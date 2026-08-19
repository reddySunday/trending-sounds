#!/usr/bin/env python3
"""Trending Sounds server — proxies Chartex API and serves the frontend."""

import base64
import hashlib
import http.server
import json
import os
import threading
import time
import unicodedata
import urllib.request
import urllib.parse
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    import jwt
    from jwt import PyJWKClient
except ImportError:  # PyJWT not installed yet — /api/* auth will reject until deps are present
    jwt = None
    PyJWKClient = None

PORT = int(os.environ.get("PORT", 3000))
CHARTEX_BASE = "https://api.chartex.com"

# GitHub data storage
GITHUB_PAT  = os.environ.get("GITHUB_DATA_PAT", "")
GITHUB_REPO = os.environ.get("GITHUB_DATA_REPO", "")
GITHUB_API  = "https://api.github.com"
DATA_KEYS   = ["pipeline_statuses", "scouting_scouts", "scouting_projects", "outreach_templates"]

# Microsoft Entra ID (single-tenant) auth
AAD_CLIENT_ID = os.environ.get("AAD_CLIENT_ID", "")
AAD_TENANT_ID = os.environ.get("AAD_TENANT_ID", "")
OWNER_EMAIL   = os.environ.get("OWNER_EMAIL", "").lower()
# Accept both the App ID URI and bare client id as audience, and both v2/v1 issuers,
# so validation works regardless of the app manifest's accessTokenAcceptedVersion.
_AUDIENCES  = [f"api://{AAD_CLIENT_ID}", AAD_CLIENT_ID]
_ISSUER_V2  = f"https://login.microsoftonline.com/{AAD_TENANT_ID}/v2.0"
_ISSUER_V1  = f"https://sts.windows.net/{AAD_TENANT_ID}/"
_jwks_client = None
# Auth is "configured" the moment the AAD env vars are present. When they are NOT
# set (local dev, or a pre-Azure deploy) the app runs unauthenticated against the
# legacy shared dataset — nothing breaks until the env vars are added.
#
# CRITICAL: if the env vars ARE set but PyJWT is missing, we FAIL CLOSED (reject
# every /api/* request) instead of silently serving the shared dataset. A broken
# app is far safer than leaking every user's data to anyone.
AUTH_CONFIGURED = bool(AAD_CLIENT_ID and AAD_TENANT_ID)
if AUTH_CONFIGURED and not jwt:
    print("WARNING: AAD is configured but PyJWT is not installed — all /api/* "
          "requests will be rejected (fail-closed). Fix the build to run: "
          "pip install -r requirements.txt")


def _get_jwks_client():
    global _jwks_client
    if _jwks_client is None and PyJWKClient and AAD_TENANT_ID:
        _jwks_client = PyJWKClient(
            f"https://login.microsoftonline.com/{AAD_TENANT_ID}/discovery/v2.0/keys"
        )
    return _jwks_client


def validate_bearer(auth_header):
    """Validate a Microsoft access token. Return {oid, email, name} or None."""
    if not (jwt and AAD_CLIENT_ID and AAD_TENANT_ID):
        return None
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    token = auth_header[7:]
    try:
        client = _get_jwks_client()
        key = client.get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, key, algorithms=["RS256"], audience=_AUDIENCES,
            options={"verify_iss": False},  # issuer checked manually to allow v1 or v2
        )
        if claims.get("iss") not in (_ISSUER_V2, _ISSUER_V1):
            return None
        if claims.get("tid") and claims["tid"] != AAD_TENANT_ID:
            return None  # defense-in-depth: reject other tenants
        oid = claims.get("oid") or claims.get("sub")
        if not oid:
            return None
        # Username claim varies by token version: v2 uses preferred_username/email,
        # v1 uses upn/unique_name. Check all so owner-matching is robust.
        email = (claims.get("preferred_username") or claims.get("upn")
                 or claims.get("email") or claims.get("unique_name") or "").lower()
        return {
            "oid": oid,
            "email": email,
            "name": claims.get("name", ""),
        }
    except Exception:
        return None


def _gh_headers():
    return {
        "Authorization": f"Bearer {GITHUB_PAT}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def github_read(filename):
    """Return (parsed_data, sha) for a file in the data repo, or (None, None) on 404."""
    url = f"{GITHUB_API}/repos/{GITHUB_REPO}/contents/{filename}"
    req = urllib.request.Request(url, headers=_gh_headers())
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.loads(r.read())
            content = base64.b64decode(body["content"]).decode()
            return json.loads(content), body["sha"]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, None
        raise


def github_write(filename, data, sha=None):
    """Upsert a JSON file in the data repo. sha is required when the file already exists."""
    url = f"{GITHUB_API}/repos/{GITHUB_REPO}/contents/{filename}"
    payload = {
        "message": f"update {filename}",
        "content": base64.b64encode(json.dumps(data, ensure_ascii=False).encode()).decode(),
    }
    if sha:
        payload["sha"] = sha
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method="PUT",
        headers={**_gh_headers(), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def github_list_dir(path):
    """Return the names of sub-directories under `path` in the data repo, or []."""
    url = f"{GITHUB_API}/repos/{GITHUB_REPO}/contents/{path}"
    req = urllib.request.Request(url, headers=_gh_headers())
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            items = json.loads(r.read())
            return [it["name"] for it in items if it.get("type") == "dir"]
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise


# ---- Shared contact registry (collision awareness across A&Rs) ----
# Statuses that mean "this A&R has reached out to the artist" (everything but new).
REACHED_OUT_STATUSES = {
    "contacted", "no-reply", "ghosted", "replied",
    "meeting", "offer", "signed", "already-signed", "passed",
}
_registry_cache = {"at": 0.0, "data": None}
_profiles_ensured = set()  # oids whose profile.json we've already synced this process


def norm_artist(name):
    """Normalize an artist name for cross-user matching: lowercase, strip accents,
    collapse whitespace. Must match the client's _normArtist()."""
    s = unicodedata.normalize("NFD", name or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join(s.lower().split())


def build_registry():
    """Aggregate a privacy-safe contact projection from every user's pipeline.
    Returns { normalizedArtist: [ {artist, song, status, at, by, oid}, ... ] }.
    Cached ~45s. Only reached-out entries are included; notes are never touched."""
    now = time.time()
    if _registry_cache["data"] is not None and now < _registry_cache["at"] + 45:
        return _registry_cache["data"]

    oids = github_list_dir("users")

    def load(oid):
        pipeline, _ = github_read(f"users/{oid}/pipeline_statuses.json")
        profile, _ = github_read(f"users/{oid}/profile.json")
        return oid, pipeline or {}, profile or {}

    results = []
    if oids:
        with ThreadPoolExecutor(max_workers=8) as ex:
            results = list(ex.map(load, oids))

    by_artist = {}
    for oid, pipeline, profile in results:
        by = profile.get("name") or (profile.get("email", "").split("@")[0]) or "An A&R"
        if not isinstance(pipeline, dict):
            continue
        for key, entry in pipeline.items():
            if not isinstance(entry, dict):
                continue
            status = entry.get("status")
            if status not in REACHED_OUT_STATUSES:
                continue
            parts = key.split("|||")
            artist = entry.get("artist") or (parts[0] if parts else "")
            song = entry.get("songName") or (parts[1] if len(parts) > 1 else "")
            at = entry.get("contactedAt") or entry.get("updatedAt") or entry.get("dateAdded")
            na = norm_artist(artist)
            if not na:
                continue
            by_artist.setdefault(na, []).append({
                "artist": artist, "song": song, "status": status,
                "at": at, "by": by, "oid": oid,
            })

    _registry_cache["data"] = by_artist
    _registry_cache["at"] = now
    return by_artist


def ensure_profile(user):
    """Keep users/{oid}/profile.json in sync with the token's name/email so the
    registry can show real names. Writes only when missing or changed, and at most
    once per oid per process (cheap enough to call on every request)."""
    oid = user.get("oid")
    if user.get("legacy") or not oid or oid in _profiles_ensured:
        return
    try:
        current, sha = github_read(f"users/{oid}/profile.json")
        desired = {"email": user.get("email", ""), "name": user.get("name", "")}
        if current != desired:
            github_write(f"users/{oid}/profile.json", desired, sha)
        _profiles_ensured.add(oid)
    except Exception:
        pass


APP_ID = os.environ.get("CHARTEX_APP_ID", "oisin_IgEZfiJk")
APP_TOKEN = os.environ.get("CHARTEX_APP_TOKEN", "uvGc0rEopiiAuVN7i7NRLL_ULptr--QAyzUrcDC0q-Y")

# Spotify Web API credentials (Client Credentials flow — no user login needed)
SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "cab1f7c20e1343b2a252848cc52c0de9")

# Token cache: { "token": str, "expires_at": float }
_spotify_token_cache = {}


def get_spotify_token():
    """Return a valid Spotify access token, refreshing if expired."""
    cached = _spotify_token_cache.get("token")
    if cached and time.time() < _spotify_token_cache.get("expires_at", 0) - 30:
        return cached
    if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
        return None
    creds = base64.b64encode(f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()).decode()
    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=b"grant_type=client_credentials",
        headers={"Authorization": f"Basic {creds}", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            _spotify_token_cache["token"] = data["access_token"]
            _spotify_token_cache["expires_at"] = time.time() + data.get("expires_in", 3600)
            return data["access_token"]
    except Exception:
        return None

STATIC_DIR = Path(__file__).parent / "public"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def send_json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _authed_user(self):
        """Return a user dict for the request, or None if a required token is invalid.
        When auth is NOT configured, returns a legacy user bound to the shared dataset.
        When auth IS configured, a valid token is mandatory — validate_bearer returns
        None (→ 401) if the token is bad OR if PyJWT is missing, so we fail closed."""
        if not AUTH_CONFIGURED:
            return {"oid": None, "email": OWNER_EMAIL, "legacy": True}
        user = validate_bearer(self.headers.get("Authorization"))
        # Capture the name/email for the shared registry on the user's FIRST
        # authenticated request (any endpoint) — backgrounded so it never blocks.
        if user and user.get("oid") not in _profiles_ensured:
            threading.Thread(target=ensure_profile, args=(user,), daemon=True).start()
        return user

    def do_POST(self):
        if self.path in ("/api/data", "/api/profile"):
            user = self._authed_user()
            if not user:
                self.send_json(401, {"error": "unauthorized"})
                return
            if self.path == "/api/profile":
                self.handle_profile_write(user)
            else:
                self.handle_data_write(user)
        else:
            self.send_response(404)
            self.end_headers()

    def handle_profile_write(self, user):
        """POST /api/profile {name} — record the caller's display name (from the
        client's Microsoft account) for the shared registry. Identity comes from
        the validated token; only the display name is taken from the body."""
        if user.get("legacy") or not user.get("oid") or not GITHUB_PAT:
            self.send_json(200, {"ok": True})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
        except Exception:
            body = {}
        name = (body.get("name") or user.get("name") or "").strip()
        desired = {"email": user.get("email", ""), "name": name}
        try:
            current, sha = github_read(f"users/{user['oid']}/profile.json")
            if current != desired:
                github_write(f"users/{user['oid']}/profile.json", desired, sha)
            _profiles_ensured.add(user["oid"])
        except Exception:
            pass
        self.send_json(200, {"ok": True})

    def do_GET(self):
        # Public (no token): the client needs this before it can sign in.
        if self.path == "/api/auth-config":
            self.send_json(200, {"clientId": AAD_CLIENT_ID, "tenantId": AAD_TENANT_ID})
            return

        # Everything else under /api/* requires a valid Microsoft token (when auth is on).
        if self.path.startswith("/api/"):
            user = self._authed_user()
            if not user:
                self.send_json(401, {"error": "unauthorized"})
                return
            if self.path == "/api/data":
                self.handle_data_read(user)
            elif self.path == "/api/registry":
                self.handle_registry(user)
            elif self.path == "/api/whoami":
                # Diagnostic: what identity does the server see, and does it match the owner?
                self.send_json(200, {
                    "oid": user.get("oid"),
                    "email": user.get("email"),
                    "legacy": bool(user.get("legacy")),
                    "owner_email_configured": bool(OWNER_EMAIL),
                    "is_owner": bool(OWNER_EMAIL) and user.get("email") == OWNER_EMAIL,
                })
            elif self.path.startswith("/api/spotify-track"):
                self.handle_spotify_track()
            else:
                self.proxy_chartex()
            return

        if self.path == "/__livereload":
            self.handle_livereload()
        else:
            # Serve index.html for all non-file routes (SPA)
            parsed = urllib.parse.urlparse(self.path)
            file_path = STATIC_DIR / parsed.path.lstrip("/")
            if not file_path.is_file():
                self.path = "/index.html"
            # Disable caching for dev
            super().do_GET()

    def handle_registry(self, user):
        """GET /api/registry — colleague contact projection, excluding the caller.
        { byArtist: { normalizedArtist: [ {artist, song, status, at, by}, ... ] } }"""
        if not GITHUB_PAT or not GITHUB_REPO:
            self.send_json(200, {"byArtist": {}})
            return
        try:
            reg = build_registry()
            caller = user.get("oid")
            out = {}
            for na, contacts in reg.items():
                others = [{k: v for k, v in c.items() if k != "oid"}
                          for c in contacts if c.get("oid") != caller]
                if others:
                    out[na] = others
            self.send_json(200, {"byArtist": out})
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def handle_data_read(self, user):
        """GET /api/data — returns all 4 data keys for the signed-in user."""
        if not GITHUB_PAT or not GITHUB_REPO:
            self.send_json(200, {k: None for k in DATA_KEYS})
            return
        legacy = user.get("legacy")
        is_owner = bool(OWNER_EMAIL) and user.get("email") == OWNER_EMAIL
        try:
            def fetch_one(key):
                if legacy:
                    data, _ = github_read(f"{key}.json")
                    return data
                data, _ = github_read(f"users/{user['oid']}/{key}.json")
                # One-time migration: the founding account inherits the legacy
                # shared root file until its first write persists it per-user.
                if data is None and is_owner:
                    data, _ = github_read(f"{key}.json")
                return data

            with ThreadPoolExecutor(max_workers=4) as ex:
                results = list(ex.map(fetch_one, DATA_KEYS))

            self.send_json(200, dict(zip(DATA_KEYS, results)))
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def handle_data_write(self, user):
        """POST /api/data — writes one key for the signed-in user."""
        if not GITHUB_PAT or not GITHUB_REPO:
            self.send_json(503, {"error": "GitHub data storage not configured"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            key = body.get("key", "")
            data = body.get("data")
            if key not in DATA_KEYS:
                self.send_json(400, {"error": f"Unknown key: {key}"})
                return
            filename = f"{key}.json" if user.get("legacy") else f"users/{user['oid']}/{key}.json"
            _, sha = github_read(filename)
            try:
                github_write(filename, data, sha)
            except urllib.error.HTTPError as e:
                if e.code == 409:
                    # SHA conflict from concurrent write — retry with fresh SHA
                    _, sha = github_read(filename)
                    github_write(filename, data, sha)
                else:
                    raise
            self.send_json(200, {"ok": True})
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def handle_livereload(self):
        """Return a hash of all public files so the client can detect changes."""
        h = hashlib.md5()
        for f in sorted(STATIC_DIR.rglob("*")):
            if f.is_file():
                h.update(f.read_bytes())
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(json.dumps({"hash": h.hexdigest()}).encode())

    def proxy_chartex(self):
        # Strip /api prefix and forward to Chartex
        chartex_path = self.path[4:]  # remove "/api"
        url = f"{CHARTEX_BASE}{chartex_path}"

        headers = {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }
        if APP_ID:
            headers["X-APP-ID"] = APP_ID
        if APP_TOKEN:
            headers["X-APP-TOKEN"] = APP_TOKEN

        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body or json.dumps({"error": str(e)}).encode())
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def handle_spotify_track(self):
        """Fetch Spotify track metadata using Web API or oEmbed fallback."""
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        url = params.get("url", [""])[0]

        if not url or "spotify.com" not in url:
            self.send_json(400, {"error": "Invalid Spotify URL"})
            return

        # Try Spotify Web API first (requires both Client ID and Secret)
        token = get_spotify_token()
        if token:
            try:
                # Extract track ID from URL like open.spotify.com/track/{id}
                match = urllib.parse.urlparse(url).path.split("/")
                track_id = None
                for i, part in enumerate(match):
                    if part == "track" and i + 1 < len(match):
                        track_id = match[i + 1].split("?")[0]
                        break
                if track_id:
                    req = urllib.request.Request(
                        f"https://api.spotify.com/v1/tracks/{track_id}",
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        data = json.loads(resp.read())
                        artists = ", ".join(a["name"] for a in data.get("artists", []))
                        self.send_json(200, {
                            "trackName": data.get("name", ""),
                            "artist": artists,
                            "coverArt": (data.get("album", {}).get("images") or [{}])[0].get("url", ""),
                        })
                        return
            except Exception:
                pass  # fall through to oEmbed

        # Fallback: Spotify oEmbed (no auth required) + page meta scrape for artist
        try:
            oembed_url = "https://open.spotify.com/oembed?url=" + urllib.parse.quote(url)
            req = urllib.request.Request(oembed_url, headers={
                "User-Agent": "Mozilla/5.0 (compatible; bot/1.0)"
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())

            track_name = data.get("title", "")
            artist = data.get("description", "")
            cover_art = data.get("thumbnail_url", "")

            # If artist is empty, try scraping og:description from the Spotify track page
            if not artist:
                import re as _re
                page_req = urllib.request.Request(url, headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
                })
                try:
                    with urllib.request.urlopen(page_req, timeout=10) as page_resp:
                        html = page_resp.read().decode("utf-8", errors="replace")
                    # og:description is typically "Artist · Song · Album"
                    m = _re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', html)
                    if m:
                        parts = m.group(1).split(" · ")
                        if len(parts) >= 2:
                            artist = parts[0].strip()
                except Exception:
                    pass

            self.send_json(200, {"trackName": track_name, "artist": artist, "coverArt": cover_art})
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")


if __name__ == "__main__":
    STATIC_DIR.mkdir(exist_ok=True)
    server = http.server.HTTPServer(("", PORT), Handler)
    print(f"Server running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()

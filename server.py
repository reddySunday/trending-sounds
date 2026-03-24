#!/usr/bin/env python3
"""Trending Sounds server — proxies Chartex API and serves the frontend."""

import base64
import hashlib
import http.server
import json
import os
import time
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path

PORT = int(os.environ.get("PORT", 3000))
CHARTEX_BASE = "https://api.chartex.com"
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

    def send_json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/spotify-track"):
            self.handle_spotify_track()
        elif self.path.startswith("/api/"):
            self.proxy_chartex()
        elif self.path == "/__livereload":
            self.handle_livereload()
        else:
            # Serve index.html for all non-file routes (SPA)
            parsed = urllib.parse.urlparse(self.path)
            file_path = STATIC_DIR / parsed.path.lstrip("/")
            if not file_path.is_file():
                self.path = "/index.html"
            # Disable caching for dev
            super().do_GET()

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

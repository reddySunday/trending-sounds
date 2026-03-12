#!/usr/bin/env python3
"""Trending Sounds server — proxies Chartex API and serves the frontend."""

import hashlib
import http.server
import json
import os
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path

PORT = int(os.environ.get("PORT", 3000))
CHARTEX_BASE = "https://api.chartex.com"
APP_ID = os.environ.get("CHARTEX_APP_ID", "oisin_IgEZfiJk")
APP_TOKEN = os.environ.get("CHARTEX_APP_TOKEN", "uvGc0rEopiiAuVN7i7NRLL_ULptr--QAyzUrcDC0q-Y")

STATIC_DIR = Path(__file__).parent / "public"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self):
        if self.path.startswith("/api/"):
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

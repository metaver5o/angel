#!/usr/bin/env python3
"""Tiny deploy/version service for the Angel stack.

Fronted by Caddy at the same origin as the mint app:

  GET  /__version  -> {deployed, latest, up_to_date, ...}
  POST /__deploy   -> fetch origin/<branch> and hard-reset the working tree.
                      index.html is a live volume mount, so the site updates
                      immediately (no image rebuild needed for content).

A background poller auto-deploys every POLL_SECONDS, so there is no cron: other
people push to main and this pulls it in within a minute.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.environ.get("REPO_DIR", "/repo")
BRANCH = os.environ.get("BRANCH", "main")
REMOTE_URL = os.environ.get("REMOTE_URL", "")  # https preferred (keyless public fetch)
TOKEN = os.environ.get("DEPLOY_TOKEN", "")
GH = os.environ.get("GITHUB_REPO", "metaver5o/angel")
POLL = int(os.environ.get("POLL_SECONDS", "60"))

_lock = threading.Lock()


def _git(*args, timeout=180):
    return subprocess.run(["git", "-C", REPO, *args],
                          capture_output=True, text=True, timeout=timeout)


def _remote_url() -> str:
    return REMOTE_URL or _git("remote", "get-url", "origin").stdout.strip()


def _fetch():
    return _git("fetch", "--quiet", _remote_url(), BRANCH)


def _head() -> str:
    return _git("rev-parse", "HEAD").stdout.strip()


def _fetched() -> str:
    return _git("rev-parse", "FETCH_HEAD").stdout.strip()


def version() -> dict:
    with _lock:
        _fetch()
        d, r = _head(), _fetched()
    return {
        "deployed": d, "deployed_short": d[:7],
        "latest": r, "latest_short": r[:7],
        "branch": BRANCH, "repo": GH,
        "up_to_date": bool(d) and d == r,
    }


def deploy() -> dict:
    with _lock:
        _fetch()
        before, target = _head(), _fetched()
        reset = _git("reset", "--hard", target)
        after = _head()
    return {
        "ok": reset.returncode == 0,
        "from": before[:7], "to": after[:7],
        "changed": before != after,
        "up_to_date": after == target,
        "error": (reset.stderr.strip() or None) if reset.returncode else None,
    }


def _poller():
    while POLL > 0:
        time.sleep(POLL)
        try:
            if not version()["up_to_date"]:
                deploy()
        except Exception:
            pass


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Deploy-Token")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path == "/__version":
            try:
                self._send(version())
            except Exception as e:
                self._send({"error": str(e)}, 500)
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        if self.path != "/__deploy":
            return self._send({"error": "not found"}, 404)
        if TOKEN and self.headers.get("X-Deploy-Token") != TOKEN:
            return self._send({"error": "unauthorized"}, 401)
        try:
            self._send(deploy())
        except Exception as e:
            self._send({"error": str(e)}, 500)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    threading.Thread(target=_poller, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8090), H).serve_forever()

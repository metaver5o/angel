#!/usr/bin/env python3
"""Tiny deploy/version/event service for the Angel stack.

Fronted by Caddy at the same origin as the mint app:

  GET  /__version  -> {deployed, latest, up_to_date, ...}
  POST /__deploy   -> fetch origin/<branch> and hard-reset the working tree.
                      web/ is a live volume mount, so the site updates
                      immediately (no image rebuild needed for content).
  POST /__event    -> append one activity/error event from the page to the
                      log (JSON lines, EVENT_LOG). Open: the page reports
                      what visitors do and what fails, including JS errors.
  GET  /__events   -> the last N events as JSON (needs DEPLOY_TOKEN).

A background poller auto-deploys every POLL_SECONDS, so there is no cron: other
people push to main and this pulls it in within a minute. Its own failures go
to the same event log, as `deployer_error`.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.environ.get("REPO_DIR", "/repo")
BRANCH = os.environ.get("BRANCH", "main")
REMOTE_URL = os.environ.get("REMOTE_URL", "")  # https preferred (keyless public fetch)
TOKEN = os.environ.get("DEPLOY_TOKEN", "")
GH = os.environ.get("GITHUB_REPO", "metaver5o/angel")
POLL = int(os.environ.get("POLL_SECONDS", "60"))
EVENT_LOG = os.environ.get("EVENT_LOG", os.path.join(REPO, "logs", "events.jsonl"))
MAX_EVENT_BYTES = 16 * 1024

_lock = threading.Lock()
_log_lock = threading.Lock()


def log_event(event: dict) -> None:
    """One JSON line per event; also echoed to stdout so `docker compose logs
    deployer` shows activity live. Never raises — logging must not break the
    thing it is logging."""
    try:
        line = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
        with _log_lock:
            os.makedirs(os.path.dirname(EVENT_LOG), exist_ok=True)
            with open(EVENT_LOG, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        print(line, flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"event log write failed: {e}", file=sys.stderr, flush=True)


def recent_events(n: int) -> list[dict]:
    try:
        with open(EVENT_LOG, encoding="utf-8") as f:
            tail = deque(f, maxlen=n)
    except FileNotFoundError:
        return []
    out = []
    for line in tail:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


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
                result = deploy()
                log_event({"t": time.time(), "src": "deployer", "event": "deploy",
                           "data": result})
                if not result["ok"]:
                    log_event({"t": time.time(), "src": "deployer", "event": "deployer_error",
                               "data": {"where": "deploy", "error": result["error"]}})
        except Exception as e:  # noqa: BLE001
            log_event({"t": time.time(), "src": "deployer", "event": "deployer_error",
                       "data": {"where": "poll", "error": str(e)}})


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

    def _authorized(self) -> bool:
        return bool(TOKEN) and self.headers.get("X-Deploy-Token") == TOKEN

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/__version":
            try:
                self._send(version())
            except Exception as e:
                log_event({"t": time.time(), "src": "deployer", "event": "deployer_error",
                           "data": {"where": "version", "error": str(e)}})
                self._send({"error": str(e)}, 500)
        elif path == "/__events":
            # Addresses and error details live here; the deploy token gates it,
            # and an empty token means nobody reads it over the wire.
            if not self._authorized():
                return self._send({"error": "unauthorized (set DEPLOY_TOKEN and send X-Deploy-Token)"}, 401)
            n = 200
            for part in query.split("&"):
                if part.startswith("n="):
                    try:
                        n = max(1, min(5000, int(part[2:])))
                    except ValueError:
                        pass
            self._send({"events": recent_events(n)})
        elif path == "/__errors":
            # Errors only, no token: message, where, build, session, wallet
            # kind - but no IP and no address - so a watcher can poll for
            # failures without holding the deploy token. ?since=<unix ts>.
            since = 0.0
            for part in query.split("&"):
                if part.startswith("since="):
                    try:
                        since = float(part[6:])
                    except ValueError:
                        pass
            errors = []
            for ev in recent_events(2000):
                if ev.get("event") not in ("error", "deployer_error", "broadcast_failed"):
                    continue
                if ev.get("t", 0) <= since:
                    continue
                errors.append({k: v for k, v in ev.items() if k not in ("ip", "address", "ua")})
            self._send({"errors": errors[-100:], "now": time.time()})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(min(n, MAX_EVENT_BYTES)) if n else b""
        if n > MAX_EVENT_BYTES:
            self.rfile.read(n - MAX_EVENT_BYTES)
        if self.path == "/__event":
            if n > MAX_EVENT_BYTES:
                return self._send({"error": "too large"}, 413)
            try:
                ev = json.loads(body.decode("utf-8"))
                if not isinstance(ev, dict) or not isinstance(ev.get("event"), str):
                    raise ValueError("an event is an object with a string `event`")
            except (ValueError, UnicodeDecodeError) as e:
                return self._send({"error": f"bad event: {e}"}, 400)
            ev["t"] = time.time()
            ev["src"] = "page"
            ev["ip"] = (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()
            log_event(ev)
            return self._send({"ok": True}, 202)
        if self.path != "/__deploy":
            return self._send({"error": "not found"}, 404)
        if TOKEN and self.headers.get("X-Deploy-Token") != TOKEN:
            return self._send({"error": "unauthorized"}, 401)
        try:
            result = deploy()
            log_event({"t": time.time(), "src": "deployer", "event": "deploy", "data": {**result, "via": "button"}})
            self._send(result)
        except Exception as e:
            log_event({"t": time.time(), "src": "deployer", "event": "deployer_error",
                       "data": {"where": "deploy-button", "error": str(e)}})
            self._send({"error": str(e)}, 500)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    log_event({"t": time.time(), "src": "deployer", "event": "deployer_start",
               "data": {"deployed": _head()[:7], "branch": BRANCH, "poll_seconds": POLL}})
    threading.Thread(target=_poller, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8090), H).serve_forever()

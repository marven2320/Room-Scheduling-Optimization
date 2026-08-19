#!/usr/bin/env python3
"""
Room Scheduling Optimization System — local server with usage tracking.

Serves the app's static files (index.html, app.js, styles.css, ...) exactly like
`python3 -m http.server`, plus two JSON API endpoints the front-end uses for the
"App Usage Summary" tab:

  POST /api/track       Append one usage/monitoring event to usage_log.csv.
  GET  /api/usage-data   Return every logged event as a JSON array (for the charts/tables).

Storage is CSV ONLY (usage_log.csv, created next to this script) — the two endpoints are
just a thin read/write API in front of that file; nothing is kept in memory or any other
format. Every request is wrapped in error handling so a malformed client payload can never
crash the server or corrupt the log.

WHAT GETS RECORDED (see CSV_FIELDS below for the exact columns):
  - The requester's IP address, and a per-page-load session id (so "visitor count" means
    unique sessions, not unique humans — someone reloading the page counts as a new visit).
  - A server-generated timestamp (UTC) — the client's clock is never trusted for this.
  - Which app function/action was used (e.g. "addRoom", "optimize", "exportCsv", ...).
  - For optimizer runs: generations run, population size, and room count at the time.
  - Round-trip latency, measured client-side per tracking call (see app.js trackEvent()).
  - Error reports (message + short context) from the app's global error handlers.
  - A free-form "details" JSON blob for anything else worth capturing about the event.

PRIVACY NOTE: this records real visitor IP addresses to a local file. That's appropriate for
the stated purpose (app functionality testing / internal monitoring) but IS personal data —
before pointing this at real end users, disclose that access is logged and to whom, and make
sure usage_log.csv itself is only readable by people who should see raw IPs. IP addresses seen
here are TCP peer addresses (self.client_address) — if this is ever deployed behind a reverse
proxy or load balancer, that will be the proxy's IP, not the visitor's, unless X-Forwarded-For
handling is added.

Run it the same way you'd run the plain static server:
    python3 server.py [port]      # default port 8000
"""
import csv
import json
import os
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(ROOT_DIR, "usage_log.csv")
MAX_BODY_BYTES = 64 * 1024  # a tracking event is small; refuse anything absurd
DEFAULT_PORT = 8000

# Column order is the on-disk contract for usage_log.csv — the front-end's summary tab reads
# these exact header names back via GET /api/usage-data, so don't reorder/rename casually.
CSV_FIELDS = [
    "timestamp", "ip", "session_id", "event_type", "function_name",
    "generations", "population_size", "num_rooms", "latency_ms",
    "error_message", "details", "user_agent",
]

_log_lock = threading.Lock()


def _ensure_log_header():
    if not os.path.exists(LOG_PATH) or os.path.getsize(LOG_PATH) == 0:
        with open(LOG_PATH, "w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=CSV_FIELDS).writeheader()


def _append_event(row: dict):
    """Thread-safe append of one event to the CSV log. Unknown keys in `row` are dropped;
    missing keys are written as empty cells — csv.DictWriter handles all quoting/escaping,
    so no manual CSV-injection risk from user-supplied strings (subject names, error text, ...)."""
    clean = {k: row.get(k, "") for k in CSV_FIELDS}
    with _log_lock:
        _ensure_log_header()
        with open(LOG_PATH, "a", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=CSV_FIELDS).writerow(clean)


def _read_events():
    if not os.path.exists(LOG_PATH):
        return []
    with _log_lock:
        with open(LOG_PATH, "r", newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))


def _clamp_str(value, max_len=2000):
    s = "" if value is None else str(value)
    return s[:max_len]


class Handler(SimpleHTTPRequestHandler):
    """Extends the standard static-file handler directly (rather than composing/delegating to
    a second handler instance) — SimpleHTTPRequestHandler's __init__ drives the whole
    request lifecycle itself (via socketserver.BaseRequestHandler), so constructing a second
    one on the same live socket to "delegate" to would try to read a second request off a
    socket the client isn't sending one on, and just hang. Subclassing avoids that entirely."""

    server_version = "RMS-Tracking/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def end_headers(self):
        # No caching, ever — this app has been bitten repeatedly by browsers serving a stale
        # app.js/styles.css after an edit. A local dev/testing server should always hand back
        # whatever's currently on disk.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _client_ip(self):
        # Direct TCP peer address. See the privacy note at the top of this file re: proxies.
        return self.client_address[0]

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/usage-data":
            try:
                events = _read_events()
                self._send_json(200, {"events": events, "count": len(events)})
            except Exception as e:
                self._send_json(500, {"error": f"Could not read usage log: {e}"})
            return
        if path == "/api/ping":
            # Cheap endpoint the front-end can hit purely to measure round-trip latency
            # without generating a log row for every single measurement.
            self._send_json(200, {"ok": True})
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/track":
            self._send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {"error": "Empty request body"})
            return
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "Request body too large"})
            return
        try:
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Body must be a JSON object")
        except Exception as e:
            self._send_json(400, {"error": f"Invalid JSON body: {e}"})
            return

        try:
            row = {
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "ip": self._client_ip(),
                "session_id": _clamp_str(payload.get("session_id"), 100),
                "event_type": _clamp_str(payload.get("event_type"), 100) or "action",
                "function_name": _clamp_str(payload.get("function_name"), 200),
                "generations": _clamp_str(payload.get("generations"), 20),
                "population_size": _clamp_str(payload.get("population_size"), 20),
                "num_rooms": _clamp_str(payload.get("num_rooms"), 20),
                "latency_ms": _clamp_str(payload.get("latency_ms"), 20),
                "error_message": _clamp_str(payload.get("error_message"), 1000),
                "details": _clamp_str(
                    json.dumps(payload.get("details")) if payload.get("details") is not None else "",
                    1000,
                ),
                "user_agent": _clamp_str(self.headers.get("User-Agent", ""), 300),
            }
            _append_event(row)
            self._send_json(200, {"ok": True})
        except Exception as e:
            self._send_json(500, {"error": f"Could not record event: {e}"})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Ignoring invalid port {sys.argv[1]!r}, using {DEFAULT_PORT}", file=sys.stderr)
    _ensure_log_header()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Room Scheduling Optimization System — serving http://localhost:{port}")
    print(f"Usage tracking log (CSV): {LOG_PATH}")
    print("Privacy note: this records visitor IP addresses for app-testing/monitoring purposes.")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
        server.shutdown()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Browser page for workshop_collect.py (`--web`).

Runs a small web server on this computer only (127.0.0.1) and opens a page
with buttons: choose the folder, check what is new on the Cardputer, and
download it. The downloading itself is the same `collect_device()` the
terminal mode uses, so files are named, skipped and checksum-checked the
same way.

The page comes from this computer, not from the Cardputer, so it keeps
working while the computer is on the Cardputer's Wi-Fi.

Python 3 standard library only.
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional

import workshop_collect as wc

PAGE_PATH = Path(__file__).resolve().parent / "workshop_collect_web.html"
SETTINGS_PATH = Path.home() / ".biomapping_collect_web.json"
# Every POST must carry this header. A page on another website can't add it
# without the browser first asking this server for permission, which it never
# gives, so other sites can't press the buttons (or delete files) behind
# your back.
REQUEST_HEADER = "X-BioMapping"
MAX_BODY_BYTES = 16384
OK_CHECKS = ("checksum_ok", "no_checksum_header")


# ── Settings kept between runs ────────────────────────────────────────────


def load_settings(path: Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: str(data[k]) for k in ("folder", "ssid", "label") if isinstance(data.get(k), str)}


def save_settings(path: Path, settings: dict[str, str]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass  # Remembering is a convenience; the page still works without it.


def clean_ssid(raw: Any) -> str:
    """A Wi-Fi name: 1-32 printable characters (it goes to networksetup as one argument)."""
    ssid = str(raw or "").strip()
    if not ssid or len(ssid) > 32 or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in ssid):
        raise ValueError("Type the Cardputer's Wi-Fi name, for example BioMapping-3E5C.")
    return ssid


def clean_folder(raw: Any) -> Path:
    text = str(raw or "").strip()
    if not text:
        raise ValueError("Choose a folder to save the recordings in.")
    folder = Path(text).expanduser().resolve()
    if folder.exists() and not folder.is_dir():
        raise ValueError(f"{folder} is a file, not a folder.")
    return folder


def choose_folder_mac(start: Path) -> Optional[str]:
    """Show the Mac's own folder picker. Returns None if the person cancels."""
    if not start.is_dir():
        start = Path.home()
    script = [
        "on run argv",
        'return POSIX path of (choose folder with prompt "Choose where to save the recordings" '
        "default location (POSIX file (item 1 of argv)))",
        "end run",
    ]
    cmd = ["osascript"]
    for line in script:
        cmd += ["-e", line]
    cmd.append(str(start))
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        return None  # Cancel (error -128) or no dialog possible.
    return proc.stdout.strip().rstrip("/") or "/"


# ── One check or download at a time ───────────────────────────────────────


class Collector:
    """Holds the settings and the state of the current (or last) job."""

    def __init__(
        self,
        *,
        wifi: wc.WifiBackend,
        client: wc.CardputerClient,
        settings: dict[str, str],
        settings_path: Optional[Path],
        connect_timeout: float = wc.DEFAULT_CONNECT_TIMEOUT,
        restore_wifi: Optional[str] = None,
        no_restore: bool = False,
    ) -> None:
        self.wifi = wifi
        self.client = client
        self.settings = dict(settings)
        self.settings_path = settings_path
        self.connect_timeout = connect_timeout
        self.restore_wifi = restore_wifi
        self.no_restore = no_restore
        self.lock = threading.Lock()
        self.thread: Optional[threading.Thread] = None
        self.job: dict[str, Any] = {"state": "idle"}

    # -- settings --

    def update_settings(self, body: dict) -> None:
        """Check and keep whatever settings the page sent."""
        new = dict(self.settings)
        if "ssid" in body:
            new["ssid"] = clean_ssid(body["ssid"])
        if "label" in body:
            new["label"] = str(body["label"] or "").strip()
        if "folder" in body:
            new["folder"] = str(clean_folder(body["folder"]))
        self.settings = new
        if self.settings_path is not None:
            save_settings(self.settings_path, new)

    def spec(self) -> wc.DeviceSpec:
        ssid = clean_ssid(self.settings.get("ssid"))
        label = wc.sanitize_label(self.settings.get("label") or ssid, fallback=ssid)
        return wc.DeviceSpec(ssid=ssid, label=label)

    def running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def snapshot(self) -> dict:
        with self.lock:
            job = json.loads(json.dumps(self.job))
        return {"settings": dict(self.settings), "job": job, "busy": self.running()}

    # -- jobs --

    def start(self, *, dry_run: bool, delete: bool) -> None:
        if self.running():
            raise RuntimeError("Already busy, wait for it to finish.")
        spec = self.spec()
        folder = clean_folder(self.settings.get("folder"))
        with self.lock:
            self.job = {
                "state": "joining",
                "kind": "check" if dry_run else "download",
                "message": f"Joining the Wi-Fi of {spec.ssid}…",
                "ssid": spec.ssid,
                "folder": str(folder),
                "files": [],
                "total_on_card": 0,
                "new_bytes": 0,
                "done_bytes": 0,
                "warnings": [],
                "log": [],
                "started": time.time(),
            }
        self.thread = threading.Thread(
            target=self._run, args=(spec, folder, dry_run, delete), name="collect", daemon=False
        )
        self.thread.start()

    def _set(self, **fields: Any) -> None:
        with self.lock:
            self.job.update(fields)

    def _log(self, line: str) -> None:
        line = line.strip("\n")
        if not line:
            return
        with self.lock:
            self.job["log"].append(line)

    def _on_listing(self, folder: Path, spec: wc.DeviceSpec):
        def on_listing(files: list[dict], total: int, truncated: bool) -> None:
            rows = []
            new_bytes = 0
            for entry in files:
                name = str(entry.get("name", ""))
                size = int(entry.get("size", 0))
                if not wc.remote_name_valid(name):
                    continue
                local = wc.build_local_filename(spec.label, name)
                dest = folder / local
                # Same first test collect_device makes (it then also checks the
                # checksum), so the progress bar counts only files it will fetch.
                have = dest.is_file() and dest.stat().st_size == size
                if not have:
                    new_bytes += size
                rows.append({"name": name, "local_name": local, "size": size,
                             "status": "have" if have else "new"})
            if total == 0:
                msg = "Connected. There are no recordings on the Cardputer."
            else:
                msg = f"Connected. {total} recording{'s' if total != 1 else ''} on the Cardputer."
            with self.lock:
                self.job.update(state="listing", files=rows, total_on_card=total,
                                new_bytes=new_bytes, truncated=truncated, message=msg)
        return on_listing

    def _on_file(self, rec: wc.FileRecord) -> None:
        with self.lock:
            row = next((r for r in self.job["files"] if r["name"] == rec.remote_name), None)
            if row is None:  # A ZIP can hold files beyond the listed 256.
                row = {"name": rec.remote_name, "local_name": rec.local_name, "size": rec.size}
                self.job["files"].append(row)
            row.update(_row_status(rec))
            if rec.action in ("downloaded", "failed"):
                self.job["state"] = "downloading"
                self.job["done_bytes"] += rec.size
                saved = sum(1 for r in self.job["files"] if r.get("status") in ("saved", "bad"))
                self.job["message"] = f"Downloading… {saved} saved so far."

    def _run(self, spec: wc.DeviceSpec, folder: Path, dry_run: bool, delete: bool) -> None:
        res: Optional[wc.DeviceResult] = None
        initial = set(self.wifi.list_preferred_networks())
        try:
            res = wc.collect_device(
                spec,
                folder,
                self.wifi,
                self.client,
                connect_timeout=self.connect_timeout,
                delete_after_download=delete and not dry_run,
                dry_run=dry_run,
                log=self._log,
                on_listing=self._on_listing(folder, spec),
                on_file=self._on_file,
            )
        except Exception as exc:  # Never leave the page stuck on "busy".
            self._log(f"Unexpected error: {exc}")
            self._set(state="error", message=f"Something went wrong: {exc}")
        finally:
            joined = res is None or res.status != "offline"
            if joined and not self.no_restore:
                self._set(message="Switching this computer back to its usual Wi-Fi…")
                to_remove = [spec.ssid] if spec.ssid not in initial else []
                try:
                    self.wifi.restore(self.restore_wifi, to_remove, should_disconnect=True)
                except Exception as exc:
                    self._log(f"Could not switch Wi-Fi back: {exc}")

        if res is None:
            return
        if not dry_run and res.status != "offline":
            try:
                wc.write_collection_log(folder, [res])
            except OSError as exc:
                self._log(f"Could not save collection_log.json: {exc}")
        self._finish(res, dry_run)

    def _finish(self, res: wc.DeviceResult, dry_run: bool) -> None:
        with self.lock:
            rows = {r["name"]: r for r in self.job["files"]}
            for rec in res.files:
                if rec.remote_name in rows:
                    rows[rec.remote_name].update(_row_status(rec))
            self.job["warnings"] = list(res.warnings)
            self.job["state"] = "error" if res.status in ("offline", "error") else "done"
            self.job["message"] = _summary(res, dry_run)
            self.job["seconds"] = round(time.time() - self.job["started"], 1)


def _row_status(rec: wc.FileRecord) -> dict:
    if rec.action == "would_download":
        out = {"status": "new"}
    elif rec.action == "skipped":
        out = {"status": "have"}
    elif rec.action == "failed":
        out = {"status": "failed", "detail": rec.verify_detail}
    elif rec.verify_status in OK_CHECKS:
        out = {"status": "saved"}
    else:
        out = {"status": "bad", "detail": rec.verify_detail or rec.verify_status}
    out["deleted"] = rec.deleted_from_device
    return out


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _summary(res: wc.DeviceResult, dry_run: bool) -> str:
    if res.status == "offline":
        return (f"Couldn't join {res.spec.ssid}. Is Wi-Fi Files open on the Cardputer, "
                "and is the name right?")
    if res.status == "error" and res.error:
        return f"Couldn't finish: {res.error}"
    if dry_run:
        if res.new_count == 0:
            return "Nothing new: this folder already has every recording."
        return (f"{_plural(res.new_count, 'new recording')} to download "
                f"({res.skipped_count} already in the folder).")
    # new_count also counts files that arrived damaged; those go under "problem".
    good = sum(1 for f in res.files if f.action == "downloaded" and f.verify_status in OK_CHECKS)
    parts = [f"Saved {_plural(good, 'new recording')}"]
    if res.skipped_count:
        parts.append(f"{res.skipped_count} already in the folder")
    if res.failed_count:
        parts.append(f"{res.failed_count} had a problem (see below)")
    if res.deleted_count:
        parts.append(f"{res.deleted_count} deleted from the Cardputer")
    return ", ".join(parts) + "."


# ── Web server ────────────────────────────────────────────────────────────


def make_handler(collector: Collector, page: bytes):
    class Handler(BaseHTTPRequestHandler):
        server_version = "BioMappingCollect"

        def log_message(self, _format: str, *_args: object) -> None:
            pass

        def _host_ok(self) -> bool:
            # Refuse requests sent under another name ("DNS rebinding").
            port = self.server.server_address[1]
            return self.headers.get("Host", "") in (f"127.0.0.1:{port}", f"localhost:{port}")

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, data: dict) -> None:
            self._send(code, json.dumps(data).encode("utf-8"), "application/json")

        def do_GET(self) -> None:
            if not self._host_ok():
                return self._json(403, {"error": "wrong address"})
            path = self.path.split("?", 1)[0]
            if path == "/":
                return self._send(200, page, "text/html; charset=utf-8")
            if path == "/api/state":
                return self._json(200, collector.snapshot())
            return self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            if not self._host_ok() or self.headers.get(REQUEST_HEADER) != "1":
                return self._json(403, {"error": "refused"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY_BYTES:
                return self._json(400, {"error": "bad request"})
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self._json(400, {"error": "bad request"})

            path = self.path.split("?", 1)[0]
            try:
                if path in ("/api/settings", "/api/check", "/api/download", "/api/choose-folder"):
                    if collector.running():
                        return self._json(409, {"error": "Busy, wait for it to finish."})
                if path == "/api/settings":
                    collector.update_settings(body)
                elif path == "/api/choose-folder":
                    if platform.system() != "Darwin":
                        return self._json(400, {"error": "Type the folder path instead."})
                    start = Path(collector.settings.get("folder") or Path.home()).expanduser()
                    picked = choose_folder_mac(start)
                    if picked is not None:
                        collector.update_settings({"folder": picked})
                elif path in ("/api/check", "/api/download"):
                    collector.update_settings(
                        {k: body[k] for k in ("ssid", "label", "folder") if k in body}
                    )
                    collector.start(
                        dry_run=(path == "/api/check"),
                        delete=bool(body.get("delete")) and path == "/api/download",
                    )
                else:
                    return self._json(404, {"error": "not found"})
            except (ValueError, RuntimeError) as exc:
                return self._json(400, {"error": str(exc)})
            return self._json(200, collector.snapshot())

    return Handler


def make_server(collector: Collector, port: int) -> ThreadingHTTPServer:
    page = PAGE_PATH.read_bytes()
    handler = make_handler(collector, page)
    try:
        return ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        return ThreadingHTTPServer(("127.0.0.1", 0), handler)  # That port is busy.


def initial_settings(
    args: argparse.Namespace,
    wifi: wc.WifiBackend,
    specs: list[wc.DeviceSpec],
    saved: dict[str, str],
) -> dict[str, str]:
    """Command-line choices win, then what was used last time, then guesses."""
    settings = dict(saved)
    if args.out is not None:
        settings["folder"] = str(Path(args.out).expanduser().resolve())
    elif not settings.get("folder"):
        settings["folder"] = str(wc._default_output_dir().resolve())
    if specs:
        settings["ssid"] = specs[0].ssid
        settings["label"] = "" if specs[0].label == specs[0].ssid else specs[0].label
    elif not settings.get("ssid"):
        known = [n for n in wifi.list_preferred_networks() if n.startswith("BioMapping-")]
        settings["ssid"] = known[0] if known else ""
    return settings


def serve(args: argparse.Namespace, wifi: wc.WifiBackend, specs: list[wc.DeviceSpec]) -> int:
    saved = load_settings(SETTINGS_PATH)
    collector = Collector(
        wifi=wifi,
        client=wc.CardputerClient(base_url=args.host),
        settings=initial_settings(args, wifi, specs, saved),
        settings_path=SETTINGS_PATH,
        connect_timeout=args.connect_timeout,
        restore_wifi=args.restore_wifi,
        no_restore=args.no_restore,
    )
    if len(specs) > 1:
        print(f"The page downloads from one Cardputer at a time; starting with {specs[0].ssid}.")
    server = make_server(collector, args.port)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Download page: {url}")
    print("Leave this window open while you use the page. Press Ctrl-C here to stop.")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if collector.running():
            print("\nFinishing the current download and switching Wi-Fi back…", flush=True)
            assert collector.thread is not None
            collector.thread.join()
    print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit("Start this with:  python3 scripts/workshop_collect.py --web")

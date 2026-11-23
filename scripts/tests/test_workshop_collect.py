#!/usr/bin/env python3
"""Automated unit and mock-server tests for scripts/workshop_collect.py."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.parse
import zipfile
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import workshop_collect as wc  # noqa: E402


def make_valid_csv(
    rows: list[str],
    *,
    include_end_time: bool = True,
    overflows: int = 0,
    flush_fails: int = 0,
    corrupt_crc: bool = False,
    omit_end: bool = False,
) -> bytes:
    """Build a realistic Cardputer CSV with an authentic CRC-32 # End line."""
    lines = [
        "# Integrity: crc32 v1",
        "# BioMapping 2 Cardputer",
        "time_s,gsr_us",
        *rows,
    ]
    body = ("\n".join(lines) + "\n").encode("utf-8")
    if omit_end:
        return body
    crc = zlib.crc32(body) & 0xFFFFFFFF
    if corrupt_crc:
        crc ^= 0x000000FF
    end_time_part = "end_time:1763850000 " if include_end_time else ""
    trailer = (
        f"# End rows:{len(rows)} bytes:{len(body)} crc32:{crc:08x} "
        f"{end_time_part}overflows:{overflows} flush_fails:{flush_fails}\n"
    ).encode("utf-8")
    return body + trailer


class FakeCardputerFleet:
    """Mock HTTP server that switches which Cardputer it pretends to be."""

    def __init__(self, devices: dict[str, dict[str, bytes]], truncated: set[str] | None = None):
        self.devices = {ssid: dict(files) for ssid, files in devices.items()}
        self.truncated = set(truncated or set())
        self.active_ssid: str | None = None
        self.lag_ssids: list[str] = []  # optional queue of stale SSIDs returned before active_ssid
        self.deleted: list[tuple[str, str]] = []
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> str:
        fleet = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_args: object) -> None:
                pass

            def _current_ssid(self) -> str:
                if fleet.lag_ssids:
                    return fleet.lag_ssids.pop(0)
                assert fleet.active_ssid is not None
                return fleet.active_ssid

            def do_GET(self) -> None:
                parsed = urllib.parse.urlsplit(self.path)
                qs = urllib.parse.parse_qs(parsed.query)
                if parsed.path == "/api/files":
                    ssid = self._current_ssid()
                    files = fleet.devices[ssid]
                    payload = {
                        "ssid": ssid,
                        "truncated": ssid in fleet.truncated,
                        "total": len(files),
                        "files": [{"name": k, "size": len(v)} for k, v in files.items()],
                    }
                    body = json.dumps(payload).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return

                if parsed.path == "/download":
                    ssid = fleet.active_ssid
                    assert ssid is not None
                    name = qs.get("name", [""])[0]
                    files = fleet.devices[ssid]
                    if name not in files:
                        self.send_response(404)
                        self.end_headers()
                        return
                    data = files[name]
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return

                if parsed.path == "/download-all.zip":
                    ssid = fleet.active_ssid
                    assert ssid is not None
                    buf = io.BytesIO()
                    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
                        for name, data in fleet.devices[ssid].items():
                            zf.writestr(name, data)
                    raw = buf.getvalue()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return

                self.send_response(404)
                self.end_headers()

            def do_POST(self) -> None:
                parsed = urllib.parse.urlsplit(self.path)
                qs = urllib.parse.parse_qs(parsed.query)
                if parsed.path == "/api/delete":
                    ssid = fleet.active_ssid
                    assert ssid is not None
                    name = qs.get("name", [""])[0]
                    files = fleet.devices[ssid]
                    if name not in files:
                        self.send_response(404)
                        self.end_headers()
                        return
                    del files[name]
                    fleet.deleted.append((ssid, name))
                    body = b'{"ok":true}'
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return

                self.send_response(404)
                self.end_headers()

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        port = self._server.server_port
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return f"http://127.0.0.1:{port}"

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()


class MockWifiBackend(wc.WifiBackend):
    def __init__(
        self,
        fleet: FakeCardputerFleet,
        online_ssids: set[str],
        preferred: list[str] | None = None,
    ):
        self.fleet = fleet
        self.online_ssids = set(online_ssids)
        self.preferred = list(preferred or [])
        self.joined: list[str] = []
        self.sweeps: int = 0
        self.restored: list[tuple[str | None, list[str], bool]] = []

    def prepare_sweep(self) -> None:
        self.sweeps += 1

    def list_preferred_networks(self) -> list[str]:
        return list(self.preferred)

    def join(self, ssid: str) -> tuple[bool, str]:
        self.joined.append(ssid)
        if ssid not in self.online_ssids:
            return False, f"Could not find network {ssid}."
        self.fleet.active_ssid = ssid
        return True, ""

    def remove_preferred(self, ssid: str) -> None:
        if ssid in self.preferred:
            self.preferred.remove(ssid)

    def restore(
        self,
        restore_ssid: str | None,
        remove_ssids: list[str],
        *,
        should_disconnect: bool = True,
    ) -> None:
        self.restored.append((restore_ssid, list(remove_ssids), should_disconnect))


class TestWorkshopCollect(unittest.TestCase):
    def test_parse_devices_file_and_labels(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "devices.txt"
            p.write_text(
                "# comment\n"
                "\n"
                "BioMapping-3E5C\n"
                "BioMapping-A1B2  Kit-02  # alice\n"
                "BioMapping-9F04=Unit 3!\n"
                "BioMapping-3E5C  IgnoredDuplicate\n",
                encoding="utf-8",
            )
            specs = wc.load_devices_file(p)
            self.assertEqual(
                specs,
                [
                    wc.DeviceSpec("BioMapping-3E5C", "BioMapping-3E5C"),
                    wc.DeviceSpec("BioMapping-A1B2", "Kit-02"),
                    wc.DeviceSpec("BioMapping-9F04", "Unit_3"),
                ],
            )

    def test_duplicate_label_rejected(self) -> None:
        with self.assertRaises(ValueError):
            wc.validate_device_specs(
                [
                    wc.DeviceSpec("BioMapping-3E5C", "Kit-01"),
                    wc.DeviceSpec("BioMapping-A1B2", "kit-01"),
                ]
            )

    def test_build_local_filename(self) -> None:
        self.assertEqual(
            wc.build_local_filename("BioMapping-3E5C", "biomap_0042_2026-11-22_14-00-00.csv"),
            "BioMapping-3E5C_biomap_0042_2026-11-22_14-00-00.csv",
        )
        self.assertEqual(
            wc.build_local_filename("Kit-02", "Kit-02_biomap_0042.csv"),
            "Kit-02_biomap_0042.csv",
        )
        with self.assertRaises(ValueError):
            wc.build_local_filename("Kit-02", "../secret.csv")
        with self.assertRaises(ValueError):
            wc.build_local_filename("Kit-02", "biomap.settings")

    def test_verify_csv_variants(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)

            good = root / "good.csv"
            good.write_bytes(make_valid_csv(["0.0,1.23", "0.1,1.25"]))
            res = wc.verify_csv_file(good, expected_size=good.stat().st_size)
            self.assertTrue(res.ok)
            self.assertEqual(res.status, "checksum_ok")
            self.assertEqual(res.warnings, ())

            warn_file = root / "warn.csv"
            warn_file.write_bytes(
                make_valid_csv(["0.0,1.23"], include_end_time=False, overflows=2, flush_fails=1)
            )
            res_w = wc.verify_csv_file(warn_file)
            self.assertTrue(res_w.ok)
            self.assertEqual(len(res_w.warnings), 2)

            bad_crc = root / "bad_crc.csv"
            bad_crc.write_bytes(make_valid_csv(["0.0,1.23"], corrupt_crc=True))
            res_b = wc.verify_csv_file(bad_crc)
            self.assertFalse(res_b.ok)
            self.assertEqual(res_b.status, "crc_mismatch")

            no_end = root / "no_end.csv"
            no_end.write_bytes(make_valid_csv(["0.0,1.23"], omit_end=True))
            res_e = wc.verify_csv_file(no_end)
            self.assertFalse(res_e.ok)
            self.assertEqual(res_e.status, "missing_end_line")

            legacy = root / "legacy.csv"
            legacy.write_bytes(b"time_s,gsr_us\n0.0,1.0\n")
            res_l = wc.verify_csv_file(legacy, expected_size=legacy.stat().st_size)
            self.assertTrue(res_l.ok)
            self.assertEqual(res_l.status, "no_checksum_header")

            empty = root / "empty.csv"
            empty.write_bytes(b"")
            res_empty = wc.verify_csv_file(empty, expected_size=0)
            self.assertFalse(res_empty.ok)
            self.assertEqual(res_empty.status, "empty_file")

    def test_multi_device_shared_folder_and_incremental_skip(self) -> None:
        csv_a = make_valid_csv(["0.0,2.10", "0.1,2.20"])
        csv_b = make_valid_csv(["0.0,5.50", "0.1,5.60", "0.2,5.70"])
        # Both devices have the exact same filename on their SD cards!
        fleet = FakeCardputerFleet(
            {
                "BioMapping-3E5C": {"biomap_0001_nodate.csv": csv_a},
                "BioMapping-A1B2": {"biomap_0001_nodate.csv": csv_b},
            }
        )
        base_url = fleet.start()
        try:
            wifi = MockWifiBackend(fleet, online_ssids={"BioMapping-3E5C", "BioMapping-A1B2"})
            client = wc.CardputerClient(base_url=base_url)

            with tempfile.TemporaryDirectory() as td:
                out_dir = Path(td)
                s1 = wc.DeviceSpec("BioMapping-3E5C", "BioMapping-3E5C")
                s2 = wc.DeviceSpec("BioMapping-A1B2", "Kit-02")
                s3 = wc.DeviceSpec("BioMapping-9F04", "Kit-03")

                r1 = wc.collect_device(s1, out_dir, wifi, client, log=lambda _m: None)
                r2 = wc.collect_device(s2, out_dir, wifi, client, log=lambda _m: None)
                r3 = wc.collect_device(s3, out_dir, wifi, client, log=lambda _m: None)

                self.assertEqual(r1.status, "ok")
                self.assertEqual(r1.new_count, 1)
                self.assertEqual(r2.status, "ok")
                self.assertEqual(r2.new_count, 1)
                self.assertEqual(r3.status, "offline")

                p1 = out_dir / "BioMapping-3E5C_biomap_0001_nodate.csv"
                p2 = out_dir / "Kit-02_biomap_0001_nodate.csv"
                self.assertTrue(p1.is_file())
                self.assertTrue(p2.is_file())
                self.assertEqual(p1.read_bytes(), csv_a)
                self.assertEqual(p2.read_bytes(), csv_b)

                # Re-running skips existing matching files cleanly.
                r1_again = wc.collect_device(s1, out_dir, wifi, client, log=lambda _m: None)
                self.assertEqual(r1_again.new_count, 0)
                self.assertEqual(r1_again.skipped_count, 1)

                # Collection log persists and appends cleanly.
                log_path = wc.write_collection_log(out_dir, [r1, r2, r3])
                data = json.loads(log_path.read_text(encoding="utf-8"))
                self.assertEqual(len(data["runs"]), 1)
                self.assertEqual(len(data["runs"][0]["devices"]), 3)
        finally:
            fleet.stop()

    def test_identity_mismatch_guard_waits_for_switch(self) -> None:
        csv_b = make_valid_csv(["0.0,3.14"])
        fleet = FakeCardputerFleet(
            {
                "BioMapping-3E5C": {"old.csv": make_valid_csv(["0.0,1.00"])},
                "BioMapping-A1B2": {"walk.csv": csv_b},
            }
        )
        # Simulate macOS momentarily still answering as BioMapping-3E5C twice.
        fleet.lag_ssids = ["BioMapping-3E5C", "BioMapping-3E5C"]
        base_url = fleet.start()
        try:
            wifi = MockWifiBackend(fleet, online_ssids={"BioMapping-A1B2"})
            client = wc.CardputerClient(base_url=base_url)
            with tempfile.TemporaryDirectory() as td:
                out_dir = Path(td)
                res = wc.collect_device(
                    wc.DeviceSpec("BioMapping-A1B2", "BioMapping-A1B2"),
                    out_dir,
                    wifi,
                    client,
                    connect_timeout=5.0,
                    log=lambda _m: None,
                    sleep_fn=lambda _s: None,
                )
                self.assertEqual(res.status, "ok")
                self.assertEqual(res.new_count, 1)
                self.assertTrue((out_dir / "BioMapping-A1B2_walk.csv").is_file())
                self.assertFalse((out_dir / "BioMapping-A1B2_old.csv").exists())
        finally:
            fleet.stop()

    def test_truncated_list_falls_back_to_zip(self) -> None:
        csv_1 = make_valid_csv(["0.0,1.0"])
        csv_2 = make_valid_csv(["0.0,2.0"])
        fleet = FakeCardputerFleet(
            {"BioMapping-3E5C": {"a.csv": csv_1, "b.csv": csv_2}},
            truncated={"BioMapping-3E5C"},
        )
        base_url = fleet.start()
        try:
            wifi = MockWifiBackend(fleet, online_ssids={"BioMapping-3E5C"})
            client = wc.CardputerClient(base_url=base_url)
            with tempfile.TemporaryDirectory() as td:
                out_dir = Path(td)
                res = wc.collect_device(
                    wc.DeviceSpec("BioMapping-3E5C", "Kit-01"),
                    out_dir,
                    wifi,
                    client,
                    log=lambda _m: None,
                )
                self.assertEqual(res.status, "ok")
                self.assertEqual(res.new_count, 2)
                self.assertEqual((out_dir / "Kit-01_a.csv").read_bytes(), csv_1)
                self.assertEqual((out_dir / "Kit-01_b.csv").read_bytes(), csv_2)
        finally:
            fleet.stop()

    def test_delete_after_download_skips_corrupt_files(self) -> None:
        good_csv = make_valid_csv(["0.0,1.0"])
        bad_csv = make_valid_csv(["0.0,2.0"], corrupt_crc=True)
        fleet = FakeCardputerFleet(
            {"BioMapping-3E5C": {"good.csv": good_csv, "bad.csv": bad_csv}}
        )
        base_url = fleet.start()
        try:
            wifi = MockWifiBackend(fleet, online_ssids={"BioMapping-3E5C"})
            client = wc.CardputerClient(base_url=base_url)
            with tempfile.TemporaryDirectory() as td:
                out_dir = Path(td)
                res = wc.collect_device(
                    wc.DeviceSpec("BioMapping-3E5C", "BioMapping-3E5C"),
                    out_dir,
                    wifi,
                    client,
                    delete_after_download=True,
                    log=lambda _m: None,
                )
                self.assertEqual(res.status, "partial")
                self.assertEqual(res.new_count, 2)
                self.assertEqual(res.failed_count, 1)
                self.assertEqual(res.deleted_count, 1)
                self.assertEqual(fleet.deleted, [("BioMapping-3E5C", "good.csv")])
                # Corrupt file stays untouched on the Cardputer AND kept on disk for inspection.
                self.assertIn("bad.csv", fleet.devices["BioMapping-3E5C"])
                self.assertTrue((out_dir / "BioMapping-3E5C_bad.csv").is_file())
        finally:
            fleet.stop()

    def test_corrupted_local_file_same_size_is_redownloaded(self) -> None:
        clean_csv = make_valid_csv(["0.0,1.00", "0.1,1.10"])
        corrupt_same_size = make_valid_csv(["0.0,1.00", "0.1,1.10"], corrupt_crc=True)
        self.assertEqual(len(clean_csv), len(corrupt_same_size))

        fleet = FakeCardputerFleet({"BioMapping-3E5C": {"walk.csv": clean_csv}})
        base_url = fleet.start()
        try:
            wifi = MockWifiBackend(fleet, online_ssids={"BioMapping-3E5C"})
            client = wc.CardputerClient(base_url=base_url)
            with tempfile.TemporaryDirectory() as td:
                out_dir = Path(td)
                local_path = out_dir / "BioMapping-3E5C_walk.csv"
                local_path.write_bytes(corrupt_same_size)

                res = wc.collect_device(
                    wc.DeviceSpec("BioMapping-3E5C", "BioMapping-3E5C"),
                    out_dir,
                    wifi,
                    client,
                    log=lambda _m: None,
                )
                self.assertEqual(res.status, "ok")
                self.assertEqual(res.new_count, 1)
                self.assertEqual(res.skipped_count, 0)
                self.assertEqual(local_path.read_bytes(), clean_csv)
        finally:
            fleet.stop()

    def test_zip_skipped_valid_file_still_eligible_for_delete(self) -> None:
        csv_1 = make_valid_csv(["0.0,1.0"])
        fleet = FakeCardputerFleet({"BioMapping-3E5C": {"a.csv": csv_1}}, truncated={"BioMapping-3E5C"})
        base_url = fleet.start()
        try:
            wifi = MockWifiBackend(fleet, online_ssids={"BioMapping-3E5C"})
            client = wc.CardputerClient(base_url=base_url)
            with tempfile.TemporaryDirectory() as td:
                out_dir = Path(td)
                (out_dir / "Kit-01_a.csv").write_bytes(csv_1)

                res = wc.collect_device(
                    wc.DeviceSpec("BioMapping-3E5C", "Kit-01"),
                    out_dir,
                    wifi,
                    client,
                    delete_after_download=True,
                    log=lambda _m: None,
                )
                self.assertEqual(res.status, "ok")
                self.assertEqual(res.skipped_count, 1)
                self.assertEqual(res.deleted_count, 1)
                self.assertEqual(fleet.deleted, [("BioMapping-3E5C", "a.csv")])
        finally:
            fleet.stop()

    def test_macos_join_timeout_handled_cleanly(self) -> None:
        import subprocess
        from unittest import mock

        backend = wc.MacOSWifiBackend(interface="en0")
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("networksetup", 25)):
            ok, msg = backend.join("BioMapping-3E5C")
        self.assertFalse(ok)
        self.assertIn("timed out", msg)

    def test_main_restores_wifi_even_for_previously_remembered_device(self) -> None:
        csv_1 = make_valid_csv(["0.0,1.0"])
        fleet = FakeCardputerFleet({"BioMapping-3E5C": {"walk.csv": csv_1}})
        base_url = fleet.start()
        try:
            # BioMapping-3E5C is ALREADY in macOS preferred networks!
            wifi = MockWifiBackend(
                fleet,
                online_ssids={"BioMapping-3E5C"},
                preferred=["HomeWiFi", "BioMapping-3E5C"],
            )
            with tempfile.TemporaryDirectory() as td:
                out_dir = Path(td)
                rc = wc.main(
                    ["--devices", "BioMapping-3E5C", "--out", str(out_dir), "--host", base_url],
                    wifi_backend=wifi,
                    sleep_fn=lambda _s: None,
                )
                self.assertEqual(rc, 0)
                # Must disconnect even though BioMapping-3E5C was not newly added to preferred.
                self.assertEqual(len(wifi.restored), 1)
                restore_ssid, remove_ssids, should_disconnect = wifi.restored[0]
                self.assertIsNone(restore_ssid)
                self.assertEqual(remove_ssids, [])
                self.assertTrue(should_disconnect)
        finally:
            fleet.stop()

    def test_main_watch_preserves_session_totals_and_single_log_entry(self) -> None:
        csv_a = make_valid_csv(["0.0,1.0", "0.1,1.1"])
        csv_b = make_valid_csv(["0.0,2.0"])
        fleet = FakeCardputerFleet(
            {
                "BioMapping-3E5C": {"w1.csv": csv_a},
                "BioMapping-A1B2": {"w2.csv": csv_b},
            }
        )
        base_url = fleet.start()
        try:
            # Start with only 3E5C online; bring A1B2 online on the second pass.
            wifi = MockWifiBackend(fleet, online_ssids={"BioMapping-3E5C"})
            fake_clock = [100.0]

            def monotonic_fn() -> float:
                return fake_clock[0]

            def sleep_fn(sec: float) -> None:
                fake_clock[0] += 70.0  # advance past 60s cooldown so 3E5C is re-checked on pass 2
                wifi.online_ssids.add("BioMapping-A1B2")

            with tempfile.TemporaryDirectory() as td:
                out_dir = Path(td)
                rc = wc.main(
                    [
                        "--devices",
                        "BioMapping-3E5C",
                        "BioMapping-A1B2=Kit-02",
                        "--out",
                        str(out_dir),
                        "--host",
                        base_url,
                        "--watch",
                        "--cooldown",
                        "60",
                        "--interval",
                        "1",
                        "--no-bell",
                    ],
                    wifi_backend=wifi,
                    sleep_fn=sleep_fn,
                    monotonic_fn=monotonic_fn,
                    max_passes=2,
                )
                self.assertEqual(rc, 0)
                # Released Cardputer Wi-Fi after pass 1 and pass 2.
                self.assertEqual(len(wifi.restored), 2)
                self.assertTrue((out_dir / "BioMapping-3E5C_w1.csv").is_file())
                self.assertTrue((out_dir / "Kit-02_w2.csv").is_file())

                # collection_log.json must have ONE clean session entry, preserving 3E5C's download count!
                log_data = json.loads((out_dir / "collection_log.json").read_text(encoding="utf-8"))
                self.assertEqual(len(log_data["runs"]), 1)
                by_ssid = {d["ssid"]: d for d in log_data["runs"][0]["devices"]}
                self.assertEqual(by_ssid["BioMapping-3E5C"]["new_count"], 1)
                self.assertEqual(by_ssid["BioMapping-3E5C"]["bytes_downloaded"], len(csv_a))
                self.assertEqual(by_ssid["BioMapping-A1B2"]["new_count"], 1)
        finally:
            fleet.stop()

    def test_watch_candidate_selection_and_cooldown(self) -> None:
        s1 = wc.DeviceSpec("BioMapping-3E5C", "Kit-01")
        s2 = wc.DeviceSpec("BioMapping-A1B2", "Kit-02")
        specs = [s1, s2]

        # Initially both are due.
        self.assertEqual(
            wc.select_watch_candidates(specs, {}, 100.0, cooldown_s=60.0, once_per_device=False),
            [s1, s2],
        )

        # Right after s1 is collected at t=100, only s2 is due at t=120.
        self.assertEqual(
            wc.select_watch_candidates(
                specs, {"BioMapping-3E5C": 100.0}, 120.0, cooldown_s=60.0, once_per_device=False
            ),
            [s2],
        )

        # After cooldown expires (t=165), s1 is re-checked in continuous mode.
        self.assertEqual(
            wc.select_watch_candidates(
                specs, {"BioMapping-3E5C": 100.0}, 165.0, cooldown_s=60.0, once_per_device=False
            ),
            [s1, s2],
        )

        # With once_per_device=True, s1 is never re-checked even after cooldown.
        self.assertEqual(
            wc.select_watch_candidates(
                specs, {"BioMapping-3E5C": 100.0}, 500.0, cooldown_s=60.0, once_per_device=True
            ),
            [s2],
        )


if __name__ == "__main__":
    unittest.main()

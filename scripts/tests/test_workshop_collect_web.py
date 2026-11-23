#!/usr/bin/env python3
"""Tests for the --web page of scripts/workshop_collect.py (workshop_collect_web.py).

Drives the page's own HTTP endpoints against the fake Cardputer and fake
Wi-Fi from test_workshop_collect.py.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = TESTS_DIR.parent
for p in (str(SCRIPTS_DIR), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

import workshop_collect as wc  # noqa: E402
import workshop_collect_web as web  # noqa: E402
from test_workshop_collect import FakeCardputerFleet, MockWifiBackend, make_valid_csv  # noqa: E402

SSID = "BioMapping-3E5C"


class WebPageTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name) / "saved"
        self.good = make_valid_csv(["0.0,2.10", "0.1,2.20"])
        self.other = make_valid_csv(["0.0,5.50"])
        self.fleet = FakeCardputerFleet(
            {SSID: {"biomap_0002_nodate.csv": self.good, "biomap_0001_nodate.csv": self.other}}
        )
        base = self.fleet.start()
        self.wifi = MockWifiBackend(self.fleet, online_ssids={SSID})
        self.settings_path = Path(self.tmp.name) / "settings.json"
        self.collector = web.Collector(
            wifi=self.wifi,
            client=wc.CardputerClient(base_url=base),
            settings={"ssid": SSID, "label": "", "folder": str(self.folder)},
            settings_path=self.settings_path,
            connect_timeout=3,
        )
        self.server = web.make_server(self.collector, 0)
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self) -> None:
        if self.collector.thread is not None:
            self.collector.thread.join(5)
        self.server.shutdown()
        self.server.server_close()
        self.fleet.stop()
        self.tmp.cleanup()

    # -- helpers --

    def request(self, path: str, body: dict | None = None, headers: dict | None = None):
        data = None if body is None else json.dumps(body).encode()
        h = {"Content-Type": "application/json"}
        if body is not None:
            h[web.REQUEST_HEADER] = "1"
        h.update(headers or {})
        req = urllib.request.Request(self.url + path, data=data, headers=h)
        try:
            with self.opener.open(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")

    def wait_done(self) -> dict:
        end = time.time() + 10
        while time.time() < end:
            _code, state = self.request("/api/state")
            if not state["busy"] and state["job"]["state"] in ("done", "error"):
                return state
            time.sleep(0.05)
        self.fail("job did not finish")

    def statuses(self, state: dict) -> dict:
        return {f["name"]: f["status"] for f in state["job"]["files"]}

    # -- tests --

    def test_page_is_served(self) -> None:
        with self.opener.open(self.url + "/", timeout=5) as resp:
            html = resp.read().decode()
        self.assertIn("Download new recordings", html)

    def test_check_then_download_then_nothing_new(self) -> None:
        code, _ = self.request("/api/check", {})
        self.assertEqual(code, 200)
        state = self.wait_done()
        self.assertEqual(state["job"]["state"], "done")
        self.assertEqual(set(self.statuses(state).values()), {"new"})
        self.assertFalse(self.folder.exists() and any(self.folder.iterdir()), "check wrote files")
        self.assertEqual(len(self.wifi.restored), 1, "Wi-Fi not switched back after a check")

        code, _ = self.request("/api/download", {})
        self.assertEqual(code, 200)
        state = self.wait_done()
        self.assertEqual(set(self.statuses(state).values()), {"saved"})
        self.assertEqual((self.folder / f"{SSID}_biomap_0002_nodate.csv").read_bytes(), self.good)
        self.assertEqual(state["job"]["done_bytes"], state["job"]["new_bytes"])
        self.assertTrue((self.folder / "collection_log.json").is_file())
        self.assertEqual(self.wifi.restored[-1], (None, [SSID], True))
        self.assertEqual(self.fleet.deleted, [], "deleted without being asked")

        self.request("/api/download", {})
        state = self.wait_done()
        self.assertEqual(set(self.statuses(state).values()), {"have"})
        self.assertEqual(state["job"]["new_bytes"], 0)

    def test_settings_from_page_are_used_and_remembered(self) -> None:
        other = Path(self.tmp.name) / "elsewhere"
        self.request("/api/download", {"folder": str(other), "label": "Kit 2", "ssid": SSID})
        self.wait_done()
        self.assertTrue((other / "Kit_2_biomap_0001_nodate.csv").is_file())
        saved = json.loads(self.settings_path.read_text())
        self.assertEqual(saved["folder"], str(other.resolve()))
        self.assertEqual(saved["label"], "Kit 2")

    def test_delete_only_when_asked(self) -> None:
        self.request("/api/download", {"delete": True})
        state = self.wait_done()
        self.assertEqual(sorted(n for _s, n in self.fleet.deleted),
                         ["biomap_0001_nodate.csv", "biomap_0002_nodate.csv"])
        self.assertTrue(all(f["deleted"] for f in state["job"]["files"]))

    def test_damaged_file_shown_and_not_deleted(self) -> None:
        self.fleet.devices[SSID]["biomap_0003_nodate.csv"] = make_valid_csv(["1"], corrupt_crc=True)
        self.request("/api/download", {"delete": True})
        state = self.wait_done()
        self.assertEqual(self.statuses(state)["biomap_0003_nodate.csv"], "bad")
        self.assertNotIn((SSID, "biomap_0003_nodate.csv"), self.fleet.deleted)
        self.assertTrue(state["job"]["warnings"])

    def test_cardputer_not_found(self) -> None:
        self.wifi.online_ssids.clear()
        self.request("/api/download", {})
        state = self.wait_done()
        self.assertEqual(state["job"]["state"], "error")
        self.assertIn("Wi-Fi Files", state["job"]["message"])
        self.assertEqual(self.wifi.restored, [], "switched Wi-Fi though it never joined")

    def test_refuses_requests_from_other_websites(self) -> None:
        # No custom header: what a form on another website would send.
        code, _ = self.request("/api/download", {}, headers={web.REQUEST_HEADER: ""})
        self.assertEqual(code, 403)
        # Right header but another host name (DNS rebinding).
        code, _ = self.request("/api/state", headers={"Host": f"evil.example:{self.port}"})
        self.assertEqual(code, 403)
        self.assertIsNone(self.collector.thread)

    def test_bad_settings_rejected(self) -> None:
        code, data = self.request("/api/download", {"ssid": ""})
        self.assertEqual(code, 400)
        self.assertIn("Wi-Fi name", data["error"])
        a_file = Path(self.tmp.name) / "a.txt"
        a_file.write_text("x")
        code, data = self.request("/api/settings", {"folder": str(a_file)})
        self.assertEqual(code, 400)
        self.assertIn("is a file", data["error"])

    def test_one_job_at_a_time(self) -> None:
        gate = threading.Event()
        real_join = self.wifi.join

        def slow_join(ssid: str):
            gate.wait(5)
            return real_join(ssid)

        self.wifi.join = slow_join  # type: ignore[method-assign]
        self.assertEqual(self.request("/api/download", {})[0], 200)
        self.assertEqual(self.request("/api/check", {})[0], 409)
        self.assertEqual(self.request("/api/settings", {"label": "x"})[0], 409)
        gate.set()
        self.wait_done()


class InitialSettingsTest(unittest.TestCase):
    def args(self, out=None) -> argparse.Namespace:
        return argparse.Namespace(out=out)

    def test_command_line_wins_over_saved(self) -> None:
        wifi = MockWifiBackend(FakeCardputerFleet({}), set(), preferred=["Home", "BioMapping-AAAA"])
        saved = {"folder": "/old", "ssid": "BioMapping-OLD", "label": "Old"}
        s = web.initial_settings(self.args(Path("/new")), wifi,
                                 [wc.DeviceSpec("BioMapping-3E5C", "Kit")], saved)
        self.assertEqual(s, {"folder": str(Path("/new").resolve()), "ssid": "BioMapping-3E5C", "label": "Kit"})

    def test_saved_then_known_networks(self) -> None:
        wifi = MockWifiBackend(FakeCardputerFleet({}), set(), preferred=["Home", "BioMapping-AAAA"])
        self.assertEqual(web.initial_settings(self.args(), wifi, [], {"ssid": "BioMapping-OLD", "folder": "/f"})["ssid"],
                         "BioMapping-OLD")
        fresh = web.initial_settings(self.args(), wifi, [], {})
        self.assertEqual(fresh["ssid"], "BioMapping-AAAA")
        self.assertTrue(fresh["folder"].endswith(wc._default_output_dir().name))


class CollectDeviceHooksTest(unittest.TestCase):
    def test_hooks_hear_listing_and_each_file(self) -> None:
        fleet = FakeCardputerFleet({SSID: {"biomap_0001_nodate.csv": make_valid_csv(["0"])}})
        base = fleet.start()
        try:
            listings, records = [], []
            with tempfile.TemporaryDirectory() as td:
                res = wc.collect_device(
                    wc.DeviceSpec(SSID, SSID), Path(td),
                    MockWifiBackend(fleet, {SSID}), wc.CardputerClient(base),
                    log=lambda _m: None,
                    on_listing=lambda files, total, trunc: listings.append((len(files), total, trunc)),
                    on_file=records.append,
                )
            self.assertEqual(listings, [(1, 1, False)])
            self.assertEqual(records, res.files)
        finally:
            fleet.stop()


if __name__ == "__main__":
    unittest.main()

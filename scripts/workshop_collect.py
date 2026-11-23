#!/usr/bin/env python3
"""Collect BioMapping CSV recordings from multiple Cardputers over Wi-Fi.

Hops through a defined list of Cardputer Wi-Fi hotspots (BioMapping-XXXX),
verifies each device's identity before downloading, renames every recording to
include the device name, and saves everything into one shared workshop folder.

Requires Python 3 standard library only (no extra packages, no firmware changes,
and no macOS Location Services permissions).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import platform
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional


DEFAULT_HOST = "http://192.168.4.1"
DEFAULT_CONNECT_TIMEOUT = 12.0
DEFAULT_POLL_INTERVAL = 0.5
DEFAULT_WATCH_INTERVAL = 5.0
DEFAULT_WATCH_COOLDOWN = 60.0
DOWNLOAD_CHUNK_BYTES = 16384
ZIP_CHUNK_BYTES = 32768
MAX_REMOTE_NAME_LEN = 63

INTEGRITY_HEADER = b"# Integrity: crc32 v1\n"
END_LINE_RE = re.compile(
    rb"^# End rows:(\d+) bytes:(\d+) crc32:([0-9a-f]{8}) "
    rb"(?:end_time:\d+ )?overflows:(\d+) flush_fails:(\d+)$"
)


@dataclass(frozen=True)
class DeviceSpec:
    """One Cardputer Wi-Fi hotspot and the prefix to use in saved filenames."""

    ssid: str
    label: str


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    status: str  # checksum_ok | no_checksum_header | empty_file | size_mismatch | missing_end_line | crc_mismatch
    detail: str = ""
    warnings: tuple[str, ...] = ()


@dataclass
class FileRecord:
    remote_name: str
    local_name: str
    size: int
    action: str  # downloaded | skipped | failed | would_download
    verify_status: str = ""
    verify_detail: str = ""
    deleted_from_device: bool = False


@dataclass
class DeviceResult:
    spec: DeviceSpec
    status: str  # ok | partial | offline | error | dry_run
    new_count: int = 0
    skipped_count: int = 0
    failed_count: int = 0
    deleted_count: int = 0
    bytes_downloaded: int = 0
    duration_s: float = 0.0
    error: str = ""
    warnings: list[str] = field(default_factory=list)
    files: list[FileRecord] = field(default_factory=list)


# ── Filename & device list helpers ────────────────────────────────────────


def sanitize_label(raw: str, fallback: str) -> str:
    """Clean a device label so it is safe to put at the start of a filename."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", raw.strip())
    cleaned = cleaned.strip("._-")
    if not cleaned:
        cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", fallback.strip()).strip("._-")
    return cleaned or "device"


def remote_name_valid(name: str) -> bool:
    """Match firmware's wifi_files_name_valid() safety rules."""
    if not name or name.startswith(".") or len(name) > MAX_REMOTE_NAME_LEN:
        return False
    if ".." in name:
        return False
    for ch in name:
        code = ord(ch)
        if code < 0x20 or code >= 0x7F or ch in '/\\"<>':
            return False
    return len(name) >= 5 and name.lower().endswith(".csv")


def build_local_filename(label: str, remote_name: str) -> str:
    """Build the saved filename in the shared folder, including the device name."""
    if not remote_name_valid(remote_name):
        raise ValueError(f"Unsafe remote filename: {remote_name!r}")
    prefix = f"{label}_"
    if remote_name.startswith(prefix):
        return remote_name
    return f"{prefix}{remote_name}"


def parse_device_entry(text: str) -> Optional[DeviceSpec]:
    """Parse one line from a devices file or one --devices argument.

    Supports:
      BioMapping-3E5C
      BioMapping-3E5C  Kit-01
      BioMapping-3E5C=Kit-01
      BioMapping-3E5C  Kit 01  # inline comment
    """
    no_comment = text.split("#", 1)[0].strip()
    if not no_comment:
        return None
    if "=" in no_comment and not any(ch.isspace() for ch in no_comment.split("=", 1)[0]):
        ssid, raw_label = no_comment.split("=", 1)
        ssid = ssid.strip()
        raw_label = raw_label.strip() or ssid
    else:
        parts = no_comment.split()
        ssid = parts[0]
        raw_label = "_".join(parts[1:]) if len(parts) > 1 else ssid
    if not ssid:
        return None
    return DeviceSpec(ssid=ssid, label=sanitize_label(raw_label, fallback=ssid))


def load_devices_file(path: Path) -> list[DeviceSpec]:
    """Read a plain text list of Cardputer Wi-Fi networks."""
    specs: list[DeviceSpec] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            spec = parse_device_entry(line)
            if spec is not None:
                specs.append(spec)
    return validate_device_specs(specs)


def validate_device_specs(specs: list[DeviceSpec]) -> list[DeviceSpec]:
    """Deduplicate by SSID and reject duplicate filename labels across devices."""
    unique: list[DeviceSpec] = []
    seen_ssids: dict[str, DeviceSpec] = {}
    seen_labels: dict[str, str] = {}
    for spec in specs:
        if spec.ssid in seen_ssids:
            continue
        label_key = spec.label.lower()
        if label_key in seen_labels:
            other = seen_labels[label_key]
            raise ValueError(
                f"Devices {other!r} and {spec.ssid!r} both use the filename label "
                f"{spec.label!r}. Give each device a unique label so files cannot clash."
            )
        seen_ssids[spec.ssid] = spec
        seen_labels[label_key] = spec.ssid
        unique.append(spec)
    return unique


def format_size(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    if num_bytes < 1024 * 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.1f} MB"
    return f"{num_bytes / (1024 * 1024 * 1024):.1f} GB"


# ── CSV integrity verification ────────────────────────────────────────────


def verify_csv_file(path: Path, expected_size: Optional[int] = None) -> VerifyResult:
    """Check file size and (when present) the Cardputer's CRC-32 # End footer."""
    data = path.read_bytes()
    if expected_size is not None and len(data) != expected_size:
        return VerifyResult(
            ok=False,
            status="size_mismatch",
            detail=f"got {len(data)} bytes, Cardputer reported {expected_size}",
        )
    if len(data) == 0:
        return VerifyResult(
            ok=False,
            status="empty_file",
            detail="file is empty (0 bytes)",
        )

    if not data.startswith(INTEGRITY_HEADER):
        return VerifyResult(ok=True, status="no_checksum_header")

    body, sep, trailer = data.rstrip(b"\n").rpartition(b"\n")
    if not sep:
        return VerifyResult(
            ok=False,
            status="missing_end_line",
            detail="recording has no # End footer (stopped abruptly?)",
        )
    body += b"\n"
    match = END_LINE_RE.match(trailer)
    if not match:
        return VerifyResult(
            ok=False,
            status="missing_end_line",
            detail="recording has no # End footer (stopped abruptly?)",
        )

    _rows_t = int(match.group(1))
    bytes_t = int(match.group(2))
    crc_t = int(match.group(3), 16)
    overflows = int(match.group(4))
    flush_fails = int(match.group(5))

    if len(body) != bytes_t:
        return VerifyResult(
            ok=False,
            status="crc_mismatch",
            detail=f"body is {len(body)} bytes, # End says {bytes_t}",
        )
    actual_crc = zlib.crc32(body) & 0xFFFFFFFF
    if actual_crc != crc_t:
        return VerifyResult(
            ok=False,
            status="crc_mismatch",
            detail=f"checksum {actual_crc:08x} != expected {crc_t:08x}",
        )

    warnings: list[str] = []
    if overflows > 0:
        warnings.append(f"{overflows} buffer overflow(s) recorded")
    if flush_fails > 0:
        warnings.append(f"{flush_fails} SD flush failure(s) recorded")

    return VerifyResult(ok=True, status="checksum_ok", warnings=tuple(warnings))


# ── Wi-Fi backends ────────────────────────────────────────────────────────


class WifiBackend:
    """Minimal Wi-Fi control interface (real OS implementation or test mock)."""

    def prepare_sweep(self) -> None:
        """Optional hook run once before a sweep across multiple devices."""

    def list_preferred_networks(self) -> list[str]:
        raise NotImplementedError

    def join(self, ssid: str) -> tuple[bool, str]:
        raise NotImplementedError

    def remove_preferred(self, ssid: str) -> None:
        raise NotImplementedError

    def restore(
        self,
        restore_ssid: Optional[str],
        remove_ssids: list[str],
        *,
        should_disconnect: bool = True,
    ) -> None:
        raise NotImplementedError


class MacOSWifiBackend(WifiBackend):
    """Controls macOS Wi-Fi using built-in networksetup (no Location needed)."""

    def __init__(self, interface: Optional[str] = None) -> None:
        self.interface = interface or self._detect_wifi_interface()

    @staticmethod
    def _detect_wifi_interface() -> str:
        proc = subprocess.run(
            ["networksetup", "-listallhardwareports"],
            capture_output=True,
            text=True,
            check=False,
        )
        lines = proc.stdout.splitlines()
        for idx, line in enumerate(lines):
            if "Hardware Port: Wi-Fi" in line or "Hardware Port: AirPort" in line:
                for sub in lines[idx + 1 : idx + 4]:
                    m = re.match(r"^\s*Device:\s*(\S+)", sub)
                    if m:
                        return m.group(1)
        return "en0"

    def list_preferred_networks(self) -> list[str]:
        proc = subprocess.run(
            ["networksetup", "-listpreferredwirelessnetworks", self.interface],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            return []
        nets: list[str] = []
        for line in proc.stdout.splitlines()[1:]:
            name = line.strip()
            if name:
                nets.append(name)
        return nets

    def join(self, ssid: str) -> tuple[bool, str]:
        try:
            proc = subprocess.run(
                ["networksetup", "-setairportnetwork", self.interface, ssid],
                capture_output=True,
                text=True,
                timeout=25,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return False, f"timed out trying to join {ssid}"
        except OSError as exc:
            return False, f"could not run networksetup: {exc}"

        combined = (proc.stdout + "\n" + proc.stderr).strip()
        lower = combined.lower()
        # networksetup sometimes exits 0 even when it prints an error message.
        if proc.returncode != 0 or any(
            err in lower
            for err in (
                "could not find network",
                "failed to join",
                "error:",
                "not a wi-fi interface",
                "network services are disabled",
            )
        ):
            return False, combined or f"networksetup exited with {proc.returncode}"
        return True, combined

    def remove_preferred(self, ssid: str) -> None:
        try:
            subprocess.run(
                ["networksetup", "-removepreferredwirelessnetwork", self.interface, ssid],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            pass

    def restore(
        self,
        restore_ssid: Optional[str],
        remove_ssids: list[str],
        *,
        should_disconnect: bool = True,
    ) -> None:
        for ssid in remove_ssids:
            self.remove_preferred(ssid)
        if restore_ssid:
            self.join(restore_ssid)
            return
        if should_disconnect:
            # Briefly toggle Wi-Fi power so macOS drops the last Cardputer
            # hotspot (letting its screen return to idle) and rejoins normal Wi-Fi.
            try:
                subprocess.run(
                    ["networksetup", "-setairportpower", self.interface, "off"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                time.sleep(1.0)
                subprocess.run(
                    ["networksetup", "-setairportpower", self.interface, "on"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
            except (subprocess.TimeoutExpired, OSError):
                pass


class LinuxWifiBackend(WifiBackend):
    """Controls Linux Wi-Fi using NetworkManager's nmcli."""

    def prepare_sweep(self) -> None:
        try:
            subprocess.run(
                ["nmcli", "device", "wifi", "rescan"],
                capture_output=True,
                timeout=15,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            pass

    def list_preferred_networks(self) -> list[str]:
        proc = subprocess.run(
            ["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            return []
        nets: list[str] = []
        for line in proc.stdout.splitlines():
            name, _, ctype = line.rpartition(":")
            if "wireless" in ctype and name:
                nets.append(name)
        return nets

    def join(self, ssid: str) -> tuple[bool, str]:
        try:
            proc = subprocess.run(
                ["nmcli", "device", "wifi", "connect", ssid],
                capture_output=True,
                text=True,
                timeout=25,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return False, f"timed out trying to join {ssid}"
        except OSError as exc:
            return False, f"could not run nmcli: {exc}"
        combined = (proc.stdout + "\n" + proc.stderr).strip()
        return proc.returncode == 0, combined

    def remove_preferred(self, ssid: str) -> None:
        try:
            subprocess.run(
                ["nmcli", "connection", "delete", ssid],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            pass

    def restore(
        self,
        restore_ssid: Optional[str],
        remove_ssids: list[str],
        *,
        should_disconnect: bool = True,
    ) -> None:
        for ssid in remove_ssids:
            self.remove_preferred(ssid)
        if restore_ssid:
            try:
                subprocess.run(
                    ["nmcli", "connection", "up", restore_ssid],
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
            except (subprocess.TimeoutExpired, OSError):
                pass
        elif should_disconnect:
            try:
                subprocess.run(
                    ["nmcli", "radio", "wifi", "off"],
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
                time.sleep(1.0)
                subprocess.run(
                    ["nmcli", "radio", "wifi", "on"],
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
            except (subprocess.TimeoutExpired, OSError):
                pass


def make_wifi_backend(interface: Optional[str] = None) -> WifiBackend:
    system = platform.system()
    if system == "Darwin":
        return MacOSWifiBackend(interface=interface)
    if system == "Linux":
        return LinuxWifiBackend()
    raise RuntimeError(
        f"Automatic Wi-Fi switching is currently supported on macOS and Linux (detected {system})."
    )


# ── Cardputer HTTP client ─────────────────────────────────────────────────


class CardputerClient:
    """Talks to a Cardputer's Wi-Fi Files HTTP server (bypassing system proxies)."""

    def __init__(self, base_url: str = DEFAULT_HOST) -> None:
        self.base_url = base_url.rstrip("/")
        # Bypass any OS HTTP/HTTPS proxy so 192.168.4.1 always connects directly.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get_files(self, timeout_s: float = 4.0) -> dict:
        req = urllib.request.Request(
            f"{self.base_url}/api/files",
            headers={"Cache-Control": "no-store"},
        )
        with self._opener.open(req, timeout=timeout_s) as resp:
            if resp.status != 200:
                raise RuntimeError(f"GET /api/files returned HTTP {resp.status}")
            return json.loads(resp.read().decode("utf-8"))

    def wait_for_device(
        self,
        expected_ssid: str,
        timeout_s: float = DEFAULT_CONNECT_TIMEOUT,
        poll_interval_s: float = DEFAULT_POLL_INTERVAL,
        sleep_fn: Callable[[float], None] = time.sleep,
        monotonic_fn: Callable[[], float] = time.monotonic,
    ) -> dict:
        """Poll /api/files until the expected Cardputer answers (guards against Wi-Fi switch lag)."""
        deadline = monotonic_fn() + timeout_s
        last_seen_ssid: Optional[str] = None
        last_error: str = "no response"

        while True:
            try:
                data = self.get_files(timeout_s=min(3.0, max(1.0, timeout_s)))
                got_ssid = data.get("ssid")
                if got_ssid == expected_ssid:
                    return data
                last_seen_ssid = str(got_ssid)
                last_error = f"connected to {got_ssid!r} instead of {expected_ssid!r}"
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, RuntimeError) as exc:
                last_error = str(exc)

            remaining = deadline - monotonic_fn()
            if remaining <= 0:
                if last_seen_ssid:
                    raise TimeoutError(
                        f"Timed out waiting for {expected_ssid} "
                        f"(still seeing {last_seen_ssid} at {self.base_url})"
                    )
                raise TimeoutError(
                    f"Timed out waiting for {expected_ssid} at {self.base_url}: {last_error}"
                )
            sleep_fn(min(poll_interval_s, remaining))

    def download_file(
        self,
        remote_name: str,
        dest_path: Path,
        expected_size: int,
        timeout_s: float = 30.0,
    ) -> int:
        """Download one CSV atomically via a .part file and verify byte count."""
        query = urllib.parse.urlencode({"name": remote_name})
        url = f"{self.base_url}/download?{query}"
        part_path = dest_path.with_name(dest_path.name + ".part")
        written = 0
        try:
            with self._opener.open(url, timeout=timeout_s) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"GET /download returned HTTP {resp.status}")
                with part_path.open("wb") as out:
                    while True:
                        chunk = resp.read(DOWNLOAD_CHUNK_BYTES)
                        if not chunk:
                            break
                        out.write(chunk)
                        written += len(chunk)
            if written != expected_size:
                raise IOError(f"incomplete download ({written}/{expected_size} bytes)")
            os.replace(part_path, dest_path)
            return written
        except Exception:
            try:
                part_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    def download_all_zip(self, zip_dest: Path, timeout_s: float = 30.0) -> int:
        """Download /download-all.zip atomically (used when a card has >256 files)."""
        url = f"{self.base_url}/download-all.zip"
        part_path = zip_dest.with_name(zip_dest.name + ".part")
        written = 0
        try:
            with self._opener.open(url, timeout=timeout_s) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"GET /download-all.zip returned HTTP {resp.status}")
                cl_hdr = resp.headers.get("Content-Length")
                expected_len = int(cl_hdr) if cl_hdr and cl_hdr.isdigit() else None
                with part_path.open("wb") as out:
                    while True:
                        chunk = resp.read(ZIP_CHUNK_BYTES)
                        if not chunk:
                            break
                        out.write(chunk)
                        written += len(chunk)
            if expected_len is not None and written != expected_len:
                raise IOError(f"incomplete ZIP download ({written}/{expected_len} bytes)")
            os.replace(part_path, zip_dest)
            return written
        except Exception:
            try:
                part_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    def delete_file(self, remote_name: str, timeout_s: float = 10.0) -> bool:
        """Delete one verified CSV from the Cardputer."""
        query = urllib.parse.urlencode({"name": remote_name})
        req = urllib.request.Request(
            f"{self.base_url}/api/delete?{query}",
            method="POST",
            data=b"",
        )
        with self._opener.open(req, timeout=timeout_s) as resp:
            if resp.status != 200:
                return False
            data = json.loads(resp.read().decode("utf-8"))
            return bool(data.get("ok"))


# ── Collection engine ─────────────────────────────────────────────────────


def _download_one_with_retry(
    client: CardputerClient,
    remote_name: str,
    dest_path: Path,
    expected_size: int,
    retries: int = 1,
) -> int:
    attempt = 0
    while True:
        try:
            return client.download_file(remote_name, dest_path, expected_size)
        except Exception:
            attempt += 1
            if attempt > retries:
                raise
            time.sleep(0.5)


def _download_zip_with_retry(
    client: CardputerClient,
    zip_dest: Path,
    retries: int = 1,
) -> int:
    attempt = 0
    while True:
        try:
            return client.download_all_zip(zip_dest)
        except Exception:
            attempt += 1
            if attempt > retries:
                raise
            time.sleep(0.5)


def _unpack_zip_into_shared_dir(
    zip_path: Path,
    spec: DeviceSpec,
    out_dir: Path,
    result: DeviceResult,
    log: Callable[[str], None],
) -> None:
    """Extract every valid .csv from a Cardputer ZIP into the shared folder with device prefix."""
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            remote_name = Path(info.filename).name
            if not remote_name_valid(remote_name):
                continue
            local_name = build_local_filename(spec.label, remote_name)
            dest_path = out_dir / local_name
            if dest_path.exists() and dest_path.stat().st_size == info.file_size:
                existing_ver = verify_csv_file(dest_path, expected_size=info.file_size)
                if existing_ver.ok:
                    result.skipped_count += 1
                    result.files.append(
                        FileRecord(
                            remote_name=remote_name,
                            local_name=local_name,
                            size=info.file_size,
                            action="skipped",
                            verify_status=existing_ver.status,
                            verify_detail=existing_ver.detail,
                        )
                    )
                    continue
                log(
                    f"    ~ {local_name} failed local check ({existing_ver.detail}); "
                    "re-extracting fresh copy"
                )

            part_path = dest_path.with_name(dest_path.name + ".part")
            try:
                with zf.open(info, "r") as src, part_path.open("wb") as dst:
                    while True:
                        chunk = src.read(DOWNLOAD_CHUNK_BYTES)
                        if not chunk:
                            break
                        dst.write(chunk)
                os.replace(part_path, dest_path)
            except Exception as exc:
                part_path.unlink(missing_ok=True)
                result.failed_count += 1
                result.warnings.append(f"{remote_name}: unpack failed ({exc})")
                result.files.append(
                    FileRecord(
                        remote_name=remote_name,
                        local_name=local_name,
                        size=info.file_size,
                        action="failed",
                        verify_detail=str(exc),
                    )
                )
                continue

            ver = verify_csv_file(dest_path, expected_size=info.file_size)
            result.new_count += 1
            result.bytes_downloaded += info.file_size
            for w in ver.warnings:
                result.warnings.append(f"{local_name}: {w}")
            if not ver.ok:
                result.failed_count += 1
                result.warnings.append(f"{local_name}: {ver.status} ({ver.detail})")
                log(f"    ! {local_name} — WARNING: {ver.detail}")
            else:
                log(f"    + {local_name} ({format_size(info.file_size)})")
            result.files.append(
                FileRecord(
                    remote_name=remote_name,
                    local_name=local_name,
                    size=info.file_size,
                    action="downloaded",
                    verify_status=ver.status,
                    verify_detail=ver.detail,
                )
            )


def collect_device(
    spec: DeviceSpec,
    out_dir: Path,
    wifi: WifiBackend,
    client: CardputerClient,
    *,
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT,
    delete_after_download: bool = False,
    dry_run: bool = False,
    quiet_offline: bool = False,
    log: Callable[[str], None] = print,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> DeviceResult:
    """Join one Cardputer, verify its identity, download new CSVs, and verify checksums."""
    t0 = time.monotonic()
    res = DeviceResult(spec=spec, status="ok")
    label_note = f" (saved as {spec.label}_...)" if spec.label != spec.ssid else ""
    if not quiet_offline:
        log(f"\n[{spec.ssid}]{label_note}")
        log("  Joining Wi-Fi...")

    joined, join_msg = wifi.join(spec.ssid)
    if not joined:
        res.status = "offline"
        res.error = join_msg or "not found"
        res.duration_s = time.monotonic() - t0
        if not quiet_offline:
            log(f"  Offline / not found ({res.error})")
        return res

    if quiet_offline:
        stamp = dt.datetime.now().strftime("%H:%M:%S")
        log(f"\n[{stamp}] Found {spec.ssid}{label_note}")
        log("  Connected to Wi-Fi, checking recordings...")

    try:
        listing = client.wait_for_device(
            expected_ssid=spec.ssid,
            timeout_s=connect_timeout,
            sleep_fn=sleep_fn,
        )
    except Exception as exc:
        res.status = "error"
        res.error = str(exc)
        res.duration_s = time.monotonic() - t0
        log(f"  Could not reach Cardputer: {exc}")
        return res

    files = listing.get("files", [])
    truncated = bool(listing.get("truncated", False))
    total_reported = int(listing.get("total", len(files)))

    if total_reported == 0:
        log("  Connected — no recordings on card.")
        res.duration_s = time.monotonic() - t0
        return res

    log(
        f"  Connected — {total_reported} recording{'s' if total_reported != 1 else ''} on card"
        + (" (more than 256, using ZIP)" if truncated else "")
    )

    if dry_run:
        res.status = "dry_run"
        for entry in files:
            rname = str(entry.get("name", ""))
            rsize = int(entry.get("size", 0))
            if not remote_name_valid(rname):
                continue
            lname = build_local_filename(spec.label, rname)
            dest = out_dir / lname
            if dest.exists() and dest.stat().st_size == rsize and verify_csv_file(dest, rsize).ok:
                res.skipped_count += 1
                res.files.append(FileRecord(rname, lname, rsize, "skipped", "already_present"))
            else:
                res.new_count += 1
                res.files.append(FileRecord(rname, lname, rsize, "would_download"))
                log(f"    [dry-run] would download -> {lname} ({format_size(rsize)})")
        if truncated and total_reported > len(files):
            extra = total_reported - len(files)
            log(f"    [dry-run] plus {extra} older recording(s) via /download-all.zip")
        res.duration_s = time.monotonic() - t0
        return res

    out_dir.mkdir(parents=True, exist_ok=True)

    if truncated:
        tmp_zip = out_dir / f".{spec.label}_download_all.zip"
        try:
            log("  Downloading full ZIP archive...")
            _download_zip_with_retry(client, tmp_zip, retries=1)
            _unpack_zip_into_shared_dir(tmp_zip, spec, out_dir, res, log)
        except Exception as exc:
            res.status = "error"
            res.error = f"ZIP download failed: {exc}"
            log(f"  ERROR: {res.error}")
            res.duration_s = time.monotonic() - t0
            return res
        finally:
            tmp_zip.unlink(missing_ok=True)
    else:
        for entry in files:
            rname = str(entry.get("name", ""))
            rsize = int(entry.get("size", 0))
            if not remote_name_valid(rname):
                res.warnings.append(f"skipped unsafe remote filename {rname!r}")
                continue
            lname = build_local_filename(spec.label, rname)
            dest_path = out_dir / lname

            if dest_path.exists() and dest_path.stat().st_size == rsize:
                existing_ver = verify_csv_file(dest_path, expected_size=rsize)
                if existing_ver.ok:
                    res.skipped_count += 1
                    res.files.append(
                        FileRecord(
                            remote_name=rname,
                            local_name=lname,
                            size=rsize,
                            action="skipped",
                            verify_status=existing_ver.status,
                            verify_detail=existing_ver.detail,
                        )
                    )
                    continue
                log(
                    f"    ~ {lname} failed local check ({existing_ver.detail}); "
                    "re-downloading fresh copy"
                )

            try:
                got = _download_one_with_retry(client, rname, dest_path, rsize, retries=1)
            except Exception as exc:
                res.failed_count += 1
                res.warnings.append(f"{rname}: download failed ({exc})")
                log(f"    ! {lname} — FAILED ({exc})")
                res.files.append(
                    FileRecord(
                        remote_name=rname,
                        local_name=lname,
                        size=rsize,
                        action="failed",
                        verify_detail=str(exc),
                    )
                )
                continue

            ver = verify_csv_file(dest_path, expected_size=rsize)
            res.new_count += 1
            res.bytes_downloaded += got
            for w in ver.warnings:
                res.warnings.append(f"{lname}: {w}")
            if not ver.ok:
                res.failed_count += 1
                res.warnings.append(f"{lname}: {ver.status} ({ver.detail})")
                log(f"    ! {lname} ({format_size(got)}) — WARNING: {ver.detail}")
            else:
                log(f"    + {lname} ({format_size(got)})")

            res.files.append(
                FileRecord(
                    remote_name=rname,
                    local_name=lname,
                    size=rsize,
                    action="downloaded",
                    verify_status=ver.status,
                    verify_detail=ver.detail,
                )
            )

    if delete_after_download:
        for rec in res.files:
            # Only delete files confirmed present and valid on disk.
            if rec.action not in ("downloaded", "skipped"):
                continue
            if rec.verify_status not in ("checksum_ok", "no_checksum_header"):
                continue
            try:
                if client.delete_file(rec.remote_name):
                    rec.deleted_from_device = True
                    res.deleted_count += 1
                else:
                    res.warnings.append(f"could not delete {rec.remote_name} on device")
            except Exception as exc:
                res.warnings.append(f"delete failed for {rec.remote_name}: {exc}")
        if res.deleted_count:
            log(f"  Deleted {res.deleted_count} verified file(s) from {spec.ssid}")

    if res.failed_count > 0:
        if res.new_count == 0 and res.skipped_count == 0:
            res.status = "error"
        else:
            res.status = "partial"
    res.duration_s = time.monotonic() - t0
    return res


def merge_device_result(prev: Optional[DeviceResult], curr: DeviceResult) -> DeviceResult:
    """Combine results across multiple --watch passes without losing earlier downloads."""
    if prev is None or prev.status == "offline":
        return curr
    if curr.status == "offline":
        return prev

    merged_files_by_name: dict[str, FileRecord] = {f.remote_name: f for f in prev.files}
    for rec in curr.files:
        old = merged_files_by_name.get(rec.remote_name)
        if old is not None and old.action == "downloaded" and rec.action == "skipped":
            # Keep the earlier download record, preserving any new deletion state.
            merged_files_by_name[rec.remote_name] = FileRecord(
                remote_name=old.remote_name,
                local_name=old.local_name,
                size=old.size,
                action=old.action,
                verify_status=old.verify_status,
                verify_detail=old.verify_detail,
                deleted_from_device=old.deleted_from_device or rec.deleted_from_device,
            )
        else:
            merged_files_by_name[rec.remote_name] = rec

    merged_warnings: list[str] = list(prev.warnings)
    for w in curr.warnings:
        if w not in merged_warnings:
            merged_warnings.append(w)

    new_count = prev.new_count + curr.new_count
    deleted_count = prev.deleted_count + curr.deleted_count
    bytes_downloaded = prev.bytes_downloaded + curr.bytes_downloaded
    failed_count = curr.failed_count
    skipped_count = curr.skipped_count
    error = curr.error

    if curr.status == "error":
        status = "partial" if new_count > 0 else "error"
    elif failed_count > 0:
        status = "partial"
    elif curr.status == "dry_run":
        status = "dry_run"
    else:
        status = "ok"

    return DeviceResult(
        spec=curr.spec,
        status=status,
        new_count=new_count,
        skipped_count=skipped_count,
        failed_count=failed_count,
        deleted_count=deleted_count,
        bytes_downloaded=bytes_downloaded,
        duration_s=prev.duration_s + curr.duration_s,
        error=error,
        warnings=merged_warnings,
        files=list(merged_files_by_name.values()),
    )


# ── Reporting & log persistence ───────────────────────────────────────────


def format_summary_table(results: list[DeviceResult]) -> str:
    headers = ("Device", "Label", "Status", "New", "Skipped", "Size", "Notes")
    rows: list[tuple[str, ...]] = []
    for r in results:
        if r.status == "offline":
            notes = "offline / not in range"
        elif r.error:
            notes = r.error
        elif r.warnings:
            notes = "; ".join(r.warnings[:2])
            if len(r.warnings) > 2:
                notes += f" (+{len(r.warnings) - 2} more)"
        elif r.status == "partial" or r.failed_count > 0:
            notes = f"{r.failed_count} file(s) failed"
        elif r.status == "dry_run":
            notes = "dry run"
        elif r.new_count == 0 and r.skipped_count == 0:
            notes = "no files"
        else:
            note_parts = ["checksums OK"]
            if r.deleted_count:
                note_parts.append(f"{r.deleted_count} deleted")
            notes = ", ".join(note_parts)

        rows.append(
            (
                r.spec.ssid,
                r.spec.label,
                r.status.upper(),
                str(r.new_count) if r.status != "offline" else "-",
                str(r.skipped_count) if r.status != "offline" else "-",
                format_size(r.bytes_downloaded) if r.bytes_downloaded else "-",
                notes,
            )
        )

    widths = [
        max(len(h), *(len(row[i]) for row in rows)) if rows else len(h)
        for i, h in enumerate(headers)
    ]
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    lines = [
        fmt.format(*headers),
        "  ".join("-" * w for w in widths),
    ]
    lines.extend(fmt.format(*row) for row in rows)
    return "\n".join(lines)


def write_collection_log(
    out_dir: Path,
    results: list[DeviceResult],
    *,
    session_id: Optional[str] = None,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / "collection_log.json"
    existing_runs: list[dict] = []
    if log_path.exists():
        try:
            prev = json.loads(log_path.read_text(encoding="utf-8"))
            if isinstance(prev, dict) and isinstance(prev.get("runs"), list):
                existing_runs = prev["runs"]
        except (OSError, json.JSONDecodeError):
            pass

    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    run_id = session_id or now_iso
    run_entry = {
        "session_id": run_id,
        "timestamp": now_iso,
        "devices": [
            {
                "ssid": r.spec.ssid,
                "label": r.spec.label,
                "status": r.status,
                "new_count": r.new_count,
                "skipped_count": r.skipped_count,
                "failed_count": r.failed_count,
                "deleted_count": r.deleted_count,
                "bytes_downloaded": r.bytes_downloaded,
                "duration_s": round(r.duration_s, 2),
                "error": r.error,
                "warnings": r.warnings,
                "files": [
                    {
                        "remote_name": f.remote_name,
                        "local_name": f.local_name,
                        "size": f.size,
                        "action": f.action,
                        "verify_status": f.verify_status,
                        "verify_detail": f.verify_detail,
                        "deleted_from_device": f.deleted_from_device,
                    }
                    for f in r.files
                ],
            }
            for r in results
        ],
    }

    replaced = False
    if session_id is not None:
        for idx in range(len(existing_runs) - 1, -1, -1):
            if existing_runs[idx].get("session_id") == session_id:
                existing_runs[idx] = run_entry
                replaced = True
                break
    if not replaced:
        existing_runs.append(run_entry)

    payload = {"runs": existing_runs}
    tmp = log_path.with_name(log_path.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, log_path)
    return log_path


# ── CLI ───────────────────────────────────────────────────────────────────


def _default_output_dir() -> Path:
    today = dt.date.today().isoformat()
    return Path("tracks") / f"workshop_{today}"


def _find_default_devices_file() -> Optional[Path]:
    candidates = [
        Path("workshop_devices.txt"),
        Path(__file__).resolve().parent / "workshop_devices.txt",
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Automatically hop through a list of BioMapping Cardputer Wi-Fi networks "
            "and download every recording into one shared workshop folder."
        )
    )
    p.add_argument(
        "-f",
        "--devices-file",
        type=Path,
        help="Text file listing Cardputer Wi-Fi names (one per line, optional friendly label).",
    )
    p.add_argument(
        "-d",
        "--devices",
        nargs="+",
        metavar="SSID[=LABEL]",
        help="Cardputer Wi-Fi names on the command line (e.g. BioMapping-3E5C BioMapping-A1B2=Kit-02).",
    )
    p.add_argument(
        "--from-known",
        action="store_true",
        help="Include every BioMapping-* Wi-Fi network already remembered by this computer.",
    )
    p.add_argument(
        "-o",
        "--out",
        type=Path,
        default=_default_output_dir(),
        help="Shared workshop folder for downloaded CSVs (default: tracks/workshop_YYYY-MM-DD).",
    )
    p.add_argument(
        "--watch",
        action="store_true",
        help=(
            "Run continuously, watching for any Cardputer in the list to appear and "
            "downloading new tracks automatically (Ctrl-C to stop)."
        ),
    )
    p.add_argument(
        "--interval",
        type=float,
        default=DEFAULT_WATCH_INTERVAL,
        help=f"Seconds to pause between --watch sweeps (default: {DEFAULT_WATCH_INTERVAL:.0f}).",
    )
    p.add_argument(
        "--cooldown",
        type=float,
        default=DEFAULT_WATCH_COOLDOWN,
        help=(
            "In --watch mode, seconds to wait before re-checking a device that was just "
            f"collected cleanly (default: {DEFAULT_WATCH_COOLDOWN:.0f})."
        ),
    )
    p.add_argument(
        "--once-per-device",
        action="store_true",
        help="In --watch mode, stop automatically once every device in the list has been collected once.",
    )
    p.add_argument(
        "--no-bell",
        action="store_true",
        help="Disable the terminal chime when new files finish downloading in --watch mode.",
    )
    p.add_argument(
        "--delete-after-download",
        action="store_true",
        help="Delete verified files from each Cardputer after downloading them (off by default).",
    )
    p.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Skip the confirmation prompt for --delete-after-download.",
    )
    p.add_argument(
        "--restore-wifi",
        metavar="SSID",
        help="Wi-Fi network name to reconnect to after collecting.",
    )
    p.add_argument(
        "--no-restore",
        action="store_true",
        help="Do not clean up temporary Wi-Fi entries or reconnect when finished.",
    )
    p.add_argument(
        "--connect-timeout",
        type=float,
        default=DEFAULT_CONNECT_TIMEOUT,
        help=f"Seconds to wait for 192.168.4.1 after joining Wi-Fi (default: {DEFAULT_CONNECT_TIMEOUT:.0f}).",
    )
    p.add_argument(
        "--interface",
        help="Override the Wi-Fi interface name on macOS (default: auto-detected, e.g. en0).",
    )
    p.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"Cardputer base URL (default: {DEFAULT_HOST}).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Connect and list what would be downloaded without writing or deleting files.",
    )
    return p


def resolve_device_list(args: argparse.Namespace, wifi: WifiBackend) -> list[DeviceSpec]:
    specs: list[DeviceSpec] = []

    devices_file = args.devices_file
    if not devices_file and not args.devices and not args.from_known:
        devices_file = _find_default_devices_file()

    if devices_file:
        if not devices_file.is_file():
            raise FileNotFoundError(f"Devices file not found: {devices_file}")
        specs.extend(load_devices_file(devices_file))

    if args.devices:
        for raw in args.devices:
            spec = parse_device_entry(raw)
            if spec is not None:
                specs.append(spec)

    if args.from_known:
        for ssid in wifi.list_preferred_networks():
            if ssid.startswith("BioMapping-"):
                specs.append(DeviceSpec(ssid=ssid, label=sanitize_label(ssid, ssid)))

    return validate_device_specs(specs)


def select_watch_candidates(
    specs: list[DeviceSpec],
    last_collected_at: dict[str, float],
    now: float,
    *,
    cooldown_s: float,
    once_per_device: bool,
) -> list[DeviceSpec]:
    """Choose which devices to probe on the current --watch sweep."""
    due: list[DeviceSpec] = []
    for spec in specs:
        done_at = last_collected_at.get(spec.ssid)
        if done_at is None:
            due.append(spec)
        elif not once_per_device and (now - done_at) >= cooldown_s:
            due.append(spec)
    return due


def main(
    argv: Optional[list[str]] = None,
    *,
    wifi_backend: Optional[WifiBackend] = None,
    sleep_fn: Callable[[float], None] = time.sleep,
    monotonic_fn: Callable[[], float] = time.monotonic,
    max_passes: Optional[int] = None,
) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.connect_timeout <= 0:
        print("Error: --connect-timeout must be greater than 0.", file=sys.stderr)
        return 2
    if args.interval < 0 or args.cooldown < 0:
        print("Error: --interval and --cooldown must be 0 or greater.", file=sys.stderr)
        return 2

    try:
        wifi = wifi_backend if wifi_backend is not None else make_wifi_backend(interface=args.interface)
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    try:
        specs = resolve_device_list(args, wifi)
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    if not specs:
        example = Path(__file__).resolve().parent / "workshop_devices.example.txt"
        print(
            "No Cardputer Wi-Fi networks specified.\n"
            f"Pass --devices-file workshop_devices.txt (see {example.name}), "
            "--devices BioMapping-XXXX, or --from-known.",
            file=sys.stderr,
        )
        return 2

    if args.delete_after_download and not args.dry_run and not args.yes:
        reply = input(
            "WARNING: --delete-after-download will delete verified files from each Cardputer.\n"
            "Continue? [y/N]: "
        ).strip().lower()
        if reply not in ("y", "yes"):
            print("Cancelled.")
            return 0

    stop_requested = False

    def _on_sigint(_signum: int, _frame: object) -> None:
        nonlocal stop_requested
        if stop_requested:
            raise KeyboardInterrupt
        stop_requested = True
        print("\nStopping after current step (press Ctrl-C again to force quit)...", flush=True)

    prev_handler = signal.signal(signal.SIGINT, _on_sigint)

    initial_preferred = set(wifi.list_preferred_networks())
    removed_preferred: set[str] = set()
    touched_ssids: list[str] = []
    connected_to_cardputer = False
    client = CardputerClient(base_url=args.host)
    session_results: dict[str, DeviceResult] = {}
    last_collected_at: dict[str, float] = {}
    session_id = dt.datetime.now(dt.timezone.utc).isoformat()
    log_saved_this_session = False

    def _release_cardputer_wifi(announce: bool = True) -> None:
        nonlocal connected_to_cardputer
        if args.no_restore:
            return
        to_remove = [
            s
            for s in touched_ssids
            if s not in initial_preferred and s not in removed_preferred
        ]
        if not connected_to_cardputer and not to_remove:
            return
        if announce:
            print("\nRestoring laptop Wi-Fi...", flush=True)
        wifi.restore(
            args.restore_wifi,
            to_remove,
            should_disconnect=connected_to_cardputer,
        )
        removed_preferred.update(to_remove)
        connected_to_cardputer = False

    print(f"Workshop folder: {args.out}")
    print(f"Devices ({len(specs)}): {', '.join(s.ssid for s in specs)}")
    if args.watch:
        mode_desc = (
            "until all devices are collected"
            if args.once_per_device
            else f"continuously (re-checks collected devices after {args.cooldown:.0f}s)"
        )
        print(f"Watch mode: running {mode_desc}. Press Ctrl-C to stop.", flush=True)

    try:
        pass_num = 0
        while not stop_requested:
            if max_passes is not None and pass_num >= max_passes:
                break
            pass_num += 1
            now = monotonic_fn()
            if args.watch:
                pending = select_watch_candidates(
                    specs,
                    last_collected_at,
                    now,
                    cooldown_s=args.cooldown,
                    once_per_device=args.once_per_device,
                )
                if args.once_per_device and not pending:
                    print("\nAll devices in the list have been collected!", flush=True)
                    break
            else:
                pending = list(specs)

            found_any_this_pass = False
            if pending:
                wifi.prepare_sweep()
            if args.watch and pending:
                stamp = dt.datetime.now().strftime("%H:%M:%S")
                print(
                    f"[{stamp}] Watching {len(pending)}/{len(specs)} device(s)...",
                    flush=True,
                )

            for spec in pending:
                if stop_requested:
                    break
                res = collect_device(
                    spec=spec,
                    out_dir=args.out,
                    wifi=wifi,
                    client=client,
                    connect_timeout=args.connect_timeout,
                    delete_after_download=args.delete_after_download,
                    dry_run=args.dry_run,
                    quiet_offline=args.watch,
                    sleep_fn=sleep_fn,
                )
                session_results[spec.ssid] = merge_device_result(
                    session_results.get(spec.ssid), res
                )

                if res.status != "offline":
                    found_any_this_pass = True
                    connected_to_cardputer = True
                    if spec.ssid not in touched_ssids:
                        touched_ssids.append(spec.ssid)
                    if res.status in ("ok", "dry_run") and res.failed_count == 0:
                        last_collected_at[spec.ssid] = monotonic_fn()
                    if args.watch:
                        if res.new_count > 0 and not args.no_bell:
                            print("\a", end="", flush=True)
                        if not args.dry_run:
                            ordered_now = [
                                session_results[s.ssid]
                                for s in specs
                                if s.ssid in session_results
                            ]
                            write_collection_log(args.out, ordered_now, session_id=session_id)
                            log_saved_this_session = True

            if not args.watch or stop_requested:
                break

            # In watch mode, release the last Cardputer hotspot after each active
            # sweep so its screen drops back to idle (visual "done" cue) and the
            # laptop isn't parked off its normal Wi-Fi between participants.
            if found_any_this_pass:
                _release_cardputer_wifi(announce=False)

            if args.once_per_device and len(last_collected_at) == len(specs):
                print("\nAll devices in the list have been collected!", flush=True)
                break

            if max_passes is not None and pass_num >= max_passes:
                break

            wait_s = args.interval if (pending or found_any_this_pass) else min(args.interval, 5.0)
            waited = 0.0
            while waited < wait_s and not stop_requested:
                step = min(0.5, wait_s - waited)
                sleep_fn(step)
                waited += step
    finally:
        signal.signal(signal.SIGINT, prev_handler)
        _release_cardputer_wifi(announce=True)

    ordered = [session_results[s.ssid] for s in specs if s.ssid in session_results]
    print("\n" + format_summary_table(ordered))

    if ordered and not args.dry_run:
        log_path = write_collection_log(args.out, ordered, session_id=session_id)
        if not log_saved_this_session:
            print(f"\nSaved log: {log_path}")
        else:
            print(f"\nUpdated log: {log_path}")

    had_error = any(r.status in ("error", "partial") or r.failed_count > 0 for r in ordered)
    return 1 if had_error else 0


if __name__ == "__main__":
    raise SystemExit(main())

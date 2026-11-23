"""The exact build of the firmware being compiled, for the "# Firmware" line
at the top of every recording (docs/csv_schema.md).

Used by both device builds: application.fam (Flipper, ufbt) and
cardputer/build_info.py (Cardputer, PlatformIO). Each passes the folders
its build compiles, so an uncommitted edit elsewhere in the repository
(the visualiser, say) doesn't mark the firmware as changed.
"""

import os
import subprocess

FIRMWARE_DIR = os.path.dirname(os.path.abspath(__file__))


def _git(*args):
    return subprocess.run(
        ["git", *args],
        cwd=FIRMWARE_DIR,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def git_rev(paths):
    """The short commit code, e.g. "396a8f1".

    "+changes" is added ("396a8f1+changes") when any of `paths` (relative
    to firmware/) has edits or new files not yet committed, because then
    the commit alone doesn't say what was built. "unknown" when there is
    no git, e.g. a build from a downloaded zip.
    """
    try:
        rev = _git("rev-parse", "--short=7", "HEAD")
        changed = _git("status", "--porcelain", "--", *paths)
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return rev + "+changes" if changed else rev

#!/usr/bin/env python3
"""Tests for firmware/build_rev.py: the build code in every recording's
"# Firmware" line. Each test runs git in a throwaway repository."""

import os
import subprocess
import sys
import tempfile
import unittest

FIRMWARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, FIRMWARE_DIR)

import build_rev  # noqa: E402


def git(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


def write(repo, path, text):
    full = os.path.join(repo, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(text)


class GitRevTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = self._tmp.name
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "test@example.com")
        git(self.repo, "config", "user.name", "Test")
        write(self.repo, "core/a.c", "int a;\n")
        write(self.repo, "visualiser/b.mjs", "export {};\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "first")
        self._real_dir = build_rev.FIRMWARE_DIR
        build_rev.FIRMWARE_DIR = self.repo

    def tearDown(self):
        build_rev.FIRMWARE_DIR = self._real_dir
        self._tmp.cleanup()

    def test_clean_build_is_the_short_commit(self):
        want = git(self.repo, "rev-parse", "--short=7", "HEAD")
        self.assertEqual(build_rev.git_rev(["core"]), want)
        self.assertEqual(len(want), 7)

    def test_uncommitted_edit_adds_changes(self):
        write(self.repo, "core/a.c", "int a, b;\n")
        self.assertTrue(build_rev.git_rev(["core"]).endswith("+changes"))

    def test_new_file_adds_changes(self):
        write(self.repo, "core/new.c", "int n;\n")
        self.assertTrue(build_rev.git_rev(["core"]).endswith("+changes"))

    def test_edit_outside_the_firmware_paths_is_ignored(self):
        write(self.repo, "visualiser/b.mjs", "export const x = 1;\n")
        self.assertNotIn("+", build_rev.git_rev(["core"]))

    def test_no_git_is_unknown(self):
        with tempfile.TemporaryDirectory() as plain:
            build_rev.FIRMWARE_DIR = plain
            self.assertEqual(build_rev.git_rev(["core"]), "unknown")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Tests for nvr data-dir paths and one-time cache migration."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import nvr_paths  # noqa: E402


class DataDirTests(unittest.TestCase):
    def test_linux_default(self) -> None:
        path = nvr_paths.data_dir(environ={}, home="/home/gary", platform="linux")
        self.assertEqual(path, Path("/home/gary/.local/share/nvr"))

    def test_linux_xdg(self) -> None:
        path = nvr_paths.data_dir(
            environ={"XDG_DATA_HOME": "/home/gary/.data"},
            home="/home/gary",
            platform="linux",
        )
        self.assertEqual(path, Path("/home/gary/.data/nvr"))

    def test_mac_default(self) -> None:
        path = nvr_paths.data_dir(environ={}, home="/Users/gary", platform="darwin")
        self.assertEqual(path, Path("/Users/gary/Library/Application Support/nvr"))

    def test_windows_localappdata(self) -> None:
        path = nvr_paths.data_dir(
            environ={"LOCALAPPDATA": r"C:\Users\gary\AppData\Local"},
            home=r"C:\Users\gary",
            platform="win32",
        )
        self.assertEqual(path, Path(r"C:\Users\gary\AppData\Local") / "nvr")

    def test_nvr_data_home_override(self) -> None:
        path = nvr_paths.data_dir(
            environ={"NVR_DATA_HOME": "/tmp/custom-nvr"},
            home="/home/gary",
            platform="linux",
        )
        self.assertEqual(path, Path("/tmp/custom-nvr"))

    def test_sherpa_and_hf_live_under_data_dir(self) -> None:
        env: dict[str, str] = {}
        home = "/home/gary"
        data = nvr_paths.data_dir(env, home, "linux")
        self.assertEqual(nvr_paths.sherpa_cache(env, home, "linux"), data / "sherpa")
        self.assertEqual(nvr_paths.hf_home(env, home, "linux"), data / "huggingface")
        self.assertEqual(nvr_paths.hf_hub_dir(env, home, "linux"), data / "huggingface" / "hub")
        self.assertEqual(nvr_paths.state_path(env, home, "linux"), data / "voice-packs.json")
        self.assertEqual(nvr_paths.bootstrap_status_path(env, home, "linux"), data / "status.json")


class MigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        nvr_paths.reset_migration_flag()
        self.tmp = tempfile.TemporaryDirectory(prefix="nvr-paths-")
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self.env = {"HOME": str(self.home), "NVR_ROOT": str(SCRIPT_DIR.parent)}

    def tearDown(self) -> None:
        nvr_paths.reset_migration_flag()
        self.tmp.cleanup()

    def test_moves_legacy_nvr_cache_and_pack_hf_repos(self) -> None:
        cache = self.home / ".cache" / "nvr"
        (cache / "sherpa" / "kokoro-int8-multi-lang-v1_0").mkdir(parents=True)
        (cache / "sherpa" / "kokoro-int8-multi-lang-v1_0" / "model.int8.onnx").write_text("weights")
        (cache / "voice-packs.json").write_text('{"version":1,"installed":{"kokoro":{"installedAt":"2026-01-01T00:00:00Z"}}}')
        kitten = self.home / ".cache" / "huggingface" / "hub" / "models--KittenML--kitten-tts-mini-0.8"
        kitten.mkdir(parents=True)
        (kitten / "refs").mkdir()
        (kitten / "snapshot.bin").write_text("kitten")
        other = self.home / ".cache" / "huggingface" / "hub" / "models--SomeoneElse--unrelated"
        other.mkdir(parents=True)
        (other / "keep.bin").write_text("keep")

        notes = nvr_paths.migrate_legacy_data(self.env, self.home, "linux", force=True)
        dest = nvr_paths.data_dir(self.env, self.home, "linux")
        self.assertTrue((dest / "sherpa" / "kokoro-int8-multi-lang-v1_0" / "model.int8.onnx").is_file())
        self.assertTrue((dest / "voice-packs.json").is_file())
        self.assertFalse(cache.exists(), f"legacy cache should be gone, notes={notes}")
        new_kitten = dest / "huggingface" / "hub" / "models--KittenML--kitten-tts-mini-0.8" / "snapshot.bin"
        self.assertTrue(new_kitten.is_file())
        self.assertFalse(kitten.exists())
        self.assertTrue((other / "keep.bin").is_file(), "unrelated HF repos must stay in the shared cache")
        self.assertFalse((dest / "huggingface" / "hub" / "models--SomeoneElse--unrelated").exists())

    def test_is_idempotent_and_does_not_copy(self) -> None:
        cache = self.home / ".cache" / "nvr"
        cache.mkdir(parents=True)
        (cache / "voice-packs.json").write_text('{"version":1,"installed":{}}')
        nvr_paths.migrate_legacy_data(self.env, self.home, "linux", force=True)
        dest = nvr_paths.data_dir(self.env, self.home, "linux")
        self.assertFalse(cache.exists())
        nvr_paths.reset_migration_flag()
        notes = nvr_paths.migrate_legacy_data(self.env, self.home, "linux", force=True)
        self.assertEqual(notes, [])
        self.assertTrue((dest / "voice-packs.json").is_file())

    def test_merge_does_not_overwrite_existing_dest(self) -> None:
        cache = self.home / ".cache" / "nvr"
        cache.mkdir(parents=True)
        (cache / "voice-packs.json").write_text("old")
        (cache / "only-old.txt").write_text("from-old")
        dest = nvr_paths.data_dir(self.env, self.home, "linux")
        dest.mkdir(parents=True)
        (dest / "voice-packs.json").write_text("new")
        notes = nvr_paths.migrate_legacy_data(self.env, self.home, "linux", force=True)
        self.assertEqual((dest / "voice-packs.json").read_text(), "new")
        self.assertTrue((dest / "only-old.txt").is_file())
        self.assertTrue(any("already exists" in line for line in notes))
        self.assertTrue((cache / "voice-packs.json").is_file(), "conflicting file is left in the old location")



    def test_repairs_missing_refs_main(self) -> None:
        dest = nvr_paths.data_dir(self.env, self.home, "linux")
        snap = dest / "huggingface" / "hub" / "models--k2-fsa--OmniVoice" / "snapshots" / "abc123"
        snap.mkdir(parents=True)
        (snap / "config.json").write_text("{}")
        notes: list[str] = []
        nvr_paths.repair_hf_repo_refs(dest / "huggingface" / "hub", notes)
        refs = dest / "huggingface" / "hub" / "models--k2-fsa--OmniVoice" / "refs" / "main"
        self.assertEqual(refs.read_text().strip(), "abc123")
        self.assertTrue(any("refs" in line for line in notes))


if __name__ == "__main__":
    unittest.main()

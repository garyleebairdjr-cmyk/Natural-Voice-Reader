#!/usr/bin/env python3
"""Unit tests for the nvr say CLI helpers. These do not start VoiceStudio."""

from __future__ import annotations

import importlib.util
import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

_MODULE = Path(__file__).resolve().parent / "nvr-say.py"
_SPEC = importlib.util.spec_from_file_location("nvr_say", _MODULE)
nvr_say = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(nvr_say)


class RouteTests(unittest.TestCase):
    def test_default_voice_is_leo_on_kittentts(self):
        route = nvr_say.resolve_route("leo", "kittentts")
        self.assertEqual(route["provider"], "voicestudio")
        self.assertEqual(route["model"], "kittentts")
        self.assertEqual(route["voice"], "expr-voice-2-m")
        self.assertEqual(route["voice_id"], "leo")
        self.assertFalse(route["slow"])

    def test_specialty_voices_use_kokoro(self):
        self.assertEqual(nvr_say.resolve_route("butler", "kittentts")["voice"], "bm_george")
        self.assertEqual(nvr_say.resolve_route("mira", "omnivoice")["provider"], "kokoro")
        self.assertEqual(nvr_say.resolve_route("arjun", "kittentts")["voice"], "hm_omega")

    def test_omnivoice_is_marked_slow(self):
        route = nvr_say.resolve_route("eve", "omnivoice")
        self.assertEqual(route["provider"], "voicestudio")
        self.assertEqual(route["model"], "omnivoice")
        self.assertEqual(route["voice"], "default")
        self.assertTrue(route["slow"])

    def test_forbidden_model_falls_back_to_kittentts(self):
        self.assertEqual(nvr_say.requested_model("voxcpm2"), "kittentts")
        self.assertEqual(nvr_say.requested_model("tts-1"), "kittentts")
        self.assertEqual(nvr_say.resolve_route("leo", "voxcpm2")["model"], "kittentts")

    def test_removed_or_unknown_voice_falls_back_to_leo(self):
        self.assertEqual(nvr_say.canonical_voice_id("aiko"), "leo")
        self.assertEqual(nvr_say.canonical_voice_id("not-a-voice"), "leo")
        self.assertEqual(nvr_say.canonical_voice_id(""), "leo")

    def test_speed_is_clamped(self):
        self.assertEqual(nvr_say.clamp_speed(1), 1.0)
        self.assertEqual(nvr_say.clamp_speed(0.2), 0.7)
        self.assertEqual(nvr_say.clamp_speed(3), 1.5)
        self.assertEqual(nvr_say.clamp_speed("nope"), 1.0)


class ParseTests(unittest.TestCase):
    def test_text_flag_and_positional_text(self):
        args = nvr_say.parse_args(["--text", "Hello Gary.", "--out", "out.mp3"])
        self.assertEqual(nvr_say.resolve_text(args), "Hello Gary.")
        args = nvr_say.parse_args(["--out", "out.mp3", "Hello", "Gary."])
        self.assertEqual(nvr_say.resolve_text(args), "Hello Gary.")

    def test_rejects_both_text_forms(self):
        args = nvr_say.parse_args(["--text", "A", "--out", "out.mp3", "B"])
        with self.assertRaises(ValueError):
            nvr_say.resolve_text(args)

    def test_normalizes_whitespace(self):
        self.assertEqual(nvr_say.normalize_text("  Hello\n  Gary  "), "Hello Gary")

    def test_list_voices_exits_zero(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = nvr_say.main(["--list-voices"])
        self.assertEqual(code, 0)
        self.assertIn("leo", stdout.getvalue())
        self.assertIn("butler", stdout.getvalue())

    def test_missing_output_is_an_error(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            code = nvr_say.main(["--text", "Hello"])
        self.assertEqual(code, 2)
        self.assertIn("--out", stderr.getvalue())

    def test_route_only_prints_json(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = nvr_say.main(["--route-only", "--voice", "butler"])
        self.assertEqual(code, 0)
        self.assertIn("kokoro", stdout.getvalue())
        self.assertIn("bm_george", stdout.getvalue())


class OutputTests(unittest.TestCase):
    def test_wants_mp3_for_stdout_and_mp3_paths(self):
        self.assertTrue(nvr_say.wants_mp3("-"))
        self.assertTrue(nvr_say.wants_mp3("clip.mp3"))
        self.assertFalse(nvr_say.wants_mp3("clip.wav"))

    def test_write_output_creates_parent_and_replaces(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "nested" / "out.mp3"
            nvr_say.write_output(str(dest), b"hello-audio")
            self.assertEqual(dest.read_bytes(), b"hello-audio")


if __name__ == "__main__":
    unittest.main()

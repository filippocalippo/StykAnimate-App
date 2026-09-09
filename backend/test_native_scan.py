"""Differential tests for the optional C ABI; Python remains the oracle."""
from __future__ import annotations

import ctypes
import os
import random
import struct
import unittest
from unittest import mock

import server
import fast_decode
import native_scan
from test_fast_decode import frame_bytes


FIGURES = [{"figure_type_id": tid, "segment_count": 1, "segments": [{"segment_id": 1}],
    "image_assets": [], "text_assets": []} for tid in (1, 2)]
BUDGET = fast_decode.NATIVE_POSE_BUDGET


class NativeScanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        status = native_scan.status()
        if not status["available"]:
            if os.environ.get("STYK_REQUIRE_NATIVE_SCAN") == "1":
                raise AssertionError(f"Native scanner required: {status}")
            raise unittest.SkipTest(f"Build scripts/build-frame-scan.py to test C++: {status}")

    def compare(self, source, *, prefix=b"", budget=BUDGET):
        outcomes = []
        for decoder in (fast_decode.scan_keyframes_python, native_scan.scan_keyframes):
            reader = server.FastReader(prefix + source)
            reader.pos = len(prefix)
            try:
                result = decoder(reader, FIGURES, 2, max_pose_bytes=budget)
            except server.piv_codec.PivError:
                outcomes.append((False,))
            else:
                self.assertIsNotNone(result, "Native test must never silently use fallback")
                outcomes.append((True, result, reader.pos))
        self.assertEqual(*outcomes)
        return outcomes[0][0]

    def test_deterministic_byte_mutations_and_truncations_match_python(self):
        frames = [frame_bytes([{"uid": 0xFFFFFFFF, "length": 3, "bend": .2},
            {"uid": 0, "join": (0, 1)}, {"uid": 2, "scale": -1.5}], duration=3,
            camera=(1.e-45, -0., 1.e-300, 1.)),
            frame_bytes([{"uid": 0xFFFFFFFF}, {"uid": 2, "join": (0, 0)}], duration=0),
            frame_bytes([{"uid": 2, "tid": 2, "length": 8}], duration=1)]
        source = struct.pack("<I", len(frames)) + b"".join(frame[4:] for frame in frames)
        self.assertTrue(self.compare(source, prefix=b"unaligned-prefix!"))
        for end in range(len(source)):
            with self.subTest(truncated=end):
                self.compare(source[:end])
        randomizer = random.Random(947102)
        accepted = 0
        for iteration in range(1500):
            changed = bytearray(source)
            for _ in range(randomizer.randrange(1, 5)):
                offset = randomizer.randrange(len(changed))
                changed[offset] ^= 1 << randomizer.randrange(8)
            with self.subTest(mutation=iteration):
                accepted += self.compare(bytes(changed))
        self.assertGreater(accepted, 0)

    def test_signed_uid_extremes_and_hidden_incoming_type_continuity(self):
        uids = [0x80000000, 0xFFFFFFFF, 0, 0x7FFFFFFF]
        for outgoing in (0, 1, 2, 65535):
            first = frame_bytes([{"uid": uid} for uid in uids], duration=outgoing)
            for incoming in (0, 1, 2):
                for change in (False, True):
                    second = frame_bytes([{"uid": uid, "tid": 2 if change else 1} for uid in uids], duration=incoming)
                    source = struct.pack("<I", 2) + first[4:] + second[4:]
                    self.assertEqual(self.compare(source), not(change and outgoing > 1))
        self.assertFalse(self.compare(frame_bytes([{"uid": 0}, {"uid": 0x80000000}])))

    def test_long_forward_join_chain_and_cycle(self):
        objects = [{"uid": uid, **({"join": (uid+1, 0)} if uid < 4999 else {})} for uid in range(5000)]
        self.assertTrue(self.compare(frame_bytes(objects)))
        objects[-1]["join"] = (0, 1)
        self.assertFalse(self.compare(frame_bytes(objects)))

    def test_native_budget_and_disabled_fallback(self):
        source = frame_bytes([{"uid": 1, "length": 5, "bend": .2}])
        exact = 512 + 512 + 3 * 24
        self.assertTrue(self.compare(source, budget=exact))
        self.assertFalse(self.compare(source, budget=exact-1))
        with mock.patch.dict(os.environ, {"STYK_DISABLE_NATIVE_SCAN": "1"}):
            self.assertFalse(native_scan.status()["available"])
            self.assertIsNone(native_scan.scan_keyframes(server.FastReader(source), FIGURES, 2, max_pose_bytes=BUDGET))
            self.assertEqual(fast_decode.scan_keyframes(server.FastReader(source), FIGURES, 2),
                fast_decode.scan_keyframes_python(server.FastReader(source), FIGURES, 2))

    def test_c_abi_rejects_metadata_and_output_capacity_without_publication(self):
        library = native_scan._load()
        source, metadata = frame_bytes(), native_scan._metadata(FIGURES)
        output = (ctypes.c_uint16 * 1)(0xABCD)
        for blob, capacity, expected in [(metadata[:-1], 1, 13),
                (struct.pack("<I", 0xFFFFFFFF), 1, 13), (metadata, 0, 14)]:
            result = native_scan.ScanResult()
            error = library.styk_piv_scan(source, len(source), 0, blob, len(blob), 2,
                BUDGET, output, capacity, ctypes.byref(result))
            self.assertEqual(error, expected)
            self.assertEqual(output[0], 0xABCD)
            self.assertLessEqual(result.end_offset, len(source))


if __name__ == "__main__":
    unittest.main()

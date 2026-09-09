"""Differential checks against the established binary grammar, not a new schema."""
from __future__ import annotations

import importlib.util
import json
import math
import struct
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import server
import fast_decode


spec = importlib.util.spec_from_file_location("canonical_piv_for_test", server.TOOLS / "piv_codec.py")
canonical = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canonical)
canonical.Reader = server.FastReader


def frame_bytes(objects=None, *, duration=1, bg=0, mix=0, bg_b=0, order=None,
                camera=None, media=False):
    if objects is None:
        objects = [{"uid": 1}]
    data = bytearray(struct.pack("<IHBH", 1, duration, mix, bg))
    if mix:
        data += struct.pack("<H", bg_b)
    data += struct.pack("<H", len(objects))
    for obj in objects:
        data += struct.pack("<IHfIB", obj.get("uid", 1), obj.get("tid", 1),
            obj.get("scale", 1), obj.get("color", 0x807F55FF), obj.get("alpha", 3))
        if media:
            data += struct.pack("<B", obj.get("media", 5))
        data += struct.pack("<dffH", obj.get("angle", -0.), obj.get("x", -0.), obj.get("y", 20),
            obj.get("lf", 1 if "length" in obj else 0))
        if obj.get("lf", 1 if "length" in obj else 0):
            data += struct.pack("<f", obj.get("length", 3))
        data += struct.pack("<H", obj.get("bf", 1 if "bend" in obj else 0))
        if obj.get("bf", 1 if "bend" in obj else 0):
            data += struct.pack("<d", obj.get("bend", .125))
        join = obj.get("join")
        data += struct.pack("<B", 1 if join else 0)
        if join:
            data += struct.pack("<HH", *join)
    order = list(range(len(objects))) if order is None else order
    data += struct.pack(f"<{len(objects)}H", *order)
    data += struct.pack("<B", 0 if camera else 1)
    if camera:
        data += struct.pack("<ffdf", *camera)
    return bytes(data)


class FastDecodeTests(unittest.TestCase):
    def compare_frames(self, data, *, media=False, invalid=False):
        figures = [{"figure_type_id": 1, "segment_count": 1, "segments": [{"segment_id": 1}],
            "image_assets": [{}] if media else [], "text_assets": []}]
        results = []
        for decoder in (canonical._keyframes, fast_decode.read_keyframes, fast_decode.scan_keyframes):
            reader = server.FastReader(data)
            if invalid:
                with self.assertRaises((server.piv_codec.PivError, canonical.PivError)):
                    decoder(reader, figures, 2)
            else:
                frames = decoder(reader, figures, 2)
                if decoder is fast_decode.scan_keyframes:
                    self.assertTrue(all(set(frame) == {"duration_raw", "objects"} and not frame["objects"]
                        for frame in frames))
                else:
                    results.append(server.encoded_json(frames, validated=True))
                self.assertEqual(reader.pos, len(data))
        if not invalid:
            self.assertEqual(*results)

    def test_valid_pose_variants_keep_every_field_and_float_bit(self):
        cases = [({}, {}), ({"x": 1.e-35, "angle": 1.e-300}, {}),
            ({"length": -0., "bend": 1.e-300, "lf": 65535, "bf": 37}, {}),
            ({"media": 255}, {"media": True}),
            ({"scale": -.25, "alpha": 255, "color": 0xFFFFFFFF},
                {"camera": (-0., 13., -1.5, .75), "duration": 0, "mix": 1, "bg_b": 1})]
        for obj, options in cases:
            with self.subTest(obj=obj):
                self.compare_frames(frame_bytes([{"uid": 1, **obj}], **options), media=options.get("media", False))
        self.compare_frames(frame_bytes([{"uid": 0xFFFFFFFF}, {"uid": 0, "join": (0, 1)},
            {"uid": 1, "join": (1, 0)}], order=[2, 0, 1]))
        self.compare_frames(frame_bytes([]))

    def test_every_truncation_is_rejected(self):
        source = frame_bytes([{"uid": 1, "length": 15, "bend": .1}],
            camera=(1., 2., .25, 1.5), mix=1, bg_b=1)
        for size in range(len(source)):
            with self.subTest(size=size):
                self.compare_frames(source[:size], invalid=True)

    def test_nonfinite_numbers_are_rejected_at_every_float_location(self):
        for value in (math.inf, -math.inf, math.nan):
            for key in ("scale", "angle", "x", "y", "length", "bend"):
                with self.subTest(value=value, key=key):
                    self.compare_frames(frame_bytes([{"uid": 1, key: value}]), invalid=True)
            for index in range(4):
                camera = [0., 0., 0., 1.]
                camera[index] = value
                self.compare_frames(frame_bytes(camera=camera), invalid=True)

    def test_semantic_bounds_and_joins_are_preserved(self):
        invalid = [struct.pack("<I", 1000001), frame_bytes(bg=2), frame_bytes(mix=1, bg_b=2),
            frame_bytes([{"uid": 1, "tid": 2}]), frame_bytes([{"uid": 1, "join": (1, 0)}]),
            frame_bytes([{"uid": 1}, {"uid": 2, "join": (0, 2)}]),
            frame_bytes([{"uid": 1, "join": (0, 0)}]),
            frame_bytes([{"uid": 1, "join": (1, 0)}, {"uid": 2, "join": (0, 0)}]),
            frame_bytes([{"uid": 1}, {"uid": 1}]), frame_bytes([{"uid": 1}, {"uid": 0}]),
            frame_bytes([{"uid": 0}, {"uid": 0xFFFFFFFF}]),
            frame_bytes([{"uid": 1}, {"uid": 2}], order=[0, 0]),
            frame_bytes([{"uid": 1}, {"uid": 2}], order=[0, 2])]
        for index, data in enumerate(invalid):
            with self.subTest(index=index):
                self.compare_frames(data, invalid=True)

    def test_full_corpus_matches_existing_decoder_exactly(self):
        manifest = json.loads((server.WORKSPACE / "docs/piv_corpus_manifest.json").read_text())
        original = canonical._keyframes
        try:
            for fixture in manifest["fixtures"]:
                path = server.WORKSPACE / fixture["path"]
                with self.subTest(path=path.name):
                    source = path.read_bytes()
                    canonical._keyframes = original
                    expected = canonical.decode_piv_bytes(source, source_path=path.name)
                    canonical._keyframes = fast_decode.read_keyframes
                    actual = canonical.decode_piv_bytes(source, source_path=path.name)
                    self.assertEqual(expected, actual)
                    self.assertEqual(server.encoded_json(expected, validated=True),
                        server.encoded_json(actual, validated=True))
        finally:
            canonical._keyframes = original

    def test_scan_corpus_preserves_all_nonframe_metadata_and_legacy_models(self):
        manifest = json.loads((server.WORKSPACE / "docs/piv_corpus_manifest.json").read_text())
        with mock.patch.object(server.piv_codec, "_keyframes", fast_decode.read_keyframes):
            for fixture in manifest["fixtures"]:
                path = server.WORKSPACE / fixture["path"]
                with self.subTest(path=path.name):
                    source = path.read_bytes()
                    expected = canonical.decode_piv_bytes(source, source_path=path.name)
                    scanned = fast_decode.decode_for_native_wire(source, source_path=path.name)
                    if expected["version"] != 5:
                        self.assertEqual(expected, scanned)
                    else:
                        self.assertEqual([frame["duration_raw"] for frame in expected["keyframes"]],
                            [frame["duration_raw"] for frame in scanned["keyframes"]])
                        self.assertEqual({key: value for key, value in expected.items() if key != "keyframes"},
                            {key: value for key, value in scanned.items() if key != "keyframes"})

    def test_scan_rejects_type_changes_on_interpolated_intervals_only(self):
        figures = [{"figure_type_id": tid, "segment_count": 1, "segments": [{"segment_id": 1}],
            "image_assets": [], "text_assets": []} for tid in (1, 2)]
        for duration in (0, 1, 2, 65535):
            source = struct.pack("<I", 2) + frame_bytes([{"uid": 1, "tid": 1}], duration=duration)[4:]
            source += frame_bytes([{"uid": 1, "tid": 2}])[4:]
            if duration > 1:
                with self.assertRaisesRegex(server.piv_codec.PivError, "Cannot interpolate a changed figure type"):
                    fast_decode.scan_keyframes(server.FastReader(source), figures, 2)
            else:
                self.assertEqual(len(fast_decode.scan_keyframes(server.FastReader(source), figures, 2)), 2)

    def test_scan_context_is_thread_local_and_restored_after_failure(self):
        path = server.WORKSPACE / "Pivot Animator v5/Animations/tween_camera.piv"
        source = path.read_bytes()
        with mock.patch.object(server.piv_codec, "_keyframes", fast_decode.read_keyframes):
            with ThreadPoolExecutor(max_workers=2) as pool:
                scan = pool.submit(fast_decode.decode_for_native_wire, source)
                full = pool.submit(server.piv_codec.decode_piv_bytes, source)
                self.assertFalse(any(frame["objects"] for frame in scan.result()["keyframes"]))
                self.assertTrue(any(frame["objects"] for frame in full.result()["keyframes"]))
            with self.assertRaises(server.piv_codec.PivError):
                fast_decode.decode_for_native_wire(source[:10])
            full = server.piv_codec.decode_piv_bytes(source)
            self.assertTrue(any(frame["objects"] for frame in full["keyframes"]))

    def test_scan_payload_is_exact_and_does_not_escape_context(self):
        path = server.WORKSPACE / "Pivot Animator v5/Animations/tween_camera.piv"
        source = path.read_bytes()
        with mock.patch.object(server.piv_codec, "_keyframes", fast_decode.read_keyframes):
            report, payload = fast_decode.decode_for_native_wire(source, with_payload=True)
            self.assertEqual(payload, server.piv_codec._unpack_source(source)[0])
            self.assertEqual(report["validation"]["payload_consumed"], len(payload))
            self.assertIsNone(getattr(fast_decode._context, "payload", None))
            with self.assertRaises(server.piv_codec.PivError):
                # A failure after frame scanning must also clear the capture.
                broken = bytearray(payload)
                struct.pack_into("<I", broken, report["validation"]["trailer_start"]-4, 0)
                fast_decode.decode_for_native_wire(bytes(broken), with_payload=True)
            self.assertIsNone(getattr(fast_decode._context, "payload", None))

    def test_scan_pose_budget_rejects_before_object_and_numeric_allocations(self):
        def figures(count=1):
            return [{"figure_type_id": 1, "segment_count": count,
                "segments": [{"segment_id": index+1} for index in range(count)],
                "image_assets": [], "text_assets": []}]
        # Deliberately omit the bytes the scanner would read next. A budget
        # error (rather than EOF) proves rejection precedes those allocations.
        many_objects = struct.pack("<IHBHH", 1, 1, 0, 0, 20)
        large_angles = frame_bytes()[:26]
        lengths = frame_bytes([{"uid": 1, "length": 3}])[:44]
        bends = frame_bytes([{"uid": 1, "length": 3, "bend": .2}])[:50]
        joins = frame_bytes([{"uid": 1, "join": (1, 0)}, {"uid": 2}])[:47]
        rows = [(many_objects, 1, 512 + 19 * 512),
            (large_angles, 30000, 1024 + 30000 * 24 - 1),
            (lengths, 1, 1024 + 24), (bends, 1, 1024 + 48),
            (joins, 1, 512 + 2 * 512 + 24)]
        for source, count, budget in rows:
            with self.subTest(count=count, budget=budget):
                reader = server.FastReader(source)
                with self.assertRaisesRegex(server.piv_codec.PivError, "Native scene exceeds the .* pose budget"):
                    fast_decode.scan_keyframes(reader, figures(count), 2, max_pose_bytes=budget)
                self.assertEqual(reader.pos, len(source))
        # Reject huge frame tables immediately, before allocating frame shells.
        source = struct.pack("<I", 600000)
        reader = server.FastReader(source)
        with self.assertRaisesRegex(server.piv_codec.PivError, "pose budget"):
            fast_decode.scan_keyframes(reader, figures(), 2, max_pose_bytes=256 * 1024 * 1024)
        self.assertEqual(reader.pos, len(source))

    def test_scan_pose_budget_accepts_exact_limit_and_checks_default(self):
        figures = [{"figure_type_id": 1, "segment_count": 1, "segments": [{"segment_id": 1}],
            "image_assets": [], "text_assets": []}]
        source = frame_bytes([{"uid": 1, "join": (1, 0)}, {"uid": 2, "length": 3, "bend": .2}])
        exact = 512 + 2 * 512 + 4 * 24 + 64
        self.assertEqual(len(fast_decode.scan_keyframes(server.FastReader(source), figures, 2,
            max_pose_bytes=exact)), 1)
        with mock.patch.object(fast_decode, "NATIVE_POSE_BUDGET", exact-1):
            with self.assertRaisesRegex(server.piv_codec.PivError, "pose budget"):
                fast_decode.scan_keyframes(server.FastReader(source), figures, 2)


if __name__ == "__main__":
    unittest.main()

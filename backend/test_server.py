"""Real fixture import/export and local HTTP transport acceptance tests."""
from __future__ import annotations

import copy
import http.client
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import threading
import unittest
from unittest import mock
import zlib

import server


class CodecTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = server.ProjectStore(server.WORKSPACE)
        cls.modern = server.WORKSPACE / "Pivot Animator v5/Animations/tween_camera.piv"
        cls.stk = server.WORKSPACE / "Pivot Animator v5/Figures/sheep.stk"
        manifest = json.loads((server.WORKSPACE / "docs/piv_corpus_manifest.json").read_text(encoding="utf-8"))
        cls.fixtures = [server.WORKSPACE / item["path"] for item in manifest["fixtures"]]

    def test_real_piv_corpus_lossless_roundtrip(self):
        versions = set()
        for path in self.fixtures:
            with self.subTest(path=path.name):
                source = path.read_bytes()
                imported = self.store.import_bytes(source, path.name)
                versions.add(imported["document"]["version"])
                output, name = self.store.export({**imported, "format": "piv"})
                self.assertEqual(output, source)
                self.assertTrue(name.endswith(".piv"))
                self.assertNotIn("editable_paths", imported["document"])
                self.assertNotIn("_codec", imported["document"])
        self.assertEqual(versions, {2, 3, 4, 5})

    def test_canonical_digest_preserves_unknown_fields_and_numeric_values(self):
        source = {"known": [1.0, -0.0, 1.25, True, None],
            "opaque": {"number_text": "1.0", "negative_zero_text": "-0.0", "integer": 9007199254740993}}
        before = copy.deepcopy(source)
        browser_numbers = {"known": [1, 0, 1.25, True, None],
            "opaque": {"number_text": "1.0", "negative_zero_text": "-0.0", "integer": 9007199254740993}}
        self.assertEqual(server.document_digest(source), server.document_digest(browser_numbers))
        self.assertEqual(source, before)
        self.assertIsInstance(source["known"][0], float)
        for changed in (
            {**browser_numbers, "known": [1, 0, 1.2500000000000002, True, None]},
            {**browser_numbers, "known": [1, 0, 1.25, 1, None]},
            {**browser_numbers, "opaque": {**browser_numbers["opaque"], "number_text": "1"}},
            {**browser_numbers, "opaque": {**browser_numbers["opaque"], "integer": 9007199254740992}},
            {**browser_numbers, "new_unknown_field": 1},
        ):
            self.assertNotEqual(server.document_digest(source), server.document_digest(changed))
        with self.assertRaises(ValueError):
            server.document_digest({"nonfinite": float("nan")})

    def test_integral_number_normalization_keeps_real_sources_identical(self):
        paths = [self.modern, server.WORKSPACE / "Goku_Broly_Movie_by_Killer1.piv",
            server.WORKSPACE / "PIVOT ANIMATOR SCENE TEST/Shroobs_JJK_Pack.piv"]
        for path in paths:
            with self.subTest(path=path.name):
                original = path.read_bytes()
                imported = self.store.import_bytes(original, path.name)
                document = server._canonical_numbers(imported["document"])
                output, _ = self.store.export({**imported, "document": document, "format": "piv"})
                self.assertEqual(output, original)
                saved, _ = self.store.export({**imported, "document": document, "format": "styk"})
                restarted = server.ProjectStore(server.WORKSPACE)
                reopened = restarted.import_bytes(saved, "restored.styk")
                reopened["document"] = server._canonical_numbers(reopened["document"])
                output, _ = restarted.export({**reopened, "format": "piv"})
                self.assertEqual(output, original)

    def test_older_native_digest_remains_readable(self):
        imported = self.store.import_bytes(self.modern.read_bytes(), self.modern.name)
        saved, _ = self.store.export({**imported, "format": "styk"})
        native = json.loads(server.native_format.decode(saved))
        native["_stykSource"].pop("document_digest_version")
        native["_stykSource"]["document_sha256"] = server.document_digest(imported["document"], canonical=False)
        restored = server.ProjectStore(server.WORKSPACE).import_bytes(server.encoded_json(native), "older.styk")
        output, _ = self.store.export({"document": restored["document"], "format": "piv"})
        self.assertEqual(output, self.modern.read_bytes())

    def test_stk_native_restart_preserves_original_and_real_edits(self):
        original = self.stk.read_bytes()
        imported = self.store.import_bytes(original, self.stk.name)
        native, _ = self.store.export({**imported, "format": "styk"})
        restarted = server.ProjectStore(server.WORKSPACE)
        reopened = restarted.import_bytes(native, "restored.styk")
        exact, _ = restarted.export({**reopened, "format": "stk", "figureTypeId": 2})
        self.assertEqual(exact, original)
        # Embedded sources work even when the caller has no server cache ID.
        exact, _ = restarted.export({"document": reopened["document"], "format": "stk"})
        self.assertEqual(exact, original)
        figure = reopened["document"]["figure_types"][1]
        figure["segments"][0]["length"] += .25
        edited, _ = restarted.export({**reopened, "format": "stk", "figureTypeId": 2})
        self.assertNotEqual(edited, original)
        actual = restarted.import_bytes(edited, "edited.stk")
        self.assertEqual(actual["document"]["figure_types"][1]["segments"][0]["length"], figure["segments"][0]["length"])

    def test_native_preserves_project_name_and_unknown_metadata(self):
        imported = self.store.import_bytes(self.modern.read_bytes(), self.modern.name)
        imported["document"]["_styk"] = {"format": "StykAnimate", "format_version": 1,
            "name": "My authored title", "future": {"keep": [1, "01", .25]}}
        native, _ = self.store.export({**imported, "format": "styk"})
        restored = server.ProjectStore(server.WORKSPACE).import_bytes(native, "different-filename.styk")
        self.assertEqual(restored["document"]["_styk"], imported["document"]["_styk"])

    def test_native_cache_does_not_retain_duplicate_uploaded_json(self):
        imported = self.store.import_bytes(self.modern.read_bytes(), self.modern.name)
        imported["document"]["opaque"] = "large opaque asset " * 10000
        native, _ = self.store.export({**imported, "format": "styk"})
        # Enough for one native document, deliberately less than two copies.
        restarted = server.ProjectStore(server.WORKSPACE, max_cache=len(server.native_format.decode(native)) + 1024)
        reopened = restarted.import_bytes(native, "large.styk")
        entry = restarted.sources[reopened["sourceId"]]
        self.assertEqual(entry.data, b"")
        self.assertEqual(entry.retained_size, len(entry.document_json))
        exact, _ = restarted.export({**reopened, "format": "piv"})
        self.assertEqual(exact, self.modern.read_bytes())

    def test_native_save_skips_unused_current_document_fingerprint(self):
        store = server.ProjectStore(server.WORKSPACE)
        imported = store.import_bytes(self.modern.read_bytes(), self.modern.name)
        with mock.patch.object(server, "document_digest", wraps=server.document_digest) as digest:
            store.export({**imported, "format": "styk"})
            self.assertEqual(digest.call_count, 1)  # Original source fingerprint only.
            digest.reset_mock()
            imported["document"]["keyframes"][0]["objects"][0]["root_x"] += .25
            native, _ = store.export({**imported, "format": "styk"})
            self.assertEqual(digest.call_count, 0)
        restarted = server.ProjectStore(server.WORKSPACE)
        reopened = restarted.import_bytes(native, "edited.styk")
        actual, _ = restarted.export({**reopened, "format": "piv"})
        self.assertEqual(server.piv_codec.decode_piv_bytes(actual)["keyframes"][0]["objects"][0]["root_x"],
            imported["document"]["keyframes"][0]["objects"][0]["root_x"])

    def test_legacy_runtime_cache_omission_is_not_a_binary_edit(self):
        path = server.WORKSPACE / "Pivot Animator v5/Animations/Legacy/walking.piv"
        original = path.read_bytes()
        imported = self.store.import_bytes(original, path.name)
        document = imported["document"]
        old_digest = server.document_digest(document, runtime_aliases=True)
        for frame in document["keyframes"]:
            for obj in frame["objects"]:
                obj.pop("runtime_segments", None)
        exact, _ = self.store.export({**imported, "format": "piv"})
        self.assertEqual(exact, original)
        native, _ = self.store.export({**imported, "format": "styk"})
        older = json.loads(server.native_format.decode(native))
        older["_stykSource"].update(document_digest_version=2, document_sha256=old_digest)
        restarted = server.ProjectStore(server.WORKSPACE)
        reopened = restarted.import_bytes(server.encoded_json(older), "older.styk")
        exact, _ = restarted.export({**reopened, "format": "piv"})
        self.assertEqual(exact, original)
        reopened["document"]["keyframes"][0]["objects"][0]["root_x"] += .25
        edited, _ = restarted.export({**reopened, "format": "piv"})
        self.assertNotEqual(edited, original)
        self.assertEqual(server.piv_codec.decode_piv_bytes(edited)["keyframes"][0]["objects"][0]["root_x"],
            reopened["document"]["keyframes"][0]["objects"][0]["root_x"])

    def test_runtime_cache_exclusion_does_not_ignore_opaque_names(self):
        original = {"keyframes": [{"objects": [{"root_x": .25, "runtime_segments": [1, 2]}]}],
            "runtime_segments": "unknown root field", "opaque": {"runtime_segments": "unknown nested field"}}
        without_cache = copy.deepcopy(original)
        without_cache["keyframes"][0]["objects"][0].pop("runtime_segments")
        self.assertEqual(server.document_digest(original), server.document_digest(without_cache))
        without_cache["opaque"]["runtime_segments"] = "edited"
        self.assertNotEqual(server.document_digest(original), server.document_digest(without_cache))

    def test_changed_pose_and_frames_export_to_pivot(self):
        imported = self.store.import_bytes(self.modern.read_bytes(), self.modern.name)
        document = imported["document"]
        document["fps"] = 30
        obj = document["keyframes"][0]["objects"][0]
        obj["root_x"] += 42.25
        obj["angles"][0] += 0.2
        document["keyframes"].insert(1, copy.deepcopy(document["keyframes"][0]))
        output, _ = self.store.export({**imported, "format": "piv"})
        actual = server.piv_codec.decode_piv_bytes(output)
        self.assertEqual(actual["fps"], 30)
        self.assertEqual(actual["keyframes"][0]["objects"][0]["root_x"], obj["root_x"])
        self.assertEqual(actual["keyframes"][0]["objects"][0]["angles"], obj["angles"])
        self.assertEqual(len(actual["keyframes"]), len(document["keyframes"]))

    def test_all_shipped_stks_keep_editable_geometry_and_assets(self):
        paths = list((server.WORKSPACE / "Pivot Animator v5/Figures").rglob("*.stk"))
        paths += list(server.WORKSPACE.glob("*.stk"))
        self.assertGreaterEqual(len(paths), 29)
        for path in paths:
            with self.subTest(path=path.name):
                imported = self.store.import_bytes(path.read_bytes(), path.name)
                original = imported["document"]["figure_types"][1]
                output, _ = self.store.export({**imported, "format": "piv"})
                actual = server.piv_codec.decode_piv_bytes(output)["figure_types"][1]
                self.assertEqual(len(actual["segments"]), len(original["segments"]))
                for field in ("polyfills", "image_assets", "text_assets"):
                    self.assertEqual(len(actual.get(field, [])), len(original.get(field, [])))
                stk, _ = self.store.export({**imported, "format": "stk", "figureTypeId": 2})
                self.assertEqual(stk, path.read_bytes())

    def test_native_save_retains_source_across_service_restart(self):
        imported = self.store.import_bytes(self.modern.read_bytes(), self.modern.name)
        saved, _ = self.store.export({**imported, "format": "styk"})
        restarted = server.ProjectStore(server.WORKSPACE)
        reopened = restarted.import_bytes(saved, "reopened.styk")
        output, _ = restarted.export({**reopened, "format": "piv"})
        self.assertEqual(output, self.modern.read_bytes())

    def test_native_save_retains_edits_across_service_restart(self):
        imported = self.store.import_bytes(self.modern.read_bytes(), self.modern.name)
        imported["document"]["fps"] = 30
        obj = imported["document"]["keyframes"][0]["objects"][0]
        obj["root_x"] += 79.5
        saved, _ = self.store.export({**imported, "format": "styk"})
        restarted = server.ProjectStore(server.WORKSPACE)
        reopened = restarted.import_bytes(saved, "edited.styk")
        output, _ = restarted.export({**reopened, "format": "piv"})
        actual = server.piv_codec.decode_piv_bytes(output)
        self.assertEqual(actual["fps"], 30)
        self.assertEqual(actual["keyframes"][0]["objects"][0]["root_x"], obj["root_x"])

    def test_early_native_wrapper_and_json_alias_import(self):
        imported = self.store.import_bytes(self.modern.read_bytes(), self.modern.name)
        wrapped = server.encoded_json({"format": "stykanimate", "version": 1,
            "name": "My early project", "document": imported["document"]})
        for filename in ("early.styk", "early.json"):
            reopened = self.store.import_bytes(wrapped, filename)
            self.assertEqual(reopened["kind"], "styk")
            self.assertEqual(reopened["document"], imported["document"])
            output, _ = self.store.export({**reopened, "format": "piv"})
            actual = server.piv_codec.decode_piv_bytes(output)
            self.assertEqual(len(actual["keyframes"]), len(imported["document"]["keyframes"]))

    def test_new_document_exports_without_source_cache(self):
        document = server.piv_codec.decode_piv_bytes(server.bridge.scaffold(
            {"canvas_width": 1280, "canvas_height": 720, "fps": 24}))
        document.pop("editable_paths", None)
        document["keyframes"][0]["objects"] = [{"unique_id": 1, "figure_type_id": 1,
            "scale": 1.0, "color_override_raw": 0, "field28": 0,
            "angles": [segment["angle_rad"] for segment in document["figure_types"][0]["segments"]],
            "root_x": 640.0, "root_y": 360.0, "lengths": [], "bends": [], "join": None}]
        document["keyframes"][0]["object_draw_order"] = [0]
        document["keyframes"][0]["object_draw_order_unique_ids"] = [1]
        output, _ = self.store.export({"document": document, "format": "piv"})
        actual = server.piv_codec.decode_piv_bytes(output)
        self.assertEqual(actual["canvas_width"], 1280)
        self.assertEqual(actual["keyframes"][0]["objects"][0]["root_x"], 640.0)

    def test_changed_legacy_scene_migrates_to_editable_v5(self):
        for path in self.fixtures:
            imported = self.store.import_bytes(path.read_bytes(), path.name)
            document = imported["document"]
            if document["version"] >= 5 or not document["keyframes"][0]["objects"]:
                continue
            obj = document["keyframes"][0]["objects"][0]
            obj["root_x"] += 11.25
            output, _ = self.store.export({**imported, "format": "piv"})
            actual = server.piv_codec.decode_piv_bytes(output)
            self.assertEqual(actual["version"], 5)
            self.assertAlmostEqual(actual["keyframes"][0]["objects"][0]["root_x"], obj["root_x"], places=3)
            return
        self.fail("The fixture corpus did not contain an editable legacy scene")

    def test_binary_cache_is_mutation_isolated(self):
        source = self.modern.read_bytes()
        imported = self.store.import_bytes(source, self.modern.name)
        imported["document"]["fps"] = 91
        second = self.store.import_bytes(source, self.modern.name)
        self.assertTrue(second["timings"]["cache_hit"])
        self.assertNotEqual(second["document"]["fps"], 91)

    def test_fast_reader_matches_parser_and_rejects_invalid_numbers(self):
        spec = importlib.util.spec_from_file_location("reference_piv_codec", server.TOOLS / "piv_codec.py")
        reference = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reference)
        source = self.modern.read_bytes()
        normal = reference.decode_piv_bytes(source)
        fast = server.piv_codec.decode_piv_bytes(source)
        for field in ("keyframes", "figure_types", "backgrounds", "fps", "canvas_width", "canvas_height"):
            self.assertEqual(fast[field], normal[field])
        reader = server.FastReader(struct.pack("<dd", 1.0, float("nan")))
        with self.assertRaises(server.piv_codec.PivError):
            reader.array("d", 2)
        with self.assertRaises(server.piv_codec.PivError):
            server.FastReader(b"\0").array("d", 20)

    def test_compiled_json_retains_every_corpus_value(self):
        for path in self.fixtures:
            with self.subTest(path=path.name):
                document = self.store.import_bytes(path.read_bytes(), path.name)["document"]
                fast = server.encoded_json(document, validated=True)
                standard = server.encoded_json(document)
                self.assertEqual(json.loads(fast), json.loads(standard))
        opaque = {"text": "caf\u00e9 \U0001f680", "surrogate": "\ud800", "uint64": 2**64 - 1,
            "larger_integer": 2**100, "tiny_fraction": 1e-100, "signed_zero": -0.0}
        self.assertEqual(json.loads(server.encoded_json(opaque, validated=True)), opaque)
        with mock.patch.object(server, "_fast_json", None):
            self.assertEqual(server.encoded_json(opaque, validated=True), server.encoded_json(opaque))

    def test_verified_binary_import_avoids_duplicate_scan_but_keeps_rejections(self):
        source = self.modern.read_bytes()
        store = server.ProjectStore(server.WORKSPACE)
        with mock.patch.object(server.bridge, "validate_document", wraps=server.bridge.validate_document) as validate:
            imported = store.import_bytes(source, self.modern.name)
            self.assertEqual(validate.call_count, 0)
            store.import_bytes(server.encoded_json(imported["document"]), "native.styk")
            self.assertEqual(validate.call_count, 1)
        # The grammar rejects nonfinite binary floats before the optimized path.
        obj = imported["document"]["keyframes"][0]["objects"][0]
        malformed = bytearray(zlib.decompress(source))
        struct.pack_into("<f", malformed, obj["record_offset"] + 6, float("nan"))
        with self.assertRaises(server.piv_codec.PivError):
            store.import_bytes(zlib.compress(malformed), "nonfinite.piv")
        # A valid native zero-key animation is distinct from malformed data.
        empty_frames = struct.pack("<BIIHHII", 5, 640, 480, 1, 2, 0, 24) + b"\x01"
        empty = store.import_bytes(zlib.compress(empty_frames), "empty-frames.piv")
        self.assertEqual(empty["document"]["keyframes"], [])
        self.assertEqual(empty["document"]["total_output_frames"], 0)
        native = imported["document"]
        native["opaque"] = {"unknown_nonfinite": float("nan")}
        with self.assertRaises(server.piv_codec.PivError):
            store.import_bytes(json.dumps(native).encode(), "nonfinite.styk")
        with self.assertRaises(server.piv_codec.PivError):
            store.export({"document": native, "format": "styk"})

    def test_path_traversal_and_malformed_import_are_rejected(self):
        for path in ("../secret.piv", "C:/secret.piv", "folder/../secret.piv", ".git/config"):
            with self.assertRaises(server.ApiError):
                self.store.open(path)
        with self.assertRaises((server.piv_codec.PivError, server.ApiError)):
            self.store.import_bytes(b"this is not a PIV", "broken.piv")
        with self.assertRaises(server.ApiError):
            self.store.import_bytes(b"", "empty.piv")
        with self.assertRaises(server.ApiError):
            self.store.import_bytes(b"data", "private.py")

    def test_missing_cache_source_fails_explicitly(self):
        imported = self.store.import_bytes(self.modern.read_bytes(), self.modern.name)
        with self.assertRaises(server.ApiError) as error:
            self.store.export({**imported, "sourceId": "expired", "format": "piv"})
        self.assertEqual(error.exception.status, 410)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="styk-web-http-test-")
        root = Path(cls.directory.name)
        (root / "index.html").write_text("<!doctype html><title>StykAnimate</title>")
        cls.server = server.LocalServer(("127.0.0.1", 0), server.ProjectStore(server.WORKSPACE), root)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.directory.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=30)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_health_static_and_binary_upload_export(self):
        status, _, data = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(data)["ok"])
        status, _, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"StykAnimate", data)
        source = (server.WORKSPACE / "Pivot Animator v5/Animations/tween_pendulum.piv").read_bytes()
        status, _, data = self.request("POST", "/api/import?filename=pendulum.piv", source,
            {"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 200, data)
        result = json.loads(data)
        status, headers, data = self.request("POST", "/api/export", server.encoded_json({**result, "format": "piv"}),
            {"Content-Type": "application/json"})
        self.assertEqual(status, 200, data)
        self.assertEqual(data, source)
        self.assertIn("Content-Disposition", headers)

    def test_reject_remote_origin_host_and_private_static_files(self):
        status, _, _ = self.request("GET", "/api/samples", headers={"Origin": "https://attacker.example"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("GET", "/api/health", headers={"Host": "attacker.example"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("GET", "/../tools/piv_codec.py")
        self.assertEqual(status, 403)

    def test_cors_preflight_from_local_editor(self):
        status, headers, _ = self.request("OPTIONS", "/api/import", headers={"Origin": "http://localhost:5173"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:5173")


if __name__ == "__main__":
    unittest.main(verbosity=2)

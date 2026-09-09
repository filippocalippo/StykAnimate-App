"""Native export of explicit V5 upgrades that retain a real legacy source."""
from __future__ import annotations

import base64
import copy
import hashlib
import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import zlib

import server
from piv_migrate import migrate_legacy_document


FIXTURES = {
    2: "Pivot Animator v5/Animations/Legacy/walking.piv",
    3: "Pivot Animator v5/Animations/Legacy/cursor.piv",
    4: "Pivot Animator v5/Animations/Legacy/sprite_demo.piv",
}


class LegacyUpgradeExportTests(unittest.TestCase):
    def upgraded(self, version=2):
        store = server.ProjectStore(server.WORKSPACE)
        path = server.WORKSPACE / FIXTURES[version]
        source = path.read_bytes()
        imported = store.import_bytes(source, path.name)
        self.assertEqual(imported["document"]["version"], version)
        legacy = copy.deepcopy(imported["document"])
        modern = migrate_legacy_document(legacy)
        # The editor keeps import provenance when it changes the live schema.
        modern["source_sha256"] = legacy["source_sha256"]
        modern["source_path"] = legacy["source_path"]
        modern["fps"] = 27
        obj = modern["keyframes"][0]["objects"][0]
        obj["root_x"] += 37.25
        obj["angles"][0] += .125
        modern["keyframes"].append(copy.deepcopy(modern["keyframes"][0]))
        modern["keyframes"][-1]["keyframe_index"] = len(modern["keyframes"]) - 1
        return store, imported, legacy, modern, source

    def assert_exported_scene(self, output, modern):
        actual = server.piv_codec.decode_piv_bytes(output)
        self.assertEqual(actual["version"], 5)
        self.assertEqual(actual["fps"], 27)
        self.assertEqual(len(actual["keyframes"]), len(modern["keyframes"]))
        wanted = modern["keyframes"][0]["objects"][0]
        restored = actual["keyframes"][0]["objects"][0]
        self.assertAlmostEqual(restored["root_x"], wanted["root_x"], places=4)
        self.assertEqual(restored["angles"], wanted["angles"])
        self.assertEqual(len(actual["figure_types"]), len(modern["figure_types"]))
        self.assertEqual(len(actual["backgrounds"]), len(modern["backgrounds"]))
        for actual_figure, wanted_figure in zip(actual["figure_types"], modern["figure_types"]):
            self.assertEqual(len(actual_figure.get("image_assets", [])), len(wanted_figure.get("image_assets", [])))
        return actual

    def test_real_legacy_v2_v3_v4_upgrade_exports_edited_v5_and_preserves_source(self):
        for version in FIXTURES:
            with self.subTest(version=version):
                store, imported, legacy, modern, source = self.upgraded(version)
                before = copy.deepcopy(modern)
                output, filename = store.export({**imported, "document": modern, "format": "piv"})
                self.assert_exported_scene(output, modern)
                self.assertTrue(filename.endswith(".piv"))
                self.assertEqual(modern, before)
                self.assertEqual(store.sources[imported["sourceId"]].data, source)
                # Undo can restore the legacy document and export it byte-for-byte.
                restored, _ = store.export({**imported, "document": legacy, "format": "piv"})
                self.assertEqual(restored, source)

    def test_native_save_restart_keeps_original_bytes_and_modern_edits(self):
        for version in FIXTURES:
            with self.subTest(version=version):
                store, imported, legacy, modern, source = self.upgraded(version)
                native, _ = store.export({**imported, "document": modern, "format": "styk"})
                saved = json.loads(server.native_format.decode(native))
                metadata = saved["_stykSource"]
                self.assertEqual(metadata["version"], version)
                self.assertEqual(metadata["sha256"], hashlib.sha256(source).hexdigest())
                self.assertEqual(base64.b64decode(metadata["source_base64"]), source)
                restarted = server.ProjectStore(server.WORKSPACE)
                reopened = restarted.import_bytes(native, "upgraded.styk")
                output, _ = restarted.export({**reopened, "format": "piv"})
                self.assert_exported_scene(output, modern)
                # Embedded provenance also works without a service cache ID.
                output, _ = restarted.export({"document": reopened["document"], "format": "piv"})
                self.assert_exported_scene(output, modern)
                native_again, _ = restarted.export({**reopened, "format": "styk"})
                self.assertEqual(json.loads(server.native_format.decode(native_again))["_stykSource"], metadata)
                self.assertEqual(reopened["document"]["source_sha256"], legacy["source_sha256"])

    def test_editable_embedded_version_cannot_choose_the_wrong_writer(self):
        store, imported, _, modern, _ = self.upgraded(3)
        native, _ = store.export({**imported, "document": modern, "format": "styk"})
        saved = json.loads(server.native_format.decode(native))
        saved["_stykSource"]["version"] = 5
        # The embedded file is actually V3; use its validated header.
        output, _ = store.export({"document": saved, "format": "piv"})
        self.assert_exported_scene(output, modern)
        # A cached source version is authoritative too.
        output, _ = store.export({**imported, "document": saved, "format": "piv"})
        self.assert_exported_scene(output, modern)

    def test_native_reopens_and_exports_in_a_fresh_python_process(self):
        store, imported, _, modern, source = self.upgraded(4)
        native, _ = store.export({**imported, "document": modern, "format": "styk"})
        with tempfile.TemporaryDirectory(prefix="styk-upgrade-restart-") as directory:
            saved = Path(directory) / "upgraded.styk"
            exported = Path(directory) / "reopened.piv"
            saved.write_bytes(native)
            script = """
import hashlib, json, sys
from pathlib import Path
import server
store = server.ProjectStore(server.WORKSPACE)
opened = store.import_bytes(Path(sys.argv[1]).read_bytes(), 'upgraded.styk')
output, _ = store.export({**opened, 'format': 'piv'})
Path(sys.argv[2]).write_bytes(output)
print(json.dumps({'original_sha256': hashlib.sha256(server.bridge.source_bytes(opened['document'])).hexdigest(),
    'original_version': opened['document']['_stykSource']['version'], 'version': opened['document']['version']}))
"""
            process = subprocess.run([sys.executable, "-c", script, str(saved), str(exported)],
                cwd=Path(__file__).resolve().parent, capture_output=True, text=True, timeout=30)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(json.loads(process.stdout), {
                "original_sha256": hashlib.sha256(source).hexdigest(), "original_version": 4, "version": 5})
            self.assert_exported_scene(exported.read_bytes(), modern)
    def test_mismatched_original_report_fingerprint_remains_rejected(self):
        store, imported, _, modern, _ = self.upgraded()
        native, _ = store.export({**imported, "document": modern, "format": "styk"})
        modern["source_sha256"] = "0" * 64
        with self.assertRaisesRegex(server.piv_codec.PivError, "different original source"):
            store.export({**imported, "document": modern, "format": "piv"})
        saved = json.loads(server.native_format.decode(native))
        saved["source_sha256"] = "0" * 64
        with self.assertRaisesRegex(server.piv_codec.PivError, "different original source"):
            store.export({"document": saved, "format": "piv"})

    def test_corrupt_embedded_fingerprint_or_legacy_grammar_remains_rejected(self):
        store, imported, _, modern, _ = self.upgraded()
        native, _ = store.export({**imported, "document": modern, "format": "styk"})
        saved = json.loads(server.native_format.decode(native))
        saved["_stykSource"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(server.piv_codec.PivError, "fingerprint"):
            store.export({"document": saved, "format": "piv"})
        # A self-consistent SHA is not evidence of a valid Pivot file.
        for malformed in (b"\x02", zlib.compress(b"\x03broken"), zlib.compress(b"")):
            with self.subTest(source=malformed.hex()):
                digest = hashlib.sha256(malformed).hexdigest()
                saved["source_sha256"] = digest
                saved["_stykSource"].update(sha256=digest, source_base64=base64.b64encode(malformed).decode("ascii"))
                with self.assertRaises(ValueError):
                    store.export({"document": saved, "format": "piv"})

    def test_stale_cached_source_is_not_silently_replaced_by_embedded_bytes(self):
        store, imported, _, modern, _ = self.upgraded()
        native, _ = store.export({**imported, "document": modern, "format": "styk"})
        with self.assertRaises(server.ApiError) as error:
            store.export({"sourceId": "expired", "document": json.loads(server.native_format.decode(native)), "format": "piv"})
        self.assertEqual(error.exception.status, 410)
        self.assertEqual(error.exception.code, "source_expired")

    def test_unupgraded_legacy_version_mismatch_remains_rejected(self):
        store, imported, legacy, _, _ = self.upgraded(2)
        legacy["version"] = 3
        with self.assertRaisesRegex(server.piv_codec.PivError, "version does not match"):
            store.export({**imported, "document": legacy, "format": "piv"})

    def test_http_exports_upgraded_scene_and_reports_source_errors(self):
        store, imported, _, modern, _ = self.upgraded(4)
        native, _ = store.export({**imported, "document": modern, "format": "styk"})
        service = server.LocalServer(("127.0.0.1", 0), store, server.APP)
        thread = threading.Thread(target=service.serve_forever, daemon=True)
        thread.start()

        def request(document, source_id=None):
            connection = http.client.HTTPConnection("127.0.0.1", service.server_port, timeout=30)
            try:
                body = {"document": document, "format": "piv"}
                if source_id is not None:
                    body["sourceId"] = source_id
                connection.request("POST", "/api/export", server.encoded_json(body), {"Content-Type": "application/json"})
                response = connection.getresponse()
                return response.status, response.read()
            finally:
                connection.close()

        try:
            status, output = request(modern, imported["sourceId"])
            self.assertEqual(status, 200)
            self.assert_exported_scene(output, modern)
            saved = json.loads(server.native_format.decode(native))
            status, output = request(saved, "expired")
            self.assertEqual(status, 410)
            self.assertEqual(json.loads(output)["code"], "source_expired")
            saved["_stykSource"]["sha256"] = "0" * 64
            status, output = request(saved)
            self.assertEqual(status, 422)
            self.assertEqual(json.loads(output)["code"], "invalid_project")
            malformed = b"\x02"
            digest = hashlib.sha256(malformed).hexdigest()
            saved["source_sha256"] = digest
            saved["_stykSource"].update(sha256=digest, source_base64=base64.b64encode(malformed).decode("ascii"))
            status, output = request(saved)
            self.assertEqual(status, 422)
            self.assertEqual(json.loads(output)["code"], "invalid_project")
        finally:
            service.shutdown()
            service.server_close()
            thread.join()


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(LegacyUpgradeExportTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    artifact = Path(__file__).resolve().parents[1] / "artifacts/legacy-upgrade-export/report.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(json.dumps({
        "scope": "Python codec API; explicit modern document with retained legacy original source",
        "tests": result.testsRun, "passed": result.wasSuccessful(),
        "failures": [str(test) for test, _ in result.failures],
        "errors": [str(test) for test, _ in result.errors],
        "realSourceFixtures": FIXTURES,
        "checks": [name for name in unittest.defaultTestLoader.getTestCaseNames(LegacyUpgradeExportTests)],
    }, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(not result.wasSuccessful())

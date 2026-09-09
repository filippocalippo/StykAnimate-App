"""Independent native-wire cache, compatibility and source-export checks."""
import json
import struct
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import server


def metadata(wire):
    assert wire.startswith(b"STYKPIV1")
    return json.loads(wire[12:12 + struct.unpack_from("<I", wire, 8)[0]])


class NativeWireCacheReview(unittest.TestCase):
    def setUp(self):
        self.store = server.ProjectStore(server.WORKSPACE)
        self.path = server.WORKSPACE / "Pivot Animator v5/Animations/tween_camera.piv"
        self.source = self.path.read_bytes()

    def test_wire_first_keeps_original_bytes_through_native_save_and_restart(self):
        result = metadata(self.store.import_bytes(self.source, self.path.name, prefer_native=True))
        entry = self.store.sources[result["sourceId"]]
        self.assertIsNone(entry.document_json)
        retained = self.store.cache_bytes
        canonical = self.store.import_bytes(self.source, self.path.name)
        self.assertTrue(canonical["document"]["keyframes"][0]["objects"])
        exported, _ = self.store.export({**canonical, "format": "piv"})
        self.assertEqual(exported, self.source)
        saved, _ = self.store.export({**canonical, "format": "styk"})
        fresh = server.ProjectStore(server.WORKSPACE)
        reopened = fresh.import_bytes(saved, "restart.styk")
        exported, _ = fresh.export({**reopened, "format": "piv"})
        self.assertEqual(exported, self.source)
        self.assertIsNone(entry.document_json)
        self.assertEqual(self.store.cache_bytes, retained)

    def test_json_first_native_upgrade_accounts_retained_bytes_once(self):
        canonical = self.store.import_bytes(self.source, self.path.name)
        entry = self.store.sources[canonical["sourceId"]]
        self.assertIsNone(entry.native_wire)
        original_json = entry.document_json
        first = metadata(self.store.import_bytes(self.source, self.path.name, prefer_native=True))
        self.assertEqual(first["sourceId"], canonical["sourceId"])
        self.assertIs(entry.document_json, original_json)
        self.assertEqual(self.store.cache_bytes, sum(item.retained_size for item in self.store.sources.values()))
        retained = self.store.cache_bytes
        metadata(self.store.import_bytes(self.source, self.path.name, prefer_native=True))
        self.assertEqual(self.store.cache_bytes, retained)
        exported, _ = self.store.export({**canonical, "format": "piv"})
        self.assertEqual(exported, self.source)

    def test_negotiated_legacy_input_stays_complete_json_and_exports_exact_bytes(self):
        path = server.WORKSPACE / "Pivot Animator v5/Animations/Legacy/walking.piv"
        source = path.read_bytes()
        imported = json.loads(self.store.import_bytes(source, path.name, as_json=True, prefer_native=True))
        self.assertNotEqual(imported["document"]["version"], 5)
        self.assertTrue(imported["document"]["keyframes"][0]["objects"])
        exported, _ = self.store.export({**imported, "format": "piv"})
        self.assertEqual(exported, source)

    def test_parallel_lazy_canonical_decode_is_memory_serialized(self):
        packet = metadata(self.store.import_bytes(self.source, self.path.name, prefer_native=True))
        entry = self.store.sources[packet["sourceId"]]
        original = server.piv_codec.decode_piv_bytes
        lock = threading.Lock()
        active = maximum = 0

        def measured(*args, **kwargs):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            try:
                time.sleep(.025)
                return original(*args, **kwargs)
            finally:
                with lock:
                    active -= 1

        with mock.patch.object(server.piv_codec, "decode_piv_bytes", side_effect=measured):
            with ThreadPoolExecutor(max_workers=2) as pool:
                outputs = list(pool.map(lambda _: self.store._canonical_json(entry), range(2)))
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(maximum, 1, "Lazy canonical decoding must obey the same peak-memory bound as imports")


if __name__ == "__main__":
    unittest.main()

import hashlib
import json
import unittest
import zlib

import native_format as native


class NativeFormatTests(unittest.TestCase):
    def setUp(self):
        self.payload = json.dumps({'name': 'Scène 日本語', 'poses': [[0.125, 1, None, True]] * 10000}).encode()

    def test_lossless_compact_deterministic_both_kinds(self):
        for kind in ('styk', 'stkz', 'stykmov'):
            encoded = native.encode(self.payload, kind)
            self.assertEqual(encoded[:4], native.MAGIC[kind])
            self.assertEqual(native.decode(encoded, kind), self.payload)
            self.assertEqual(encoded, native.encode(self.payload, kind))
            self.assertLess(len(encoded), len(self.payload) / 20)

    def test_old_json_and_wrapper_remain_readable(self):
        for data in (self.payload, b'\xef\xbb\xbf \n' + self.payload, b'{"format":"stykanimate","version":1,"document":{}}'):
            self.assertEqual(native.decode(data), data)
            with self.assertRaises(ValueError):
                native.decode(data, 'stkz')

    def test_corruption_truncation_wrong_kind_and_future_version(self):
        valid = native.encode(self.payload, 'styk')
        for damaged in (b'', valid[:20], valid[:-1], valid + b'x',
                        valid[:4] + b'\x02' + valid[5:], valid[:5] + b'\x02' + valid[6:],
                        valid[:6] + b'\x01' + valid[7:],
                        valid[:24] + bytes([valid[24] ^ 1]) + valid[25:],
                        valid[:-1] + bytes([valid[-1] ^ 1])):
            with self.subTest(size=len(damaged)), self.assertRaises(ValueError):
                native.decode(damaged)
        with self.assertRaisesRegex(ValueError, 'extension'):
            native.decode(valid, 'stkz')

    def test_inflation_is_bounded_by_declared_and_absolute_sizes(self):
        packed = zlib.compress(self.payload)
        for size in (1, native.MAX_BYTES + 1):
            data = native.HEADER.pack(b'STYK', 1, 1, 0, size, len(packed), hashlib.sha256(self.payload).digest()) + packed
            with self.assertRaises(ValueError):
                native.decode(data)
        with self.assertRaises(ValueError):
            native.encode(self.payload, 'styk', max_bytes=100)

    def test_rejects_concatenated_compressed_streams(self):
        packed = zlib.compress(self.payload) + zlib.compress(b'{}')
        data = native.HEADER.pack(b'STYK', 1, 1, 0, len(self.payload), len(packed), hashlib.sha256(self.payload).digest()) + packed
        with self.assertRaises(ValueError):
            native.decode(data)


if __name__ == '__main__':
    unittest.main()

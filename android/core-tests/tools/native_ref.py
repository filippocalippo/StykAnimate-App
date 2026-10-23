"""Trimmed copy of backend/native_format.py (encode paths only) used to build
test fixtures with the project's own encoder. zstd is not used here."""
import base64, hashlib, json, math, re, struct, zlib

HEADER = struct.Struct('<4sBBHQQ32s')
SECTION = struct.Struct('<BBHIQQ32s8x')
VERSION = 1
MAX_BYTES = 256 * 1024 * 1024
MAX_SKELETON_BYTES = 384 * 1024 * 1024
MAGIC = {'styk': b'STYK', 'stkz': b'STKZ', 'stykmov': b'STMV'}
LIFT_MIN_ARRAY = 32
LIFT_MIN_STRING = 64 * 1024
B64_FIELDS = frozenset(('data_base64', 'source_base64'))
ESCAPABLE = re.compile(r'^S2[BSED]:')
TYPE_BYTES = {'u8': 1, 'u16': 2, 'u32': 4, 'i32': 4, 'f32': 4, 'f64': 8}
TYPE_FORMAT = {'u8': 'B', 'u16': 'H', 'u32': 'I', 'i32': 'i', 'f32': 'f', 'f64': 'd'}
F64_INT_LIMIT = 1 << 53


def _pack(data: bytes):
    return 1, zlib.compress(data, level=3)


def encode(payload: bytes, kind: str, *, max_bytes=MAX_BYTES) -> bytes:
    compressed = zlib.compress(payload, level=3)
    header = HEADER.pack(MAGIC[kind], VERSION, 1, 0, len(payload), len(compressed), hashlib.sha256(payload).digest())
    return header + compressed


def _array_type(values):
    ints, f32 = True, True
    low, high = 0, -1
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or (
                isinstance(value, float) and not math.isfinite(value)):
            return None
        if isinstance(value, int):
            if value < low: low = value
            if value > high: high = value
            if abs(value) >= F64_INT_LIMIT: return None
        else:
            ints = False
        if f32:
            try:
                f32 = struct.unpack('<f', struct.pack('<f', value))[0] == value
            except OverflowError:
                f32 = False
    if ints:
        if low >= 0:
            if high <= 0xff: return 'u8'
            if high <= 0xffff: return 'u16'
            if high <= 0xffffffff: return 'u32'
        elif low >= -0x80000000 and high <= 0x7fffffff:
            return 'i32'
        return 'f64'
    return 'f32' if f32 else 'f64'


def _canonical_base64_length(value):
    if len(value) % 4:
        return None
    padding = 2 if value.endswith('==') else 1 if value.endswith('=') else 0
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    end = len(value) - padding
    last = 0
    for index in range(end):
        last = alphabet.find(value[index])
        if last < 0:
            return None
    if (padding == 2 and last & 15) or (padding == 1 and last & 3):
        return None
    return len(value) // 4 * 3 - padding


def _lift(document, *, max_bytes=MAX_BYTES):
    arrays, blobs = bytearray(), bytearray()
    seen_arrays = {}
    seen_blobs = {}

    def lift(value, key):
        if isinstance(value, str):
            if len(value) >= LIFT_MIN_STRING:
                payload, prefix = None, ''
                if key in B64_FIELDS:
                    payload = value
                elif key in ('data_url', 'styk_tiles') and value.startswith('data:'):
                    comma = value.find(',')
                    if comma > 5 and value[:comma].endswith(';base64'):
                        payload, prefix = value[comma + 1:], value[:comma + 1]
                if payload is not None:
                    hit = seen_blobs.get(payload)
                    if hit is None:
                        try:
                            raw = base64.b64decode(payload, validate=True)
                        except ValueError:
                            raw = None
                        if raw is not None and base64.b64encode(raw).decode('ascii') == payload:
                            hit = (len(blobs), len(raw))
                            blobs.extend(raw)
                            seen_blobs[payload] = hit
                    if hit is not None:
                        marker = f'1:{hit[0]}:{hit[1]}'
                        return f'S2D:{marker}:{prefix}' if prefix else f'S2S:{marker}'
            return 'S2E:' + value if ESCAPABLE.match(value) else value
        if isinstance(value, list):
            element_type = _array_type(value) if len(value) >= LIFT_MIN_ARRAY else None
            if element_type is not None:
                hit = seen_arrays.get(id(value))
                if hit is not None:
                    return hit
                size = TYPE_BYTES[element_type]
                offset = len(arrays) + (-len(arrays) % size)
                arrays.extend(b'\0' * (offset - len(arrays)))
                arrays.extend(struct.pack(f'<{len(value)}{TYPE_FORMAT[element_type]}', *value))
                marker = f'S2B:{element_type}:0:{offset}:{len(value)}'
                seen_arrays[id(value)] = marker
                return marker
            return [lift(item, '') for item in value]
        if isinstance(value, dict):
            return {item_key: lift(item, item_key) for item_key, item in value.items()}
        return value

    skeleton = lift(document, '')
    return skeleton, [(1, bytes(arrays)), (2, bytes(blobs))]


def encode_v2(document, kind, *, max_bytes=MAX_BYTES):
    skeleton, sections = _lift(document, max_bytes=max_bytes)
    payload = json.dumps(skeleton, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    codec, packed_payload = _pack(payload)
    records = bytearray()
    payloads = []
    for section_kind, raw in sections:
        section_codec, stored = _pack(raw)
        records += SECTION.pack(section_kind, section_codec, 0, 0, len(raw), len(stored), hashlib.sha256(raw).digest())
        payloads.append(stored)
    header = HEADER.pack(MAGIC[kind], 2, codec, 0, len(payload), len(packed_payload), hashlib.sha256(payload).digest())
    parts = [header, struct.pack('<I', len(sections)), packed_payload, bytes(records), *payloads]
    return b''.join(parts)

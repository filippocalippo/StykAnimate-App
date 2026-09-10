"""Versioned, lossless STYK/STKZ/STMV containers, independent of the Pivot codec.

The payload is UTF-8 JSON compressed with zlib at level 3. A fixed header
identifies the kind/version and bounds inflation before any JSON is parsed.
"""
import hashlib
import struct
import zlib

HEADER = struct.Struct('<4sBBHQQ32s')
VERSION = 1
MAX_BYTES = 256 * 1024 * 1024
MAGIC = {'styk': b'STYK', 'stkz': b'STKZ', 'stykmov': b'STMV'}


def encode(payload: bytes, kind: str, *, max_bytes=MAX_BYTES) -> bytes:
    if kind not in MAGIC:
        raise ValueError('Unknown StykAnimate file kind.')
    if not payload or len(payload) > max_bytes:
        raise ValueError('The native document exceeds the uncompressed size limit.')
    compressed = zlib.compress(payload, level=3)
    header = HEADER.pack(MAGIC[kind], VERSION, 1, 0, len(payload), len(compressed), hashlib.sha256(payload).digest())
    if len(header) + len(compressed) > max_bytes:
        raise ValueError('The native file exceeds the compressed size limit.')
    return header + compressed


def decode(data: bytes, kind='styk', *, max_bytes=MAX_BYTES) -> bytes:
    if kind not in MAGIC:
        raise ValueError('Unknown StykAnimate file kind.')
    if len(data) > max_bytes:
        raise ValueError('The native file exceeds the compressed size limit.')
    # Read compatibility for both original plain JSON and the early wrapper.
    if kind == 'styk' and data.lstrip(b'\xef\xbb\xbf \t\r\n').startswith(b'{'):
        return data
    if len(data) < HEADER.size:
        raise ValueError('The StykAnimate file is truncated or has an invalid header.')
    magic, version, compression, flags, size, packed_size, digest = HEADER.unpack_from(data)
    if magic != MAGIC[kind]:
        raise ValueError('The StykAnimate file type does not match its extension.')
    if version != VERSION or compression != 1 or flags != 0:
        raise ValueError('Unsupported StykAnimate file version. Update the app to open this file.')
    if not 0 < size <= max_bytes:
        raise ValueError('The native document exceeds the uncompressed size limit.')
    if packed_size != len(data) - HEADER.size:
        raise ValueError('The StykAnimate file is truncated or has trailing data.')
    decoder = zlib.decompressobj()
    try:
        payload = decoder.decompress(data[HEADER.size:], size + 1)
    except zlib.error as error:
        raise ValueError('The StykAnimate file is damaged (invalid compressed data).') from error
    if len(payload) != size or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError('The StykAnimate file is damaged (invalid payload length).')
    if hashlib.sha256(payload).digest() != digest:
        raise ValueError('The StykAnimate file is damaged (checksum mismatch).')
    return payload

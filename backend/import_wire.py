"""Validated native frame bytes avoid repeating a large JSON object inventory.

This is an internal transport, not a new project format. The normal decoder has
already validated the complete file. All decoded fields are reconstructed by the
client; canonical JSON and original bytes remain available for native export.
"""
import struct

CONTENT_TYPE = "application/vnd.stykanimate.piv-frames-v1"
MAGIC = b"STYKPIV1"


def native_frame_wire(document, source, unpack_source, encode, *, payload=None):
    if document.get("version") != 5 or document.get("format") != "piv_v5_standalone":
        return None
    if payload is None:
        payload, _ = unpack_source(source)
    start = document["validation"]["frame_start"]
    end = document["validation"]["trailer_start"] - 4
    if not (0 <= start < end <= len(payload)):
        raise ValueError("Invalid validated native frame extent")
    header = dict(document)
    header["keyframes"] = []
    return encode(header, validated=True), payload[start:end], start


def response_bytes(parts, metadata, encode):
    header, frames, start = parts
    wire = encode({**metadata, "nativeFrames": {"version": 1, "sourceOffset": start,
        "byteLength": len(frames)}})
    # Reuse the already encoded figure/media header; no parse or huge graph copy.
    result_header = b'{"document":' + header + b',' + wire[1:]
    return b"".join((MAGIC, struct.pack("<I", len(result_header)), result_header, frames))

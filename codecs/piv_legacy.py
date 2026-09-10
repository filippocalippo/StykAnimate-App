"""Version dispatch and integrity checks for Pivot 2–4 project payloads.

Version-specific readers consume sequential records.  This module supplies the
common contract used by ``piv_codec``; no marker searching or trace is involved.
"""
from __future__ import annotations

import base64
import math
from pathlib import Path
import struct
from typing import Any
import zlib


def _keyed_bitmap_png(asset: dict[str, Any]) -> None:
    """Decode native BMP color-key transparency for browser image resources.

    BI_RGB BMPs store bottom-up padded BGR rows (or indexed palettes), while
    browser PNGs need top-down RGBA pixels.  Binary PIV data is left untouched.
    """
    key = asset.get("transparency_color_raw", asset.get("transparent_color_raw"))
    uri = asset.get("data_uri", "")
    if key is None or not uri.startswith("data:image/bmp;base64,"):
        return
    blob = base64.b64decode(uri.split(",", 1)[1])
    if len(blob) < 54 or blob[:2] != b"BM":
        raise ValueError("Truncated legacy sprite bitmap")
    pixel_offset = struct.unpack_from("<I", blob, 10)[0]
    dib_size = struct.unpack_from("<I", blob, 14)[0]
    if dib_size < 40:
        asset["render_limitations"] = ["Color-key conversion for OS/2 BMP headers is not implemented."]
        return
    width, signed_height, planes, bits, compression = struct.unpack_from("<iiHHI", blob, 18)
    height = abs(signed_height)
    if width <= 0 or not height or planes != 1:
        raise ValueError("Invalid legacy sprite bitmap geometry")
    if compression != 0 or bits not in (1, 4, 8, 24, 32):
        asset["render_limitations"] = [f"Color-key conversion for BMP compression {compression}, depth {bits} is not implemented."]
        return
    stride = ((width * bits + 31) // 32) * 4
    if pixel_offset + stride * height > len(blob):
        raise ValueError("Legacy sprite bitmap pixels exceed stored resource")
    palette = []
    if bits <= 8:
        used = struct.unpack_from("<I", blob, 46)[0] or (1 << bits)
        palette_start = 14 + dib_size
        if used > 1 << bits or palette_start + used * 4 > pixel_offset:
            raise ValueError("Invalid legacy sprite bitmap palette")
        for index in range(used):
            blue, green, red = blob[palette_start + index * 4:palette_start + index * 4 + 3]
            palette.append((red, green, blue))
    key_rgb = (key & 255, key >> 8 & 255, key >> 16 & 255)
    rows = bytearray()
    for y in range(height):
        row = pixel_offset + (height - 1 - y if signed_height > 0 else y) * stride
        rows.append(0)  # PNG filter: none.
        for x in range(width):
            if bits <= 8:
                index = (blob[row + x * bits // 8] >> (8 - bits - (x * bits % 8))) & ((1 << bits) - 1)
                if index >= len(palette):
                    raise ValueError("Legacy sprite bitmap references an absent palette color")
                rgb = palette[index]
            else:
                pos = row + x * (bits // 8)
                blue, green, red = blob[pos:pos + 3]
                rgb = (red, green, blue)
            rows.extend((*rgb, 0 if rgb == key_rgb else 255))
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
    asset["data_url"] = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    asset["render_mime_type"] = "image/png"
    asset["color_key_applied"] = True


def _validate_report(report: dict[str, Any], payload_size: int) -> None:
    """Reject corrupt references even when their binary widths remain valid."""
    for field in ("canvas_width", "canvas_height"):
        value = report.get(field)
        if not isinstance(value, int) or not 0 < value <= 100000:
            raise ValueError(f"Invalid legacy {field}: {value!r}")
    if not isinstance(report.get("fps"), (int, float)) or not 1 <= report["fps"] <= 1000:
        raise ValueError(f"Invalid legacy playback rate: {report.get('fps')!r}")

    figures = report.get("figure_types", [])
    by_id = {figure["figure_type_id"]: figure for figure in figures}
    if len(by_id) != len(figures):
        raise ValueError("Duplicate legacy figure type ID")
    for figure in figures:
        segments = figure["segments"]
        if len(segments) != figure["segment_count"]:
            raise ValueError("Legacy segment count does not match records")
        parents = {segment["segment_id"]: segment["parent_id"] for segment in segments}
        if len(parents) != len(segments) or 0 in parents:
            raise ValueError("Duplicate or zero legacy segment ID")
        for segment_id in parents:
            visiting: set[int] = set()
            current = segment_id
            while current:
                if current in visiting:
                    raise ValueError(f"Legacy segment parent cycle in figure {figure['figure_type_id']}")
                if current not in parents:
                    raise ValueError(f"Unknown legacy parent ID {current}")
                visiting.add(current)
                current = parents[current]

    background_ids = {0, *(background["background_id"] for background in report.get("backgrounds", []))}
    for frame in report.get("keyframes", []):
        if frame["background_id"] not in background_ids:
            raise ValueError(f"Unknown legacy background ID {frame['background_id']}")
        objects = frame["objects"]
        if sorted(frame["object_draw_order"]) != list(range(len(objects))):
            raise ValueError("Legacy object draw order must be a permutation of frame slots")
        for obj in objects:
            figure = by_id.get(obj["figure_type_id"])
            if figure is None:
                raise ValueError(f"Unknown legacy figure type {obj['figure_type_id']}")
            count = figure["segment_count"]
            if len(obj["angles"]) != count:
                raise ValueError("Legacy angle count does not match figure topology")
            if obj.get("lengths") and len(obj["lengths"]) != count:
                raise ValueError("Legacy length count does not match figure topology")
            for value in [obj["root_x"], obj["root_y"], obj["scale"], *obj["angles"], *obj.get("lengths", [])]:
                if not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise ValueError("Non-finite legacy object geometry")
            join = obj.get("join")
            if join:
                slot = join["target_object_slot"]
                if not 0 <= slot < len(objects):
                    raise ValueError("Legacy join refers to an absent object")
                target = by_id[objects[slot]["figure_type_id"]]
                handles = {0, *(segment["segment_id"] for segment in target["segments"])}
                if join["target_handle_id"] not in handles:
                    raise ValueError("Legacy join refers to an absent target handle")

    validation = report.setdefault("validation", {})
    consumed = validation.get("payload_consumed", validation.get("consumed_bytes"))
    if consumed != payload_size:
        raise ValueError(f"Legacy decoder did not account for complete payload: {consumed}/{payload_size}")
    validation["payload_consumed"] = payload_size
    validation["reference_integrity"] = True


def decode_legacy_payload(
    data: bytes,
    source_path: str | Path | None = None,
    assets_root: str | Path | None = None,
) -> dict[str, Any]:
    """Decode an already uncompressed legacy payload into the project schema."""
    if not data or data[0] not in (2, 3, 4):
        raise ValueError(f"Unsupported legacy Pivot version: {data[0] if data else 'empty'}")
    source = str(source_path) if source_path else ""
    assets = Path(assets_root) if assets_root else None
    if data[0] == 4:
        if __package__:
            from .piv_legacy_v4 import decode_v4
        else:
            from piv_legacy_v4 import decode_v4

        report = decode_v4(data, source_path=source, assets_root=assets)
    else:
        if __package__:
            from .piv_legacy_v2 import decode_v2
        else:
            from piv_legacy_v2 import decode_v2

        report = decode_v2(data, source_path=source, assets_root=assets)
    _validate_report(report, len(data))
    report.setdefault("payload_size", len(data))
    report.setdefault("source_path", source)
    report.setdefault("file_type", "piv")
    report.setdefault("trace_assisted", False)
    report.setdefault("supports_viewer", True)
    for frame in report["keyframes"]:
        frame.setdefault("inbetweens", 0)
        frame.setdefault("interpolation", "hold")
        frame.setdefault("duration_semantics", "hold")
        frame.setdefault("duration_frames", frame["duration_raw"])
    total = sum(frame["duration_frames"] for frame in report["keyframes"])
    report.setdefault("total_output_frames", total)
    report.setdefault("duration_seconds", total / report["fps"])
    assets_to_normalize = list(report.get("backgrounds", []))
    for figure in report["figure_types"]:
        for segment in figure["segments"]:
            if segment.get("segment_type") == "image":
                segment.setdefault("extra_u16", segment.get("image_asset_index", segment.get("sprite_index", 0)))
                # Legacy sprite_flip reverses the attachment endpoints. The
                # separate per-instance image_text_flags byte mirrors pixels.
                segment.setdefault("extra_u8_a", segment.get("image_flip", segment.get("sprite_flip", 0)))
                segment.setdefault("extra_u8_b", 0)
        for asset in figure.get("image_assets", []):
            _keyed_bitmap_png(asset)
            asset.setdefault("asset_index", asset.get("image_index", asset.get("sprite_index", 0)))
            if "pivot" in asset and "endpoint" in asset:
                start, end = asset["pivot"], asset["endpoint"]
                dx, dy = end["x"] - start["x"], end["y"] - start["y"]
                asset.setdefault("anchor_start", dict(start))
                asset.setdefault("anchor_end", dict(end))
                asset.setdefault("anchor_length", math.hypot(dx, dy))
                asset.setdefault("anchor_angle_rad", math.atan2(dy, dx))
        assets_to_normalize.extend(figure.get("image_assets", []))
    for asset in assets_to_normalize:
        if "data_uri" in asset:
            asset.setdefault("data_url", asset["data_uri"])
    report["validation"]["editable_field_count"] = len(report.get("_bindings", {}))
    return report

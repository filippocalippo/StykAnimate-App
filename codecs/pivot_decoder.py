#!/usr/bin/env python3
"""Decode Pivot figure files into a normalized JSON format.

Current support:
- Legacy `.stk` (uncompressed and compressed-legacy containers)
- V5 `.stk` containers (zlib payload)
  - `v5_line20` compact segment block decoder
  - `v5_line21_rgb` compact RGB segment block decoder
  - `v5_line23` segment block decoder for line-based figures
  - Embedded sprite extraction (PNG/JPEG)

This decoder is intentionally incremental. Some advanced V5 object types
(sprites/text side tables and uncommon metadata blocks) are not fully decoded yet.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PNG_SIG = b"\x89PNG\r\n\x1a\n"
PNG_END = b"IEND\xaeB`\x82"
JPG_SOI = b"\xff\xd8"
JPG_EOI = b"\xff\xd9"


def _json_float(value: float) -> float | None:
    v = float(value)
    return v if math.isfinite(v) else None


@dataclass
class Segment:
    segment_id: int
    parent_id: int
    length: float
    angle_rad: float
    thickness: float
    color_rgb: list[int]
    color_alpha: float = 1.0
    transparency: int = 0
    flags: int = 0
    segment_type: str = "line"
    segment_kind: str = "line"
    primitive_code: int = 0
    bend_rad: float = 0.0
    visible: bool = True
    valid: bool = True

    def as_dict(self) -> dict[str, Any]:
        set_bits = [i for i in range(16) if self.flags & (1 << i)]
        low = self.flags & 0x00FF
        high = (self.flags >> 8) & 0x00FF
        return {
            "segment_id": self.segment_id,
            "parent_id": self.parent_id,
            "length": _json_float(self.length),
            "angle_rad": _json_float(self.angle_rad),
            "thickness": _json_float(self.thickness),
            "color_rgb": self.color_rgb,
            "color_alpha": _json_float(self.color_alpha),
            "transparency": int(self.transparency),
            "flags": self.flags,
            "segment_type": self.segment_type,
            "segment_kind": self.segment_kind,
            "primitive_code": self.primitive_code,
            "bend_rad": _json_float(self.bend_rad),
            "end_tangent_rad": _json_float(self.angle_rad + self.bend_rad),
            "geometry_model": "circular_arc_by_tangent",
            "angle_reference": "start_tangent_rad",
            "length_reference": "arc_length",
            "bend_reference": "tangent_delta_rad",
            "visible": self.visible,
            "valid": self.valid,
            "flag_bits": {
                "is_circle": self.segment_type == "circle",
                "is_static": bool(self.flags & 0x0100),
                "low_byte": low,
                "high_byte": high,
                "set_bits": set_bits,
                "raw": self.flags,
            },
        }


@dataclass(frozen=True)
class DecodeOptions:
    mode: str = "fast"
    include_full_raw_hex: bool = False
    include_payload_hex: bool = False
    include_record_raw: bool = False
    include_tail_arrays: bool = False
    include_unknown_block_data: bool = False

    @staticmethod
    def from_mode(mode: str) -> "DecodeOptions":
        m = (mode or "fast").strip().lower()
        if m == "deep":
            return DecodeOptions(
                mode="deep",
                include_full_raw_hex=True,
                include_payload_hex=True,
                include_record_raw=True,
                include_tail_arrays=True,
                include_unknown_block_data=True,
            )
        return DecodeOptions(mode="fast")


def _segment_with_raw(
    seg: Segment,
    rec: bytes,
    rec_offset: int,
    layout: str,
    include_raw: bool = False,
) -> dict[str, Any]:
    out = seg.as_dict()
    out["source_layout"] = layout
    out["record_offset"] = rec_offset
    out["record_size"] = len(rec)
    if not include_raw:
        return out
    out["record_hex"] = rec.hex()
    out["record_u8"] = list(rec)
    out["record_i8"] = [
        int.from_bytes(rec[i : i + 1], "little", signed=True)
        for i in range(len(rec))
    ]
    out["record_u16_le"] = [
        int.from_bytes(rec[i : i + 2], "little")
        for i in range(0, len(rec) - 1, 2)
    ]
    out["record_i16_le"] = [
        int.from_bytes(rec[i : i + 2], "little", signed=True)
        for i in range(0, len(rec) - 1, 2)
    ]
    out["record_u32_le"] = [
        int.from_bytes(rec[i : i + 4], "little")
        for i in range(0, len(rec) - 3, 4)
    ]
    out["record_i32_le"] = [
        int.from_bytes(rec[i : i + 4], "little", signed=True)
        for i in range(0, len(rec) - 3, 4)
    ]
    out["record_f32_le"] = [
        _json_float(struct.unpack_from("<f", rec, i)[0])
        for i in range(0, len(rec) - 3, 4)
    ]
    out["record_f64_le"] = [
        _json_float(struct.unpack_from("<d", rec, i)[0])
        for i in range(0, len(rec) - 7, 8)
    ]
    return out


def _find_all(data: bytes, needle: bytes) -> list[int]:
    out: list[int] = []
    i = 0
    while True:
        j = data.find(needle, i)
        if j == -1:
            return out
        out.append(j)
        i = j + 1


def _parse_png_dimensions(blob: bytes) -> tuple[int, int] | None:
    if not blob.startswith(PNG_SIG) or len(blob) < 24:
        return None
    # IHDR starts after 8-byte signature + 4-byte length + 4-byte "IHDR"
    width = int.from_bytes(blob[16:20], "big")
    height = int.from_bytes(blob[20:24], "big")
    return width, height


def _extract_embedded_sprites(payload: bytes) -> list[dict[str, Any]]:
    sprites: list[dict[str, Any]] = []

    for idx, start in enumerate(_find_all(payload, PNG_SIG)):
        end_marker = payload.find(PNG_END, start)
        if end_marker == -1:
            continue
        end = end_marker + len(PNG_END)
        blob = payload[start:end]
        dims = _parse_png_dimensions(blob)
        sprite: dict[str, Any] = {
            "index": idx,
            "format": "png",
            "start": start,
            "end": end,
            "size_bytes": end - start,
            "name": f"sprite_{idx:03d}.png",
        }
        if dims:
            sprite["width"] = dims[0]
            sprite["height"] = dims[1]
        sprite["_bytes"] = blob
        sprites.append(sprite)

    ends = [i + 2 for i in _find_all(payload, JPG_EOI)]
    jpg_index = 0
    for start in _find_all(payload, JPG_SOI):
        end = next((x for x in ends if x > start), None)
        if end is None:
            continue
        blob = payload[start:end]
        if b"JFIF" not in blob[:64] and b"Exif" not in blob[:64]:
            continue
        sprite = {
            "index": jpg_index,
            "format": "jpg",
            "start": start,
            "end": end,
            "size_bytes": end - start,
            "name": f"sprite_{jpg_index:03d}.jpg",
            "_bytes": blob,
        }
        sprites.append(sprite)
        jpg_index += 1

    return sprites


def _write_sprites(
    sprites: list[dict[str, Any]], file_stem: str, assets_root: Path | None
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if assets_root is not None:
        target_dir = assets_root / file_stem
        target_dir.mkdir(parents=True, exist_ok=True)
    else:
        target_dir = None

    for sprite in sprites:
        item = {
            k: v
            for k, v in sprite.items()
            if k in {"index", "format", "start", "end", "size_bytes", "name", "width", "height"}
        }
        blob = sprite["_bytes"]
        if target_dir is not None:
            output_path = target_dir / sprite["name"]
            if output_path.exists():
                output_path = target_dir / f"{output_path.stem}_{sprite['index']:03d}{output_path.suffix}"
            output_path.write_bytes(blob)
            item["asset_path"] = str(output_path)
        out.append(item)

    return out


def _detect_draw_order_u16(tail_bytes: bytes, count: int) -> dict[str, Any] | None:
    if count <= 0 or len(tail_bytes) < count * 2:
        return None

    u16 = [
        int.from_bytes(tail_bytes[i : i + 2], "little")
        for i in range(0, len(tail_bytes) - 1, 2)
    ]
    if len(u16) < count:
        return None

    zero_based_target = set(range(count))
    one_based_target = set(range(1, count + 1))
    max_start = min(96, len(u16) - count)
    candidates: list[tuple[int, str, list[int]]] = []

    for start in range(max_start + 1):
        window = u16[start : start + count]
        window_set = set(window)
        if len(window_set) != count:
            continue

        if window_set == zero_based_target:
            candidates.append((start, "zero", [x + 1 for x in window]))
        elif window_set == one_based_target:
            candidates.append((start, "one", list(window)))

    if not candidates:
        return None

    # Prefer the latest full-permutation window in the tail.
    # If tied, prefer one-based indexing.
    start, base, draw = max(candidates, key=lambda x: (x[0], 1 if x[1] == "one" else 0))
    return {
        "index_base": base,
        "start_u16_index": start,
        "draw_order": draw,
    }


def _find_draw_order_windows_u16(
    tail_bytes: bytes, count: int, max_results: int = 12
) -> list[dict[str, Any]]:
    if count <= 0 or len(tail_bytes) < count * 2:
        return []

    u16 = [
        int.from_bytes(tail_bytes[i : i + 2], "little")
        for i in range(0, len(tail_bytes) - 1, 2)
    ]
    if len(u16) < count:
        return []

    zero_based_target = set(range(count))
    one_based_target = set(range(1, count + 1))
    out: list[dict[str, Any]] = []
    for start in range(0, len(u16) - count + 1):
        window = u16[start : start + count]
        window_set = set(window)
        if len(window_set) != count:
            continue
        if window_set == zero_based_target:
            out.append(
                {
                    "index_base": "zero",
                    "start_u16_index": start,
                    "draw_order_head": [x + 1 for x in window[:24]],
                }
            )
        elif window_set == one_based_target:
            out.append(
                {
                    "index_base": "one",
                    "start_u16_index": start,
                    "draw_order_head": window[:24],
                }
            )
        if len(out) >= max_results:
            break
    return out


def _detect_z_map_u16(tail_bytes: bytes, count: int) -> dict[str, Any] | None:
    """Detect contiguous per-segment z-order maps in u16 form."""

    if count <= 0 or len(tail_bytes) < count * 2:
        return None

    u16 = [
        int.from_bytes(tail_bytes[i : i + 2], "little")
        for i in range(0, len(tail_bytes) - 1, 2)
    ]
    if len(u16) < count:
        return None

    target_zero = set(range(count))
    target_one = set(range(1, count + 1))
    candidates: list[tuple[str, int, list[int]]] = []
    for start in range(0, len(u16) - count + 1):
        window = u16[start : start + count]
        values = set(window)
        if values == target_zero:
            candidates.append(("zero", start, window))
        elif values == target_one:
            candidates.append(("one", start, window))

    if not candidates:
        return None

    # Prefer the latest complete map in the tail.
    index_base, start, window = max(candidates, key=lambda x: x[1])
    if index_base == "zero":
        z_map = [int(v) + 1 for v in window]
        method = "zmap_zero_based_u16"
    else:
        z_map = [int(v) for v in window]
        method = "zmap_one_based_u16"

    order_pairs = [(seg_id + 1, z_map[seg_id]) for seg_id in range(count)]
    order_pairs.sort(key=lambda x: (x[1], x[0]))
    draw_order = [seg_id for seg_id, _ in order_pairs]

    return {
        "index_base": index_base,
        "start_u16_index": start,
        "draw_order": draw_order,
        "z_order_map": z_map,
        "method": method,
    }


def _detect_z_map_u16_hi_byte(tail_bytes: bytes, count: int) -> dict[str, Any] | None:
    """Detect z-maps encoded in the high byte of u16 values (e.g. 0x0300)."""

    if count <= 0 or len(tail_bytes) < count * 2:
        return None
    u16 = [
        int.from_bytes(tail_bytes[i : i + 2], "little")
        for i in range(0, len(tail_bytes) - 1, 2)
    ]
    if len(u16) < count:
        return None

    target_zero = set(range(count))
    target_one = set(range(1, count + 1))
    candidates: list[tuple[int, str, list[int]]] = []
    for start in range(0, len(u16) - count + 1):
        window = u16[start : start + count]
        if any((v & 0x00FF) != 0 for v in window):
            continue
        hi = [(v >> 8) & 0xFF for v in window]
        values = set(hi)
        if values == target_zero:
            candidates.append((start, "zero", [int(v) + 1 for v in hi]))
        elif values == target_one:
            candidates.append((start, "one", [int(v) for v in hi]))

    if not candidates:
        return None

    start, base, z_map = max(candidates, key=lambda x: x[0])
    order_pairs = [(seg_id + 1, z_map[seg_id]) for seg_id in range(count)]
    order_pairs.sort(key=lambda x: (x[1], x[0]))
    draw_order = [seg_id for seg_id, _ in order_pairs]
    return {
        "index_base": f"{base}_hi_byte",
        "start_u16_index": start,
        "draw_order": draw_order,
        "z_order_map": z_map,
        "method": "zmap_hi_byte_u16",
    }


def _detect_order_stream_ids_once_u16(tail_bytes: bytes, count: int) -> dict[str, Any] | None:
    """Extract strict draw order from mixed streams when ids appear exactly once."""

    if count <= 0 or len(tail_bytes) < 2:
        return None

    u16 = [
        int.from_bytes(tail_bytes[i : i + 2], "little")
        for i in range(0, len(tail_bytes) - 1, 2)
    ]
    if not u16:
        return None

    order = [v for v in u16 if 1 <= v <= count]
    if len(order) != count:
        return None
    if len(set(order)) != count:
        return None

    return {
        "index_base": "stream_ids_once",
        "start_u16_index": None,
        "draw_order": order,
        "coverage": 1.0,
        "method": "stream_ids_once_u16",
    }


def _detect_draw_order_first_appearance_u16(
    tail_bytes: bytes,
    count: int,
    min_coverage: float = 0.6,
) -> dict[str, Any] | None:
    if count <= 0 or len(tail_bytes) < 2:
        return None

    u16 = [
        int.from_bytes(tail_bytes[i : i + 2], "little")
        for i in range(0, len(tail_bytes) - 1, 2)
    ]
    if not u16:
        return None

    one_order: list[int] = []
    one_seen: set[int] = set()
    zero_order: list[int] = []
    zero_seen: set[int] = set()

    for raw in u16:
        if 1 <= raw <= count and raw not in one_seen:
            one_seen.add(raw)
            one_order.append(raw)
        if 0 <= raw < count and raw not in zero_seen:
            zero_seen.add(raw)
            zero_order.append(raw + 1)  # normalize to 1-based segment ids

    one_cov = len(one_order) / count
    zero_cov = len(zero_order) / count

    best: tuple[str, list[int], float] | None = None
    if one_cov >= min_coverage:
        best = ("one", one_order, one_cov)
    if zero_cov >= min_coverage and (best is None or zero_cov > best[2]):
        best = ("zero", zero_order, zero_cov)

    if best is None:
        return None

    return {
        "index_base": best[0],
        "draw_order": best[1],
        "coverage": best[2],
        "method": "first_appearance_u16",
    }


def _merge_ranges(ranges: list[tuple[int, int]], total_size: int) -> list[tuple[int, int]]:
    clipped: list[tuple[int, int]] = []
    for start, end in ranges:
        s = max(0, min(total_size, int(start)))
        e = max(0, min(total_size, int(end)))
        if e <= s:
            continue
        clipped.append((s, e))
    if not clipped:
        return []
    clipped.sort(key=lambda x: (x[0], x[1]))
    merged = [clipped[0]]
    for s, e in clipped[1:]:
        ls, le = merged[-1]
        if s <= le:
            merged[-1] = (ls, max(le, e))
        else:
            merged.append((s, e))
    return merged


def _complement_ranges(total_size: int, known: list[tuple[int, int]]) -> list[tuple[int, int]]:
    merged = _merge_ranges(known, total_size)
    out: list[tuple[int, int]] = []
    pos = 0
    for s, e in merged:
        if pos < s:
            out.append((pos, s))
        pos = e
    if pos < total_size:
        out.append((pos, total_size))
    return out


def _blob_dump(
    blob: bytes,
    start: int,
    end: int,
    include_content: bool = True,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "start": int(start),
        "end": int(end),
        "size": len(blob),
    }
    if include_content:
        out["hex"] = blob.hex()
        out["u8"] = list(blob)
        out["u16_le"] = [
            int.from_bytes(blob[i : i + 2], "little")
            for i in range(0, len(blob) - 1, 2)
        ]
        out["u32_le"] = [
            int.from_bytes(blob[i : i + 4], "little")
            for i in range(0, len(blob) - 3, 4)
        ]
    return out


def _segment_kind_from_flags(flags: int) -> str:
    # Observed in Pivot v5 binary strings: TSegmentKind =
    # line, circle, image, circleFill, circleClear, text, squareLine
    primitive = flags & 0x00FF
    return {
        0: "line",
        1: "circle",
        2: "image",
        3: "circleFill",
        4: "circleClear",
        5: "text",
        6: "squareLine",
    }.get(primitive, "line")


def _segment_type_from_flags(flags: int) -> str:
    kind = _segment_kind_from_flags(flags)
    if kind in {"circle", "circleFill", "circleClear"}:
        return "circle"
    if kind == "squareLine":
        return "line"
    if kind in {"image", "text"}:
        return kind
    return "line"


def _normalize_aff7f8_poly_ids(
    polyfills: list[dict[str, Any]],
    _segment_count: int,
) -> tuple[list[dict[str, Any]], str]:
    """Keep aff7f8 poly ids as-is.

    In aff7f8 files, `0` is used in practice as a root-joint reference.
    Treat ids as joint references (root + segment tips), not zero-based segment ids.
    """

    out: list[dict[str, Any]] = []
    saw_root = False
    for poly in polyfills:
        item = dict(poly)
        ids = [int(x) for x in poly.get("segment_ids") or []]
        item["segment_ids_raw"] = list(ids)
        item["vertex_id_space"] = "joint_tip_ids"
        if 0 in ids:
            saw_root = True
            item["segment_id_index_base"] = "joint_tip_ids_root0"
        else:
            item["segment_id_index_base"] = "joint_tip_ids_one"
        item["segment_ids"] = ids
        item["segment_id_normalization"] = "as_is"
        out.append(item)

    base_label = "joint_tip_ids_root0" if saw_root else "joint_tip_ids_one"
    return out, base_label


def _decode_segment_id_block(
    raw_ids: list[int], segment_count: int
) -> dict[str, Any] | None:
    """Decode id-base semantics without forcing an ambiguous interpretation."""

    one_ok = all(1 <= i <= segment_count for i in raw_ids)
    zero_ok = all(0 <= i < segment_count for i in raw_ids)
    if not one_ok and not zero_ok:
        return None

    out: dict[str, Any] = {
        "segment_ids_raw": [int(i) for i in raw_ids],
        "vertex_id_space": "segment_ids",
    }
    if one_ok and not zero_ok:
        out["segment_ids"] = [int(i) for i in raw_ids]
        out["segment_id_index_base"] = "one"
    elif zero_ok and not one_ok:
        out["segment_ids"] = [int(i) + 1 for i in raw_ids]
        out["segment_id_index_base"] = "zero"
    else:
        # Ambiguous blocks (all ids in 1..segment_count-1) are kept explicit.
        out["segment_ids"] = [int(i) for i in raw_ids]
        out["segment_id_index_base"] = "ambiguous"
        out["segment_ids_one_based"] = [int(i) for i in raw_ids]
        out["segment_ids_zero_based"] = [int(i) + 1 for i in raw_ids]
    return out


def _decode_v5_tail_metadata(
    tail: bytes, segment_count: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    """Decode optional bend/polyfill metadata ahead of draw-order tables.

    Returns:
    - bends: list[{"segment_id": int, "bend_rad": float}]
    - polyfills: list[{"segment_ids": list[int], "color_rgb": [r,g,b], "color_alpha": float}]
    - parse_end: byte offset in `tail` where metadata parsing ended
    """

    bends: list[dict[str, Any]] = []
    polyfills: list[dict[str, Any]] = []
    parse_end = 0

    if len(tail) < 4:
        return bends, polyfills, parse_end

    bend_count = int.from_bytes(tail[0:2], "little")
    poly_count = int.from_bytes(tail[2:4], "little")
    pos = 4

    if bend_count > segment_count or bend_count > 4096:
        return bends, polyfills, parse_end
    if pos + bend_count * 10 > len(tail):
        return bends, polyfills, parse_end

    for _ in range(bend_count):
        bend = struct.unpack_from("<d", tail, pos)[0]
        seg_id = struct.unpack_from("<H", tail, pos + 8)[0]
        if not math.isfinite(bend) or abs(bend) > 1000:
            return [], [], 0
        if seg_id < 1 or seg_id > segment_count:
            return [], [], 0
        bends.append({"segment_id": int(seg_id), "bend_rad": _json_float(bend)})
        pos += 10

    if poly_count <= 512:
        polys_ok = True
        for _ in range(poly_count):
            if pos + 6 > len(tail):
                polys_ok = False
                break
            seg_count = int.from_bytes(tail[pos : pos + 2], "little")
            pos += 2
            color_raw = int.from_bytes(tail[pos : pos + 4], "little")
            pos += 4
            if seg_count <= 0 or seg_count > segment_count:
                polys_ok = False
                break
            if pos + seg_count * 2 > len(tail):
                polys_ok = False
                break

            raw_ids = [
                int.from_bytes(tail[pos + i * 2 : pos + i * 2 + 2], "little")
                for i in range(seg_count)
            ]
            pos += seg_count * 2

            # Optional delimiter used by some files.
            if pos + 2 <= len(tail) and int.from_bytes(tail[pos : pos + 2], "little") == 0:
                pos += 2

            id_block = _decode_segment_id_block(raw_ids, segment_count)
            if id_block is None:
                polys_ok = False
                break

            r = (color_raw >> 0) & 0xFF
            g = (color_raw >> 8) & 0xFF
            b = (color_raw >> 16) & 0xFF
            a = (color_raw >> 24) & 0xFF
            alpha = max(0.0, min(1.0, (255.0 - float(a)) / 255.0))
            poly = dict(id_block)
            poly.update(
                {
                    "color_rgb": [r, g, b],
                    "color_alpha": alpha,
                }
            )
            polyfills.append(poly)

        if not polys_ok:
            polyfills = []
            pos = 4 + bend_count * 10

    parse_end = pos
    return bends, polyfills, parse_end


def _decode_v5_tail_batch_polyfills(
    tail: bytes, segment_count: int
) -> tuple[list[dict[str, Any]], int]:
    """Decode count+color+segment-id polyfill batches at the head of a tail block.

    Observed batch layout:
    - u16 segment_id_count
    - u32 color_rgba
    - u16[segment_id_count] segment_ids
    """

    polyfills: list[dict[str, Any]] = []
    pos = 0
    while pos + 6 <= len(tail):
        seg_count = int.from_bytes(tail[pos : pos + 2], "little")
        if seg_count <= 0 or seg_count > segment_count or seg_count > 4096:
            break
        need = 6 + seg_count * 2
        if pos + need > len(tail):
            break

        color_raw = int.from_bytes(tail[pos + 2 : pos + 6], "little")
        raw_ids = [
            int.from_bytes(tail[pos + 6 + i * 2 : pos + 8 + i * 2], "little")
            for i in range(seg_count)
        ]

        id_block = _decode_segment_id_block(raw_ids, segment_count)
        if id_block is None:
            break

        r = (color_raw >> 0) & 0xFF
        g = (color_raw >> 8) & 0xFF
        b = (color_raw >> 16) & 0xFF
        a = (color_raw >> 24) & 0xFF
        alpha = max(0.0, min(1.0, (255.0 - float(a)) / 255.0))
        poly = dict(id_block)
        poly.update(
            {
                "color_rgb": [r, g, b],
                "color_alpha": alpha,
                "source": "tail_batch",
            }
        )
        polyfills.append(poly)
        pos += need

    return polyfills, pos


def _decode_v5_aff7f8(payload: bytes, count_hint: int, options: DecodeOptions) -> dict[str, Any]:
    """Decode modern V5 stream parsed by Pivot's aff7f8 routine.

    Reverse-engineered from runtime traces:
    - header flags byte
    - u16 segment count
    - variable segment records controlled by header bits
    - bend table
    - polyfill records
    - per-object z map (segments + polyfills) or sequential map
    """

    out: dict[str, Any] = {
        "supported": False,
        "segments": [],
        "polyfills": [],
        "bends": [],
        "draw_order": [],
        "valid_count": 0,
        "offset": 3,
        "record_count": 0,
        "valid_ratio": 0.0,
        "notes": ["No valid v5_aff7f8 stream decoded"],
        "layout": "v5_aff7f8",
        "stride": 0,
        "records_start": 3,
        "records_end": 3,
        "flags_byte": None,
        "global_style": None,
    }

    if len(payload) < 3:
        out["notes"] = ["Payload too short for v5_aff7f8 header"]
        return out

    flags = int(payload[0])
    count = int.from_bytes(payload[1:3], "little")
    if count <= 0:
        out["notes"] = [f"Invalid segment count in v5_aff7f8 payload: {count}"]
        return out

    if count_hint > 0 and abs(count - count_hint) > 2:
        # Keep this parser strict so legacy/other variants can fallback cleanly.
        out["notes"] = [
            f"Count mismatch for v5_aff7f8 (header={count}, hint={count_hint})",
        ]
        return out

    bit = lambda b: (flags >> b) & 1
    # Primitive kinds that carry extra e2c/e2e/e2f payload.
    primitive_extra_mask = 0x24  # bits 2 and 5

    pos = 3

    def _need(n: int, label: str) -> None:
        nonlocal pos
        if pos + n > len(payload):
            raise ValueError(f"Unexpected EOF while reading {label} at {pos} (need {n})")

    segments_tmp: list[dict[str, Any]] = []
    has_primitive_2 = False
    has_primitive_5 = False

    try:
        for i in range(count):
            rec_start = pos
            _need(2, "segment.parent_id")
            parent_id = int.from_bytes(payload[pos : pos + 2], "little")
            pos += 2

            segment_id = i + 1
            if bit(5) == 0:
                _need(2, "segment.segment_id")
                segment_id = int.from_bytes(payload[pos : pos + 2], "little")
                pos += 2

            _need(4, "segment.length")
            length = struct.unpack_from("<f", payload, pos)[0]
            pos += 4
            _need(8, "segment.angle")
            angle = struct.unpack_from("<d", payload, pos)[0]
            pos += 8
            _need(4, "segment.thickness")
            thickness = struct.unpack_from("<f", payload, pos)[0]
            pos += 4

            primitive = 0
            if bit(0) == 0:
                _need(1, "segment.primitive")
                primitive = int(payload[pos])
                pos += 1

            aux_code = 0
            if bit(1) == 0:
                _need(1, "segment.aux_code")
                aux_code = int(payload[pos])
                pos += 1

            color_primary = [0, 0, 0]
            if bit(2) == 0:
                _need(3, "segment.color_primary")
                color_primary = [int(payload[pos]), int(payload[pos + 1]), int(payload[pos + 2])]
                pos += 3

            transparency = 0
            if bit(3) == 0:
                _need(1, "segment.transparency")
                transparency = int(payload[pos])
                pos += 1

            color_secondary = [255, 255, 255]
            alpha_secondary = 0
            if bit(7) == 0:
                _need(1, "segment.secondary_color_present")
                has_secondary = int(payload[pos])
                pos += 1
                if has_secondary:
                    _need(3, "segment.color_secondary")
                    color_secondary = [
                        int(payload[pos]),
                        int(payload[pos + 1]),
                        int(payload[pos + 2]),
                    ]
                    pos += 3
                    _need(1, "segment.alpha_secondary")
                    alpha_secondary = int(payload[pos])
                    pos += 1

            extra_u16 = 0
            extra_u8_a = 0
            extra_u8_b = 0
            if primitive <= 7 and ((primitive_extra_mask >> primitive) & 1):
                _need(4, "segment.primitive_extra")
                extra_u16 = int.from_bytes(payload[pos : pos + 2], "little")
                extra_u8_a = int(payload[pos + 2])
                extra_u8_b = int(payload[pos + 3])
                pos += 4
                if primitive == 2:
                    has_primitive_2 = True
                else:
                    has_primitive_5 = True

            rec_end = pos
            segments_tmp.append(
                {
                    "segment_id": int(segment_id),
                    "parent_id": int(parent_id),
                    "length": float(length),
                    "angle_rad": float(angle),
                    "thickness": float(thickness),
                    "primitive": int(primitive),
                    "aux_code": int(aux_code),
                    "color_primary": color_primary,
                    "transparency": int(transparency),
                    "color_secondary": color_secondary,
                    "alpha_secondary": int(alpha_secondary),
                    "extra_u16": int(extra_u16),
                    "extra_u8_a": int(extra_u8_a),
                    "extra_u8_b": int(extra_u8_b),
                    "record_offset": rec_start,
                    "record_end": rec_end,
                }
            )

        _need(2, "bend_count")
        bend_count = int.from_bytes(payload[pos : pos + 2], "little")
        pos += 2
        bends: list[dict[str, Any]] = []
        for _ in range(bend_count):
            _need(10, "bend_record")
            seg_index = int.from_bytes(payload[pos : pos + 2], "little")
            pos += 2
            bend_rad = float(struct.unpack_from("<d", payload, pos)[0])
            pos += 8
            bends.append({"segment_index": seg_index, "bend_rad": bend_rad})

        # Primitive 2/5 side-tables are complex object payloads (image/text).
        # They are rare in the target stick libraries and not needed for segment/poly z import.
        # Keep parser strict: if present, let fallback decoders handle these files.
        if has_primitive_2 or has_primitive_5:
            out["notes"] = [
                "v5_aff7f8 contains primitive 2/5 side tables; parser support is not implemented for these payloads yet",
            ]
            return out

        _need(2, "poly_count")
        poly_count = int.from_bytes(payload[pos : pos + 2], "little")
        pos += 2
        polyfills: list[dict[str, Any]] = []
        for _ in range(poly_count):
            _need(6, "poly_header")
            seg_count = int.from_bytes(payload[pos : pos + 2], "little")
            pos += 2
            rgb = [int(payload[pos]), int(payload[pos + 1]), int(payload[pos + 2])]
            pos += 3
            alpha_raw = int(payload[pos])
            pos += 1
            _need(seg_count * 2, "poly_segment_ids")
            ids = [
                int.from_bytes(payload[pos + j * 2 : pos + j * 2 + 2], "little")
                for j in range(seg_count)
            ]
            pos += seg_count * 2
            polyfills.append(
                {
                    "segment_ids": ids,
                    "segment_ids_raw": list(ids),
                    "segment_id_index_base": "one",
                    "vertex_id_space": "joint_tip_ids",
                    "color_rgb": rgb,
                    "color_alpha": max(0.0, min(1.0, 1.0 - (float(alpha_raw) / 255.0))),
                    "alpha_raw": alpha_raw,
                    "source": "aff7f8_poly",
                }
            )

        seg_z_raw: list[int] = []
        poly_z_raw: list[int] = []
        if bit(4) == 0:
            _need(count * 2, "segment_z_map")
            seg_z_raw = [
                int.from_bytes(payload[pos + i * 2 : pos + i * 2 + 2], "little")
                for i in range(count)
            ]
            pos += count * 2
            if poly_count > 0:
                _need(poly_count * 2, "poly_z_map")
                poly_z_raw = [
                    int.from_bytes(payload[pos + i * 2 : pos + i * 2 + 2], "little")
                    for i in range(poly_count)
                ]
                pos += poly_count * 2
        else:
            seg_z_raw = list(range(count))
            poly_z_raw = [count + i for i in range(poly_count)]

        global_style: dict[str, Any]
        if bit(6) != 0:
            _need(8, "global_style")
            style_u28 = int.from_bytes(payload[pos : pos + 4], "little")
            pos += 4
            style_rgb = [int(payload[pos]), int(payload[pos + 1]), int(payload[pos + 2])]
            pos += 3
            style_u30 = int(payload[pos])
            pos += 1
            global_style = {
                "u28": style_u28,
                "rgb": style_rgb,
                "u30": style_u30,
                "present": True,
            }
        else:
            global_style = {"u28": 0, "rgb": [255, 255, 255], "u30": 0, "present": False}

    except (ValueError, struct.error) as exc:
        out["notes"] = [f"v5_aff7f8 parse failed: {exc}"]
        return out

    if pos != len(payload):
        # Keep strict: if we do not consume full payload, layout might be different.
        out["notes"] = [
            f"v5_aff7f8 consumed {pos} of {len(payload)} payload bytes (remaining {len(payload) - pos})",
        ]
        return out

    bends_by_index = {int(b["segment_index"]): float(b["bend_rad"]) for b in bends}
    # Runtime trace parity (cow/sheep/basketball): aff7f8 bend keys are zero-based
    # segment record indexes (ParserSeg #N). Do not guess alternate key spaces.
    bend_key_mode = "index0"

    segments: list[dict[str, Any]] = []
    valid = 0
    for idx, item in enumerate(segments_tmp):
        primitive = int(item["primitive"])
        aux_code = int(item["aux_code"])
        flags_u16 = ((aux_code & 0xFF) << 8) | (primitive & 0xFF)
        transparency = int(item["transparency"])
        seg_id = int(item["segment_id"])
        bend_val = bends_by_index.get(idx, 0.0)
        seg = Segment(
            segment_id=seg_id,
            parent_id=int(item["parent_id"]),
            length=float(item["length"]),
            angle_rad=float(item["angle_rad"]),
            thickness=float(item["thickness"]),
            color_rgb=list(item["color_primary"]),
            color_alpha=max(0.0, min(1.0, 1.0 - (float(transparency) / 255.0))),
            transparency=transparency,
            flags=flags_u16,
            segment_type=_segment_type_from_flags(flags_u16),
            segment_kind=_segment_kind_from_flags(flags_u16),
            primitive_code=primitive,
            bend_rad=float(bend_val),
            visible=bool((item["thickness"] > 0.01) or primitive in {1, 3, 4, 6}),
            valid=True,
        )
        is_valid = _is_valid_v5_segment(seg, count + poly_count + 4)
        seg.valid = is_valid
        if not is_valid:
            seg.visible = False
        if is_valid:
            valid += 1

        rec_start = int(item["record_offset"])
        rec_end = int(item["record_end"])
        rec_blob = payload[rec_start:rec_end]
        seg_out = _segment_with_raw(
            seg,
            rec_blob,
            rec_start,
            "v5_aff7f8",
            include_raw=options.include_record_raw,
        )
        z_raw = int(seg_z_raw[idx]) if idx < len(seg_z_raw) else idx
        seg_out["z_order_runtime_raw"] = z_raw
        seg_out["z_order_map"] = z_raw + 1
        seg_out["z_order"] = z_raw + 1
        seg_out["z_order_source"] = "runtime_z2a"
        seg_out["aux_code"] = aux_code
        seg_out["bend_key_mode"] = bend_key_mode
        seg_out["color_secondary"] = list(item["color_secondary"])
        seg_out["alpha_secondary"] = int(item["alpha_secondary"])
        seg_out["extra_u16"] = int(item["extra_u16"])
        seg_out["extra_u8_a"] = int(item["extra_u8_a"])
        seg_out["extra_u8_b"] = int(item["extra_u8_b"])
        segments.append(seg_out)

    for i, poly in enumerate(polyfills, start=1):
        z_raw = int(poly_z_raw[i - 1]) if i - 1 < len(poly_z_raw) else (count + i - 1)
        poly["z_order_runtime_raw"] = z_raw
        poly["z_order"] = z_raw + 1
        poly["z_order_source"] = "runtime_z2a"
        poly["polyfill_id"] = i
        poly["object_slot"] = count + i

    polyfills, poly_id_base = _normalize_aff7f8_poly_ids(polyfills, count)

    for idx, seg in enumerate(segments, start=1):
        seg["object_slot"] = idx

    object_count = count + len(polyfills)
    object_z_map: list[int | None] = [None] * object_count
    for seg in segments:
        slot = int(seg.get("object_slot") or 0)
        if 1 <= slot <= object_count:
            object_z_map[slot - 1] = int(seg.get("z_order", 0))
    for poly in polyfills:
        slot = int(poly.get("object_slot") or 0)
        if 1 <= slot <= object_count:
            object_z_map[slot - 1] = int(poly.get("z_order", 0))

    object_draw_order: list[dict[str, Any]] = []
    for seg in segments:
        object_draw_order.append(
            {
                "object_slot": int(seg.get("object_slot") or 0),
                "object_type": "segment",
                "segment_id": int(seg.get("segment_id") or 0),
                "z_order_runtime_raw": int(seg.get("z_order_runtime_raw") or 0),
                "z_order": int(seg.get("z_order") or 0),
            }
        )
    for poly in polyfills:
        object_draw_order.append(
            {
                "object_slot": int(poly.get("object_slot") or 0),
                "object_type": "polyfill",
                "polyfill_id": int(poly.get("polyfill_id") or 0),
                "z_order_runtime_raw": int(poly.get("z_order_runtime_raw") or 0),
                "z_order": int(poly.get("z_order") or 0),
            }
        )
    object_draw_order.sort(
        key=lambda x: (
            int(x.get("z_order_runtime_raw") or 0),
            int(x.get("object_slot") or 0),
        )
    )

    draw_pairs = [
        (int(s["segment_id"]), int(s.get("z_order", i + 1)), i)
        for i, s in enumerate(segments)
    ]
    draw_pairs.sort(key=lambda x: (x[1], x[2], x[0]))
    draw_order = [seg_id for seg_id, _z, _i in draw_pairs]

    out.update(
        {
            "supported": True,
            "segments": segments,
            "polyfills": polyfills,
            "bends": bends,
            "draw_order": draw_order,
            "object_count": object_count,
            "object_count_source": "segments_plus_polyfills",
            "object_z_map": object_z_map,
            "object_draw_order": object_draw_order,
            "valid_count": valid,
            "record_count": count,
            "valid_ratio": (valid / count) if count > 0 else 0.0,
            "notes": [
                "Decoded using v5_aff7f8 runtime-compatible parser",
                f"flags=0x{flags:02x}, segments={count}, bends={len(bends)}, polyfills={len(polyfills)}, poly_id_base={poly_id_base}",
            ],
            "records_end": len(payload),
            "flags_byte": flags,
            "global_style": global_style,
            "bend_key_mode": bend_key_mode,
        }
    )
    return out


def _is_valid_v5_segment(seg: Segment, max_parent: int) -> bool:
    if not math.isfinite(seg.length) or not math.isfinite(seg.angle_rad) or not math.isfinite(seg.thickness):
        return False
    if seg.parent_id < 0 or seg.parent_id > max_parent:
        return False
    if seg.length < 0 or seg.length > 20000:
        return False
    if seg.thickness < -0.1 or seg.thickness > 5000:
        return False
    if abs(seg.angle_rad) > 20:
        return False
    return True


def _decode_v5_line23(payload: bytes, count_hint: int, options: DecodeOptions) -> dict[str, Any]:
    """Decode the V5 line-based 23-byte record block.

    Record layout (observed):
    - u16 parent_id
    - f32 length
    - f64 angle_rad
    - f32 thickness
    - u16 flags
    - u8 r
    - u8 g
    - u8 b
    """

    stride = 23
    best: dict[str, Any] = {
        "supported": False,
        "segments": [],
        "valid_count": 0,
        "offset": None,
        "record_count": 0,
        "valid_ratio": 0.0,
        "notes": ["No valid v5_line23 segment block found"],
        "layout": "v5_line23",
        "stride": stride,
    }

    if count_hint <= 0:
        best["notes"] = ["Invalid segment count hint in v5 payload"]
        return best

    max_offset = min(128, max(0, len(payload) - count_hint * stride))

    for offset in range(max_offset + 1):
        end = offset + count_hint * stride
        if end > len(payload):
            continue

        segments: list[dict[str, Any]] = []
        valid = 0
        for i in range(count_hint):
            rec = payload[offset + i * stride : offset + (i + 1) * stride]
            rec_offset = offset + i * stride
            parent_id = struct.unpack_from("<H", rec, 0)[0]
            length = struct.unpack_from("<f", rec, 2)[0]
            angle = struct.unpack_from("<d", rec, 6)[0]
            thickness = struct.unpack_from("<f", rec, 14)[0]
            flags = struct.unpack_from("<H", rec, 18)[0]
            color = [rec[20], rec[21], rec[22]]

            seg = Segment(
                segment_id=i + 1,
                parent_id=parent_id,
                length=length,
                angle_rad=angle,
                thickness=thickness,
                color_rgb=color,
                color_alpha=1.0,
                transparency=0,
                flags=flags,
                segment_type=_segment_type_from_flags(flags),
                segment_kind=_segment_kind_from_flags(flags),
                primitive_code=flags & 0x00FF,
                visible=thickness > 0.01,
            )
            is_valid = _is_valid_v5_segment(seg, count_hint)
            seg.valid = is_valid
            if not is_valid:
                seg.visible = False
            segments.append(
                _segment_with_raw(
                    seg,
                    rec,
                    rec_offset,
                    "v5_line23",
                    include_raw=options.include_record_raw,
                )
            )
            if is_valid:
                valid += 1

        ratio = valid / count_hint
        if ratio > best["valid_ratio"]:
            best = {
                "supported": ratio >= 0.75,
                "segments": segments,
                "valid_count": valid,
                "offset": offset,
                "record_count": count_hint,
                "valid_ratio": ratio,
                "notes": [],
                "layout": "v5_line23",
                "stride": stride,
            }

    if not best["supported"]:
        best["notes"] = [
            "V5 payload does not match the line23 layout strongly enough",
            f"Best validity ratio: {best['valid_ratio']:.3f}",
        ]
    else:
        best["notes"] = [
            "Decoded using v5_line23 segment layout",
            f"offset={best['offset']}, records={best['record_count']}, ratio={best['valid_ratio']:.3f}",
        ]

    return best


def _decode_v5_line23_prim_alpha(payload: bytes, count_hint: int, options: DecodeOptions) -> dict[str, Any]:
    """Decode V5 23-byte layout variant with explicit primitive + transparency bytes.

    Record layout (observed in some files):
    - u16 parent_id
    - f32 length
    - f64 angle_rad
    - f32 thickness
    - u8 primitive_code
    - u8 transparency (0=opaque, 255=fully transparent)
    - u8 r
    - u8 g
    - u8 b
    """

    stride = 23
    best: dict[str, Any] = {
        "supported": False,
        "segments": [],
        "valid_count": 0,
        "offset": None,
        "record_count": 0,
        "valid_ratio": 0.0,
        "notes": ["No valid v5_line23_prim_alpha segment block found"],
        "layout": "v5_line23_prim_alpha",
        "stride": stride,
    }

    if count_hint <= 0:
        best["notes"] = ["Invalid segment count hint in v5 payload"]
        return best

    max_offset = min(220, max(0, len(payload) - count_hint * stride))
    for offset in range(max_offset + 1):
        end = offset + count_hint * stride
        if end > len(payload):
            continue

        segments: list[dict[str, Any]] = []
        valid = 0
        for i in range(count_hint):
            rec = payload[offset + i * stride : offset + (i + 1) * stride]
            rec_offset = offset + i * stride
            parent_id = struct.unpack_from("<H", rec, 0)[0]
            length = struct.unpack_from("<f", rec, 2)[0]
            angle = struct.unpack_from("<d", rec, 6)[0]
            thickness = struct.unpack_from("<f", rec, 14)[0]
            primitive = int(rec[18])
            transparency = int(rec[19])
            r, g, b = int(rec[20]), int(rec[21]), int(rec[22])
            alpha = max(0.0, min(1.0, 1.0 - (float(transparency) / 255.0)))
            flags = primitive

            seg = Segment(
                segment_id=i + 1,
                parent_id=parent_id,
                length=length,
                angle_rad=angle,
                thickness=thickness,
                color_rgb=[r, g, b],
                color_alpha=alpha,
                transparency=transparency,
                flags=flags,
                segment_type=_segment_type_from_flags(flags),
                segment_kind=_segment_kind_from_flags(flags),
                primitive_code=primitive,
                visible=thickness > 0.01,
            )
            is_valid = _is_valid_v5_segment(seg, count_hint) and 0 <= primitive <= 16
            seg.valid = is_valid
            if not is_valid:
                seg.visible = False
            segments.append(
                _segment_with_raw(
                    seg,
                    rec,
                    rec_offset,
                    "v5_line23_prim_alpha",
                    include_raw=options.include_record_raw,
                )
            )
            if is_valid:
                valid += 1

        ratio = valid / count_hint
        if ratio > best["valid_ratio"]:
            best = {
                "supported": ratio >= 0.75,
                "segments": segments,
                "valid_count": valid,
                "offset": offset,
                "record_count": count_hint,
                "valid_ratio": ratio,
                "notes": [],
                "layout": "v5_line23_prim_alpha",
                "stride": stride,
            }

    if not best["supported"]:
        best["notes"] = [
            "V5 payload does not match the line23_prim_alpha layout strongly enough",
            f"Best validity ratio: {best['valid_ratio']:.3f}",
        ]
    else:
        best["notes"] = [
            "Decoded using v5_line23_prim_alpha segment layout",
            f"offset={best['offset']}, records={best['record_count']}, ratio={best['valid_ratio']:.3f}",
        ]

    return best


def _decode_v5_line22(payload: bytes, count_hint: int, options: DecodeOptions) -> dict[str, Any]:
    """Decode V5 22-byte layout variant.

    Record layout (observed):
    - u16 parent_id
    - f32 length
    - f64 angle_rad
    - f32 thickness
    - u8 primitive_code
    - u8 r
    - u8 g
    - u8 b
    """

    stride = 22
    best: dict[str, Any] = {
        "supported": False,
        "segments": [],
        "valid_count": 0,
        "offset": None,
        "record_count": 0,
        "valid_ratio": 0.0,
        "notes": ["No valid v5_line22 segment block found"],
        "layout": "v5_line22",
        "stride": stride,
    }

    if count_hint <= 0:
        best["notes"] = ["Invalid segment count hint in v5 payload"]
        return best

    max_offset = min(220, max(0, len(payload) - count_hint * stride))
    for offset in range(max_offset + 1):
        end = offset + count_hint * stride
        if end > len(payload):
            continue

        segments: list[dict[str, Any]] = []
        valid = 0
        for i in range(count_hint):
            rec = payload[offset + i * stride : offset + (i + 1) * stride]
            rec_offset = offset + i * stride
            parent_id = struct.unpack_from("<H", rec, 0)[0]
            length = struct.unpack_from("<f", rec, 2)[0]
            angle = struct.unpack_from("<d", rec, 6)[0]
            thickness = struct.unpack_from("<f", rec, 14)[0]
            primitive = int(rec[18])
            r, g, b = int(rec[19]), int(rec[20]), int(rec[21])
            flags = primitive
            seg = Segment(
                segment_id=i + 1,
                parent_id=parent_id,
                length=length,
                angle_rad=angle,
                thickness=thickness,
                color_rgb=[r, g, b],
                color_alpha=1.0,
                transparency=0,
                flags=flags,
                segment_type=_segment_type_from_flags(flags),
                segment_kind=_segment_kind_from_flags(flags),
                primitive_code=primitive,
                visible=thickness > 0.01,
            )
            is_valid = _is_valid_v5_segment(seg, count_hint) and 0 <= primitive <= 16
            seg.valid = is_valid
            if not is_valid:
                seg.visible = False
            segments.append(
                _segment_with_raw(
                    seg,
                    rec,
                    rec_offset,
                    "v5_line22",
                    include_raw=options.include_record_raw,
                )
            )
            if is_valid:
                valid += 1

        ratio = valid / count_hint
        if ratio > best["valid_ratio"]:
            best = {
                "supported": ratio >= 0.75,
                "segments": segments,
                "valid_count": valid,
                "offset": offset,
                "record_count": count_hint,
                "valid_ratio": ratio,
                "notes": [],
                "layout": "v5_line22",
                "stride": stride,
            }

    if not best["supported"]:
        best["notes"] = [
            "V5 payload does not match the line22 layout strongly enough",
            f"Best validity ratio: {best['valid_ratio']:.3f}",
        ]
    else:
        best["notes"] = [
            "Decoded using v5_line22 segment layout",
            f"offset={best['offset']}, records={best['record_count']}, ratio={best['valid_ratio']:.3f}",
        ]
    return best


def _decode_v5_line24(payload: bytes, count_hint: int, options: DecodeOptions) -> dict[str, Any]:
    """Decode alternate V5 24-byte record layout.

    Record layout (observed in many modern files):
    - u16 parent_id
    - f32 length
    - f64 angle_rad
    - f32 thickness
    - u16 flags
    - u32 color (R,G,B,A where A often behaves like inverse opacity)
    """

    stride = 24
    best: dict[str, Any] = {
        "supported": False,
        "segments": [],
        "valid_count": 0,
        "offset": None,
        "record_count": 0,
        "valid_ratio": 0.0,
        "notes": ["No valid v5_line24 segment block found"],
        "layout": "v5_line24",
        "stride": stride,
    }

    if count_hint <= 0:
        best["notes"] = ["Invalid segment count hint in v5 payload"]
        return best

    max_offset = min(220, max(0, len(payload) - count_hint * stride))
    for offset in range(max_offset + 1):
        end = offset + count_hint * stride
        if end > len(payload):
            continue

        segments: list[dict[str, Any]] = []
        valid = 0
        for i in range(count_hint):
            rec = payload[offset + i * stride : offset + (i + 1) * stride]
            rec_offset = offset + i * stride
            parent_id = struct.unpack_from("<H", rec, 0)[0]
            length = struct.unpack_from("<f", rec, 2)[0]
            angle = struct.unpack_from("<d", rec, 6)[0]
            thickness = struct.unpack_from("<f", rec, 14)[0]
            flags = struct.unpack_from("<H", rec, 18)[0]
            r, g, b, a = rec[20], rec[21], rec[22], rec[23]
            # Pivot stores transparency (0=opaque, 255=fully transparent).
            alpha = max(0.0, min(1.0, 1.0 - (float(a) / 255.0)))
            visible = bool(thickness > 0.01)

            seg = Segment(
                segment_id=i + 1,
                parent_id=parent_id,
                length=length,
                angle_rad=angle,
                thickness=thickness,
                color_rgb=[r, g, b],
                color_alpha=alpha,
                transparency=int(a),
                flags=flags,
                segment_type=_segment_type_from_flags(flags),
                segment_kind=_segment_kind_from_flags(flags),
                primitive_code=flags & 0x00FF,
                visible=visible,
            )
            is_valid = _is_valid_v5_segment(seg, count_hint)
            seg.valid = is_valid
            if not is_valid:
                seg.visible = False
            segments.append(
                _segment_with_raw(
                    seg,
                    rec,
                    rec_offset,
                    "v5_line24",
                    include_raw=options.include_record_raw,
                )
            )
            if is_valid:
                valid += 1

        ratio = valid / count_hint
        if ratio > best["valid_ratio"]:
            best = {
                "supported": ratio >= 0.75,
                "segments": segments,
                "valid_count": valid,
                "offset": offset,
                "record_count": count_hint,
                "valid_ratio": ratio,
                "notes": [],
                "layout": "v5_line24",
                "stride": stride,
            }

    if not best["supported"]:
        best["notes"] = [
            "V5 payload does not match the line24 layout strongly enough",
            f"Best validity ratio: {best['valid_ratio']:.3f}",
        ]
    else:
        best["notes"] = [
            "Decoded using v5_line24 segment layout",
            f"offset={best['offset']}, records={best['record_count']}, ratio={best['valid_ratio']:.3f}",
        ]

    return best


def _decode_v5_line25_with_ids(payload: bytes, count_hint: int, options: DecodeOptions) -> dict[str, Any]:
    """Decode V5 25-byte layout with explicit segment ids.

    Record layout:
    - u16 parent_id
    - u16 segment_id (explicit id, usually a permutation of 1..N)
    - f32 length
    - f64 angle_rad
    - f32 thickness
    - u16 flags
    - u8 r
    - u8 g
    - u8 b
    """

    stride = 25
    best: dict[str, Any] = {
        "supported": False,
        "segments": [],
        "valid_count": 0,
        "offset": None,
        "record_count": 0,
        "valid_ratio": 0.0,
        "notes": ["No valid v5_line25_ids segment block found"],
        "layout": "v5_line25_ids",
        "stride": stride,
    }

    if count_hint <= 0:
        best["notes"] = ["Invalid segment count hint in v5 payload"]
        return best

    max_offset = min(220, max(0, len(payload) - count_hint * stride))
    for offset in range(max_offset + 1):
        end = offset + count_hint * stride
        if end > len(payload):
            continue

        ids: list[int] = []
        segments: list[dict[str, Any]] = []
        valid = 0
        for i in range(count_hint):
            rec = payload[offset + i * stride : offset + (i + 1) * stride]
            rec_offset = offset + i * stride
            parent_id = struct.unpack_from("<H", rec, 0)[0]
            segment_id = struct.unpack_from("<H", rec, 2)[0]
            length = struct.unpack_from("<f", rec, 4)[0]
            angle = struct.unpack_from("<d", rec, 8)[0]
            thickness = struct.unpack_from("<f", rec, 16)[0]
            flags = struct.unpack_from("<H", rec, 20)[0]
            color = [rec[22], rec[23], rec[24]]

            ids.append(segment_id)
            has_color = (color[0] + color[1] + color[2]) > 15
            visible = bool(thickness > 0.01 or ((flags & 0x0100) and has_color))

            seg = Segment(
                segment_id=segment_id,
                parent_id=parent_id,
                length=length,
                angle_rad=angle,
                thickness=thickness,
                color_rgb=color,
                color_alpha=1.0,
                transparency=0,
                flags=flags,
                segment_type=_segment_type_from_flags(flags),
                segment_kind=_segment_kind_from_flags(flags),
                primitive_code=flags & 0x00FF,
                visible=visible,
            )
            is_valid = _is_valid_v5_segment(seg, count_hint)
            seg.valid = is_valid
            if not is_valid:
                seg.visible = False
            segments.append(
                _segment_with_raw(
                    seg,
                    rec,
                    rec_offset,
                    "v5_line25_ids",
                    include_raw=options.include_record_raw,
                )
            )
            if is_valid:
                valid += 1

        ratio = valid / count_hint
        ids_unique = len(set(ids)) == count_hint
        ids_in_range = ids and min(ids) >= 1 and max(ids) <= count_hint
        id_perm_boost = 1 if (ids_unique and ids_in_range) else 0

        current_score = (1 if best["supported"] else 0, best["valid_count"], best["valid_ratio"])
        new_score = (1 if (ratio >= 0.75 and id_perm_boost) else 0, valid, ratio)
        # Prefer candidates with explicit-id permutation signal, then ratio.
        if (new_score > current_score) or (ratio > best["valid_ratio"] and not best["supported"]):
            best = {
                "supported": bool(ratio >= 0.75 and id_perm_boost),
                "segments": segments,
                "valid_count": valid,
                "offset": offset,
                "record_count": count_hint,
                "valid_ratio": ratio,
                "notes": [],
                "layout": "v5_line25_ids",
                "stride": stride,
                "id_permutation": bool(ids_unique and ids_in_range),
            }

    if not best["supported"]:
        best["notes"] = [
            "V5 payload does not match the line25-id layout strongly enough",
            f"Best validity ratio: {best['valid_ratio']:.3f}",
        ]
    else:
        best["notes"] = [
            "Decoded using v5_line25_ids segment layout",
            f"offset={best['offset']}, records={best['record_count']}, ratio={best['valid_ratio']:.3f}",
        ]

    return best


def _decode_v5_line20(payload: bytes, count_hint: int, options: DecodeOptions) -> dict[str, Any]:
    """Decode compact V5 20-byte record layout.

    Record layout:
    - u16 parent_id
    - f32 length
    - f64 angle_rad
    - f32 thickness
    - u16 flags

    This layout is used by some smaller modern figures where color/style
    metadata is stored in tail sections.
    """

    stride = 20
    best: dict[str, Any] = {
        "supported": False,
        "segments": [],
        "valid_count": 0,
        "offset": None,
        "record_count": 0,
        "valid_ratio": 0.0,
        "notes": ["No valid v5_line20 segment block found"],
        "layout": "v5_line20",
        "stride": stride,
    }

    if count_hint <= 0:
        best["notes"] = ["Invalid segment count hint in v5 payload"]
        return best

    max_offset = min(220, max(0, len(payload) - count_hint * stride))
    for offset in range(max_offset + 1):
        end = offset + count_hint * stride
        if end > len(payload):
            continue

        segments: list[dict[str, Any]] = []
        valid = 0
        for i in range(count_hint):
            rec = payload[offset + i * stride : offset + (i + 1) * stride]
            rec_offset = offset + i * stride
            parent_id = struct.unpack_from("<H", rec, 0)[0]
            length = struct.unpack_from("<f", rec, 2)[0]
            angle = struct.unpack_from("<d", rec, 6)[0]
            thickness = struct.unpack_from("<f", rec, 14)[0]
            flags = struct.unpack_from("<H", rec, 18)[0]

            seg = Segment(
                segment_id=i + 1,
                parent_id=parent_id,
                length=length,
                angle_rad=angle,
                thickness=thickness,
                color_rgb=[0, 0, 0],
                color_alpha=1.0,
                transparency=0,
                flags=flags,
                segment_type=_segment_type_from_flags(flags),
                segment_kind=_segment_kind_from_flags(flags),
                primitive_code=flags & 0x00FF,
                visible=thickness > 0.01,
            )
            is_valid = _is_valid_v5_segment(seg, count_hint)
            seg.valid = is_valid
            if not is_valid:
                seg.visible = False
            segments.append(
                _segment_with_raw(
                    seg,
                    rec,
                    rec_offset,
                    "v5_line20",
                    include_raw=options.include_record_raw,
                )
            )
            if is_valid:
                valid += 1

        ratio = valid / count_hint
        if ratio > best["valid_ratio"]:
            best = {
                "supported": ratio >= 0.75,
                "segments": segments,
                "valid_count": valid,
                "offset": offset,
                "record_count": count_hint,
                "valid_ratio": ratio,
                "notes": [],
                "layout": "v5_line20",
                "stride": stride,
            }

    if not best["supported"]:
        best["notes"] = [
            "V5 payload does not match the line20 layout strongly enough",
            f"Best validity ratio: {best['valid_ratio']:.3f}",
        ]
    else:
        best["notes"] = [
            "Decoded using v5_line20 segment layout",
            f"offset={best['offset']}, records={best['record_count']}, ratio={best['valid_ratio']:.3f}",
        ]

    return best


def _decode_v5_line21_rgb(payload: bytes, count_hint: int, options: DecodeOptions) -> dict[str, Any]:
    """Decode compact V5 21-byte record layout with inline RGB.

    Record layout:
    - u16 parent_id
    - f32 length
    - f64 angle_rad
    - f32 thickness
    - u8 r
    - u8 g
    - u8 b
    """

    stride = 21
    best: dict[str, Any] = {
        "supported": False,
        "segments": [],
        "valid_count": 0,
        "offset": None,
        "record_count": 0,
        "valid_ratio": 0.0,
        "notes": ["No valid v5_line21_rgb segment block found"],
        "layout": "v5_line21_rgb",
        "stride": stride,
    }

    if count_hint <= 0:
        best["notes"] = ["Invalid segment count hint in v5 payload"]
        return best

    max_offset = min(220, max(0, len(payload) - count_hint * stride))
    for offset in range(max_offset + 1):
        end = offset + count_hint * stride
        if end > len(payload):
            continue

        segments: list[dict[str, Any]] = []
        valid = 0
        for i in range(count_hint):
            rec = payload[offset + i * stride : offset + (i + 1) * stride]
            rec_offset = offset + i * stride
            parent_id = struct.unpack_from("<H", rec, 0)[0]
            length = struct.unpack_from("<f", rec, 2)[0]
            angle = struct.unpack_from("<d", rec, 6)[0]
            thickness = struct.unpack_from("<f", rec, 14)[0]
            r, g, b = rec[18], rec[19], rec[20]

            seg = Segment(
                segment_id=i + 1,
                parent_id=parent_id,
                length=length,
                angle_rad=angle,
                thickness=thickness,
                color_rgb=[r, g, b],
                color_alpha=1.0,
                transparency=0,
                flags=0,
                segment_type="line",
                segment_kind="line",
                primitive_code=0,
                visible=thickness > 0.01,
            )
            is_valid = _is_valid_v5_segment(seg, count_hint)
            seg.valid = is_valid
            if not is_valid:
                seg.visible = False
            segments.append(
                _segment_with_raw(
                    seg,
                    rec,
                    rec_offset,
                    "v5_line21_rgb",
                    include_raw=options.include_record_raw,
                )
            )
            if is_valid:
                valid += 1

        ratio = valid / count_hint
        if ratio > best["valid_ratio"]:
            best = {
                "supported": ratio >= 0.75,
                "segments": segments,
                "valid_count": valid,
                "offset": offset,
                "record_count": count_hint,
                "valid_ratio": ratio,
                "notes": [],
                "layout": "v5_line21_rgb",
                "stride": stride,
            }

    if not best["supported"]:
        best["notes"] = [
            "V5 payload does not match the line21_rgb layout strongly enough",
            f"Best validity ratio: {best['valid_ratio']:.3f}",
        ]
    else:
        best["notes"] = [
            "Decoded using v5_line21_rgb segment layout",
            f"offset={best['offset']}, records={best['record_count']}, ratio={best['valid_ratio']:.3f}",
        ]

    return best


def _parse_legacy_payload(payload: bytes, options: DecodeOptions) -> dict[str, Any] | None:
    # Layout A: [version:1][count:1][records...]
    if len(payload) >= 2 and len(payload) == 2 + payload[1] * 24:
        version = payload[0]
        count = payload[1]
        base = 2
        layout = "version_and_count"
    # Layout B: [count:1][records...]
    elif len(payload) >= 1 and len(payload) == 1 + payload[0] * 24:
        version = None
        count = payload[0]
        base = 1
        layout = "count_only"
    else:
        return None

    segments: list[dict[str, Any]] = []
    for i in range(count):
        rec = payload[base + i * 24 : base + (i + 1) * 24]
        parent_id, segment_id, flags = struct.unpack_from("<BBH", rec, 0)
        length = struct.unpack_from("<f", rec, 4)[0]
        angle = struct.unpack_from("<d", rec, 8)[0]
        thickness = struct.unpack_from("<f", rec, 16)[0]
        style_raw = struct.unpack_from("<I", rec, 20)[0]

        low = int(flags) & 0x00FF
        high = (int(flags) >> 8) & 0x00FF
        seg: dict[str, Any] = {
            "segment_id": int(segment_id),
            "parent_id": int(parent_id),
            "length": _json_float(length),
            "angle_rad": _json_float(angle),
            "thickness": _json_float(thickness),
            "color_rgb": [0, 0, 0],
            "color_alpha": 1.0,
            "transparency": 0,
            "flags": int(flags),
            "style_raw": int(style_raw),
            "segment_type": "circle" if (style_raw & 0x01) else "line",
            "segment_kind": "circle" if (style_raw & 0x01) else "line",
            "primitive_code": int(style_raw) & 0x00FF,
            "z_order": i + 1,
            "visible": thickness > 0.01,
            "valid": True,
            "flag_bits": {
                "is_circle": bool(style_raw & 0x01),
                "is_static": bool(flags & 0x0100),
                "low_byte": low,
                "high_byte": high,
                "set_bits": [b for b in range(16) if int(flags) & (1 << b)],
                "raw": int(flags),
            },
            "source_layout": "legacy_24",
            "record_offset": base + i * 24,
            "record_size": len(rec),
        }
        if options.include_record_raw:
            seg["record_hex"] = rec.hex()
            seg["record_u8"] = list(rec)
            seg["record_i8"] = [
                int.from_bytes(rec[j : j + 1], "little", signed=True)
                for j in range(len(rec))
            ]
            seg["record_u16_le"] = [
                int.from_bytes(rec[j : j + 2], "little")
                for j in range(0, len(rec) - 1, 2)
            ]
            seg["record_i16_le"] = [
                int.from_bytes(rec[j : j + 2], "little", signed=True)
                for j in range(0, len(rec) - 1, 2)
            ]
            seg["record_u32_le"] = [
                int.from_bytes(rec[j : j + 4], "little")
                for j in range(0, len(rec) - 3, 4)
            ]
            seg["record_i32_le"] = [
                int.from_bytes(rec[j : j + 4], "little", signed=True)
                for j in range(0, len(rec) - 3, 4)
            ]
            seg["record_f32_le"] = [
                _json_float(struct.unpack_from("<f", rec, j)[0])
                for j in range(0, len(rec) - 3, 4)
            ]
            seg["record_f64_le"] = [
                _json_float(struct.unpack_from("<d", rec, j)[0])
                for j in range(0, len(rec) - 7, 8)
            ]
        segments.append(seg)

    return {
        "format": "legacy_stk",
        "legacy_layout": layout,
        "version_byte": version,
        "segment_count": count,
        "segments": segments,
        "notes": ["Decoded using legacy 24-byte segment records"],
    }


def decode_stk_file(
    path: Path,
    assets_root: Path | None = None,
    options: DecodeOptions | None = None,
) -> dict[str, Any]:
    if options is None:
        options = DecodeOptions.from_mode("fast")
    raw = path.read_bytes()
    report: dict[str, Any] = {
        "source_path": str(path),
        "source_size": len(raw),
        "file_type": "stk",
        "decode_status": "unsupported",
        "segments": [],
        "sprites": [],
        "notes": [],
    }
    if options.include_full_raw_hex:
        report["raw_bytes_hex"] = raw.hex()

    # Compressed containers start with marker byte 0x79 or 0x7A followed by zlib 0x78.
    if len(raw) > 2 and raw[1] == 0x78 and raw[0] in (0x79, 0x7A):
        marker = raw[0]
        payload = zlib.decompress(raw[1:])

        # Some compressed files still use legacy payload layout.
        legacy = _parse_legacy_payload(payload, options)
        if legacy is not None:
            report.update(
                {
                    "format": legacy["format"],
                    "decode_status": "decoded",
                    "container": "compressed_legacy",
                    "compression_marker": marker,
                    "payload_size": len(payload),
                    "segment_count": legacy["segment_count"],
                    "segments": legacy["segments"],
                    "notes": legacy["notes"] + [f"compression_marker=0x{marker:02x}"],
                }
            )
            if options.include_payload_hex:
                report["payload_bytes_hex"] = payload.hex()
            return report

        count_hint = int.from_bytes(payload[1:3], "little") if len(payload) >= 3 else 0
        line_aff7f8 = _decode_v5_aff7f8(payload, count_hint, options)
        line20 = _decode_v5_line20(payload, count_hint, options)
        line21 = _decode_v5_line21_rgb(payload, count_hint, options)
        line22 = _decode_v5_line22(payload, count_hint, options)
        line23 = _decode_v5_line23(payload, count_hint, options)
        line23_pa = _decode_v5_line23_prim_alpha(payload, count_hint, options)
        line24 = _decode_v5_line24(payload, count_hint, options)
        line25 = _decode_v5_line25_with_ids(payload, count_hint, options)
        sprites = _extract_embedded_sprites(payload)
        sprites_written = _write_sprites(sprites, path.stem, assets_root)

        # Preferred path: runtime-compatible aff7f8 stream parser.
        # This matches Pivot's own decode routine for modern payloads and
        # includes exact parent/id fields, polyfills, and z maps.
        if line_aff7f8["supported"]:
            best_layout = line_aff7f8
            segments = list(best_layout["segments"])
            polyfills = list(best_layout.get("polyfills") or [])
            bends = list(best_layout.get("bends") or [])
            draw_order = list(best_layout.get("draw_order") or [])
            records_start = int(best_layout.get("records_start") or 0)
            records_end = int(best_layout.get("records_end") or len(payload))
            payload_head = payload[:records_start]
            payload_tail = payload[records_end:]
            if options.include_unknown_block_data:
                header_u8 = list(payload_head)
                header_u16 = [
                    int.from_bytes(payload_head[i : i + 2], "little")
                    for i in range(0, len(payload_head) - 1, 2)
                ]
                header_hex = payload_head.hex()
            else:
                header_preview = payload_head[:32]
                header_u8 = list(header_preview)
                header_u16 = [
                    int.from_bytes(header_preview[i : i + 2], "little")
                    for i in range(0, len(header_preview) - 1, 2)
                ]
                header_hex = header_preview[:64].hex()

            report.update(
                {
                    "format": "v5_stk",
                    "decode_status": "decoded",
                    "container": "v5_compressed",
                    "compression_marker": marker,
                    "payload_size": len(payload),
                    "segment_count_hint": count_hint,
                    "segment_decode": {
                        "layout": best_layout["layout"],
                        "supported": True,
                        "offset": best_layout.get("offset"),
                        "stride": best_layout.get("stride"),
                        "records_start": records_start,
                        "records_end": records_end,
                        "record_count": best_layout.get("record_count"),
                        "valid_count": best_layout.get("valid_count"),
                        "valid_ratio": best_layout.get("valid_ratio"),
                        "v5_header_tag": int(payload_head[0]) if len(payload_head) >= 1 else None,
                        "v5_header_segment_count": int.from_bytes(payload_head[1:3], "little")
                        if len(payload_head) >= 3
                        else None,
                        "v5_header_size": len(payload_head),
                        "v5_header_u8": header_u8,
                        "v5_header_u16": header_u16,
                        "v5_header_hex": header_hex,
                        "v5_flags_byte": best_layout.get("flags_byte"),
                        "bend_key_mode": best_layout.get("bend_key_mode"),
                        "global_style": best_layout.get("global_style"),
                        "alternatives": {
                            "v5_aff7f8": {
                                "valid_ratio": best_layout.get("valid_ratio"),
                                "valid_count": best_layout.get("valid_count"),
                                "offset": best_layout.get("offset"),
                            },
                            "v5_line23": {
                                "valid_ratio": line23["valid_ratio"],
                                "valid_count": line23["valid_count"],
                                "offset": line23["offset"],
                            },
                            "v5_line23_prim_alpha": {
                                "valid_ratio": line23_pa["valid_ratio"],
                                "valid_count": line23_pa["valid_count"],
                                "offset": line23_pa["offset"],
                            },
                            "v5_line20": {
                                "valid_ratio": line20["valid_ratio"],
                                "valid_count": line20["valid_count"],
                                "offset": line20["offset"],
                            },
                            "v5_line21_rgb": {
                                "valid_ratio": line21["valid_ratio"],
                                "valid_count": line21["valid_count"],
                                "offset": line21["offset"],
                            },
                            "v5_line22": {
                                "valid_ratio": line22["valid_ratio"],
                                "valid_count": line22["valid_count"],
                                "offset": line22["offset"],
                            },
                            "v5_line24": {
                                "valid_ratio": line24["valid_ratio"],
                                "valid_count": line24["valid_count"],
                                "offset": line24["offset"],
                            },
                            "v5_line25_ids": {
                                "valid_ratio": line25["valid_ratio"],
                                "valid_count": line25["valid_count"],
                                "offset": line25["offset"],
                            },
                        },
                        "draw_order_index_base": "runtime_zero_based_map",
                        "draw_order_tail_start_u16": None,
                        "draw_order_scope": "runtime_aff7f8",
                        "draw_order_tail_start_byte": None,
                        "draw_order_tail_end_byte": None,
                        "draw_order_method": "runtime_aff7f8_z2a",
                        "draw_order_coverage": 1.0,
                        "object_draw_order_method": "runtime_aff7f8_objects",
                        "object_draw_order_scope": "runtime_aff7f8",
                        "object_draw_order_index_base": "runtime_zero_based_map",
                        "object_draw_order_count": int(best_layout.get("object_count") or (len(segments) + len(polyfills))),
                        "object_count": int(best_layout.get("object_count") or (len(segments) + len(polyfills))),
                        "object_count_source": str(best_layout.get("object_count_source") or "segments_plus_polyfills"),
                        "draw_order_interpretation_default": "map",
                        "draw_order_interpretation_candidates": ["map"],
                        "draw_order_exact": True,
                        "tail_metadata": {
                            "bend_count": len(bends),
                            "polyfill_count": len(polyfills),
                            "batch_polyfill_count": 0,
                            "parse_end": records_end,
                            "batch_parse_end": 0,
                            "draw_order_tail_size": 0,
                        },
                    },
                    "segments": segments,
                    "draw_order": draw_order,
                    "object_count": int(best_layout.get("object_count") or (len(segments) + len(polyfills))),
                    "object_draw_order": list(best_layout.get("object_draw_order") or []),
                    "object_z_map": list(best_layout.get("object_z_map") or []),
                    "draw_order_windows": [],
                    "bends": bends,
                    "polyfills": polyfills,
                    "sprites": sprites_written,
                    "notes": best_layout["notes"],
                    "tail_u16_sample": [],
                    "binary_map": {
                        "payload_size": len(payload),
                        "records_start": records_start,
                        "records_end": records_end,
                        "header": _blob_dump(
                            payload_head,
                            0,
                            records_start,
                            include_content=options.include_unknown_block_data,
                        ),
                        "records": {
                            "start": records_start,
                            "end": records_end,
                            "size": max(0, records_end - records_start),
                        },
                        "tail": _blob_dump(
                            payload_tail,
                            records_end,
                            len(payload),
                            include_content=options.include_unknown_block_data,
                        ),
                        "tail_known_ranges": [],
                        "tail_unknown_ranges": [],
                        "tail_unknown_blocks": [],
                        "payload_unknown_ranges": [],
                        "payload_unknown_blocks": [],
                    },
                }
            )
            if options.include_payload_hex:
                report["payload_bytes_hex"] = payload.hex()
            if options.include_tail_arrays:
                report["tail_bytes_hex"] = ""
                report["tail_u8"] = []
                report["tail_u16"] = []
                report["tail_u32"] = []
            return report

        # Pick the better v5 decoder candidate.
        layout_candidates = [line20, line21, line22, line23, line23_pa, line24, line25]
        best_layout = max(
            layout_candidates,
            key=lambda x: (1 if x["supported"] else 0, x["valid_count"], x["valid_ratio"]),
        )
        end = None
        tail = b""
        tail_u16_sample: list[int] = []
        tail_u8: list[int] = []
        tail_u16: list[int] = []
        tail_u32: list[int] = []
        draw_order_info = None
        draw_order_scope: str | None = None
        draw_order_method: str | None = None
        object_order_info = None
        object_order_scope: str | None = None
        object_order_method: str | None = None
        draw_order_windows: list[dict[str, Any]] = []
        bends: list[dict[str, Any]] = []
        polyfills: list[dict[str, Any]] = []
        tail_batch_polyfills: list[dict[str, Any]] = []
        parse_end = 0
        tail_batch_parse_end = 0
        draw_order_tail = b""
        if best_layout["offset"] is not None:
            end = best_layout["offset"] + best_layout["record_count"] * best_layout["stride"]
            tail = payload[end:]
            tail_u8 = list(tail)
            tail_u16 = [
                int.from_bytes(tail[i : i + 2], "little")
                for i in range(0, len(tail) - 1, 2)
            ]
            tail_u32 = [
                int.from_bytes(tail[i : i + 4], "little")
                for i in range(0, len(tail) - 3, 4)
            ]
            tail_u16_sample = [
                int.from_bytes(tail[i : i + 2], "little")
                for i in range(0, min(120, len(tail) - 1), 2)
            ]
            bends, polyfills, parse_end = _decode_v5_tail_metadata(tail, best_layout["record_count"])
            draw_order_tail = tail[parse_end:] if parse_end < len(tail) else tail
            def _pick_order(blob: bytes, scope_name: str) -> tuple[dict[str, Any] | None, str | None]:
                info = _detect_draw_order_u16(blob, best_layout["record_count"])
                if info is not None:
                    return info, "full_permutation_u16"
                info = _detect_z_map_u16(blob, best_layout["record_count"])
                if info is not None:
                    return info, str(info.get("method") or "zmap_u16")
                info = _detect_z_map_u16_hi_byte(blob, best_layout["record_count"])
                if info is not None:
                    return info, str(info.get("method") or "zmap_hi_byte_u16")
                info = _detect_order_stream_ids_once_u16(blob, best_layout["record_count"])
                if info is not None:
                    return info, str(info.get("method") or "stream_ids_once_u16")
                return None, None

            draw_order_info, draw_order_method = _pick_order(draw_order_tail, "draw_order_tail")
            if draw_order_info is not None:
                draw_order_scope = "draw_order_tail"
            if draw_order_info is None:
                draw_order_info, draw_order_method = _pick_order(tail, "tail")
                if draw_order_info is not None:
                    draw_order_scope = "tail"
            # Modern files may prefix draw tails with batch polyfill commands.
            # Decode these first, then try draw-order extraction on the remainder.
            if draw_order_info is None and len(draw_order_tail) >= 6:
                tail_batch_polyfills, tail_batch_parse_end = _decode_v5_tail_batch_polyfills(
                    draw_order_tail, best_layout["record_count"]
                )
                if tail_batch_polyfills and tail_batch_parse_end > 0:
                    polyfills.extend(tail_batch_polyfills)
                    rem = draw_order_tail[tail_batch_parse_end:]
                    rem_info, rem_method = _pick_order(rem, "draw_order_tail_batch_remainder")
                    if rem_info is not None:
                        draw_order_info = rem_info
                        draw_order_scope = "draw_order_tail_batch_remainder"
                        draw_order_method = rem_method
            draw_order_windows = _find_draw_order_windows_u16(tail, best_layout["record_count"])

            # Some modern files store a unified z-map for segments + polyfills.
            # Try to decode a full permutation for total drawable objects.
            total_objects = best_layout["record_count"] + len(polyfills)
            if total_objects > best_layout["record_count"]:
                rem = draw_order_tail[tail_batch_parse_end:] if tail_batch_parse_end > 0 else draw_order_tail
                object_candidates: list[tuple[str, bytes]] = [
                    ("draw_order_tail_batch_remainder", rem),
                    ("draw_order_tail", draw_order_tail),
                    ("tail", tail),
                ]
                for scope_name, blob in object_candidates:
                    info = _detect_draw_order_u16(blob, total_objects)
                    if info is None:
                        continue
                    object_order_info = info
                    object_order_scope = scope_name
                    object_order_method = "full_permutation_u16_objects"
                    break

        if polyfills:
            for idx, poly in enumerate(polyfills, start=1):
                poly["polyfill_id"] = idx

        records_start = int(best_layout["offset"] or 0)
        records_end = int(end or records_start)
        payload_head = payload[:records_start]
        payload_tail = payload[records_end:]
        if options.include_unknown_block_data:
            header_u8 = list(payload_head)
            header_u16 = [
                int.from_bytes(payload_head[i : i + 2], "little")
                for i in range(0, len(payload_head) - 1, 2)
            ]
            header_hex = payload_head.hex()
        else:
            header_preview = payload_head[:32]
            header_u8 = list(header_preview)
            header_u16 = [
                int.from_bytes(header_preview[i : i + 2], "little")
                for i in range(0, len(header_preview) - 1, 2)
            ]
            header_hex = header_preview[:64].hex()

        draw_order_start_tail_byte: int | None = None
        draw_order_end_tail_byte: int | None = None
        tail_known_ranges: list[tuple[int, int]] = []
        if parse_end > 0:
            tail_known_ranges.append((0, parse_end))
        if tail_batch_parse_end > 0:
            tail_known_ranges.append((parse_end, parse_end + tail_batch_parse_end))
        if draw_order_info is not None and draw_order_info.get("start_u16_index") is not None:
            start_bytes = int(draw_order_info["start_u16_index"]) * 2
            if draw_order_scope == "draw_order_tail":
                start_bytes += parse_end
            elif draw_order_scope == "draw_order_tail_batch_remainder":
                start_bytes += parse_end + tail_batch_parse_end
            draw_order_start_tail_byte = start_bytes
            draw_order_end_tail_byte = start_bytes + (best_layout["record_count"] * 2)
            tail_known_ranges.append((draw_order_start_tail_byte, draw_order_end_tail_byte))
        tail_known_ranges = _merge_ranges(tail_known_ranges, len(tail))
        tail_unknown_ranges = _complement_ranges(len(tail), tail_known_ranges)
        tail_unknown_blocks = [
            _blob_dump(
                tail[s:e],
                s,
                e,
                include_content=options.include_unknown_block_data,
            )
            for (s, e) in tail_unknown_ranges
        ]

        payload_unknown_ranges: list[tuple[int, int]] = []
        if records_start > 0:
            payload_unknown_ranges.append((0, records_start))
        for s, e in tail_unknown_ranges:
            payload_unknown_ranges.append((records_end + s, records_end + e))
        payload_unknown_ranges = _merge_ranges(payload_unknown_ranges, len(payload))
        payload_unknown_blocks = [
            _blob_dump(
                payload[s:e],
                s,
                e,
                include_content=options.include_unknown_block_data,
            )
            for (s, e) in payload_unknown_ranges
        ]

        if bends and best_layout["segments"]:
            by_id = {int(s["segment_id"]): s for s in best_layout["segments"]}
            for item in bends:
                seg = by_id.get(int(item["segment_id"]))
                if seg is not None:
                    seg["bend_rad"] = float(item["bend_rad"])

        # Compute concrete per-segment z-order variants for rendering/debugging.
        if best_layout["segments"]:
            by_id = {int(s["segment_id"]): s for s in best_layout["segments"]}
            seg_count = int(best_layout["record_count"])
            has_tail_perm = bool(draw_order_info and draw_order_info.get("draw_order"))
            tail_perm = list(draw_order_info["draw_order"]) if has_tail_perm else []
            explicit_map = (
                list(draw_order_info.get("z_order_map"))
                if draw_order_info and isinstance(draw_order_info.get("z_order_map"), list)
                else []
            )
            tail_is_full_perm = bool(draw_order_method == "full_permutation_u16")
            tail_is_map = bool(draw_order_method in {"zmap_zero_based_u16", "zmap_one_based_u16"})
            object_map_perm = (
                list(object_order_info.get("draw_order"))
                if object_order_info and isinstance(object_order_info.get("draw_order"), list)
                else []
            )
            has_object_map = bool(
                object_order_method == "full_permutation_u16_objects"
                and len(object_map_perm) >= (seg_count + len(polyfills))
            )

            # Variant A: treat tail values as a draw sequence of segment ids.
            if has_tail_perm:
                z_next = 1
                for seg_id in tail_perm:
                    seg = by_id.get(int(seg_id))
                    if seg is None:
                        continue
                    seg["z_order_sequence"] = z_next
                    z_next += 1
                for seg in best_layout["segments"]:
                    if "z_order_sequence" not in seg:
                        seg["z_order_sequence"] = z_next
                        z_next += 1
            else:
                for i, seg in enumerate(best_layout["segments"], start=1):
                    seg["z_order_sequence"] = i

            # Variant B: per-segment z-map, when explicitly decoded.
            if explicit_map and len(explicit_map) >= best_layout["record_count"]:
                for idx, z_val in enumerate(explicit_map[: best_layout["record_count"]], start=1):
                    seg = by_id.get(idx)
                    if seg is not None:
                        seg["z_order_map"] = int(z_val)
                for i, seg in enumerate(best_layout["segments"], start=1):
                    if "z_order_map" not in seg:
                        seg["z_order_map"] = int(seg.get("z_order_sequence", i))
            # For full permutations without explicit map payload, use record-index mapping.
            elif has_tail_perm and tail_is_full_perm:
                map_assigned = set()
                for idx, z_val in enumerate(tail_perm, start=1):
                    if not (1 <= int(z_val) <= best_layout["record_count"]):
                        continue
                    seg = by_id.get(idx)
                    if seg is not None:
                        seg["z_order_map"] = int(z_val)
                        map_assigned.add(int(seg["segment_id"]))
                for idx, seg in enumerate(best_layout["segments"], start=1):
                    seg_id = int(seg["segment_id"])
                    if seg_id in map_assigned:
                        continue
                    if 1 <= idx <= len(tail_perm):
                        seg["z_order_map"] = int(tail_perm[idx - 1])
                    else:
                        seg["z_order_map"] = int(seg.get("z_order_sequence", idx))
            else:
                for i, seg in enumerate(best_layout["segments"], start=1):
                    seg["z_order_map"] = int(seg.get("z_order_sequence", i))

            # Variant C: unified object z-map (segments + polyfills).
            if has_object_map:
                total = seg_count + len(polyfills)
                for obj_idx in range(1, min(total, len(object_map_perm)) + 1):
                    z_val = int(object_map_perm[obj_idx - 1])
                    if obj_idx <= seg_count:
                        seg = by_id.get(obj_idx)
                        if seg is not None:
                            seg["z_order_map"] = z_val
                    else:
                        poly_idx = obj_idx - seg_count
                        if 1 <= poly_idx <= len(polyfills):
                            polyfills[poly_idx - 1]["z_order"] = z_val
                            polyfills[poly_idx - 1]["z_order_source"] = "tail_object_map"

            # Default render z-order: prefer map interpretation for map/permutation methods.
            if has_object_map:
                for seg in best_layout["segments"]:
                    seg["z_order"] = int(seg.get("z_order_map", seg.get("z_order_sequence", 0)))
                    seg["z_order_source"] = "tail_object_map"
            elif has_tail_perm and (tail_is_full_perm or tail_is_map):
                for seg in best_layout["segments"]:
                    seg["z_order"] = int(seg.get("z_order_map", seg.get("z_order_sequence", 0)))
                    seg["z_order_source"] = "tail_map"
            else:
                for seg in best_layout["segments"]:
                    seg["z_order"] = int(seg.get("z_order_sequence", 0))
                    seg["z_order_source"] = "tail_sequence" if has_tail_perm else "record_fallback"

        report.update(
            {
                "format": "v5_stk",
                "decode_status": "decoded" if best_layout["supported"] else "partial",
                "container": "v5_compressed",
                "compression_marker": marker,
                "payload_size": len(payload),
                "segment_count_hint": count_hint,
                "segment_decode": {
                    "layout": best_layout["layout"],
                    "supported": best_layout["supported"],
                    "offset": best_layout["offset"],
                    "stride": best_layout["stride"],
                    "records_start": records_start,
                    "records_end": records_end,
                    "record_count": best_layout["record_count"],
                    "valid_count": best_layout["valid_count"],
                    "valid_ratio": best_layout["valid_ratio"],
                    "v5_header_tag": int(payload_head[0]) if len(payload_head) >= 1 else None,
                    "v5_header_segment_count": int.from_bytes(payload_head[1:3], "little")
                    if len(payload_head) >= 3
                    else None,
                    "v5_header_size": len(payload_head),
                    "v5_header_u8": header_u8,
                    "v5_header_u16": header_u16,
                    "v5_header_hex": header_hex,
                    "alternatives": {
                        "v5_line23": {
                            "valid_ratio": line23["valid_ratio"],
                            "valid_count": line23["valid_count"],
                            "offset": line23["offset"],
                        },
                        "v5_line23_prim_alpha": {
                            "valid_ratio": line23_pa["valid_ratio"],
                            "valid_count": line23_pa["valid_count"],
                            "offset": line23_pa["offset"],
                        },
                        "v5_line20": {
                            "valid_ratio": line20["valid_ratio"],
                            "valid_count": line20["valid_count"],
                            "offset": line20["offset"],
                        },
                        "v5_line21_rgb": {
                            "valid_ratio": line21["valid_ratio"],
                            "valid_count": line21["valid_count"],
                            "offset": line21["offset"],
                        },
                        "v5_line22": {
                            "valid_ratio": line22["valid_ratio"],
                            "valid_count": line22["valid_count"],
                            "offset": line22["offset"],
                        },
                        "v5_line24": {
                            "valid_ratio": line24["valid_ratio"],
                            "valid_count": line24["valid_count"],
                            "offset": line24["offset"],
                        },
                        "v5_line25_ids": {
                            "valid_ratio": line25["valid_ratio"],
                            "valid_count": line25["valid_count"],
                            "offset": line25["offset"],
                        },
                    },
                },
                "segments": best_layout["segments"],
                "draw_order": draw_order_info["draw_order"] if draw_order_info else [],
                "draw_order_windows": draw_order_windows,
                "bends": bends,
                "polyfills": polyfills,
                "sprites": sprites_written,
                "notes": best_layout["notes"],
                "tail_u16_sample": tail_u16_sample,
                "binary_map": {
                    "payload_size": len(payload),
                    "records_start": records_start,
                    "records_end": records_end,
                    "header": _blob_dump(
                        payload_head,
                        0,
                        records_start,
                        include_content=options.include_unknown_block_data,
                    ),
                    "records": {
                        "start": records_start,
                        "end": records_end,
                        "size": max(0, records_end - records_start),
                    },
                    "tail": _blob_dump(
                        payload_tail,
                        records_end,
                        len(payload),
                        include_content=options.include_unknown_block_data,
                    ),
                    "tail_known_ranges": [
                        {"start": s, "end": e, "size": e - s}
                        for (s, e) in tail_known_ranges
                    ],
                    "tail_unknown_ranges": [
                        {"start": s, "end": e, "size": e - s}
                        for (s, e) in tail_unknown_ranges
                    ],
                    "tail_unknown_blocks": tail_unknown_blocks,
                    "payload_unknown_ranges": [
                        {"start": s, "end": e, "size": e - s}
                        for (s, e) in payload_unknown_ranges
                    ],
                    "payload_unknown_blocks": payload_unknown_blocks,
                },
            }
        )
        if options.include_payload_hex:
            report["payload_bytes_hex"] = payload.hex()
        if options.include_tail_arrays:
            report["tail_bytes_hex"] = tail.hex()
            report["tail_u8"] = tail_u8
            report["tail_u16"] = tail_u16
            report["tail_u32"] = tail_u32
        if draw_order_info or object_order_info:
            if draw_order_info:
                report["segment_decode"]["draw_order_index_base"] = draw_order_info["index_base"]
                report["segment_decode"]["draw_order_tail_start_u16"] = draw_order_info.get("start_u16_index")
                report["segment_decode"]["draw_order_scope"] = draw_order_scope
                report["segment_decode"]["draw_order_tail_start_byte"] = draw_order_start_tail_byte
                report["segment_decode"]["draw_order_tail_end_byte"] = draw_order_end_tail_byte
                report["segment_decode"]["draw_order_method"] = draw_order_method
                report["segment_decode"]["draw_order_coverage"] = draw_order_info.get("coverage")
            else:
                report["segment_decode"]["draw_order_index_base"] = None
                report["segment_decode"]["draw_order_tail_start_u16"] = None
                report["segment_decode"]["draw_order_scope"] = None
                report["segment_decode"]["draw_order_tail_start_byte"] = None
                report["segment_decode"]["draw_order_tail_end_byte"] = None
                report["segment_decode"]["draw_order_method"] = None
                report["segment_decode"]["draw_order_coverage"] = None

            if object_order_info:
                report["segment_decode"]["object_draw_order_method"] = object_order_method
                report["segment_decode"]["object_draw_order_scope"] = object_order_scope
                report["segment_decode"]["object_draw_order_index_base"] = object_order_info.get("index_base")
                report["segment_decode"]["object_draw_order_count"] = len(
                    object_order_info.get("draw_order") or []
                )
            else:
                report["segment_decode"]["object_draw_order_method"] = None
                report["segment_decode"]["object_draw_order_scope"] = None
                report["segment_decode"]["object_draw_order_index_base"] = None
                report["segment_decode"]["object_draw_order_count"] = 0

            if object_order_method == "full_permutation_u16_objects":
                report["segment_decode"]["draw_order_interpretation_default"] = "map"
                report["segment_decode"]["draw_order_interpretation_candidates"] = ["map"]
                report["segment_decode"]["draw_order_exact"] = True
            elif draw_order_method in {"full_permutation_u16", "zmap_zero_based_u16", "zmap_one_based_u16"}:
                report["segment_decode"]["draw_order_interpretation_default"] = "map"
                report["segment_decode"]["draw_order_interpretation_candidates"] = ["sequence", "map"]
                report["segment_decode"]["draw_order_exact"] = bool(
                    draw_order_method
                    in {
                        "full_permutation_u16",
                        "zmap_zero_based_u16",
                        "zmap_one_based_u16",
                        "zmap_hi_byte_u16",
                        "stream_ids_once_u16",
                    }
                )
            else:
                report["segment_decode"]["draw_order_interpretation_default"] = "sequence"
                report["segment_decode"]["draw_order_interpretation_candidates"] = ["sequence"]
                report["segment_decode"]["draw_order_exact"] = bool(
                    draw_order_method
                    in {
                        "full_permutation_u16",
                        "zmap_zero_based_u16",
                        "zmap_one_based_u16",
                        "zmap_hi_byte_u16",
                        "stream_ids_once_u16",
                    }
                )
        else:
            report["segment_decode"]["draw_order_index_base"] = None
            report["segment_decode"]["draw_order_tail_start_u16"] = None
            report["segment_decode"]["draw_order_scope"] = None
            report["segment_decode"]["draw_order_tail_start_byte"] = None
            report["segment_decode"]["draw_order_tail_end_byte"] = None
            report["segment_decode"]["draw_order_method"] = None
            report["segment_decode"]["draw_order_coverage"] = None
            report["segment_decode"]["object_draw_order_method"] = None
            report["segment_decode"]["object_draw_order_scope"] = None
            report["segment_decode"]["object_draw_order_index_base"] = None
            report["segment_decode"]["object_draw_order_count"] = 0
            report["segment_decode"]["draw_order_interpretation_default"] = "record"
            report["segment_decode"]["draw_order_interpretation_candidates"] = ["record"]
            report["segment_decode"]["draw_order_exact"] = False
        report["segment_decode"]["tail_metadata"] = {
            "bend_count": len(bends),
            "polyfill_count": len(polyfills),
            "batch_polyfill_count": len(tail_batch_polyfills),
            "parse_end": parse_end,
            "batch_parse_end": tail_batch_parse_end,
            "draw_order_tail_size": len(draw_order_tail),
        }
        if options.include_tail_arrays:
            report["segment_decode"]["draw_order_tail_hex"] = draw_order_tail.hex()

        if sprites_written and not best_layout["supported"]:
            report["notes"].append("Sprites were extracted even though geometry is partial")

        return report

    # Plain legacy `.stk`
    legacy = _parse_legacy_payload(raw, options)
    if legacy is not None:
        report.update(
            {
                "format": legacy["format"],
                "decode_status": "decoded",
                "container": "plain",
                "segment_count": legacy["segment_count"],
                "segments": legacy["segments"],
                "notes": legacy["notes"],
            }
        )
        if options.include_payload_hex:
            report["payload_bytes_hex"] = raw.hex()
        return report

    report["notes"] = ["Unrecognized .stk layout"]
    return report


def _scan_files(input_path: Path) -> list[Path]:
    if input_path.is_file():
        return [input_path]

    out: list[Path] = []
    for ext in ("*.stk",):
        out.extend(input_path.rglob(ext))
    return sorted(p for p in out if p.is_file())


def main() -> int:
    parser = argparse.ArgumentParser(description="Decode Pivot files to JSON")
    parser.add_argument("input", type=Path, help="Input .stk file or directory")
    parser.add_argument("--out", type=Path, required=True, help="Output JSON report path")
    parser.add_argument(
        "--assets",
        type=Path,
        help="Directory where embedded sprite assets are written",
    )
    parser.add_argument(
        "--mode",
        choices=["fast", "deep"],
        default="fast",
        help="Decode output mode: fast (small report) or deep (full raw reverse-engineering data)",
    )
    args = parser.parse_args()
    options = DecodeOptions.from_mode(args.mode)

    files = _scan_files(args.input)
    if not files:
        raise SystemExit(f"No supported files found under: {args.input}")

    decoded: list[dict[str, Any]] = []
    for f in files:
        try:
            decoded.append(decode_stk_file(f, assets_root=args.assets, options=options))
        except Exception as exc:
            decoded.append(
                {
                    "source_path": str(f),
                    "source_size": f.stat().st_size,
                    "file_type": "stk",
                    "decode_status": "error",
                    "error": str(exc),
                }
            )

    summary = {
        "total_files": len(decoded),
        "decoded": sum(1 for d in decoded if d.get("decode_status") == "decoded"),
        "partial": sum(1 for d in decoded if d.get("decode_status") == "partial"),
        "unsupported": sum(1 for d in decoded if d.get("decode_status") == "unsupported"),
        "errors": sum(1 for d in decoded if d.get("decode_status") == "error"),
        "total_segments": sum(len(d.get("segments", [])) for d in decoded),
        "total_sprites": sum(len(d.get("sprites", [])) for d in decoded),
    }

    report = {
        "schema_version": 1,
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "input": str(args.input),
        "mode": options.mode,
        "summary": summary,
        "files": decoded,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(json.dumps(summary, indent=2))
    print(f"Wrote decoder report: {args.out}")
    print(f"Mode: {options.mode}")
    if args.assets:
        print(f"Asset output root: {args.assets}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Private, file-based codec transport for the native StykAnimate application.

Only import/export uses Python. Evaluation, rendering, editing, and playback
remain native C++. No server, network access, or original-file writes occur.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
import zlib

WORKSPACE = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(WORKSPACE / "tools"))
from piv_codec import PivError, Reader, MAX_SEGMENTS, _builtin_man, _figure, decode_piv_bytes
from piv_full_writer import encode_piv_project
from piv_migrate import migrate_legacy_bytes
from pivot_decoder import DecodeOptions, decode_stk_file

MAX_SOURCE = 256 * 1024 * 1024
MAX_DOCUMENT = 512 * 1024 * 1024
META = "_stykSource"


def read_bounded(path: Path, limit: int) -> bytes:
    if not path.is_file():
        raise PivError(f"File does not exist: {path}")
    if path.stat().st_size > limit:
        raise PivError(f"File exceeds the {limit // (1024 * 1024)} MiB size limit")
    with path.open("rb") as stream:
        result = stream.read(limit + 1)
    if len(result) > limit:
        raise PivError("File grew past the size limit while reading")
    return result


def atomic_write(path: Path, data: bytes, *, staging: bool = False) -> None:
    """Replace only the explicitly requested destination, after complete output."""
    if staging:
        # The native parent reserved this same-directory staging file and alone
        # commits it. Direct writing lets forced cancellation remove every byte
        # without leaving an additional unknown temporary filename behind.
        fd, temporary = os.open(path, os.O_WRONLY | os.O_TRUNC | getattr(os, "O_BINARY", 0)), None
    else:
        fd, temporary = tempfile.mkstemp(prefix=".styk-write-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if temporary is not None:
            os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def atomic_json(path: Path, value: object, *, staging: bool = False) -> None:
    if staging:
        fd, temporary = os.open(path, os.O_WRONLY | os.O_TRUNC | getattr(os, "O_BINARY", 0)), None
    else:
        fd, temporary = tempfile.mkstemp(prefix=".styk-json-", dir=path.parent)
    try:
        written = 0
        with os.fdopen(fd, "wb") as stream:
            for part in json.JSONEncoder(ensure_ascii=True, allow_nan=False, separators=(",", ":")).iterencode(value):
                blob = part.encode("ascii")
                written += len(blob)
                if written > MAX_DOCUMENT:
                    raise PivError("Decoded document exceeds the 512 MiB transport limit")
                stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        if temporary is not None:
            os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def document_digest(document: dict) -> str:
    semantic = {k: v for k, v in document.items() if k not in (META, "_styk")}
    # CPython's C encoder is much faster than walking every token in Python.
    # The transport is bounded and this transient buffer dies before export.
    encoded = json.dumps(semantic, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("ascii")).hexdigest()


def attach_source(document: dict, source: bytes, path: Path, kind: str) -> dict:
    # Bindings and JSON-pointer inventories are an old scalar-editor index;
    # native edits use the complete document writer and do not need them.
    document.pop("editable_paths", None)
    document.pop("_codec", None)
    document[META] = {"kind": kind, "version": document.get("version"),
        "source_base64": base64.b64encode(source).decode("ascii"),
        "sha256": hashlib.sha256(source).hexdigest(), "original_path": str(path.resolve()),
        "document_sha256": document_digest(document)}
    document["_styk"] = {"format": "StykAnimate", "format_version": 1}
    return document


def inflate_stk(source: bytes) -> bytes | None:
    if len(source) < 3 or source[0] not in (0x79, 0x7a) or source[1] != 0x78:
        return None
    inflater = zlib.decompressobj()
    payload = inflater.decompress(source[1:], MAX_SOURCE + 1)
    if len(payload) > MAX_SOURCE or inflater.unconsumed_tail:
        raise PivError("Decompressed STK exceeds the 256 MiB limit")
    if not inflater.eof or inflater.unused_data:
        raise PivError("Truncated STK stream or unexpected trailing data")
    return payload


def stk_document(path: Path, source: bytes) -> dict:
    payload = inflate_stk(source)
    figure = None
    if payload is not None:
        # STK uses the same native figure stream as PIV. PIV alone appends a
        # length-prefixed name. This route also decodes image and glyph tables,
        # which the old standalone STK viewer intentionally did not interpret.
        try:
            reader = Reader(payload + b"\0")
            figure = _figure(reader, 2, None)
            if reader.pos != len(payload) + 1:
                raise PivError("STK figure stream contains unparsed trailing bytes")
        except (PivError, ValueError, struct.error) as exc:
            # The existing parser is authoritative for raw/compressed legacy.
            # Never let modern corruption silently become an approximate file.
            from pivot_decoder import _parse_legacy_payload
            if _parse_legacy_payload(payload, DecodeOptions()) is None:
                raise PivError(f"Unsupported or malformed modern STK: {exc}") from exc
    if figure is None:
        report = decode_stk_file(path, options=DecodeOptions())
        if report.get("decode_status") != "decoded" or report.get("format") != "legacy_stk":
            raise PivError("Unsupported STK layout; no approximate import was performed")
        # The later, native-verified PIV legacy reader distinguishes the static
        # byte at record+21 from unused flags at record+2. The original STK
        # viewer predates that finding. Reuse the verified segment reader here.
        from piv_legacy_v2 import Reader as LegacyReader, _segment
        raw_payload = source if payload is None else payload
        count = len(report["segments"])
        legacy_reader = LegacyReader(raw_payload)
        legacy_reader.pos = len(raw_payload) - count * 24
        segments = [_segment(legacy_reader, 0, index, bind=False) for index in range(count)]
        for index, segment in enumerate(segments):
            segment.update(aux_code=int(segment["is_static"]), segment_order_index=index,
                z_order_runtime_raw=index)
            if segment.get("primitive_code") == 2:
                raise PivError("Legacy STK sprite requires an embedded image table")
        figure = {"figure_type_id": 2, "segments": segments, "segment_count": len(segments),
            "polyfills": [], "image_assets": [], "text_assets": [], "side_tables": [],
            "segment_decode": {"layout": "legacy_stk", "global_style": None}}
    figure["name"] = path.stem
    figure["implicit"] = False
    figure["segment_count"] = len(figure["segments"])
    # Fit by translating the root, retaining the figure's authored proportions.
    points = {0: (0.0, 0.0)}
    remaining = list(figure["segments"])
    for _ in range(len(remaining) + 1):
        pending = []
        for segment in remaining:
            if segment["parent_id"] not in points:
                pending.append(segment)
                continue
            x, y = points[segment["parent_id"]]
            a, length, bend = segment["angle_rad"], segment["length"], segment.get("bend_rad", 0)
            if abs(bend) < 1e-8:
                dx, dy = length * math.cos(a), length * math.sin(a)
            else:
                dx = length / bend * (math.sin(a + bend) - math.sin(a))
                dy = length / bend * (math.cos(a) - math.cos(a + bend))
            points[segment["segment_id"]] = (x + dx, y + dy)
        if not pending:
            break
        if len(pending) == len(remaining):
            raise PivError("STK contains missing parents or a cyclic topology")
        remaining = pending
    x_values, y_values = zip(*points.values())
    width = max(640, math.ceil(max(x_values) - min(x_values) + 120))
    height = max(480, math.ceil(max(y_values) - min(y_values) + 120))
    root_x = width / 2 - (max(x_values) + min(x_values)) / 2
    root_y = height / 2 - (max(y_values) + min(y_values)) / 2
    obj = {"object_slot": 0, "unique_id": 1, "figure_type_id": 2, "scale": 1.0,
        "color_override_raw": 0, "field28": 0, "image_text_flags": 0, "opacity": 1.0,
        "angles": [s["angle_rad"] for s in figure["segments"]], "root_x": root_x, "root_y": root_y,
        "lengths": [], "bends": [], "len_flag": 0, "bend_flag": 0, "join": None}
    return {"version": 5, "canvas_width": width, "canvas_height": height, "fps": 24,
        "auto_easing": False, "auto_easing_source": "file", "backgrounds": [],
        "figure_types": [_builtin_man(), figure], "keyframes": [{"keyframe_index": 0,
            "duration_raw": 1, "inbetweens": 0, "background_id": 0, "background_mix": 0,
            "background_id_b": None, "objects": [obj], "object_draw_order": [0],
            "object_draw_order_unique_ids": [1], "camera": {"is_default": True,
                "x": 0.0, "y": 0.0, "angle_rad": 0.0, "scale": 1.0}}],
        "total_output_frames": 1, "duration_seconds": 1 / 24,
        "notes": ["Imported STK definition retains its original lengths, colors, static nodes, and media."]}


def validate_document(document: dict) -> None:
    if not isinstance(document, dict) or document.get("version") not in (2, 3, 4, 5):
        raise PivError("Not a supported StykAnimate/Pivot document")
    native = document.get("_styk", {})
    if native and (native.get("format") != "StykAnimate" or native.get("format_version") != 1):
        raise PivError("Unsupported StykAnimate native project version")
    for key in ("canvas_width", "canvas_height"):
        value = document.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= 100000:
            raise PivError(f"Invalid {key}")
    if not isinstance(document.get("fps"), (int, float)) or not 0 < document["fps"] <= 1000:
        raise PivError("Invalid project frame rate")
    figures, frames = document.get("figure_types"), document.get("keyframes")
    if not isinstance(figures, list) or not figures or len(figures) > 65535:
        raise PivError("Invalid figure table")
    if not isinstance(frames, list) or (not frames and document.get('version') != 5) or len(frames) > 1000000:
        raise PivError("Invalid keyframe table")
    def numeric(value, label):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise PivError(f"Invalid numeric {label}")
        if not math.isfinite(value):
            raise PivError(f"Document contains non-finite {label}")
    types = {}
    for figure in figures:
        tid, segments = figure.get("figure_type_id"), figure.get("segments")
        if not isinstance(tid, int) or tid in types or not isinstance(segments, list) or not 0 < len(segments) <= MAX_SEGMENTS:
            raise PivError("Invalid or duplicate figure definition")
        parents = {s["segment_id"]: s["parent_id"] for s in segments}
        if len(parents) != len(segments) or 0 in parents:
            raise PivError("Invalid segment identifiers")
        for segment in segments:
            for field in ("length", "angle_rad", "thickness"):
                numeric(segment.get(field), "segment " + field)
            numeric(segment.get("bend_rad", 0), "segment bend")
            if segment.get("primitive_code", 0) not in (0, 1, 2, 3, 4, 5, 6):
                raise PivError("Unsupported segment primitive")
        seen = {0}
        for sid in parents:
            cursor, chain = sid, set()
            while cursor not in seen:
                if cursor in chain or cursor not in parents:
                    raise PivError("Cyclic or missing segment parent")
                chain.add(cursor)
                cursor = parents[cursor]
            seen.update(chain)
        types[tid] = (len(segments), parents)
    for frame in frames:
        objects = frame.get("objects")
        if not isinstance(objects, list) or len(objects) > 65535:
            raise PivError("Invalid frame objects")
        uids = {o["unique_id"]: o for o in objects}
        if len(uids) != len(objects):
            raise PivError("Duplicate object identity in frame")
        joined_to = {}
        for obj in objects:
            tid = obj.get("figure_type_id")
            if tid not in types or len(obj.get("angles", [])) != types[tid][0]:
                raise PivError("Object figure reference or pose length is invalid")
            for field in ("lengths", "bends"):
                if obj.get(field) and len(obj[field]) != types[tid][0]:
                    raise PivError(f"Object {field} count does not match its figure")
            for field in ("root_x", "root_y", "scale"):
                numeric(obj.get(field), "object " + field)
            for field in ("angles", "lengths", "bends"):
                for value in obj.get(field, []):
                    numeric(value, "pose " + field)
            join = obj.get("join")
            if join:
                target_id = join.get("target_unique_id")
                if target_id is None:
                    slot = join.get("target_object_slot")
                    if not isinstance(slot, int) or not 0 <= slot < len(objects):
                        raise PivError("Invalid joined object slot")
                    target_id = objects[slot]["unique_id"]
                if target_id not in uids:
                    raise PivError("Joined figure references a missing object")
                target = uids[target_id]
                handle = join.get("target_handle_id")
                if target["figure_type_id"] not in types or (handle != 0 and handle not in types[target["figure_type_id"]][1]):
                    raise PivError("Joined figure references a missing handle")
                joined_to[obj["unique_id"]] = target_id
        checked = set()
        for uid in joined_to:
            chain = set()
            while uid in joined_to and uid not in checked:
                if uid in chain:
                    raise PivError("Cyclic figure attachments")
                chain.add(uid)
                uid = joined_to[uid]
            checked.update(chain)
    # json.load accepts NaN by default; finite checking protects native code.
    stack = [document]
    while stack:
        item = stack.pop()
        if isinstance(item, float) and not math.isfinite(item):
            raise PivError("Document contains non-finite numbers")
        if isinstance(item, dict):
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)


def load_project(path: Path) -> dict:
    suffix = path.suffix.lower()
    source = read_bounded(path, MAX_DOCUMENT if suffix in (".styk", ".json") else MAX_SOURCE)
    if suffix == ".piv":
        document = decode_piv_bytes(source, source_path=str(path.resolve()))
        attach_source(document, source, path, "piv")
    elif suffix == ".stk":
        document = attach_source(stk_document(path, source), source, path, "stk")
    elif suffix in (".styk", ".json"):
        document = json.loads(source.decode("utf-8-sig"))
    else:
        raise PivError("Choose a .piv, .stk, or .styk project")
    validate_document(document)
    return document


def source_bytes(document: dict) -> bytes | None:
    metadata = document.get(META)
    if not metadata:
        return None
    encoded = metadata.get("source_base64")
    if not isinstance(encoded, str) or len(encoded) > (MAX_SOURCE * 4 // 3 + 8):
        raise PivError("Invalid embedded original source")
    try:
        source = base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise PivError("Corrupted embedded original source") from exc
    if hashlib.sha256(source).hexdigest() != metadata.get("sha256"):
        raise PivError("Embedded original source fingerprint does not match")
    return source


def scaffold(document: dict) -> bytes:
    return zlib.compress(struct.pack("<BIIHH", 5, int(document["canvas_width"]),
        int(document["canvas_height"]), 1, 2)
        + struct.pack("<IHBHHBI", 1, 1, 0, 0, 0, 1, int(document["fps"])) + b"\x01")


def export_stk(document: dict) -> bytes:
    """Export one editable definition as a native modern STK figure stream."""
    selected = document.get("_exportFigureTypeId")
    if selected is None:
        selected = next((o["figure_type_id"] for f in document["keyframes"] for o in f["objects"]), None)
    chosen = next((f for f in document["figure_types"] if f["figure_type_id"] == selected), None)
    if chosen is None:
        raise PivError("Select a figure to export as STK")
    # Normalize sparse joint IDs, topology and media offsets using the complete
    # writer, but only include this definition, not every frame in the project.
    figure = copy.deepcopy(chosen)
    figure.update(figure_type_id=2, name="", implicit=False)
    mini = decode_piv_bytes(scaffold(document))
    mini["figure_types"].append(figure)
    if document["version"] < 5:
        from piv_migrate import _figure as migrate_figure
        mini["figure_types"][-1] = migrate_figure(figure, 2)
    packed = encode_piv_project(scaffold(document), mini, force_rebuild=True)
    normalized = decode_piv_bytes(packed)["figure_types"][1]
    normalized["name"] = ""
    from piv_full_writer import _figure as write_figure
    from piv_document import _Writer
    writer = _Writer()
    write_figure(writer, normalized, normalized, zlib.decompress(packed), None)
    # The final byte is the empty PIV-only figure name. Media absolute offsets
    # were already relocated relative to the STK figure payload beginning at 0.
    payload = bytes(writer.data[:-1])
    reader = Reader(payload + b"\0")
    _figure(reader, 2, None)
    if reader.pos != len(payload) + 1:
        raise PivError("Internal STK export validation failed")
    return b"\x7a" + zlib.compress(payload)


def save_project(document: dict, destination: Path, original: Path | None = None, *, staging_path: Path | None = None) -> dict:
    validate_document(document)
    metadata = document.get(META, {})
    protected = [p for p in (original, Path(metadata["original_path"]) if metadata.get("original_path") else None) if p]
    if any(p.suffix.lower() in (".piv", ".stk") and p.resolve() == destination.resolve() for p in protected):
        raise PivError("Original Pivot files are protected. Choose a different filename for the exported copy.")
    suffix = destination.suffix.lower()
    output_path = staging_path if staging_path is not None else destination
    staged = staging_path is not None
    if suffix == ".stk":
        output = export_stk(document)
        atomic_write(output_path, output, staging=staged)
        return {"format": "stk", "path": str(destination)}
    if suffix == ".styk":
        # Validate embedded source now, rather than defer discovering corruption
        # until a later Pivot export. Asset blobs are already inline in the JSON.
        source_bytes(document)
        output = copy.copy(document)
        output["_styk"] = {"format": "StykAnimate", "format_version": 1}
        atomic_json(output_path, output, staging=staged)
        return {"format": "styk", "path": str(destination)}
    if suffix != ".piv":
        raise PivError("Save as .styk, .piv, or .stk")
    source = source_bytes(document)
    kind = metadata.get("kind")
    unchanged = metadata.get("document_sha256") == document_digest(document)
    if source is not None and kind == "piv" and unchanged:
        output = source
    elif document["version"] < 5:
        if source is None or kind != "piv":
            raise PivError("Legacy export requires the embedded original Pivot source")
        output = migrate_legacy_bytes(source, document)
    elif source is not None and kind == "piv":
        output = encode_piv_project(source, document)
    else:
        output = encode_piv_project(scaffold(document), document, force_rebuild=True)
    # Decode before commit, so even an encoder regression cannot replace an
    # existing destination with a structurally invalid project.
    checked = decode_piv_bytes(output)
    atomic_write(output_path, output, staging=staged)
    return {"format": "piv", "version": checked["version"], "path": str(destination),
        "converted_legacy": document["version"] < 5 and checked["version"] == 5}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--response", type=Path, required=True)
    args = parser.parse_args()
    try:
        request = json.loads(read_bounded(args.request, MAX_DOCUMENT).decode("utf-8-sig"))
        operation = request.get("operation")
        if operation == "load":
            response = {"ok": True, "document": load_project(Path(request["path"]))}
        elif operation == "save":
            original = Path(request["original"]) if request.get("original") else None
            stage = Path(request["stage_path"]) if request.get("stage_path") else None
            result = save_project(request["document"], Path(request["destination"]), original, staging_path=stage)
            response = {"ok": True, **result}
        else:
            raise PivError("Unknown codec operation")
        atomic_json(args.response, response)
        return 0
    except Exception as exc:
        # Error transport must survive malformed input and use no raw tracebacks
        # or output from third-party modules as protocol data.
        atomic_json(args.response, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

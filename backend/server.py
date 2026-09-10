#!/usr/bin/env python3
"""StykAnimate local file codec and desktop web host (Python 3.10+).

The render/edit loop never crosses this process boundary. This long-lived
service only imports, validates, and exports the existing Pivot document schema.
Original bytes live in a bounded cache; files opened by the user are never
modified. Run ``python backend/server.py --port 47831`` from the app directory.
"""
from __future__ import annotations

import argparse
from collections import OrderedDict
from dataclasses import dataclass
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import math
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import struct
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, quote, unquote, urlsplit

sys.dont_write_bytecode = True
APP = Path(__file__).resolve().parents[1]
WORKSPACE = APP.parent
TOOLS = Path(os.environ.get("STYK_TOOLS_ROOT", APP / "codecs")).resolve()
BRIDGE = Path(os.environ.get("STYK_BRIDGE_PATH", APP / "codecs/codec_bridge.py")).resolve()
sys.path.insert(0, str(TOOLS))
import piv_codec
import import_wire
import fast_decode
import native_format

# Optional compiled serializer. Source checkouts discover the same local wheels
# used by the desktop build; a plain Python installation remains supported.
_fast_json = None
if os.environ.get("STYK_DISABLE_FAST_JSON") != "1":
    build_dependencies = APP / "build" / "python-build-deps"
    if build_dependencies.is_dir():
        sys.path.append(str(build_dependencies))
    try:
        import orjson as _fast_json
        if not callable(getattr(_fast_json, "dumps", None)):
            _fast_json = None
    except ImportError:
        pass
JSON_ENCODER = "orjson" if _fast_json is not None else "stdlib"


class FastReader(piv_codec.Reader):
    """The same grammar, without the scalar-editor binding inventory.

    A figure pose is a contiguous numeric array. Reading it in a single C
    struct call avoids one Python dispatch and dictionary allocation per joint.
    Bounds and finite-number validation remain enforced. The existing writers
    use the document model rather than the old scalar binding API.
    """
    _structs: dict[str, struct.Struct] = {}

    def read(self, fmt: str, path: str | None = None):
        decoder = self._structs.get(fmt)
        if decoder is None:
            decoder = self._structs.setdefault(fmt, struct.Struct("<" + fmt))
        end = self.pos + decoder.size
        if end > len(self.data):
            raise piv_codec.PivError(f"Unexpected EOF at payload offset {self.pos:#x}")
        value = decoder.unpack_from(self.data, self.pos)[0]
        self.pos = end
        if isinstance(value, float) and not math.isfinite(value):
            raise piv_codec.PivError(f"Non-finite {path or fmt} at {end - decoder.size:#x}")
        return value

    def array(self, fmt: str, count: int, path: str | None = None) -> list:
        size = struct.calcsize("<" + fmt)
        end = self.pos + size * count
        if count < 0 or end > len(self.data):
            raise piv_codec.PivError(f"Unexpected array EOF at payload offset {self.pos:#x}")
        values = list(struct.unpack_from(f"<{count}{fmt}", self.data, self.pos))
        self.pos = end
        if fmt in ("f", "d") and any(not math.isfinite(v) for v in values):
            raise piv_codec.PivError(f"Non-finite array {path or fmt}")
        return values


# Process-local specialization: the checked-in decoder and native app stay intact.
piv_codec.Reader = FastReader
piv_codec._keyframes = fast_decode.read_keyframes
spec = importlib.util.spec_from_file_location("styk_web_codec_bridge", BRIDGE)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Cannot load the existing Pivot codec bridge at {BRIDGE}")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

MAX_SOURCE = 128 * 1024 * 1024
MAX_DOCUMENT = 256 * 1024 * 1024
MAX_CACHE = 384 * 1024 * 1024
MAX_CACHE_ENTRIES = 24
MAX_SAMPLE_COUNT = 5000
IMPORT_SUFFIXES = {".piv", ".stk", ".styk", ".stkz", ".stykmov", ".json"}
PRIVATE_PARTS = {".git", ".codex", ".agents", "__pycache__", "node_modules"}
EXCLUDED_DIRS = PRIVATE_PARTS | {
    "reports", "tests", "vendor", "reference", "references", "reference_runs",
    "snapshots", "__snapshots__", "dependencies", "artifacts", "piv_extracted",
    "third_party", "build", "dist", "local", "stykanimate", "stykanimate-webapp",
}


class ApiError(ValueError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


def validate_native_figure(document, kind="stkz"):
    figures, frames = document.get("figure_types"), document.get("keyframes")
    if (not isinstance(figures, list) or not figures or any(not isinstance(f, dict) for f in figures) or
            not isinstance(frames, list) or len(frames) != 1 or
            not isinstance(frames[0], dict) or not isinstance(frames[0].get("objects"), list) or
            not frames[0]["objects"] or any(not isinstance(o, dict) for o in frames[0]["objects"])):
        raise ApiError(422, "invalid_native_figure", f"A .{kind} file must contain reusable figures and one pose.")
    objects = frames[0]["objects"]
    figure_ids = {f.get("figure_type_id") for f in figures}
    metadata = document.get("_styk", {})
    if (not isinstance(metadata, dict) or any(o.get("figure_type_id") not in figure_ids for o in objects) or
            document.get("backgrounds") or metadata.get("animation") or metadata.get("simpleFrameDraft") or metadata.get("layerSheet")):
        raise ApiError(422, "invalid_native_figure", f"The .{kind} figure must be self-contained.")
    for pose in objects:
        join = pose.get("join")
        if join is not None and (not isinstance(join, dict) or type(join.get("target_object_slot")) is not int or
                                 not 0 <= join["target_object_slot"] < len(objects)):
            raise ApiError(422, "invalid_native_figure", "Figure set joins must stay inside the saved set.")

    if kind == "stykmov" and (len(figures) != 1 or len(objects) != 1 or objects[0].get("join") is not None or
                              not figures[0].get("_styk", {}).get("movieclip")):
        raise ApiError(422, "invalid_movieclip", "A .stykmov file must contain one movieclip.")

def encoded_json(value: object, *, validated: bool = False) -> bytes:
    if validated and _fast_json is not None:
        try:
            # The verified binary grammar or bridge validation has already
            # rejected all nonfinite numbers. orjson emits UTF-8 bytes directly.
            return _fast_json.dumps(value)
        except (TypeError, ValueError):
            # Keep unusual opaque strings (including lone surrogate units) and
            # arbitrary-size integers exactly using the established encoder.
            pass
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")


def _canonical_numbers(value):
    """Unify JSON number spelling without rounding or mutating document data.

    ECMAScript has one Number type, so JSON.stringify turns 1.0 into 1 and -0.0
    into 0. These are equal numeric values, not edits. Nonintegral floats, bools,
    strings (even numeric-looking strings), and every unknown field retain their
    values. Do not coerce integers through float: uint64 values may be exact.
    """
    if isinstance(value, float):
        return int(value) if math.isfinite(value) and value.is_integer() else value
    if isinstance(value, dict):
        return {key: _canonical_numbers(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical_numbers(item) for item in value]
    return value


def document_digest(document: dict, *, canonical: bool = True, runtime_aliases: bool = False) -> str:
    # Browser-only properties and lossless source storage are outside the format.
    semantic = {k: v for k, v in document.items() if k not in ("_stykSource", "_styk", "_stykWeb")}
    if canonical:
        semantic = _canonical_numbers(semantic)
        if not runtime_aliases:
            # Legacy reports expose an expanded pose cache. The editor updates
            # authoritative angles/lengths and intentionally drops this cache.
            # Only this exact known location is excluded; opaque names survive.
            for frame in semantic.get("keyframes", []):
                for obj in frame.get("objects", []):
                    obj.pop("runtime_segments", None)
    return hashlib.sha256(json.dumps(semantic, sort_keys=True, ensure_ascii=True,
        allow_nan=False, separators=(",", ":")).encode("ascii")).hexdigest()


def compact_media_aliases(document: dict) -> None:
    """Keep one writable representation of every embedded asset.

    The parser intentionally exposes side_tables and image/text lists as aliases
    to the exact same Python objects. JSON would duplicate every image and glyph
    outline. The full writer explicitly accepts the canonical image/text lists
    when side_tables is absent, so no decoded or opaque asset data is removed.
    """
    for figure in document.get("figure_types", []):
        side = figure.get("side_tables")
        combined = [*figure.get("image_assets", []), *figure.get("text_assets", [])]
        if side is not None and len(side) == len(combined) and all(
            any(item is candidate for candidate in combined) for item in side
        ):
            figure.pop("side_tables", None)


def filename_only(filename: str) -> str:
    if not isinstance(filename, str):
        raise ApiError(400, "invalid_filename", "A filename is required.")
    name = filename.replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r'[\x00-\x1f\x7f:*?"<>|]', "_", name).strip(" .")[:220]
    if not name or Path(name).suffix.lower() not in IMPORT_SUFFIXES:
        raise ApiError(415, "unsupported_file", "Choose a .styk project, .stykmov movieclip, .stkz figure, .piv, or .stk file.")
    return name


def safe_child(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\x00" in relative:
        raise ApiError(400, "invalid_path", "A relative file path is required.")
    normalized = relative.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    if normalized.startswith("/") or ":" in normalized or any(
        p in (".", "..") or p.startswith(".") or p.casefold() in PRIVATE_PARTS for p in parts
    ):
        raise ApiError(403, "path_forbidden", "The path must stay inside the project directory.")
    target = (root / normalized).resolve()
    if not target.is_relative_to(root):
        raise ApiError(403, "path_forbidden", "The path must stay inside the project directory.")
    return target


@dataclass
class Source:
    source_id: str
    data: bytes
    document_json: bytes | None
    digest: str | None
    filename: str
    kind: str
    version: int
    decode_ms: float
    native_wire: tuple | None = None

    @property
    def retained_size(self) -> int:
        return len(self.data) + len(self.document_json or b"") + (sum(len(x) for x in self.native_wire[:2]) if self.native_wire else 0)


class ProjectStore:
    def __init__(self, root: Path, max_cache: int = MAX_CACHE):
        self.root = root.resolve()
        self.max_cache = max_cache
        self.sources: OrderedDict[str, Source] = OrderedDict()
        self.cache_bytes = 0
        self.lock = threading.RLock()
        self.decode_lock = threading.RLock()

    def _canonical_json(self, entry: Source) -> bytes:
        if entry.document_json is not None:
            return entry.document_json
        with self.decode_lock:
            return self._encode_canonical(entry)

    def _encode_canonical(self, entry: Source) -> bytes:
        # Negotiated native imports retain validated source bytes and a small
        # definition header. Export/legacy JSON clients alone need this full
        # object inventory; do not keep its 100+ MB encoding in the hot cache.
        document = piv_codec.decode_piv_bytes(entry.data, source_path=entry.filename)
        for key in ("editable_paths", "_codec", "_stykWeb"):
            document.pop(key, None)
        compact_media_aliases(document)
        packed = encoded_json(document, validated=True)
        if len(packed) > MAX_DOCUMENT:
            raise ApiError(413, "document_too_large", "The decoded project exceeds the JSON transport limit.")
        return packed

    def samples(self) -> list[dict]:
        result = []
        for directory, subdirectories, filenames in os.walk(self.root):
            subdirectories[:] = [name for name in subdirectories
                if not name.startswith(".") and name.casefold() not in EXCLUDED_DIRS]
            for name in filenames:
                path = Path(directory) / name
                if path.suffix.lower() not in (".piv", ".stk"):
                    continue
                try:
                    if not path.resolve().is_relative_to(self.root):
                        continue
                    stat = path.stat()
                except OSError:
                    continue
                result.append({"path": path.relative_to(self.root).as_posix(), "name": name,
                    "kind": path.suffix[1:].lower(), "size": stat.st_size})
                if len(result) >= MAX_SAMPLE_COUNT:
                    return sorted(result, key=lambda item: (item["kind"], item["name"].casefold()))
        return sorted(result, key=lambda item: (item["kind"], item["name"].casefold()))

    def open(self, relative: str, *, as_json: bool = False, prefer_native: bool = False) -> dict | bytes:
        path = safe_child(self.root, relative)
        filename_only(path.name)
        if path.suffix.lower() == ".json":
            raise ApiError(415, "unsupported_sample", "Use file import to open a native JSON project.")
        if not path.is_file():
            raise ApiError(404, "file_not_found", "This project file no longer exists.")
        data = bridge.read_bounded(path, MAX_DOCUMENT if path.suffix.lower() in (".styk", ".stkz", ".stykmov") else MAX_SOURCE)
        return self.import_bytes(data, path.name, as_json=as_json, prefer_native=prefer_native)

    def import_bytes(self, data: bytes, filename: str, *, as_json: bool = False, prefer_native: bool = False) -> dict | bytes:
        started = time.perf_counter()
        name = filename_only(filename)
        kind = Path(name).suffix[1:].lower()
        if kind == "json":
            kind = "styk"
        if len(data) > (MAX_DOCUMENT if kind in ("styk", "stkz", "stykmov") else MAX_SOURCE):
            raise ApiError(413, "file_too_large", "This file exceeds the import size limit.")
        if not data:
            raise ApiError(400, "empty_file", "This file is empty.")
        # STK names become editable figure names, so include the name in its key.
        key_data = data + (name.encode("utf-8") if kind == "stk" else b"")
        source_id = hashlib.sha256(kind.encode("ascii") + b"\0" + key_data).hexdigest()
        with self.lock:
            entry = self.sources.get(source_id)
            if entry:
                self.sources.move_to_end(source_id)
        cache_hit = entry is not None
        if entry is None:
            # Bounded serialization prevents parallel imports from multiplying
            # decoder peak memory. Editing/playback remains independent in JS.
            with self.decode_lock:
                with self.lock:
                    entry = self.sources.get(source_id)
                if entry is None:
                    decode_started = time.perf_counter()
                    validated_payload = None
                    if kind == "piv":
                        if prefer_native:
                            document, validated_payload = fast_decode.decode_for_native_wire(data, source_path=name, with_payload=True)
                        else:
                            document = piv_codec.decode_piv_bytes(data, source_path=name)
                    elif kind == "stk":
                        # Only the verified legacy STK parser requires a path.
                        # Its temporary copy is private, bounded, and auto-removed.
                        with tempfile.TemporaryDirectory(prefix="stykanimate-import-") as directory:
                            path = Path(directory) / name
                            path.write_bytes(data)
                            document = bridge.stk_document(path, data)
                    else:
                        document = json.loads(native_format.decode(data, kind).decode("utf-8-sig"))
                        # Compatibility with the web editor's early native-save
                        # wrapper. Current saves use the canonical document plus
                        # embedded source metadata, so original bytes survive.
                        if isinstance(document, dict) and document.get("format") == "stykanimate":
                            if document.get("version") != 1 or not isinstance(document.get("document"), dict):
                                raise ApiError(422, "invalid_native_version", "Unsupported StykAnimate project version.")
                            wrapper = document
                            document = wrapper["document"]
                            if wrapper.get("_stykSource") and "_stykSource" not in document:
                                document["_stykSource"] = wrapper["_stykSource"]
                    if not isinstance(document, dict):
                        raise ApiError(400, "invalid_document", "Project data must be a JSON object.")
                    if kind in ("stkz", "stykmov"):
                        validate_native_figure(document, kind)
                    document.pop("editable_paths", None)
                    document.pop("_codec", None)
                    document.pop("_stykWeb", None)
                    if kind in ("piv", "stk"):
                        compact_media_aliases(document)
                    if kind == "piv" and document.get("version") == 5:
                        # _decode/_figure/_keyframes already validate dimensions,
                        # fps, topology, identities, pose sizes, joins, primitive
                        # codes, permutations and all binary floating-point data.
                        # Repeating the bridge's numeric scan cost 3s on Akane.
                        # Native v5 may contain zero stored keys; the editor
                        # supplies a separate working placeholder on load.
                        if not isinstance(document.get("keyframes"), list):
                            raise piv_codec.PivError("Invalid keyframe table")
                    else:
                        # Native JSON and STK documents still need the full
                        # independent validation, including unknown nested data.
                        bridge.validate_document(document)
                    bridge.source_bytes(document)  # Validate any embedded source before editing.
                    wire_parts = import_wire.native_frame_wire(document, data, piv_codec._unpack_source, encoded_json,
                        payload=validated_payload) if prefer_native and kind == "piv" else None
                    packed = None if wire_parts else encoded_json(document, validated=True)
                    if packed is not None and len(packed) > MAX_DOCUMENT:
                        raise ApiError(413, "document_too_large", "The decoded project exceeds the transport limit.")
                    # A semantic source digest is only needed on export. Delay
                    # the second serialization until then to shorten import.
                    # Native JSON already embeds the original binary source.
                    # Keeping its uploaded JSON as well doubles retained memory
                    # and made large projects save successfully but fail reopen.
                    retained_source = b"" if kind in ("styk", "stkz", "stykmov") else data
                    entry = Source(source_id, retained_source, packed, None, name,
                        kind, document["version"], (time.perf_counter() - decode_started) * 1000)
                    entry.native_wire = wire_parts
                    if entry.retained_size > self.max_cache:
                        raise ApiError(413, "cache_limit", "The decoded project exceeds the source cache limit.")
                    with self.lock:
                        self.sources[source_id] = entry
                        self.cache_bytes += entry.retained_size
                        while self.cache_bytes > self.max_cache or len(self.sources) > MAX_CACHE_ENTRIES:
                            _, old = self.sources.popitem(last=False)
                            self.cache_bytes -= old.retained_size
                else:
                    cache_hit = True
        if prefer_native and entry.kind == "piv" and entry.version == 5 and entry.native_wire is None:
            with self.decode_lock:
                if entry.native_wire is None:
                    parts = import_wire.native_frame_wire(json.loads(self._canonical_json(entry)), entry.data, piv_codec._unpack_source, encoded_json)
                    if parts and entry.retained_size + len(parts[0]) + len(parts[1]) <= self.max_cache:
                        with self.lock:
                            entry.native_wire = parts
                            self.cache_bytes += len(parts[0]) + len(parts[1])
                            while self.cache_bytes > self.max_cache and len(self.sources) > 1:
                                _, old = self.sources.popitem(last=False)
                                self.cache_bytes -= old.retained_size
        metadata = {"ok": True, "sourceId": source_id,
            "filename": name, "kind": kind, "version": entry.version,
            "timings": {"decode_ms": round(entry.decode_ms, 3), "cache_hit": cache_hit,
                "total_ms": round((time.perf_counter() - started) * 1000, 3),
                "source_bytes": len(data), "document_bytes": len(entry.document_json) if entry.document_json is not None else None}}
        if prefer_native and entry.native_wire is not None:
            metadata["timings"]["transport"] = "native-v5-frames"
            result = import_wire.response_bytes(entry.native_wire, metadata, encoded_json)
            if len(result) <= MAX_DOCUMENT:
                return result
        if as_json:
            # Transport the already encoded document directly. A large scene
            # must not be parsed and serialized again just to wrap its result.
            packed = self._canonical_json(entry)
            metadata["timings"]["document_bytes"] = len(packed)
            metadata["timings"]["total_ms"] = round((time.perf_counter() - started) * 1000, 3)
            return b"".join((b'{"document":', packed, b',', encoded_json(metadata)[1:]))
        packed = self._canonical_json(entry)
        metadata["document"] = json.loads(packed)
        metadata["timings"]["document_bytes"] = len(packed)
        metadata["timings"]["total_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return metadata

    def export(self, request: dict) -> tuple[bytes, str]:
        document = request.get("document")
        if not isinstance(document, dict):
            raise ApiError(400, "invalid_document", "Export requires an editable document.")
        format_name = request.get("format", "piv")
        if format_name not in ("piv", "stk", "styk", "stkz", "stykmov"):
            raise ApiError(415, "unsupported_export", "Export as piv, stk, styk, stkz, or stykmov.")
        bridge.validate_document(document)
        if format_name in ("stkz", "stykmov"):
            validate_native_figure(document, format_name)
            output_doc = dict(document)
            output_doc.pop("_stykSource", None)
            output_doc["_styk"] = {**document.get("_styk", {}), "format": "StykAnimate", "format_version": 1}
            output = native_format.encode(encoded_json(output_doc, validated=True), format_name)
            base = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]', "_", str(request.get("filename") or "Figure")).strip(" .")[:180] or "Figure"
            return output, f"{base}.{format_name}"
        source_id = request.get("sourceId")
        with self.lock:
            entry = self.sources.get(source_id) if isinstance(source_id, str) else None
            if entry:
                self.sources.move_to_end(source_id)
        if source_id and entry is None:
            raise ApiError(410, "source_expired", "The original source expired from memory. Reopen the original file before exporting.")
        if entry and entry.kind in ("piv", "stk") and entry.digest is None:
            entry.digest = document_digest(json.loads(self._canonical_json(entry)))
        metadata = document.get("_stykSource", {})
        embedded_source = bridge.source_bytes(document)
        source = entry.data if entry and entry.kind in ("piv", "stk") else embedded_source
        source_kind = entry.kind if entry and entry.kind in ("piv", "stk") else metadata.get("kind")
        # A reopened .styk cache entry contains the *saved edited document*,
        # while its embedded PIV bytes still represent the original import.
        # Compare against that original document's digest, not the native-save
        # cache digest, or edits would disappear when exporting after restart.
        original_digest = entry.digest if entry and entry.kind in ("piv", "stk") else metadata.get("document_sha256")
        # Native saves always retain the edited document. Comparing its entire
        # graph against the source only affects binary PIV/STK export decisions.
        compare_binary = format_name != "styk"
        current_digest = document_digest(document) if compare_binary else None
        unchanged = compare_binary and current_digest == original_digest
        if compare_binary and not unchanged and not (entry and entry.kind in ("piv", "stk")) and metadata.get("document_digest_version", 1) == 1:
            # Native files written before numeric canonicalization used the
            # previous hash. Retain compatibility where it still matches.
            unchanged = document_digest(document, canonical=False) == original_digest
        if compare_binary and not unchanged and source is not None and source_kind == "piv" and document["version"] < 5 and metadata.get("document_digest_version", 1) < 3:
            # Older native saves omitted the expanded legacy pose cache but
            # fingerprinted it in the source. Reconstruct that verified source
            # once to upgrade comparison without mistaking a real pose edit.
            original_doc = piv_codec.decode_piv_bytes(source, source_path=document.get("source_path", ""))
            for key in ("editable_paths", "_codec", "_stykWeb"):
                original_doc.pop(key, None)
            compact_media_aliases(original_doc)
            unchanged = current_digest == document_digest(original_doc)
        if format_name == "styk":
            output_doc = dict(document)
            output_doc["_styk"] = {**document.get("_styk", {}), "format": "StykAnimate", "format_version": 1}
            if entry and entry.kind in ("piv", "stk"):
                import base64
                output_doc["_stykSource"] = {"kind": entry.kind, "version": entry.version,
                    "source_base64": base64.b64encode(entry.data).decode("ascii"),
                    "sha256": hashlib.sha256(entry.data).hexdigest(),
                    "document_sha256": entry.digest, "document_digest_version": 3}
            output = native_format.encode(encoded_json(output_doc, validated=True), "styk")
        elif format_name == "stk":
            selected = request.get("figureTypeId")
            selection_matches = selected in (None, 2)
            if source is not None and source_kind == "stk" and unchanged and selection_matches:
                output = source
            else:
                output_doc = dict(document)
                if selected is not None:
                    output_doc["_exportFigureTypeId"] = selected
                output = bridge.export_stk(output_doc)
        elif source is not None and source_kind == "piv" and unchanged:
            output = source
        elif document["version"] < 5:
            if source is None or source_kind != "piv":
                raise ApiError(422, "missing_legacy_source", "Legacy PIV export requires its imported source.")
            output = bridge.migrate_legacy_bytes(source, document)
        elif source is not None and source_kind == "piv":
            # An explicit editor upgrade changes the editable schema to V5,
            # while its original legacy bytes remain available for native-save
            # provenance and Undo. Never hand those bytes to the V5 writer or
            # trust the editable metadata's version when choosing a writer.
            source_version = entry.version if entry and entry.kind == "piv" else None
            if source_version is None:
                payload, _ = piv_codec._unpack_source(source)
                source_version = payload[0] if payload else None
                if source_version in (2, 3, 4):
                    # Embedded bytes have a verified fingerprint, but their
                    # grammar still needs validation before bypassing the
                    # source-based writer. Cached PIV imports already did it.
                    piv_codec.decode_piv_bytes(payload)
            if source_version in (2, 3, 4):
                source_digest = hashlib.sha256(source).hexdigest()
                if document.get("source_sha256", source_digest) != source_digest:
                    raise piv_codec.PivError("Edited document belongs to a different original source")
                output = bridge.encode_piv_project(bridge.scaffold(document), document, force_rebuild=True)
            else:
                output = bridge.encode_piv_project(source, document)
        else:
            output = bridge.encode_piv_project(bridge.scaffold(document), document, force_rebuild=True)
        if len(output) > MAX_DOCUMENT:
            raise ApiError(413, "export_too_large", "The exported project exceeds the transport limit.")
        base = Path(request.get("filename") or (entry.filename if entry else "Untitled")).stem
        base = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]', "_", base).strip(" .")[:180] or "Untitled"
        return output, f"{base}.{format_name}"


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: ProjectStore, web_root: Path, token: str = ""):
        self.store, self.web_root, self.token = store, web_root.resolve(), token
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server: LocalServer
    protocol_version = "HTTP/1.1"
    server_version = "StykAnimate/1"

    def log_message(self, fmt, *args):
        # Imported file names are private and not needed in the process log.
        pass

    def _check_request(self, *, auth: bool = True) -> str | None:
        host = urlsplit("http://" + self.headers.get("Host", "")).hostname
        if host not in ("localhost", "127.0.0.1", "::1"):
            raise ApiError(403, "host_forbidden", "Only loopback requests are accepted.")
        origin = self.headers.get("Origin")
        if origin and origin != "null":
            parts = urlsplit(origin)
            if parts.scheme != "http" or parts.hostname not in ("localhost", "127.0.0.1", "::1"):
                raise ApiError(403, "origin_forbidden", "Only the local desktop editor can use the codec.")
        elif origin == "null":
            raise ApiError(403, "origin_forbidden", "Open the editor through the local desktop host.")
        if auth and self.server.token and self.headers.get("Authorization") != "Bearer " + self.server.token:
            raise ApiError(401, "unauthorized", "The desktop session token is missing or invalid.")
        return origin

    def _send(self, status: int, data: bytes, content_type: str, *, filename: str | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin and origin != "null":
            parts = urlsplit(origin)
            if parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1"):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition, Server-Timing")
        if filename:
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(filename))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, status: int, value: object):
        self._send(status, encoded_json(value), "application/json; charset=utf-8")

    def _body(self, limit: int) -> bytes:
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(400, "unsupported_transfer", "Send a bounded Content-Length upload.")
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0:
            raise ApiError(411, "length_required", "Content-Length is required.")
        if length > limit:
            self.close_connection = True
            raise ApiError(413, "body_too_large", "The request exceeds the configured size limit.")
        self.connection.settimeout(60)
        body = self.rfile.read(length)
        if len(body) != length:
            raise ApiError(400, "truncated_upload", "The upload ended before the complete file arrived.")
        return body

    def _handle_error(self, exc: Exception):
        # Unconsumed bodies must never become a subsequent HTTP request.
        self.close_connection = True
        if isinstance(exc, ApiError):
            self._json(exc.status, {"ok": False, "error": str(exc), "code": exc.code})
        elif isinstance(exc, (piv_codec.PivError, ValueError, TypeError, KeyError, IndexError, struct.error)):
            self._json(422, {"ok": False, "error": str(exc), "code": "invalid_project"})
        elif isinstance(exc, OSError):
            self._json(500, {"ok": False, "error": "The local file operation could not be completed.", "code": "file_error"})
        else:
            print(f"Codec failure: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            self._json(500, {"ok": False, "error": "The project operation failed.", "code": "codec_error"})

    def do_OPTIONS(self):
        try:
            self._check_request(auth=False)
            self.send_response(204)
            if self.headers.get("Origin"):
                self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Content-Length", "0")
            self.end_headers()
        except Exception as exc:
            self._handle_error(exc)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            parsed = urlsplit(self.path)
            self._check_request(auth=parsed.path.startswith("/api/") and parsed.path != "/api/health")
            if parsed.path == "/api/health":
                scanner = fast_decode.native_scan.status()
                self._json(200, {"ok": True, "name": "StykAnimate-webapp", "schemaVersion": 1,
                    "codec": "Pivot verified grammar / bulk reader", "versions": [2, 3, 4, 5],
                    "formats": ["piv", "stk", "styk", "stkz", "stykmov"], "maxImportBytes": MAX_SOURCE,
                    "jsonEncoder": JSON_ENCODER,
                    "nativeFrameScanner": "cpp" if scanner["available"] else "python",
                    "nativeFrameScannerInfo": {"abi": scanner["abi"], "sha256": scanner["sha256"]} if scanner["available"] else None})
            elif parsed.path == "/api/samples":
                self._json(200, {"ok": True, "samples": self.server.store.samples()})
            elif parsed.path.startswith("/api/"):
                raise ApiError(404, "route_not_found", "Unknown codec endpoint.")
            else:
                relative = unquote(parsed.path).lstrip("/") or "index.html"
                target = safe_child(self.server.web_root, relative)
                if not target.is_file():
                    raise ApiError(404, "file_not_found", "The application resource was not found.")
                if target.suffix.lower() not in {".html", ".css", ".js", ".mjs", ".json", ".svg",
                    ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".wasm"}:
                    raise ApiError(403, "resource_forbidden", "This resource is private.")
                mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                if target.suffix.lower() in (".js", ".mjs"):
                    mime = "text/javascript"
                self._send(200, target.read_bytes(), mime)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._handle_error(exc)

    def do_POST(self):
        try:
            self._check_request()
            parsed = urlsplit(self.path)
            if parsed.path == "/api/import":
                name = parse_qs(parsed.query).get("filename", ["imported.piv"])[0]
                result = self.server.store.import_bytes(self._body(MAX_DOCUMENT if name.lower().endswith((".styk", ".stkz", ".stykmov", ".json")) else MAX_SOURCE), name, as_json=True,
                    prefer_native=import_wire.CONTENT_TYPE in self.headers.get("Accept", ""))
                self._send(200, result, import_wire.CONTENT_TYPE if result.startswith(import_wire.MAGIC) else "application/json; charset=utf-8")
            elif parsed.path in ("/api/open", "/api/export"):
                request = json.loads(self._body(MAX_DOCUMENT).decode("utf-8"))
                if not isinstance(request, dict):
                    raise ApiError(400, "invalid_request", "The request must be a JSON object.")
                if parsed.path == "/api/open":
                    result = self.server.store.open(request.get("path"), as_json=True,
                        prefer_native=import_wire.CONTENT_TYPE in self.headers.get("Accept", ""))
                    self._send(200, result, import_wire.CONTENT_TYPE if result.startswith(import_wire.MAGIC) else "application/json; charset=utf-8")
                else:
                    data, name = self.server.store.export(request)
                    self._send(200, data, "application/octet-stream", filename=name)
            else:
                raise ApiError(404, "route_not_found", "Unknown codec endpoint.")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._handle_error(exc)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "localhost"])
    parser.add_argument("--port", default=47831, type=int)
    parser.add_argument("--workspace", type=Path, default=WORKSPACE)
    parser.add_argument("--static-root", type=Path, default=Path(os.environ.get("STYK_WEB_ROOT", APP)))
    parser.add_argument("--token", default=os.environ.get("STYK_API_TOKEN", ""))
    args = parser.parse_args()
    server = LocalServer((args.host, args.port), ProjectStore(args.workspace), args.static_root, args.token)
    print(json.dumps({"event": "ready", "host": "127.0.0.1", "port": server.server_port,
        "url": f"http://127.0.0.1:{server.server_port}"}), flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

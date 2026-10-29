#!/usr/bin/env python3
"""StykAnimate local file codec and desktop web host (Python 3.10+).

The render/edit loop never crosses this process boundary. This long-lived
service only imports, validates, and exports the existing Pivot document schema.
Original bytes live in bounded caches and active-document leases; user files are never
modified. Run ``python backend/server.py --port 47831`` from the app directory.
"""
from __future__ import annotations

import argparse
from collections import OrderedDict
from dataclasses import dataclass
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import importlib.util
import io
import json
import math
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import select
import socket
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
import jobs
from work_control import checkpoint

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
        checkpoint()
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
if BRIDGE.is_file():
    spec = importlib.util.spec_from_file_location("styk_web_codec_bridge", BRIDGE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load the existing Pivot codec bridge at {BRIDGE}")
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
elif getattr(sys, "frozen", False):
    bridge = importlib.import_module("codec_bridge")
else:
    raise RuntimeError(f"Cannot load the existing Pivot codec bridge at {BRIDGE}")

MAX_SOURCE = 128 * 1024 * 1024
MAX_DOCUMENT = 256 * 1024 * 1024
MAX_CACHE = 384 * 1024 * 1024
MAX_CACHE_ENTRIES = 24
MAX_SOURCE_OWNERS = 16
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


NATIVE_SUFFIXES = (".styk", ".stkz", ".stykmov", ".json")


def is_native_document(filename: str) -> bool:
    return filename.lower().endswith(NATIVE_SUFFIXES)


def import_size_limit(filename: str) -> int:
    """Largest upload accepted for a file name: native documents may exceed Pivot sources."""
    return MAX_DOCUMENT if is_native_document(filename) else MAX_SOURCE


def error_response(exc: Exception) -> tuple[int, dict]:
    """The (status, JSON body) a codec failure becomes on every transport."""
    if isinstance(exc, (ApiError, jobs.JobError)):
        return exc.status, {"ok": False, "error": str(exc), "code": exc.code}
    if isinstance(exc, (piv_codec.PivError, ValueError, TypeError, KeyError, IndexError, struct.error)):
        return 422, {"ok": False, "error": str(exc), "code": "invalid_project"}
    if isinstance(exc, OSError):
        return 500, {"ok": False, "error": "The local file operation could not be completed.", "code": "file_error"}
    print(f"Codec failure: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
    return 500, {"ok": False, "error": "The project operation failed.", "code": "codec_error"}


def response_metadata(*, filename: str | None = None, timings: dict | None = None,
                      request_bytes: int | None = None) -> dict[str, str]:
    """Diagnostic and download headers the editor reads from a codec response."""
    headers: dict[str, str] = {}
    if request_bytes is not None:
        headers["X-Styk-Request-Bytes"] = str(request_bytes)
    if timings:
        headers["Server-Timing"] = ", ".join(f"{stage};dur={duration:.3f}" for stage, duration in timings.items())
    if filename:
        headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(filename)
    return headers


def source_record_payload(store: "ProjectStore", source_id: str) -> bytes:
    """The retained original source of an imported document, with its metadata."""
    source, meta = store.source_record(source_id)
    return b"STYKSRC1" + struct.pack("<I", len(meta)) + meta + source


def health_payload(jobs_snapshot: dict, session: str | None, *, max_import: int | None = None) -> dict:
    """The /api/health body: what this codec can read and how it is running."""
    from process_metrics import memory_mib
    scanner = fast_decode.native_scan.status()
    return {"ok": True, "name": "StykAnimate-webapp", "schemaVersion": 1,
        "jobs": jobs_snapshot,
        "codec": "Pivot verified grammar / bulk reader", "versions": [2, 3, 4, 5],
        "formats": ["piv", "stk", "styk", "stkz", "stykmov"], "maxImportBytes": MAX_SOURCE if max_import is None else max_import,
        "jsonEncoder": JSON_ENCODER, "processMemoryMiB": memory_mib(),
        "nativeFrameScanner": "cpp" if scanner["available"] else "python",
        "nativeFrameScannerInfo": {"abi": scanner["abi"], "sha256": scanner["sha256"]} if scanner["available"] else None,
        "session": session}


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

def decoded_json(data: bytes):
    """Fast request/document parsing; identical semantics to stdlib json.

    orjson is stricter about NaN, lone surrogates, and trailing bytes. Falling
    back to stdlib on its parse errors keeps the established error behavior —
    accepted nonfinite values still reach validate_document's rejection.
    """
    if _fast_json is not None:
        try:
            return _fast_json.loads(data)
        except _fast_json.JSONDecodeError:
            pass
    return json.loads(data.decode("utf-8"))


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
    kind = type(value)
    if kind is float:
        # Builtin is_integer is false for NaN/infinities. Keep subclass handling
        # below: an overridden method may require the historical finite guard.
        return int(value) if value.is_integer() else value
    if kind is int or kind is str or kind is bool or value is None:
        return value
    if isinstance(value, float):
        return int(value) if math.isfinite(value) and value.is_integer() else value
    if isinstance(value, dict):
        checkpoint()
        return {key: _canonical_numbers(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        checkpoint()
        return [_canonical_numbers(item) for item in value]
    return value


def document_digest(document: dict, *, canonical: bool = True, runtime_aliases: bool = False) -> str:
    if canonical and not runtime_aliases and all(isinstance(key, str) for key in document):
        # The same v3 bytes, without a second complete pose graph or JSON string.
        # Keep historical encoding for legacy fingerprints and non-JSON keys.
        return source_document_digest(document)
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


def source_document_digest(document: dict) -> str:
    """The v3 fingerprint, encoded one frame at a time.

    Native frame imports can legitimately exceed the legacy JSON response limit.
    Saving their original source needs a fingerprint, not a second complete JSON
    buffer or a second normalized pose inventory. Decoder allocation remains
    serialized by ProjectStore.decode_lock; only one frame is normalized here.
    Exported documents use the same bounded normalization and exact hash bytes.
    """
    digest = hashlib.sha256()
    def emit(value):
        digest.update(json.dumps(value, sort_keys=True, ensure_ascii=True,
            allow_nan=False, separators=(",", ":")).encode("ascii"))
    digest.update(b'{')
    keys = sorted(k for k in document if k not in ("_stykSource", "_styk", "_stykWeb"))
    for i, key in enumerate(keys):
        checkpoint()
        if i: digest.update(b',')
        emit(key); digest.update(b':')
        if key == "keyframes":
            digest.update(b'[')
            for index, frame in enumerate(document[key]):
                checkpoint()
                if index: digest.update(b',')
                normalized = _canonical_numbers(frame)
                for obj in normalized.get("objects", []):
                    obj.pop("runtime_segments", None)
                emit(normalized)
            digest.update(b']')
        else:
            emit(_canonical_numbers(document[key]))
    digest.update(b'}')
    return digest.hexdigest()


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
    def __init__(self, root: Path, max_cache: int = MAX_CACHE, *,
                 max_retained_sources: int = MAX_CACHE, max_source_owners: int = MAX_SOURCE_OWNERS):
        self.root = root.resolve()
        self.max_cache = max_cache
        self.sources: OrderedDict[str, Source] = OrderedDict()
        self.cache_bytes = 0
        # Active documents lease immutable original bytes, never a decoded pose
        # graph or frame-wire buffer. A lease shares the cache's bytes rather than
        # copying them, and survives ordinary LRU eviction until its owner exits.
        self.source_owners: dict[str, str] = {}
        self.retained_sources: dict[str, Source] = {}
        self.retained_source_bytes = 0
        self.max_retained_sources = max_retained_sources
        self.max_source_owners = max_source_owners
        self.closed = False
        self.lock = threading.RLock()
        self.decode_lock = threading.RLock()

    @staticmethod
    def _source_owner(owner_id: str) -> str:
        if not isinstance(owner_id, str) or not re.fullmatch(r"[a-f0-9]{32}", owner_id):
            raise ApiError(400, "invalid_source_owner", "Invalid original source owner.")
        return owner_id

    def _find_source(self, source_id: str) -> Source | None:
        with self.lock:
            entry = self.sources.get(source_id)
            if entry is not None:
                self.sources.move_to_end(source_id)
            return entry if entry is not None else self.retained_sources.get(source_id)

    def _retain_source(self, entry: Source, owner_id: str) -> bool:
        self._source_owner(owner_id)
        if entry.kind not in ("piv", "stk") or not entry.data:
            return False  # Native projects already contain their original bytes.
        with self.lock, jobs.publication():
            if self.closed:
                raise ApiError(503, "backend_closed", "The local codec is shutting down.")
            old_id = self.source_owners.get(owner_id)
            if old_id == entry.source_id:
                return True
            if old_id is None and len(self.source_owners) >= self.max_source_owners:
                raise ApiError(503, "source_owner_limit", "Too many original sources are active. Close unused documents and try again.")
            # The previous lease remains intact if a new lease cannot fit. When
            # this owner is its last reference, replacement can reuse its budget.
            remove_old = old_id is not None and sum(value == old_id for value in self.source_owners.values()) == 1
            old_size = len(self.retained_sources[old_id].data) if remove_old else 0
            added_size = 0 if entry.source_id in self.retained_sources else len(entry.data)
            if self.retained_source_bytes - old_size + added_size > self.max_retained_sources:
                raise ApiError(413, "source_retention_limit", "Active original sources exceed the retention limit. Close unused documents and try again.")
            if remove_old:
                self.retained_source_bytes -= old_size
                del self.retained_sources[old_id]
            if added_size:
                self.retained_sources[entry.source_id] = Source(entry.source_id, entry.data,
                    None, entry.digest, entry.filename, entry.kind, entry.version, entry.decode_ms)
                self.retained_source_bytes += added_size
            self.source_owners[owner_id] = entry.source_id
        return True

    def retain_source(self, source_id: str, owner_id: str) -> bool:
        """Keep an active document's original beyond decoded-document eviction."""
        self._source_owner(owner_id)
        entry = self._find_source(source_id) if isinstance(source_id, str) else None
        if entry is None:
            raise ApiError(410, "source_expired", "The original source expired from memory. Reopen the original file before exporting.")
        return self._retain_source(entry, owner_id)

    def release_source(self, owner_id: str) -> None:
        self._source_owner(owner_id)
        with self.lock, jobs.publication():
            source_id = self.source_owners.pop(owner_id, None)
            if source_id is not None and source_id not in self.source_owners.values():
                entry = self.retained_sources.pop(source_id)
                self.retained_source_bytes -= len(entry.data)

    def close(self) -> None:
        with self.lock:
            self.closed = True
            self.source_owners.clear()
            self.retained_sources.clear()
            self.retained_source_bytes = 0
            self.sources.clear()
            self.cache_bytes = 0

    def _canonical_json(self, entry: Source) -> bytes:
        if entry.document_json is not None:
            return entry.document_json
        with self.decode_lock:
            return self._encode_canonical(entry)

    def _encode_canonical(self, entry: Source) -> bytes:
        # Negotiated native imports retain validated source bytes and a small
        # definition header. Export/legacy JSON clients alone need this full
        # object inventory; do not keep its 100+ MB encoding in the hot cache.
        document = self._decode_canonical(entry)
        packed = encoded_json(document, validated=True)
        if len(packed) > MAX_DOCUMENT:
            raise ApiError(413, "document_too_large", "The decoded project exceeds the JSON transport limit.")
        return packed

    def _decode_canonical(self, entry: Source) -> dict:
        checkpoint()
        if entry.kind == "stk":
            with tempfile.TemporaryDirectory(prefix="stykanimate-import-") as directory:
                path = Path(directory) / entry.filename
                path.write_bytes(entry.data)
                document = bridge.stk_document(path, entry.data)
        else:
            document = piv_codec.decode_piv_bytes(entry.data, source_path=entry.filename)
        for key in ("editable_paths", "_codec", "_stykWeb"):
            document.pop(key, None)
        compact_media_aliases(document)
        return document

    def _source_digest(self, entry: Source) -> str:
        with self.decode_lock:
            checkpoint()
            if entry.digest is None:
                if entry.document_json is not None:
                    digest = document_digest(decoded_json(entry.document_json))
                else:
                    digest = source_document_digest(self._decode_canonical(entry))
                with self.lock, jobs.publication():
                    entry.digest = digest
                    retained = self.retained_sources.get(entry.source_id)
                    if retained is not None:
                        retained.digest = digest
            return entry.digest

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

    def open(self, relative: str, *, as_json: bool = False, prefer_native: bool = False,
             source_owner: str | None = None) -> dict | bytes:
        path = safe_child(self.root, relative)
        filename_only(path.name)
        if path.suffix.lower() == ".json":
            raise ApiError(415, "unsupported_sample", "Use file import to open a native JSON project.")
        if not path.is_file():
            raise ApiError(404, "file_not_found", "This project file no longer exists.")
        data = bridge.read_bounded(path, MAX_DOCUMENT if path.suffix.lower() in (".styk", ".stkz", ".stykmov") else MAX_SOURCE)
        return self.import_bytes(data, path.name, as_json=as_json, prefer_native=prefer_native,
                                 source_owner=source_owner)

    def source_record(self, source_id: str) -> tuple[bytes, bytes]:
        """Retained original binary source plus provenance metadata for a
        worker-side .styk build (mirrors what export embeds as _stykSource)."""
        entry = self._find_source(source_id)
        if entry is None:
            raise ApiError(410, "source_expired", "The original source expired from memory. Reopen the original file before exporting.")
        if entry.kind not in ("piv", "stk") or not entry.data:
            raise ApiError(422, "no_source", "The cached import has no binary source.")
        self._source_digest(entry)
        meta = encoded_json({"kind": entry.kind, "version": entry.version,
            "sha256": hashlib.sha256(entry.data).hexdigest(),
            "document_sha256": entry.digest, "document_digest_version": 3})
        return entry.data, meta

    def import_bytes(self, data: bytes, filename: str, *, as_json: bool = False, prefer_native: bool = False,
                     source_owner: str | None = None) -> dict | bytes:
        checkpoint()
        if source_owner is not None:
            self._source_owner(source_owner)
        with self.lock:
            if self.closed:
                raise ApiError(503, "backend_closed", "The local codec is shutting down.")
        started = time.perf_counter()
        name = filename_only(filename)
        kind = Path(name).suffix[1:].lower()
        if kind == "json":
            kind = "styk"
        if len(data) > (MAX_DOCUMENT if kind in ("styk", "stkz", "stykmov") else MAX_SOURCE):
            raise ApiError(413, "file_too_large", "This file exceeds the import size limit.")
        if not data:
            raise ApiError(400, "empty_file", "This file is empty.")
        if not isinstance(data, bytes):
            if not isinstance(data, (bytearray, memoryview)):
                raise ApiError(400, "invalid_source", "Import requires binary file bytes.")
            data = bytes(data)  # Leased original bytes must be immutable.
        # STK names become editable figure names, so include the name in its key.
        key_data = data + (name.encode("utf-8") if kind == "stk" else b"")
        source_id = hashlib.sha256(kind.encode("ascii") + b"\0" + key_data).hexdigest()
        with self.lock:
            entry = self.sources.get(source_id)
            retained_entry = self.retained_sources.get(source_id)
            if entry:
                self.sources.move_to_end(source_id)
        # PIV cache identity depends on bytes, not the chosen display filename.
        # Keep the canonical source_path stable across an active lease's LRU
        # eviction, just as ordinary cache hits already do for renamed copies.
        canonical_name = retained_entry.filename if retained_entry is not None else name
        if retained_entry is not None:
            data = retained_entry.data
        cache_hit = entry is not None
        if entry is None:
            # Bounded serialization prevents parallel imports from multiplying
            # decoder peak memory. Editing/playback remains independent in JS.
            with self.decode_lock:
                checkpoint()
                with self.lock:
                    entry = self.sources.get(source_id)
                if entry is None:
                    decode_started = time.perf_counter()
                    validated_payload = None
                    if kind == "piv":
                        if prefer_native:
                            document, validated_payload = fast_decode.decode_for_native_wire(data, source_path=canonical_name, with_payload=True)
                        else:
                            document = piv_codec.decode_piv_bytes(data, source_path=canonical_name)
                    elif kind == "stk":
                        # Only the verified legacy STK parser requires a path.
                        # Its temporary copy is private, bounded, and auto-removed.
                        with tempfile.TemporaryDirectory(prefix="stykanimate-import-") as directory:
                            path = Path(directory) / name
                            path.write_bytes(data)
                            document = bridge.stk_document(path, data)
                    else:
                        document = decoded_json(native_format.decode(data, kind).lstrip(b"\xef\xbb\xbf"))
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
                    entry = Source(source_id, retained_source, packed,
                        retained_entry.digest if retained_entry is not None else None, canonical_name,
                        kind, document["version"], (time.perf_counter() - decode_started) * 1000)
                    entry.native_wire = wire_parts
                    if entry.retained_size > self.max_cache:
                        raise ApiError(413, "cache_limit", "The decoded project exceeds the source cache limit.")
                    with self.lock, jobs.publication():
                        if self.closed:
                            raise ApiError(503, "backend_closed", "The local codec is shutting down.")
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
                    parts = import_wire.native_frame_wire(decoded_json(self._canonical_json(entry)), entry.data, piv_codec._unpack_source, encoded_json)
                    if parts and entry.retained_size + len(parts[0]) + len(parts[1]) <= self.max_cache:
                        with self.lock, jobs.publication():
                            if self.closed:
                                raise ApiError(503, "backend_closed", "The local codec is shutting down.")
                            entry.native_wire = parts
                            self.cache_bytes += len(parts[0]) + len(parts[1])
                            while self.cache_bytes > self.max_cache and len(self.sources) > 1:
                                _, old = self.sources.popitem(last=False)
                                self.cache_bytes -= old.retained_size
        retained = self._retain_source(entry, source_owner) if source_owner is not None else False
        metadata = {"ok": True, "sourceId": source_id,
            "filename": name, "kind": kind, "version": entry.version,
            "timings": {"decode_ms": round(entry.decode_ms, 3), "cache_hit": cache_hit,
                "total_ms": round((time.perf_counter() - started) * 1000, 3),
                "source_bytes": len(data), "document_bytes": len(entry.document_json) if entry.document_json is not None else None}}
        if retained:
            metadata["sourceOwner"] = source_owner
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
        metadata["document"] = decoded_json(packed)
        metadata["timings"]["document_bytes"] = len(packed)
        metadata["timings"]["total_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return metadata

    def export(self, request: dict, *, timings: dict | None = None) -> tuple[bytes, str]:
        checkpoint()
        stage_started = time.perf_counter()
        def mark(stage):
            nonlocal stage_started
            checkpoint()
            now = time.perf_counter()
            if timings is not None:
                timings[stage] = (now - stage_started) * 1000
            stage_started = now
        document = request.get("document")
        if not isinstance(document, dict):
            raise ApiError(400, "invalid_document", "Export requires an editable document.")
        format_name = request.get("format", "piv")
        if format_name not in ("piv", "stk", "styk", "stkz", "stykmov"):
            raise ApiError(415, "unsupported_export", "Export as piv, stk, styk, stkz, or stykmov.")
        bridge.validate_document(document)
        mark("validate")
        if format_name in ("stkz", "stykmov"):
            validate_native_figure(document, format_name)
            output_doc = dict(document)
            output_doc.pop("_stykSource", None)
            output_doc["_styk"] = {**document.get("_styk", {}), "format": "StykAnimate", "format_version": 1}
            output = native_format.encode_v2(output_doc, format_name)
            base = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]', "_", str(request.get("filename") or "Figure")).strip(" .")[:180] or "Figure"
            mark("encode")
            return output, f"{base}.{format_name}"
        source_id = request.get("sourceId")
        entry = self._find_source(source_id) if isinstance(source_id, str) else None
        if source_id and entry is None:
            raise ApiError(410, "source_expired", "The original source expired from memory. Reopen the original file before exporting.")
        if entry and entry.kind in ("piv", "stk") and entry.digest is None:
            self._source_digest(entry)
        mark("source_digest")
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
        mark("provenance")
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
        mark("document_digest")
        if format_name == "styk":
            output_doc = dict(document)
            output_doc["_styk"] = {**document.get("_styk", {}), "format": "StykAnimate", "format_version": 1}
            if entry and entry.kind in ("piv", "stk"):
                import base64
                output_doc["_stykSource"] = {"kind": entry.kind, "version": entry.version,
                    "source_base64": base64.b64encode(entry.data).decode("ascii"),
                    "sha256": hashlib.sha256(entry.data).hexdigest(),
                    "document_sha256": entry.digest, "document_digest_version": 3}
            output = native_format.encode_v2(output_doc, "styk")
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
        mark("encode")
        base = Path(request.get("filename") or (entry.filename if entry else "Untitled")).stem
        base = re.sub(r'[\x00-\x1f\x7f/\\:*?"<>|]', "_", base).strip(" .")[:180] or "Untitled"
        return output, f"{base}.{format_name}"


def session_proof(token: str) -> str | None:
    """Lets the launcher confirm it reached its own process, not another listener
    that took the loopback port first. The digest does not reveal the token."""
    return hashlib.sha256(("styk-session:" + token).encode()).hexdigest() if token else None


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: ProjectStore, web_root: Path, token: str = ""):
        self.store, self.web_root, self.token = store, web_root.resolve(), token
        self.jobs = jobs.JobRegistry()
        super().__init__(address, Handler)

    def server_close(self):
        self.jobs.close()
        super().server_close()
        self.store.close()


class Handler(BaseHTTPRequestHandler):
    server: LocalServer
    protocol_version = "HTTP/1.1"
    server_version = "StykAnimate/1"

    def _job(self):
        return self.server.jobs.enter(self.headers.get("X-Styk-Job-Id"),
            abort_transport=lambda: self.connection.shutdown(socket.SHUT_RDWR))

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

    def _send(self, status: int, data: bytes, content_type: str, *, filename: str | None = None,
              cache_control: str = "no-store", etag: str | None = None, length: int | None = None,
              timings: dict | None = None, request_bytes: int | None = None):
        checkpoint()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data) if length is None else length))
        self.send_header("Cache-Control", cache_control)
        if etag:
            self.send_header("ETag", etag)
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin and origin != "null":
            parts = urlsplit(origin)
            if parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1"):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition, Server-Timing, X-Styk-Request-Bytes")
        for name, value in response_metadata(filename=filename, timings=timings, request_bytes=request_bytes).items():
            self.send_header(name, value)
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
        # Poll without poisoning BufferedReader with socket timeouts. read1 first
        # consumes any bytes prefetched alongside the headers; select only waits
        # when that buffer and the socket have no data. BytesIO avoids a retained
        # list of chunks and its final immutable value becomes the request body.
        self.connection.setblocking(False)
        body, remaining, deadline = io.BytesIO(), length, time.monotonic() + 60
        try:
            while remaining:
                checkpoint()
                chunk = self.rfile.read1(min(256 * 1024, remaining))
                if not chunk:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("The upload stopped sending data.")
                    if not select.select([self.connection], [], [], .05)[0]:
                        continue
                    checkpoint()
                    chunk = self.rfile.read1(min(256 * 1024, remaining))
                    if not chunk:
                        raise ApiError(400, "truncated_upload", "The upload ended before the complete file arrived.")
                body.write(chunk)
                remaining -= len(chunk)
                deadline = time.monotonic() + 60
            checkpoint()
            return body.getvalue()
        finally:
            self.connection.settimeout(60)

    def _handle_error(self, exc: Exception):
        # Unconsumed bodies must never become a subsequent HTTP request.
        self.close_connection = True
        status, payload = error_response(exc)
        self._json(status, payload)

    def do_OPTIONS(self):
        try:
            self._check_request(auth=False)
            self.send_response(204)
            if self.headers.get("Origin"):
                self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Styk-Job-Id, X-Styk-Source-Owner")
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
                self._json(200, health_payload(self.server.jobs.snapshot(), session_proof(self.server.token)))
            elif parsed.path == "/api/samples":
                self._json(200, {"ok": True, "samples": self.server.store.samples()})
            elif parsed.path == "/api/source":
                with self._job():
                    source_id = parse_qs(parsed.query).get("id", [""])[0]
                    self._send(200, source_record_payload(self.server.store, source_id), "application/octet-stream")
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
                # App resources are public static files: let the browser hold the
                # bytes and answer revalidation with 304 instead of re-reading and
                # re-sending every module on each worker spawn or reload.
                stat = target.stat()
                etag = '"%x-%x"' % (stat.st_mtime_ns, stat.st_size)
                candidates = {token.strip().removeprefix("W/") for token in self.headers.get("If-None-Match", "").split(",")}
                if "*" in candidates or etag in candidates:
                    self._send(304, b"", mime, cache_control="no-cache", etag=etag, length=stat.st_size)
                    return
                self._send(200, target.read_bytes(), mime, cache_control="no-cache", etag=etag)
        except ConnectionError:
            self.close_connection = True
        except Exception as exc:
            try:
                self._handle_error(exc)
            except ConnectionError:
                self.close_connection = True

    def do_POST(self):
        try:
            self._check_request()
            parsed = urlsplit(self.path)
            if parsed.path == "/api/cancel":
                self._body(0)
                self.server.jobs.cancel(parse_qs(parsed.query).get("id", [""])[0])
                self._send(204, b"", "application/json")
                return
            if parsed.path == "/api/source/release":
                # Small ownership cleanup cannot be rejected just because the
                # memory-heavy import/export queue is full.
                request = decoded_json(self._body(4096))
                if not isinstance(request, dict):
                    raise ApiError(400, "invalid_request", "The request must be a JSON object.")
                owner_id = self.server.store._source_owner(request.get("ownerId"))
                if "jobId" in request:
                    # Cancellation and lease removal share one acknowledged
                    # control request. Publication is ordered by JobRegistry's
                    # condition: a completed lease is removed; a still-pending
                    # import cannot publish after this cancellation barrier.
                    self.server.jobs.cancel(request["jobId"])
                self.server.store.release_source(owner_id)
                self._send(204, b"", "application/json")
                return
            if parsed.path not in ("/api/import", "/api/open", "/api/export", "/api/source/retain"):
                raise ApiError(404, "route_not_found", "Unknown codec endpoint.")
            with self._job():
                self._project_post(parsed)
        except ConnectionError:
            self.close_connection = True
        except Exception as exc:
            try:
                self._handle_error(exc)
            except ConnectionError:
                self.close_connection = True

    def _project_post(self, parsed):
        # Admission precedes reading/parsing large uploads. The control endpoint
        # and health remain independent of the single memory-heavy work slot.
        if parsed.path == "/api/import":
            name = parse_qs(parsed.query).get("filename", ["imported.piv"])[0]
            result = self.server.store.import_bytes(self._body(import_size_limit(name)), name, as_json=True,
                prefer_native=import_wire.CONTENT_TYPE in self.headers.get("Accept", ""),
                source_owner=self.headers.get("X-Styk-Source-Owner"))
            self._send(200, result, import_wire.CONTENT_TYPE if result.startswith(import_wire.MAGIC) else "application/json; charset=utf-8")
        elif parsed.path == "/api/source/retain":
            request = decoded_json(self._body(4096))
            if not isinstance(request, dict):
                raise ApiError(400, "invalid_request", "The request must be a JSON object.")
            retained = self.server.store.retain_source(request.get("sourceId"), request.get("ownerId"))
            self._json(200, {"ok": True, "retained": retained})
        elif parsed.path in ("/api/open", "/api/export"):
            started = time.perf_counter()
            body = self._body(MAX_DOCUMENT)
            checkpoint()
            request_bytes = len(body)
            received = time.perf_counter()
            request = decoded_json(body)
            timings = {"receive": (received - started) * 1000, "parse": (time.perf_counter() - received) * 1000}
            del body
            if not isinstance(request, dict):
                raise ApiError(400, "invalid_request", "The request must be a JSON object.")
            if parsed.path == "/api/open":
                result = self.server.store.open(request.get("path"), as_json=True,
                    prefer_native=import_wire.CONTENT_TYPE in self.headers.get("Accept", ""),
                    source_owner=self.headers.get("X-Styk-Source-Owner"))
                self._send(200, result, import_wire.CONTENT_TYPE if result.startswith(import_wire.MAGIC) else "application/json; charset=utf-8")
            else:
                data, name = self.server.store.export(request, timings=timings)
                timings["total"] = (time.perf_counter() - started) * 1000
                self._send(200, data, "application/octet-stream", filename=name, timings=timings, request_bytes=request_bytes)
        else:
            raise ApiError(404, "route_not_found", "Unknown codec endpoint.")


def stop_when_stdin_closes(server: LocalServer) -> None:
    """Shut down once whoever spawned us closes our standard input.

    The desktop app holds a pipe to this process for its whole life. The OS
    closes that pipe when the app exits by any route (quit, crash, SIGKILL,
    out-of-memory kill, compositor crash), so the codec, whose caches can hold
    hundreds of MiB, never outlives it. Data on the pipe is ignored; only EOF
    matters. Opt-in: a server started from a terminal keeps its stdin.
    """
    def watch() -> None:
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except (OSError, ValueError):
            pass
        # A stuck request must not keep an orphan alive.
        backstop = threading.Timer(5.0, os._exit, args=(0,))
        backstop.daemon = True
        backstop.start()
        server.shutdown()
    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "localhost"])
    parser.add_argument("--port", default=47831, type=int)
    parser.add_argument("--workspace", type=Path, default=WORKSPACE)
    parser.add_argument("--static-root", type=Path, default=Path(os.environ.get("STYK_WEB_ROOT", APP)))
    parser.add_argument("--token", default=os.environ.get("STYK_API_TOKEN", ""))
    parser.add_argument("--exit-on-stdin-close", action="store_true",
                        help="stop when the parent closes standard input (set by the desktop app)")
    args = parser.parse_args()
    server = LocalServer((args.host, args.port), ProjectStore(args.workspace), args.static_root, args.token)
    if args.exit_on_stdin_close:
        stop_when_stdin_closes(server)
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

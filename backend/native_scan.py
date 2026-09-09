"""Optional portable C++ PIV frame validator, with no Python pose allocation.

Only immutable byte buffers cross the ABI; the library writes into a bounded
caller-owned duration array and fixed result structure. No native allocation is
returned to Python. An absent/incompatible library uses the Python fallback.
"""
from __future__ import annotations

import ctypes
import hashlib
import os
from pathlib import Path
import platform
import struct
import sys
import threading

from piv_codec import PivError

ROOT = Path(__file__).resolve().parents[1]
_lock = threading.Lock()
_library = None
_attempted = False
_status = {"available": False, "reason": "not loaded"}


class ScanResult(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ("end_offset", "error_offset", "pose_bytes")] + [
        (name, ctypes.c_uint32) for name in ("frame_count", "error_frame", "error_object", "error_code")]


def architecture():
    machine = platform.machine().lower()
    if ctypes.sizeof(ctypes.c_void_p) == 4:
        return "x86"
    return {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine, machine)


def library_name():
    if sys.platform == "win32":
        return "styk-piv-frame-scan.dll"
    return "libstyk-piv-frame-scan.dylib" if sys.platform == "darwin" else "libstyk-piv-frame-scan.so"


def _load():
    global _library, _attempted, _status
    if os.environ.get("STYK_DISABLE_NATIVE_SCAN") == "1":
        return None
    with _lock:
        if _attempted:
            return _library
        _attempted = True
        explicit = os.environ.get("STYK_NATIVE_SCAN_LIBRARY")
        candidates = [Path(explicit)] if explicit else [
            ROOT / "native" / "bin" / architecture() / library_name(),
            Path(getattr(sys, "_MEIPASS", ROOT)) / "native" / library_name(),
            Path(sys.executable).resolve().parent / "native" / library_name()]
        for candidate in candidates:
            if not candidate.is_file():
                continue
            try:
                library = ctypes.CDLL(str(candidate.resolve()))
                library.styk_piv_scan_abi.argtypes = []
                library.styk_piv_scan_abi.restype = ctypes.c_uint32
                library.styk_piv_scan_result_size.argtypes = []
                library.styk_piv_scan_result_size.restype = ctypes.c_uint32
                if library.styk_piv_scan_abi() != 1 or library.styk_piv_scan_result_size() != ctypes.sizeof(ScanResult):
                    raise ValueError("Native PIV scanner ABI mismatch")
                library.styk_piv_scan.argtypes = [ctypes.c_char_p, ctypes.c_uint64, ctypes.c_uint64,
                    ctypes.c_char_p, ctypes.c_uint64, ctypes.c_uint32, ctypes.c_uint64,
                    ctypes.POINTER(ctypes.c_uint16), ctypes.c_uint32, ctypes.POINTER(ScanResult)]
                library.styk_piv_scan.restype = ctypes.c_uint32
                digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
                _status = {"available": True, "path": str(candidate.resolve()), "abi": 1, "sha256": digest}
                _library = library
                return library
            except (OSError, AttributeError, ValueError) as error:
                _status = {"available": False, "path": str(candidate), "reason": str(error)}
        if _status.get("reason") == "not loaded":
            _status = {"available": False, "reason": "native library is not installed"}
        return None


def status():
    _load()
    return dict(_status) if os.environ.get("STYK_DISABLE_NATIVE_SCAN") != "1" else {
        "available": False, "reason": "disabled by STYK_DISABLE_NATIVE_SCAN"}


def _metadata(figures):
    pieces = [struct.pack("<I", len(figures))]
    for figure in figures:
        count, tid = figure["segment_count"], figure["figure_type_id"]
        if not isinstance(count, int) or not 0 < count <= 30000 or not isinstance(tid, int) or not 0 < tid <= 65535:
            raise PivError("Invalid native scanner figure metadata")
        handles = [0, *(segment["segment_id"] for segment in figure["segments"])]
        if len(handles) != count+1:
            raise PivError("Invalid native scanner handle count")
        media = bool(figure.get("image_assets") or figure.get("text_assets"))
        try:
            pieces.append(struct.pack(f"<HHBBH{len(handles)}H", tid, count, media, 0, len(handles), *handles))
        except struct.error as error:
            raise PivError("Invalid native scanner handle metadata") from error
    return b"".join(pieces)


_ERRORS = {1: "Unexpected EOF", 2: "Implausible keyframe count", 4: "Unknown background",
    5: "Unknown figure type", 6: "Non-finite pose or camera", 7: "Object IDs must be unique and sorted as signed integers",
    8: "Cannot interpolate a changed figure type", 9: "Invalid joined object slot",
    10: "Unknown joined target handle", 11: "Cyclic object joins", 12: "Invalid object draw-order permutation",
    13: "Invalid native scanner definition metadata", 14: "Invalid native scanner output capacity",
    15: "Native scanner allocation failed", 16: "Native scanner internal failure"}


def scan_keyframes(reader, figures, bg_slots, *, max_pose_bytes):
    """Return validated duration shells, or None when the accelerator is absent."""
    library = _load()
    if library is None:
        return None
    data, start = reader.data, reader.pos
    if not isinstance(data, bytes):
        # Reader payloads are immutable bytes in production. Do not hand native
        # code a mutable buffer another request could change while GIL is free.
        data = bytes(data)
    if not isinstance(start, int) or start < 0 or start+4 > len(data):
        raise PivError(f"Unexpected EOF at payload offset {start:#x}")
    if isinstance(max_pose_bytes, bool) or not isinstance(max_pose_bytes, int) or not 0 <= max_pose_bytes <= 0xFFFFFFFFFFFFFFFF:
        raise ValueError("Native pose budget must be a nonnegative uint64 integer")
    count = struct.unpack_from("<I", data, start)[0]
    if count > 1000000:
        reader.pos = start + 4
        raise PivError(f"Implausible keyframe count {count} at {start:#x}")
    if count * 512 > max_pose_bytes:
        reader.pos = start + 4
        raise PivError(f"Native scene exceeds the {max_pose_bytes // (1024 * 1024)} MiB pose budget")
    metadata = _metadata(figures)
    durations = (ctypes.c_uint16 * count)()
    result = ScanResult()
    error = library.styk_piv_scan(data, len(data), start, metadata, len(metadata), bg_slots,
        max_pose_bytes, durations, count, ctypes.byref(result))
    reader.pos = result.end_offset
    if error:
        message = (f"Native scene exceeds the {max_pose_bytes // (1024 * 1024)} MiB pose budget" if error == 3
            else _ERRORS.get(error, "Unknown native scanner failure"))
        where = f" at payload offset {result.error_offset:#x}"
        if result.error_frame != 0xFFFFFFFF:
            where += f", frame {result.error_frame}"
        if result.error_object != 0xFFFFFFFF:
            where += f", object {result.error_object}"
        raise PivError(message + where)
    if result.frame_count != count or not start+4 <= result.end_offset <= len(data):
        raise PivError("Invalid native scanner output bounds")
    return [{"duration_raw": duration, "objects": []} for duration in durations]

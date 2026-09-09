#!/usr/bin/env python3
"""Profile one import without repeating the expensive decode or retaining its scene.

Run from the app directory:
    python backend/profile_import.py "C:/path/to/project.piv" --out artifacts/import-profile.json

Wrappers measure production stages; optional cProfile provides deterministic call
counts but substantially inflates Python stages relative to the C JSON encoder.
The default sampling thread never traverses scene data. All patches are local to
this diagnostic process and restored before exit.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
import cProfile
import ctypes
import gc
import hashlib
import json
import platform
from pathlib import Path
import pstats
import sys
import threading
import time

import server


def memory_snapshot():
    if sys.platform == "win32":
        class Counters(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                *[(name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize",
                "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        process = ctypes.windll.kernel32.GetCurrentProcess
        process.restype = ctypes.c_void_p
        get_info = ctypes.windll.psapi.GetProcessMemoryInfo
        get_info.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
        if not get_info(process(), ctypes.byref(counters), counters.cb):
            raise ctypes.WinError()
        return {"working_set_bytes": counters.WorkingSetSize,
            "peak_working_set_bytes": counters.PeakWorkingSetSize,
            "private_bytes": counters.PrivateUsage, "peak_private_bytes": counters.PeakPagefileUsage}
    try:
        import resource
        units = 1 if sys.platform == "darwin" else 1024
        return {"peak_working_set_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * units}
    except ImportError:
        return {}


class Measurements:
    def __init__(self):
        self.stages = {}
        self.active = []
        self.patches = []
        self.top = Counter()
        self.inclusive = Counter()
        self.sampled_stages = Counter()
        self.samples = 0
        self.main_ident = threading.get_ident()
        self.done = threading.Event()
        self.document = {}
        self.origin = time.perf_counter()

    @contextmanager
    def stage(self, name):
        row = self.stages.setdefault(name, {"calls": 0, "wall_ms": 0, "cpu_ms": 0,
            "first_start_ms": None, "last_end_ms": None, "memory_before": None, "memory_after": None})
        before_memory = memory_snapshot()
        before, cpu = time.perf_counter(), time.thread_time()
        if row["first_start_ms"] is None:
            row["first_start_ms"] = (before - self.origin) * 1000
            row["memory_before"] = before_memory
        self.active.append(name)
        try:
            yield
        finally:
            elapsed = (time.perf_counter() - before) * 1000
            row["wall_ms"] += elapsed
            row["cpu_ms"] += (time.thread_time() - cpu) * 1000
            row["calls"] += 1
            row["last_end_ms"] = (time.perf_counter() - self.origin) * 1000
            self.active.pop()
            row["memory_after"] = memory_snapshot()

    def patch(self, owner, attribute, name, *, observe=None):
        original = getattr(owner, attribute)
        def measured(*args, **kwargs):
            with self.stage(name):
                value = original(*args, **kwargs)
            if observe:
                with self.stage("diagnostic.document_summary"):
                    observe(value)
            return value
        setattr(owner, attribute, measured)
        self.patches.append((owner, attribute, original))

    def install(self):
        def observe(document):
            self.document = {"version": document["version"],
                "figure_types": len(document["figure_types"]), "keyframes": len(document["keyframes"]),
                "definition_segments": sum(len(figure["segments"]) for figure in document["figure_types"]),
                "objects": sum(len(frame["objects"]) for frame in document["keyframes"]),
                "pose_values": sum(len(obj.get(field, [])) for frame in document["keyframes"]
                    for obj in frame["objects"] for field in ("angles", "lengths", "bends")),
                "output_frames": document.get("total_output_frames")}
        self.patch(server.piv_codec, "decode_piv_bytes", "decode_piv_bytes", observe=observe)
        # These top-level grammar functions are infrequent enough to time without
        # instrumenting every scalar read, numeric validation, or list append.
        for name in ("_unpack_source", "_backgrounds", "_keyframes"):
            self.patch(server.piv_codec, name, "decode." + name.lstrip("_"))
        self.patch(server, "compact_media_aliases", "compact_media_aliases")
        self.patch(server.bridge, "validate_document", "validate_document")
        self.patch(server.bridge, "source_bytes", "embedded_source_validation")
        self.patch(server, "Source", "source_cache_record")

        original = server.encoded_json
        def measured_encoding(value, **kwargs):
            name = "document" if isinstance(value, dict) and "keyframes" in value else "metadata"
            with self.stage("encoded_json." + name):
                # Delegate exactly to production: forcing the previous stdlib
                # expression here would hide a compiled encoder optimization.
                return original(value, **kwargs)
        server.encoded_json = measured_encoding
        self.patches.append((server, "encoded_json", original))
        self.patch(server.json, "dumps", "stdlib_json.dumps")
        if getattr(server, "_fast_json", None) is not None:
            self.patch(server._fast_json, "dumps", "orjson.dumps")

    def restore(self):
        for owner, attribute, original in reversed(self.patches):
            setattr(owner, attribute, original)

    def sample(self):
        while not self.done.wait(.01):
            frame = sys._current_frames().get(self.main_ident)
            if frame is None:
                continue
            stack = []
            while frame:
                code = frame.f_code
                if Path(code.co_filename).name != Path(__file__).name:
                    stack.append(f"{code.co_filename}:{frame.f_lineno} ({code.co_name})")
                frame = frame.f_back
            self.samples += 1
            if self.active:
                self.sampled_stages[self.active[-1]] += 1
            if stack:
                self.top[stack[0]] += 1
                self.inclusive.update(set(stack))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path,
        nargs="?", default=Path("C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv"))
    parser.add_argument("--out", type=Path, default=server.APP / "artifacts/backend-akane-profile.json")
    parser.add_argument("--cprofile", action="store_true", help="Enable slower deterministic profiling in the same single import.")
    args = parser.parse_args()
    source_path = args.source.resolve()
    source = source_path.read_bytes()
    store = server.ProjectStore(server.WORKSPACE)
    measurement = Measurements()
    measurement.install()
    sampler = threading.Thread(target=measurement.sample, daemon=True, name="import-profile-sampler")
    profiler = cProfile.Profile() if args.cprofile else None
    gc.collect()
    baseline = memory_snapshot()
    started = time.perf_counter()
    measurement.origin = started
    sampler.start()
    try:
        if profiler:
            profiler.enable()
        response = store.import_bytes(source, source_path.name, as_json=True)
        if profiler:
            profiler.disable()
        elapsed = (time.perf_counter() - started) * 1000
        after = memory_snapshot()
        response_bytes = len(response)
        # Read timings from the tiny metadata suffix, never parse the huge document.
        boundary = response.rfind(b',"ok":true,')
        metadata = json.loads(b"{" + response[boundary + 1:]) if boundary >= 0 else {}
    finally:
        measurement.done.set()
        sampler.join(timeout=1)
        measurement.restore()
    record = next(iter(store.sources.values()))
    top_level = ("decode_piv_bytes", "compact_media_aliases", "validate_document",
        "embedded_source_validation", "encoded_json.document", "source_cache_record", "encoded_json.metadata")
    known_ms = sum(measurement.stages.get(name, {}).get("wall_ms", 0) for name in top_level)
    report = {"source": str(source_path), "source_bytes": len(source),
        "source_sha256": hashlib.sha256(source).hexdigest(), "python": platform.python_version(),
        "platform": platform.platform(), "profiled_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "method": "One production ProjectStore.import_bytes(as_json=True) invocation; transparent stage wrappers calling the selected production JSON encoder, 10ms stack sampler, OS process memory counters.",
        "limitations": ["Stage timings include nested stages; do not sum every row.",
            "Sampler cannot interrupt C code holding the GIL (JSON encoder); use measured stage times for comparisons.",
            "Residual includes source fingerprinting, codec metadata removal, decoded scene destruction, response byte concatenation, and diagnostic bookkeeping.",
            "OS peak memory is cumulative across process lifetime; stage before/after values are process totals.",
            "Excludes file read, HTTP socket transmission, frontend JSON parsing, and scene compilation."],
        "cprofile_enabled": args.cprofile, "document": measurement.document,
        "json_encoder": getattr(server, "JSON_ENCODER", "stdlib"),
        "bridge_validation_calls": measurement.stages.get("validate_document", {}).get("calls", 0),
        "total_ms": elapsed, "top_level_stage_ms": known_ms, "unattributed_ms": elapsed - known_ms,
        "diagnostic_summary_ms": measurement.stages.get("diagnostic.document_summary", {}).get("wall_ms", 0),
        "document_json_bytes": len(record.document_json), "response_bytes": response_bytes,
        "cache_retained_bytes": store.cache_bytes, "api_timings": metadata.get("timings"),
        "memory_before": baseline, "memory_after": after, "stages": measurement.stages,
        "sampling": {"samples": measurement.samples, "stage_samples": dict(measurement.sampled_stages),
            "top_lines": [{"location": line, "samples": count} for line, count in measurement.top.most_common(30)],
            "inclusive_lines": [{"location": line, "samples": count} for line, count in measurement.inclusive.most_common(30)]}}
    if profiler:
        statistics = pstats.Stats(profiler)
        rows = []
        for (filename, line, function), (primitive_calls, total_calls, own, cumulative, callers) in statistics.stats.items():
            rows.append({"location": f"{filename}:{line} ({function})", "primitive_calls": primitive_calls,
                "calls": total_calls, "own_ms": own * 1000, "cumulative_ms": cumulative * 1000})
        report["cprofile"] = sorted(rows, key=lambda row: row["cumulative_ms"], reverse=True)[:50]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"artifact": str(args.out), "total_ms": elapsed,
        "stages_ms": {name: row["wall_ms"] for name, row in measurement.stages.items()},
        "document_json_bytes": len(record.document_json), "unattributed_ms": elapsed - known_ms,
        "memory_before": baseline, "memory_after": after, "document": measurement.document}, indent=2), flush=True)


if __name__ == "__main__":
    main()

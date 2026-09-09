#!/usr/bin/env python3
"""Measure actual first/repeated native saves without retaining duplicate outputs.

python backend/profile_native_save.py "C:/path/to/project.piv" --out artifacts/native-save-profile.json

The process imports once, saves twice, and requires identical output fingerprints.
Only diagnostic wrappers are installed; production serialization is not replaced.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
from pathlib import Path
import platform
import time

import server
from profile_import import Measurements, memory_snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="?",
        default=Path("C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv"))
    parser.add_argument("--out", type=Path,
        default=server.APP / "artifacts/backend-akane-native-save-profile.json")
    args = parser.parse_args()
    source_path = args.source.resolve()
    source = source_path.read_bytes()
    source_sha256 = hashlib.sha256(source).hexdigest()
    store = server.ProjectStore(server.WORKSPACE)
    measurements = Measurements()
    phase = "import"

    def wrap(owner, attribute, name):
        original = getattr(owner, attribute)
        def measured(*arguments, **options):
            with measurements.stage(phase + "." + name):
                return original(*arguments, **options)
        setattr(owner, attribute, measured)
        measurements.patches.append((owner, attribute, original))

    wrap(server.piv_codec, "decode_piv_bytes", "decode_piv_bytes")
    wrap(server.bridge, "validate_document", "validate_document")
    wrap(server.bridge, "source_bytes", "embedded_source_validation")
    wrap(server, "document_digest", "document_digest")
    wrap(server, "encoded_json", "encoded_json")
    wrap(server.json, "loads", "json.loads")
    wrap(server.json, "dumps", "stdlib_json.dumps")
    if getattr(server, "_fast_json", None) is not None:
        wrap(server._fast_json, "dumps", "orjson.dumps")
    memory_before = memory_snapshot()
    phases = []
    try:
        started = time.perf_counter()
        # The dict API supplies an editable scene for subsequent in-process
        # saves. Its JSON rehydration is measured separately from binary decode.
        imported = store.import_bytes(source, source_path.name)
        import_ms = (time.perf_counter() - started) * 1000
        document = imported["document"]
        request = {"document": document, "sourceId": imported["sourceId"],
            "format": "styk", "filename": source_path.stem}
        document["_styk"] = {"format": "StykAnimate", "format_version": 1, "name": source_path.stem}
        phases.append({"phase": phase, "total_ms": import_ms, "timings": imported["timings"],
            "memory_after": memory_snapshot()})
        for phase in ("first_save", "second_save"):
            gc.collect()
            before = memory_snapshot()
            started = time.perf_counter()
            output, filename = store.export(request)
            elapsed = (time.perf_counter() - started) * 1000
            row = {"phase": phase, "total_ms": elapsed, "filename": filename,
                "output_bytes": len(output), "output_sha256": hashlib.sha256(output).hexdigest(),
                "memory_before": before, "memory_after": memory_snapshot(),
                "digest_calls": measurements.stages.get(phase + ".document_digest", {}).get("calls", 0)}
            phases.append(row)
            del output  # Do not retain the first 200+ MB file while saving again.
        first, second = phases[1:]
        if (first["output_bytes"], first["output_sha256"]) != (second["output_bytes"], second["output_sha256"]):
            raise AssertionError("First and repeated native exports produced different bytes.")
        if first["digest_calls"] != 1 or second["digest_calls"] != 0:
            raise AssertionError("Native saves should fingerprint the original source once and skip subsequent digests.")
    finally:
        measurements.restore()
    report = {"source": str(source_path), "source_bytes": len(source), "source_sha256": source_sha256,
        "profiled_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": platform.python_version(), "platform": platform.platform(),
        "json_encoder": getattr(server, "JSON_ENCODER", "stdlib"),
        "method": "One actual ProjectStore import followed by two actual native saves; transparent stage wrappers and OS memory counters. Each output is hashed and released before the next save.",
        "limitations": ["Import uses the dict API and includes separately measured JSON rehydration to supply the editable document.",
            "Stage timings are nested; do not sum every row.",
            "Save total excludes output hashing, collection before each save, HTTP input parsing/transmission, and desktop filesystem writes.",
            "OS peak memory is cumulative across process lifetime."],
        "document": {"version": document["version"], "figure_types": len(document["figure_types"]),
            "keyframes": len(document["keyframes"]),
            "objects": sum(len(frame["objects"]) for frame in document["keyframes"])},
        "checks": {"identical_native_output": True, "first_save_source_digest_calls": first["digest_calls"],
            "second_save_source_digest_calls": second["digest_calls"], "outputs_not_retained_together": True},
        "memory_before": memory_before, "phases": phases, "stages": measurements.stages}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"artifact": str(args.out), "checks": report["checks"],
        "phases": phases, "stages_ms": {name: row["wall_ms"] for name, row in measurements.stages.items()}}, indent=2), flush=True)


if __name__ == "__main__":
    main()

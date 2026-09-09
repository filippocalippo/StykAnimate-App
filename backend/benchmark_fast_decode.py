"""Compare decoded schema and isolated frame-reader timings on a real project.

This is a CPU-only component diagnostic. It excludes HTTP, browser transfer,
rendering and input latency; it must not be presented as desktop import latency.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import time

import server
import fast_decode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path, default=Path("artifacts/backend-fast-decode.json"))
    args = parser.parse_args()
    source = args.source.read_bytes()
    spec = importlib.util.spec_from_file_location("canonical_piv_benchmark", server.TOOLS / "piv_codec.py")
    codec = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(codec)
    codec.Reader = server.FastReader
    original = codec._keyframes
    enabled_before = gc.isenabled()
    rows = []
    expected_digest = None
    try:
        for mode, frame_decoder, collect in (("canonical", original, True),
                ("batched", fast_decode.read_keyframes, True),
                ("batched-no-cyclic-gc", fast_decode.read_keyframes, False)):
            gc.collect()
            gc.enable() if collect else gc.disable()
            collections, start_gc = [], {}
            def observe_gc(phase, info):
                generation = info["generation"]
                if phase == "start":
                    start_gc[generation] = time.perf_counter()
                else:
                    collections.append((time.perf_counter() - start_gc[generation]) * 1000)
            gc.callbacks.append(observe_gc)
            codec._keyframes = frame_decoder
            try:
                started = time.perf_counter()
                document = codec.decode_piv_bytes(source, source_path=args.source.name)
                decode_ms = (time.perf_counter() - started) * 1000
            finally:
                gc.callbacks.remove(observe_gc)
            started = time.perf_counter()
            packed = server.encoded_json(document, validated=True)
            encode_ms = (time.perf_counter() - started) * 1000
            digest = hashlib.sha256(packed).hexdigest()
            if expected_digest is None:
                expected_digest = digest
            if digest != expected_digest:
                raise AssertionError(f"Full decoded schema differs in {mode}")
            row = {"mode": mode, "decode_ms": decode_ms, "encode_ms": encode_ms,
                "gc_ms": sum(collections), "gc_count": len(collections),
                "decoded_json_bytes": len(packed), "decoded_json_sha256": digest,
                "schema_identical": True, "frames": len(document["keyframes"]),
                "objects": sum(len(frame["objects"]) for frame in document["keyframes"])}
            rows.append(row)
            print(json.dumps(row), flush=True)
            del packed, document
    finally:
        gc.enable() if enabled_before else gc.disable()
    report = {"source": str(args.source.resolve()), "source_sha256": hashlib.sha256(source).hexdigest(),
        "python": platform.python_version(), "platform": platform.platform(),
        "method": "One decode per reader in one process, source bytes read before timing; exact full JSON byte digest equality.",
        "limitations": ["Component diagnostic, not desktop import latency.",
            "Sequential allocation state may differ; matched cold desktop testing is required."], "runs": rows}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

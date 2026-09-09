#!/usr/bin/env python3
"""Measure original vs bulk-reader codec and end-to-end cached imports."""
import argparse
import gc
import importlib.util
import json
from pathlib import Path
import platform
import statistics
import time

import server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=server.APP / "artifacts/backend-import-benchmark.json")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("reference_piv_codec", server.TOOLS / "piv_codec.py")
    reference = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reference)
    paths = ["Pivot Animator v5/Animations/tween_camera.piv", "Pivot Animator v5/Animations/tween_demo.piv",
        "Goku_Broly_Movie_by_Killer1.piv", "PIVOT ANIMATOR SCENE TEST/Shroobs_JJK_Pack.piv"]
    report = {"python": platform.python_version(), "platform": platform.platform(),
        "scope": "Wall-clock milliseconds, local Python process. Three warm parser samples. Import includes validation and JSON encoding; source digest is deferred to export. Wire preparation avoids redundant JSON parsing/serialization. Excludes HTTP transmission and frontend compilation.",
        "results": []}
    for relative in paths:
        path = server.WORKSPACE / relative
        source = path.read_bytes()
        row = {"path": relative, "source_bytes": len(source)}
        for name, decoder in (("reference", reference.decode_piv_bytes), ("bulk_reader", server.piv_codec.decode_piv_bytes)):
            measurements = []
            for _ in range(3):
                gc.collect()
                start = time.perf_counter()
                document = decoder(source)
                measurements.append((time.perf_counter() - start) * 1000)
                row.update(version=document["version"], figure_types=len(document["figure_types"]),
                    keyframes=len(document["keyframes"]),
                    segments=sum(len(f["segments"]) for f in document["figure_types"]))
                del document
            row[name + "_ms"] = round(statistics.median(measurements), 3)
        store = server.ProjectStore(server.WORKSPACE)
        for kind in ("first_import", "cached_import"):
            start = time.perf_counter()
            result = store.import_bytes(source, path.name, as_json=True)
            elapsed = (time.perf_counter() - start) * 1000
            row[kind] = json.loads(result)["timings"]
            row[kind]["response_prepared_ms"] = round(elapsed, 3)
        row["parser_speedup"] = round(row["reference_ms"] / row["bulk_reader_ms"], 2)
        report["results"].append(row)
        print(json.dumps(row), flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

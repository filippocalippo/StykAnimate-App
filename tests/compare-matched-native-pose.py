"""Compare saved native world nodes to each matched desktop pointer trial."""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def native_nodes(scene):
    return {(obj["unique_id"], index): (node["x"], node["y"])
            for obj in scene["objects"] for index, node in enumerate(obj["nodes"])}


def app_nodes(nodes):
    result = {(node["uid"], node["vertex"]): (node["x"], node["y"]) for node in nodes}
    assert len(result) == len(nodes), "Duplicate application node identity"
    return result


def compare(reference, actual, scale):
    assert reference.keys() == actual.keys(), "Native/application node identities differ"
    differences = [abs(reference[key][axis] - actual[key][axis]) for key in reference for axis in (0, 1)]
    assert all(math.isfinite(value) for value in differences)
    maximum = max(differences, default=0)
    assert maximum < 0.0001, f"Native pose mismatch: maximum coordinate error {maximum} world units"
    return {"nodes": len(reference), "maxWorldUnits": maximum,
            "rmsWorldUnits": math.sqrt(sum(value * value for value in differences) / len(differences)),
            "maxPixelsAtMatchedZoom": maximum * scale}


def changed_uids(before, after):
    return sorted({key[0] for key in before if any(abs(before[key][axis] - after[key][axis]) > 0.0001 for axis in (0, 1))})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-trial", type=Path, required=True)
    parser.add_argument("--app-run", type=Path, required=True)
    args = parser.parse_args()
    report = read(args.app_run / "report.json")
    before = native_nodes(read(args.native_trial / "before-scene.json"))
    after = native_nodes(read(args.native_trial / "after-scene.json"))
    expected_changed = changed_uids(before, after)
    assert expected_changed == [460611, 460612, 460615, 460616, 460619, 460622, 460623, 460624, 460626]
    rows = []
    for trial in report["trials"]:
        evidence = read(args.app_run / f"process-{trial['processIndex']}" / f"{trial['id']}-pose-evidence.json")
        assert evidence["sourceSha256"] == report["sourceHashBefore"]
        assert evidence["frameIndex"] == 1478
        app_before, app_after = app_nodes(evidence["before"]["nodes"]), app_nodes(evidence["afterNodes"])
        changed = changed_uids(app_before, app_after)
        assert changed == expected_changed, "Pointer movement changed a different branch"
        rows.append({"trial": trial["id"], "before": compare(before, app_before, report["config"]["scale"]),
                     "after": compare(after, app_after, report["config"]["scale"]), "changedUIDs": changed})
    output = args.app_run / "native-pose-comparison.json"
    output.write_text(json.dumps({"status": "passed", "nativeTrial": str(args.native_trial),
                                  "sourceSha256": report["sourceHashBefore"], "trials": rows}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "passed", "trials": len(rows), "nodesPerPose": len(before),
                      "maxWorldUnits": max(row[side]["maxWorldUnits"] for row in rows for side in ["before", "after"]), "report": str(output)}))


if __name__ == "__main__":
    main()

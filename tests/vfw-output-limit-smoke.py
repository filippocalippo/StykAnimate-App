"""Verify the production native AVI byte cap without supplying the full declared stream."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    # Each uncompressed frame is 48 MiB. Five fit; the sixth crosses 256 MiB.
    raw = bytes(4096 * 4096 * 3)
    results = []
    for architecture in ["x86", "x64"]:
        target = args.output / f"{architecture}-oversized.avi"
        helper = ROOT / "native/bin" / architecture / "styk-vfw.exe"
        process = subprocess.Popen([str(helper), "--encode", str(target.resolve()), "0", "4096", "4096", "30", "1", "100", "-1", "0", "0"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        messages = []
        try:
            ready = json.loads(process.stdout.readline())
            assert ready["type"] == "ready" and ready["frameBytes"] == len(raw), ready
            for index in range(6):
                process.stdin.write(raw)
                process.stdin.flush()
                message = json.loads(process.stdout.readline())
                messages.append(message)
                if index < 5:
                    assert message["type"] == "frame" and message["index"] == index, message
                else:
                    assert message["type"] == "error" and message["code"] == "OUTPUT_LIMIT", message
            # No EOF and no remaining 94 frames are needed to reject this file.
            assert process.wait(timeout=10) == 1
            assert not target.exists(), "Native failure retained a partial AVI"
            results.append({"architecture": architecture, "declaredFrames": 100, "suppliedFrames": 6,
                            "acceptedFrameACKs": 5, "failure": messages[-1], "partialRemoved": True})
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            for stream in [process.stdin, process.stdout, process.stderr]:
                stream.close()
    report = {"status": "passed", "limitBytes": 256 * 1024 * 1024, "trials": results}
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()

"""Exercise actual installed VFW compressors; FFmpeg only decodes the resulting AVI."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def invoke(helper, arguments, data=None, expected=0):
    result = subprocess.run([str(helper), *map(str, arguments)], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    lines = [json.loads(line) for line in result.stdout.decode("utf-8").splitlines() if line]
    assert result.returncode == expected, (arguments, result.returncode, lines, result.stderr.decode("utf-8", errors="replace"))
    return lines


def headers(data):
    start = data.index(b"strh") + 8
    scale, rate, first, length = struct.unpack_from("<IIII", data, start + 20)
    fmt = data.index(b"strf") + 8
    width, height = struct.unpack_from("<ii", data, fmt + 4)
    return {"scale": scale, "rate": rate, "first": first, "frames": length, "width": width, "height": height}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=False)
    ffmpeg = ROOT / "build/video-encoder/ffmpeg.exe"
    width, height, frames = 160, 92, 3
    colors = [((255, 0, 0), (0, 0, 255)), ((0, 255, 0), (255, 255, 0)), ((0, 255, 255), (255, 0, 255))]
    stride = (width * 3 + 3) & ~3
    raw = b"".join(b"".join(bytes(reversed(pair[0] if y < height // 2 else pair[1])) * width + bytes(stride - width * 3)
                             for y in reversed(range(height))) for pair in colors)
    report = {"encodingAPI": "Windows AVIFile/AVIMakeCompressedStream + installed VFW codecs", "decoder": "FFmpeg independent software decode", "architectures": [], "checks": []}
    for arch in ["x86", "x64"]:
        helper = ROOT / "native/bin" / arch / "styk-vfw.exe"
        listing = invoke(helper, ["--list", width, height])[0]
        assert listing["architecture"] == arch
        assert len({c["handler"] for c in listing["codecs"]}) == len(listing["codecs"]), "Duplicate codec identities"
        report["architectures"].append(listing)
        for codec in listing["codecs"]:
            if not codec["supported"]: continue
            target = args.output / f"{arch}-{codec['handler']:08x}.avi"
            command = ["--encode", target.resolve(), codec["handler"], width, height, 7, 2, frames, 10000 if codec["quality"] else -1, 2 if codec["keyframes"] else 0, 0]
            messages = invoke(helper, command, raw)
            assert messages[0]["type"] == "ready" and messages[0]["frameBytes"] == stride * height
            assert [m["index"] for m in messages if m["type"] == "frame"] == list(range(frames))
            assert messages[-1]["type"] == "complete" and messages[-1]["sizeBytes"] == target.stat().st_size
            meta = headers(target.read_bytes()); assert meta == {"scale": 2, "rate": 7, "first": 0, "frames": frames, "width": width, "height": height}, meta
            decoded = subprocess.run([str(ffmpeg), "-v", "error", "-i", str(target), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True).stdout
            assert len(decoded) == width * height * 3 * frames
            maximum = 0
            for index, pair in enumerate(colors):
                for y, expected in [(height // 4, pair[0]), (height * 3 // 4, pair[1])]:
                    at = (index * width * height + y * width + width // 2) * 3
                    actual = list(decoded[at:at+3]); delta = max(abs(a-b) for a, b in zip(actual, expected)); maximum = max(maximum, delta)
                    assert delta <= 20, (arch, codec["fourcc"], index, y, actual, expected)
            report["checks"].append({"architecture": arch, "handler": codec["handler"], "fourcc": codec["fourcc"], "output": str(target), "headers": meta, "decodedMaxProbeError": maximum, "frameACKs": frames})
        for name, body, code in [("short", raw[:-1], "SHORT_INPUT"), ("extra", raw+b"x", "EXTRA_INPUT")]:
            target = args.output / f"{arch}-{name}.avi"
            messages = invoke(helper, ["--encode", target.resolve(), 0, width, height, 7, 2, frames, -1, 0, 0], body, expected=1)
            assert messages[-1]["code"] == code and not target.exists(), messages
        rejected = invoke(helper, ["--list", 16384, 16384], expected=1)
        assert rejected[-1]["code"] == "DIMENSIONS"
        occupied = args.output / f"{arch}-existing.avi"; occupied.write_bytes(b"preserve me")
        rejected = invoke(helper, ["--encode", occupied.resolve(), 0, width, height, 7, 2, frames, -1, 0, 0], raw, expected=1)
        assert rejected[-1]["code"] == "OUTPUT_FILE" and occupied.read_bytes() == b"preserve me"
    report["status"] = "passed"; (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"status": "passed", "encodes": len(report["checks"]), "report": str(args.output / "report.json")}))


if __name__ == "__main__":
    main()

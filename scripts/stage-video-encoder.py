"""Stage an offline native encoder and its provenance on the target platform."""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def inspect(binary: Path, argument: str) -> str:
    result = subprocess.run([str(binary), argument], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=15,
                            creationflags=0x08000000 if os.name == "nt" else 0)
    if result.returncode:
        raise RuntimeError(f"The native video encoder could not run: {result.stderr[-2000:]}")
    return (result.stdout + result.stderr).strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Explicitly approved local FFmpeg binary; otherwise use the pinned imageio wheel")
    args = parser.parse_args()
    wheel_version = None
    if args.source:
        source = args.source.expanduser().resolve()
    else:
        import imageio_ffmpeg
        wheel_version = importlib.metadata.version("imageio-ffmpeg")
        if wheel_version != "0.6.0":
            raise RuntimeError("Install the pinned build requirements: imageio-ffmpeg==0.6.0")
        source = Path(imageio_ffmpeg.get_ffmpeg_exe()).resolve()
        binary_root = (Path(imageio_ffmpeg.__file__).resolve().parent / "binaries").resolve()
        if binary_root not in source.parents:
            raise RuntimeError("The imageio wheel must contain the native encoder. An external PATH fallback cannot enter a release.")
    if not source.is_file():
        raise RuntimeError("The approved FFmpeg binary is missing.")
    version, license_text, encoders = (inspect(source, option) for option in ("-version", "-L", "-encoders"))
    if "--enable-nonfree" in version:
        raise RuntimeError("Non-redistributable FFmpeg builds cannot enter a desktop package.")
    required_encoders = ["libx264", "mpeg4", "wmv2", "libvpx-vp9"]
    if not all(codec in encoders for codec in required_encoders):
        raise RuntimeError("The staged encoder needs libx264, mpeg4, wmv2 and libvpx-vp9 for the desktop export presets.")
    destination = ROOT / "build" / "video-encoder"
    destination.mkdir(parents=True, exist_ok=True)
    executable = destination / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if not executable.is_file() or hashlib.sha256(executable.read_bytes()).hexdigest() != source_hash:
        shutil.copy2(source, executable)
    if os.name != "nt":
        executable.chmod(0o755)
    for notice in (ROOT / "scripts" / "licenses" / "ffmpeg").iterdir():
        if notice.is_file():
            shutil.copy2(notice, destination / notice.name)
    (destination / "FFMPEG-LICENSE-NOTICE.txt").write_text(license_text + "\n", encoding="utf-8")
    machine = platform.machine().lower()
    architecture = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine, machine)
    manifest = {
        "platform": {"Windows": "win32", "Darwin": "darwin", "Linux": "linux"}[platform.system()],
        "architecture": architecture, "executable": executable.name,
        "sourceFileName": source.name, "imageioFfmpeg": wheel_version,
        "sha256": source_hash, "bytes": executable.stat().st_size, "encoders": required_encoders,
        "versionAndConfiguration": version, "license": "GPL-3.0-or-later" if "--enable-version3" in version else "GPL-2.0-or-later",
        "upstream": "https://ffmpeg.org/", "source": "https://github.com/FFmpeg/FFmpeg",
        "sourceReleases": "https://ffmpeg.org/releases/",
        "binaryPackage": "https://pypi.org/project/imageio-ffmpeg/0.6.0/",
        "binaryBuilds": "https://www.gyan.dev/ffmpeg/builds/" if "gyan.dev" in version else "https://github.com/imageio/imageio-binaries",
        "notice": "The encoder runs as a separate process. Preserve the bundled licenses and the corresponding-source distribution requirements when redistributing this binary.",
    }
    (destination / "build-info.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: manifest[key] for key in ("platform", "architecture", "executable", "sha256", "bytes")}, indent=2))


if __name__ == "__main__":
    main()

"""Build the fixed Windows VFW helper for both installed codec architectures."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def version_key(path):
    try:
        return tuple(map(int, path.name.split(".")))
    except ValueError:
        return ()


def compiler_root(override):
    if override:
        return override.resolve()
    vswhere = Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Microsoft Visual Studio/Installer/vswhere.exe"
    if not vswhere.is_file():
        raise ValueError("Visual Studio discovery is unavailable; pass --msvc with an installed MSVC tool directory")
    installation = subprocess.check_output([str(vswhere), "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], text=True).strip()
    versions = sorted((Path(installation) / "VC/Tools/MSVC").glob("*"), key=version_key, reverse=True) if installation else []
    for candidate in versions:
        if all((candidate / "bin/Hostx64" / arch / "cl.exe").is_file() for arch in ["x86", "x64"]):
            return candidate
    raise ValueError("Install Visual Studio C++ x86/x64 build tools or pass --msvc")


def sdk_version(root, override):
    if override:
        return override
    for candidate in sorted((root / "Include").glob("*"), key=version_key, reverse=True):
        if not version_key(candidate):
            continue
        if all((candidate / part).is_dir() for part in ["ucrt", "shared", "um"]) and all((root / "Lib" / candidate.name / part / arch).is_dir() for part in ["ucrt", "um"] for arch in ["x86", "x64"]):
            return candidate.name
    raise ValueError("No complete Windows SDK found; pass --sdk and --sdk-version")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--msvc", type=Path, help="MSVC tool directory; defaults to latest vswhere-discovered C++ toolchain")
    parser.add_argument("--sdk", type=Path, default=Path(os.environ.get("WindowsSdkDir", "C:/Program Files (x86)/Windows Kits/10")))
    parser.add_argument("--sdk-version", help="SDK version; defaults to newest complete installed SDK")
    parser.add_argument("--arch", choices=["x86", "x64", "both"], default="both")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("VFW is a Windows-only native API")
    try:
        args.msvc = compiler_root(args.msvc)
        args.sdk_version = sdk_version(args.sdk, args.sdk_version)
    except (ValueError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    built = []
    for arch in (["x86", "x64"] if args.arch == "both" else [args.arch]):
        binary_dir = args.msvc / "bin/Hostx64" / arch
        include = [args.msvc / "include", *(args.sdk / "Include" / args.sdk_version / part for part in ["ucrt", "shared", "um"])]
        libraries = [args.msvc / "lib" / arch, *(args.sdk / "Lib" / args.sdk_version / part / arch for part in ["ucrt", "um"])]
        for required in [binary_dir / "cl.exe", *include, *libraries]:
            if not required.exists():
                parser.error(f"Required build dependency not found: {required}")
        output = ROOT / "native/bin" / arch
        output.mkdir(parents=True, exist_ok=True)
        command = [str(binary_dir / "cl.exe"), "/nologo", "/std:c++17", "/O2", "/MT", "/EHsc", "/W4", "/WX", "/DUNICODE", "/D_UNICODE",
                   f"/Fe:{output / 'styk-vfw.exe'}", f"/Fo:{output / 'vfw-bridge.obj'}", str(ROOT / "native/vfw-bridge.cpp"), "/link", "/INCREMENTAL:NO",
                   *[f"/LIBPATH:{path}" for path in libraries], "vfw32.lib", "user32.lib", "gdi32.lib", "winmm.lib", "ole32.lib"]
        environment = dict(os.environ, INCLUDE=";".join(map(str, include)), LIB=";".join(map(str, libraries)))
        environment["PATH"] = str(binary_dir) + os.pathsep + environment.get("PATH", "")
        subprocess.run(command, cwd=ROOT, env=environment, check=True)
        executable = output / "styk-vfw.exe"
        built.append({"architecture": arch, "path": executable.relative_to(ROOT).as_posix(), "sha256": sha256(executable), "bytes": executable.stat().st_size})
    manifest_path = ROOT / "native/bin/build-info.json"
    old = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    source_hash = sha256(ROOT / "native/vfw-bridge.cpp")
    retained = []
    if old.get("source", {}).get("sha256") == source_hash:
        for previous in old.get("helpers", []):
            candidate = ROOT / previous.get("path", "")
            if previous.get("architecture") not in [item["architecture"] for item in built] and candidate.is_file() and sha256(candidate) == previous.get("sha256"):
                retained.append(previous)
    manifest = {"schemaVersion": 1, "source": {"path": "native/vfw-bridge.cpp", "sha256": source_hash},
                "toolchain": {"msvc": str(args.msvc), "msvcVersion": args.msvc.name, "sdk": str(args.sdk), "sdkVersion": args.sdk_version, "standard": "c++17", "runtime": "static"},
                "helpers": sorted([*retained, *built], key=lambda item: item["architecture"])}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"built": built, "manifest": str(manifest_path)}))


if __name__ == "__main__":
    main()

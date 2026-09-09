"""Build the optional portable C++ PIV frame validator for the current host.

Windows uses MSVC and a static runtime; Linux/macOS use the host C++ compiler.
The plain Python scanner remains available when no matching library is present.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=["x86", "x64", "arm64"], default={
        "amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(platform.machine().lower(), platform.machine().lower()))
    parser.add_argument("--msvc", type=Path)
    parser.add_argument("--sdk", type=Path, default=Path(os.environ.get("WindowsSdkDir", "C:/Program Files (x86)/Windows Kits/10")))
    parser.add_argument("--sdk-version")
    parser.add_argument("--cxx", default=os.environ.get("CXX", "c++"))
    args = parser.parse_args()
    source = ROOT / "native/piv-frame-scan.cpp"
    output = ROOT / "native/bin" / args.arch
    output.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    if os.name == "nt":
        spec = importlib.util.spec_from_file_location("styk_native_build_tools", ROOT / "scripts/build-vfw-bridge.py")
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        try:
            msvc = helper.compiler_root(args.msvc)
            sdk_version = helper.sdk_version(args.sdk, args.sdk_version)
        except (ValueError, subprocess.SubprocessError) as error:
            parser.error(str(error))
        binaries = msvc / "bin/Hostx64" / args.arch
        includes = [msvc / "include", *(args.sdk / "Include" / sdk_version / part for part in ["ucrt", "shared", "um"])]
        libraries = [msvc / "lib" / args.arch, *(args.sdk / "Lib" / sdk_version / part / args.arch for part in ["ucrt", "um"])]
        for required in [binaries / "cl.exe", *includes, *libraries]:
            if not required.exists():
                parser.error(f"Missing build dependency: {required}")
        library = output / "styk-piv-frame-scan.dll"
        command = [str(binaries / "cl.exe"), "/nologo", "/std:c++17", "/O2", "/MT", "/EHsc", "/W4", "/WX", "/LD",
            f"/Fe:{library}", f"/Fo:{output / 'piv-frame-scan.obj'}", str(source), "/link", "/INCREMENTAL:NO",
            f"/IMPLIB:{output / 'styk-piv-frame-scan.lib'}", *[f"/LIBPATH:{path}" for path in libraries]]
        environment["INCLUDE"] = ";".join(map(str, includes))
        environment["LIB"] = ";".join(map(str, libraries))
        environment["PATH"] = str(binaries) + os.pathsep + environment.get("PATH", "")
        toolchain = {"compiler": str(binaries / "cl.exe"), "msvcVersion": msvc.name,
            "sdkVersion": sdk_version, "runtime": "static", "standard": "c++17"}
    else:
        compiler = shutil.which(args.cxx)
        if not compiler:
            parser.error(f"C++ compiler not found: {args.cxx}")
        host = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(platform.machine().lower(), platform.machine().lower())
        if args.arch != host and sys.platform != "darwin":
            parser.error("Cross compilation requires a target compiler; use --cxx with a matching host or build on the target OS")
        library = output / ("libstyk-piv-frame-scan.dylib" if sys.platform == "darwin" else "libstyk-piv-frame-scan.so")
        command = [compiler, "-std=c++17", "-O3", "-fPIC", "-fvisibility=hidden", "-Wall", "-Wextra", "-Werror",
            "-dynamiclib" if sys.platform == "darwin" else "-shared", str(source), "-o", str(library)]
        if sys.platform == "darwin":
            command += ["-arch", {"x64": "x86_64", "arm64": "arm64"}.get(args.arch, args.arch)]
        toolchain = {"compiler": compiler, "runtime": "system C++ runtime", "standard": "c++17"}
    subprocess.run(command, cwd=ROOT, env=environment, check=True)
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    manifest = {"schemaVersion": 1, "abiVersion": 1, "platform": sys.platform, "architecture": args.arch,
        "source": {"path": source.relative_to(ROOT).as_posix(), "sha256": digest(source)},
        "library": {"path": library.relative_to(ROOT).as_posix(), "sha256": digest(library), "bytes": library.stat().st_size},
        "toolchain": toolchain}
    (output / "frame-scan-build-info.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Freeze the existing Python codecs for the current OS; no runtime install required."""
from __future__ import annotations

import importlib.util
import importlib.metadata
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


def main() -> int:
    app_root = Path(__file__).resolve().parents[1]
    workspace = app_root.parent
    build_deps = app_root / "build" / "python-build-deps"
    if build_deps.is_dir():
        sys.path.insert(0, str(build_deps))
    if importlib.util.find_spec("PyInstaller") is None:
        print("Install build dependencies with: python -m pip install -r scripts/requirements-build.txt", file=sys.stderr)
        return 1
    if importlib.util.find_spec("orjson") is None:
        print("The release codec requires orjson: python -m pip install -r scripts/requirements-build.txt", file=sys.stderr)
        return 1
    import orjson
    if orjson.__version__ != "3.12.0":
        print(f"The pinned release encoder is orjson 3.12.0; found {orjson.__version__}.", file=sys.stderr)
        return 1
    server = app_root / "backend" / "server.py"
    if not server.is_file():
        print(f"Backend entry point missing: {server}", file=sys.stderr)
        return 1
    architecture = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(platform.machine().lower(), platform.machine().lower())
    scanner_manifest = app_root / "native" / "bin" / architecture / "frame-scan-build-info.json"
    if not scanner_manifest.is_file():
        print("Build the native PIV scanner for this host first: npm run build:frame-scan", file=sys.stderr)
        return 1
    scanner = json.loads(scanner_manifest.read_text(encoding="utf-8"))
    scanner_name = "styk-piv-frame-scan.dll" if sys.platform == "win32" else "libstyk-piv-frame-scan.dylib" if sys.platform == "darwin" else "libstyk-piv-frame-scan.so"
    scanner_library = app_root / "native" / "bin" / architecture / scanner_name
    digest = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
    if scanner.get("platform") != sys.platform or scanner.get("architecture") != architecture or scanner.get("abiVersion") != 1 or not scanner_library.is_file() or scanner.get("library", {}).get("sha256") != digest(scanner_library) or scanner.get("source", {}).get("sha256") != digest(app_root / "native" / "piv-frame-scan.cpp"):
        print("The native PIV scanner is stale or built for another host; run npm run build:frame-scan", file=sys.stderr)
        return 1
    command = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
        "--name", "styk-codec", "--console",
        "--distpath", str(app_root / "build" / "sidecar"),
        "--workpath", str(app_root / "build" / "pyinstaller"),
        "--specpath", str(app_root / "build"),
        "--paths", str(workspace / "tools"),
        "--paths", str(workspace / "StykAnimate" / "tools"),
        "--paths", str(app_root / "backend"),
        "--add-binary", str(scanner_library) + os.pathsep + "native",
        "--copy-metadata", "orjson",
    ]
    # The bridge is loaded dynamically. Hidden imports retain its codec and
    # standard-library dependency graph in the standalone interpreter.
    modules = [
        "codec_bridge", "piv_codec", "piv_document", "piv_full_writer",
        "piv_asset_writer", "piv_migrate", "piv_legacy", "piv_legacy_v2",
        "piv_legacy_v4", "piv_side_tables", "pivot_decoder", "pivot_ik", "orjson",
        "fast_decode", "import_wire", "native_scan",
    ]
    for module in modules:
        command.extend(["--hidden-import", module])
    command.append(str(server))
    build_env = dict(os.environ)
    if build_deps.is_dir():
        build_env["PYTHONPATH"] = str(build_deps) + os.pathsep + build_env.get("PYTHONPATH", "")
    build_env["PYINSTALLER_CONFIG_DIR"] = str(app_root / "build" / "pyinstaller-cache")
    result = subprocess.run(command, cwd=app_root, env=build_env, check=False)
    if result.returncode == 0:
        output = app_root / "build" / "sidecar"
        distribution = importlib.metadata.distribution("orjson")
        license_output = output / "THIRD_PARTY" / "orjson"
        license_output.mkdir(parents=True, exist_ok=True)
        for entry in distribution.files or []:
            if "/licenses/" in str(entry).replace("\\", "/"):
                shutil.copyfile(distribution.locate_file(entry), license_output / Path(entry).name)
        manifest = {"platform": sys.platform, "architecture": architecture, "python": platform.python_version(),
                    "orjson": orjson.__version__, "pyinstaller": importlib.metadata.version("PyInstaller"), "nativeScanner": scanner,
                    "runtimeSources": {name: digest(app_root / "backend" / name) for name in ["server.py", "fast_decode.py", "import_wire.py", "native_scan.py"]}}
        (output / "build-info.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"Codec sidecar ready for {sys.platform}: {app_root / 'build' / 'sidecar'}")
        print(f"Bundled encoder: orjson {orjson.__version__}; licenses: {license_output}")
        print("Run npm run dist on this OS to build its desktop installers.")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())

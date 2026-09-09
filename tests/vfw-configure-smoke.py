"""Cancel only owned codec dialogs, save their opaque state, and reuse it in AVI."""
from __future__ import annotations
import argparse
import ctypes as C
from ctypes import wintypes as W
import json
from pathlib import Path
import struct
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=False)
    user = C.WinDLL("user32", use_last_error=True)
    user.CreateWindowExW.argtypes = [W.DWORD, W.LPCWSTR, W.LPCWSTR, W.DWORD, C.c_int, C.c_int, C.c_int, C.c_int, W.HWND, W.HMENU, W.HINSTANCE, W.LPVOID]
    user.CreateWindowExW.restype = W.HWND
    user.GetWindowThreadProcessId.argtypes = [W.HWND, C.POINTER(W.DWORD)]
    user.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
    user.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
    user.GetDlgItem.argtypes = [W.HWND, C.c_int]; user.GetDlgItem.restype = W.HWND
    user.PostMessageW.argtypes = [W.HWND, W.UINT, W.WPARAM, W.LPARAM]
    user.DestroyWindow.argtypes = [W.HWND]
    callback_type = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    user.EnumWindows.argtypes = [callback_type, W.LPARAM]; user.EnumChildWindows.argtypes = [W.HWND, callback_type, W.LPARAM]
    user.PeekMessageW.argtypes = [C.POINTER(W.MSG), W.HWND, W.UINT, W.UINT, W.UINT]
    owner = user.CreateWindowExW(0, "STATIC", "StykAnimate owned VFW test owner", 0x00CF0000, 0, 0, 240, 120, None, None, None, None)
    if not owner: raise C.WinError(C.get_last_error())
    report = {"status": "running", "dialogs": [], "policy": "Only PID-owned codec dialogs receive Cancel; no global keyboard/mouse input."}

    def text(hwnd, api):
        buf = C.create_unicode_buffer(512); api(hwnd, buf, len(buf)); return buf.value

    def pump():
        message = W.MSG()
        while user.PeekMessageW(C.byref(message), None, 0, 0, 1):
            user.TranslateMessage(C.byref(message)); user.DispatchMessageW(C.byref(message))

    try:
        for arch in ["x86", "x64"]:
            helper = ROOT / "native/bin" / arch / "styk-vfw.exe"
            listing = json.loads(subprocess.check_output([str(helper), "--list", "160", "92"]))
            codec = next(c for c in listing["codecs"] if c["supported"] and c["configure"])
            state = (args.output / f"{arch}-state.bin").resolve()
            process = subprocess.Popen([str(helper), "--configure", str(codec["handler"]), "160", "92", str(owner), str(state)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
            record = {"architecture": arch, "codec": codec, "ownedPid": process.pid, "windows": []}; seen = set()
            try:
                deadline = time.monotonic() + 15
                while process.poll() is None and time.monotonic() < deadline:
                    pump()
                    @callback_type
                    def inspect(hwnd, _):
                        pid = W.DWORD(); user.GetWindowThreadProcessId(hwnd, C.byref(pid))
                        if pid.value != process.pid or hwnd in seen: return True
                        title = text(hwnd, user.GetWindowTextW); kind = text(hwnd, user.GetClassNameW)
                        if kind != "#32770": return True
                        controls = []
                        @callback_type
                        def child(control, _):
                            controls.append({"class": text(control, user.GetClassNameW), "text": text(control, user.GetWindowTextW)}); return True
                        user.EnumChildWindows(hwnd, child, 0)
                        cancel = user.GetDlgItem(hwnd, 2)
                        record["windows"].append({"caption": title, "class": kind, "controls": controls, "action": "IDCANCEL" if cancel else "WM_CLOSE"})
                        seen.add(hwnd)
                        user.PostMessageW(hwnd, 0x111 if cancel else 0x10, 2 if cancel else 0, 0)
                        return True
                    user.EnumWindows(inspect, 0); time.sleep(.02)
                stdout, stderr = process.communicate(timeout=2)
                assert process.returncode == 0, (stdout, stderr)
                assert record["windows"], "No owned native codec dialog was observed"
                configured = json.loads(stdout); data = state.read_bytes()
                magic, bits, handler, size = struct.unpack("<8sIII", data[:20])
                assert magic == b"STYKVFW1" and bits == (32 if arch == "x86" else 64) and handler == codec["handler"]
                assert size == len(data) - 20 and 20 <= len(data) <= 1024 * 1024
                output = (args.output / f"{arch}-state-roundtrip.avi").resolve()
                raw = bytes([0, 0, 255]) * (160 * 92) * 3
                encoded = subprocess.run([str(helper), "--encode", str(output), str(handler), "160", "92", "16", "1", "3", "-1", "0", "0", str(state)], input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=True)
                messages = [json.loads(line) for line in encoded.stdout.splitlines()]
                assert [m["index"] for m in messages if m["type"] == "frame"] == [0, 1, 2]
                decoded = subprocess.check_output([str(ROOT / "build/video-encoder/ffmpeg.exe"), "-v", "error", "-i", str(output), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], timeout=15)
                assert len(decoded) == 160 * 92 * 3 * 3 and abs(decoded[0] - 255) <= 20 and max(decoded[1:3]) <= 20
                record.update(configured=configured, stateFileBytes=len(data), frames=3, decodedFirstPixel=list(decoded[:3]), output=str(output)); report["dialogs"].append(record)
            finally:
                if process.poll() is None: process.kill(); process.wait(timeout=5)
        report["status"] = "passed"
    finally:
        user.DestroyWindow(owner); (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"status": report["status"], "dialogs": len(report["dialogs"]), "report": str(args.output / "report.json")}))


if __name__ == "__main__": main()

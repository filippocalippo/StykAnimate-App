"""Inspect and cancel only a codec dialog owned by the supplied test helper PID."""
import ctypes as C
from ctypes import wintypes as W
import json
import sys
import time

parent_mode = sys.argv[1] == '--parent'
pid_expected = int(sys.argv[2] if parent_mode else sys.argv[1])
if pid_expected < 1:
    raise ValueError('A positive owned helper PID is required')
user = C.WinDLL('user32', use_last_error=True)
callback_type = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
user.GetWindowThreadProcessId.argtypes = [W.HWND, C.POINTER(W.DWORD)]
user.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
user.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, C.c_int]
user.GetDlgItem.argtypes = [W.HWND, C.c_int]
user.GetDlgItem.restype = W.HWND
user.PostMessageW.argtypes = [W.HWND, W.UINT, W.WPARAM, W.LPARAM]
user.EnumWindows.argtypes = [callback_type, W.LPARAM]
user.EnumChildWindows.argtypes = [W.HWND, callback_type, W.LPARAM]
if parent_mode:
    kernel = C.WinDLL('kernel32', use_last_error=True)
    class ProcessEntry(C.Structure):
        _fields_ = [('size', W.DWORD), ('usage', W.DWORD), ('pid', W.DWORD), ('heap', C.c_size_t), ('module', W.DWORD), ('threads', W.DWORD), ('parent', W.DWORD), ('priority', W.LONG), ('flags', W.DWORD), ('exe', W.WCHAR * 260)]
    kernel.CreateToolhelp32Snapshot.argtypes = [W.DWORD, W.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = W.HANDLE
    kernel.Process32FirstW.argtypes = [W.HANDLE, C.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [W.HANDLE, C.POINTER(ProcessEntry)]
    kernel.CloseHandle.argtypes = [W.HANDLE]
    parent_pid, pid_expected, deadline = pid_expected, None, time.monotonic() + 5
    while pid_expected is None and time.monotonic() < deadline:
        snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
        try:
            entry = ProcessEntry(); entry.size = C.sizeof(entry)
            exists = kernel.Process32FirstW(snapshot, C.byref(entry))
            while exists:
                if entry.parent == parent_pid and entry.exe.lower() == 'styk-vfw.exe':
                    pid_expected = entry.pid
                    break
                exists = kernel.Process32NextW(snapshot, C.byref(entry))
        finally:
            kernel.CloseHandle(snapshot)
        if pid_expected is None:
            time.sleep(.02)
    if pid_expected is None:
        raise RuntimeError('No codec helper belonging to the isolated Electron process appeared')

def text(hwnd, api):
    buffer = C.create_unicode_buffer(512)
    api(hwnd, buffer, len(buffer))
    return buffer.value

windows = []
deadline = time.monotonic() + 10
while not windows and time.monotonic() < deadline:
    @callback_type
    def inspect(hwnd, _):
        pid = W.DWORD()
        user.GetWindowThreadProcessId(hwnd, C.byref(pid))
        if pid.value != pid_expected or text(hwnd, user.GetClassNameW) != '#32770':
            return True
        controls = []
        @callback_type
        def child(control, _):
            controls.append({'class': text(control, user.GetClassNameW), 'text': text(control, user.GetWindowTextW)})
            return True
        user.EnumChildWindows(hwnd, child, 0)
        cancel = user.GetDlgItem(hwnd, 2)
        windows.append({'pid': pid.value, 'caption': text(hwnd, user.GetWindowTextW), 'controls': controls, 'action': 'IDCANCEL' if cancel else 'WM_CLOSE'})
        user.PostMessageW(hwnd, 0x111 if cancel else 0x10, 2 if cancel else 0, 0)
        return True
    user.EnumWindows(inspect, 0)
    time.sleep(.02)
if not windows:
    raise RuntimeError('No codec dialog belonging to the owned helper appeared')
print(json.dumps({'windows': windows}))

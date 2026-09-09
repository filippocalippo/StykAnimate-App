"""Measure the original Pivot UI player in a newly owned, isolated process.

This drives the real PlayButtonClick and native timer, never the export loop.
QPC timestamps cover engine calls and the native Direct2D/DXGI Present call, not
monitor scanout. Native addresses are accepted only for the reference hash.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
sys.path.insert(0, str(ROOT / "tools"))
import reference_harness as reference

AGENT = r"""
const kernel = Process.getModuleByName('kernel32.dll');
const qpc = new NativeFunction(kernel.getExportByName('QueryPerformanceCounter'), 'bool', ['pointer'], 'stdcall');
const qpf = new NativeFunction(kernel.getExportByName('QueryPerformanceFrequency'), 'bool', ['pointer'], 'stdcall');
const qpcMemory = Memory.alloc(8), frequencyMemory = Memory.alloc(8); qpf(frequencyMemory);
const frequency = Number(frequencyMemory.readS64());
function now() { qpc(qpcMemory); return Number(qpcMemory.readS64()) * 1000 / frequency; }
const getThreadTimes = new NativeFunction(kernel.getExportByName('GetThreadTimes'),'bool',['pointer','pointer','pointer','pointer','pointer'],'stdcall');
const threadTimes = Memory.alloc(32);
function threadCPU() { if(!getThreadTimes(ptr('0xfffffffe'),threadTimes,threadTimes.add(8),threadTimes.add(16),threadTimes.add(24)))return null;return (Number(threadTimes.add(16).readU64())+Number(threadTimes.add(24).readU64()))/10000; }
// Instrument only the window Present callsite, avoiding per-figure COM hooks.
// Static Pivot 5.2.11 disassembly: TCanvasD2D.EndScene, FSwapChain +0xD0.
// SyncInterval=0 and Flags=0 are pushed at 0x7AD75A before vtable Present.
const samples = [], presents = [], renderTargets = [], timerCalls = [];
const presentCalls = new Map();
let running = false, measuring = false, cursorInitialized = false, stopped = false, started = 0, frameOrdinal = 0, lastTick = null, lastFrameEnd = null;
let nativeMetadata = null, frameStarts = [], originalScale = null, zoomCode = null;
const user32=Process.getModuleByName('user32.dll');
Interceptor.attach(at(0x7ad75a), {onEnter(){
  if(!measuring)return;
  const canvas=this.context.ebp.sub(4).readPointer();
  presentCalls.set(this.threadId,{api:'TCanvasD2D.DXGI.Present',tick:lastTick,start:now(),canvas:canvas.toString(),width:canvas.add(0x6c).readU32(),height:canvas.add(0x70).readU32(),syncInterval:0,flags:0});
}});
Interceptor.attach(at(0x7ad76d), {onEnter(){
  const record=presentCalls.get(this.threadId);if(!record)return;
  presentCalls.delete(this.threadId);presents.push({...record,end:now(),result:this.context.eax.toUInt32()});
}});
function matrixAt(p) { return Array.from({length:9},(_,i)=>p.add(i*4).readFloat()); }
function cursorTick(player) { const key=player.add(8).readU32(); return (frameStarts[key]||0)+player.add(12).readU32(); }
function seekPlayer(player,tick) {
  let key=0; while(key+1<frameStarts.length&&frameStarts[key+1]<=tick)key++;
  // Begin at an actual keyframe so the native interpolator initializes its own state.
  player.add(8).writeU32(key);player.add(12).writeU32(0);return frameStarts[key];
}
Interceptor.attach(at(0x9513bc), {
  onEnter() {
    this.active=false;if(!running)return;this.player=this.context.eax;this.canvas=this.context.edx;this.canvasInfo={address:this.canvas.toString(),vmt:this.canvas.readPointer().toString(),width:this.canvas.add(0x6c).readU32(),height:this.canvas.add(0x70).readU32()};
    if(!cursorInitialized){seekPlayer(this.player,cfg.start_tick);cursorInitialized=true;}
    this.tick=cursorTick(this.player);lastTick=this.tick;
    if(this.tick<cfg.start_tick)return;
    this.active=true;if(!measuring){measuring=true;started=now();}
    this.ordinal=frameOrdinal++;
    this.matrix=matrixAt(this.player.add(0x34));this.supersample=this.player.add(0x10).readU8();this.cpuStart=threadCPU();this.start=now();
  },
  onLeave(result) {
    if(!this.active)return;lastFrameEnd=now();const cpuEnd=threadCPU();
    samples.push({tick:this.tick,ordinal:this.ordinal,start:this.start,end:lastFrameEnd,wallMs:lastFrameEnd-this.start,threadCpuMs:this.cpuStart===null||cpuEnd===null?null:cpuEnd-this.cpuStart,matrix:this.matrix,canvas:this.canvasInfo,supersample:this.supersample,hasNext:!!(result.toUInt32()&255),nextCursorTick:safe(()=>cursorTick(this.player))});
    if(this.ordinal+1>=cfg.frames)global(0xb65f9c).add(0x650).writeU8(1);
  }
});
Interceptor.attach(at(0xb2a9a8),{onEnter(){this.active=measuring;if(this.active)this.start=now();},onLeave(){if(this.active)timerCalls.push({start:this.start,end:now(),tick:lastTick});}});
Interceptor.attach(at(0xb2ad68),{onEnter(){this.active=measuring;},onLeave(){if(this.active){stopped=true;measuring=false;running=false;emit('complete',{frames:samples.length});}}});
function exactZoom(image,scale) {
  if(!zoomCode){const memory=Memory.alloc(Process.pageSize);Memory.protect(memory,Process.pageSize,'rwx');const writer=new X86Writer(memory);writer.putMovRegRegOffsetPtr('eax','esp',4);writer.putMovRegRegOffsetPtr('edx','esp',8);writer.putPushReg('edx');writer.putCallAddress(at(0x935dd4));writer.putRet();writer.flush();zoomCode={memory,call:new NativeFunction(memory,'uint',['pointer','float'],'mscdecl')};}
  return zoomCode.call(image,scale);
}
function beginPlayback() {
  nativeMetadata=metadata();frameStarts=[];let tick=0;for(let i=0;i<nativeMetadata.frames.length;i++){frameStarts.push(tick);tick+=i===nativeMetadata.frames.length-1?Number(nativeMetadata.frames[i].duration>0):nativeMetadata.frames[i].duration;}
  if(cfg.start_tick+cfg.frames>tick)throw Error('Requested native range exceeds '+tick+' playback frames');
  const form=global(0xb65f9c),image=form.add(0x6cc).readPointer(),timer=form.add(0x6b4).readPointer();originalScale=image.add(0x3d0).readFloat();
  pglobal(0xb6654c).writeU8(0);exactZoom(image,cfg.scale);call(0xb2ddec,form,form);
  // Native frame count, FPS, scale and source settings remain observable.
  emit('configuration',{metadata:nativeMetadata,totalTicks:tick,scale:image.add(0x3d0).readFloat(),originalScale,matrix:matrixAt(image.add(0x434)),timer:{dueTimeMs:timer.add(0x40).readU32(),intervalMs:timer.add(0x44).readU32()},qpcFrequency:frequency});
  running=true;call(0xb2a7e8,form,form);
}
function onPump(){if(busy||!pending)return;busy=true;const action=pending;pending=null;try{action();}catch(error){emit('error',{message:String(error),stack:error.stack});}finally{busy=false;}}
for(const name of ['PeekMessageW','PeekMessageA']){const address=user32.findExportByName(name);if(address)Interceptor.attach(address,{onEnter:onPump});}
rpc.exports={
  state(){return {parsedFrames,lastFrameParse,finished:stopped,metadata:safe(metadata),frames:samples.length};},
  inspectview(){pending=()=>{const image=global(0xb65f9c).add(0x6cc).readPointer(),bitmap=call(0x69661c,image),canvas=call(0x54fdc8,bitmap);emit('viewport',{width:canvas.add(0x6c).readU32(),height:canvas.add(0x70).readU32()});};return true;},
  start(){pending=beginPlayback;return true;},
  results(){return {started,stopped,samples,presents,renderTargets,timerCalls,presentationHook:'TCanvasD2D.EndScene 0x7AD75A to 0x7AD76D'};}
};
emit('ready',{pid:Process.id,base:base.toString()});
"""


def quantiles(values):
    values = sorted(values)
    return {"count": len(values), "p50": values[len(values) // 2] if values else 0,
            "p95": values[min(len(values) - 1, int(len(values) * .95))] if values else 0,
            "max": values[-1] if values else 0}


def prepare_owned_window(pid, width, height):
    """Restore only this run's main window; never enumerate/control another PID."""
    user = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.IsIconic.argtypes = [wintypes.HWND]
    user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user.SetForegroundWindow.argtypes = [wintypes.HWND]
    user.GetForegroundWindow.restype = wintypes.HWND
    user.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    windows = []

    def inspect(hwnd):
        rect, title = wintypes.RECT(), ctypes.create_unicode_buffer(512)
        user.GetWindowRect(hwnd, ctypes.byref(rect))
        user.GetWindowTextW(hwnd, title, len(title))
        return {"hwnd": int(hwnd), "title": title.value, "rect": [rect.left, rect.top, rect.right, rect.bottom],
                "visible": bool(user.IsWindowVisible(hwnd)), "iconic": bool(user.IsIconic(hwnd))}

    @callback_type
    def callback(hwnd, parameter):
        owner = wintypes.DWORD()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid:
            windows.append(inspect(hwnd))
        return True

    user.EnumWindows(callback, 0)
    candidates = [window for window in windows if window["title"] and window["rect"][2] > window["rect"][0]]
    if not candidates:
        raise RuntimeError("Owned Pivot main window was not found")
    chosen = max(candidates, key=lambda window: (window["rect"][2] - window["rect"][0]) * (window["rect"][3] - window["rect"][1]))
    hwnd = chosen["hwnd"]
    user.ShowWindow(hwnd, 9)  # SW_RESTORE, including a minimized/hidden native form.
    # A visible but covered window yields DXGI_STATUS_OCCLUDED and is not a fair
    # presentation benchmark. Keep the owned window topmost for this short run.
    if not user.SetWindowPos(hwnd, wintypes.HWND(-1), 0, 0, width, height, 0x40):
        raise ctypes.WinError(ctypes.get_last_error())
    activated = bool(user.SetForegroundWindow(hwnd))
    time.sleep(.35)
    after = inspect(hwnd)
    after["foreground"] = int(user.GetForegroundWindow() or 0) == hwnd
    after["activation_requested"] = activated
    return {"before": windows, "after": after}


def run(args):
    if os.name != "nt":
        raise RuntimeError("Native Pivot benchmark requires Windows")
    import frida
    source = args.input.resolve(strict=True)
    executable = (ROOT / "Pivot Animator v5/pivot.exe").resolve(strict=True)
    if reference.sha256(executable) != reference.SUPPORTED_PIVOT_SHA256:
        raise ValueError("Unsupported executable: native addresses require the reference SHA-256")
    source_hash = reference.sha256(source)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    fixture = output / "input.piv"
    shutil.copy2(source, fixture)
    profile = output / "profile"
    (profile / "Pivot Animator").mkdir(parents=True)
    # Create only the owned profile. Never reuse or rewrite user's Pivot.ini.
    (profile / "Pivot Animator/Pivot.ini").write_text(
        "[Pivot.Settings]\nLanguage=English\nNumOnion=0\nOnionAhead=0\nPlayFitZoom=0\nLoopPlay=0\nFrameRate=16\n"
        "[MainForm]\nTop=0\nLeft=0\nWidth=1600\nHeight=1000\nInitMax=0\n", encoding="utf-8")
    config = {"profile": str(profile), "scale": args.scale, "start_tick": args.start_tick, "frames": args.frames,
              "expected_canvas": [args.canvas_width, args.canvas_height]}
    prefix = reference.AGENT.partition("function exportFrames()")[0]
    script_text = (prefix + AGENT).replace("__CONFIG__", json.dumps(config))
    (output / "instrumentation.js").write_text(script_text, encoding="utf-8")
    report = {"schema": "pivot-native-ui-performance/v1", "input": str(source), "input_sha256": source_hash,
              "pivot_sha256": reference.sha256(executable), "status": "running", "requested": config,
              "limitations": ["Instrumented original UI timer and rendering APIs; not PNG export throughput.",
                              "Engine QPC wall duration includes native evaluation, drawing and potential GPU waits. It is not equivalent to browser CPU submission time or worker compilation time.",
                              "GetThreadTimes CPU deltas are recorded separately and have coarse Windows accounting granularity; presentation intervals are not monitor scanout or pure GPU timestamps.",
                              "Playback begins at the containing native keyframe to initialize interpolation; only the requested range is measured. The real native timer controls every draw.",
                              "Frida hook overhead is included. Canvas physical scale and render target dimensions are recorded, not assumed."]}
    events = []
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 1 if args.visible else 0
    process = session = None
    log = (output / "events.jsonl").open("w", encoding="utf-8")
    try:
        process = subprocess.Popen([str(executable), str(fixture)], cwd=executable.parent,
                                   env=dict(os.environ, APPDATA=str(profile)), startupinfo=startup,
                                   creationflags=0x4 | subprocess.CREATE_NEW_PROCESS_GROUP)
        report["owned_pid"] = process.pid
        session = frida.attach(process.pid)
        script = session.create_script(script_text)

        def on_message(message, data):
            event = message.get("payload", message)
            events.append(event)
            log.write(json.dumps(event) + "\n")
            log.flush()
            if event.get("event") in {"ready", "complete", "error", "native_message"} or event.get("type") == "error":
                print(json.dumps(event), flush=True)

        script.on("message", on_message)
        script.load()
        ntdll = ctypes.WinDLL("ntdll")
        ntdll.NtResumeProcess.argtypes = [ctypes.c_void_p]
        ntdll.NtResumeProcess.restype = ctypes.c_long
        status = ntdll.NtResumeProcess(int(process._handle))
        if status:
            raise RuntimeError(f"NtResumeProcess failed: {status:#x}")
        deadline = time.monotonic() + args.timeout
        previous = stable_since = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"Owned Pivot exited {process.returncode}")
            errors = [e for e in events if e.get("type") == "error" or e.get("event") in {"error", "native_message"}]
            if errors:
                raise RuntimeError(str(errors[-1]))
            state = script.exports_sync.state()
            candidate = (state["parsedFrames"], state.get("metadata"))
            loaded = any(e.get("event") == "file_open" and Path(e.get("name", "")).resolve() == fixture for e in events)
            if loaded and (state.get("metadata") or {}).get("keyframe_count", 0) and candidate == previous:
                stable_since = stable_since or time.monotonic()
                if time.monotonic() - stable_since >= 2:
                    break
            else:
                stable_since = None
            previous = candidate
            time.sleep(.2)
        else:
            raise TimeoutError("Native project loading timed out")
        if args.visible:
            # Measured Pivot chrome at DPI=1: 168 horizontal / 185 vertical pixels.
            # The actual render-canvas size is independently captured every tick.
            report["window"] = prepare_owned_window(process.pid, args.canvas_width + 168, args.canvas_height + 185)
            # Native non-client borders differ on the isolated and interactive
            # desktop. Query the actual canvas on its UI thread, then compensate.
            for attempt in range(2):
                previous_viewports = sum(event.get("event") == "viewport" for event in events)
                script.exports_sync.inspectview()
                inspect_deadline = time.monotonic() + 3
                while time.monotonic() < inspect_deadline:
                    viewports = [event for event in events if event.get("event") == "viewport"]
                    if len(viewports) > previous_viewports:
                        break
                    time.sleep(.05)
                else:
                    raise TimeoutError("Native viewport inspection timed out")
                current = viewports[-1]
                if [current["width"], current["height"]] == config["expected_canvas"]:
                    break
                rect = report["window"]["after"]["rect"]
                report.setdefault("window_adjustments", []).append(report["window"])
                report["window"] = prepare_owned_window(process.pid,
                    rect[2] - rect[0] + args.canvas_width - current["width"],
                    rect[3] - rect[1] + args.canvas_height - current["height"])
        script.exports_sync.start()
        while time.monotonic() < deadline:
            errors = [e for e in events if e.get("type") == "error" or e.get("event") in {"error"}]
            if errors:
                raise RuntimeError(str(errors[-1]))
            if any(e.get("event") == "complete" for e in events):
                break
            if process.poll() is not None:
                raise RuntimeError(f"Owned Pivot exited {process.returncode}")
            time.sleep(.1)
        else:
            report["measurements"] = script.exports_sync.results()
            raise TimeoutError("Native UI playback timed out")
        measurements = script.exports_sync.results()
        report["measurements"] = measurements
        report["configuration"] = next((e for e in events if e.get("event") == "configuration"), None)
        frames = measurements["samples"]
        expected = list(range(args.start_tick, args.start_tick + args.frames))
        actual = [f["tick"] for f in frames]
        intervals = [b["start"] - a["start"] for a, b in zip(frames, frames[1:])]
        # Keep raw calls, then associate the first successful submission attempt
        # after each frame finishes. Additional control repaints do not create
        # extra animation frames or artificially shorten frame cadence.
        presentation = []
        for frame in frames:
            matches = [call for call in measurements["presents"] if call["tick"] == frame["tick"] and call["start"] >= frame["end"]]
            if matches:
                presentation.append(matches[0])
        report["frame_presentations"] = presentation
        presentation_intervals = [b["end"] - a["end"] for a, b in zip(presentation, presentation[1:])]
        visible_presentation = len(presentation) == args.frames and all(call["result"] == 0 for call in presentation)
        canvas_matches = all([frame["canvas"]["width"], frame["canvas"]["height"]] == config["expected_canvas"] for frame in frames)
        report["summary"] = {"frames": len(frames), "firstTick": actual[0] if actual else None,
                             "lastTick": actual[-1] if actual else None, "exactTickCoverage": actual == expected,
                             "engineWall": quantiles([f["wallMs"] for f in frames]), "engineIntervals": quantiles(intervals),
                             "engineThreadCPU": quantiles([f["threadCpuMs"] for f in frames if f.get("threadCpuMs") is not None]),
                             "presentationCalls": len(measurements["presents"]), "framePresentations": len(presentation), "presentationIntervals": quantiles(presentation_intervals),
                             "presentationCallWall": quantiles([call["end"] - call["start"] for call in presentation]),
                             "presentationResults": sorted(set(f"0x{call['result']:08X}" for call in presentation)),
                             "visiblePresentation": visible_presentation, "canvasMatches": canvas_matches}
        report["summary"]["aggregateEngineWallMs"] = sum(frame["wallMs"] for frame in frames)
        report["summary"]["aggregateEngineThreadCpuMs"] = sum(frame["threadCpuMs"] for frame in frames if frame.get("threadCpuMs") is not None)
        report["metric_definitions"] = {
            "engineWall": "QPC elapsed time around native TPlayer render, including evaluation, rasterization and possible waits.",
            "engineThreadCPU": "GetThreadTimes delta for the rendering thread, quantized by Windows accounting.",
            "presentationCallWall": "QPC elapsed time inside the native DXGI.Present call.",
            "presentationIntervals": "Elapsed QPC time between Present returns for successive logical frames; not physical display scanout."}
        report["status"] = "complete" if actual == expected and visible_presentation and canvas_matches else "comparison_incomplete"
        print(json.dumps(report["summary"], indent=2), flush=True)
    except Exception as error:
        report.update(status="failed", error=str(error))
        raise
    finally:
        if process:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
        if session:
            try:
                session.detach()
            except Exception:
                pass
        log.close()
        report["input_unchanged"] = reference.sha256(source) == source_hash
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="New, nonexisting output directory")
    parser.add_argument("--start-tick", type=int, default=1824)
    parser.add_argument("--frames", type=int, default=48)
    parser.add_argument("--scale", type=float, default=1.4911764705882353)
    parser.add_argument("--canvas-width", type=int, default=1120)
    parser.add_argument("--canvas-height", type=int, default=652)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--visible", action="store_true", help="Show the harness-owned process; needed to assess visible-window presentation")
    args = parser.parse_args()
    if args.start_tick < 0 or args.frames < 1 or args.frames > 100000:
        parser.error("Invalid tick range")
    if not math.isfinite(args.scale) or not .1 <= args.scale <= 8:
        parser.error("Scale must be finite and between .1 and 8")
    if not math.isfinite(args.timeout) or args.timeout <= 3:
        parser.error("Timeout must be finite and exceed three seconds")
    result = run(args)
    return 0 if result["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Prepare or run a guarded original Pivot frame-clipboard diagnostic.

Default operation is read-only --plan. --run additionally requires the isolated
native GPU lease. The original input, profile and clipboard are never modified.
"""
from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from native_process_watchdog import OwnedProcessWatchdog
spec = importlib.util.spec_from_file_location("native_editor", HERE / "native-editor-benchmark.py")
editor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(editor)
native, reference, ROOT = editor.native, editor.reference, editor.ROOT

SOURCE_SHA256 = "e24482713308932f4ae7c8dfc4efdf66abfc4dd9b634ede98630302daa958c7d"
CASES = {1: {"name": "dense-one", "first": 1478, "objects": 643},
         64: {"name": "dense-64", "first": 1415, "objects": 21587},
         1479: {"name": "all", "first": 0, "objects": 208373}}

CLIPBOARD_AGENT = r"""
let clipboardOperation=null,clipboardCase=null;
const clipboardOperations=[],clipboardPresentCalls=new Map();
const clipboardFolder=cfg.profile+'\\Pivot Animator\\';
function normalPath(value){return value.replace(/\//g,'\\').replace(/\\+$/,'').toLowerCase();}
function assertClipboardIsolation(){
 const actual=global(0xb66474).readUtf16String();
 if(!/[\\/]$/.test(actual)||normalPath(actual)!==normalPath(clipboardFolder))throw Error('Native clipboard prefix escaped owned profile: '+actual);
 if(global(0xb65dbc).readUtf16String()!=='CF_PivotFrames_v5')throw Error('Native clipboard filename stem changed');
 return actual;
}
function frameInventory(start,count){
 const frames=global(0xb66b20),total=arrayLength(frames);
 if(start<0||count<0||start+count>total)throw Error('Invalid stored-frame inventory');
 const rows=[];let objects=0;
 for(let index=start;index<start+count;index++){
  const frame=frames.add(index*4).readPointer(),n=arrayLength(frame.add(0x10).readPointer());
  objects+=n;rows.push({duration:frame.add(12).readU16(),objects:n});
 }
 return{frames:rows,objects};
}
function selectedIndices(){
 const list=global(0xb668c8),length=arrayLength(list);
 if(length>1479)throw Error('Implausible clipboard selection count');
 return Array.from({length},(_,index)=>list.add(index*4).readS32());
}
function prepareClipboardCase(count){
 if(clipboardOperation)throw Error('Another clipboard operation is active');
 assertClipboardIsolation();const total=arrayLength(global(0xb66b20));
 if(total!==1479||![1,64,1479].includes(count))throw Error('Clipboard case requires unchanged Akane stored frames');
 const first=total-count;
 call(0xb263ac,form(),first,0);
 for(let index=first+1;index<total;index++)call(0xb26760,form(),index);
 exactZoom(image(),cfg.scale);
 const selected=selectedIndices(),expected=Array.from({length:count},(_,i)=>first+i);
 if(form().add(0x590).readS32()!==count||JSON.stringify(selected)!==JSON.stringify(expected))throw Error('Native stored-frame range differs from requested workload');
 const frames=global(0xb66b20);
 for(const index of selected)if(!frames.add(index*4).readPointer().add(0x18).readU8())throw Error('Native selected-frame flag missing');
 clipboardCase={count,first,selected,source:frameInventory(0,total),copied:frameInventory(first,count),
   beforeFrames:total,editingFrame:form().add(0x6c8).readS32(),viewport:viewport(),clipboardPrefix:assertClipboardIsolation()};
 emit('clipboard_prepared',clipboardCase);
}
// A native TIMERPROC enters outside Frida callback suppression. Thus the real
// method entry/return and subsequent native Present hooks remain observable.
function armClipboardCommand(kind){
 if(clipboardOperation||!clipboardCase)throw Error('Clipboard case is not ready');
 assertClipboardIsolation();
 if(!['copy','paste'].includes(kind))throw Error('Unsupported clipboard operation');
 const hwnd=form().add(0xc0).readPointer().add(8).readPointer(),memory=Memory.alloc(Process.pageSize);
 Memory.protect(memory,Process.pageSize,'rwx');const w=new X86Writer(memory);
 w.putPushReg('ebx');w.putPushReg('esi');w.putPushReg('edi');w.putPushReg('ebp');
 w.putMovRegRegOffsetPtr('ebx','esp',20);w.putMovRegRegOffsetPtr('esi','esp',28);
 w.putPushReg('esi');w.putPushReg('ebx');w.putCallAddress(user32.getExportByName('KillTimer'));
 w.putBytes([0x33,0xc0,0x33,0xd2,0x33,0xc9]);
 w.putCallAddress(at(kind==='copy'?0xb123ec:0xb125c8));
 w.putPopReg('ebp');w.putPopReg('edi');w.putPopReg('esi');w.putPopReg('ebx');w.putBytes([0xc2,0x10,0]);w.flush();keepAlive.push(memory);
 clipboardOperation={kind,count:clipboardCase.count,first:clipboardCase.first,armedAt:now(),
  beforeFrames:arrayLength(global(0xb66b20)),presentations:[],dispatch:'owned-HWND-one-shot-native-TIMERPROC',
  entryAddress:kind==='copy'?'0xB123EC':'0xB125C8',pasteIndex:kind==='paste'?0:null};
 const timer=setTimer(hwnd,0,1,memory);if(!timer){clipboardOperation=null;throw Error('Cannot arm clipboard native timer');}
 emit('clipboard_armed',{kind,timer});
}
for(const [kind,address]of[['copy',0xb123ec],['paste',0xb125c8]])Interceptor.attach(at(address),{
 onEnter(){this.operation=clipboardOperation?.kind===kind?clipboardOperation:null;if(this.operation)this.operation.start=now();},
 onLeave(){const op=this.operation;if(!op)return;op.end=now();op.operationWallMs=op.end-op.start;
  op.armedToReturnMs=op.end-op.armedAt;op.afterFrames=arrayLength(global(0xb66b20));
  op.editingFrameAfter=form().add(0x6c8).readS32();op.completedNativeReturn=true;
  emit('clipboard_returned',{kind,count:op.count,operationWallMs:op.operationWallMs,afterFrames:op.afterFrames});
 }
});
// One callsite per Paste captures the decoded clipboard record count without
// adding an instrumentation callback to every individual frame decoder call.
Interceptor.attach(at(0xb12d06),{onEnter(){if(clipboardOperation?.kind==='paste')clipboardOperation.decodedClipboardFrames=this.context.ecx.toUInt32();}});
Interceptor.attach(at(0x7ad75a),{onEnter(){
 const op=clipboardOperation;if(!op)return;const value=this.context.ebp.sub(4).readPointer();
 if(!mainWindowCanvas(value))return;
 clipboardPresentCalls.set(this.threadId,{start:now(),width:value.add(0x6c).readU32(),height:value.add(0x70).readU32(),
  mainWindowVerified:true,frameCount:arrayLength(global(0xb66b20)),afterOperationReturn:Boolean(op.end)});
}});
Interceptor.attach(at(0x7ad76d),{onEnter(){const value=clipboardPresentCalls.get(this.threadId);if(!value)return;
 clipboardPresentCalls.delete(this.threadId);value.end=now();value.result=this.context.eax.toUInt32();clipboardOperation?.presentations.push(value);
}});
function matchingClipboardPresent(op){
 // The verified HWND's swapchain includes application chrome. Its dimensions
 // need not equal the separately checked scene bitmap viewport.
 return op.presentations.find(p=>p.mainWindowVerified&&p.result===0&&p.start>=op.end&&p.frameCount===op.afterFrames)||null;
}
function finishClipboardOperation(){
 const op=clipboardOperation;if(!op?.end)throw Error('Clipboard native method has not returned');
 const expected=op.beforeFrames+(op.kind==='paste'?op.count:0);
 if(op.afterFrames!==expected)throw Error('Native clipboard operation produced the wrong stored-frame count');
 op.sceneViewportAfter=viewport();
 if(op.sceneViewportAfter.width!==1120||op.sceneViewportAfter.height!==652)throw Error('Native scene viewport changed during clipboard operation');
 const present=matchingClipboardPresent(op);
 op.successfulPresent=present||null;op.operationToSuccessfulPresentMs=present?present.end-op.start:null;
 op.presentationQualification=present?'First matching main-window S_OK Present after native operation return.':'No matching natural post-return presentation observed; operation-return timing only.';
 if(op.kind==='paste'){
  if(op.decodedClipboardFrames!==op.count)throw Error('Native parsed a different clipboard frame count');
  const inserted=frameInventory(0,op.count),tail=frameInventory(op.count,op.beforeFrames);
  op.insertedInventory=inserted;
  op.insertedInventoryMatches=JSON.stringify(inserted)===JSON.stringify(clipboardCase.copied);
  op.originalTailInventoryMatches=JSON.stringify(tail)===JSON.stringify(clipboardCase.source);
  if(!op.insertedInventoryMatches||!op.originalTailInventoryMatches)throw Error('Native paste changed frame order, durations or object counts');
 }
 clipboardOperations.push(op);clipboardOperation=null;emit('clipboard_complete',op);
}
rpc.exports={...rpc.exports,
 clipboardprepare(count){pending=()=>prepareClipboardCase(count);wake();return true;},
 clipboardrun(kind){pending=()=>armClipboardCommand(kind);wake();return true;},
 clipboardfinish(){pending=finishClipboardOperation;wake();return true;},
 clipboardresults(){return{operations:clipboardOperations,active:clipboardOperation,case:clipboardCase};}
};
"""


def instrumentation(config):
    prefix = reference.AGENT.partition("function exportFrames()")[0]
    prefix = prefix.replace("Interceptor.attach(at(0x54c79c), {onLeave() { parsedFrames++; lastFrameParse = Date.now(); }});", "")
    zoom = native.AGENT[native.AGENT.index("function exactZoom("):native.AGENT.index("function beginPlayback()")]
    return (prefix + editor.AGENT.replace("__EXACT_ZOOM__", zoom) + CLIPBOARD_AGENT).replace("__CONFIG__", json.dumps(config))


def run(args, plan):
    import frida
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    fixture, profile = output / "input.piv", output / "profile"
    shutil.copy2(args.input, fixture)
    (profile / "Pivot Animator").mkdir(parents=True)
    (profile / "Pivot Animator/Pivot.ini").write_text("[Pivot.Settings]\nLanguage=English\nNumOnion=0\nOnionAhead=0\nPlayFitZoom=0\nLoopPlay=0\nFrameRate=16\n[MainForm]\nWidth=1600\nHeight=1000\nInitMax=0\n", encoding="utf-8")
    config = {"profile": str(profile), "fixture": str(fixture), "output": str(output), "scale": 1.4911764860153198,
              "uid": 460616, "steps": 1, "amplitude": 8, "detailed": False}
    (output / "instrumentation.js").write_text(instrumentation(config), encoding="utf-8")
    report = {**plan, "status": "running", "configuration": config, "cases": []}
    process = session = watchdog = case_watchdog = None
    case = None
    events = []
    with (output / "events.jsonl").open("w", encoding="utf-8") as log:
        try:
            executable = ROOT / "Pivot Animator v5/pivot.exe"
            startup = subprocess.STARTUPINFO(); startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW; startup.wShowWindow = 1
            spawn_started = time.monotonic()
            process = subprocess.Popen([str(executable)], cwd=executable.parent,
                env=dict(os.environ, APPDATA=str(profile)), startupinfo=startup,
                creationflags=0x4 | subprocess.CREATE_NEW_PROCESS_GROUP)
            report["ownedPid"] = process.pid
            def expired(evidence, scope="whole-process"):
                # Kill is attempted before this callback, so evidence I/O cannot
                # delay enforcement. Preserve useful state even if RPC is stuck.
                partial = {"status": "watchdog-timeout", "scope": scope, "ownedPid": process.pid, "watchdog": evidence,
                           "completedCases": [case["name"] for case in report["cases"]],
                           "recentEvents": list(events[-12:])}
                (output / "watchdog-timeout.json").write_text(json.dumps(partial, indent=2), encoding="utf-8")
            watchdog = OwnedProcessWatchdog(process, args.timeout, started_at=spawn_started, on_expire=expired).start()
            session = watchdog.call(frida.attach, process.pid, label="Frida attach")
            script = watchdog.call(session.create_script, instrumentation(config), label="Frida script creation")
            def rpc(method, *values):
                return (case_watchdog or watchdog).call(getattr(script.exports_sync, method), *values, label=f"RPC {method}")
            def message(value, data):
                entry = value.get("payload", value); events.append(entry)
                if not log.closed:
                    try: log.write(json.dumps(entry) + "\n"); log.flush()
                    except ValueError: pass  # A late destruction notification after bounded cleanup.
                if entry.get("event") in {"clipboard_returned", "error"}: print(json.dumps(entry), flush=True)
            script.on("message", message); watchdog.call(script.load, label="Frida script load")
            ntdll = ctypes.WinDLL("ntdll"); ntdll.NtResumeProcess.argtypes = [ctypes.c_void_p]; ntdll.NtResumeProcess.restype = ctypes.c_long
            if ntdll.NtResumeProcess(int(process._handle)): raise RuntimeError("Could not resume owned Pivot")
            deadline = watchdog.deadline
            def event(name, previous=0): return editor.wait_event(events, name, previous, process, min(deadline, case_watchdog.deadline if case_watchdog else deadline))
            previous = None; stable = time.monotonic()
            while time.monotonic() < deadline:
                state = rpc("state"); current = state.get("frames")
                if current != previous: stable = time.monotonic()
                if state.get("initialized") and time.monotonic() - stable > 1: break
                previous = current; time.sleep(.1)
            else: raise TimeoutError("Native initialization timed out")
            report["window"] = watchdog.call(native.prepare_owned_window, process.pid, 1288, 837, label="Owned window setup")
            for _ in range(3):
                count = sum(e.get("event") == "viewport" for e in events); rpc("viewport")
                view = event("viewport", count)
                if [view["width"], view["height"]] == [1120, 652]: break
                rect = report["window"]["after"]["rect"]
                report["window"] = watchdog.call(native.prepare_owned_window, process.pid, rect[2]-rect[0]+1120-view["width"], rect[3]-rect[1]+652-view["height"], label="Owned viewport adjustment")
            else: raise RuntimeError("Cannot match the native canvas viewport")
            for count in args.cases:
                case = {"name": CASES[count]["name"], "keys": count, "status": "setup"}
                report["cases"].append(case)
                case_watchdog = OwnedProcessWatchdog(process, min(args.case_timeout, max(0, watchdog.deadline-time.monotonic())),
                    on_expire=lambda evidence, count=count: expired(evidence, f"case-{count}")).start()
                before = sum(e.get("event") == "import_complete" for e in events)
                rpc("load", f"clipboard-case-{count}-setup-import-excluded")
                imported = event("import_complete", before)
                before = sum(e.get("event") == "clipboard_prepared" for e in events)
                rpc("clipboardprepare", count); prepared = event("clipboard_prepared", before)
                if prepared["copied"]["objects"] != CASES[count]["objects"]: raise RuntimeError("Native selected object count differs from the Node workload")
                case.update(setupImportExcluded=imported, selection=prepared, status="measuring")
                time.sleep(.3)  # Let unmeasured selection redraws settle.
                for operation in ["copy", "paste"]:
                    returned = sum(e.get("event") == "clipboard_returned" for e in events)
                    completed = sum(e.get("event") == "clipboard_complete" for e in events)
                    rpc("clipboardrun", operation); event("clipboard_returned", returned)
                    time.sleep(.35)  # Observe natural presentation; never force a diagnostic repaint.
                    rpc("clipboardfinish"); result = event("clipboard_complete", completed)
                    case[operation] = result
                    clipboard = profile / "Pivot Animator/CF_PivotFrames_v5.dat"
                    if not clipboard.is_file(): raise RuntimeError("Native internal clipboard file was not produced in the owned profile")
                    case[operation]["clipboardFileBytes"] = clipboard.stat().st_size
                    (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
                case_watchdog.cancel(); case["watchdog"] = case_watchdog.snapshot()
                case_watchdog = None; case["status"] = "complete"
            report["adapter"] = rpc("results").get("adapter")
            report["status"] = "complete"
        except Exception as error:
            if case is not None: case.update(status="failed", error=str(error))
            report.update(status="failed", error=str(error)); raise
        finally:
            if process:
                if process.poll() is None: process.kill()
                process.wait(timeout=3); report["ownedProcessClosed"] = True
                report["ownedProcessWallSeconds"] = time.monotonic()-spawn_started
            if watchdog:
                watchdog.cancel(); report["watchdog"] = watchdog.snapshot()
                if report["watchdog"]["expired"]: report["status"] = "watchdog-timeout"
            if case_watchdog:
                case_watchdog.cancel(); case["watchdog"] = case_watchdog.snapshot()
                if case["watchdog"]["expired"]: report["status"] = "watchdog-timeout"
            report["notStartedCaseKeys"] = [count for count in args.cases if count not in [item["keys"] for item in report["cases"]]]
            if session:
                def detach():
                    try: session.detach()
                    except Exception: pass
                cleanup = threading.Thread(target=detach, name="owned-native-detach", daemon=True)
                cleanup.start(); cleanup.join(timeout=1)
                report["sessionDetachCompleted"] = not cleanup.is_alive()
            report["sourceUnchanged"] = reference.sha256(args.input) == plan["sourceSha256"]
            report["fixtureUnchanged"] = reference.sha256(fixture) == plan["sourceSha256"]
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/native-clipboard-akane-v1"))
    parser.add_argument("--cases", nargs="+", type=int, default=[1, 64, 1479])
    parser.add_argument("--timeout", type=float, default=25, help="Owned-process wall deadline in seconds, including Frida setup and initialization")
    parser.add_argument("--case-timeout", type=float, default=25, help="Per-case wall limit including its excluded setup import; also bounded by the whole-process deadline")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--prepare", action="store_true", help="Write plan and generated instrumentation only; never launch Pivot")
    args = parser.parse_args()
    if len(set(args.cases)) != len(args.cases) or not args.cases or any(n not in CASES for n in args.cases): parser.error("Cases must be a unique subset of 1,64,1479")
    if not 10 <= args.timeout <= 180: parser.error("Timeout must be 10..180 seconds")
    if not 5 <= args.case_timeout <= 60: parser.error("Case timeout must be 5..60 seconds")
    if args.run and (args.plan or args.prepare): parser.error("--run cannot be combined with preparation modes")
    args.input = args.input.resolve(strict=True)
    source_hash = reference.sha256(args.input)
    if source_hash != SOURCE_SHA256: raise ValueError("Clipboard workloads are defined only for the exact guarded Akane source")
    if reference.sha256(ROOT / "Pivot Animator v5/pivot.exe") != reference.SUPPORTED_PIVOT_SHA256: raise ValueError("Native method addresses require original Pivot 5.2.11")
    plan = {"schema": "native-pivot-clipboard-performance/v1", "status": "prepared-not-run",
        "source": str(args.input), "sourceSha256": source_hash, "pivotSha256": reference.SUPPORTED_PIVOT_SHA256,
        "ownedProcessWallLimitSeconds": args.timeout,
        "perCaseWallLimitSeconds": args.case_timeout,
        "workloads": [{"keys": count, **CASES[count], "last": 1478, "pasteIndex": 0, "destinationStoredKeys": 1479} for count in args.cases],
        "metricBoundaries": {"operationWallMs": "QPC at original common Copy/Paste method entry to its native return; includes native serialization, internal clipboard file I/O and synchronous UI work.",
            "operationToSuccessfulPresentMs": "Same entry to first naturally observed matching main-window S_OK Present after method return. Null if no such presentation occurs; physical scanout is not measured."},
        "isolation": "Only owned copied source/profile/process. Native APPDATA prefix must equal owned profile/Pivot Animator before Copy/Paste; user's internal clipboard and Windows clipboard stay untouched.",
        "limitations": ["Preparation only until explicit Root lease and --run plus STYK_GPU_SLOT=native-clipboard.",
            "One process; untouched source reloaded before each case outside measurement. OS caches uncontrolled.",
            "Native Copy serializes an internal .dat file. Current Node app baseline keeps its staged clipboard in memory and excludes rendering; boundaries are not equivalent.",
            "Native timeline Paste resets working-frame Undo; no native timeline Undo equivalence is asserted.",
            "Selection setup and post-operation inventory checks are excluded. Inventory proves stored-key order, durations and pose counts, not every serialized field.",
            "A copy need not repaint the scene; an unavailable natural presentation is reported rather than forced."]}
    if args.prepare:
        args.output.mkdir(parents=True, exist_ok=False)
        config = {"profile": str((args.output / "profile").resolve()), "fixture": str((args.output / "input.piv").resolve()),
                  "output": str(args.output.resolve()), "scale": 1.4911764860153198, "uid": 460616, "steps": 1, "amplitude": 8, "detailed": False}
        (args.output / "instrumentation.js").write_text(instrumentation(config), encoding="utf-8")
        (args.output / "plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")
    if args.run:
        if os.environ.get("STYK_GPU_SLOT") != "native-clipboard": raise RuntimeError("No isolated native clipboard lease guard")
        print(json.dumps({"status": run(args, plan)["status"]})); return
    print(json.dumps(plan, indent=2))


if __name__ == "__main__": main()

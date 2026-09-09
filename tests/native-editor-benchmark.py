"""Guarded original Pivot import/readiness and delivered-input-to-Present probe.

Each trial owns an empty native process and profile, performs one process-cold
and one same-process warm import, then a real Windows mouse gesture. OS file
cache is uncontrolled. Only the copied source is loaded; nothing is saved back.
"""
from __future__ import annotations
import argparse
import ctypes
from ctypes import wintypes
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("native_playback", HERE / "native-playback-benchmark.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
reference = native.reference
ROOT = native.ROOT


def quantiles(values):
    ordered = sorted(value for value in values if isinstance(value, (int, float)) and math.isfinite(value))
    return {"count": len(ordered), "method": "nearest-rank", "p50": ordered[math.ceil(len(ordered) * .5) - 1] if ordered else None,
            "p95": ordered[math.ceil(len(ordered) * .95) - 1] if ordered else None, "max": ordered[-1] if ordered else None}

AGENT = r"""
const kernel=Process.getModuleByName('kernel32.dll'),user32=Process.getModuleByName('user32.dll');
const qpc=new NativeFunction(kernel.getExportByName('QueryPerformanceCounter'),'bool',['pointer'],'stdcall');
const qpf=new NativeFunction(kernel.getExportByName('QueryPerformanceFrequency'),'bool',['pointer'],'stdcall');
const clockMemory=Memory.alloc(8),frequencyMemory=Memory.alloc(8);qpf(frequencyMemory);const frequency=Number(frequencyMemory.readU64());
function now(){qpc(clockMemory);return Number(clockMemory.readU64())*1000/frequency;}
function matrixAt(p){return Array.from({length:9},(_,i)=>p.add(i*4).readFloat());}
let activeImport=null,imports=[],gesture=null,latestInput=null,poseSequence=0,mainHwnd=null,adapterInfo=null,zoomCode=null;
const observedCanvases=new Map();
const presents=new Map(),inputEvents=[],poseEvents=[],dragPresents=[],gestureStages=[],stages=[],inputHandles=new Set();
function form(){return global(0xb65f9c);}
function frame(){return form().add(0x6bc).readPointer();}
function image(){return form().add(0x6cc).readPointer();}
function bitmap(){return call(0x69661c,image());}
function canvas(){return call(0x54fdc8,bitmap());}
function node(object,id){const p=object.add(0x34).readPointer().add(id*16);return {x:p.readFloat(),y:p.add(4).readFloat()};}
for(const [label,address] of [['drag-timer',0xb211f8],['editor-draw',0xb1f848]])Interceptor.attach(at(address),{onEnter(){this.active=!!gesture;if(this.active){this.start=now();this.inputId=latestInput?.id;}},onLeave(){if(this.active)gestureStages.push({label,inputId:this.inputId,start:this.start,end:now()});}});
function selectedObject(){const objects=frame().add(0x10).readPointer();for(let slot=0;slot<arrayLength(objects);slot++){const object=objects.add(slot*4).readPointer();if(object.add(0x58).readU32()===cfg.uid)return{slot,object};}throw Error('Requested native UID not found');}
function invoke(va,args,ret='int'){return new NativeFunction(va,ret,args.map(()=> 'pointer'),'stdcall');}
function adapterFromCanvas(value){
 const swap=value.add(0xd0).readPointer(),out=Memory.alloc(4),iid=Memory.alloc(16);
 iid.writeByteArray([0xfa,0x77,0xec,0x54,0x77,0x13,0xe6,0x44,0x8c,0x32,0x88,0xfd,0x5f,0x44,0xc8,0x4c]);
 const method=(p,i)=>p.readPointer().add(i*4).readPointer();
 const getDevice=new NativeFunction(method(swap,7),'int',['pointer','pointer','pointer'],'stdcall');
 if(getDevice(swap,iid,out)<0)return{error:'IDXGISwapChain.GetDevice failed'};const device=out.readPointer();
 try{const getAdapter=new NativeFunction(method(device,7),'int',['pointer','pointer'],'stdcall');if(getAdapter(device,out)<0)return{error:'IDXGIDevice.GetAdapter failed'};const adapter=out.readPointer();
  try{const desc=Memory.alloc(304),getDesc=new NativeFunction(method(adapter,8),'int',['pointer','pointer'],'stdcall');if(getDesc(adapter,desc)<0)return{error:'IDXGIAdapter.GetDesc failed'};
   return {description:desc.readUtf16String(),vendorId:desc.add(256).readU32(),deviceId:desc.add(260).readU32(),subsysId:desc.add(264).readU32(),revision:desc.add(268).readU32()};
  }finally{new NativeFunction(method(adapter,2),'uint',['pointer'],'stdcall')(adapter);}
 }finally{new NativeFunction(method(device,2),'uint',['pointer'],'stdcall')(device);}
}
const canvasWindows=new Map();
function mainWindowCanvas(value){return safe(()=>{
 const key=value.toString();if(!canvasWindows.has(key)){
  const swap=value.add(0xd0).readPointer(),desc=Memory.alloc(64),getDesc=new NativeFunction(swap.readPointer().add(12*4).readPointer(),'int',['pointer','pointer'],'stdcall');
  if(getDesc(swap,desc)<0)return false;canvasWindows.set(key,desc.add(44).readPointer());
 }
 return canvasWindows.get(key).equals(form().add(0xc0).readPointer().add(8).readPointer());
})===true;}
function finishImport(){if(!activeImport?.returned||!activeImport.success||!activeImport.lastEditorDrawEnd)return;const p=activeImport.presentations.find(p=>p.result===0&&p.start>=activeImport.lastEditorDrawEnd);if(!p)return;activeImport.firstVisible=p.end;activeImport.firstVisibleMs=p.end-activeImport.start;activeImport.editableVisible=Math.max(p.end,activeImport.returned);activeImport.importToEditableVisibleMs=activeImport.editableVisible-activeImport.start;imports.push(activeImport);emit('import_complete',activeImport);activeImport=null;}
Interceptor.attach(at(0x7ad75a),{onEnter(){const value=this.context.ebp.sub(4).readPointer();if(!observedCanvases.has(value.toString())){const record={canvas:value.toString(),formCanvas:safe(()=>form().add(0x2c0).readPointer().toString()),parent:safe(()=>value.add(0x18).readPointer().toString()),form:safe(()=>form().toString()),width:value.add(0x6c).readU32(),height:value.add(0x70).readU32()};observedCanvases.set(value.toString(),record);emit('observed_canvas',record);}if(!mainWindowCanvas(value))return;
 if(!adapterInfo)adapterInfo=safe(()=>adapterFromCanvas(value));
 presents.set(this.threadId,{start:now(),latestInputId:latestInput?.id,poseId:poseSequence,width:value.add(0x6c).readU32(),height:value.add(0x70).readU32()});
}});
Interceptor.attach(at(0x7ad76d),{onEnter(){const p=presents.get(this.threadId);if(!p)return;presents.delete(this.threadId);p.end=now();p.result=this.context.eax.toUInt32();
 if(activeImport){activeImport.presentations.push(p);finishImport();}
 if(gesture&&latestInput)dragPresents.push(p);
}});
for(const [label,address] of [['source-read-unpack',0xaf4a68],['project-parser',0xb10c14],['legacy-parser',0xb11064],['background-assets',0xaefd3c],['figure-types-assets',0xaff7f8],['initial-edit-frame',0xb1f16c],['editor-draw',0xb1f848]]){
 if(!cfg.detailed&&['background-assets','figure-types-assets'].includes(label))continue;
 Interceptor.attach(at(address),{onEnter(){this.active=activeImport; if(this.active)this.start=now();},onLeave(){if(this.active){const end=now();this.active.stages.push({label,start:this.start,end,wallMs:end-this.start});if(label==='editor-draw')this.active.lastEditorDrawEnd=end;}}});
}
Interceptor.attach(kernel.getExportByName('CreateFileW'),{onEnter(args){this.source=safe(()=>args[0].readUtf16String().toLowerCase())===cfg.fixture.toLowerCase();if(this.source)this.start=now();},onLeave(result){if(this.source&&!result.equals(ptr('0xffffffff'))){inputHandles.add(result.toString());if(activeImport)activeImport.sourceOpen={start:this.start,end:now()};}}});
if(cfg.detailed)Interceptor.attach(kernel.getExportByName('ReadFile'),{onEnter(args){this.active=activeImport&&inputHandles.has(args[0].toString());if(this.active){this.import=activeImport;this.start=now();this.bytes=args[3];}},onLeave(result){if(this.active){this.import.sourceReadCalls++;this.import.sourceReadWallMs+=now()-this.start;this.import.sourceReadBytes+=safe(()=>this.bytes.readU32())||0;}}});
Interceptor.attach(kernel.getExportByName('CloseHandle'),{onEnter(args){inputHandles.delete(args[0].toString());}});
Interceptor.attach(at(0xb27b54),{onEnter(){if(activeImport)activeImport.loaderEntered=now();},onLeave(result){if(activeImport){activeImport.returned=now();activeImport.loaderWallMs=activeImport.returned-activeImport.loaderEntered;activeImport.success=!!(result.toUInt32()&255);activeImport.metadata={width:pglobal(0xb65fcc).readU32(),height:pglobal(0xb65e78).readU32(),keyframes:arrayLength(global(0xb66b20)),fps:pglobal(0xb66a1c).readS32()};emit('load_returned',{label:activeImport.label,success:activeImport.success});if(!activeImport.success)emit('error',{message:'Native LoadProject returned false'});finishImport();}}});
Interceptor.attach(at(0x8a2994),{onEnter(args){if(!gesture||!mainHwnd||!args[0].equals(mainHwnd))return;const message=args[1].toUInt32();if(![0x200,0x201,0x202].includes(message))return;const raw=args[3].toUInt32();inputEvents.push({kind:'wndproc',message,start:now(),buttons:args[2].toUInt32(),clientX:raw<<16>>16,clientY:raw>>16});}});
Interceptor.attach(at(0xb21134),{onEnter(){if(!gesture)return;const s=this.context.esp;latestInput={id:inputEvents.length,kind:'form-move',start:now(),x:s.add(8).readFloat(),y:s.add(4).readFloat(),buttons:this.context.ecx.toUInt32()&65535};inputEvents.push(latestInput);}});
Interceptor.attach(at(0x9496c0),{onEnter(){this.active=!!gesture&&!!latestInput;if(!this.active)return;const s=this.context.esp,p=s.add(20).readPointer();this.start=now();this.input=latestInput;this.slot=this.context.edx.toUInt32()&65535;this.segment=this.context.ecx.toUInt32()&65535;this.target={x:p.readFloat(),y:p.add(4).readFloat()};},onLeave(){if(!this.active)return;const object=frame().add(0x10).readPointer().add(this.slot*4).readPointer();poseEvents.push({id:++poseSequence,inputId:this.input?.id,inputStart:this.input?.start,start:this.start,end:now(),slot:this.slot,uid:object.add(0x58).readU32(),segment:this.segment,target:this.target,root:node(object,0),endpoint:node(object,1)});}});
__EXACT_ZOOM__
// LoadProject resets view scale to 1 at 0xB27E3A. Apply the comparison zoom
// immediately afterward, before its existing SetEditFrame/DrawFigures path.
Interceptor.attach(at(0xb27e3f),{onEnter(){if(activeImport){exactZoom(image(),cfg.scale);activeImport.viewport=viewport();}}});
function viewport(){const c=canvas();return{width:c.add(0x6c).readU32(),height:c.add(0x70).readU32(),matrix:matrixAt(image().add(0x434))};}
function physicalPoint(world){
 const local=Memory.alloc(8),absolute=Memory.alloc(8),p=Memory.alloc(8);p.writeFloat(world.x);p.add(4).writeFloat(world.y);
 call(0x936104,image(),p,local);call(0x6be4b4,image(),local,absolute);
 const handle=form().add(0xc0).readPointer();const scale=handle.add(0x58).readFloat();
 if(Math.abs(scale-1)>.0001)throw Error('This matched benchmark requires native DPI scale1; got '+scale);
 p.writeS32(Math.round(absolute.readFloat()*scale));p.add(4).writeS32(Math.round(absolute.add(4).readFloat()*scale));
 new NativeFunction(user32.getExportByName('ClientToScreen'),'bool',['pointer','pointer'],'stdcall')(mainHwnd,p);
 return{x:p.readS32(),y:p.add(4).readS32(),local:{x:local.readFloat(),y:local.add(4).readFloat()},dpiScale:scale};
}
function inspectScene(filename){
 const scene=snapshotFrame(frame());call(0x54fb7c,bitmap(),ustring(filename),0);return scene;
}
function setupGesture(){
 call(0xb263ac,form(),arrayLength(global(0xb66b20))-1,0);exactZoom(image(),cfg.scale);call(0xb2ddec,form(),form());
 const target=selectedObject(),typeId=target.object.add(0x30).readU16(),definition=global(0xb66820).add(typeId*4).readPointer(),endpointId=definition.add(12).readPointer().add(2).readU16();if(endpointId!==1)throw Error('Requested segment0 endpoint is not node1');call(0x94bc04,frame(),target.slot,1);call(0xb24b18,form());call(0xb1f848,form());
 mainHwnd=call(0x89e688,form());if(!call(0x89e5a8,mainHwnd).equals(form()))throw Error('Native HWND does not resolve to the main form');
 const root=node(target.object,0),endpoint=node(target.object,1),start=physicalPoint(endpoint);
 const trajectory=Array.from({length:cfg.steps},(_,i)=>{const world={x:endpoint.x+Math.sin(i/4)*cfg.amplitude,y:endpoint.y+Math.cos(i/4)*cfg.amplitude};return{i,world,screen:physicalPoint(world)};});
 emit('gesture_setup',{uid:cfg.uid,slot:target.slot,root,endpoint,start,trajectory,viewport:viewport(),hwnd:mainHwnd.toString(),cameraApplied:false,scene:inspectScene(cfg.output+'\\before.png'),adapter:adapterInfo});
}
const postMessage=new NativeFunction(user32.getExportByName('PostMessageW'),'bool',['pointer','uint','pointer','pointer'],'stdcall');
const windowThread=new NativeFunction(user32.getExportByName('GetWindowThreadProcessId'),'uint',['pointer','pointer'],'stdcall');
const setTimer=new NativeFunction(user32.getExportByName('SetTimer'),'uint',['pointer','uint','uint','pointer'],'stdcall');
function nativeLoad(label){
 if(activeImport)throw Error('A native import is already active');
 const hwnd=form().add(0xc0).readPointer().add(8).readPointer(),filename=ustring(cfg.fixture),memory=Memory.alloc(Process.pageSize);
 Memory.protect(memory,Process.pageSize,'rwx');const w=new X86Writer(memory);
 w.putPushReg('ebx');w.putPushReg('esi');w.putPushReg('edi');w.putPushReg('ebp');
 w.putMovRegRegOffsetPtr('ebx','esp',20);w.putMovRegRegOffsetPtr('esi','esp',28);
 w.putPushReg('esi');w.putPushReg('ebx');w.putCallAddress(user32.getExportByName('KillTimer'));
 w.putBytes([0xb8,...u32(form()),0xba,...u32(filename),0x33,0xc9]);w.putCallAddress(at(0xb27b54));
 w.putPopReg('ebp');w.putPopReg('edi');w.putPopReg('esi');w.putPopReg('ebx');w.putBytes([0xc2,0x10,0]);w.flush();keepAlive.push(memory);
 activeImport={label,start:now(),stages:[],presentations:[],sourceReadMeasured:cfg.detailed,sourceReadCalls:cfg.detailed?0:null,sourceReadBytes:cfg.detailed?0:null,sourceReadWallMs:cfg.detailed?0:null,dispatch:'owned-HWND-one-shot-native-TIMERPROC'};
 const timer=setTimer(hwnd,0,1,memory);if(!timer){activeImport=null;throw Error('Could not arm owned native load timer');}emit('load_armed',{label,timer});
}
function u32(p){const n=p.toUInt32();return[n&255,(n>>>8)&255,(n>>>16)&255,n>>>24];}
let mainThread=0;
function wake(){const hwnd=form().add(0xc0).readPointer().add(8).readPointer();mainThread=windowThread(hwnd,ptr(0));if(!mainThread||!postMessage(hwnd,0,ptr(0),ptr(0)))throw Error('Could not wake the owned main window');emit('queued',{mainThread});}
function pump(){if(busy||!pending||Process.getCurrentThreadId()!==mainThread)return;busy=true;const action=pending;pending=null;emit('action_started',{thread:Process.getCurrentThreadId()});try{action();}catch(error){emit('error',{message:String(error),stack:error.stack});}finally{busy=false;emit('action_finished');}}
for(const name of ['PeekMessageW','PeekMessageA','WaitMessage']){const a=user32.findExportByName(name);if(a)Interceptor.attach(a,{onEnter:pump});}
rpc.exports={
 state(){return{initialized:safe(()=>!form().isNull()&&!frame().isNull()&&!image().isNull()),parsedFrames,lastFrameParse,frames:safe(()=>arrayLength(global(0xb66b20))),imports:imports.length,observedCanvases:Array.from(observedCanvases.values()),adapter:adapterInfo};},
 viewport(){pending=()=>emit('viewport',viewport());wake();return true;},
 load(label){pending=()=>nativeLoad(label);wake();return true;},
 setup(){pending=setupGesture;wake();return true;},
 hit(){const packed=form().add(0x548).readU32(),slot=packed&65535,segment=packed>>16,objects=frame().add(0x10).readPointer();return{slot,segment,uid:slot<arrayLength(objects)?objects.add(slot*4).readPointer().add(0x58).readU32():null};},
  begin(){pending=()=>{gesture={start:now()};emit('gesture_armed');};wake();return true;},
 finish(){pending=()=>{gesture=null;emit('gesture_complete',{inputEvents,poseEvents,gestureStages,presentations:dragPresents,scene:inspectScene(cfg.output+'\\after.png'),viewport:viewport(),adapter:adapterInfo});};wake();return true;},
 results(){return{imports,inputEvents,poseEvents,gestureStages,presentations:dragPresents,adapter:adapterInfo};}
};emit('ready',{pid:Process.id,base:base.toString(),qpcFrequency:frequency});
"""


def wait_event(events, event, count, process, deadline):
    while time.monotonic() < deadline:
        matches = [entry for entry in events if entry.get("event") == event]
        if len(matches) > count:
            return matches[-1]
        failures = [entry for entry in events if entry.get("type") == "error" or entry.get("event") in {"error", "native_message"}]
        if failures:
            raise RuntimeError(str(failures[-1]))
        if process.poll() is not None:
            raise RuntimeError(f"Owned Pivot exited {process.returncode}")
        time.sleep(.03)
    raise TimeoutError(f"Native {event} timed out")


class Mouse:
    def __init__(self, pid):
        self.pid = pid
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        self.user.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
        self.user.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
        self.user.WindowFromPoint.argtypes = [wintypes.POINT]
        self.user.WindowFromPoint.restype = wintypes.HWND
        self.user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.initial = wintypes.POINT()
        self.user.GetCursorPos(ctypes.byref(self.initial))
        self.down = False
        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]
        class UNION(ctypes.Union):
            _fields_ = [("mi", MOUSEINPUT), ("padding", ctypes.c_byte * 32)]
        class INPUT(ctypes.Structure):
            _anonymous_ = ("data",)
            _fields_ = [("type", wintypes.DWORD), ("data", UNION)]
        self.INPUT = INPUT
        self.user.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]

    def move(self, point):
        p = wintypes.POINT(round(point["x"]), round(point["y"]))
        hwnd = self.user.WindowFromPoint(p)
        owner = wintypes.DWORD()
        self.user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != self.pid:
            raise RuntimeError("Target point is not owned by this Pivot process; no input sent")
        if not self.user.SetCursorPos(p.x, p.y):
            raise ctypes.WinError(ctypes.get_last_error())
        return {"x": p.x, "y": p.y, "sent": time.perf_counter() * 1000}

    def button(self, down):
        event = self.INPUT()
        event.type = 0
        event.mi.dwFlags = 0x2 if down else 0x4
        if self.user.SendInput(1, ctypes.byref(event), ctypes.sizeof(event)) != 1:
            raise ctypes.WinError(ctypes.get_last_error())
        self.down = down

    def restore(self):
        if self.down:
            self.button(False)
        self.user.SetCursorPos(self.initial.x, self.initial.y)


def trial(args, output, number):
    import frida
    output.mkdir(parents=True, exist_ok=False)
    fixture = output / "input.piv"
    shutil.copy2(args.input, fixture)
    profile = output / "profile"
    (profile / "Pivot Animator").mkdir(parents=True)
    (profile / "Pivot Animator/Pivot.ini").write_text("[Pivot.Settings]\nLanguage=English\nNumOnion=0\nOnionAhead=0\nPlayFitZoom=0\nLoopPlay=0\nFrameRate=16\nDragIntervalMs=20\n[MainForm]\nWidth=1600\nHeight=1000\nInitMax=0\n", encoding="utf-8")
    config = {"profile": str(profile), "fixture": str(fixture), "output": str(output), "scale": args.scale, "uid": args.uid, "steps": args.steps, "amplitude": args.amplitude, "detailed": args.detail_stages}
    prefix = reference.AGENT.partition("function exportFrames()")[0].replace("Interceptor.attach(at(0x54c79c)", "Interceptor.attach(at(0x94c79c)")
    if not args.detail_stages:
        prefix = prefix.replace("Interceptor.attach(at(0x94c79c), {onLeave() { parsedFrames++; lastFrameParse = Date.now(); }});", "")
    zoom = native.AGENT[native.AGENT.index("function exactZoom("):native.AGENT.index("function beginPlayback()")]
    agent = (prefix + AGENT.replace("__EXACT_ZOOM__", zoom)).replace("__CONFIG__", json.dumps(config))
    (output / "instrumentation.js").write_text(agent, encoding="utf-8")
    executable = ROOT / "Pivot Animator v5/pivot.exe"
    startup = subprocess.STARTUPINFO(); startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW; startup.wShowWindow = 1
    events, result = [], {"trial": number, "status": "running", "configuration": config}
    process = session = mouse = None
    log = (output / "events.jsonl").open("w", encoding="utf-8")
    try:
        process = subprocess.Popen([str(executable)], cwd=executable.parent, env=dict(os.environ, APPDATA=str(profile)), startupinfo=startup, creationflags=0x4 | subprocess.CREATE_NEW_PROCESS_GROUP)
        result["owned_pid"] = process.pid
        session = frida.attach(process.pid); script = session.create_script(agent)
        def message(message, data):
            entry = message.get("payload", message); events.append(entry); log.write(json.dumps(entry) + "\n"); log.flush()
            if entry.get("event") in {"ready", "load_returned", "import_complete", "gesture_armed", "observed_canvas", "error"}:
                print(json.dumps({k: v for k, v in entry.items() if k not in {"stages", "presentations"}}), flush=True)
        script.on("message", message); script.load()
        ntdll = ctypes.WinDLL("ntdll"); ntdll.NtResumeProcess.argtypes = [ctypes.c_void_p]; ntdll.NtResumeProcess.restype = ctypes.c_long
        if ntdll.NtResumeProcess(int(process._handle)):
            raise RuntimeError("Could not resume owned Pivot")
        deadline = time.monotonic() + args.timeout
        previous = None; stable = time.monotonic()
        while time.monotonic() < deadline:
            state = script.exports_sync.state()
            current = (state.get("frames"), state.get("parsedFrames"))
            if current != previous:
                stable = time.monotonic()
            if state.get("initialized") and time.monotonic() - stable > 1:
                break
            previous = current; time.sleep(.1)
        else:
            raise TimeoutError("Empty native application initialization timed out")
        result["startup"] = state
        result["window"] = native.prepare_owned_window(process.pid, 1288, 837)
        for attempt in range(3):
            count = sum(e.get("event") == "viewport" for e in events); script.exports_sync.viewport()
            view = wait_event(events, "viewport", count, process, deadline)
            if [view["width"], view["height"]] == [1120, 652]:
                break
            r = result["window"]["after"]["rect"]
            result["window"] = native.prepare_owned_window(process.pid, r[2]-r[0]+1120-view["width"], r[3]-r[1]+652-view["height"])
        for label in ["process-cold-os-cache-uncontrolled", "same-process-warm"]:
            count = sum(e.get("event") == "import_complete" for e in events); script.exports_sync.load(label)
            imported = wait_event(events, "import_complete", count, process, deadline)
            viewport_state = imported.get("viewport", {})
            if [viewport_state.get("width"), viewport_state.get("height")] != [1120, 652] or abs(viewport_state.get("matrix", [0])[0] - args.scale) > 1e-6:
                raise RuntimeError("Native import did not use the required matched viewport and scale")
        script.exports_sync.setup(); setup = wait_event(events, "gesture_setup", 0, process, deadline)
        (output / "before-scene.json").write_text(json.dumps(setup.pop("scene")), encoding="utf-8")
        result["setup"] = setup
        mouse = Mouse(process.pid); mouse.move(setup["start"]); time.sleep(.1)
        script.exports_sync.begin(); wait_event(events, "gesture_armed", 0, process, deadline)
        mouse.button(True); time.sleep(.1)
        hit = script.exports_sync.hit(); result["hit"] = hit
        if hit["uid"] != args.uid or hit["segment"] != 0:
            raise RuntimeError("Actual native mouse-down hit a different handle; gesture aborted")
        sent = []
        for target in setup["trajectory"]:
            sent.append({"i": target["i"], **mouse.move(target["screen"])})
            time.sleep(args.interval_ms / 1000)
        time.sleep(.12); mouse.button(False); time.sleep(.2)
        script.exports_sync.finish(); finished = wait_event(events, "gesture_complete", 0, process, deadline)
        (output / "after-scene.json").write_text(json.dumps(finished.pop("scene")), encoding="utf-8")
        result["gesture"] = finished; result["sent"] = sent; result["measurements"] = script.exports_sync.results()
        poses = finished["poseEvents"]
        if not poses or any(pose["uid"] != args.uid or pose["segment"] != 0 for pose in poses):
            raise RuntimeError("Actual native mouse gesture did not consistently pose the requested parent joint")
        if not all(pose["root"] == setup["root"] for pose in poses):
            raise RuntimeError("Parent origin moved during native posing")
        responses = []
        for pose in poses:
            matching = [p for p in finished["presentations"] if p["poseId"] == pose["id"] and p["start"] >= pose["end"] and p["result"] == 0]
            if matching:
                responses.append({"poseId": pose["id"], "inputId": pose["inputId"], "inputToPresentMs": matching[0]["end"]-pose["inputStart"], "poseWallMs": pose["end"]-pose["start"], "target": pose["target"], "present": matching[0]})
        result["responses"] = responses
        result["summary"] = {"poses": len(poses), "successfulPresentedPoses": len(responses), "inputToPresent": quantiles([r["inputToPresentMs"] for r in responses]), "poseWall": quantiles([r["poseWallMs"] for r in responses]), "sourceUnchanged": reference.sha256(args.input) == args.source_hash}
        result["status"] = "complete" if responses and len(responses) == len(poses) else "presentation_coverage_incomplete"
    except Exception as error:
        result.update(status="failed", error=str(error)); raise
    finally:
        if mouse:
            mouse.restore()
        if process:
            if process.poll() is None: process.kill()
            process.wait(timeout=10)
        if session:
            try: session.detach()
            except Exception: pass
        log.close(); (output / "report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path); parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--trials", type=int, default=3); parser.add_argument("--uid", type=int, default=460616)
    parser.add_argument("--steps", type=int, default=24); parser.add_argument("--amplitude", type=float, default=8)
    parser.add_argument("--scale", type=float, default=1.4911764860153198); parser.add_argument("--interval-ms", type=float, default=40)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--detail-stages", action="store_true", help="Add per-frame, per-type and ReadFile hooks; use only for stage diagnosis, not the lightweight baseline")
    args = parser.parse_args()
    if not 1 <= args.trials <= 5 or not 1 <= args.steps <= 240 or not all(math.isfinite(v) and v > 0 for v in [args.amplitude, args.scale, args.interval_ms, args.timeout]):
        parser.error("Invalid bounded benchmark configuration")
    args.input = args.input.resolve(strict=True); args.output = args.output.resolve()
    if reference.sha256(ROOT / "Pivot Animator v5/pivot.exe") != reference.SUPPORTED_PIVOT_SHA256:
        raise ValueError("Native addresses require the exact guarded original executable")
    args.source_hash = reference.sha256(args.input)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {"schema": "native-pivot-editor-performance/v1", "status": "running", "source": str(args.input), "sourceSha256": args.source_hash,
              "pivotSha256": reference.SUPPORTED_PIVOT_SHA256, "trials": [], "limitations": [
                  "Cold means fresh process/profile; the operating-system file cache is uncontrolled.",
                  "Input latency begins when the native form receives a move, and ends at a successful main-window DXGI.Present return; physical scanout is not measured.",
                  "Native standard editing uses raw document coordinates with zoom/pan; saved frame camera affects its guide, not figure coordinates.",
                  "Nested loader stages overlap and must not be added. Frida instrumentation overhead is included."]}
    try:
        for number in range(args.trials):
            report["trials"].append(trial(args, args.output / f"trial-{number+1}", number + 1))
        report["status"] = "complete" if all(r["status"] == "complete" for r in report["trials"]) else "incomplete"
        report["importSummary"] = {}
        for label in ["process-cold-os-cache-uncontrolled", "same-process-warm"]:
            rows = [row for trial_result in report["trials"] for row in trial_result["measurements"]["imports"] if row["label"] == label]
            report["importSummary"][label] = {key: quantiles([row.get(key) for row in rows]) for key in ["loaderWallMs", "sourceReadWallMs", "firstVisibleMs", "importToEditableVisibleMs"]}
        report["inputSummary"] = {key: quantiles([row[key] for trial_result in report["trials"] for row in trial_result["responses"]]) for key in ["inputToPresentMs", "poseWallMs"]}
    except Exception as error:
        report.update(status="failed", error=str(error))
        raise
    finally:
        report["sourceUnchanged"] = reference.sha256(args.input) == args.source_hash
        (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0 if report["status"] == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())

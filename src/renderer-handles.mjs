/** Retained screen-sized handles. One ordered instanced draw replaces thousands
 * of Canvas2D paths; unchanged descriptors never upload their records again. */
const shader=/* wgsl */`
struct Globals { row0:vec4f, row1:vec4f, viewport:vec4f, clip:vec4f }
struct Handle { point:vec4f, color:vec4f }
@group(0) @binding(0) var<uniform> globals:Globals;
@group(0) @binding(1) var<storage,read> handles:array<Handle>;
struct Vertex { @builtin(position) position:vec4f, @location(0) local:vec2f, @location(1) @interpolate(flat) index:u32 }
@vertex fn vs(@builtin(vertex_index) vertex:u32,@builtin(instance_index) index:u32)->Vertex {
  let h=handles[index];
  var corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  let local=corners[vertex]*(h.point.z+h.point.w*0.5+1.0/globals.viewport.z);
  let center=vec2f(dot(globals.row0.xyz,vec3f(h.point.xy,1)),dot(globals.row1.xyz,vec3f(h.point.xy,1)));
  let screen=center+local;
  var out:Vertex;
  out.position=vec4f(screen.x/globals.viewport.x*2-1,1-screen.y/globals.viewport.y*2,0,1);
  out.local=local;out.index=index;return out;
}
@fragment fn fs(v:Vertex)->@location(0) vec4f {
  let h=handles[v.index];let distance=length(v.local);let aa=0.5/globals.viewport.z;
  let coverage=1-smoothstep(h.point.z+h.point.w*0.5-aa,h.point.z+h.point.w*0.5+aa,distance);
  let stroke=h.point.w*smoothstep(h.point.z-0.5-aa,h.point.z-0.5+aa,distance);
  let outlineColor=select(vec3f(0),vec3f(0.05098,0.6,1),h.color.w>0.5);
  return vec4f(mix(h.color.rgb,outlineColor,stroke)*coverage,coverage);
}`;

export class HandleRenderer {
  constructor(device,uniform){this.device=device;this.uniform=uniform;this.previous=[];this.offsets=[];this.colors=new Map();}
  async initialize(format){
    const d=this.device,module=d.createShaderModule({code:shader,label:'Screen-sized editor handles'});
    const info=await module.getCompilationInfo(),errors=info.messages.filter(m=>m.type==='error');
    if(errors.length)throw new Error(errors.map(m=>m.message).join('\n'));
    this.pipeline=await d.createRenderPipelineAsync({label:'Retained editor handles',layout:'auto',vertex:{module,entryPoint:'vs'},
      fragment:{module,entryPoint:'fs',targets:[{format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
      primitive:{topology:'triangle-list'},multisample:{count:4}});
  }
  update(handles,translations,outline){
    const d=this.device,size=Math.max(32,handles.length*32);let reset=this.outline!==outline;
    if(!this.buffer||this.buffer.size<size){
      this.buffer?.destroy();const capacity=2**Math.ceil(Math.log2(size));
      this.buffer=d.createBuffer({label:'Retained handle records',size:capacity,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      this.data=new Float32Array(capacity/4);
      this.bindGroup=d.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.buffer}}]});reset=true;
    }
    if(handles.groups){
      let bytes=0;const next=[];
      for(let i=0;i<handles.groups.length;i++){
        const group=handles.groups[i],delta=translations?.get(group.uid),x=delta?.x||0,y=delta?.y||0,prior=this.groups?.[i];
        next.push({handles:group.handles,offset:group.offset,x,y});
        if(!reset&&prior?.handles===group.handles&&prior.offset===group.offset&&prior.x===x&&prior.y===y)continue;
        for(let j=0;j<group.handles.length;j++)this.write(group.handles[j],group.offset+j,x,y,outline);
        const count=group.handles.length*8;
        if(count){d.queue.writeBuffer(this.buffer,group.offset*32,this.data,group.offset*8,count);bytes+=count*4;}
      }
      this.groups=next;this.previous=[];this.offsets=[];this.outline=outline;this.count=handles.length;return bytes;
    }
    this.groups=null;
    let begin=-1,bytes=0;
    const flush=end=>{if(begin<0)return;const count=(end-begin)*8;d.queue.writeBuffer(this.buffer,begin*32,this.data,begin*8,count);bytes+=count*4;begin=-1;};
    for(let i=0;i<handles.length;i++){
      const h=handles[i],delta=translations?.get(h.uid),x=delta?.x||0,y=delta?.y||0;
      if(!reset&&this.previous[i]===h&&this.offsets[i*2]===x&&this.offsets[i*2+1]===y){flush(i);continue;}
      if(begin<0)begin=i;
      this.write(h,i,x,y,outline);
      this.offsets[i*2]=x;this.offsets[i*2+1]=y;
    }
    flush(handles.length);this.previous=handles;this.offsets.length=handles.length*2;this.outline=outline;this.count=handles.length;return bytes;
  }
  write(h,index,x,y,outline){
    let color=this.colors.get(h.color);
    if(!color){const hex=h.color.slice(1);color=[0,2,4].map(n=>parseInt(hex.slice(n,n+2),16)/255);this.colors.set(h.color,color);}
    const offset=index*8,data=this.data;
    data[offset]=h.point.x+x;data[offset+1]=h.point.y+y;data[offset+2]=h.screenRadius;data[offset+3]=outline||h.ik?1:0;
    data[offset+4]=color[0];data[offset+5]=color[1];data[offset+6]=color[2];data[offset+7]=h.ik?1:0;
  }
  draw(pass){if(!this.count)return 0;pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.bindGroup);pass.draw(6,this.count);return 1;}
  destroy(){this.buffer?.destroy();this.previous=[];this.offsets=[];this.groups=null;this.data=null;}
}

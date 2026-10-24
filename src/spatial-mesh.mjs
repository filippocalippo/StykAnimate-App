import {messageError} from './localized-error.mjs';
/** Figure-level indexed skinned meshes. Vertices, triangles and colours are
 * immutable definition data bound to the figure's own spatial bones. They never
 * become joints, fills or per-frame pose channels: a pose evaluates them into
 * typed arrays consumed by one depth-tested draw. See docs/SPATIAL-MESHES.md.
 *
 * Evaluation follows rig-spatial skinning operation for operation, so a mesh
 * converted from native skin joints reproduces their projected positions. */
import {spatialBone,spatialViewInterpolation} from './rig-spatial.mjs';

const EPS=1e-9,NEAR=.05;
export const MESH_LIMITS=Object.freeze({vertices:200000,triangles:400000,colors:1024,groups:1024});
const KEYS=new Set(['positions','bones','weights','indices','colors','materials','basis','z','views','viewVertices','viewPoints','groups']);
export const spatialMeshOf=figure=>figure?._styk?.spatialMesh;

export function validateSpatialMesh(figure){
  const m=spatialMeshOf(figure);if(m===undefined)return;
  const fail=(key,params)=>{throw messageError(new Error(''),key,params);};
  if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!KEYS.has(k)))fail("errors.spatialMesh.invalid3dMesh", {});
  const {positions,bones,weights,indices,colors,materials,basis}=m;
  if(!Array.isArray(positions)||positions.length<9||positions.length%3)fail("errors.spatialMesh.a3dMeshNeedsXyzPositionsForAt", {});
  const count=positions.length/3;
  if(count>MESH_LIMITS.vertices)fail("errors.spatialMesh.a3dMeshCanHaveUpToVertices", {vertices: MESH_LIMITS.vertices});
  for(const v of positions)if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e6)fail("errors.spatialMesh.failure3dMeshPositionsMustBeFinite", {});
  if(!Array.isArray(bones)||bones.length!==count*4||!Array.isArray(weights)||weights.length!==count*4)fail("errors.spatialMesh.each3dMeshVertexNeedsFourBoneAnd", {});
  const ids=new Map(figure.segments.map((s,i)=>[s.segment_id,i])),checked=new Set();
  for(let v=0;v<count;v++){
    let sum=0;
    for(let k=0;k<4;k++){
      const bone=bones[v*4+k],weight=weights[v*4+k];
      if(!Number.isInteger(bone)||bone<0||bone>65535||typeof weight!=='number'||!Number.isFinite(weight)||weight<0||weight>1)fail("errors.spatialMesh.failure3dMeshBindingsNeedBoneIdsAndWeights", {});
      if((bone===0)!==(weight===0)||(k===0&&bone===0))fail("errors.spatialMesh.bindEvery3dMeshVertexToAtLeast", {});
      if(!bone)continue;
      for(let j=0;j<k;j++)if(bones[v*4+j]===bone)fail("errors.spatialMesh.a3dMeshVertexCannotBindOneBone", {});
      if(!checked.has(bone)){if(!spatialBone(figure.segments[ids.get(bone)]))fail("errors.spatialMesh.failure3dMeshVerticesMustBindArticulatedSpatialJoints", {});checked.add(bone);}
      sum+=weight;
    }
    if(Math.abs(sum-1)>1e-6)fail("errors.spatialMesh.failure3dMeshVertexWeightsMustAddUpTo", {});
  }
  if(!Array.isArray(indices)||!indices.length||indices.length%3)fail("errors.spatialMesh.a3dMeshNeedsTriangleIndices", {});
  const triangles=indices.length/3;
  if(triangles>MESH_LIMITS.triangles)fail("errors.spatialMesh.a3dMeshCanHaveUpToTriangles", {triangles: MESH_LIMITS.triangles});
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i],b=indices[i+1],c=indices[i+2];
    for(const n of [a,b,c])if(!Number.isInteger(n)||n<0||n>=count)fail("errors.spatialMesh.failure3dMeshTrianglesMustReferenceExistingVertices", {});
    if(a===b||b===c||a===c)fail("errors.spatialMesh.failure3dMeshTrianglesNeedThreeDifferentVertices", {});
  }
  if(!Array.isArray(colors)||!colors.length||colors.length>MESH_LIMITS.colors||colors.some(c=>!Array.isArray(c)||c.length!==3||c.some(v=>!Number.isInteger(v)||v<0||v>255)))
    fail("errors.spatialMesh.a3dMeshNeeds1RgbColours", {colors: MESH_LIMITS.colors});
  if(!Array.isArray(materials)||materials.length!==triangles||materials.some(i=>!Number.isInteger(i)||i<0||i>=colors.length))fail("errors.spatialMesh.each3dMeshTriangleNeedsAColour", {});
  if(!Array.isArray(basis)||basis.length!==3||basis.some(id=>!Number.isInteger(id)||(id!==0&&!ids.has(id)))||basis[1]===0||basis[2]===0||basis[1]===basis[2])
    fail("errors.spatialMesh.a3dMeshNeedsItsOriginXAnd", {});
  if(m.z!==undefined&&(typeof m.z!=='number'||!Number.isFinite(m.z)||Math.abs(m.z)>1e6))fail("errors.spatialMesh.failure3dMeshDepthOrderMustBeFinite", {});
  if(m.views!==undefined||m.viewVertices!==undefined||m.viewPoints!==undefined){
    const {views,viewVertices,viewPoints}=m;
    if(![4,8].includes(views)||!Array.isArray(viewVertices)||!viewVertices.length||!Array.isArray(viewPoints)||viewPoints.length!==viewVertices.length*views*3)
      fail("errors.spatialMesh.viewCorrectedMeshVerticesNeedFourOrEight", {});
    let previous=-1;
    for(const v of viewVertices){
      if(!Number.isInteger(v)||v<=previous||v>=count)fail("errors.spatialMesh.viewCorrectedVerticesMustBeListedOnceIn", {});
      if(weights[v*4]!==1)fail("errors.spatialMesh.viewCorrectedMeshVerticesMustFollowOneBone", {});
      previous=v;
    }
    for(const n of viewPoints)if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e6)fail("errors.spatialMesh.failure3dMeshViewPositionsMustBeFinite", {});
  }
  if(m.groups!==undefined){
    if(!Array.isArray(m.groups)||m.groups.length>MESH_LIMITS.groups)fail("errors.spatialMesh.invalid3dMeshParts", {});
    let end=0;
    for(const g of m.groups){
      if(!g||typeof g!=='object'||Object.keys(g).some(k=>!['name','start','count'].includes(k))||typeof g.name!=='string'||g.name.length>256||
        !Number.isInteger(g.start)||!Number.isInteger(g.count)||g.count<1||g.start<end||g.start+g.count>triangles)fail("errors.spatialMesh.failure3dMeshPartsNeedNamesAndOrderedTriangle", {});
      end=g.start+g.count;
    }
  }
}

/** Remap bone and reference joint IDs, e.g. when figures are combined. The
 * returned mesh shares every array that the remap leaves unchanged. */
export function remapSpatialMesh(mesh,map){
  const id=n=>n===0?0:map.get(n)??n;
  if(!mesh.bones.some(n=>id(n)!==n)&&!mesh.basis.some(n=>id(n)!==n))return mesh;
  return {...mesh,bones:mesh.bones.map(id),basis:mesh.basis.map(id)};
}
export const spatialMeshBones=mesh=>new Set([...(mesh?.bones??[]).filter(Boolean),...(mesh?.basis??[]).filter(Boolean)]);

/** Definition data is compiled once per immutable mesh and joint layout.
 * Vertex slots hold bone ordinals; `bones[ordinal]` is the segment index. */
const plans=new WeakMap();
export function spatialMeshPlan(figure,ids){
  const mesh=spatialMeshOf(figure);if(!mesh)return null;
  const cached=plans.get(mesh);
  if(cached?.ids===ids)return cached.plan;
  const vertices=mesh.positions.length/3,triangles=mesh.indices.length/3,ordinals=new Map(),bones=[];
  const slots=new Int32Array(vertices*4).fill(-1),weights=new Float64Array(vertices*4),counts=new Uint8Array(vertices);
  for(let v=0;v<vertices;v++)for(let k=0;k<4;k++){
    const bone=mesh.bones[v*4+k];if(!bone)continue;
    const index=ids.get(bone);if(index===undefined)throw messageError(new Error(''), "errors.spatialMesh.a3dMeshReferencesAMissingBone", {});
    let ordinal=ordinals.get(index);if(ordinal===undefined){ordinal=bones.length;ordinals.set(index,ordinal);bones.push(index);}
    slots[v*4+counts[v]]=ordinal;weights[v*4+counts[v]]=mesh.weights[v*4+k];counts[v]++;
  }
  const viewSlot=new Int32Array(vertices).fill(-1);
  if(mesh.viewVertices)mesh.viewVertices.forEach((v,i)=>{viewSlot[v]=i;});
  const plan={mesh,vertices,triangles,positions:new Float64Array(mesh.positions),slots,weights,counts,bones:Int32Array.from(bones),
    indices:Uint32Array.from(mesh.indices),materials:Uint16Array.from(mesh.materials),palette:mesh.colors,basis:mesh.basis,base:Number(mesh.z??0),
    views:mesh.views??0,viewSlot,viewPoints:mesh.viewPoints?new Float64Array(mesh.viewPoints):null};
  plans.set(mesh,{ids,plan});
  return plan;
}

// Per-pose bone values: q(4) t(3) origin(3) axis(3) stretch, choiceScale,
// shape width, taper, rest length, dual(4), stretched flag.
const STRIDE=24;
function boneValues(f,F,b){
  F.set(f.q,b);F.set(f.t,b+4);F.set(f.origin,b+7);F.set(f.axis,b+10);F[b+13]=f.stretch;F[b+14]=f.choiceScale??NaN;
  F[b+15]=f.shape?f.shape.width:NaN;F[b+16]=f.shape?f.shape.taper:NaN;F[b+17]=f.restLength??NaN;F.set(f.dual,b+18);F[b+22]=Math.abs(f.stretch-1)>EPS?1:0;
}
// spatialPoint(frame,[x,y,z]) from cached values, in the same operation order.
function framePoint(F,b,x0,y0,z0,out,at){
  let x=x0,y=y0,z=z0;
  const ox=F[b+7],oy=F[b+8],oz=F[b+9],width=F[b+15],choice=F[b+14];
  if(width===width){
    const ax=F[b+10],ay=F[b+11],az=F[b+12],rx=x0-ox,ry=y0-oy,rz=z0-oz,d=rx*ax+ry*ay+rz*az;
    const u=Math.max(0,Math.min(1,d/F[b+17])),amount=width*(1+F[b+16]*u*u*(3-2*u))-1;
    x=x0+(rx-d*ax)*amount;y=y0+(ry-d*ay)*amount;z=z0+(rz-d*az)*amount;
  }
  if(choice===choice){x=ox+(x-ox)*choice;y=oy+(y-oy)*choice;z=oz+(z-oz)*choice;}
  else if(F[b+22]){
    const ax=F[b+10],ay=F[b+11],az=F[b+12],s=F[b+13],d=(x0-ox)*ax+(y0-oy)*ay+(z0-oz)*az;
    x=x+d*(s-1)*ax;y=y+d*(s-1)*ay;z=z+d*(s-1)*az;
  }
  const qx=F[b],qy=F[b+1],qz=F[b+2],qw=F[b+3],tx=2*(qy*z-qz*y),ty=2*(qz*x-qx*z),tz=2*(qx*y-qy*x);
  out[at]=x+qw*tx+qy*tz-qz*ty+F[b+4];out[at+1]=y+qw*ty+qz*tx-qx*tz+F[b+5];out[at+2]=z+qw*tz+qx*ty-qy*tx+F[b+6];
}
const scratch=new Float64Array(3);

/** A vertex bound to several bones: dual-quaternion blend, or a linear blend
 * of bone positions while any bone stretches (rig-spatial skinPoint). */
function blendedVertex(plan,F,v,px,py,pz,out){
  const count=plan.counts[v],base=v*4,first=plan.slots[base]*STRIDE;
  let x=0,y=0,z=0,w=0,dx=0,dy=0,dz=0,dw=0,stretch=false,shaped=false;
  for(let k=0;k<count;k++){
    const b=plan.slots[base+k]*STRIDE;stretch||=F[b+22]===1;shaped||=F[b+15]===F[b+15];
    const weight=plan.weights[base+k]*(F[b]*F[first]+F[b+1]*F[first+1]+F[b+2]*F[first+2]+F[b+3]*F[first+3]<0?-1:1);
    x+=F[b]*weight;y+=F[b+1]*weight;z+=F[b+2]*weight;w+=F[b+3]*weight;dx+=F[b+18]*weight;dy+=F[b+19]*weight;dz+=F[b+20]*weight;dw+=F[b+21]*weight;
  }
  if(stretch){
    let sx=0,sy=0,sz=0;
    for(let k=0;k<count;k++){framePoint(F,plan.slots[base+k]*STRIDE,px,py,pz,scratch,0);const weight=plan.weights[base+k];sx+=scratch[0]*weight;sy+=scratch[1]*weight;sz+=scratch[2]*weight;}
    out[0]=sx;out[1]=sy;out[2]=sz;return;
  }
  const norm=Math.hypot(x,y,z,w);x/=norm;y/=norm;z/=norm;w/=norm;dx/=norm;dy/=norm;dz/=norm;dw/=norm;
  const tx=2*(y*pz-z*py),ty=2*(z*px-x*pz),tz=2*(x*py-y*px);
  let rx=px+w*tx+y*tz-z*ty+2*(-dw*x+dx*w-dy*z+dz*y),
    ry=py+w*ty+z*tx-x*tz+2*(-dw*y+dx*z+dy*w-dz*x),
    rz=pz+w*tz+x*ty-y*tx+2*(-dw*z-dx*y+dy*x+dz*w);
  if(shaped){
    // Blend radial offsets in bind space, then rotate with the blended frame.
    let ox=0,oy=0,oz=0;
    for(let k=0;k<count;k++){
      const b=plan.slots[base+k]*STRIDE,width=F[b+15];if(width!==width)continue;
      const ax=F[b+10],ay=F[b+11],az=F[b+12],rx0=px-F[b+7],ry0=py-F[b+8],rz0=pz-F[b+9],d=rx0*ax+ry0*ay+rz0*az;
      const u=Math.max(0,Math.min(1,d/F[b+17])),amount=width*(1+F[b+16]*u*u*(3-2*u))-1,weight=plan.weights[base+k];
      ox+=(rx0-d*ax)*amount*weight;oy+=(ry0-d*ay)*amount*weight;oz+=(rz0-d*az)*amount*weight;
    }
    const ux=2*(y*oz-z*oy),uy=2*(z*ox-x*oz),uz=2*(x*oy-y*ox);
    rx+=ox+w*ux+y*uz-z*uy;ry+=oy+w*uy+z*ux-x*uz;rz+=oz+w*uz+x*uy-y*ux;
  }
  out[0]=rx;out[1]=ry;out[2]=rz;
}

const FRAME_VALUES=14;
function frameValues(f,key,at){
  key.set(f.q,at);key.set(f.t,at+4);key[at+7]=f.stretch;key[at+8]=f.choiceScale??NaN;
  key[at+9]=f.shape?.width??NaN;key[at+10]=f.shape?.taper??NaN;key[at+11]=f.restLength??NaN;key[at+12]=f.nativeBend;key[at+13]=0;
}
const sameKey=(a,b)=>{if(!a||a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i]&&!(a[i]!==a[i]&&b[i]!==b[i]))return false;return true;};

/** Evaluate a pose. `frames[i]` is the spatial frame of segment i; `context`
 * supplies the figure transform, basis joints and colour function. An
 * unchanged pose returns its predecessor's arrays; nothing else is retained. */
export function* evaluateSpatialMeshSteps(plan,frames,context,previous){
  const {root,scale,figureAngle,mirror,camera,joints,colorOf,slot}=context;
  const o=joints.get(plan.basis[0]),bx=joints.get(plan.basis[1]),by=joints.get(plan.basis[2]),B=plan.bones.length;
  const key=new Float64Array(B*FRAME_VALUES+18),F=new Float64Array(B*STRIDE),W=plan.views?new Float64Array(B*6):null;
  for(let i=0;i<B;i++){
    const f=frames[plan.bones[i]];if(!f)throw messageError(new Error(''), "errors.spatialMesh.a3dMeshBoneWasNotEvaluated", {});
    frameValues(f,key,i*FRAME_VALUES);boneValues(f,F,i*STRIDE);
    if(W){const view=spatialViewInterpolation(f),interval=plan.views===8?view.eight:view.four;W.set([interval.index,interval.next,interval.blend,view.cos,view.sin,view.strength],i*6);}
  }
  const g=B*FRAME_VALUES;
  key[g]=root.x;key[g+1]=root.y;key[g+2]=scale;key[g+3]=figureAngle;key[g+4]=mirror?1:0;
  key[g+5]=camera?camera.k:NaN;key[g+6]=camera?camera.root.x:NaN;key[g+7]=camera?camera.root.y:NaN;key[g+8]=camera?camera.scale:NaN;
  for(const [j,p] of [o,bx,by].entries()){key[g+9+j*2]=p?p.x:NaN;key[g+10+j*2]=p?p.y:NaN;}
  key[g+15]=o?1:0;key[g+16]=bx?1:0;key[g+17]=by?1:0;
  const colors=plan.palette.map(colorOf);
  if(previous?.plan===plan&&sameKey(previous.key,key)){
    const same=previous.colors.length===colors.length&&colors.every((c,i)=>c[0]===previous.colors[i][0]&&c[1]===previous.colors[i][1]&&c[2]===previous.colors[i][2]);
    return same?previous:{...previous,colors};
  }
  const n=plan.vertices,cs=Math.cos(figureAngle),sn=Math.sin(figureAngle),sign=mirror?-1:1,base=plan.base;
  const nearZ=camera?(1-NEAR)/camera.k:Infinity,P=plan.positions,counts=plan.counts,slots=plan.slots,viewSlot=plan.viewSlot,views=plan.viewPoints,stride=plan.views*3;
  let positions=new Float32Array(n*2),depth=new Float32Array(n),extra=0;
  const raw=camera?new Float64Array(n*3):null,point=new Float64Array(3);
  const dx=bx&&o?bx.x-o.x:0,dy=bx&&o?bx.y-o.y:0,den=dx*dx+dy*dy,flat=o&&den>=1e-16;
  // Bounds and the depth range cover the vertices of visible faces only, as
  // native surfaces do; the range sets depth-buffer quantization.
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity,zMin=Infinity,zMax=-Infinity;
  const used=new Uint8Array(n);
  for(let v=0;v<n;v++){
    let px=P[v*3],py=P[v*3+1],pz=P[v*3+2];
    if(counts[v]===1){
      const b=slots[v*4]*STRIDE,view=viewSlot[v];
      if(view>=0){
        const w=slots[v*4]*6,a=view*stride+W[w]*3,c=view*stride+W[w+1]*3,t=W[w+2],cos=W[w+3],sin=W[w+4],k=W[w+5];
        const x=views[a]+(views[c]-views[a])*t,y=views[a+1]+(views[c+1]-views[a+1])*t,z=views[a+2]+(views[c+2]-views[a+2])*t;
        px=px+(F[b+7]+x*cos-z*sin-px)*k;py=py+(F[b+8]+y-py)*k;pz=pz+(F[b+9]+x*sin+z*cos-pz)*k;
      }
      framePoint(F,b,px,py,pz,point,0);
    }else blendedVertex(plan,F,v,px,py,pz,point);
    const X=root.x+(point[0]*cs-point[1]*sign*sn)*scale,Y=root.y+(point[0]*sn+point[1]*sign*cs)*scale;
    let sx,sy,d;
    if(camera){
      const rz=point[2]*scale,q=Math.max(NEAR,1-camera.k*rz);
      sx=camera.root.x+(X-camera.root.x)/q;sy=camera.root.y+(Y-camera.root.y)/q;d=base+rz/q/camera.scale;
      raw[v*3]=X;raw[v*3+1]=Y;raw[v*3+2]=rz;
    }else{sx=X;sy=Y;d=flat?base+((root.x+point[2]*scale*cs-o.x)*dx+(root.y+point[2]*scale*sn-o.y)*dy)/den:base;}
    positions[v*2]=sx;positions[v*2+1]=sy;depth[v]=d;
    if((v&8191)===8191)yield {phase:'geometry',stage:'mesh vertices',slot,completed:v+1,total:n};
  }
  const parity=o&&bx&&by?Math.sign(dx*(by.y-o.y)-dy*(by.x-o.x)):0,I=plan.indices,M=plan.materials;
  let triangles=new Uint32Array(plan.triangles*3),materials=new Uint16Array(plan.triangles),z=new Float32Array(plan.triangles),count=0;
  const grow=()=>{const size=Math.max(16,count*2);let t=new Uint32Array(size*3);t.set(triangles);triangles=t;t=new Uint16Array(size);t.set(materials);materials=t;t=new Float32Array(size);t.set(z);z=t;};
  for(let t=0;parity&&t<plan.triangles;t++){
    const a=I[t*3],b=I[t*3+1],c=I[t*3+2];
    if(!camera||(raw[a*3+2]<=nearZ&&raw[b*3+2]<=nearZ&&raw[c*3+2]<=nearZ)){
      const ax=positions[a*2],ay=positions[a*2+1],ux=positions[b*2]-ax,uy=positions[b*2+1]-ay,vx=positions[c*2]-ax,vy=positions[c*2+1]-ay;
      if((ux*vy-uy*vx)*parity<=Math.max(ux*ux+uy*uy,vx*vx+vy*vy)*2e-7)continue;
      if(count===materials.length)grow();
      triangles[count*3]=a;triangles[count*3+1]=b;triangles[count*3+2]=c;materials[count]=M[t];z[count]=(depth[a]+depth[b]+depth[c])/3;count++;
      used[a]=1;used[b]=1;used[c]=1;
    }else{
      // Clip against the near plane before projection, as native surfaces do.
      const clipped=[];
      for(const [p,q] of [[a,b],[b,c],[c,a]]){
        const pz=raw[p*3+2],qz=raw[q*3+2],inside=pz<=nearZ,next=qz<=nearZ;
        if(inside)clipped.push([raw[p*3],raw[p*3+1],pz]);
        if(inside!==next){const s=(nearZ-pz)/(qz-pz);clipped.push([raw[p*3]+(raw[q*3]-raw[p*3])*s,raw[p*3+1]+(raw[q*3+1]-raw[p*3+1])*s,nearZ]);}
      }
      if(clipped.length<3)continue;
      const projected=clipped.map(([X,Y,Z])=>{const d=Math.max(NEAR,1-camera.k*Z);return [camera.root.x+(X-camera.root.x)/d,camera.root.y+(Y-camera.root.y)/d,base+Z/d/camera.scale];});
      let area=0,extent=0;const [p0]=projected;
      for(let i=1;i<projected.length;i++){const ux=projected[i][0]-p0[0],uy=projected[i][1]-p0[1];extent=Math.max(extent,ux*ux+uy*uy);if(i+1<projected.length)area+=ux*(projected[i+1][1]-p0[1])-uy*(projected[i+1][0]-p0[0]);}
      if(area*parity<=extent*2e-7)continue;
      const ids=projected.map(([x,y,d])=>{
        const at=n+extra;
        if(at>=depth.length){const size=Math.max(64,depth.length*2);const p=new Float32Array(size*2);p.set(positions);positions=p;const q=new Float32Array(size);q.set(depth);depth=q;}
        positions[at*2]=x;positions[at*2+1]=y;depth[at]=d;extra++;
        const fx=positions[at*2],fy=positions[at*2+1],fd=depth[at];
        if(fx<x0)x0=fx;if(fx>x1)x1=fx;if(fy<y0)y0=fy;if(fy>y1)y1=fy;if(fd<zMin)zMin=fd;if(fd>zMax)zMax=fd;
        return at;
      }),value=projected.reduce((s,p)=>s+p[2],0)/projected.length;
      for(let i=1;i+1<ids.length;i++){if(count===materials.length)grow();triangles[count*3]=ids[0];triangles[count*3+1]=ids[i];triangles[count*3+2]=ids[i+1];materials[count]=M[t];z[count]=value;count++;}
    }
    if((t&16383)===16383)yield {phase:'geometry',stage:'mesh faces',slot,completed:t+1,total:plan.triangles};
  }
  for(let v=0;v<n;v++){
    if(!used[v])continue;
    const fx=positions[v*2],fy=positions[v*2+1],fd=depth[v];
    if(fx<x0)x0=fx;if(fx>x1)x1=fx;if(fy<y0)y0=fy;if(fy>y1)y1=fy;if(fd<zMin)zMin=fd;if(fd>zMax)zMax=fd;
  }
  return {plan,key,vertexCount:n+extra,positions,depth,triangles,materials,z,count,colors,
    bounds:count&&x0<=x1?{x0,y0,x1,y1}:null,zMin,zMax};
}
export function evaluateSpatialMesh(plan,frames,context,previous){
  const steps=evaluateSpatialMeshSteps(plan,frames,context,previous);
  for(;;){const step=steps.next();if(step.done)return step.value;}
}

/** Painter-order drawables for an evaluated mesh. Other visible primitives of
 * the same figure split its triangles exactly where native per-face ordering
 * would place them; a face tied with a primitive draws before it. */
export function spatialMeshDrawables(mesh,owner,others){
  if(!mesh?.count)return [];
  const item=(index,triangles,materials,count,z)=>({type:'mesh',...owner,index,spatialMesh:mesh,triangles,materials,count,z,alpha:1});
  const levels=[...new Set(others.filter(Number.isFinite))].sort((a,b)=>a-b);
  if(!levels.length||mesh.zMax<levels[0])return [item(0,mesh.triangles,mesh.materials,mesh.count,levels.length?levels[0]:mesh.zMin)];
  const bucket=new Uint32Array(mesh.count),sizes=new Uint32Array(levels.length+1);
  for(let t=0;t<mesh.count;t++){
    const value=mesh.z[t];let lo=0,hi=levels.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(levels[mid]<value)lo=mid+1;else hi=mid;}
    bucket[t]=lo;sizes[lo]++;
  }
  const result=[];
  for(let k=0;k<=levels.length;k++){
    if(!sizes[k])continue;
    const triangles=new Uint32Array(sizes[k]*3),materials=new Uint16Array(sizes[k]);let at=0;
    for(let t=0;t<mesh.count;t++)if(bucket[t]===k){triangles.set(mesh.triangles.subarray(t*3,t*3+3),at*3);materials[at]=mesh.materials[t];at++;}
    result.push(item(k,triangles,materials,sizes[k],k<levels.length?levels[k]:mesh.zMax));
  }
  return result;
}

/** Axis-aligned bounds of the visible faces, or null. */
export const spatialMeshBounds=mesh=>mesh?.bounds??null;

/** Point-in-visible-face test for selection (screen space, no depth). */
export function spatialMeshContains(mesh,x,y){
  if(!mesh?.bounds||x<mesh.bounds.x0||x>mesh.bounds.x1||y<mesh.bounds.y0||y>mesh.bounds.y1)return false;
  const p=mesh.positions,T=mesh.triangles;
  for(let t=0;t<mesh.count;t++){
    const a=T[t*3]*2,b=T[t*3+1]*2,c=T[t*3+2]*2;
    const d1=(x-p[b])*(p[a+1]-p[b+1])-(p[a]-p[b])*(y-p[b+1]),d2=(x-p[c])*(p[b+1]-p[c+1])-(p[b]-p[c])*(y-p[c+1]),d3=(x-p[a])*(p[c+1]-p[a+1])-(p[c]-p[a])*(y-p[a+1]);
    if(!((d1<0||d2<0||d3<0)&&(d1>0||d2>0||d3>0)))return true;
  }
  return false;
}

/** Geometry in SVG coordinates (Y down). Files store angles in degrees, Y up. */
export const TAU=Math.PI*2;
export const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export const wrapDegrees=x=>((x%360)+360)%360;
export const signedDegrees=x=>((x+540)%360)-180;
export const mulMatrix=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
export const matrixPoint=(m,x,y)=>({x:m[0]*x+m[2]*y+m[4],y:m[1]*x+m[3]*y+m[5]});
export function inverseMatrix(m){const d=m[0]*m[3]-m[1]*m[2];if(Math.abs(d)<1e-12)throw new Error('Cannot edit a singular (zero-scale) transform.');return [m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];}
export function poseMatrix(x=0,y=0,scale=1,rotation=0,flipX=1,flipY=1){const a=-rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return [c*scale*flipX,s*scale*flipX,-s*scale*flipY,c*scale*flipY,x,-y];}
/** Arc centerline from the native sagitta/circulization convention. Not a quadratic Bezier. */
export function segmentCurve(length,sagitta,circular=false,samples=48){
 const L=Math.max(0,length),h=Math.abs(sagitta),sign=Math.sign(sagitta)||1,n=clamp(Math.ceil(samples),8,256);
 if(h<1e-7)return {kind:'line',points:[{x:0,y:0},{x:L,y:0}]};
 if(L<1e-7){const r=h/2;return {kind:'circle',radius:r,center:{x:0,y:-sign*r},largeArc:true,points:Array.from({length:n+1},(_,i)=>{const a=sign*(Math.PI/2+TAU*i/n);return {x:r*Math.cos(a),y:-sign*r+r*Math.sin(a)}})};}
 if(!circular&&h<L/2){return {kind:'ellipse',rx:L/2,ry:h,largeArc:false,points:Array.from({length:n+1},(_,i)=>{const a=Math.PI-Math.PI*i/n;return {x:L/2+L/2*Math.cos(a),y:-sign*h*Math.sin(a)}})};}
 const r=(L*L/4+h*h)/(2*h),cy=sign*(r-h),a0=Math.atan2(-cy,-L/2),sweep=sign*4*Math.atan2(h,L/2);
 return {kind:'arc',radius:r,center:{x:L/2,y:cy},largeArc:h>L/2,points:Array.from({length:n+1},(_,i)=>{const a=a0+sweep*i/n;return {x:L/2+r*Math.cos(a),y:cy+r*Math.sin(a)}})};
}
export function toSegmentWorld(p,along,side=0){const rad=-p.angle*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad);return {x:p.start.x+c*along-s*side,y:p.start.y+s*along+c*side};}

/** Pivot's monotone cubic, retained when detaching imported property curves. */
export const shortestPropertyAngle = angle => ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
export function sampleNativePropertyCurve(keys, index, t, angular) {
  let left=index,right=index+1;
  while(left>0 && keys[left].tick-keys[left-1].tick>1 && keys[left-1].nativeCurve==='pchip') left--;
  while(right<keys.length-1 && keys[right+1].tick-keys[right].tick>1 && keys[right].nativeCurve==='pchip') right++;
  const values=[keys[left].value],times=[0];
  for(let i=left+1;i<=right;i++) {
    times.push(keys[i].tick-keys[left].tick);
    values.push(angular ? values.at(-1)+shortestPropertyAngle(keys[i].value-values.at(-1)) : keys[i].value);
  }
  const j=index-left,n=values.length;
  if(n<3)return values[j]+(values[j+1]-values[j])*t;
  const h=times.slice(1).map((v,i)=>v-times[i]),d=h.map((v,i)=>(values[i+1]-values[i])/v);
  const endpoint=(h0,h1,d0,d1)=>{let m=((2*h0+h1)*d0-h0*d1)/(h0+h1);if(Math.sign(m)!==Math.sign(d0))return 0;
    if(Math.sign(d0)!==Math.sign(d1)&&Math.abs(m)>3*Math.abs(d0))m=3*d0;return m;};
  const slope=i=>{
    if(i===0)return endpoint(h[0],h[1],d[0],d[1]);
    if(i===n-1)return endpoint(h.at(-1),h.at(-2),d.at(-1),d.at(-2));
    if(!d[i-1]||!d[i]||Math.sign(d[i-1])!==Math.sign(d[i]))return 0;
    const w=(2*h[i-1]+h[i])/(3*(h[i-1]+h[i]));return d[i-1]*d[i]/(w*d[i-1]+(1-w)*d[i]);
  };
  const t2=t*t,t3=t2*t;
  return (2*t3-3*t2+1)*values[j]+(t3-2*t2+t)*h[j]*slope(j)+(3*t2-2*t3)*values[j+1]+(t3-t2)*h[j]*slope(j+1);
}

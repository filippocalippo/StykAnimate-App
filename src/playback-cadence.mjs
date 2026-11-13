/** Display callback cadence from the frame loop (statistics read the refresh interval from it). The bounded
 * rolling minimum does not mistake a main-thread stall for a slower display. */
export class PlaybackCadence {
  constructor(){this.samples=new Float64Array(32);this.reset();}
  reset(){this.last=null;this.count=0;this.index=0;this.interval=null;}
  observe(now){
    const previous=this.last;this.last=now;
    if(previous===null)return;
    const delta=now-previous;
    if(!Number.isFinite(delta)||delta<4||delta>50)return;
    this.samples[this.index]=delta;this.index=(this.index+1)%this.samples.length;
    this.count=Math.min(this.samples.length,this.count+1);
    if(this.count<4)return;
    let minimum=Infinity;for(let i=0;i<this.count;i++)minimum=Math.min(minimum,this.samples[i]);
    this.interval=minimum;
  }
}

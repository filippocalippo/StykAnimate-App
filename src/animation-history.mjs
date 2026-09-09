/** Commands publish immutable channel records. Charge copied channels and table
 * references, without serializing the unrelated animation on every gesture. */
const channelBytes = new WeakMap();
const keyBytes = new WeakMap();
function size(channel, seen) {
  let bytes=channelBytes.get(channel);
  if(bytes===undefined){const {keys,...metadata}=channel;bytes=JSON.stringify(metadata).length*2;channelBytes.set(channel,bytes);}
  if(!seen.has(channel.keys)){
    let keys=keyBytes.get(channel.keys);if(keys===undefined){keys=JSON.stringify(channel.keys).length*2;keyBytes.set(channel.keys,keys);}
    bytes+=keys;seen.add(channel.keys);
  }
  return bytes;
}
export function animationChangeBytes(before,after) {
  const old=new Map((before?.channels??[]).map(channel=>[channel.id,channel]));
  const seen=new Set();
  let bytes=128+8*((before?.channels.length??0)+(after?.channels.length??0));
  for(const channel of after?.channels??[]) {
    const previous=old.get(channel.id);
    if(previous!==channel)bytes+=size(channel,seen)+(previous?size(previous,seen):0);
    old.delete(channel.id);
  }
  for(const channel of old.values())bytes+=size(channel,seen);
  for(const animation of [before,after])if(animation){const {channels,...metadata}=animation;bytes+=JSON.stringify(metadata).length*2;}
  return bytes;
}
export function animationHistoryBytes(command) {
  const {draftAnimation,...metadata}=command;
  let bytes=0;
  if(command.kind==='animation') {
    delete metadata.before;delete metadata.after;
    bytes+=animationChangeBytes(command.before,command.after);
  }
  if(draftAnimation)bytes+=animationChangeBytes(draftAnimation.before,draftAnimation.after);
  return bytes+JSON.stringify(metadata).length*2+(command.sourceBytes??0);
}

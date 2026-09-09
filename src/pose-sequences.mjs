/** Restore immutable sequence sharing after JSON/native-file decoding. The
 * incoming document belongs to the loader; published editor keys use COW. */
export function* internPoseSequencesSteps(report) {
  const records=new Map(),sequences=new Map(),visited=new Set();let serial=0,work=0;
  for(const animation of [report._styk?.animation,report._styk?.simpleFrameDraft?.animationBaseline])
    for(const channel of animation?.channels ?? []) {
      if(channel.property!=='pose'||visited.has(channel.keys))continue;
      const keys=channel.keys,ids=[];let hash=2166136261;
      for(const key of keys){
        const signature=JSON.stringify(key);let record=records.get(signature);
        if(!record)records.set(signature,record={id:++serial});
        ids.push(record.id);hash=Math.imul(hash^record.id,16777619)>>>0;
        if(++work%256===0)yield {phase:'pose sequences',checked:work};
      }
      const fingerprint=`${keys.length}:${hash}`,bucket=sequences.get(fingerprint)??[];
      const same=bucket.find(candidate=>candidate.ids.every((id,i)=>id===ids[i]));
      if(same)channel.keys=same.keys;else{bucket.push({ids,keys});sequences.set(fingerprint,bucket);}
      visited.add(channel.keys);
    }
}

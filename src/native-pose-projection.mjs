import {poseSourceFrame} from './animation-pose.mjs';

/** A figure's keys describe its own lifetime, not every frame in the movie.
 * Identical lifetimes share immutable sequences, including explicit blank keys. */
export function figurePoseSequences(report, keys) {
  const appearances = new Map();
  keys.forEach((key, index) => {
    for (const object of poseSourceFrame(report, key.value?.frameId)?.objects ?? []) {
      let indices = appearances.get(object.unique_id);
      if (!indices) appearances.set(object.unique_id, indices = []);
      indices.push(index);
    }
  });
  const sequences = new Map(), blanks = new Map(), empty = [];
  const blank = index => {
    if (!blanks.has(index)) blanks.set(index, {...keys[index], value:{frameId:null}});
    return blanks.get(index);
  };
  const byUid = new Map();
  return uid => {
    if (byUid.has(uid)) return byUid.get(uid);
    const present = appearances.get(uid);
    if (!present?.length) return empty;
    if (present.length === keys.length) return keys;
    const signature = present.join(',');
    let sequence = sequences.get(signature);
    if (!sequence) {
      sequence = [];
      if (present[0] > 0) sequence.push(blank(0));
      for (let i = 0; i < present.length; i++) {
        const index = present[i];
        sequence.push(keys[index]);
        if (index + 1 < keys.length && present[i + 1] !== index + 1) sequence.push(blank(index + 1));
      }
      sequences.set(signature, sequence);
    }
    byUid.set(uid, sequence);
    return sequence;
  };
}

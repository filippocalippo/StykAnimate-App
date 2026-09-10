/** Versioned native-file representation. Live editor channels always contain
 * ordinary immutable key arrays; only the storage boundary uses references. */
export function packPoseSequences(report, visited = new WeakMap()) {
  if (!report || typeof report !== 'object') return report;
  if (visited.has(report)) return visited.get(report);
  const result = {...report, _styk: {...report._styk}}; visited.set(report, result);
  const pack = animation => {
    if (!animation?.channels) return animation;
    const ids = new Map(), sequences = [];
    const channels = animation.channels.map(channel => {
      if (channel.property !== 'pose') return channel;
      let sequence = ids.get(channel.keys);
      if (sequence === undefined) { sequence = sequences.length; ids.set(channel.keys, sequence); sequences.push(channel.keys); }
      return {...channel, keys: {sequence}};
    });
    if (!sequences.length) return animation;
    return {...animation, version: 2, poseSequences: sequences, channels};
  };
  if (report._styk?.animation) result._styk.animation = pack(report._styk.animation);
  const draft = report._styk?.simpleFrameDraft;
  if (draft?.animationBaseline) result._styk.simpleFrameDraft = {...draft, animationBaseline: pack(draft.animationBaseline)};
  if (report._styk?.movieclipSource?.document) result._styk.movieclipSource = {...report._styk.movieclipSource,
    document: packPoseSequences(report._styk.movieclipSource.document, visited)};
  result.figure_types = report.figure_types?.map(figure => figure._styk?.movieclip ? {...figure, _styk: {...figure._styk,
    movieclip: {...figure._styk.movieclip, document: packPoseSequences(figure._styk.movieclip.document, visited)}}} : figure);
  return result;
}

export function* expandPoseSequencesSteps(report) {
  for (const animation of [report?._styk?.animation, report?._styk?.simpleFrameDraft?.animationBaseline]) {
    if (animation?.version !== 2) continue;
    if (!Array.isArray(animation.channels) || animation.channels.length > 100000 ||
        !Array.isArray(animation.poseSequences) || animation.poseSequences.length > 100000)
      throw new Error('Invalid stored pose sequence table.');
    let count = 0;
    for (const keys of animation.poseSequences) {
      if (!Array.isArray(keys) || (count += keys.length) > 1000000) throw new Error('Invalid stored pose sequence capacity.');
      yield {phase: 'pose sequences', keys: count};
    }
    const channels = [];
    for (const channel of animation.channels) {
      if (channel?.property !== 'pose') { channels.push(channel); continue; }
      const reference = channel.keys, index = reference?.sequence;
      if (!reference || Array.isArray(reference) || Object.keys(reference).length !== 1 ||
          !Number.isInteger(index) || index < 0 || index >= animation.poseSequences.length)
        throw new Error('Invalid stored pose sequence reference.');
      channels.push({...channel, keys: animation.poseSequences[index]});
      if ((channels.length & 255) === 0) yield {phase: 'pose sequences', channels: channels.length};
    }
    animation.channels = channels; animation.version = 1; delete animation.poseSequences;
  }
}

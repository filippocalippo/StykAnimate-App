/** Shared authored times, projected without baking poses into native frames. */
export function authoredKeyTimes(channels) {
  const seen = new Set(), ticks = new Set();
  for (const channel of channels) {
    if (seen.has(channel.keys)) continue;
    seen.add(channel.keys);
    for (const key of channel.keys) if (!key.hidden) ticks.add(key.tick);
  }
  return [...ticks].sort((a,b)=>a-b);
}


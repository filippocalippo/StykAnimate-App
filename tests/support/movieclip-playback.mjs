// The playback a movieclip figure stores on a pose: the clock follows the spans the clip is shown on (its presence).
export const presencePlayback = (settings = {}) => ({clock: 'presence', offset: 0, speed: 1, mode: 'loop', ...settings});

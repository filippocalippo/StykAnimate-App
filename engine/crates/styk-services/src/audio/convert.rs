//! Channel mapping for an endpoint that takes its own format (the direct path): stereo goes to the front pair, a mono
//! endpoint gets the mean, other channels stay silent.

const FRONT_LEFT: u32 = 0x1;
const FRONT_RIGHT: u32 = 0x2;

/// Where front left and front right sit among `channels` channels of a layout with `mask` (a `WAVEFORMATEXTENSIBLE` channel
/// mask; 0 means the plain order, left then right). `None` for a mono endpoint.
pub fn front_pair(channels: u16, mask: u32) -> Option<(usize, usize)> {
    if channels < 2 {
        return None;
    }
    if mask == 0 {
        return Some((0, 1));
    }
    let index = |bit: u32| (mask & bit != 0).then(|| (mask & (bit - 1)).count_ones() as usize);
    match (index(FRONT_LEFT), index(FRONT_RIGHT)) {
        (Some(l), Some(r)) if l < channels as usize && r < channels as usize => Some((l, r)),
        // A layout without a front pair (two side or surround speakers): its first two channels.
        _ => Some((0, 1)),
    }
}

/// Writes the stereo frames of `stereo` as `channels` interleaved channels into `out`.
pub fn map_channels(stereo: &[f32], out: &mut [f32], channels: u16, mask: u32) {
    let channels = channels as usize;
    let frames = stereo.len() / 2;
    debug_assert!(out.len() >= frames * channels);
    match front_pair(channels as u16, mask) {
        None => {
            for i in 0..frames {
                out[i] = (stereo[i * 2] + stereo[i * 2 + 1]) * 0.5;
            }
        }
        Some((left, right)) => {
            for i in 0..frames {
                let frame = &mut out[i * channels..(i + 1) * channels];
                frame.fill(0.0);
                frame[left] = stereo[i * 2];
                frame[right] = stereo[i * 2 + 1];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_goes_to_the_front_pair_wherever_the_layout_puts_it() {
        let stereo = [0.1, 0.2, 0.3, 0.4];
        let mut out = [9.0f32; 16];
        map_channels(&stereo, &mut out, 8, 0x63f); // 7.1: FL FR FC LFE BL BR SL SR
        assert_eq!(&out[..8], &[0.1, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(&out[8..], &[0.3, 0.4, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        let mut six = [9.0f32; 12];
        map_channels(&stereo, &mut six, 6, 0);
        assert_eq!(&six[..6], &[0.1, 0.2, 0.0, 0.0, 0.0, 0.0]);
        // A layout with only side speakers has no front pair: its first two channels.
        let mut sides = [9.0f32; 8];
        map_channels(&stereo, &mut sides, 4, 0x600 | 0x30);
        assert_eq!(&sides[..4], &[0.1, 0.2, 0.0, 0.0]);
        // Front right and centre without front left: the right channel is still found by its place in the mask.
        assert_eq!(front_pair(3, 0x7), Some((0, 1)));
        assert_eq!(front_pair(2, 0x3), Some((0, 1)));
        assert_eq!(front_pair(3, 0x6 | 0x8), Some((0, 1)));
    }

    #[test]
    fn a_mono_endpoint_gets_the_mean() {
        let mut out = [0.0f32; 2];
        map_channels(&[0.5, -0.25, 1.0, 1.0], &mut out, 1, 0x4);
        assert_eq!(out, [0.125, 1.0]);
    }
}

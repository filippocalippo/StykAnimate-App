//! The mixer held to today's `src/audio-pcm.mjs` bit for bit. The goldens (`tests/fixtures/audio/`) are what `mixAudio`,
//! `wavePeaks` and `audibleClips` produced, written by `scripts/generate-audio-goldens.mjs` (which ran today's mixer twice on
//! each input and failed unless the runs agreed and every chunk size gave the same samples).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use styk_core::audio::{inspect_wave, mix_audio, wave_peaks, AudioState, Clip, MixPlan, PlanClip, SourceBytes, WavSource};
use styk_doc::Value;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/audio")
}

struct Goldens {
    cases: Value,
    sources: HashMap<Arc<str>, WavSource>,
    json: Value,
}

fn load() -> Goldens {
    let json = styk_doc::json::parse(&std::fs::read(fixtures().join("cases.json")).expect("the goldens are checked in")).expect("cases.json");
    let mut sources = HashMap::new();
    for (name, file) in json.get("sources").and_then(Value::as_obj).expect("sources").iter() {
        let bytes = std::fs::read(fixtures().join(file.as_str().unwrap())).expect("a source file");
        sources.insert(Arc::from(&**name), inspect_wave(Arc::new(SourceBytes::new(bytes))).expect("a source WAV"));
    }
    Goldens { cases: json.get("cases").cloned().unwrap(), sources, json }
}

fn clip(value: &Value) -> Clip {
    let n = |key: &str| value.get(key).and_then(Value::as_f64).unwrap_or_else(|| panic!("clip.{key}"));
    Clip { asset_id: Arc::from(value.get("assetId").and_then(Value::as_str).unwrap()), start: n("start"), offset: n("offset"), duration: n("duration"), gain: n("gain"), fade_in: n("fadeIn"), fade_out: n("fadeOut") }
}

/// The samples of a float32 WAV the way `pcmWave` writes it.
fn read_f32_wave(path: PathBuf) -> Vec<f32> {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[0..4], b"RIFF");
    bytes[44..].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

fn assert_same_bits(name: &str, what: &str, native: &[f32], golden: &[f32]) {
    assert_eq!(native.len(), golden.len(), "{name} ({what}): length");
    if let Some(at) = native.iter().zip(golden).position(|(a, b)| a.to_bits() != b.to_bits()) {
        panic!("{name} ({what}): sample {at} is {:e} ({:#x}), today's mixer made {:e} ({:#x})", native[at], native[at].to_bits(), golden[at], golden[at].to_bits());
    }
}

fn clips_of(case: &Value) -> Vec<Clip> {
    case.get("clips").unwrap().elements().unwrap().iter().map(|c| clip(&c)).collect()
}

#[test]
fn every_golden_case_equals_todays_mixer_bit_for_bit_at_every_chunk_size() {
    let goldens = load();
    let cases = goldens.cases.elements().unwrap();
    assert!(cases.len() >= 10, "the goldens cover the formats and the edge cases");
    for case in cases.iter() {
        let name = case.get("name").and_then(Value::as_str).unwrap().to_string();
        let start = case.get("start").and_then(Value::as_f64).unwrap() as u64;
        let frames = case.get("frames").and_then(Value::as_f64).unwrap() as usize;
        let clips = clips_of(&case);
        let golden = read_f32_wave(fixtures().join(case.get("golden").and_then(Value::as_str).unwrap()));
        assert_eq!(golden.len(), frames * 2);
        for chunk in [1usize, 7, 480, 1200, 4800, 12000] {
            let mut joined = vec![0.0f32; frames * 2];
            let mut at = 0;
            while at < frames {
                let n = chunk.min(frames - at);
                mix_audio(&clips, &goldens.sources, start + at as u64, &mut joined[at * 2..(at + n) * 2]).expect("mix");
                at += n;
            }
            assert_same_bits(&name, &format!("chunks of {chunk}"), &joined, &golden);
        }
        // The plan the transport and the exporter use mixes the same samples (a clip with no source is out of range here).
        let planned: Vec<PlanClip> = clips.iter().filter_map(|c| goldens.sources.get(&c.asset_id).map(|s| PlanClip { clip: c.clone(), source: s.clone() })).collect();
        let plan = MixPlan::new(planned);
        let mut out = vec![0.0f32; frames * 2];
        plan.mix(start, &mut out).unwrap();
        assert_same_bits(&name, "plan", &out, &golden);
    }
}

#[test]
fn the_three_clip_case_depends_on_document_order() {
    let goldens = load();
    let case = goldens.cases.elements().unwrap().iter().find(|c| c.get("name").and_then(Value::as_str) == Some("three-clip-cancellation")).unwrap();
    let clips = clips_of(&case);
    let golden = read_f32_wave(fixtures().join("three-clip-cancellation.f32.wav"));
    // Sample 1440 (30 ms): 1 + 2^-24 - 1 in document order is exactly 0, as today's mixer gives.
    assert_eq!((golden[2880], golden[2881]), (0.0, 0.0));
    let mut sorted = clips.clone();
    sorted.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());
    let mut out = vec![0.0f32; 4800 * 2];
    mix_audio(&sorted, &goldens.sources, 0, &mut out).unwrap();
    assert_eq!(out[2880], 2f32.powi(-24), "sorted by start the same sum rounds differently: the test would catch a sorted mixer");
    let mut in_order = vec![0.0f32; 4800 * 2];
    mix_audio(&clips, &goldens.sources, 0, &mut in_order).unwrap();
    assert_eq!(in_order[2880], 0.0);
}

#[test]
fn peaks_equal_wave_peaks_of_todays_importer() {
    let goldens = load();
    let peaks = goldens.json.get("peaks").and_then(Value::as_obj).unwrap();
    for (name, expected) in peaks.iter() {
        let source = &goldens.sources[&**name];
        let native = wave_peaks(source);
        let want: Vec<f64> = expected.get("peaks").unwrap().elements().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert_eq!(source.frames as f64, expected.get("frames").and_then(Value::as_f64).unwrap(), "{name}: frames");
        assert_eq!(native.len(), want.len(), "{name}: bins");
        for (i, (a, b)) in native.iter().zip(&want).enumerate() {
            assert_eq!(a.to_bits(), b.to_bits(), "{name}: bin {i}");
        }
    }
}

#[test]
fn audible_clips_equal_todays_selection_and_gain_product() {
    let goldens = load();
    for case in goldens.json.get("audible").unwrap().elements().unwrap().iter() {
        let name = case.get("name").and_then(Value::as_str).unwrap();
        let state = AudioState::from_value(case.get("state").unwrap()).expect("a state");
        let native = state.audible_clips();
        let want = clips_of(&Value::object({
            let mut o = styk_doc::Obj::new();
            o.set("clips", case.get("clips").unwrap().clone());
            o
        }));
        assert_eq!(native.len(), want.len(), "{name}");
        for (a, b) in native.iter().zip(&want) {
            assert_eq!((&a.asset_id, a.start.to_bits(), a.offset.to_bits(), a.duration.to_bits(), a.gain.to_bits()), (&b.asset_id, b.start.to_bits(), b.offset.to_bits(), b.duration.to_bits(), b.gain.to_bits()), "{name}");
        }
    }
}

#[test]
fn a_clip_in_range_with_no_source_is_refused_and_one_out_of_range_is_not_looked_up() {
    use styk_core::audio::MixError;
    let clips = vec![Clip { asset_id: Arc::from("gone"), start: 0.0, offset: 0.0, duration: 1.0, gain: 1.0, fade_in: 0.0, fade_out: 0.0 }];
    let mut out = vec![0.0f32; 480];
    assert_eq!(mix_audio(&clips, &HashMap::new(), 0, &mut out), Err(MixError::MissingSource));
    assert_eq!(mix_audio(&clips, &HashMap::new(), 48_000, &mut out), Ok(()));
    assert_eq!(mix_audio(&clips, &HashMap::new(), 0, &mut vec![0.0f32; 48_001 * 2]), Err(MixError::Range));
    assert_eq!(mix_audio(&clips, &HashMap::new(), 0, &mut []), Err(MixError::Range));
}

#[test]
fn wav_headers_are_read_as_today() {
    use styk_core::audio::wav::WavError;
    let goldens = load();
    let good = std::fs::read(fixtures().join("mono16-44k.wav")).unwrap();
    let inspect = |bytes: Vec<u8>| inspect_wave(Arc::new(SourceBytes::new(bytes)));
    assert_eq!(inspect(good[..good.len() - 1].to_vec()).err(), Some(WavError::Truncated));
    assert_eq!(inspect(good[..40].to_vec()).err(), Some(WavError::Unsupported));
    let mut not_wave = good.clone();
    not_wave[8] = b'X';
    assert_eq!(inspect(not_wave).err(), Some(WavError::Unsupported));
    let mut three_channels = good.clone();
    three_channels[22] = 3;
    assert_eq!(inspect(three_channels).err(), Some(WavError::Unsupported));
    let mut slow = good.clone();
    slow[24..28].copy_from_slice(&7999u32.to_le_bytes());
    assert_eq!(inspect(slow).err(), Some(WavError::Unsupported));
    let mut odd_data = good.clone();
    let data_size = u32::from_le_bytes(odd_data[40..44].try_into().unwrap()) - 1;
    odd_data[40..44].copy_from_slice(&data_size.to_le_bytes());
    assert_eq!(inspect(odd_data).err(), Some(WavError::Unsupported), "a data chunk that is not a whole number of frames");
    let ext = &goldens.sources["stereo24-96k-ext"];
    assert_eq!((ext.format.code, ext.format.bits, ext.format.sample_rate, ext.format.channels), (1, 24, 96_000, 2), "the extensible sub-format is read");
}

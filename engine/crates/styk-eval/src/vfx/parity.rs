//! Effect parity with the editor: `frames[].vfx` of a reference dump
//! (`engine/tools/reference.mjs --vfx`) against [`super::evaluate`]. Used by
//! [`crate::parity::compare`], so `styk compare` and the fixture tests share it.

use std::sync::Arc;

use styk_doc::Value;

use super::paint::kind_name;
use super::{padding, sampling_padding, working_slots, Effect, FrameVfx, ObjectVfx, ParamKind, ParamValue};
use crate::eval::{Frame, Prepared};

/// Largest accepted relative difference of a continuous parameter, an
/// opacity or an offset. Colours, options, switches, seeds, paddings and
/// working slots must be equal.
pub const TOLERANCE: f64 = 1e-9;

/// What the effect comparison counted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    /// Ticks whose reference has effects (`frames[].vfx`).
    pub frames: usize,
    /// Effects in the reference: every stack's and every generated effect.
    pub effects: usize,
    pub mismatched_effects: usize,
    /// Stacks in the reference (each with its padding and working slots).
    pub stacks: usize,
    /// Other differences: paddings, working slots, connected groups and their
    /// order, objects with effects on one side only, active clips, warnings.
    pub other: usize,
}

const LINES: usize = 6;

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() <= TOLERANCE * (1.0 + b.abs())
}

fn items(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_arr).unwrap_or(&[])
}

fn numbers(v: Option<&Value>) -> Vec<f64> {
    v.and_then(Value::numbers).unwrap_or_default()
}

/// Why `ours` differs from a dumped effect (`{id, type, params}`), if it does.
pub fn effect_diff(ours: &Effect, expected: &Value) -> Option<String> {
    let kind = ours.kind();
    if expected.get("id").and_then(Value::as_str) != Some(&*ours.id) || expected.get("type").and_then(Value::as_str) != Some(kind.name()) {
        return Some(format!("{} {} vs {} {}", expected.get("type").unwrap_or(&Value::Null), expected.get("id").unwrap_or(&Value::Null), kind.name(), &*ours.id));
    }
    let Some(params) = expected.get("params").and_then(Value::as_obj) else { return Some("no parameters".into()) };
    if params.len() != kind.specs().len() {
        return Some(format!("{} parameters vs {}", params.len(), kind.specs().len()));
    }
    for (i, spec) in kind.specs().iter().enumerate() {
        let Some(theirs) = params.get(spec.name) else { return Some(format!("{} missing", spec.name)) };
        let same = match (ours.params.get(i), theirs) {
            (ParamValue::Num(a), Value::Num(b)) if spec.kind == ParamKind::Number => near(a, *b),
            (ParamValue::Num(a), Value::Num(b)) => a == *b,
            (ParamValue::Paint(p), Value::Obj(_)) => {
                let stops = items(theirs.get("stops"));
                theirs.get("type").and_then(Value::as_str) == Some(kind_name(p.kind))
                    && theirs.get("angle").and_then(Value::as_f64).is_some_and(|angle| near(p.angle, angle))
                    && stops.len() == p.stops.len()
                    && stops.iter().zip(&p.stops).all(|(s, ours)| {
                        s.get("offset").and_then(Value::as_f64).is_some_and(|o| near(ours.offset, o))
                            && s.get("opacity").and_then(Value::as_f64).is_some_and(|o| near(ours.opacity, o))
                            && numbers(s.get("color")) == ours.rgb.map(f64::from)
                    })
            }
            _ => false,
        };
        if !same {
            return Some(format!("{} {} {}: {} vs {:?}", kind.name(), &*ours.id, spec.name, theirs, ours.params.get(i)));
        }
    }
    None
}

struct Diff<'a> {
    counts: &'a mut Counts,
    problems: &'a mut Vec<String>,
    lines: usize,
    extent: f64,
}

impl Diff<'_> {
    fn note(&mut self, line: String) {
        if self.lines < LINES {
            self.problems.push(line);
        }
        self.lines += 1;
    }

    fn other(&mut self, line: String) {
        self.counts.other += 1;
        self.note(line);
    }

    /// One dumped stack (`{effects, padding, slots}`) against ours.
    fn stack(&mut self, what: &str, ours: &[Arc<Effect>], expected: Option<&Value>) {
        let effects = items(expected.and_then(|e| e.get("effects")));
        self.counts.stacks += 1;
        self.counts.effects += effects.len();
        if effects.len() != ours.len() {
            self.counts.mismatched_effects += effects.len().abs_diff(ours.len());
            let names = |list: Vec<String>| list.join(", ");
            let theirs = effects.iter().map(|e| e.get("type").and_then(Value::as_str).unwrap_or("?").to_string()).collect();
            self.note(format!("{what}: [{}] vs [{}]", names(theirs), names(ours.iter().map(|e| e.kind().name().to_string()).collect())));
        }
        for (theirs, ours) in effects.iter().zip(ours) {
            if let Some(why) = effect_diff(ours, theirs) {
                self.counts.mismatched_effects += 1;
                self.note(format!("{what}: {why}"));
            }
        }
        let Some(expected) = expected else { return };
        let (e, ours) = (self.extent, ours);
        let paddings = [padding(ours, 1.0, e), padding(ours, 2.5, e), sampling_padding(ours, 1.0, e), sampling_padding(ours, 0.75, e)];
        if numbers(expected.get("padding")) != paddings {
            self.other(format!("{what}: padding {} vs {paddings:?}", expected.get("padding").unwrap_or(&Value::Null)));
        }
        let slots: Vec<f64> = working_slots(ours).into_iter().map(f64::from).collect();
        if numbers(expected.get("slots")) != slots {
            self.other(format!("{what}: working slots {} vs {slots:?}", expected.get("slots").unwrap_or(&Value::Null)));
        }
    }
}

/// Compares one tick's dump (`frames[].vfx`) with `frame.vfx`.
pub fn compare(prepared: &Prepared, frame: &Frame, expected: &Value, counts: &mut Counts, problems: &mut Vec<String>) {
    counts.frames += 1;
    let none = FrameVfx::default();
    let ours = frame.vfx.as_deref().unwrap_or(&none);
    let extent = prepared.doc.canvas[0].max(prepared.doc.canvas[1]) as f64;
    let mut d = Diff { counts, problems, lines: 0, extent };
    d.stack("scene", &ours.scene, expected.get("scene"));
    // Slots no group draws: on a hidden layer, or without artwork.
    let hidden: Vec<u32> = numbers(expected.get("layerHidden")).into_iter().map(|s| s as u32).collect();
    let empty: Vec<u32> = numbers(expected.get("empty")).into_iter().map(|s| s as u32).collect();
    let mut listed = Vec::new();
    let nothing = ObjectVfx::default();
    for theirs in items(expected.get("objects")) {
        let slot = theirs.get("slot").and_then(Value::as_f64).unwrap_or(-1.0) as usize;
        listed.push(slot);
        let what = format!("slot {slot} (uid {})", theirs.get("uid").unwrap_or(&Value::Null));
        if frame.objects.get(slot).map(|o| o.uid as f64) != theirs.get("uid").and_then(Value::as_f64) {
            d.other(format!("{what}: another object in the engine"));
        }
        let object = ours.object(slot as u32).unwrap_or(&nothing);
        d.stack(&format!("{what} figure"), &object.figure, theirs.get("figure"));
        match (theirs.get("attached"), &object.attached) {
            (Some(group), Some(attached)) => {
                d.stack(&format!("{what} group"), &attached.stack, Some(group));
                let mut members: Vec<f64> = attached.members.iter().filter(|m| !hidden.contains(m) && !empty.contains(m)).map(|&m| m as f64).collect();
                members.sort_by(f64::total_cmp);
                if numbers(group.get("members")) != members {
                    d.other(format!("{what}: group members {} vs {members:?}", group.get("members").unwrap_or(&Value::Null)));
                }
            }
            (None, None) => {}
            (theirs, _) => d.other(format!("{what}: a connected group {}", if theirs.is_some() { "missing in the engine" } else { "the editor does not draw" })),
        }
        let segments = theirs.get("segments").and_then(Value::as_obj);
        for (handle, stack) in segments.into_iter().flat_map(|s| s.iter()) {
            let ours = object.segments.iter().find(|(h, _)| handle.parse() == Ok(*h)).map_or(&[][..], |(_, s)| &s[..]);
            d.stack(&format!("{what} node {handle}"), ours, Some(stack));
        }
        for (handle, _) in &object.segments {
            if !segments.is_some_and(|s| s.contains(&handle.to_string())) {
                d.other(format!("{what}: node {handle} has effects the editor does not draw"));
            }
        }
    }
    for (slot, object) in ours.objects.iter().enumerate() {
        if object.is_some() && !listed.contains(&slot) {
            d.other(format!("slot {slot}: effects the editor does not draw"));
        }
    }
    let roots: Vec<f64> = ours.roots.iter().filter(|r| !hidden.contains(r)).map(|&r| r as f64).collect();
    if numbers(expected.get("roots")) != roots {
        d.other(format!("connected groups {} vs {roots:?}", expected.get("roots").unwrap_or(&Value::Null)));
    }
    if hidden.is_empty() && expected.get("warnings").and_then(Value::as_f64) != Some(ours.warnings.len() as f64) {
        d.other(format!("{} connected-group warnings vs {}", expected.get("warnings").unwrap_or(&Value::Null), ours.warnings.len()));
    }
    let clips = prepared.doc.vfx_clips.as_deref();
    let generators = items(expected.get("generators"));
    d.counts.effects += generators.len();
    if generators.len() != ours.generators.len() {
        d.counts.mismatched_effects += generators.len().abs_diff(ours.generators.len());
        d.note(format!("{} generated effects vs {}", generators.len(), ours.generators.len()));
    }
    for (theirs, ours) in generators.iter().zip(&ours.generators) {
        let clip = clips.and_then(|c| c.clips.get(ours.clip as usize)).map(|c| &*c.id);
        let why = if theirs.get("clip").and_then(Value::as_str) != clip || theirs.get("index").and_then(Value::as_f64) != Some(ours.index as f64) {
            Some(format!("clip {} #{} vs {clip:?} #{}", theirs.get("clip").unwrap_or(&Value::Null), theirs.get("index").unwrap_or(&Value::Null), ours.index))
        } else if !theirs.get("alpha").and_then(Value::as_f64).is_some_and(|a| near(ours.alpha, a)) || theirs.get("start").and_then(Value::as_f64) != Some(ours.start) {
            Some(format!("opacity {} from {} vs {} from {}", theirs.get("alpha").unwrap_or(&Value::Null), theirs.get("start").unwrap_or(&Value::Null), ours.alpha, ours.start))
        } else {
            effect_diff(&ours.effect, theirs)
        };
        if let Some(why) = why {
            d.counts.mismatched_effects += 1;
            d.note(format!("generated effect: {why}"));
        }
    }
    let active: Vec<&str> = clips.into_iter().flat_map(|c| &c.clips).filter(|c| c.active_at(frame.tick)).map(|c| &*c.id).collect();
    let theirs: Vec<&str> = items(expected.get("activeClips")).iter().filter_map(Value::as_str).collect();
    if theirs != active {
        d.other(format!("active clips {theirs:?} vs {active:?}"));
    }
}

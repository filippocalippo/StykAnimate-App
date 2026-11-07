//! Test-only, lossless comparison of the typed draw-list payload. No pointer,
//! allocation capacity, padding, Debug text or float normalization is encoded.
use std::sync::Arc;
use styk_eval::doc::{Paint, PaintKind, PaintStop};
use styk_eval::drawlist::{
    CameraPose, DrawList, EffectLayer, GlyphInstance, GlyphMask, Group, LayerKind, Pass, Prim,
};
use styk_eval::vfx::{Effect, ParamValue};

#[derive(Default)]
struct Bytes(Vec<u8>);
impl Bytes {
    fn flag(&mut self, value: bool) {
        self.0.push(u8::from(value));
    }
    fn word(&mut self, value: u32) {
        self.0.extend(value.to_le_bytes());
    }
    fn count(&mut self, value: usize) {
        self.0.extend((value as u64).to_le_bytes());
    }
    fn text(&mut self, value: &str) {
        self.count(value.len());
        self.0.extend(value.as_bytes());
    }
    fn floats(&mut self, values: &[f32]) {
        for value in values {
            self.0.extend(value.to_bits().to_le_bytes());
        }
    }
    fn doubles(&mut self, values: &[f64]) {
        for value in values {
            self.0.extend(value.to_bits().to_le_bytes());
        }
    }
    fn paint(&mut self, paint: &Paint) {
        let Paint { kind, angle, stops } = paint;
        self.word(match kind {
            PaintKind::Solid => 0,
            PaintKind::Linear => 1,
            PaintKind::Radial => 2,
            PaintKind::Angular => 3,
            PaintKind::Diamond => 4,
        });
        self.doubles(&[*angle]);
        self.count(stops.len());
        for PaintStop {
            offset,
            rgb,
            opacity,
        } in stops
        {
            self.doubles(&[*offset, *opacity]);
            self.0.extend(rgb);
        }
    }
    fn camera(&mut self, camera: &Option<CameraPose>) {
        self.flag(camera.is_some());
        if let Some(CameraPose {
            x,
            y,
            scale,
            angle,
            is_default,
        }) = camera
        {
            self.doubles(&[*x, *y, *scale, *angle]);
            self.flag(*is_default);
        }
    }
    fn layer(&mut self, layer: &EffectLayer) {
        let EffectLayer { effects, kind } = layer;
        self.flag(effects.is_some());
        if let Some(effects) = effects {
            let stack = effects
                .downcast_ref::<Vec<Arc<Effect>>>()
                .expect("every effect payload must have a typed comparison");
            self.count(stack.len());
            for effect in stack {
                let Effect {
                    id,
                    enabled,
                    params,
                } = effect.as_ref();
                self.text(id);
                self.flag(*enabled);
                self.text(params.kind().name());
                // The registry's get/specs cover every typed parameter field,
                // including integer/choice/toggle fields and gradient paints.
                self.count(params.kind().specs().len());
                for (index, spec) in params.kind().specs().iter().enumerate() {
                    self.text(spec.name);
                    match params.get(index) {
                        ParamValue::Num(value) => {
                            self.word(0);
                            self.doubles(&[value]);
                        }
                        ParamValue::Paint(value) => {
                            self.word(1);
                            self.paint(&value);
                        }
                    }
                }
            }
        }
        match kind {
            LayerKind::Entry {
                bounds,
                domain,
                scale,
                padding,
                single_drawing,
            } => {
                self.word(0);
                self.doubles(bounds);
                self.doubles(domain);
                self.doubles(&[*scale, *padding]);
                self.flag(*single_drawing);
            }
            LayerKind::Nested {
                bounds,
                domain,
                scale,
            } => {
                self.word(1);
                self.doubles(bounds);
                self.doubles(domain);
                self.doubles(&[*scale]);
            }
            LayerKind::Raster { bounds } => {
                self.word(2);
                self.doubles(bounds);
            }
            LayerKind::Camera { canvas, camera } => {
                self.word(3);
                for side in canvas {
                    self.word(*side);
                }
                self.camera(camera);
            }
        }
    }
}

pub fn payload(list: &DrawList) -> Vec<u8> {
    // Exhaustive destructuring makes an added draw-list field a compile error
    // until the parity comparator includes it.
    let DrawList {
        composited_export,
        prims,
        paints,
        points,
        groups,
        passes,
        background_prims,
        layers,
        materials,
        glyphs,
    } = list;
    let mut bytes = Bytes::default();
    bytes.flag(*composited_export);
    bytes.word(*background_prims);
    bytes.word(*materials);
    bytes.count(prims.len());
    for Prim {
        kind,
        group,
        color,
        paint,
        a,
        b,
        c,
    } in prims
    {
        for value in [kind, group, color, paint] {
            bytes.word(*value);
        }
        bytes.floats(a);
        bytes.floats(b);
        bytes.floats(c);
    }
    bytes.count(paints.len());
    for row in paints {
        bytes.floats(row);
    }
    bytes.count(points.len());
    for point in points {
        bytes.floats(point);
    }
    bytes.count(groups.len());
    for Group {
        parent,
        depth,
        opacity,
        bounds,
        layer,
    } in groups
    {
        bytes.word(*parent);
        bytes.word(*depth);
        bytes.word(*layer);
        bytes.floats(&[*opacity]);
        bytes.floats(bounds);
    }
    bytes.count(passes.len());
    for Pass { depth, start, end } in passes {
        bytes.word(*depth);
        bytes.word(*start);
        bytes.word(*end);
    }
    bytes.count(layers.len());
    for layer in layers {
        bytes.layer(layer);
    }
    bytes.count(glyphs.len());
    for GlyphInstance { mask, triangles } in glyphs {
        let GlyphMask {
            bounds,
            origin,
            angle,
            scale,
            offset,
        } = mask;
        bytes.doubles(bounds);
        bytes.doubles(origin);
        bytes.doubles(&[*angle]);
        bytes.doubles(scale);
        bytes.doubles(offset);
        bytes.count(triangles.len());
        for point in triangles.iter() {
            bytes.floats(point);
        }
    }
    bytes.0
}

pub fn assert_lists(actual: &DrawList, expected: &DrawList) {
    let (actual, expected) = (payload(actual), payload(expected));
    assert_eq!(
        actual.len(),
        expected.len(),
        "typed draw-list payload lengths differ"
    );
    let mismatch = actual.iter().zip(&expected).position(|(a, b)| a != b);
    assert!(
        mismatch.is_none(),
        "typed draw-list payload differs at byte {mismatch:?}"
    );
}

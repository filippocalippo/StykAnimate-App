//! Which fragment shader draws each primitive.
//!
//! `prim.wgsl` shades every kind in one function. A software rasterizer (SwiftShader, which Chromium draws WebGL2 with
//! where there is no usable graphics card) runs a fragment through both sides of every branch, so each pixel of a solid
//! rectangle paid for pictures, glyphs, gradients and generated effects: the document's background alone cost 61 ms of a
//! 78 ms frame. So the shader has three entry points over the same functions (`fs_flat`, `fs_vector`, `fs_main`), each
//! holding the code of fewer kinds, and a pass draws each run of primitives with the simplest one that holds all of the
//! run's kinds. The pixels are the same whichever draws them (`tests/shading.rs`).

use styk_draw::*;

/// A fragment entry point of `prim.wgsl`; each holds the kinds of the ones before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Shading {
    /// `fs_flat`: triangles and the view's fill in their own colour.
    Flat,
    /// `fs_vector`: those and the shapes covered by their distance (segments, boxes, arcs, polylines, discs, rings).
    Vector,
    /// `fs_main`: every kind.
    Full,
}

impl Shading {
    /// The entry point's name in `prim.wgsl`.
    pub(crate) fn entry(self) -> &'static str {
        match self {
            Shading::Flat => "fs_flat",
            Shading::Vector => "fs_vector",
            Shading::Full => "fs_main",
        }
    }
}

/// The simplest shader that draws `p` as `fs_main` does. A paint record (a gradient), a face of a depth run and a
/// record that adds light need the general one; so does every kind that samples a texture.
pub(crate) fn shading(p: &Prim) -> Shading {
    if p.paint != NO_PAINT || p.kind & (F_DEPTH | F_ADD) != 0 {
        return Shading::Full;
    }
    match p.kind & 255 {
        K_TRI | K_FILL_VIEW => Shading::Flat,
        K_CAPSULE | K_BOX | K_ARC | K_POLYLINE | K_DISC | K_RING => Shading::Vector,
        _ => Shading::Full,
    }
}

/// Runs a list's primitives are drawn in, beside its background's: a pass draws one call a run, so a list whose kinds
/// alternate keeps the general shader for longer stretches rather than drawing many short ones.
pub(crate) const MAX_RUNS: usize = 64;

/// The runs of `prims` (`start`, `end`, shader), in order and covering them all. The primitives in `background` (the
/// root's leading fills, drawn in a call of their own) are runs of their own; the others are merged, when there are more
/// than [`MAX_RUNS`] runs, by drawing the shortest with the shader their neighbours need.
pub(crate) fn runs(prims: &[Prim], background: std::ops::Range<u32>) -> Vec<(u32, u32, Shading)> {
    let mut out = Vec::new();
    let segment = |start: u32, end: u32, merge: bool, out: &mut Vec<(u32, u32, Shading)>| {
        let mut runs: Vec<(u32, u32, Shading)> = Vec::new();
        for i in start..end {
            let shader = shading(&prims[i as usize]);
            match runs.last_mut() {
                Some(last) if last.2 == shader => last.1 = i + 1,
                _ => runs.push((i, i + 1, shader)),
            }
        }
        if merge {
            let mut shortest = 1u32;
            while runs.len() > MAX_RUNS {
                shortest *= 2;
                // Each run shorter than `shortest` takes the shader its neighbours need, then equal neighbours join.
                let wanted: Vec<Shading> = (0..runs.len())
                    .map(|i| {
                        let (start, end, shader) = runs[i];
                        if end - start >= shortest {
                            return shader;
                        }
                        let before = i.checked_sub(1).map(|j| runs[j].2);
                        let after = runs.get(i + 1).map(|run| run.2);
                        shader.max(before.unwrap_or(shader)).max(after.unwrap_or(shader))
                    })
                    .collect();
                let mut joined: Vec<(u32, u32, Shading)> = Vec::with_capacity(runs.len());
                for (run, shader) in runs.iter().zip(wanted) {
                    match joined.last_mut() {
                        Some(last) if last.2 == shader => last.1 = run.1,
                        _ => joined.push((run.0, run.1, shader)),
                    }
                }
                runs = joined;
            }
        }
        out.extend(runs);
    };
    let n = prims.len() as u32;
    let (bg_start, bg_end) = (background.start.min(n), background.end.min(n).max(background.start.min(n)));
    segment(0, bg_start, true, &mut out);
    segment(bg_start, bg_end, false, &mut out);
    segment(bg_end, n, true, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prim(kind: u32) -> Prim {
        Prim { kind, group: 0, color: 0xff00_00ff, paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] }
    }

    #[test]
    fn each_kind_draws_with_the_simplest_shader_that_holds_it() {
        assert_eq!(shading(&prim(K_FILL_VIEW)), Shading::Flat);
        assert_eq!(shading(&prim(K_TRI)), Shading::Flat);
        assert_eq!(shading(&prim(K_TRI | F_GLYPH_VECTOR)), Shading::Flat, "a lone glyph's outline is a flat triangle");
        for kind in [K_CAPSULE, K_BOX, K_ARC, K_POLYLINE | F_CLOSED, K_DISC, K_RING | F_RING_FILL] {
            assert_eq!(shading(&prim(kind)), Shading::Vector, "kind {kind}");
        }
        for kind in [K_IMAGE, K_IMAGE | F_DRAWING, K_GLYPH, K_COMPOSITE, K_BG_IMAGE, K_PARTICLE, K_BEAM, K_DEPTH_RESET, K_TRI | F_DEPTH, K_PARTICLE | F_ADD] {
            assert_eq!(shading(&prim(kind)), Shading::Full, "kind {kind}");
        }
        let painted = Prim { paint: 0, ..prim(K_FILL_VIEW) };
        assert_eq!(shading(&painted), Shading::Full, "a gradient needs the general shader");
    }

    #[test]
    fn runs_cover_the_list_in_order_and_keep_the_background_apart() {
        let prims = [prim(K_FILL_VIEW), prim(K_CAPSULE), prim(K_DISC), prim(K_TRI), prim(K_IMAGE), prim(K_CAPSULE)];
        assert_eq!(runs(&prims, 0..1), vec![(0, 1, Shading::Flat), (1, 3, Shading::Vector), (3, 4, Shading::Flat), (4, 5, Shading::Full), (5, 6, Shading::Vector)]);
        // A background whose kind is the scene's is still its own run.
        let prims = [prim(K_CAPSULE), prim(K_CAPSULE)];
        assert_eq!(runs(&prims, 0..1), vec![(0, 1, Shading::Vector), (1, 2, Shading::Vector)]);
        assert_eq!(runs(&[], 0..0), vec![]);
        assert_eq!(runs(&prims, 0..0), vec![(0, 2, Shading::Vector)]);
    }

    #[test]
    fn alternating_kinds_merge_into_at_most_the_cap() {
        // A picture after every three segments: hundreds of runs become a few, each drawn with a shader that holds its kinds.
        let mut prims = vec![prim(K_FILL_VIEW)];
        for i in 0..2000 {
            prims.push(prim(if i % 4 == 3 { K_IMAGE } else { K_CAPSULE }));
        }
        prims.extend((0..500).map(|_| prim(K_CAPSULE)));
        let runs = runs(&prims, 0..1);
        assert!(runs.len() <= MAX_RUNS + 1, "{} runs", runs.len());
        assert_eq!(runs[0], (0, 1, Shading::Flat), "the background keeps its own shader");
        assert_eq!(runs.last().unwrap().2, Shading::Vector, "a long run of segments keeps the simpler shader");
        let mut at = 0;
        for &(start, end, shader) in &runs {
            assert_eq!(start, at, "runs are contiguous");
            assert!(end > start);
            assert!(prims[start as usize..end as usize].iter().all(|p| shading(p) <= shader), "a run's shader holds every kind in it");
            at = end;
        }
        assert_eq!(at, prims.len() as u32);
    }
}

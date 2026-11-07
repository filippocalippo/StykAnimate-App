//! opentype.js's `Path` commands, in doubles.

/// One path command with its coordinates in the units it was built in (font units, then pixels after `scale_path`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PathCmd {
    M(f64, f64),
    L(f64, f64),
    /// Quadratic: control point, then end point.
    Q(f64, f64, f64, f64),
    /// Cubic: two control points, then end point.
    C(f64, f64, f64, f64, f64, f64),
    Z,
}

/// `Glyph.getPath(0, 0, fontSize)`: `x + (cmd.x * xScale)` and `y + (-cmd.y * yScale)` with `x = y = 0`, so a negative
/// zero becomes a positive one exactly as it does there. `scale` is `1 / unitsPerEm * fontSize`.
pub(crate) fn scale_path(commands: &[PathCmd], units_per_em: f64, font_size: f64) -> Vec<PathCmd> {
    let scale = 1.0 / (if units_per_em != 0.0 { units_per_em } else { 1000.0 }) * font_size;
    let sx = |v: f64| 0.0 + (v * scale);
    let sy = |v: f64| 0.0 + (-v * scale);
    commands
        .iter()
        .map(|c| match *c {
            PathCmd::M(x, y) => PathCmd::M(sx(x), sy(y)),
            PathCmd::L(x, y) => PathCmd::L(sx(x), sy(y)),
            PathCmd::Q(x1, y1, x, y) => PathCmd::Q(sx(x1), sy(y1), sx(x), sy(y)),
            PathCmd::C(x1, y1, x2, y2, x, y) => PathCmd::C(sx(x1), sy(y1), sx(x2), sy(y2), sx(x), sy(y)),
            PathCmd::Z => PathCmd::Z,
        })
        .collect()
}

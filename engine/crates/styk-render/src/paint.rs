//! Portable paint and clip geometry for an explicitly selected Canvas painter.
//! These helpers do not select a renderer policy or change native rasterization.

/// A host's explicit paint contract, independent of its drawing raster grid.
/// Native retains the ordinary GPU/export policy. CanvasDirect applies one
/// artboard clip at each root paint/composite, never inside an isolated child.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum PaintContext {
    #[default]
    Native,
    CanvasDirect { background_bounds: [f64; 4] },
    /// The same owning Canvas foreground, with its independently admitted
    /// single typed-solid root paint presented by the browser destination.
    CanvasForeground { background_bounds: [f64; 4] },
}

/// The axis-aligned Canvas clip after its owning float32 rectangle conversion.
/// Skia's initial binary-rectangle optimization is distinct from its analytic
/// clip path: the latter truncates x at dot8 and snaps y at quarter pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CanvasClip { rect: [f32; 4] }

impl CanvasClip {
    pub fn new(rect: [f64; 4]) -> Self {
        let rect = rect.map(|v| v as f32);
        if !rect.iter().all(|v| v.is_finite()) || rect[2] <= rect[0] || rect[3] <= rect[1] {
            return Self { rect: [0.0; 4] };
        }
        let nearly = |x: f32| { let v = x + 0.125; v - v.floor() < 0.25 };
        let binary = rect.iter().all(|&v| nearly(v));
        Self { rect: std::array::from_fn(|i| {
            let v = rect[i];
            if binary { (v + 0.5).floor() }
            else if i % 2 == 0 { (v * 256.0).trunc() / 256.0 }
            else { ((v * 256.0).trunc() / 64.0 + 0.5).floor() / 4.0 }
        }) }
    }

    /// Already converted clip edges (left, top, right, bottom), for a root pass.
    pub fn rect(self) -> [f32; 4] { self.rect }

    pub fn alpha(self, pixel: [usize; 2]) -> u8 {
        let [l,t,r,b] = self.rect.map(|v| v as f64);
        let [x,y] = pixel.map(|v| v as f64);
        let w = (r.min(x+1.0)-l.max(x)).clamp(0.0,1.0);
        let h = (b.min(y+1.0)-t.max(y)).clamp(0.0,1.0);
        (w*h*255.0+0.5).floor() as u8
    }
}

/// Apply a Canvas byte mask to one premultiplied paint. Quantization belongs to
/// this explicitly selected painter; Native source arithmetic stays unchanged.
pub fn mask_premultiplied(src: [f32; 4], alpha: u8) -> [f32; 4] {
    src.map(|v| (((v.clamp(0.0,1.0)*255.0+0.5).floor() as u32 * (alpha as u32+1)) >> 8) as f32 / 255.0)
}

/// The existing background image owner's one bitmap paint domain. `cover` is
/// its fitted logical size; `source` is the actual decoded size (without gutter).
/// Nine edge slices are aligned to one source-density raster before painting.
/// This selects geometry only, never another image cache or sampling policy.
pub fn background_image_bounds(cover: [f64; 2], source: [f64; 2], bounds: [f64; 4]) -> [f64; 4] {
    if bounds[0] >= 0.0 && bounds[1] >= 0.0 && bounds[0]+bounds[2] <= cover[0] && bounds[1]+bounds[3] <= cover[1] {
        return [0.0,0.0,cover[0],cover[1]];
    }
    let density = (source[0]/cover[0]).min(source[1]/cover[1]).min(16382.0/bounds[2]).min(16382.0/bounds[3]).min((31.0*1024.0*1024.0/(bounds[2]*bounds[3])).sqrt());
    let left = (bounds[0]*density).floor();
    let top = (bounds[1]*density).floor();
    let width = ((bounds[0]+bounds[2])*density).ceil()-left;
    let height = ((bounds[1]+bounds[3])*density).ceil()-top;
    [left/density,top/density,width.max(1.0)/density,height.max(1.0)/density]
}

/// A transformed paint rectangle in output pixels, in perimeter order. Keep all
/// four corners: a camera rotation must not turn its paint into an axis-aligned box.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaintQuad(pub [[f64; 2]; 4]);

impl PaintQuad {
    /// Transform world x, y, width and height using the existing view arithmetic.
    pub fn rectangle(matrix: [f64; 6], rect: [f64; 4]) -> Self {
        let [x, y, w, h] = rect;
        Self([[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(|p| styk_eval::view::apply(matrix, p)))
    }

    /// Area of this paint inside one output pixel. It is independent of the
    /// pixel's clip area: the Canvas clip is applied to each paint operation.
    /// Constant-size scratch storage keeps edge queries allocation free.
    pub fn pixel_area(&self, pixel: [f64; 2]) -> f64 {
        if !pixel.iter().chain(self.0.iter().flatten()).all(|v| v.is_finite()) { return 0.0; }
        let mut points = [[0.0; 2]; 12];
        for (out, p) in points.iter_mut().zip(self.0) { *out = [p[0] - pixel[0], p[1] - pixel[1]]; }
        let mut count = 4;
        for (axis, bound, greater) in [(0, 0.0, true), (0, 1.0, false), (1, 0.0, true), (1, 1.0, false)] {
            let mut next = [[0.0; 2]; 12];
            let mut n = 0;
            for i in 0..count {
                let (a, b) = (points[i], points[(i + 1) % count]);
                let inside = |p: [f64; 2]| if greater { p[axis] >= bound } else { p[axis] <= bound };
                if inside(a) { next[n] = a; n += 1; }
                if inside(a) != inside(b) {
                    let t = (bound - a[axis]) / (b[axis] - a[axis]);
                    next[n] = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]; n += 1;
                }
            }
            if n == 0 { return 0.0; }
            points = next; count = n;
        }
        let mut twice_area = 0.0;
        for i in 0..count { let (a, b) = (points[i], points[(i + 1) % count]); twice_area += a[0] * b[1] - a[1] * b[0]; }
        (twice_area.abs() * 0.5).clamp(0.0, 1.0)
    }

    /// Fill-rectangle coverage after the original matrix's float32
    /// rectStaysRect classification. A nonzero skew must select the path painter
    /// even if transformed corners later round to an axis-aligned rectangle.
    /// Rectangle edges use rounded dot8, unlike the clip's analytic path.
    pub fn canvas_alpha(&self, matrix: [f64; 6], pixel: [usize; 2]) -> Option<u8> {
        let [a,b,c,d,e,f] = matrix.map(|v|v as f32);
        if ![a,b,c,d,e,f].iter().all(|v|v.is_finite()) ||
            !((b == 0.0 && c == 0.0 && a != 0.0 && d != 0.0) ||
              (a == 0.0 && d == 0.0 && b != 0.0 && c != 0.0)) { return None; }
        let q = self.0.map(|p| p.map(|v| v as f32));
        if (q[0][1] == q[1][1] && q[1][0] == q[2][0] && q[2][1] == q[3][1] && q[3][0] == q[0][0]) ||
           (q[0][0] == q[1][0] && q[1][1] == q[2][1] && q[2][0] == q[3][0] && q[3][1] == q[0][1]) {
            let dot = |v: f32| (v as f64*256.0+0.5).floor();
            let (l,t,r,b) = (dot(q[0][0].min(q[2][0])),dot(q[0][1].min(q[2][1])),dot(q[0][0].max(q[2][0])),dot(q[0][1].max(q[2][1])));
            let [x,y] = pixel.map(|v|v as f64*256.0);
            let w = (r.min(x+256.0)-l.max(x)).clamp(0.0,256.0);
            let h = (b.min(y+256.0)-t.max(y)).clamp(0.0,256.0);
            if w == 0.0 || h == 0.0 { return Some(0); }
            let thin_x = (l/256.0).floor() == ((r-1.0)/256.0).floor();
            let thin_y = (t/256.0).floor() == ((b-1.0)/256.0).floor();
            if thin_y { return Some(((h-1.0)*w/256.0).floor() as u8); }
            if w == 256.0 { return Some(if h == 256.0 { 255 } else { (h-u8::from(thin_y) as f64) as u8 }); }
            if h == 256.0 { return Some((w-u8::from(thin_x) as f64) as u8); }
            return Some(((h-u8::from(thin_y) as f64)*w/256.0).floor() as u8);
        }
        // Rotated paths use the renderer's existing full-quad coverage until the
        // pinned analytic path policy is independently certified. Geometric area
        // is not assumed to be Skia's quantized coverage.
        None
    }
}

/// Geometric area of an output-pixel clip rectangle (x, y, width, height).
/// This does not choose the painter's quantization or a GPU sample mask.
pub fn rect_pixel_area(rect: [f64; 4], pixel: [f64; 2]) -> f64 {
    if !rect.iter().chain(pixel.iter()).all(|v| v.is_finite()) || rect[2] <= 0.0 || rect[3] <= 0.0 { return 0.0; }
    let x = (rect[0] + rect[2]).min(pixel[0] + 1.0) - rect[0].max(pixel[0]);
    let y = (rect[1] + rect[3]).min(pixel[1] + 1.0) - rect[1].max(pixel[1]);
    x.max(0.0) * y.max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn coverage_byte(area: f64) -> u8 { (area.clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u8 }
    #[test]
    fn original_matrix_classification_precedes_corner_rounding() {
        // Real Editor square-camera fixture, angle 1e-11, monitor zoom .139.
        // The matrix retains its skew after f32 conversion, although every
        // transformed corner rounds to the same axis-aligned f32 rectangle.
        let matrix = [0.139, -1.39e-12, 1.39e-12, 0.139,
            69.499999999305, 6.949960607016692e-10];
        let bounds = [-2.000000005000004,-2.000000005000004,
            1004.000000005,1004.000000005];
        let paint = PaintQuad::rectangle(matrix,bounds);
        assert_eq!(paint.canvas_alpha(matrix,[69,0]),None,
            "the pinned painter classifies the original f32 matrix before transformed corners");
        let identity = [1.0,0.0,0.0,1.0,0.0,0.0];
        let axis = PaintQuad::rectangle(identity,[0.25,0.0,1.0,1.0]);
        assert_eq!(axis.canvas_alpha([1.0,-0.0,0.0,1.0,-0.0,0.0],[0,0]),Some(191),"signed zero remains zero");
        assert_eq!(axis.canvas_alpha([1.0,1e-50,0.0,1.0,0.0,0.0],[0,0]),Some(191),"the owning matrix scalar conversion precedes classification");
        assert_eq!(axis.canvas_alpha([0.0,0.0,0.0,1.0,0.0,0.0],[0,0]),None,"a degenerate diagonal does not preserve rectangles");
        assert_eq!(axis.canvas_alpha([1.0,0.0,0.0,1.0,f64::INFINITY,0.0],[0,0]),None);
        let quarter = [0.0,1.0,-1.0,0.0,1.25,0.0];
        let turned = PaintQuad::rectangle(quarter,[0.0,0.0,1.0,1.0]);
        assert_eq!(turned.canvas_alpha(quarter,[0,0]),Some(191),"an exactly zero primary diagonal uses the rectangle painter too");
    }
    #[test]
    fn pinned_canvas_clip_converts_edges_before_coverage() {
        let horizontal = CanvasClip::new([19.305555555555554,0.0,328.19444444444446,173.75]);
        assert_eq!(horizontal.rect(),[19.3046875,0.0,328.19140625,173.75]);
        for (p,alpha) in [([19,0],177),([328,0],49),([19,173],133),([328,173],37)] { assert_eq!(horizontal.alpha(p),alpha); }
        let vertical = CanvasClip::new([0.0,32.578125,347.5,141.171875]);
        assert_eq!(vertical.rect(),[0.0,32.5,347.5,141.25]);
        for (p,alpha) in [([0,32],128),([347,32],64),([0,141],64),([347,141],32)] { assert_eq!(vertical.alpha(p),alpha); }
        // All four nearly-integral edges take the original binary clip branch.
        let binary = CanvasClip::new([0.0,26.0625,278.0,112.9375]);
        assert_eq!(binary.rect(),[0.0,26.0,278.0,113.0]);
        assert_eq!(binary.alpha([0,26]),255);
    }
    #[test]
    fn fill_rectangle_rounding_is_separate_from_clip_path_rounding() {
        let paint = PaintQuad::rectangle([1.0,0.0,0.0,1.0,0.0,0.0],[15.444444444444443,0.0,247.11111111111111,139.0]);
        let matrix = [1.0,0.0,0.0,1.0,0.0,0.0];
        assert_eq!(paint.canvas_alpha(matrix,[15,0]),Some(142));
        assert_eq!(paint.canvas_alpha(matrix,[262,0]),Some(142));
        let one_row = PaintQuad::rectangle([1.0,0.0,0.0,1.0,0.0,0.0],[15.444444444444443,0.0,247.11111111111111,1.0]);
        assert_eq!(one_row.canvas_alpha(matrix,[15,0]),Some(141),"the pinned one-row blitter multiplies by height-1 even when the row is a full pixel high");
        let clip = CanvasClip::new([15.444444444444443,0.0,262.55555555555554,139.0]);
        assert_eq!(clip.alpha([15,0]),142);
        assert_eq!(clip.alpha([262,0]),141);
        let rotated = PaintQuad([[0.5,-0.5],[1.5,0.5],[0.5,1.5],[-0.5,0.5]]);
        assert_eq!(rotated.canvas_alpha([1.0,1.0,-1.0,1.0,0.0,0.0],[0,0]),None,"rotated geometric area is not assumed to be quantized Canvas coverage");
    }
    #[test]
    fn background_image_domain_distinguishes_cover_from_edge_raster() {
        assert_eq!(background_image_bounds([1080.0,540.0],[2.0,1.0],[0.0,0.0,960.0,540.0]),[0.0,0.0,1080.0,540.0]);
        assert_eq!(background_image_bounds([1080.0,540.0],[2.0,1.0],[-5.0,-5.0,970.0,550.0]),[-540.0,-540.0,1620.0,1620.0]);
        assert_eq!(background_image_bounds([1080.0,540.0],[1.0,1.0],[0.0,0.0,960.0,540.0]),[0.0,0.0,1080.0,540.0]);
    }
    #[test]
    fn fractional_clip_and_paint_are_separate_operations() {
        let rect = [15.444444444444443, 0.0, 247.11111111111111, 139.0];
        let paint = PaintQuad::rectangle([1.0,0.0,0.0,1.0,0.0,0.0],rect);
        let clip = coverage_byte(rect_pixel_area(rect,[15.0,0.0]));
        let fill = coverage_byte(paint.pixel_area([15.0,0.0]));
        assert_eq!((fill,clip),(142,142));
        assert_eq!((fill as f64 * clip as f64 / 255.0).round() as u8,79);
        assert_eq!(coverage_byte(paint.pixel_area([16.0,0.0])),255);
    }
    #[test]
    fn rotation_preserves_the_actual_paint_quad() {
        let quad = PaintQuad([[0.5,-0.5],[1.5,0.5],[0.5,1.5],[-0.5,0.5]]);
        assert_eq!(quad.pixel_area([0.0,0.0]),1.0);
        assert_eq!(quad.pixel_area([1.0,0.0]),0.25);
        assert_eq!(quad.pixel_area([-1.0,0.0]),0.25);
        let mut reversed = quad; reversed.0.reverse();
        assert_eq!(reversed.pixel_area([1.0,0.0]),quad.pixel_area([1.0,0.0]));
    }
    #[test]
    fn clip_queries_are_local_and_reject_empty_or_nonfinite_bounds() {
        let rect = [1e9+0.25,1e9+0.25,0.5,0.5];
        assert_eq!(PaintQuad::rectangle([1.0,0.0,0.0,1.0,0.0,0.0],rect).pixel_area([1e9,1e9]),0.25);
        assert_eq!(rect_pixel_area(rect,[1e9,1e9]),0.25);
        assert_eq!(rect_pixel_area([0.0,0.0,-1.0,1.0],[0.0,0.0]),0.0);
        assert_eq!(PaintQuad([[f64::NAN;2];4]).pixel_area([0.0,0.0]),0.0);
    }
}

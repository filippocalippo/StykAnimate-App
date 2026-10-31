//! Recorded Canvas monitor texels of a published drawing at fractional density.
//! These samples come from actual Legacy Electron/web PNGs, not the sampler.
use std::path::Path;
use styk_eval::{assets::{self, Assets}, drawlist, geometry};
use styk_raster::{DrawingGrid, Edges, Images, PaintContext, Raster, ViewParams};

#[test]
fn direct_canvas_root_uses_the_recorded_high_quality_cel_sampling() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawing-root-sampling/raw-cel-only.json");
    let prepared = styk_eval::prepare(styk_eval::open(&file).unwrap());
    let assets = Assets::build(&prepared.doc);
    let mut images = Images::default();
    for (cel, _) in assets.cels.values() {
        for image in assets::decode_cel(&assets, cel) { images.add(&assets, &image); }
    }
    let frame = prepared.evaluate(0.0);
    let scene = geometry::build(&prepared.doc, &frame);
    let list = drawlist::encode(&prepared.doc, &assets, &scene);
    assert_eq!(scene.objects.len(), 1);
    assert_eq!(list.groups.len(), 1, "the recorded CEL is painted directly at the root");
    let zoom = 139.0 / 540.0;
    let pan = [(278.0 - 960.0 * zoom) / 2.0, 0.0];
    let view = ViewParams { matrix: styk_eval::view::camera_matrix(&prepared.doc, frame.camera.as_ref(), zoom, pan),
        artboard: [pan[0],0.0,pan[0]+960.0*zoom,139.0], clip_to_artboard: true, clear:[0.0;4], zoom, pan,
        stretch:1.0, camera_view:true, camera_limit:styk_render::CAMERA_PREVIEW_LIMIT };
    let mut raster = Raster::new(Edges::Smooth);
    raster.set_drawing_grid(DrawingGrid::Destination);
    let native = raster.render(&list, &images, &view, [278,139]).straight();
    raster.set_paint_context(PaintContext::CanvasDirect { background_bounds:[0.0,0.0,960.0,540.0] });
    let canvas = raster.render(&list, &images, &view, [278,139]).straight();
    for ([x,y], expected) in [
        ([182,135],[110u8,111,118,255]), ([172,130],[101,102,109,255]),
        ([190,100],[90,91,98,255]), ([156,109],[133,135,140,255]),
        ([139,83],[104,106,112,255]), ([196,126],[116,117,124,255]),
    ] {
        let at = (y*278+x)*4;
        for k in 0..4 {
            assert!(canvas[at+k].abs_diff(expected[k]) <= 2, "recorded Canvas at{x},{y}, channel{k}: {} versus {}", canvas[at+k],expected[k]);
        }
    }
    raster.set_paint_context(PaintContext::Native);
    assert_eq!(raster.render(&list,&images,&view,[278,139]).straight(), native, "Native reset keeps the original root sampling policy");
    assert_ne!(canvas,native,"the explicit Canvas root has its own image sampling contract");
}

#[test]
fn the_foreground_target_omits_only_the_admitted_root_background() {
    let file=Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawing-root-sampling/raw-cel-only.json");
    let prepared=styk_eval::prepare(styk_eval::open(&file).unwrap());let assets=Assets::build(&prepared.doc);let mut images=Images::default();
    for(cel,_)in assets.cels.values(){for image in assets::decode_cel(&assets,cel){images.add(&assets,&image);}}
    let frame=prepared.evaluate(0.0);let scene=geometry::build(&prepared.doc,&frame);let list=drawlist::encode(&prepared.doc,&assets,&scene);
    assert_eq!(list.background_prims,1);assert!(drawlist::plain_solid_background(&prepared.doc,&scene));
    let zoom=139.0/540.0;let pan=[(278.0-960.0*zoom)/2.0,0.0];
    let view=ViewParams{matrix:styk_eval::view::camera_matrix(&prepared.doc,frame.camera.as_ref(),zoom,pan),artboard:[pan[0],0.0,pan[0]+960.0*zoom,139.0],clip_to_artboard:true,clear:[0.0;4],zoom,pan,stretch:1.0,camera_view:true,camera_limit:styk_render::CAMERA_PREVIEW_LIMIT};
    let mut raster=Raster::new(Edges::Smooth);raster.set_drawing_grid(DrawingGrid::Destination);
    raster.set_paint_context(PaintContext::CanvasDirect{background_bounds:[0.0,0.0,960.0,540.0]});let full=raster.render(&list,&images,&view,[278,139]).straight();
    raster.set_paint_context(PaintContext::CanvasForeground{background_bounds:[0.0,0.0,960.0,540.0]});let fg=raster.render(&list,&images,&view,[278,139]).straight();
    assert_eq!(full[(15*4)+3],79);assert_eq!(fg[(15*4)+3],0,"background prefix belongs to the destination paint");
    assert!(fg.as_chunks::<4>().0.iter().any(|p|p[3]>0),"foreground CEL primitives are still painted");
    raster.set_paint_context(PaintContext::CanvasDirect{background_bounds:[0.0,0.0,960.0,540.0]});assert_eq!(raster.render(&list,&images,&view,[278,139]).straight(),full,"the ordinary root route is unchanged");
}

//! Origin posing follows editor recordings at each step, including gesture history.
use std::path::Path;
#[test]
fn origin_pose_matches_every_recorded_step() {
    let folder=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in ["layout", "offsets", "support", "support-pinned", "support-free"] {
        for mode in ["native", "sheet", "autokey-sheet"] {
            if kind.contains('-') && mode == "autokey-sheet" { continue; }
            let name=format!("origin-pose-{kind}-{mode}");
            let reference=styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
            let outcome=styk_edit::replay::replay(&reference).unwrap();
            assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
            assert_eq!((outcome.matched,&outcome.unported),(outcome.steps,&None),"{name}");
        }
    }
}

#[test]
fn origin_figures_the_pivots_cannot_follow_refuse_atomically_and_other_definitions_never_panic() {
    use styk_doc::{Obj, Value};
    let document = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-gestures-layout-native.document.json")).unwrap();
    for kind in ["poseChoices", "spatialMesh", "movieclip", "drawing", "rig", "poseChoiceSegment", "spatialPose", "spatialIK", "joinedRig"] {
        let mut report = styk_doc::json::parse(&document).unwrap();
        match kind {
            "spatialPose" | "spatialIK" => {
                let object = report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0].make_obj().unwrap();
                if kind == "spatialPose" { object.set("_stykSpatial", Value::object(Obj::new())); }
                else {
                    let mut controller = Obj::new(); controller.set("spatialTarget", Value::object(Obj::new()));
                    let mut controllers = Obj::new(); controllers.set("22", Value::object(controller)); object.set("_stykIK", Value::object(controllers));
                }
            }
            _ => {
                let index = if kind == "joinedRig" { 1 } else { 0 };
                let figure = report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[index].make_obj().unwrap();
                if ["rig", "poseChoiceSegment", "joinedRig"].contains(&kind) {
                    figure.get_mut("segments").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set(if kind == "poseChoiceSegment" { "_stykPoseChoice" } else { "_stykRig" }, Value::object(Obj::new()));
                } else { figure.get_mut("_styk").unwrap().make_obj().unwrap().set(kind, Value::object(Obj::new())); }
            }
        }
        let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
        editor.call("select", &[Value::Num(1.0), Value::Num(0.0)]).unwrap();
        editor.call("beginDrag", &[]).unwrap();
        let before = (editor.report_json(), editor.state());
        // A 3D pose, a mesh, a movieclip and a drawing on an origin figure are the editor's; a rig or a pose choice is posed as in any document.
        let refused = ["spatialMesh", "movieclip", "drawing", "spatialPose", "spatialIK"].contains(&kind);
        for method in ["poseJoint", "rotateJoint", "bendJoint", "beginHandleEditDrag", "editHandlePosition", "commitHandleEditDrag", "cancelHandleEditDrag", "beginFigureHandleDrag", "transformFigureHandle", "commitFigureHandleDrag", "cancelFigureHandleDrag"] {
            if refused {
                assert!(matches!(editor.call(method, &[]), Err(styk_edit::EditError::Unported(_))), "{kind} {method}");
                assert_eq!((editor.report_json(), editor.state()), before, "{kind} {method} changed state on refusal");
            } else {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| editor.call(method, &[]))).unwrap_or_else(|_| panic!("{kind} {method} panicked")).ok();
            }
        }
    }
}

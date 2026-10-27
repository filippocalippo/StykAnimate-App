use std::path::Path;
use styk_eval::{parity, records::Records};
fn parse(path:&Path)->styk_doc::Value {styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()}
#[test]
fn retained_crops_match_editor_records_and_fractional_geometry() {
 let folder=Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-source");
 for variant in ["native","sheet"] {
  let name=format!("cropped-{variant}");let record_folder=folder.join(format!("{name}.records"));
  let tree=parse(&record_folder.join("report.json"));let reference=parse(&record_folder.join("records.json"));let prepared=styk_eval::prepare(styk_eval::from_value(&tree,"").unwrap());let records=Records::new(&tree,&prepared).unwrap();
  for entry in reference.get("ticks").unwrap().elements().unwrap().iter(){
   let got=styk_doc::json::to_string(&records.recorded(&entry).unwrap());let want=entry.get("json").unwrap().as_str().unwrap();
   assert_eq!(got,want,"{name} tick {:?}",entry.get("tick"));
  }
  let tree=parse(&folder.join(format!("{name}-host.json")));let reference=parse(&folder.join(format!("{name}-host.reference.json")));let report=parity::compare(&styk_eval::prepare(styk_eval::from_value(&tree,"").unwrap()),&reference);assert!(report.matches(),"{name}: {:?}",report.bad_frames);
  // Ordinary interpolation of the captured boundaries cannot reproduce the crop.
  let mut document=styk_eval::from_value(&tree,"").unwrap();let figure=std::sync::Arc::make_mut(&mut document.figures[0]);let clip=figure.movieclip.as_mut().unwrap();let clip=std::sync::Arc::get_mut(clip).unwrap();let mut local=(*clip.document).clone();local.movieclip_source=None;clip.document=std::sync::Arc::new(local);clip.prepared=std::sync::Arc::new(styk_eval::eval::Prepared::new(clip.document.clone()));
  assert!(!parity::compare(&styk_eval::prepare(document),&reference).matches(),"{name} did not need its source");
 }
}

//! The `_stykIK` table of a pose object → [`Table`].
//!
//! The editor validates a table when a document is loaded (`validateIK`); this
//! reader is lenient instead: a controller that lacks what the solver needs is
//! left out, and optional sections that are malformed read as absent.

use std::collections::BTreeMap;

use styk_doc::Value;

use super::{Angles, BendReference, Controller, Quaternions, SpatialTarget, Table, Target};

fn number(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// `/^[1-9]\d*$/` keys: handle and figure ids.
fn id(key: &str) -> Option<u32> {
    if key.starts_with('0') || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse().ok()
}

fn angles(v: Option<&Value>) -> Option<Angles> {
    let object = v?.as_obj()?;
    Some(object.iter().filter_map(|(key, value)| Some((id(key)?, value.as_f64().filter(|a| a.is_finite())?))).collect())
}

fn vector<const N: usize>(v: &Value) -> Option<[f64; N]> {
    let numbers = v.numbers()?;
    <[f64; N]>::try_from(numbers.as_slice()).ok()
}

fn quaternions(v: Option<&Value>) -> Option<Quaternions> {
    let object = v?.as_obj()?;
    Some(object.iter().filter_map(|(key, value)| Some((id(key)?, vector::<4>(value)?))).collect())
}

fn by_figure<T>(v: Option<&Value>, table: impl Fn(Option<&Value>) -> Option<T>) -> Option<BTreeMap<u32, T>> {
    let object = v?.as_obj()?;
    Some(object.iter().filter_map(|(key, value)| Some((id(key)?, table(Some(value))?))).collect())
}

fn controller(c: &Value) -> Option<Controller> {
    let target = c.get("target")?;
    let chain_length = number(c, "chainLength").filter(|n| n.fract() == 0.0 && *n >= 1.0)?;
    Some(Controller {
        enabled: c.get("enabled")?.as_bool()?,
        pinned: c.get("pinned")?.as_bool()?,
        allow_stretch: c.get("allowStretch").and_then(Value::as_bool).unwrap_or(false),
        chain_length: chain_length.min(u32::MAX as f64) as u32,
        bend_direction: number(c, "bendDirection")?,
        target: Target { x: number(target, "x")?, y: number(target, "y")?, rotation: number(target, "rotation")? },
        followers: angles(c.get("followers")).unwrap_or_default(),
        attachment_offsets: angles(c.get("attachmentOffsets")),
        joined_followers: by_figure(c.get("joinedFollowers"), angles),
        joined_attachment_offsets: by_figure(c.get("joinedAttachmentOffsets"), angles),
        spatial_followers: quaternions(c.get("spatialFollowers")),
        joined_spatial_followers: by_figure(c.get("joinedSpatialFollowers"), quaternions),
        spatial_target: c.get("spatialTarget").and_then(|t| {
            Some(SpatialTarget {
                depth: number(t, "depth")?,
                pole: vector::<3>(t.get("pole")?)?,
                swivel: number(t, "swivel")?,
                normals: t.get("normals").and_then(|n| {
                    let items = n.as_arr()?;
                    Some([vector::<3>(items.first()?)?, vector::<3>(items.get(1)?)?])
                }),
            })
        }),
        bend_reference: c.get("bendReference").and_then(|r| {
            Some(BendReference {
                side: number(r, "side")?,
                angle: number(r, "angle")?,
                axis: number(r, "axis")?,
                ratio: number(r, "ratio")?,
                shape: r.get("shape").and_then(Value::numbers),
            })
        }),
    })
}

/// Reads `object._stykIK`. `None` when the object has no table.
pub fn table(v: Option<&Value>) -> Option<Table> {
    let object = v?.as_obj()?;
    Some(Table { controllers: object.iter().filter_map(|(key, value)| Some((id(key)?, controller(value)?))).collect() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_controller_and_orders_handles_like_javascript() {
        let text = br#"{"22":{"enabled":true,"pinned":true,"chainLength":2,"bendDirection":0,"allowStretch":true,
            "target":{"x":1.5,"y":-2,"rotation":0.25},"followers":{"33":0.5,"7":1},
            "joinedFollowers":{"4":{"9":2}},"bendReference":{"side":-1,"angle":0.1,"axis":0.2,"ratio":0.9,"shape":[0.1,0.2,0.3]},
            "spatialFollowers":{"5":[0,0,0,1]},"spatialTarget":{"depth":3,"pole":[0,0,1],"swivel":0.5,"normals":[[1,0,0],[0,1,0]]}},
            "3":{"enabled":true,"pinned":false,"chainLength":1,"bendDirection":1,"target":{"x":0,"y":0,"rotation":0},"followers":{}},
            "x":{"enabled":true},"05":{"enabled":true}}"#;
        let value = styk_doc::json::parse(text).unwrap();
        let table = table(Some(&value)).unwrap();
        assert_eq!(table.controllers.keys().copied().collect::<Vec<_>>(), vec![3, 22]);
        assert!(table.has_pinned());
        let c = table.get(22).unwrap();
        assert!(c.allow_stretch && c.active());
        assert_eq!(c.chain_length, 2);
        assert_eq!(c.target, Target { x: 1.5, y: -2.0, rotation: 0.25 });
        assert_eq!(c.followers.keys().copied().collect::<Vec<_>>(), vec![7, 33]);
        assert_eq!(c.joined_followers.as_ref().unwrap()[&4][&9], 2.0);
        assert_eq!(c.bend_reference.as_ref().unwrap().shape.as_deref(), Some(&[0.1, 0.2, 0.3][..]));
        assert_eq!(c.spatial_followers.as_ref().unwrap()[&5], [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(c.spatial_target.as_ref().unwrap().normals, Some([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]));
        assert!(!table.get(3).unwrap().active());
    }
}

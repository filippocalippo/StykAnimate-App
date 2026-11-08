//! Versioned layout data. No I/O: a storage worker must hold its interprocess lock across read/merge/replace.
use super::*;
use std::collections::BTreeMap;
use styk_doc::{Obj, Value};
pub const VERSION: u32 = 3;
pub const MAX_BYTES: usize = 256 * 1024;
pub const SAVE_DELAY_MS: u64 = 200;
const MAX_RETRY_MS: u64 = 10_000;
pub(super) const FILE_NAME: &str = "layouts.json";
fn obj(items: Vec<(&str, Value)>) -> Value {
    Value::object(
        items
            .into_iter()
            .map(|(k, v)| (std::sync::Arc::from(k), v))
            .collect::<Obj>(),
    )
}
fn arr(v: Vec<Value>) -> Value {
    Value::array(v)
}
fn num(n: impl Into<f64>) -> Value {
    Value::from(n.into())
}
fn string(s: &str) -> Value {
    Value::from(s)
}
fn get<'a>(v: &'a Value, k: &str) -> Result<&'a Value, LayoutError> {
    v.get(k).ok_or(LayoutError::InvalidFile)
}
fn number(v: &Value) -> Result<f64, LayoutError> {
    v.as_f64()
        .filter(|x| x.is_finite())
        .ok_or(LayoutError::InvalidFile)
}
fn uint(v: &Value) -> Result<u32, LayoutError> {
    let n = number(v)?;
    if n < 0. || n > u32::MAX as f64 || n.fract() != 0. {
        Err(LayoutError::InvalidFile)
    } else {
        Ok(n as u32)
    }
}
fn text(v: &Value) -> Result<&str, LayoutError> {
    v.as_str().ok_or(LayoutError::InvalidFile)
}
fn list(v: &Value) -> Result<&[Value], LayoutError> {
    v.as_arr().ok_or(LayoutError::InvalidFile)
}
fn side(s: Side) -> Value {
    string(match s {
        Side::Left => "left",
        Side::Right => "right",
        Side::Top => "top",
        Side::Bottom => "bottom",
    })
}
fn read_side(v: &Value) -> Result<Side, LayoutError> {
    match text(v)? {
        "left" => Ok(Side::Left),
        "right" => Ok(Side::Right),
        "top" => Ok(Side::Top),
        "bottom" => Ok(Side::Bottom),
        _ => Err(LayoutError::InvalidFile),
    }
}
fn panel(p: &PanelId) -> Value {
    obj(vec![("kind", string(&p.kind)), ("n", num(p.n))])
}
fn read_panel(v: &Value) -> Result<PanelId, LayoutError> {
    Ok(PanelId {
        kind: text(get(v, "kind")?)?.into(),
        n: u8::try_from(uint(get(v, "n")?)?).map_err(|_| LayoutError::InvalidFile)?,
    })
}
fn rect(r: Rect) -> Value {
    obj(vec![
        ("x", num(r.x)),
        ("y", num(r.y)),
        ("w", num(r.w)),
        ("h", num(r.h)),
    ])
}
fn read_rect(v: &Value) -> Result<Rect, LayoutError> {
    Ok(Rect {
        x: number(get(v, "x")?)?,
        y: number(get(v, "y")?)?,
        w: number(get(v, "w")?)?,
        h: number(get(v, "h")?)?,
    })
}
fn size(s: Sz) -> Value {
    match s {
        Sz::Px(v) => obj(vec![("px", num(v))]),
        Sz::Flex(v) => obj(vec![("flex", num(v))]),
    }
}
fn read_size(v: &Value) -> Result<Sz, LayoutError> {
    if let Some(n) = v.get("px") {
        Ok(Sz::Px(number(n)?))
    } else {
        Ok(Sz::Flex(number(get(v, "flex")?)?))
    }
}
fn node(n: &Node) -> Value {
    match n {
        Node::Tabs(g) => obj(vec![
            ("id", num(g.id)),
            ("tabs", arr(g.tabs.iter().map(panel).collect())),
            ("active", num(g.active as f64)),
            ("collapsed", Value::from(g.collapsed)),
            ("flyout", num(g.flyout_px)),
        ]),
        Node::Split { id, axis, kids } => obj(vec![
            ("id", num(*id)),
            (
                "axis",
                string(if *axis == Axis::Horizontal { "h" } else { "v" }),
            ),
            (
                "kids",
                arr(kids
                    .iter()
                    .map(|k| obj(vec![("size", size(k.size)), ("node", node(&k.node))]))
                    .collect()),
            ),
        ]),
    }
}
fn read_node(v: &Value, depth: usize) -> Result<Node, LayoutError> {
    if depth > MAX_DEPTH {
        return Err(LayoutError::Limit);
    }
    let id = uint(get(v, "id")?)?;
    if let Some(t) = v.get("tabs") {
        Ok(Node::Tabs(TabGroup {
            id,
            tabs: list(t)?.iter().map(read_panel).collect::<Result<_, _>>()?,
            active: uint(get(v, "active")?)? as usize,
            collapsed: get(v, "collapsed")?
                .as_bool()
                .ok_or(LayoutError::InvalidFile)?,
            flyout_px: number(get(v, "flyout")?)?,
        }))
    } else {
        let a = match text(get(v, "axis")?)? {
            "h" => Axis::Horizontal,
            "v" => Axis::Vertical,
            _ => return Err(LayoutError::InvalidFile),
        };
        Ok(Node::Split {
            id,
            axis: a,
            kids: list(get(v, "kids")?)?
                .iter()
                .map(|k| {
                    Ok(Kid {
                        size: read_size(get(k, "size")?)?,
                        node: read_node(get(k, "node")?, depth + 1)?,
                    })
                })
                .collect::<Result<_, LayoutError>>()?,
        })
    }
}
fn hint(h: &ReturnPlacement) -> Value {
    obj(vec![
        ("group", num(h.group)),
        ("index", num(h.index as f64)),
        ("sibling", h.sibling.map_or(Value::Null, num)),
        ("side", side(h.side)),
        ("size", size(h.size)),
    ])
}
fn read_hint(v: &Value) -> Result<ReturnPlacement, LayoutError> {
    Ok(ReturnPlacement {
        group: uint(get(v, "group")?)?,
        index: uint(get(v, "index")?)? as usize,
        sibling: v
            .get("sibling")
            .filter(|v| !matches!(v, Value::Null))
            .map(uint)
            .transpose()?,
        side: read_side(get(v, "side")?)?,
        size: read_size(get(v, "size")?)?,
    })
}
pub fn to_value(l: &Layout) -> Value {
    let mut v = obj(vec![
        ("main", l.main.as_ref().map_or(Value::Null, node)),
        (
            "floats",
            arr(l
                .floats
                .iter()
                .map(|f| {
                    obj(vec![
                        ("id", num(f.id)),
                        ("root", node(&f.root)),
                        ("monitor", string(&f.frames.monitor.to_string())),
                        ("relative", rect(f.frames.relative)),
                        (
                            "setups",
                            arr(f
                                .frames
                                .by_setup
                                .iter()
                                .map(|(k, r)| {
                                    obj(vec![("key", string(&k.to_string())), ("rect", rect(*r))])
                                })
                                .collect()),
                        ),
                    ])
                })
                .collect()),
        ),
        (
            "presentedPanels",
            arr(l
                .stage_tools
                .map(|_| PanelId::new("tools"))
                .into_iter()
                .chain(l.joined_layers.then(|| PanelId::new("layers")))
                .map(|p| panel(&p))
                .collect()),
        ),
        ("closed", arr(l.closed.iter().map(panel).collect())),
        ("dormant", arr(l.dormant.iter().map(panel).collect())),
        ("tools", l.stage_tools.map_or(Value::Null, side)),
        ("joinedLayers", Value::from(l.joined_layers)),
        ("layersWidth", num(l.layers_width)),
        (
            "returns",
            arr(l
                .returns
                .iter()
                .map(|(p, h)| obj(vec![("panel", panel(p)), ("hint", hint(h))]))
                .collect()),
        ),
    ]);
    if let Value::Obj(o) = &mut v {
        let o = std::sync::Arc::make_mut(o);
        for (k, v) in &l.unknown {
            if o.get(k).is_none() {
                o.set(k, v.clone());
            }
        }
    }
    l.unknown_records.restore(&mut v);
    v
}
pub fn from_value(v: &Value, w: Workspace) -> Result<Layout, LayoutError> {
    let main = match get(v, "main")? {
        Value::Null => None,
        n => Some(read_node(n, 0)?),
    };
    let floats = list(get(v, "floats")?)?
        .iter()
        .map(|f| {
            Ok(Float {
                id: uint(get(f, "id")?)?,
                root: read_node(get(f, "root")?, 0)?,
                frames: Frames {
                    monitor: text(get(f, "monitor")?)?
                        .parse()
                        .map_err(|_| LayoutError::InvalidFile)?,
                    relative: read_rect(get(f, "relative")?)?,
                    by_setup: list(get(f, "setups")?)?
                        .iter()
                        .map(|s| {
                            Ok((
                                text(get(s, "key")?)?
                                    .parse()
                                    .map_err(|_| LayoutError::InvalidFile)?,
                                read_rect(get(s, "rect")?)?,
                            ))
                        })
                        .collect::<Result<_, LayoutError>>()?,
                },
            })
        })
        .collect::<Result<_, LayoutError>>()?;
    let known = [
        "presentedPanels",
        "main",
        "floats",
        "closed",
        "dormant",
        "tools",
        "joinedLayers",
        "layersWidth",
        "returns",
    ];
    let mut l = Layout {
        main,
        floats,
        unknown_records: UnknownRecords::default(),
        closed: list(get(v, "closed")?)?
            .iter()
            .map(read_panel)
            .collect::<Result<_, _>>()?,
        dormant: list(get(v, "dormant")?)?
            .iter()
            .map(read_panel)
            .collect::<Result<_, _>>()?,
        stage_tools: match get(v, "tools")? {
            Value::Null => None,
            s => Some(read_side(s)?),
        },
        joined_layers: get(v, "joinedLayers")?
            .as_bool()
            .ok_or(LayoutError::InvalidFile)?,
        layers_width: number(get(v, "layersWidth")?)?,
        returns: list(get(v, "returns")?)?
            .iter()
            .map(|r| Ok((read_panel(get(r, "panel")?)?, read_hint(get(r, "hint")?)?)))
            .collect::<Result<_, LayoutError>>()?,
        unknown: v
            .as_obj()
            .ok_or(LayoutError::InvalidFile)?
            .iter()
            .filter(|(k, _)| !known.contains(&k.as_ref()))
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
    };
    l.validate(w)?;
    l.unknown_records = UnknownRecords::read(v);
    Ok(l)
}
pub fn encode(l: &Layout) -> Result<Vec<u8>, LayoutError> {
    let v = obj(vec![("version", num(VERSION)), ("layout", to_value(l))]);
    let mut b = Vec::new();
    styk_doc::json::write(&v, &mut b);
    if b.len() > MAX_BYTES {
        Err(LayoutError::Limit)
    } else {
        Ok(b)
    }
}
pub fn decode(bytes: &[u8], w: Workspace) -> Result<Layout, LayoutError> {
    if bytes.len() > MAX_BYTES {
        return Err(LayoutError::Limit);
    }
    let v = styk_doc::json::parse(bytes).map_err(|_| LayoutError::InvalidFile)?;
    let version = uint(get(&v, "version")?)?;
    if version > VERSION {
        return Err(LayoutError::FutureVersion);
    }
    if version != VERSION {
        return Err(LayoutError::InvalidFile);
    }
    from_value(get(&v, "layout")?, w)
}
/// Corrupt known fields fall back without writing the source; all opaque root fields survive.
pub fn repair(v: &Value, w: Workspace) -> (Layout, Vec<String>) {
    match from_value(v, w) {
        Ok(l) => (l, vec![]),
        Err(e) => {
            let mut l = essentials(w);
            l.unknown.insert("unrepaired".into(), v.clone());
            (l, vec![format!("Layout reset: {e:?}")])
        }
    }
}
#[derive(Clone, Debug)]
pub struct MigrationGeometry {
    pub window: Size,
    pub stage: Rect,
    pub client_x: f64,
    pub client_y: f64,
    pub scale: f64,
    pub setup: u64,
}
#[derive(Clone, Debug)]
pub struct ImportResult {
    pub user: Vec<(String, String, Layout)>,
    pub layouts: BTreeMap<String, Layout>,
    pub warnings: Vec<String>,
}
/// Legacy import requires explicit logical-stage and physical-client geometry (no mixed-DPI guessing).
pub fn import_v2(v: &Value, geometry: &MigrationGeometry) -> ImportResult {
    let mut result = ImportResult {
        user: vec![],
        layouts: BTreeMap::new(),
        warnings: vec![],
    };
    for (mode, w) in [
        ("animate", Workspace::Animate),
        ("draw", Workspace::Draw),
        ("rig", Workspace::Rig),
    ] {
        let mut l = essentials(w);
        let mut selected: Vec<PanelId> = vec![];
        let old = v.get("modes").and_then(|m| m.get(mode));
        let preset = old
            .and_then(|m| m.get("preset"))
            .and_then(Value::as_str)
            .unwrap_or(if w == Workspace::Rig {
                "build"
            } else {
                "animate"
            });
        if w == Workspace::Rig {
            let p = PanelId::new("structure");
            if let Err(e) = l.apply(Operation::Reopen(p.clone()), w) {
                result.warnings.push(format!("Structure: {e:?}"))
            }
            let gid = l
                .groups()
                .iter()
                .find(|g| g.tabs.contains(&p))
                .map(|g| g.id);
            if let Some(id) = gid
                && let Err(e) = l.apply(Operation::Collapse(id, true), w)
            {
                result.warnings.push(format!("Structure: {e:?}"))
            }
        }
        if preset == "build"
            && let Err(e) = l.apply(Operation::Close(PanelId::new("timeline")), w)
        {
            result.warnings.push(format!("Timeline: {e:?}"))
        }
        if preset == "review" {
            for p in ["properties", "vfx", "library"] {
                if let Err(e) = l.apply(Operation::Close(PanelId::new(p)), w) {
                    result.warnings.push(format!("{p}: {e:?}"))
                }
            }
            if let Some(g) = l.group_mut(3) {
                g.collapsed = true;
            }
        }
        let mut imported_sides = BTreeMap::new();
        if let Some(records) = old
            .and_then(|m| m.get("arrangement").or(Some(m)))
            .and_then(|a| a.get("panels"))
            .and_then(Value::as_arr)
        {
            let mut groups: BTreeMap<String, u32> = BTreeMap::new();
            let mut columns: BTreeMap<String, u32> = BTreeMap::new();
            let mut records: Vec<_> = records.iter().collect();
            records.sort_by(|a, b| {
                a.get("order")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.)
                    .total_cmp(&b.get("order").and_then(Value::as_f64).unwrap_or(0.))
            });
            for record in records {
                let Some(kind) = record.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if spec(kind).is_none() {
                    l.unknown
                        .insert(format!("legacy-panel:{kind}"), record.clone());
                    continue;
                }
                let p = PanelId::new(kind);
                let dock = record
                    .get("dock")
                    .and_then(Value::as_str)
                    .unwrap_or("right");
                let side = match if dock == "strip" {
                    record
                        .get("side")
                        .and_then(Value::as_str)
                        .unwrap_or("right")
                } else {
                    dock
                } {
                    "left" => Side::Left,
                    "bottom" => Side::Bottom,
                    _ => Side::Right,
                };
                if !["hidden", "float", "strip", "left", "right", "bottom"].contains(&dock) {
                    l.unknown
                        .insert(format!("legacy-panel:{kind}"), record.clone());
                    result
                        .warnings
                        .push(format!("{kind}: unknown dock kept at home"));
                    continue;
                }
                let operation = if dock == "hidden" {
                    Operation::Close(p.clone())
                } else if dock == "float" {
                    let r = record
                        .get("rect")
                        .and_then(|r| read_rect(r).ok())
                        .unwrap_or(Rect {
                            x: 0.,
                            y: 0.,
                            w: 320.,
                            h: 400.,
                        });
                    Operation::Move(
                        p.clone(),
                        Zone::Float {
                            rect: Rect {
                                x: geometry.client_x + (geometry.stage.x + r.x) * geometry.scale,
                                y: geometry.client_y + (geometry.stage.y + r.y) * geometry.scale,
                                w: r.w * geometry.scale,
                                h: r.h * geometry.scale,
                            },
                        },
                    )
                } else {
                    let key = format!("{dock}:{}", legacy_group(record));
                    let zone = if let Some(group) = groups.get(&key) {
                        Zone::Tab {
                            group: *group,
                            index: usize::MAX,
                        }
                    } else if let Some(group) = columns.get(dock) {
                        Zone::Split {
                            group: *group,
                            side: Side::Bottom,
                        }
                    } else {
                        Zone::WindowEdge { side }
                    };
                    Operation::Move(p.clone(), zone)
                };
                match l.apply(operation, w) {
                    Ok(_) => {
                        if let Some(g) = l.groups().iter().find(|g| g.tabs.contains(&p)) {
                            let id = g.id;
                            imported_sides.insert(id, side);
                            let key = format!("{dock}:{}", legacy_group(record));
                            groups.insert(key, id);
                            let first = columns.entry(dock.into()).or_insert(id);
                            let first = *first;
                            if first != id && matches!(dock, "left" | "right") {
                                let weights = old
                                    .and_then(|m| m.get("weights"))
                                    .and_then(|v| v.get(dock))
                                    .and_then(Value::as_nums);
                                let a = weights
                                    .and_then(|v| v.get(0))
                                    .filter(|v| *v > 0.)
                                    .unwrap_or(1.);
                                let b = weights
                                    .and_then(|v| v.get(1))
                                    .filter(|v| *v > 0.)
                                    .unwrap_or(1.);
                                fn weight(n: &mut Node, first: u32, second: u32, a: f64, b: f64) {
                                    if let Node::Split { kids, .. } = n {
                                        if kids.iter().any(|k| k.node.id() == first)
                                            && kids.iter().any(|k| k.node.id() == second)
                                        {
                                            for k in kids {
                                                k.size = Sz::Flex(if k.node.id() == first {
                                                    a
                                                } else {
                                                    b
                                                });
                                            }
                                        } else {
                                            for k in kids {
                                                weight(&mut k.node, first, second, a, b);
                                            }
                                        }
                                    }
                                }
                                if let Some(n) = &mut l.main {
                                    weight(n, first, id, a, b);
                                }
                            }
                            if record.get("active").and_then(Value::as_bool) == Some(true) {
                                selected.push(p.clone());
                                if let Some(g) = l.group_mut(id) {
                                    g.active = g.tabs.iter().position(|x| *x == p).unwrap_or(0);
                                }
                            }
                            if dock == "strip"
                                && let Some(g) = l.group_mut(id)
                            {
                                g.collapsed = true;
                            }
                        }
                    }
                    Err(e) => result.warnings.push(format!("{kind} kept at home: {e:?}")),
                }
            }
        }
        for p in selected {
            let gid = l
                .groups()
                .iter()
                .find(|g| g.tabs.contains(&p))
                .map(|g| g.id);
            if let Some(g) = gid.and_then(|id| l.group_mut(id)) {
                g.active = g.tabs.iter().position(|x| *x == p).unwrap_or(0);
            }
        }
        if preset == "timing" && old.and_then(|m| m.get("panels")).is_none() {
            match super::preset(w, Preset::Animator, geometry.window.h) {
                Ok(layout) => l = layout,
                Err(e) => result.warnings.push(format!("Timing: {e:?}")),
            }
        }
        if old
            .and_then(|m| {
                m.get("bottomSpan")
                    .or_else(|| m.get("arrangement").and_then(|a| a.get("bottomSpan")))
            })
            .and_then(Value::as_str)
            == Some("stage")
            && !l.closed.contains(&PanelId::new("timeline"))
            && let Err(e) = l.apply(
                Operation::Move(
                    PanelId::new("timeline"),
                    Zone::Split {
                        group: 1,
                        side: Side::Bottom,
                    },
                ),
                w,
            )
        {
            result.warnings.push(format!("Timeline span: {e:?}"));
        }
        if let Some(rail) = old.and_then(|m| m.get("rail")).and_then(Value::as_str) {
            l.stage_tools = Some(if rail == "right" {
                Side::Right
            } else {
                Side::Left
            });
        }
        // Shared sizes become independent allocations, never a shared mutable setting.
        fn sizes(n: &mut Node, v: &Value, sides: &BTreeMap<u32, Side>) {
            if let Node::Split { axis, kids, .. } = n {
                for k in kids {
                    let mut gs = vec![];
                    k.node.groups(&mut gs);
                    let key = if *axis == Axis::Vertical {
                        matches!(&k.node,Node::Tabs(g) if g.tabs.iter().any(|p|p.kind=="timeline"))
                            .then_some("bottom")
                    } else if gs.iter().all(|g| sides.get(&g.id) == Some(&Side::Left)) {
                        Some("left")
                    } else if gs
                        .iter()
                        .any(|g| g.tabs.iter().any(|p| p.kind == "structure"))
                    {
                        Some("structure")
                    } else {
                        Some("right")
                    };
                    if matches!(k.size, Sz::Px(_))
                        && let Some(n) = key
                            .and_then(|key| v.get(key))
                            .and_then(Value::as_f64)
                            .filter(|n| n.is_finite() && *n > 0.)
                    {
                        k.size = Sz::Px(n);
                    }
                    sizes(&mut k.node, v, sides);
                }
            }
        }
        if let Some(s) = v.get("shared").and_then(|s| s.get("sizes")) {
            if let Some(n) = &mut l.main {
                sizes(n, s, &imported_sides)
            }
            if let Some(n) = s.get("timelineLabels").and_then(Value::as_f64) {
                l.layers_width = n.max(120.);
            }
        }
        if v.get("modes").is_none() {
            let sizes = obj(vec![
                ("right", v.get("right").cloned().unwrap_or(Value::Null)),
                ("bottom", v.get("timeline").cloned().unwrap_or(Value::Null)),
            ]);
            if let Some(n) = &mut l.main {
                self::sizes_v1(n, &sizes);
            }
        }
        for f in &mut l.floats {
            if let Some((key, _)) = f.frames.by_setup.front_mut() {
                *key = geometry.setup;
            }
        }
        result.layouts.insert(mode.into(), l);
    }
    if let Some(saved) = v.get("saved").and_then(Value::as_arr) {
        for entry in saved.iter().take(32) {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Imported layout");
            let mode = entry
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("animate");
            let arrangement = entry
                .get("arrangement")
                .cloned()
                .unwrap_or_else(|| entry.clone());
            let input = obj(vec![
                ("modes", obj(vec![(mode, arrangement)])),
                ("shared", v.get("shared").cloned().unwrap_or(Value::Null)),
            ]);
            let imported = import_v2(&input, geometry);
            if let Some(l) = imported.layouts.get(mode) {
                result
                    .user
                    .push((name.chars().take(48).collect(), mode.into(), l.clone()));
            }
            result.warnings.extend(imported.warnings);
        }
    }
    result
}
fn legacy_group(v: &Value) -> String {
    v.get("group")
        .map(|g| {
            g.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| g.as_f64().unwrap_or(0.).to_string())
        })
        .unwrap_or_else(|| "0".into())
}
fn sizes_v1(n: &mut Node, v: &Value) {
    if let Node::Split { axis, kids, .. } = n {
        for k in kids {
            if matches!(k.size, Sz::Px(_)) {
                let key = if *axis == Axis::Vertical {
                    "bottom"
                } else {
                    "right"
                };
                if let Some(n) = v
                    .get(key)
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite() && *n > 0.)
                {
                    k.size = Sz::Px(n);
                }
            }
            sizes_v1(&mut k.node, v);
        }
    }
}

/// Coalesces edits while one ordered write is outstanding; callers inject monotonic milliseconds.
#[derive(Clone, Debug, Default)]
pub struct SaveQueue {
    pending: Option<(u64, Vec<u8>)>,
    in_flight: Option<Vec<u8>>,
    retry_ms: u64,
}
impl SaveQueue {
    /// One host wake, also used by Settings so retry timing has a single owner.
    pub fn deadline(&self) -> Option<u64> {
        if self.in_flight.is_some() { None } else { self.pending.as_ref().map(|(at, _)| *at) }
    }
    pub fn flush(&mut self, now: u64) {
        if let Some((at, _)) = &mut self.pending { *at = now; }
    }
    pub fn idle(&self) -> bool { self.pending.is_none() && self.in_flight.is_none() }
    pub fn changed(&mut self, now: u64, bytes: Vec<u8>) -> Result<(), LayoutError> {
        if bytes.len() > MAX_BYTES {
            return Err(LayoutError::Limit);
        }
        self.replace(now, bytes);
        Ok(())
    }
    /// Reuse the same scheduling/backoff when an owner holds its typed payload elsewhere.
    pub(crate) fn mark_changed(&mut self, now: u64) { self.replace(now, Vec::new()); }
    fn replace(&mut self, now: u64, bytes: Vec<u8>) {
        self.pending = Some((now.saturating_add(SAVE_DELAY_MS), bytes));
        self.retry_ms = 0;
    }
    pub fn take_due(&mut self, now: u64) -> Option<Vec<u8>> {
        if self.in_flight.is_some() || self.pending.as_ref().is_none_or(|(due, _)| *due > now) {
            return None;
        }
        let (_, bytes) = self.pending.take()?;
        self.in_flight = Some(bytes.clone());
        Some(bytes)
    }
    pub fn complete(&mut self, success: bool, now: u64) {
        let Some(bytes) = self.in_flight.take() else {
            return;
        };
        if success {
            self.retry_ms = 0;
        } else if self.pending.is_none() {
            let delay = self.retry_ms.max(SAVE_DELAY_MS);
            self.pending = Some((now.saturating_add(delay), bytes));
            self.retry_ms = (delay * 2).min(MAX_RETRY_MS);
        }
    }
}

/// Stamps compare lexicographically: caller-supplied milliseconds and process identity disambiguate ties.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Stamp {
    pub millis: u64,
    pub writer: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub stamp: Stamp,
    pub value: Value,
}
/// Workspace values include current/base/dirty and arrangements by setup; user values carry name/workspaces/layout.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayoutFile {
    pub workspaces: BTreeMap<String, Entry>,
    pub user: BTreeMap<String, Entry>,
    pub tombstones: BTreeMap<String, Stamp>,
    pub unknown: BTreeMap<String, Value>,
}
fn stamp(s: &Stamp) -> Value {
    obj(vec![
        ("millis", string(&s.millis.to_string())),
        ("writer", string(&s.writer)),
    ])
}
fn read_stamp(v: &Value) -> Result<Stamp, LayoutError> {
    Ok(Stamp {
        millis: text(get(v, "millis")?)?
            .parse()
            .map_err(|_| LayoutError::InvalidFile)?,
        writer: text(get(v, "writer")?)?.into(),
    })
}
impl LayoutFile {
    pub fn merge(&self, other: &Self, now: u64) -> Self {
        let mut merged = self.clone();
        for (to, from) in [
            (&mut merged.workspaces, &other.workspaces),
            (&mut merged.user, &other.user),
        ] {
            for (id, e) in from {
                if to.get(id).is_none_or(|old| e.stamp > old.stamp) {
                    to.insert(id.clone(), e.clone());
                }
            }
        }
        for (id, s) in &other.tombstones {
            if merged.tombstones.get(id).is_none_or(|old| s > old) {
                merged.tombstones.insert(id.clone(), s.clone());
            }
        }
        merged
            .user
            .retain(|id, e| merged.tombstones.get(id).is_none_or(|s| *s < e.stamp));
        merged
            .tombstones
            .retain(|_, s| now.saturating_sub(s.millis) <= 30 * 24 * 60 * 60 * 1000);
        while merged.tombstones.len() > 16 {
            let oldest = merged
                .tombstones
                .iter()
                .min_by_key(|(_, s)| *s)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                merged.tombstones.remove(&id);
            }
        }
        for (k, v) in &other.unknown {
            merged.unknown.entry(k.clone()).or_insert_with(|| v.clone());
        }
        merged
    }
    pub fn encode(&self) -> Result<Vec<u8>, LayoutError> {
        if self.user.len() > 32 {
            return Err(LayoutError::Limit);
        }
        fn entries(map: &BTreeMap<String, Entry>) -> Value {
            Value::object(
                map.iter()
                    .map(|(id, e)| (std::sync::Arc::from(id.as_str()), entry_wire(e, None)))
                    .collect(),
            )
        }
        let mut v = obj(vec![
            ("version", num(VERSION)),
            ("workspaces", entries(&self.workspaces)),
            (
                "user",
                arr(self
                    .user
                    .iter()
                    .map(|(id, e)| entry_wire(e, Some(id)))
                    .collect()),
            ),
            (
                "tombstones",
                Value::object(
                    self.tombstones
                        .iter()
                        .map(|(id, s)| (std::sync::Arc::from(id.as_str()), stamp(s)))
                        .collect(),
                ),
            ),
        ]);
        if let Value::Obj(o) = &mut v {
            let o = std::sync::Arc::make_mut(o);
            for (k, v) in &self.unknown {
                if o.get(k).is_none() {
                    o.set(k, v.clone());
                }
            }
        }
        let mut b = Vec::new();
        styk_doc::json::write(&v, &mut b);
        if b.len() > MAX_BYTES {
            Err(LayoutError::Limit)
        } else {
            Ok(b)
        }
    }
    pub fn decode(b: &[u8]) -> Result<Self, LayoutError> {
        if b.len() > MAX_BYTES {
            return Err(LayoutError::Limit);
        }
        let v = styk_doc::json::parse(b).map_err(|_| LayoutError::InvalidFile)?;
        let version = uint(get(&v, "version")?)?;
        if version > VERSION {
            return Err(LayoutError::FutureVersion);
        }
        if version != VERSION {
            return Err(LayoutError::InvalidFile);
        }
        fn entries(v: &Value) -> Result<BTreeMap<String, Entry>, LayoutError> {
            v.as_obj()
                .ok_or(LayoutError::InvalidFile)?
                .iter()
                .map(|(id, e)| {
                    Ok((
                        id.to_string(),
                        Entry {
                            stamp: read_stamp(get(e, "stamp")?)?,
                            value: entry_payload(e)?,
                        },
                    ))
                })
                .collect()
        }
        Ok(Self {
            workspaces: entries(get(&v, "workspaces")?)?,
            user: list(get(&v, "user")?)?
                .iter()
                .map(|e| {
                    Ok((
                        text(get(e, "id")?)?.to_owned(),
                        Entry {
                            stamp: read_stamp(get(e, "stamp")?)?,
                            value: entry_payload(e)?,
                        },
                    ))
                })
                .collect::<Result<_, LayoutError>>()?,
            tombstones: get(&v, "tombstones")?
                .as_obj()
                .ok_or(LayoutError::InvalidFile)?
                .iter()
                .map(|(id, s)| Ok((id.to_string(), read_stamp(s)?)))
                .collect::<Result<_, LayoutError>>()?,
            unknown: v
                .as_obj()
                .ok_or(LayoutError::InvalidFile)?
                .iter()
                .filter(|(k, _)| {
                    !["version", "workspaces", "user", "tombstones"].contains(&k.as_ref())
                })
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        })
    }
    /// The closure runs under Storage's cross-process transaction, so concurrent additions cannot overwrite each other.
    pub async fn save(
        &self,
        storage: &dyn styk_services::storage::Storage,
        now: u64,
        cancel: &styk_services::Cancel,
    ) -> Result<(), LayoutError> {
        let proposed = self.clone();
        storage
            .update(
                FILE_NAME,
                MAX_BYTES,
                Box::new(move |bytes| {
                    let current = match bytes {
                        Some(b) => Self::decode(b).map_err(|e| format!("{e:?}"))?,
                        None => Self::default(),
                    };
                    current
                        .merge(&proposed, now)
                        .encode()
                        .map_err(|e| format!("{e:?}"))
                }),
                cancel,
            )
            .await
            .map_err(|e| LayoutError::Storage(e.to_string()))
    }
}

impl LayoutFile {
    pub fn save_user(
        &mut self,
        id: &str,
        name: &str,
        workspaces: &[Workspace],
        layout: &Layout,
        stamp: Stamp,
    ) -> Result<(), LayoutError> {
        if name.trim().is_empty()
            || name.chars().count() > 48
            || (!self.user.contains_key(id) && self.user.len() >= 32)
            || id.is_empty()
        {
            return Err(LayoutError::Limit);
        }
        for w in workspaces {
            layout.validate(*w)?;
        }
        let names = workspaces
            .iter()
            .map(|w| {
                string(match w {
                    Workspace::Animate => "animate",
                    Workspace::Draw => "draw",
                    Workspace::Rig => "rig",
                })
            })
            .collect();
        let value = obj(vec![
            ("name", string(name)),
            ("workspaces", arr(names)),
            ("layout", to_value(layout)),
        ]);
        self.user.insert(id.into(), Entry { stamp, value });
        Ok(())
    }
    pub fn delete_user(&mut self, id: &str, stamp: Stamp) -> Result<Entry, LayoutError> {
        let old = self.user.remove(id).ok_or(LayoutError::Missing)?;
        self.tombstones.insert(id.into(), stamp);
        Ok(old)
    }
}
pub fn state_to_value(s: &LayoutState) -> Value {
    let mut value = obj(vec![
        ("current", to_value(&s.current)),
        ("base", to_value(&s.base)),
        ("dirty", Value::from(s.dirty)),
        (
            "setups",
            Value::object(
                s.setups
                    .iter()
                    .map(|(key, l)| (std::sync::Arc::from(key.to_string()), to_value(l)))
                    .collect(),
            ),
        ),
    ]);
    if let Value::Obj(o) = &mut value {
        let o = std::sync::Arc::make_mut(o);
        for (k, v) in &s.unknown {
            if o.get(k).is_none() {
                o.set(k, v.clone());
            }
        }
    }
    value
}
pub fn state_from_value(v: &Value, w: Workspace) -> Result<LayoutState, LayoutError> {
    let mut s = LayoutState::new(from_value(get(v, "current")?, w)?);
    s.unknown = v
        .as_obj()
        .ok_or(LayoutError::InvalidFile)?
        .iter()
        .filter(|(k, _)| !["current", "base", "dirty", "setups"].contains(&k.as_ref()))
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    s.base = from_value(get(v, "base")?, w)?;
    s.dirty = s.current != s.base;
    s.setups = get(v, "setups")?
        .as_obj()
        .ok_or(LayoutError::InvalidFile)?
        .iter()
        .map(|(k, v)| {
            Ok((
                k.parse().map_err(|_| LayoutError::InvalidFile)?,
                from_value(v, w)?,
            ))
        })
        .collect::<Result<_, LayoutError>>()?;
    Ok(s)
}

fn entry_wire(e: &Entry, id: Option<&str>) -> Value {
    let mut o = e.value.as_obj().cloned().unwrap_or_default();
    o.set("stamp", stamp(&e.stamp));
    if let Some(id) = id {
        o.set("id", string(id));
    }
    Value::object(o)
}
fn entry_payload(e: &Value) -> Result<Value, LayoutError> {
    let mut o = e.as_obj().ok_or(LayoutError::InvalidFile)?.clone();
    o.remove_all(["stamp", "id"]);
    Ok(Value::object(o))
}
/// One named layout for .stylayout import/export, independent of the profile catalogue.
pub fn export_named(name: &str, layout: &Layout) -> Result<Vec<u8>, LayoutError> {
    if name.trim().is_empty() || name.chars().count() > 48 {
        return Err(LayoutError::Limit);
    }
    let v = obj(vec![
        ("version", num(VERSION)),
        ("name", string(name)),
        ("layout", to_value(layout)),
    ]);
    let mut b = vec![];
    styk_doc::json::write(&v, &mut b);
    if b.len() > MAX_BYTES {
        Err(LayoutError::Limit)
    } else {
        Ok(b)
    }
}
pub fn import_named(
    bytes: &[u8],
    w: Workspace,
) -> Result<(String, Layout, Vec<String>), LayoutError> {
    if bytes.len() > MAX_BYTES {
        return Err(LayoutError::Limit);
    }
    let v = styk_doc::json::parse(bytes).map_err(|_| LayoutError::InvalidFile)?;
    let version = uint(get(&v, "version")?)?;
    if version > VERSION {
        return Err(LayoutError::FutureVersion);
    }
    if version != VERSION {
        return Err(LayoutError::InvalidFile);
    }
    let name = text(get(&v, "name")?)?;
    if name.trim().is_empty() || name.chars().count() > 48 {
        return Err(LayoutError::Limit);
    }
    let (l, warnings) = repair(get(&v, "layout")?, w);
    Ok((name.into(), l, warnings))
}

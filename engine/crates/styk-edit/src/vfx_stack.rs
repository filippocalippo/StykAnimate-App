//! Effects in a figure's, a segment's or the scene's stack on a layer sheet
//! (src/editor-vfx.mjs): added, removed, reset, duplicated, moved, reordered, pasted and
//! installed from a preset, each stack or attached scope keyed at the playhead through
//! `addAnimationKeys`. New effects take the
//! identities the editor drew (D18).

use styk_doc::{Obj, Value};
use styk_eval::vfx::Kind;

use crate::property_edit::{normalize_target, validate_vfx_value};
use crate::sheet::items;
use crate::{EditError, Editor};

/// Built-in editable effects, generated from
/// src/vfx-presets.mjs, kept outside browser-specific bindings.
fn preset(name: &Value) -> Option<Value> {
    static PRESETS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    PRESETS.get_or_init(|| styk_doc::json::parse(include_bytes!("vfx_presets.json")).expect("the generated preset catalogue is valid")).get(name.as_str()?).cloned()
}

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// `effectAvailable(type, scene)`: scene stacks take the scene's effects; figures and segments
/// the others but the vignette (an unknown kind passes here and fails in `createVfx`).
fn available(kind: &str, scene: bool) -> bool {
    match Kind::from_name(kind) {
        Some(k) if scene => k.on_scene(),
        None if scene => false,
        Some(k) => !k.scene_only() && kind != "vignette",
        None => kind != "vignette",
    }
}

fn is_scene(target: &Value) -> bool {
    target.get("kind").and_then(Value::as_str) == Some("scene")
}

impl Editor {
    /// `connectedVfxConflict(frame, uid)`: existing scope depths include the forced owner.
    /// The current displayed frame owns joins; no source frame or editable pose is changed.
    pub(crate) fn check_connected_vfx(&self, uid: &Value) -> Result<(), EditError> {
        let objects = crate::frame::objects_of(&self.shown_frame()?);
        let root = objects.iter().position(|o| o.get("unique_id") == Some(uid)).ok_or_else(|| invalid("The effect owner is missing."))?;
        let mut children = vec![Vec::new(); objects.len()];
        let mut queue = Vec::new();
        for (slot, object) in objects.iter().enumerate() {
            match object.get("join").filter(|j| j.truthy()) {
                None => queue.push(slot),
                Some(join) => if let Some(parent) = join.get("target_object_slot").and_then(Value::as_f64).filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n < objects.len() as f64) { children[parent as usize].push(slot); },
            }
        }
        let mut depths = vec![None; objects.len()];
        let mut at = 0;
        while at < queue.len() {
            let slot = queue[at];
            at += 1;
            if depths[slot].is_some() { continue; }
            let object = &objects[slot];
            let parent = object.path(&["join", "target_object_slot"]).and_then(Value::as_f64).filter(|n| n.fract() == 0.0 && *n >= 0.0).and_then(|n| depths.get(n as usize)).copied().flatten().unwrap_or(0);
            depths[slot] = Some(parent + usize::from(object.get("_stykVfxScope") == Some(&Value::Num(1.0)) || slot == root));
            queue.extend_from_slice(&children[slot]);
        }
        let mut members = vec![false; objects.len()];
        let mut queue = vec![root];
        members[root] = true;
        let mut at = 0;
        while at < queue.len() {
            let slot = queue[at];
            at += 1;
            if depths[slot].is_some_and(|depth| depth > 16) { return Err(invalid("Connected VFX support at most 16 nested groups.")); }
            for &child in &children[slot] {
                if !members[child] { members[child] = true; queue.push(child); }
            }
        }
        Ok(())
    }

    /// `setVfxScope(target, includeAttached)`: the figure scope keyed at the playhead.
    pub(crate) fn set_vfx_scope(&mut self, target: &Value, include: &Value) -> Result<Value, EditError> {
        let target = self.vfx_target(target)?;
        if target.get("kind").and_then(Value::as_str) != Some("figure") { return Err(invalid("errors.editorVfx.selectAWholeFigureToIncludeAttachedParts")); }
        let Some(include) = include.as_bool() else { return Err(invalid("errors.editorVfx.chooseWhetherToIncludeAttachedParts")) };
        if include { self.check_connected_vfx(target.get("uid").unwrap_or(&Value::Null))?; }
        let mut entry = Obj::new();
        entry.set("target", target);
        entry.set("property", Value::str("vfxScope"));
        entry.set("tick", Value::Num(self.tick));
        entry.set("value", Value::Num(if include { 1.0 } else { 0.0 }));
        entry.set("exactTarget", Value::Bool(true));
        self.add_animation_keys(Some(&Value::array(vec![Value::object(entry)]))).map(|keys| keys.item(0).unwrap_or(Value::Null))
    }

    /// A preset's ordinary editable effects; stack identities use the `fx-` spelling,
    /// clip effects keep the editor's UUIDs. Validation occurs when the stack is published.
    pub(crate) fn vfx_preset_effects(&mut self, name: &Value, stack_ids: bool) -> Result<Vec<Value>, EditError> {
        let preset = preset(name).ok_or_else(|| invalid(if stack_ids { "errors.editorVfx.chooseAnAvailablePreset" } else { "errors.editorVfxClips.chooseAnEffectPreset" }))?;
        let mut effects = Vec::new();
        for definition in items(Some(&preset)) {
            let id = if stack_ids { self.fresh_effect_id()? } else { self.draw_uuid()? };
            let effect = self.create_vfx(definition.item(0).as_ref().and_then(Value::as_str).unwrap_or(""), &id)?;
            let mut params = effect.get("params").and_then(Value::as_obj).cloned().unwrap_or_default();
            if let Some(extra) = definition.item(1).as_ref().and_then(Value::as_obj) { for (key, value) in extra.iter() { params.set(key, value.clone()); } }
            let mut effect = effect.as_obj().cloned().unwrap_or_default();
            effect.set("params", Value::object(params));
            effects.push(Value::object(effect));
        }
        Ok(effects)
    }

    /// `applyVfxPreset(targets, name)`: the built-in effects appended to each target.
    pub(crate) fn apply_vfx_preset(&mut self, targets: &Value, name: &Value) -> Result<Value, EditError> {
        if preset(name).is_none() { return Err(invalid("errors.editorVfx.chooseAnAvailablePreset")); }
        let list = if targets.is_array() { items(Some(targets)) } else { vec![targets.clone()] };
        let targets = list.iter().map(|target| self.vfx_target(target)).collect::<Result<Vec<_>, _>>()?;
        let mut entries = Vec::new();
        for target in &targets {
            let mut stack = self.vfx_effects(target)?;
            stack.extend(self.vfx_preset_effects(name, true)?);
            entries.push(self.stack_entry(target, stack)?);
        }
        self.add_animation_keys(Some(&Value::array(entries)))
    }
    /// `targetFor(editor, target)`: a figure, segment or the scene, on an unlocked layer, present
    /// at the playhead.
    pub(crate) fn vfx_target(&self, target: &Value) -> Result<Value, EditError> {
        let target = normalize_target(target)?;
        let kind = target.get("kind").and_then(Value::as_str).unwrap_or("").to_string();
        if !["scene", "figure", "segment"].contains(&kind.as_str()) {
            return Err(invalid("errors.editorVfx.selectAFigureNodeMovieclipOrScene"));
        }
        let layer = if kind == "scene" { "scene".to_string() } else { self.layer_of(target.get("uid").and_then(Value::as_f64).unwrap_or(0.0) as u32) };
        if self.track_locked(&layer) {
            return Err(invalid("errors.editorVfx.unlockThisLayerBeforeEditingEffects"));
        }
        if self.animation_value(&target, "vfxStack", &Value::Num(self.tick))?.is_none() {
            return Err(invalid("errors.editorVfx.thisTargetIsNotPresentAtThisFrame"));
        }
        Ok(target)
    }

    /// `vfxEffects(target)`: the target's stack on show.
    pub(crate) fn vfx_effects(&self, target: &Value) -> Result<Vec<Value>, EditError> {
        Ok(items(self.animation_value(target, "vfxStack", &Value::Num(self.tick))?.as_ref()))
    }

    /// `createVfx(type, id)`: an effect of `type` with its default parameters.
    pub(crate) fn create_vfx(&self, kind: &str, id: &str) -> Result<Value, EditError> {
        if Kind::from_name(kind).is_none() {
            return Err(invalid("errors.vfx.chooseAnAvailableEffect"));
        }
        let mut effect = Obj::new();
        effect.set("version", Value::Num(2.0));
        effect.set("type", Value::str(kind));
        effect.set("id", Value::str(id));
        effect.set("enabled", Value::Bool(true));
        effect.set("params", Value::object(Obj::new()));
        Ok(validate_vfx_value("vfxStack", Some(&Value::array(vec![Value::object(effect)])))?.item(0).unwrap_or(Value::Null))
    }

    /// `freshId()`: `fx-` and an identity the editor drew, without its dashes.
    fn fresh_effect_id(&mut self) -> Result<String, EditError> {
        Ok(format!("fx-{}", self.draw_uuid()?.replace('-', "")))
    }

    /// One `vfxStack` key entry at the playhead.
    fn stack_entry(&self, target: &Value, stack: Vec<Value>) -> Result<Value, EditError> {
        let mut entry = Obj::new();
        entry.set("target", target.clone());
        entry.set("property", Value::str("vfxStack"));
        entry.set("tick", Value::Num(self.tick));
        entry.set("value", validate_vfx_value("vfxStack", Some(&Value::array(stack)))?);
        entry.set("exactTarget", Value::Bool(true));
        Ok(Value::object(entry))
    }

    /// `addVfx(targets, type)`: a new effect at the end of each target's stack. Returns the new
    /// effects' identities.
    pub(crate) fn add_vfx(&mut self, targets: &Value, kind: &Value) -> Result<Value, EditError> {
        let list = if targets.is_array() { items(Some(targets)) } else { vec![targets.clone()] };
        let targets: Vec<Value> = list.iter().map(|t| self.vfx_target(t)).collect::<Result<_, _>>()?;
        let kind = kind.as_str().unwrap_or("").to_string();
        if targets.iter().any(|t| !available(&kind, is_scene(t))) {
            return Err(invalid("errors.editorVfx.thisEffectIsNotAvailableForTheSelected"));
        }
        let (mut entries, mut ids) = (Vec::new(), Vec::new());
        for target in &targets {
            let mut stack = self.vfx_effects(target)?;
            let id = self.fresh_effect_id()?;
            let effect = self.create_vfx(&kind, &id)?;
            ids.push(Value::str(&id));
            stack.push(effect);
            entries.push(self.stack_entry(target, stack)?);
        }
        self.add_animation_keys(Some(&Value::array(entries)))?;
        Ok(Value::array(ids))
    }

    /// `changeVfxStack(target, mutate)`: the target's stack changed and keyed at the playhead.
    fn change_vfx_stack(&mut self, target: &Value, mutate: impl FnOnce(&mut Editor, &Value, &mut Vec<Value>) -> Result<(), EditError>) -> Result<Value, EditError> {
        let target = self.vfx_target(target)?;
        let mut stack = self.vfx_effects(&target)?;
        mutate(self, &target, &mut stack)?;
        let entry = self.stack_entry(&target, stack)?;
        self.add_animation_keys(Some(&Value::array(vec![entry]))).map(|keys| keys.item(0).unwrap_or(Value::Null))
    }

    /// `removeVfx(target, id)`.
    pub(crate) fn remove_vfx(&mut self, target: &Value, id: &Value) -> Result<Value, EditError> {
        self.change_vfx_stack(target, |_, _, stack| {
            if let Some(at) = stack.iter().position(|e| e.get("id") == Some(id)) {
                stack.remove(at);
            }
            Ok(())
        })
    }

    /// `resetVfx(target, id)`: the effect's defaults back.
    pub(crate) fn reset_vfx(&mut self, target: &Value, id: &Value) -> Result<Value, EditError> {
        self.change_vfx_stack(target, |editor, _, stack| {
            let Some(at) = stack.iter().position(|e| e.get("id") == Some(id)) else { return Err(invalid("errors.editorVfx.theEffectNoLongerExists")) };
            let kind = stack[at].get("type").and_then(Value::as_str).unwrap_or("").to_string();
            stack[at] = editor.create_vfx(&kind, id.as_str().unwrap_or(""))?;
            Ok(())
        })
    }

    /// `duplicateVfx(target, id)`: a copy after the effect. Returns the copy's identity.
    pub(crate) fn duplicate_vfx(&mut self, target: &Value, id: &Value) -> Result<Value, EditError> {
        let mut new_id = Value::Null;
        self.change_vfx_stack(target, |editor, _, stack| {
            let Some(at) = stack.iter().position(|e| e.get("id") == Some(id)) else { return Err(invalid("errors.editorVfx.theEffectNoLongerExists")) };
            let fresh = editor.fresh_effect_id()?;
            let mut copy = stack[at].as_obj().cloned().unwrap_or_default();
            copy.set("id", Value::str(&fresh));
            stack.insert(at + 1, Value::object(copy));
            new_id = Value::str(&fresh);
            Ok(())
        })?;
        Ok(new_id)
    }

    /// `moveVfx(target, id, direction)`: one place up or down.
    pub(crate) fn move_vfx(&mut self, target: &Value, id: &Value, direction: &Value) -> Result<Value, EditError> {
        let step = direction.as_f64().filter(|d| *d == -1.0 || *d == 1.0).ok_or_else(|| invalid("errors.editorVfxClips.chooseAnEffectOrder"))?;
        self.change_vfx_stack(target, |_, _, stack| {
            let Some(at) = stack.iter().position(|e| e.get("id") == Some(id)) else { return Ok(()) };
            let to = at as i64 + step as i64;
            if to >= 0 && (to as usize) < stack.len() {
                stack.swap(at, to as usize);
            }
            Ok(())
        })
    }

    /// `reorderVfx(target, id, index)`.
    pub(crate) fn reorder_vfx(&mut self, target: &Value, id: &Value, index: &Value) -> Result<Value, EditError> {
        self.change_vfx_stack(target, |_, _, stack| {
            let from = stack.iter().position(|e| e.get("id") == Some(id));
            let to = index.as_f64().filter(|i| i.fract() == 0.0 && *i >= 0.0 && (*i as usize) < stack.len());
            let (Some(from), Some(to)) = (from, to) else { return Err(invalid("errors.editorVfx.invalidEffectPosition")) };
            let effect = stack.remove(from);
            stack.insert(to as usize, effect);
            Ok(())
        })
    }

    /// `pasteVfx(targets, stack, {includeAttached})` on a layer sheet: the copied effects merged
    /// into each target's stack (an effect of the same identity and kind replaced, one of
    /// another kind under a new identity), and the scope set when given.
    pub(crate) fn paste_vfx(&mut self, targets: &Value, stack: &Value, options: &Value) -> Result<Value, EditError> {
        let list = if targets.is_array() { items(Some(targets)) } else { vec![targets.clone()] };
        let effects = items(Some(&validate_vfx_value("vfxStack", Some(stack))?));
        let include = match options.get("includeAttached") {
            None => None,
            Some(Value::Bool(include)) => Some(*include),
            Some(_) => return Err(invalid("errors.editorVfx.chooseWhetherToIncludeAttachedParts")),
        };
        let mut entries = Vec::new();
        for given in &list {
            let target = self.vfx_target(given)?;
            let mut next = self.vfx_effects(&target)?;
            for effect in &effects {
                let kind = effect.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                if !available(&kind, is_scene(&target)) {
                    return Err(invalid("errors.editorVfx.thisEffectIsNotAvailableForTheSelected"));
                }
                let index = next.iter().position(|e| e.get("id") == effect.get("id"));
                let same = index.is_some_and(|i| next[i].get("type") == effect.get("type"));
                let mut value = effect.as_obj().cloned().unwrap_or_default();
                if index.is_some() && !same {
                    value.set("id", Value::str(&self.fresh_effect_id()?));
                }
                match index.filter(|_| same) {
                    Some(i) => next[i] = Value::object(value),
                    None => next.push(Value::object(value)),
                }
            }
            entries.push(self.stack_entry(&target, next)?);
            if let (Some(include), Some("figure")) = (include, target.get("kind").and_then(Value::as_str)) {
                if include { self.check_connected_vfx(target.get("uid").unwrap_or(&Value::Null))?; }
                let mut scope = Obj::new();
                scope.set("target", target.clone());
                scope.set("property", Value::str("vfxScope"));
                scope.set("tick", Value::Num(self.tick));
                scope.set("exactTarget", Value::Bool(true));
                scope.set("value", Value::Num(if include { 1.0 } else { 0.0 }));
                entries.push(Value::object(scope));
            }
        }
        if !self.sheet() {
            return Err(EditError::Unported("pasteVfx on a native timeline".into()));
        }
        self.add_animation_keys(Some(&Value::array(entries)))
    }
}

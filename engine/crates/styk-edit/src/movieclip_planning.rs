//! Borrowed movieclip sheet planning on the worker. The existing sheet Plan,
//! record evaluator and publication/history callback remain the single owners.
//! Direct editor/UI admission and the remaining presence-replacement options
//! are deliberately outside these recorded planning prerequisites.
use crate::{
    EditError, Editor, FocusLock,
    frame::{layer_of, objects_of},
    layer_planning::{Progress, SheetPlan, checked_plan},
    sheet::{Plan, Write, constant, items, key_at, num},
};
use styk_doc::Value;
use styk_eval::{eval::Prepared, records::Records};

/// Explicit worker-only context. The host retains revision/lineage ownership;
/// this callback publication is a replay oracle until prepared publication and
/// bounded ACK transfer are connected. It must never be called on the UI thread.
pub struct TimelineWorker<'a> {
    pub max_source_bytes: usize,
    pub check: &'a mut dyn FnMut() -> Result<(), EditError>,
    pub progress: &'a mut dyn FnMut(Progress),
    pub clock: fn() -> f64,
}
impl TimelineWorker<'_> {
    pub(crate) fn prepare(&mut self, editor: &mut Editor) -> Result<(), EditError> {
        let prepared = editor.prepared()?;
        if let Some(plan) = prepare_movieclips(
            &editor.report,
            &prepared,
            PreparationRequest {
                uids: &editor.selection.uids,
                next_frame_identity: editor.next_frame_identity,
                max_source_bytes: self.max_source_bytes,
                focus: editor.focus_lock.as_ref(),
            },
            &mut *self.check,
            &mut *self.progress,
            self.clock,
        )? {
            editor.publish_sheet_migration(plan)?;
        }
        Ok(())
    }
    pub(crate) fn publish(
        &mut self,
        editor: &mut Editor,
        channels: &[Value],
        label: &str,
    ) -> Result<(), EditError> {
        let prepared = editor.prepared()?;
        let plan = apply_channels(
            &editor.report,
            &prepared,
            ChannelsRequest {
                channels,
                label,
                preserve_duration: false,
                next_frame_identity: editor.next_frame_identity,
                max_source_bytes: self.max_source_bytes,
                focus: editor.focus_lock.as_ref(),
            },
            &mut *self.check,
            &mut *self.progress,
            self.clock,
        )?;
        editor.publish_sheet_migration(plan)?;
        Ok(())
    }

    /// A command already planned through the existing sheet replacement owner
    /// uses the same opaque publication, source budget and host guards.
    pub(crate) fn publish_plan(
        &mut self,
        editor: &mut Editor,
        plan: Plan,
        label: &str,
    ) -> Result<(), EditError> {
        self.publish_plan_with_selection(editor, plan, label, None)
    }

    pub(crate) fn publish_plan_with_selection(&mut self, editor: &mut Editor, plan: Plan, label: &str, selection: Option<crate::select::SelectionState>) -> Result<(), EditError> {
        self.publish_plan_with_geometry(editor, plan, label, selection, false)
    }

    pub(crate) fn publish_plan_with_geometry(&mut self, editor: &mut Editor, plan: Plan, label: &str, selection: Option<crate::select::SelectionState>, retain_geometry: bool) -> Result<(), EditError> {
        let _scope = crate::prof::scope("planning::publish");
        (self.check)()?;
        budget(self.max_source_bytes)?;
        let (_, poses, values) = memory(plan.sources.iter().map(|(_, frame)| frame), self.max_source_bytes, (0, 0, 0))?;
        (self.progress)(Progress {
            phase: "planning",
            completed: plan.sources.len(),
            total: plan.sources.len(),
            source_frames: plan.sources.len(),
            object_poses: poses,
            segment_values: values,
        });
        (self.check)()?;
        let publication = SheetPlan::movieclip(
            plan,
            label,
            editor
                .report
                .path(&["_styk", "layers"])
                .cloned()
                .unwrap_or(Value::Null),
            editor.next_frame_identity,
        );
        editor.publish_sheet_migration_with_geometry_checked(publication, selection, retain_geometry, || (self.check)())?;
        Ok(())
    }
}

impl Editor {
    /// The context of a timeline call the session runs on the interface: nothing cancels it, nothing waits on
    /// its progress and its sources are bounded by the document, not by a budget.
    pub(crate) fn inline_timeline<T>(&mut self, run: impl FnOnce(&mut Editor, &mut TimelineWorker<'_>) -> T) -> T {
        fn clock() -> f64 { 0.0 }
        let mut check = || Ok(());
        let mut progress = |_: Progress| {};
        let mut worker = TimelineWorker { max_source_bytes: usize::MAX, check: &mut check, progress: &mut progress, clock };
        run(self, &mut worker)
    }
}

#[derive(Clone, Copy)]
enum TimelineCall { Bake, AddFigure, Playback, Restart, RemoveRestart, BreakApart, Extend, Place, Split }
impl TimelineCall {
    fn of(method: &str, args: &[Value]) -> Option<Self> {
        Some(match method {
            "bakeMovieclip" => Self::Bake,
            "addFigure" => Self::AddFigure,
            "setMovieclipPlayback" if args.get(1).and_then(|value| value.get("allFrames")).is_some_and(Value::truthy) => Self::Playback,
            "restartMovieclip" => Self::Restart,
            "removeMovieclipRestart" => Self::RemoveRestart,
            "breakApartMovieclip" => Self::BreakApart,
            "addMovieclipToNextKeyframes" => Self::Extend,
            "placeMovieclip" => Self::Place,
            "splitMovieclip" => Self::Split,
            _ => return None,
        })
    }
}

impl Editor {
    /// Offline replay routing for the SAME supported worker calls. Ordinary
    /// figure insertion and unrecorded selection metadata keep normal dispatch.
    pub(crate) fn movieclip_timeline_replay_call(&self, method: &str, args: &[Value]) -> bool {
        if self.selection_metadata_visible() && !crate::select::metadata_recorded_call(method) { return false; }
        if !self.sheet() { return matches!(TimelineCall::of(method, args), Some(TimelineCall::Bake)); }
        match TimelineCall::of(method, args) {
            Some(TimelineCall::AddFigure) => {
                let figures = items(self.report.get("figure_types"));
                let wanted = args.first().cloned().or_else(|| figures.first().and_then(|figure| figure.get("figure_type_id").cloned()));
                figures.iter().find(|figure| figure.get("figure_type_id") == wanted.as_ref()).is_some_and(|figure| figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy))
            }
            Some(_) => true,
            None => false,
        }
    }

    /// Recorded sequential timed sheet calls on a durable worker editor. The
    /// normal `call` path continues to refuse these dense operations.
    pub fn call_movieclip_timeline_worker(
        &mut self,
        method: &str,
        args: &[Value],
        worker: &mut TimelineWorker<'_>,
    ) -> Result<Value, EditError> {
        if !self.sheet() && !matches!(TimelineCall::of(method, args), Some(TimelineCall::Bake)) {
            return Err(EditError::Unported(
                "movieclip sheet worker on a native timeline".into(),
            ));
        }
        if let Some(reason) = self.scan_unported() {
            if !self.recorded_native_movieclip_call(method, args, &reason) {
                return Err(EditError::Unported(format!("{method} {reason}")));
            }
        }
        if self.report.path(&["_styk", "simpleFrameDraft"]).is_some() {
            return Err(EditError::Unported(
                "timed movieclip worker with a saved frame draft".into(),
            ));
        }
        if let Some(reason) = self.ik_gate(method, args)? {
            return Err(EditError::Unported(format!("{method} {reason}")));
        }
        let snapshot = self.snapshot();
        let interrupted = std::cell::Cell::new(false);
        let check = &mut || {
            let result = (worker.check)();
            interrupted.set(interrupted.get() || result.is_err());
            result
        };
        let mut context = TimelineWorker {
            max_source_bytes: worker.max_source_bytes,
            check,
            progress: worker.progress,
            clock: worker.clock,
        };
        let result = match TimelineCall::of(method, args) {
            Some(TimelineCall::Bake) => self.bake_movieclip_worker(&mut context),
            Some(TimelineCall::AddFigure) => self.add_sheet_movieclip_figure(args.first(), &mut context),
            Some(TimelineCall::Playback) => {
                self.set_movieclip_playback_with(
                    args.first().unwrap_or(&Value::Null),
                    args.get(1).unwrap(),
                    Some(&mut context),
                )
            }
            Some(TimelineCall::Restart) => self.restart_movieclip_with(Some(&mut context)),
            Some(TimelineCall::RemoveRestart) => self.remove_movieclip_restart_with(Some(&mut context)),
            Some(TimelineCall::BreakApart) => self.break_apart_movieclip_with(Some(&mut context)),
            Some(TimelineCall::Extend) => self.extend_sheet_movieclip(
                args.first().and_then(Value::as_f64).unwrap_or(f64::NAN),
                &mut context,
            ),
            Some(TimelineCall::Place) => self.place_movieclip_with(
                args.first().unwrap_or(&Value::Null),
                args.get(1)
                    .and_then(|v| v.get("move"))
                    .is_some_and(Value::truthy),
                Some(&mut context),
            ),
            Some(TimelineCall::Split) => self.split_movieclip_with(
                args.first().and_then(Value::as_f64).unwrap_or(self.tick),
                Some(&mut context),
            ),
            None => Err(EditError::Unported(format!(
                "timed movieclip sheet worker {method}"
            ))),
        };
        // Host cancellation/budget rejection discards this worker transaction,
        // including counters, pending source membership and the live gesture.
        // Ordinary editor errors retain their recorded command semantics.
        let host_budget = matches!(&result, Err(EditError::Invalid(key)) if matches!(key.as_str(),
            "errors.editorLayerMigration.thisLayerMigrationExceedsTheRetainedPoseMemory" |
            "errors.editorLayerMigration.layerMigrationSourceMemoryBudgetMustBePositive"));
        if interrupted.get() || host_budget || matches!(result, Err(EditError::Unported(_))) {
            self.restore(snapshot);
        }
        result
    }
}

pub struct PreparationRequest<'a> {
    pub uids: &'a [u32],
    pub next_frame_identity: u64,
    pub max_source_bytes: usize,
    /// The layers Focus and lock holds from the edit.
    pub focus: Option<&'a FocusLock>,
}
pub struct ChannelsRequest<'a> {
    pub channels: &'a [Value],
    pub label: &'a str,
    pub preserve_duration: bool,
    pub next_frame_identity: u64,
    pub max_source_bytes: usize,
    /// The layers Focus and lock holds from the edit.
    pub focus: Option<&'a FocusLock>,
}
pub(crate) fn memory<'a>(
    frames: impl ExactSizeIterator<Item = &'a Value>,
    maxbytes: usize,
    previous: (usize, usize, usize),
) -> Result<(usize, usize, usize), EditError> {
    let total = frames.len();
    let (counted, mut poses, mut values) = previous;
    for frame in frames.skip(counted) {
        for object in objects_of(frame) {
            poses = poses.saturating_add(1);
            for field in ["angles", "lengths", "bends"] {
                values = values
                    .saturating_add(object.get(field).and_then(Value::array_len).unwrap_or(0));
            }
        }
    }
    let retained = 256usize
        .saturating_mul(total)
        .saturating_add(512usize.saturating_mul(poses))
        .saturating_add(8usize.saturating_mul(values));
    if retained > maxbytes {
        return Err(EditError::Invalid(
            "errors.editorLayerMigration.thisLayerMigrationExceedsTheRetainedPoseMemory".into(),
        ));
    }
    Ok((total, poses, values))
}
pub(crate) fn budget(maxbytes: usize) -> Result<(), EditError> {
    if maxbytes == 0 {
        Err(EditError::Invalid(
            "errors.editorLayerMigration.layerMigrationSourceMemoryBudgetMustBePositive".into(),
        ))
    } else {
        Ok(())
    }
}
/// `_prepareSheetMovieclips`: only selected, unlocked user layers with imported
/// source keys are materialized. The acknowledged report/Prepared generation must
/// match, and the host owns revision/lineage checks and bounded publication ACKs.
pub fn prepare_movieclips(
    report: &Value,
    prepared: &Prepared,
    request: PreparationRequest<'_>,
    mut check: impl FnMut() -> Result<(), EditError>,
    mut progress: impl FnMut(Progress),
    clock: fn() -> f64,
) -> Result<Option<SheetPlan>, EditError> {
    check()?;
    let layers = report
        .path(&["_styk", "layers"])
        .cloned()
        .unwrap_or(Value::Null);
    let ids: Vec<String> = items(layers.get("order"))
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| {
            request
                .uids
                .iter()
                .any(|u| layer_of(Some(&layers), *u) == *id)
                && !crate::layer_focus::locked(
                    layers.path(&["byId", id, "locked"]).is_some_and(Value::truthy),
                    request.focus,
                    id,
                )
                && items(report.path(&["_styk", "layerSheet", "tracks", id, "keys"]))
                    .iter()
                    .any(|key| key.get("sourceTick").is_some())
        })
        .map(str::to_string)
        .collect();
    if ids.is_empty() {
        return Ok(None);
    }
    budget(request.max_source_bytes)?;
    let mut plan = checked_plan(report, &ids, request.next_frame_identity, request.focus)?;
    let records = Records::new(report, prepared).map_err(EditError::from)?;
    let total: usize = ids
        .iter()
        .map(|id| items(report.path(&["_styk", "layerSheet", "tracks", id, "keys"])).len())
        .sum();
    let (mut completed, mut last) = (0usize, clock());
    let mut footprint = (0usize, 0usize, 0usize);
    for id in &ids {
        let mut keys = plan.keys(id);
        for key in &mut keys {
            check()?;
            if key.get("sourceTick").is_some() {
                let frame = records
                    .evaluated_with(num(key, "tick").unwrap_or(0.0), false)
                    .map_err(EditError::from)?;
                let source = plan.capture(&frame, id);
                let key = key.make_obj().ok_or_else(|| {
                    EditError::Invalid("errors.layerSheet.invalidLayerTimeline".into())
                })?;
                key.set("value", source);
                key.remove("sourceTick");
            }
            completed += 1;
            footprint = memory(plan.sources.iter().map(|(_, frame)| frame), request.max_source_bytes, footprint)?;
            let (_, poses, values) = footprint;
            if completed % 8 == 0 || clock() - last >= 8.0 || completed == total {
                progress(Progress {
                    phase: "planning",
                    completed,
                    total,
                    source_frames: plan.sources.len(),
                    object_poses: poses,
                    segment_values: values,
                });
                last = clock();
            }
        }
        plan.set_keys(id, keys);
    }
    check()?;
    Ok(Some(SheetPlan::movieclip(
        plan,
        "Prepare movieclip poses",
        layers,
        request.next_frame_identity,
    )))
}
/// Plain `sheetApplyChannels`: existing sheet samples compose the supplied pose
/// and scalar channels, and writes capture through Plan. Continuation/replacement
/// options await their own recordings and are not exposed by this request.
pub fn apply_channels(
    report: &Value,
    prepared: &Prepared,
    request: ChannelsRequest<'_>,
    mut check: impl FnMut() -> Result<(), EditError>,
    mut progress: impl FnMut(Progress),
    clock: fn() -> f64,
) -> Result<SheetPlan, EditError> {
    check()?;
    budget(request.max_source_bytes)?;
    let layers = report
        .path(&["_styk", "layers"])
        .cloned()
        .unwrap_or(Value::Null);
    let mut ids = Vec::new();
    let mut ticks = Vec::new();
    for channel in request.channels {
        let target = channel.get("target").unwrap_or(&Value::Null);
        let id = match target.get("kind").and_then(Value::as_str) {
            Some("scene") => "scene".to_string(),
            Some("camera") => "camera".to_string(),
            Some("layer") => target
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            _ => layer_of(Some(&layers), num(target, "uid").unwrap_or(0.0) as u32).to_string(),
        };
        if !ids.contains(&id) {
            ids.push(id);
        }
        ticks.extend(
            items(channel.get("keys"))
                .iter()
                .filter(|key| !key.get("hidden").is_some_and(Value::truthy))
                .filter_map(|key| num(key, "tick").filter(|tick| *tick >= 0.0)),
        );
        for range in items(channel.get("maskedRanges")) {
            ticks.extend(range.numbers().unwrap_or_default());
        }
        if let Some(end) = num(channel, "clipEnd") {
            ticks.push(end);
        }
    }
    if ids.is_empty() {
        return Err(EditError::Invalid(
            "errors.editorLayerSheet.selectALayer".into(),
        ));
    }
    let mut plan = checked_plan(report, &ids, request.next_frame_identity, request.focus)?;
    for id in &ids {
        ticks.extend(plan.keys(id).iter().filter_map(|key| num(key, "tick")));
    }
    ticks.sort_by(f64::total_cmp);
    ticks.dedup();
    let records = Records::new(report, prepared).map_err(EditError::from)?;
    let (total, mut last) = (ticks.len(), clock());
    let mut footprint = (0usize, 0usize, 0usize);
    let channels = records
        .bind_channels(request.channels)
        .map_err(EditError::from)?;
    for (at, tick) in ticks.into_iter().enumerate() {
        check()?;
        if !request.preserve_duration || tick < plan.duration {
            let base = records
                .evaluated_with(tick, false)
                .map_err(EditError::from)?;
            let frame = channels.compose(base, tick).map_err(EditError::from)?;
            for id in &ids {
                let keys = items(report.path(&["_styk", "layerSheet", "tracks", id, "keys"]));
                let fallback = constant();
                let current = key_at(&keys, tick).map(|at| &keys[at]).unwrap_or(&fallback);
                plan.write(
                    id,
                    tick,
                    &frame,
                    Write {
                        easing: Some(current),
                        ..Write::default()
                    },
                )?;
            }
        }
        footprint = memory(plan.sources.iter().map(|(_, frame)| frame), request.max_source_bytes, footprint)?;
        let (_, poses, values) = footprint;
        if (at + 1) % 8 == 0 || clock() - last >= 8.0 || at + 1 == total {
            progress(Progress {
                phase: "planning",
                completed: at + 1,
                total,
                source_frames: plan.sources.len(),
                object_poses: poses,
                segment_values: values,
            });
            last = clock();
        }
    }
    check()?;
    Ok(SheetPlan::movieclip(
        plan,
        request.label,
        layers,
        request.next_frame_identity,
    ))
}

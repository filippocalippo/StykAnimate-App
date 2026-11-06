//! Baking a movieclip (`bakeMovieclip`, src/editor-movieclips.mjs): every frame of the clip sampled as ordinary editable poses and
//! published as one `Bake animation` entry.
//!
//! The sampling is the long part (a frame of a dense scene takes milliseconds, and a bake may sample thousands), so it is a job that
//! runs in slices: [`Editor::begin_bake`] checks the clip and opens the job, [`Editor::sample_bake`] samples some more of its
//! frames, [`Editor::publish_bake`] publishes them. The interface (`engine-owner.mjs`) gives the thread back between slices; a
//! call that runs all three at once is `bakeMovieclip`, for the tools and the tests. A job belongs to the revision it began at:
//! any edit between its slices ends it.

use styk_doc::Value;
use styk_eval::materialize::{Materializer, MaterializerState};

use crate::frame::objects_of;
use crate::movieclip_commands::{error, materialize_error, uses_presence};
use crate::movieclip_planning::TimelineWorker;
use crate::record::{num, uid};
use crate::{EditError, Editor};

/// A bake in progress: the frames sampled so far, and where the sampling goes on.
pub(crate) struct Job {
    /// The revision it began at.
    revision: u64,
    /// The clip's figure.
    previous: u32,
    /// The clip's record as the bake began.
    original: Value,
    start: f64,
    end: f64,
    /// The next tick to sample.
    tick: f64,
    /// The document the clip is sampled from.
    report: Value,
    state: Option<MaterializerState>,
    frames: Vec<(f64, Value)>,
    count: usize,
    footprint: (usize, usize, usize),
}

impl Editor {
    /// `bakeMovieclip` in one go: the bake as the tools and the tests run it, with the context of their worker.
    pub(crate) fn bake_movieclip_worker(&mut self, worker: &mut TimelineWorker<'_>) -> Result<Value, EditError> {
        let mut job = self.start_bake(worker)?;
        while !self.sample_job(&mut job, usize::MAX, worker)? {}
        self.finish_bake(job, worker)
    }

    /// `bakeMovieclipBegin()`: the selected clip is checked and the job opened (one already open ends). The answer says how many ticks
    /// it will sample.
    pub(crate) fn begin_bake(&mut self, worker: &mut TimelineWorker<'_>) -> Result<Value, EditError> {
        self.bake = None;
        let job = self.start_bake(worker)?;
        let mut answer = styk_doc::Obj::new();
        answer.set("total", Value::Num((job.end - job.start).max(0.0)));
        self.bake = Some(job);
        Ok(Value::object(answer))
    }

    /// `bakeMovieclipSample(ticks)`: up to that many more ticks sampled. The answer says whether the job has sampled them all.
    pub(crate) fn sample_bake(&mut self, ticks: f64, worker: &mut TimelineWorker<'_>) -> Result<Value, EditError> {
        let mut job = self.open_bake()?;
        let done = self.sample_job(&mut job, if ticks >= 1.0 { ticks as usize } else { 1 }, worker)?;
        let mut answer = styk_doc::Obj::new();
        answer.set("done", Value::Bool(done));
        answer.set("completed", Value::Num(job.frames.len() as f64));
        self.bake = Some(job);
        Ok(Value::object(answer))
    }

    /// `bakeMovieclipPublish()`: the frames sampled become the baked poses, as one entry. The job ends either way.
    pub(crate) fn publish_bake(&mut self, worker: &mut TimelineWorker<'_>) -> Result<Value, EditError> {
        let job = self.open_bake()?;
        self.finish_bake(job, worker)
    }

    /// The job open at this revision: one that an edit since overtook ends here.
    fn open_bake(&mut self) -> Result<Job, EditError> {
        let job = self.bake.take().ok_or_else(|| error("theSceneChangedWhileBakingTryAgain"))?;
        if job.revision != self.revision {
            return Err(error("theSceneChangedWhileBakingTryAgain"));
        }
        Ok(job)
    }

    /// The checks a bake begins with, and its job.
    fn start_bake(&mut self, worker: &mut TimelineWorker<'_>) -> Result<Job, EditError> {
        self.selected_movieclip()?;
        self.commit_drag()?;
        self.commit_animation_edit()?;
        let (_, original, _) = self.selected_movieclip()?;
        let previous = uid(&original).unwrap();
        let playback = crate::movieclips::playback_settings(original.get("_stykMovieclip"));
        let start = if uses_presence(&original) { 0.0 } else { num(&Value::object(playback.clone()), "start").unwrap_or(0.0) };
        let total = crate::timeline::total_ticks(&crate::timeline::rows(&self.report));
        let end = playback.get("end").and_then(Value::as_f64).unwrap_or(total).min(total);
        if end - start > 5000.0 {
            return Err(error("bakeSupportsScenesUpTo5000Frames"));
        }
        crate::movieclip_planning::budget(worker.max_source_bytes)?;
        Ok(Job { revision: self.revision, previous, original, start, end, tick: start, report: self.report.clone(), state: None, frames: Vec::new(), count: 0, footprint: (0, 0, 0) })
    }

    /// Samples up to `ticks` more ticks of the job. Whether it has sampled them all.
    fn sample_job(&self, job: &mut Job, ticks: usize, worker: &mut TimelineWorker<'_>) -> Result<bool, EditError> {
        let prepared = self.prepared()?;
        let records = styk_eval::records::Records::new(&job.report, &prepared).map_err(materialize_error)?;
        let mut materializer = match job.state.take() {
            Some(state) => Materializer::resume(&job.report, &prepared, state),
            None => Materializer::new(&job.report, &prepared).map_err(materialize_error)?,
        };
        let stop = job.tick + ticks as f64;
        let mut last = (worker.clock)();
        while job.tick < job.end && job.tick < stop {
            (worker.check)()?;
            let tick = job.tick;
            let sampled = records.evaluated_with(tick, true).map_err(materialize_error)?;
            let frame = self.expand_movieclip_pose(&sampled, job.previous, &mut materializer)?;
            job.count = job.count.saturating_add(objects_of(&frame).len());
            if job.count > 250000 {
                return Err(error("bakeAShorterRangeForThisScene"));
            }
            job.frames.push((tick, frame));
            job.footprint = crate::movieclip_planning::memory(job.frames.iter().map(|(_, frame)| frame), worker.max_source_bytes, job.footprint)?;
            let now = (worker.clock)();
            if job.frames.len() % 8 == 0 || now - last > 6.0 || tick + 1.0 >= job.end {
                (worker.progress)(crate::layer_planning::Progress {
                    phase: "sampling", completed: job.frames.len(), total: (job.end - job.start).max(0.0).ceil() as usize,
                    source_frames: job.frames.len(), object_poses: job.footprint.1, segment_values: job.footprint.2,
                });
                last = now;
                (worker.check)()?;
            }
            job.tick += 1.0;
        }
        job.state = Some(materializer.into_state());
        Ok(job.tick >= job.end)
    }

    /// Publishes what the job sampled.
    fn finish_bake(&mut self, job: Job, worker: &mut TimelineWorker<'_>) -> Result<Value, EditError> {
        let Job { previous, original, start, end, report, state, frames, .. } = job;
        if frames.is_empty() {
            return Ok(Value::Bool(false));
        }
        let prepared = self.prepared()?;
        let materializer = match state {
            Some(state) => Materializer::resume(&report, &prepared, state),
            None => Materializer::new(&report, &prepared).map_err(materialize_error)?,
        };
        let definitions = materializer.figures().to_vec();
        let paths = materializer.identities().map(|(path, uid)| (uid, path.into())).collect();
        (worker.check)()?;
        self.publish_movieclip_expansion_with(frames, previous, (start, end), definitions, paths, "Bake animation", false, &original, Some(worker))
    }
}

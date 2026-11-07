//! The stream driver: the protocol between a renderer and a device, run on the device thread.
//!
//! The thread owns an [`Endpoint`] (WASAPI, or the fake) and calls [`StreamDriver::wake`] each time the device wants data. A
//! wake in an idle stream starts one when the transport asked (`StreamControl::activate`); in a running stream it detects
//! underruns, asks the renderer for the free frames, writes them and publishes the clock.
//!
//! Three kinds of stop (docs/native/audio.md):
//! - the renderer answers `Restart` or `Idle`: the device is stopped and **reset**, so what was queued is discarded now and the
//!   position starts again at 0 (a new epoch);
//! - the renderer keeps answering `Continue` with silence: whatever was queued **still plays**;
//! - a lost device ends the loop with an error.

use std::sync::Arc;

use super::clock::{ClockState, Segment, StreamClock};
use super::{AudioError, Next, RenderResult, RenderSource, StreamControl, RATE};

/// The device side. All calls happen on the device thread.
pub trait Endpoint {
    /// Frames the stream's buffer holds (stream rate).
    fn buffer_frames(&self) -> u32;
    /// The frequency `position` counts in.
    fn frequency(&self) -> u64;
    /// Frames written and not yet played.
    fn padding(&mut self) -> Result<u32, AudioError>;
    /// Gives `fill` `frames` frames of the buffer (interleaved stereo `f32`) and releases them; when `fill` answers `false`
    /// the frames are released as silence.
    fn write(&mut self, frames: u32, fill: &mut dyn FnMut(&mut [f32]) -> bool) -> Result<(), AudioError>;
    /// The position being heard now, in the units of `frequency`, and the host time (ns) it was measured at.
    fn position(&mut self) -> Result<(u64, u64), AudioError>;
    fn start(&mut self) -> Result<(), AudioError>;
    /// Stops the stream and discards everything queued; the position restarts at 0.
    fn stop_and_reset(&mut self) -> Result<(), AudioError>;
}

pub struct StreamDriver {
    source: Box<dyn RenderSource>,
    clock: Arc<StreamClock>,
    control: Arc<StreamControl>,
    state: ClockState,
    running: bool,
}

/// Restarts asked back to back in one wake are served at most this often; the renderer cannot ask for ever.
const MAX_RESTARTS: usize = 4;

impl StreamDriver {
    pub fn new(source: Box<dyn RenderSource>, clock: Arc<StreamClock>, control: Arc<StreamControl>) -> StreamDriver {
        StreamDriver { source, clock, control, state: ClockState::default(), running: false }
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub fn clock_state(&self) -> &ClockState {
        &self.state
    }

    /// One wake of the device thread.
    pub fn wake<E: Endpoint + ?Sized>(&mut self, endpoint: &mut E) -> Result<(), AudioError> {
        if !self.running {
            if self.control.take_activation() {
                self.begin(endpoint)?;
            }
            return Ok(());
        }
        self.period(endpoint)
    }

    /// Writes one block, records what it holds, and returns what the renderer wants next.
    fn block<E: Endpoint + ?Sized>(&mut self, endpoint: &mut E, frames: u32) -> Result<Next, AudioError> {
        let source = &mut self.source;
        let mut result: Option<RenderResult> = None;
        endpoint.write(frames, &mut |out| {
            let rendered = source.render(out);
            let keep = rendered.next == Next::Continue;
            result = Some(rendered);
            keep
        })?;
        let result = result.expect("the endpoint calls fill once");
        self.state.generation = result.generation;
        if result.next == Next::Continue {
            let playing = result.playing_frames.min(frames) as u64;
            let start = self.state.rendered;
            self.state.push(Segment { stream_start: start, frames: playing, playing: true, project: result.project_start });
            self.state.push(Segment { stream_start: start + playing, frames: frames as u64 - playing, playing: false, project: result.held_at });
            self.state.rendered += frames as u64;
        }
        Ok(result.next)
    }

    /// Starts an epoch: reset the device, fill its buffer from the renderer, start it.
    fn begin<E: Endpoint + ?Sized>(&mut self, endpoint: &mut E) -> Result<(), AudioError> {
        for _ in 0..MAX_RESTARTS {
            endpoint.stop_and_reset()?;
            self.state.begin_epoch();
            match self.block(endpoint, endpoint.buffer_frames())? {
                Next::Continue => {
                    endpoint.start()?;
                    self.running = true;
                    self.clock.store(&self.state);
                    return Ok(());
                }
                Next::Idle => break,
                Next::Restart => {}
            }
        }
        self.go_idle(endpoint)
    }

    fn go_idle<E: Endpoint + ?Sized>(&mut self, endpoint: &mut E) -> Result<(), AudioError> {
        endpoint.stop_and_reset()?;
        self.running = false;
        self.state.end_epoch();
        self.clock.store(&self.state);
        Ok(())
    }

    fn period<E: Endpoint + ?Sized>(&mut self, endpoint: &mut E) -> Result<(), AudioError> {
        // A waiting command takes effect before anything else, whether or not the device has room for a block.
        let waiting = self.source.poll();
        self.state.generation = waiting.generation;
        match waiting.next {
            Next::Continue => {}
            Next::Restart => return self.begin(endpoint),
            Next::Idle => return self.go_idle(endpoint),
        }
        let (position, host_ns) = endpoint.position()?;
        let frequency = endpoint.frequency().max(1);
        let heard = (position as u128 * RATE as u128 / frequency as u128) as u64;
        // The device played frames nobody wrote (the thread missed its deadline and the position kept counting): the gap is
        // silence that is not project time. The renderer continues where it was, so no sound is skipped and the media time
        // holds for the gap.
        if heard > self.state.rendered {
            let gap = heard - self.state.rendered;
            let at = match self.state.segments[..self.state.len].last() {
                Some(last) if last.playing => last.project + last.frames as i64,
                Some(last) => last.project,
                None => 0,
            };
            let start = self.state.rendered;
            self.state.push(Segment { stream_start: start, frames: gap, playing: false, project: at });
            self.state.rendered = heard;
            self.state.underruns += 1;
        }
        let padding = endpoint.padding()?;
        if padding == 0 && self.state.device_valid {
            // The device ran dry. Where its position stops with it nothing is mapped wrongly; the count is for the user.
            self.state.underruns += 1;
        }
        let free = endpoint.buffer_frames().saturating_sub(padding);
        if free > 0 {
            match self.block(endpoint, free)? {
                Next::Continue => {}
                Next::Restart => return self.begin(endpoint),
                Next::Idle => return self.go_idle(endpoint),
            }
        }
        self.state.position = position;
        self.state.frequency = frequency;
        self.state.host_ns = host_ns;
        self.state.device_valid = position > 0;
        self.clock.store(&self.state);
        Ok(())
    }
}

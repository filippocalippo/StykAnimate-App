//! Large writes to the GPU, copied from staging buffers (docs/engine/rendering.md, Uploads).
//!
//! A browser's `writeBuffer` and `writeTexture` from the engine's shared memory sometimes left part of a large write out: a
//! picture of the sprite atlas read back with rows of other bytes, so an export of the same document did not always give the
//! same frames. A write of [`STAGED_FROM`] bytes or more is therefore copied into a buffer this module maps at creation and
//! fills itself, then copied on the GPU. Smaller writes are `Queue::write_buffer` / `write_texture`.
//!
//! What the staged path costs, and bounds:
//! * On the browser's WebGPU the buffer is filled straight through `getMappedRange` (one copy, by the browser); wgpu's
//!   `get_mapped_range_mut` would first copy the range into a `Vec` in wasm memory and copy it back.
//! * Each staging buffer is held until the queue reports the work that reads it done, then destroyed (WebGPU frees a buffer on
//!   `destroy`, not when its last handle is dropped), from that report itself, so a renderer that stops drawing keeps none.
//! * The bytes held that way are counted. Past [`BACKLOG`] the callers that can wait do ([`backlogged`]: the stage skips the
//!   frame, an export waits for the queue to drain); a write made anyway past [`LIMIT`] is the plain write, counted in
//!   [`StagingStats::plain`], so nothing is held without bound.
//! * A browser that cannot map a large buffer (wgpu unwraps the exception, which traps the engine) is asked first for writes of
//!   [`PROBED_FROM`] bytes or more, by allocating the same number of bytes in JavaScript; if that fails the write is the plain
//!   write. Smaller staging buffers are not probed: they fail only where any allocation does.

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Writes of at least this many bytes are staged.
pub(crate) const STAGED_FROM: usize = 64 << 10;
/// Bytes held in staging buffers past which callers that can wait do.
pub const BACKLOG: u64 = 64 << 20;
/// Bytes held in staging buffers past which a write is the plain write.
pub const LIMIT: u64 = 192 << 20;
/// Staged writes of at least this many bytes check that the browser can map them first.
const PROBED_FROM: u64 = 8 << 20;

/// A staging buffer the GPU may still read.
struct Held {
    device: wgpu::Device,
    buffer: wgpu::Buffer,
    done: Arc<AtomicBool>,
    bytes: u64,
}

struct State {
    held: RefCell<Vec<Held>>,
    bytes: Cell<u64>,
    peak: Cell<u64>,
    staged: Cell<u64>,
    plain: Cell<u64>,
    /// [`BACKLOG`] and [`LIMIT`] (a test sets smaller ones).
    backlog: Cell<u64>,
    limit: Cell<u64>,
}

impl Default for State {
    fn default() -> State {
        State { held: RefCell::default(), bytes: Cell::new(0), peak: Cell::new(0), staged: Cell::new(0), plain: Cell::new(0), backlog: Cell::new(BACKLOG), limit: Cell::new(LIMIT) }
    }
}

thread_local! {
    /// The staging buffers of the thread's renderers (the stage and its previews, or an export worker's).
    static STATE: State = State::default();
}

/// What the staging of this thread's renderers has done.
#[derive(Clone, Copy, Debug, Default)]
pub struct StagingStats {
    /// Bytes of staging buffers the GPU may still read.
    pub in_flight: u64,
    /// The most that was.
    pub peak: u64,
    /// Writes staged.
    pub staged: u64,
    /// Large writes made as the plain write: past [`LIMIT`], or with no room to map.
    pub plain: u64,
}

pub fn staging_stats() -> StagingStats {
    STATE.with(|s| StagingStats { in_flight: s.bytes.get(), peak: s.peak.get(), staged: s.staged.get(), plain: s.plain.get() })
}

/// Whether so much is staged and unfinished that a caller that can wait should (a frame is skipped, an export waits for
/// the queue to drain).
pub fn backlogged() -> bool {
    STATE.with(|s| s.bytes.get() >= s.backlog.get())
}

/// Destroys the staging buffers the GPU has finished with. Runs with every staged write and every frame, and when the queue
/// reports work done.
pub(crate) fn retire() {
    STATE.with(|s| {
        let Ok(mut held) = s.held.try_borrow_mut() else { return };
        held.retain(|h| {
            let finished = h.done.load(Ordering::Acquire);
            if finished {
                h.buffer.destroy();
                s.bytes.set(s.bytes.get() - h.bytes);
            }
            !finished
        });
    });
}

/// Destroys every staging buffer made for `device`, finished with or not: the device is going away, and a stage that
/// has stopped drawing keeps nothing.
pub fn release_staging(device: &wgpu::Device) {
    STATE.with(|s| {
        let Ok(mut held) = s.held.try_borrow_mut() else { return };
        held.retain(|h| {
            let ours = h.device == *device;
            if ours {
                h.buffer.destroy();
                s.bytes.set(s.bytes.get() - h.bytes);
            }
            !ours
        });
    });
}

/// Whether a write of `size` staged bytes may be staged now; a refusal is counted.
fn room(size: u64) -> bool {
    retire();
    let refused = STATE.with(|s| s.bytes.get() + size > s.limit.get()) || (size >= PROBED_FROM && !can_map(size));
    if refused {
        STATE.with(|s| s.plain.set(s.plain.get() + 1));
    }
    !refused
}

/// Whether the browser can allocate `size` bytes of mapped memory, judged by allocating as many in JavaScript.
#[cfg(target_arch = "wasm32")]
fn can_map(size: u64) -> bool {
    let constructor = js_sys::ArrayBuffer::new(0).constructor();
    js_sys::Reflect::construct(&constructor, &js_sys::Array::of1(&wasm_bindgen::JsValue::from_f64(size as f64))).is_ok()
}

#[cfg(not(target_arch = "wasm32"))]
fn can_map(_size: u64) -> bool {
    true
}

/// A buffer of `size` bytes (a multiple of 4) the CPU fills now, to be copied from on the GPU.
fn staging(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor { label: Some("styk staging"), size, usage: wgpu::BufferUsages::COPY_SRC, mapped_at_creation: true })
}

/// Fills `buffer`, made mapped, with the pieces `pieces` puts (an offset and bytes each), then unmaps it.
fn fill(buffer: &wgpu::Buffer, pieces: impl FnOnce(&mut dyn FnMut(usize, &[u8]))) {
    #[cfg(target_arch = "wasm32")]
    if let Some(handle) = buffer.as_webgpu()
        && let Ok(range) = handle.get_mapped_range()
    {
        // One copy, made by the browser, from the engine's memory into the mapped memory.
        let mapped = js_sys::Uint8Array::new(&range);
        // SAFETY: the view is read at once, before anything here can allocate.
        pieces(&mut |at, bytes| {
            let view = unsafe { js_sys::Uint8Array::view(bytes) };
            mapped.set(&view, at as u32);
        });
        buffer.unmap();
        return;
    }
    {
        let mut view = buffer.slice(..).get_mapped_range_mut().expect("a buffer made mapped is mapped");
        pieces(&mut |at, bytes| view.slice(at..at + bytes.len()).copy_from_slice(bytes));
    }
    buffer.unmap();
}

/// Submits `encoder`, whose copies read `source`, and holds `source` until the queue reports them done.
fn submit(device: &wgpu::Device, queue: &wgpu::Queue, encoder: wgpu::CommandEncoder, source: wgpu::Buffer, bytes: u64) {
    queue.submit([encoder.finish()]);
    let done = Arc::new(AtomicBool::new(false));
    let flag = done.clone();
    queue.on_submitted_work_done(move || {
        flag.store(true, Ordering::Release);
        retire();
    });
    STATE.with(|s| {
        s.bytes.set(s.bytes.get() + bytes);
        s.peak.set(s.peak.get().max(s.bytes.get()));
        s.staged.set(s.staged.get() + 1);
        s.held.borrow_mut().push(Held { device: device.clone(), buffer: source, done, bytes });
    });
}

/// `Queue::write_buffer`, staged when large (see the module).
pub(crate) fn write_buffer(device: &wgpu::Device, queue: &wgpu::Queue, buffer: &wgpu::Buffer, offset: u64, data: &[u8]) {
    let size = data.len().next_multiple_of(wgpu::COPY_BUFFER_ALIGNMENT as usize) as u64;
    if data.len() < STAGED_FROM || offset % wgpu::COPY_BUFFER_ALIGNMENT != 0 || offset + size > buffer.size() || !room(size) {
        queue.write_buffer(buffer, offset, data);
        return;
    }
    let source = staging(device, size);
    fill(&source, |put| put(0, data));
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk staged write") });
    encoder.copy_buffer_to_buffer(&source, 0, buffer, offset, size);
    submit(device, queue, encoder, source, size);
}

/// `Queue::write_texture` of `rows` rows of `row_bytes` bytes (`data`), staged when large (see the module).
pub(crate) fn write_texture(device: &wgpu::Device, queue: &wgpu::Queue, texture: wgpu::TexelCopyTextureInfo<'_>, data: &[u8], row_bytes: u32, rows: u32, extent: wgpu::Extent3d) {
    let stride = row_bytes.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let size = stride as u64 * rows as u64;
    if data.len() < STAGED_FROM || !room(size) {
        queue.write_texture(texture, data, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row_bytes), rows_per_image: Some(rows) }, extent);
        return;
    }
    let source = staging(device, size);
    fill(&source, |put| {
        if stride == row_bytes {
            put(0, data);
        } else {
            for (y, row) in data.chunks_exact(row_bytes as usize).enumerate() {
                put(y * stride as usize, row);
            }
        }
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk staged write") });
    encoder.copy_buffer_to_texture(
        wgpu::TexelCopyBufferInfo { buffer: &source, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride), rows_per_image: Some(rows) } },
        texture,
        extent,
    );
    submit(device, queue, encoder, source, size);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A device, or none where the machine has no adapter (these tests then pass without checking anything: they need a GPU).
    fn device() -> Option<(wgpu::Device, wgpu::Queue)> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
            eprintln!("skipped: no GPU adapter");
            return None;
        };
        Some(pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device"))
    }

    fn target(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor { label: None, size, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false })
    }

    /// A buffer to read back into (a buffer that is mapped for reading may be no more than the copy's destination).
    fn readback(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor { label: None, size, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false })
    }

    fn read(device: &wgpu::Device, queue: &wgpu::Queue, buffer: &wgpu::Buffer) -> Vec<u8> {
        let copy = readback(device, buffer.size());
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(buffer, 0, &copy, 0, buffer.size());
        queue.submit([encoder.finish()]);
        copy.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let bytes = copy.slice(..).get_mapped_range().expect("range").to_vec();
        bytes
    }

    fn pattern(len: usize, seed: u8) -> Vec<u8> {
        (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
    }

    #[test]
    fn a_large_write_is_staged_lands_at_its_offset_and_is_given_back_when_the_queue_is_done() {
        let Some((device, queue)) = device() else { return };
        let buffer = target(&device, 1 << 20);
        let small = pattern(1000, 1);
        write_buffer(&device, &queue, &buffer, 256, &small);
        assert_eq!(staging_stats().staged, 0, "a small write is the plain write");
        let large = pattern(200 << 10, 7);
        write_buffer(&device, &queue, &buffer, 4096, &large);
        let stats = staging_stats();
        assert_eq!((stats.staged, stats.in_flight), (1, large.len() as u64), "one staged write, its bytes held until the queue is done");
        let read = read(&device, &queue, &buffer);
        assert_eq!(&read[256..256 + small.len()], &small[..]);
        assert_eq!(&read[4096..4096 + large.len()], &large[..]);
        let stats = staging_stats();
        assert_eq!((stats.in_flight, stats.peak), (0, large.len() as u64), "the queue's report gave the staging buffer back");
    }

    #[test]
    fn staged_rows_are_padded_for_the_copy_and_land_row_for_row() {
        let Some((device, queue)) = device() else { return };
        let (width, height) = (301u32, 300u32);
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let pixels = pattern((width * height * 4) as usize, 3);
        assert!(pixels.len() >= STAGED_FROM);
        write_texture(&device, &queue, texture.as_image_copy(), &pixels, width * 4, height, wgpu::Extent3d { width, height, depth_or_array_layers: 1 });
        assert_eq!(staging_stats().staged, 1);
        let stride = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let back = readback(&device, stride as u64 * height as u64);
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &back, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride), rows_per_image: Some(height) } },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        queue.submit([encoder.finish()]);
        back.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let mapped = back.slice(..).get_mapped_range().expect("range");
        for row in 0..height as usize {
            assert_eq!(&mapped[row * stride as usize..row * stride as usize + width as usize * 4], &pixels[row * width as usize * 4..(row + 1) * width as usize * 4], "row {row}");
        }
    }

    #[test]
    fn what_is_held_is_bounded_and_released_with_its_device() {
        let Some((device, queue)) = device() else { return };
        STATE.with(|s| {
            s.backlog.set(300 << 10);
            s.limit.set(500 << 10);
        });
        let buffer = target(&device, 1 << 20);
        let data = pattern(200 << 10, 5);
        write_buffer(&device, &queue, &buffer, 0, &data);
        assert!(!backlogged(), "200 KiB held is under the backlog");
        write_buffer(&device, &queue, &buffer, 0, &data);
        assert!(backlogged(), "400 KiB held is a backlog: a caller that can wait does");
        write_buffer(&device, &queue, &buffer, 0, &data);
        let stats = staging_stats();
        assert_eq!((stats.staged, stats.plain), (2, 1), "past the limit the write is the plain write: nothing more is held");
        assert!(stats.in_flight <= 500 << 10);
        release_staging(&device);
        let stats = staging_stats();
        assert_eq!(stats.in_flight, 0, "a device's staging buffers are given back at once");
        assert!(!backlogged());
        // The queue's later report finds nothing left to give back.
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        assert_eq!(staging_stats().in_flight, 0);
    }
}

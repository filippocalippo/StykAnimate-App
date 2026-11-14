//! How long creating the effect pipelines takes, family by family: what the first frame that draws an effect waits for. On
//! WebGL2 the browser compiles each pipeline on the interface thread (ANGLE translates it to HLSL and compiles it with FXC on
//! Windows), so a slow shader is a frozen interface. A measurement, not a check: it prints and asserts nothing about time.
//!
//!   WGPU_BACKEND=dx12 WGPU_DX12_COMPILER=fxc cargo test --release -p styk-render --test effect_compile_bench -- --ignored --nocapture
//!
//! (DX12 with FXC compiles the HLSL naga writes, which is close to what ANGLE's D3D11 backend compiles.)

use std::sync::Arc;
use std::time::Instant;

use styk_eval::vfx::registry::*;
use styk_eval::vfx::{Color, Effect};
use styk_render::effects::executor::Executor;
use styk_render::effects::recipe::{record, Frame};
use styk_render::wgpu;

fn effect(params: Params) -> Arc<Effect> {
    Arc::new(Effect { id: Arc::from("e"), enabled: true, params })
}

#[test]
#[ignore = "a measurement: run with --ignored --nocapture"]
fn effect_pipelines_compile() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
        eprintln!("skipped: no GPU adapter");
        return;
    };
    eprintln!("{:?} {}", adapter.get_info().backend, adapter.get_info().name);
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_limits: adapter.limits(), ..Default::default() })).expect("device");
    let cases: Vec<(&str, Vec<Arc<Effect>>)> = vec![
        ("tint", vec![effect(Params::Tint(Tint { color: Color::Rgb(0xff0000), ..Default::default() }))]),
        ("blur 4", vec![effect(Params::Blur(Blur { radius: 4.0, ..Default::default() }))]),
        ("blur 60", vec![effect(Params::Blur(Blur { radius: 60.0, ..Default::default() }))]),
        ("directional blur", vec![effect(Params::Blur(Blur { radius: 30.0, mode: BlurMode::Directional, ..Default::default() }))]),
        ("glow", vec![effect(Params::Glow(Glow::default()))]),
        ("glow with spread", vec![effect(Params::Glow(Glow { spread: 6.0, ..Default::default() }))]),
        ("shadow", vec![effect(Params::Shadow(Shadow::default()))]),
        ("outline", vec![effect(Params::Outline(Outline::default()))]),
        ("outline square", vec![effect(Params::Outline(Outline { rounded: false, ..Default::default() }))]),
        ("outline centred", vec![effect(Params::Outline(Outline { mode: OutlinePlacement::Center, ..Default::default() }))]),
        ("pixelate", vec![effect(Params::Pixelate(Pixelate::default()))]),
        ("noise", vec![effect(Params::Noise(Noise::default()))]),
        ("bloom", vec![effect(Params::Bloom(Bloom::default()))]),
        ("wave", vec![effect(Params::Wave(Wave::default()))]),
        ("turbulence", vec![effect(Params::Turbulence(Turbulence::default()))]),
        ("grade", vec![effect(Params::Grade(Grade { contrast: 1.2, ..Default::default() }))]),
    ];
    // One executor for the whole run, as the stage has: a case pays only for the pipelines the cases before it did not create.
    let mut executor = Executor::new(&device);
    let started = Instant::now();
    for (name, stack) in &cases {
        let mut records = Vec::new();
        let run = record(&mut records, stack, Frame { scale: 1.0, origin: [0.0; 2], output_size: [200.0, 200.0] }, [256, 256]);
        let before = executor.stats.pipelines;
        let at = Instant::now();
        executor.prepare(&device, &queue, records, &[&run]);
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        eprintln!("{name:>20}: {:>7.1} ms, {} new pipelines", at.elapsed().as_secs_f64() * 1000.0, executor.stats.pipelines - before);
    }
    eprintln!("{:>20}: {:>7.1} ms, {} pipelines", "all", started.elapsed().as_secs_f64() * 1000.0, executor.stats.pipelines);
}

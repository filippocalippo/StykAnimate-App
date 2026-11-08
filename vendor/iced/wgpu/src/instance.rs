//! Optional host GPU policy, installed before any compositor is created.
//! The host owns backend/compiler preference; iced still negotiates its surface,
//! feature set and limits. No engine dependency enters the toolkit.
use std::sync::OnceLock;

pub type Policy = fn() -> Vec<wgpu::InstanceDescriptor>;
static POLICY: OnceLock<Policy> = OnceLock::new();

/// Install once at startup; reads never initialise or block on a worker.
pub fn install(policy: Policy) -> Result<(), Policy> {
    POLICY.set(policy)
}

pub(crate) fn descriptors(default: wgpu::InstanceDescriptor) -> Vec<wgpu::InstanceDescriptor> {
    POLICY
        .get()
        .map_or_else(|| vec![default], |policy| policy())
}

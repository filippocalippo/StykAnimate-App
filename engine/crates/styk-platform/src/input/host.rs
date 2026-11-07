//! The input source the developer tools use, for this target.

use std::sync::Arc;
use styk_services::input::InputHost;

/// The input host of this target: on Windows the `WM_POINTER` source and the performance counter; on a target with no source yet,
/// a host that says so when asked to attach (the trait is ready for one).
pub fn host() -> Arc<dyn InputHost> {
    #[cfg(windows)]
    {
        Arc::new(crate::input::windows::pointer::WindowsInputHost)
    }
    #[cfg(not(windows))]
    {
        Arc::new(unsupported::NoInputHost)
    }
}

#[cfg(not(windows))]
mod unsupported {
    use raw_window_handle::HasWindowHandle;
    use std::sync::Arc;
    use styk_services::input::{AttachedInput, InputHost, InputQueue};
    use styk_services::Clock;
    use crate::clock::SystemClock;

    pub struct NoInputHost;

    impl InputHost for NoInputHost {
        fn clock(&self) -> Arc<dyn Clock> {
            Arc::new(SystemClock::new())
        }

        fn attach(&self, _: &dyn HasWindowHandle, _: InputQueue) -> Result<AttachedInput, String> {
            Err("this target has no pen input source yet".into())
        }
    }
}

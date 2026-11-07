#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::let_underscore_must_use, unused_must_use, clippy::disallowed_methods, clippy::disallowed_types))]
//! Native-only diagnostic workloads, separate from interface views.
pub mod pen_lab { mod report; pub mod self_test; }

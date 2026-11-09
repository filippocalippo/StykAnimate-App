//! Area 2: project files, the project library, the library store, recent files, preferences, recovery and the
//! user-data migration. Each `desktop/*.cjs` module of that area becomes one module here; their commands are added
//! below with `desktop.commands(crate::commands![...])`.

use crate::Desktop;

pub fn register(_desktop: &mut Desktop) {}

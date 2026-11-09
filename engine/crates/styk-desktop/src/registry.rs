//! How the areas add their commands, state and start-up work to the one Tauri builder.
//!
//! Tauri takes a single invoke handler, so each area hands its commands over as a [`Commands`] set (made with
//! [`commands!`](crate::commands)) and [`Desktop::run`] joins them: a call goes to the set that names it. The page
//! can reach a command only when `capabilities/main.json` allows it (build.rs declares exactly those).

use std::collections::BTreeSet;

use tauri::ipc::Invoke;
use tauri::{App, Builder, Wry};

type Handler = Box<dyn Fn(Invoke<Wry>) -> bool + Send + Sync + 'static>;
type Setup = Box<dyn FnOnce(&mut App<Wry>) -> Result<(), Box<dyn std::error::Error>> + Send>;

/// One area's commands: their names, and the handler `tauri::generate_handler!` made for them.
pub struct Commands {
    names: Vec<&'static str>,
    handler: Handler,
}

impl Commands {
    /// Used by [`commands!`](crate::commands); `names` are the commands' function paths as written.
    pub fn new(names: &[&'static str], handler: impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static) -> Self {
        let names = names.iter().map(|&path| path.rsplit("::").next().unwrap_or(path).trim()).collect();
        Self { names, handler: Box::new(handler) }
    }
    pub fn names(&self) -> &[&'static str] {
        &self.names
    }
}

/// The commands of one area, by function name: `commands![update_state, window::window_state]`.
#[macro_export]
macro_rules! commands {
    ($($command:path),* $(,)?) => {
        $crate::registry::Commands::new(&[$(stringify!($command)),*], ::tauri::generate_handler![$($command),*])
    };
}

/// The app being put together: the Tauri builder, every area's commands and the work each area does at start.
pub struct Desktop {
    builder: Option<Builder<Wry>>,
    commands: Vec<Commands>,
    setups: Vec<Setup>,
    after: Vec<Setup>,
}

impl Default for Desktop {
    fn default() -> Self {
        Self::new()
    }
}

impl Desktop {
    pub fn new() -> Self {
        Self { builder: Some(Builder::default()), commands: Vec::new(), setups: Vec::new(), after: Vec::new() }
    }

    /// Work done after every area's [`setup`](Self::setup): opening the window.
    pub fn after_setup(
        &mut self,
        setup: impl FnOnce(&mut App<Wry>) -> Result<(), Box<dyn std::error::Error>> + Send + 'static,
    ) -> &mut Self {
        self.after.push(Box::new(setup));
        self
    }

    /// Adds an area's commands. A name may belong to one area only.
    pub fn commands(&mut self, commands: Commands) -> &mut Self {
        for name in commands.names() {
            assert!(!self.command_names().contains(name), "the command {name} is registered twice");
        }
        self.commands.push(commands);
        self
    }

    /// Changes the Tauri builder: plugins, managed state, window events.
    pub fn builder(&mut self, change: impl FnOnce(Builder<Wry>) -> Builder<Wry>) -> &mut Self {
        let builder = self.builder.take().expect("builder");
        self.builder = Some(change(builder));
        self
    }

    /// Work done once the app exists, before the window opens, in the order the areas registered it.
    pub fn setup(
        &mut self,
        setup: impl FnOnce(&mut App<Wry>) -> Result<(), Box<dyn std::error::Error>> + Send + 'static,
    ) -> &mut Self {
        self.setups.push(Box::new(setup));
        self
    }

    /// Every registered command's name.
    pub fn command_names(&self) -> BTreeSet<&'static str> {
        self.commands.iter().flat_map(|set| set.names().iter().copied()).collect()
    }

    /// Joins the commands into Tauri's single handler, and runs the app.
    pub fn run(mut self) {
        let sets = std::mem::take(&mut self.commands);
        let mut setups = std::mem::take(&mut self.setups);
        setups.append(&mut self.after);
        let builder = self.builder.take().expect("builder");
        let app = builder
            .invoke_handler(move |invoke| {
                let name = invoke.message.command().to_owned();
                match sets.iter().find(|set| set.names.contains(&name.as_str())) {
                    Some(set) => (set.handler)(invoke),
                    None => {
                        invoke.resolver.reject(format!("Unknown command: {name}"));
                        true
                    }
                }
            })
            .setup(move |app| {
                for setup in setups {
                    setup(app)?;
                }
                Ok(())
            })
            .build(tauri::generate_context!())
            .unwrap_or_else(|error| crate::shell::fatal("StykAnimate could not start", &error.to_string()));
        app.run(crate::shell::on_run_event);
    }
}

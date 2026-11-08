# Interface implementation patterns

## Catalogue screenshot loop

Use the developer-only `styk-screens` binary for catalogue iterations:

```sh
cargo build --locked --manifest-path engine/Cargo.toml -p styk-screens
STYK_BACKGROUND_WINDOW=1 engine/target/debug/styk-screens --screen band --size 1560x900 --scale 1 --screenshot artifacts/band.png
```

Run builds and captures through the machine queue. Build this package in its own Cargo
invocation: building it together with the app unifies the core's engine feature and loses
the cheaper graph. The preview always runs headless, even without an environment override.

The catalogue, fixture models, fonts, widgets and headless renderer are shared with
`stykanimate --screen`. The renderer lives in `styk-ui::headless`; hosts inject the platform's
font smoothing, redraw timestamp and asynchronous retry timer. The retry limit is unchanged.
The catalogue currently holds the component sheet and four band states. None needs an engine
document: tab identities and the shell layout are core model types. New document-derived
screens must commit their prepared view models beside the catalogue and use them in both hosts.

The core's default `engine` feature retains the application behaviour. Turning it off exposes
only portable controls, focus, launch parsing, document identities and shell models. The design
system does not enable the engine. The UI keeps its engine-backed pen lab behind its default
`engine` feature; catalogue-only hosts turn that off. Application hosts and document tests
keep the defaults.

Before reporting a chunk done, run `cargo xtask check`: it still checks references through the
real app, then renders every catalogue entry through both binaries and rejects any PNG byte
difference. Both use the same deterministic PNG encoder, so byte identity proves pixel identity.
Missing captures, render failures and timeouts fail; references and thresholds are never changed.
The same gate checks the separately resolved preview dependency graph. Shipping graph and symbol
guards reject `styk-screens`; no production package may depend on it.

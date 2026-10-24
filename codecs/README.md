# Python Pivot codecs (development test oracle)

These are the application's original Python codec modules, copied without algorithm changes from the sibling `tools` directory and `StykAnimate/tools/codec_bridge.py`. With `backend/` they are the oracle the Rust codec (`engine/crates/styk-piv`) is checked against: `engine/tools/piv/parity.sh` records their answers and replays them against the Rust codec, and the Python unit tests in `backend/` exercise them.

The app does not run or ship them: every build runs the Rust codec compiled to WebAssembly ([Pivot files and the codec service](../docs/engine/formats-piv.md)). A codec change is made in `styk-piv`; change these files only to keep the oracle's recorded answers meaningful. Do not publish this directory as a GitHub release attachment.

The Pivot format support was reverse-engineered for interoperability; StykAnimate is not affiliated with Pivot Animator.

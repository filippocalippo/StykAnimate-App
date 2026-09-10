# Desktop codecs

These are the application's existing Python codec modules, copied without algorithm changes from the sibling `tools` directory and `StykAnimate/tools/codec_bridge.py`. They now live in the private app repository so release builds work from a clean checkout. Development, PyInstaller and electron-builder all use this copy.

Update these files when changing a codec. Rebuild the sidecar before packaging. Do not publish this directory as a GitHub release attachment.

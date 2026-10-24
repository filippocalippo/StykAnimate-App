# Third-party notices

StykAnimate is licensed under the GNU GPL, version 3 or later (see [LICENSE](LICENSE)). It includes or distributes the following third-party components under their own licenses. Each license text is kept next to the component.

## Included in this repository

| Component | Use | License | License text |
| --- | --- | --- | --- |
| [resvg](https://github.com/RazrFalcon/resvg) (WebAssembly build) | Rendering SVG to images | MPL-2.0 | [vendor/resvg/LICENSE](vendor/resvg/LICENSE), [NOTICE](vendor/resvg/NOTICE.md) |
| [opentype.js](https://github.com/opentypejs/opentype.js) | Font outlines for text | MIT | [vendor/text/opentype.LICENSE](vendor/text/opentype.LICENSE) |
| [Noto Sans](https://fonts.google.com/noto) | Default text font | SIL OFL 1.1 | [vendor/text/OFL.txt](vendor/text/OFL.txt) |
| [Zstandard](https://github.com/facebook/zstd) (compiled into the engine's WebAssembly modules through the [zstd](https://github.com/gyscos/zstd-rs) crate, MIT) | Compressed project sections | BSD-3-Clause | [engine/licenses/zstd.LICENSE](engine/licenses/zstd.LICENSE) |
| [Inter and Inter Tight](https://rsms.me/inter/) | Interface fonts and the logo wordmark | SIL OFL 1.1 | [assets/fonts/OFL-Inter.txt](assets/fonts/OFL-Inter.txt), [assets/fonts/OFL-InterTight.txt](assets/fonts/OFL-InterTight.txt), [assets/brand/Inter-LICENSE.txt](assets/brand/Inter-LICENSE.txt) |
| [sticknodes-rs](https://github.com/vinceTheProgrammer/sticknodes-rs) | Adapted Stick Nodes format-reading logic | MIT | [src/sticknodes/decoder/THIRD_PARTY_NOTICES.md](src/sticknodes/decoder/THIRD_PARTY_NOTICES.md) |

## Bundled in desktop releases

| Component | Use | License | License text |
| --- | --- | --- | --- |
| [FFmpeg](https://ffmpeg.org) (via imageio-ffmpeg) | Video encoding, run as a separate program | GPL-3.0 | [scripts/licenses/ffmpeg/COPYING.GPLv3](scripts/licenses/ffmpeg/COPYING.GPLv3) |
| [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg) | Supplies the FFmpeg binary | BSD-2-Clause | [scripts/licenses/ffmpeg/IMAGEIO-FFMPEG-LICENSE.txt](scripts/licenses/ffmpeg/IMAGEIO-FFMPEG-LICENSE.txt) |
| [Electron](https://www.electronjs.org) and Chromium | Desktop runtime | MIT and Chromium's licenses | Shipped as `LICENSE.electron.txt` and `LICENSES.chromium.html` in every desktop build |
| Python and the packages in [`backend/requirements-fast.txt`](backend/requirements-fast.txt) | The local codec service, packaged with PyInstaller | PSF and each package's license | Included in the packaged codec service |

npm dependencies are listed with their licenses in [package-lock.json](package-lock.json).

## Compatibility

Pivot Animator and Stick Nodes are the property of their respective owners. StykAnimate reads and writes their file formats for interoperability and is not affiliated with or endorsed by them.

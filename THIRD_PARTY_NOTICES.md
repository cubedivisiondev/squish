# Third-Party Notices

SQUISH is MIT-licensed (see [LICENSE](LICENSE)). It relies on the third-party
software and fonts listed below. Each is the property of its respective authors
and is used under its own license. This file is provided for attribution and
compliance.

Components are split into two groups:

- **Bundled** - Shipped inside this repository.
- **Runtime** - Fetched from a public CDN when a feature needs it, and **not**
  redistributed in this repository. Listed for transparency and attribution.

---

## Bundled

### Fonts

All three typefaces are licensed under the **SIL Open Font License, Version 1.1**.
The full license text for each is included alongside the font files in
[`fonts/`](fonts/).

| Font | Role | Copyright | License |
| --- | --- | --- | --- |
| **Jost** | Headings / wordmark | Copyright 2020 The Jost Project Authors (https://github.com/indestructible-type/Jost) | OFL-1.1, `fonts/OFL-Jost.txt` |
| **Manrope** | Body text | Copyright 2018 The Manrope Project Authors (https://github.com/sharanda/manrope) | OFL-1.1, `fonts/OFL-Manrope.txt` |
| **Space Mono** | Monospace / UI | Copyright 2016 The Space Mono Project Authors (https://github.com/googlefonts/spacemono) | OFL-1.1, `fonts/OFL-SpaceMono.txt` |

The `.woff2` files were generated from the upstream OFL sources (distributed via
[Fontsource](https://fontsource.org)). Under the OFL, the Reserved Font Names
(Jost, Manrope, Space Mono) may not be used to promote or distribute modified
versions.

### ffmpeg.wasm - JavaScript API (`vendor/ffmpeg/`)

The small UMD build of the `@ffmpeg/ffmpeg` and `@ffmpeg/util` packages (the
JavaScript API and worker that drive the WebAssembly core) is vendored so the
in-page Worker can be constructed same-origin.

- **Project:** ffmpeg.wasm (https://github.com/ffmpegwasm/ffmpeg.wasm)
- **Copyright:** Copyright (c) 2019 Jerome Wu and contributors
- **License:** MIT

---

## Runtime (loaded from CDN, not redistributed here)

These are fetched on demand from `cdn.jsdelivr.net` the first time a given
feature is used, and are never bundled into this repository.

| Component | Used for | License | Source |
| --- | --- | --- | --- |
| **@ffmpeg/core** `0.12.10` (FFmpeg, compiled to WebAssembly) | Video & audio transcoding | FFmpeg is licensed under the LGPL-2.1-or-later, with some components under the GPL | https://github.com/ffmpegwasm/ffmpeg.wasm |
| **gifsicle-wasm-browser** (gifsicle) | GIF optimization | GPL-2.0 | https://github.com/renzhezhilu/gifsicle-wasm-browser |
| **pdfjs-dist** `3.11.174` (PDF.js) | Rendering PDF pages | Apache-2.0, Copyright Mozilla Foundation | https://github.com/mozilla/pdf.js |
| **pdf-lib** `1.17.1` | Building/embedding PDFs | MIT | https://github.com/Hopding/pdf-lib |

Because these are loaded at runtime and not distributed with this source, their
licenses impose no obligations on this repository. They are documented here for
completeness and to credit their authors. If you self-host these assets instead
of using the CDN, review each project's license for the terms that apply to
redistribution.

---

## Full license texts

- MIT (this project): [`LICENSE`](LICENSE)
- SIL Open Font License 1.1: `fonts/OFL-Jost.txt`, `fonts/OFL-Manrope.txt`,
  `fonts/OFL-SpaceMono.txt`
- Apache-2.0, GPL-2.0, and LGPL-2.1 full texts are available from the linked
  upstream projects.

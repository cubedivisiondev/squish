# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-08

Initial public release.

### Added

- Exact-size compression for **images** (JPG, PNG, WEBP, BMP), **GIF**,
  **video** (MP4, MOV, MKV, AVI, WEBM, and more), **audio** (MP3, M4A, WAV,
  FLAC, and more), **PDF**, and **SVG**, with a never-over-target guarantee.
- Format conversion within each family, including **GIF ↔ video** and
  **PDF ↔ image**.
- **MAX QUALITY** mode for best-fidelity conversion without a size target.
- A probe → model → predict → verify engine that measures real encodes rather
  than estimating, landing as close under the target as possible.
- Fully **client-side** processing (Canvas + WebAssembly); **nothing is
  uploaded**.
- Installable, **offline-capable PWA** with a service worker and web manifest.
- Accessible UI: keyboard operation, screen-reader labels, a semantic progress
  bar, and live status announcements.

[1.0.0]: https://github.com/cubedivisiondev/squish/releases/tag/v1.0.0

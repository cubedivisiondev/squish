# Security Policy

## Reporting a vulnerability

Report privately. Do not open a public issue for a security report - A public issue tells everyone about the flaw before there is a fix.

Send the report to **security@puddystudios.com** or **hello@puddystudios.com**, or open a private advisory through GitHub at https://github.com/cubedivisiondev/squish/security/advisories/new.

Include what you need to make the problem real to us:

- What the issue is and what an attacker could do with it.
- Steps to reproduce, or a working proof of concept.
- The affected version, browser, and platform.

We acknowledge the report, investigate, and keep you informed through the fix and disclosure. Coordinated disclosure is welcome, and reporters who want to be named will be credited.

## Threat model

SQUISH runs entirely in the browser. There is no backend, no accounts, and no server-side storage. Files are read locally and processed on the device with the Canvas API and WebAssembly, and they never leave it. That absence is the whole defense. There is no server to breach, no database to leak, no session to hijack.

What remains worth scrutiny lives on the device and at the edge of it:

- Parsing of untrusted input files. Image, PDF, and media decoding is where malformed bytes meet code.
- The service-worker cache and its update behavior, which control what runs offline after the first load.
- The integrity and provenance of the WebAssembly codecs loaded from a CDN.
- Any path that could move a user's file data off the device. There should be none. A report that proves otherwise is the most valuable kind you can send.

## Supported versions

This project is maintained on a best-effort basis. Security fixes land on the `main` branch, which is the latest released version.

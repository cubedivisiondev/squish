# Contributing to SQUISH

SQUISH is a browser-only compressor. Drop a file, name a target size, get back the highest-quality file that fits at or under it. Everything runs on the device, with no server and no build step. A contribution earns its place by keeping those things true.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Three principles that do not bend

Every change is measured against these first. A change that breaks one of them does not ship, however clever it is otherwise.

1. **The output is never over the target.** A "to a size" result is always at or under the number the user asked for. Every engine measures real bytes and honors this. If a target sits below a format's floor, report the smallest size you can actually reach and offer a one-tap larger target. Never overshoot, and never estimate a size you did not measure.
2. **Nothing is uploaded.** SQUISH is one hundred percent client-side. Files are read locally and processed with the Canvas API and WebAssembly in the browser. Do not add a backend, a tracker, an analytics beacon, or any network call that moves user data off the device. The only network requests are the lazy-loaded codec bundles.
3. **Zero build step.** SQUISH is static HTML, CSS, and JavaScript. No framework, no bundler, no transpile. It has to drop onto any static host and run. The heavy codecs are lazy-loaded WebAssembly, pulled only when a matching file is used.

## Run it locally

There is nothing to install. Serve the folder over HTTP and open the printed URL. WebAssembly and the service worker require an `http(s)://` origin, so `file://` will not work.

```bash
git clone https://github.com/cubedivisiondev/squish.git
cd squish
python3 -m http.server 5173   # or:  npx serve .
```

Edit a file, hard-refresh, and the change is live. The service worker precaches the shell, so when you test offline behavior use an incognito window or turn on "Update on reload" in DevTools under Application. If a change touches a precached asset, bump `VERSION` in `sw.js` so clients pick it up.

## Propose a change

1. **Open an issue first** for anything non-trivial, so the approach is agreed before you invest the time.
2. Fork the repo and branch: `git checkout -b fix/short-description`.
3. Keep it focused. One logical change per pull request.
4. Match the surrounding style (below).
5. **Test in a real browser.** There is no unit-test harness. Exercise the paths you touched across a few real files, confirm every output lands at or under target, and write down what you tested in the PR.
6. Run `node --check app.js && node --check sw.js` before you push. Syntax errors have nowhere to hide in a zero-build project.
7. Fill out the pull request template, describe what changed and why, link the issue, and keep the diff reviewable. Large mechanical rewrites belong in their own PR.

## Style

- **Copy.** Hyphens only, never em-dashes. Capitalize the first word after a " - " separator. Status and error copy states the fact plainly and does not apologize.
- **JavaScript.** Small focused functions, descriptive names, two-space indentation. Comment the why, not the what, especially around the WebAssembly quirks where the reason is rarely obvious from the code.
- **Accessibility.** Controls stay keyboard-operable and labeled. Progress and status are announced to assistive tech through the semantic progress bar and live regions. Never let a `display` rule override the `hidden` attribute.

## Where to file things

- **Bugs and features** go through the [issue templates](https://github.com/cubedivisiondev/squish/issues/new/choose).
- **Anything security-related** follows [SECURITY.md](SECURITY.md). Do not open a public issue for a vulnerability.

SQUISH is a Puddy Studios tool, MIT licensed, (c) 2026 PUDDY Inc. The code is yours to build on. The care that keeps it fast, private, and honest about a byte count is what makes it worth contributing to.

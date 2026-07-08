## Summary

<!-- What does this change and why? Link the issue it addresses (e.g. "Closes #12"). -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / cleanup
- [ ] Other:

## How was this tested?

<!-- There is no unit-test harness. Describe the real files, formats, and targets
     you verified by hand, and the browser(s) you tested in. -->

## Checklist

- [ ] Output still lands **at or under** the target (never-over-target guarantee holds).
- [ ] No data leaves the device (still 100% client-side, no new tracking/analytics).
- [ ] No build step introduced; it's still plain HTML/CSS/JS.
- [ ] `npm run check` passes (`node --check app.js && node --check sw.js`).
- [ ] Bumped `sw.js` `VERSION` if a precached shell asset changed.
- [ ] User-facing copy uses hyphens (no em-dashes) and follows the existing style.

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/jhw1106/fast-sitegen/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/jhw1106/fast-sitegen/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# fast-sitegen

A faster drop-in for makefun-site 1.0.0, written for
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
on make.fun.

`solve.js` exports `run(input)`, which returns exactly the answer
makefun-site 1.0.0 returns for one site: the output tree as a JSON object
of every path it writes and that file's text, byte for byte. `main.ts` is
the driver the harness runs: it reads every case from `/input/cases.json`,
answers each with `run`, and writes `/output/answers.json`.

How it gets faster than the reference:

- Markdown is rendered in a single pass that writes HTML straight out —
  no token objects, no second walk. Inline text is scanned once, and plain
  runs are escaped whole instead of one character at a time.
- Templates are compiled to plain functions (one per template, per case),
  so a render is direct string building and real `for` loops; a loop reuses
  one scope frame and one loop object instead of allocating one per element.
- Slugs take an ASCII fast path (NFKD is the identity there), with a
  per-case cache per distinct text; link targets are resolved once per
  (directory, target) instead of once per link.
- Nothing is cached from one case to the next, and a build reads no clock,
  environment, randomness or file.

## Layout

- `solve.js` — the whole generator, dependency-free ES module.
- `main.ts` — the harness driver.
- `LICENSE` — MIT.

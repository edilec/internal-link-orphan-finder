# Changelog

All notable changes to this project are recorded here. Rule ids are part of the public contract:
renaming one is a breaking change and is recorded as such.

## Unreleased

### Added

- Breadth-first internal-link reachability over an explicit page inventory, from entry pages taken
  from the capture's `roots` or from `--entry`. A visited set means cyclic sites terminate.
- A reason on every page result: the actual hop-by-hop path for a reachable page, the absence of an
  incoming link for an orphan, and the incoming pages plus disconnected group for an unreachable
  one.
- Weakly connected grouping of the pages no entry page reaches, with group ids derived from the
  lowest-sorted member so they are stable without a counter.
- `link-target-unknown` and `link-source-unknown`: a link endpoint the capture does not inventory is
  reported unknown — neither broken nor orphaned — and forces an `incomplete` report.
- Sharded captures through `include`, confined to a capture root by real path after symlink
  resolution, with a lexical pre-check, a cycle-safe visited set and bounded nesting.
- Strict UTF-8 decoding of every capture document; a decode failure is the finding, and encoding
  validity is never inferred from decoded text.
- CLI with `--help`, `--json`, `--capture`, `--root`, `--entry` and a flag for each of the seven
  documented limits.
- `docs/reachability-rules.md`: capture format, rule catalog with severity and incomplete columns,
  limits, determinism and exit codes.
- Examples for each outcome: `site-clean.json` (pass), `site-orphan.json` (fail),
  `site-broken.json` (incomplete).

### Fixed

- The human-readable report prints exactly one line per finding. A page id or a capture file name
  holding a newline used to print extra lines that no finding stood behind, so a log scraper
  counting `^ERROR` saw more errors than the run reported. Capture-derived text is flattened
  before it is printed; the JSON report was never affected.

### Notes

- Severity comes from one frozen `ruleId -> severity` table; an unknown rule id throws.
- The rules that force `status: "incomplete"` are declared as data and every one of them has a test
  that fails if it is removed from the list.
- `status: "pass"` with `checked: 0` is impossible: the one place that decides status emits
  `empty-inventory` instead.
- Ordering is pinned by tests that fail when the comparator, the page sort or either group sort is
  removed: the fixtures use ids where code-unit order and locale order genuinely disagree, declared
  out of order, so `localeCompare` cannot be substituted unnoticed.
- The guard that refuses a non-regular capture file is defended by a named pipe, which blocks
  forever without it; a directory cannot stand in for that test, because reading one fails anyway.

No release has been published.

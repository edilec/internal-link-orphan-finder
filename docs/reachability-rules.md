# Reachability rules, capture format, limits and determinism

This document is the reference for what `internal-link-orphan-finder` computes, what each rule
means, and what the tool refuses to claim. Rule ids are stable: renaming one is a breaking change
and is recorded in the changelog.

## The capture format

The tool reads a **capture**: a JSON document holding the page inventory a crawl produced plus the
internal links extracted from those pages. It never fetches anything, so the capture is the whole
of its evidence.

```json
{
  "schemaVersion": "1",
  "site": "optional label",
  "roots": ["/"],
  "include": ["links/blog.json"],
  "pages": [
    { "id": "/", "title": "Home", "note": "optional free text" }
  ],
  "links": [
    { "from": "/", "to": "/about", "kind": "nav", "label": "About" }
  ]
}
```

| Key | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | string | Must be `"1"`. |
| `site` | string, optional | A label. Never interpreted. |
| `roots` | string array, optional | Entry page ids the search starts from. `--entry` replaces this list when given. |
| `include` | string array, optional | Relative POSIX paths to further capture documents, merged into this one. |
| `pages` | array, optional | The inventory. Each entry is `{ id, title?, note? }`. |
| `links` | array, optional | Extracted links. Each entry is `{ from, to, kind?, label? }`. |

A page `id` is an **opaque string** compared exactly. The tool does not normalise URLs, resolve
relative references, strip query strings, collapse trailing slashes or fold case; `/a` and `/a/`
are two different pages. Whatever normalisation your crawler applies is the normalisation that
holds.

**Unknown keys are rejected.** A document, page entry or link entry carrying a key that is not in
the tables above produces `capture-invalid` and the document is not merged. A one-character typo
that silently disabled a field would turn a real failure into a green run, so it is refused
instead.

**The first violation stops that document.** A capture is machine-produced: a partially understood
one is evidence the tool does not have, so it is refused rather than half-used.

### Sharded captures

`include` lets a crawler write its links in several files. Each entry is resolved against the
**capture root** — the directory given by `--root`, defaulting to the directory holding the capture
file. Resolution is confined twice:

1. lexically, before anything is touched: no absolute path, no `..` segment, no empty segment, no
   backslash separator, no drive prefix, no NUL;
2. by **real path**: the candidate is resolved through every symlink with `realpath`, and the
   result must still be inside the real capture root.

The second check is the guarantee. Rejecting `../` alone is not confinement — a symlink planted
inside the root points wherever it likes — so a shard that resolves outside the root is refused
and its contents never enter the report.

A shard included twice is read once (`duplicate-include`). Include cycles therefore terminate.

## The three states, and the one that is not a state

For every page in the inventory the report carries a result with a **reason**:

| State | Meaning | Reason carried |
| --- | --- | --- |
| `reachable` | A path of internal links leads here from an entry page. | The actual path: `["/", "/docs", "/docs/api"]`, plus its depth and origin. |
| `orphan` | No page in the inventory links here. | That no incoming link exists, plus how many links arrive from sources outside the inventory. |
| `unreachable` | Pages link here, but none of them is reachable either. | The incoming pages (bounded by `maxListed`) and the group they belong to. |

A **link target that is not in the inventory is none of these**. It is *unknown*: the crawl simply
did not cover it. It is not broken — the tool never requested it — and it is not an orphan, because
nothing is known about what links to it. Conflating those is the classic false positive of this
category of tool, so the target is reported as `link-target-unknown` and no page result is invented
for it.

An unknown target or source also means the reachability answer for the *rest* of the inventory is
not fully supported: a page reported as an orphan might be linked from a page the crawl never
visited. That is why both rules force `status: "incomplete"` and exit 2 rather than a pass.

### Reachability

Breadth-first from the entry pages, over links whose **both** endpoints are inventory pages:

- entry pages are visited first, in code-unit order;
- each page's outgoing targets are visited in code-unit order;
- a visited set means a cycle is walked once, so cyclic sites terminate;
- the path recorded is the shortest one BFS found, and it is the path reported as the reason.

A **self link** (`from` equal to `to`) never makes a page reachable and is not counted as an
incoming link, so a page whose only inbound link is its own is an orphan.

### Disconnected groups

Among the pages no entry page reaches, weakly connected components are computed over the same
edges, ignoring direction. A component of two or more pages is reported as `disconnected-group`;
its id is the lowest-sorted member id, so group ids are stable without a counter. A component of
one page is an orphan, not a group.

## Rule catalog

`Incomplete` says whether the rule forces `status: "incomplete"` (and exit code 2) on its own.

| Rule | Severity | Incomplete | Meaning |
| --- | --- | --- | --- |
| `capture-invalid` | error | yes | A capture document is not JSON, not an object, carries the wrong `schemaVersion`, or holds an unrecognised or mistyped field. |
| `capture-undecodable` | error | yes | A capture document is not valid UTF-8. The decoder decides this; it is never inferred from decoded text. |
| `capture-unreadable` | error | yes | A capture document could not be resolved, is not a regular file, or could not be read. |
| `disconnected-group` | info | no | Two or more unreachable pages link only to each other. |
| `duplicate-include` | info | no | The same shard was included more than once; it was read only the first time. |
| `duplicate-page-id` | error | no | An inventory id is declared twice; only the first declaration is analysed. |
| `empty-inventory` | error | yes | No page was examined. A run with no evidence is never a pass. |
| `file-too-large` | error | yes | A capture document is above `maxFileBytes` and was not read. |
| `include-depth-exceeded` | error | yes | Include nesting is deeper than `maxIncludeDepth`; that shard was not read. |
| `link-source-unknown` | warning | yes | A link's `from` page is not in the inventory, so the link cannot carry reachability and the crawl's coverage is unknown. |
| `link-target-unknown` | warning | yes | A link's `to` page is not in the inventory. Unknown — neither broken nor orphaned. |
| `no-usable-root` | error | yes | No configured entry page is in the inventory, so reachability could not be computed at all. |
| `orphan-page` | error | no | An inventory page that no inventory page links to. |
| `path-escapes-root` | error | yes | A capture or shard resolved, after symlinks, outside the capture root. It was refused and not read. |
| `root-not-in-inventory` | error | no | A configured entry page id does not appear in the inventory. |
| `self-link` | info | no | A page links to itself. Never an incoming link. |
| `too-many-findings` | error | yes | The report exceeds `maxFindings`; the notice naming how many were dropped is appended last. |
| `too-many-include-files` | error | yes | More shards were included than `maxIncludeFiles`; the remainder were not read. |
| `too-many-links` | error | yes | The capture holds more links than `maxLinks`; the remainder were not analysed. |
| `too-many-pages` | error | yes | The inventory holds more pages than `maxPages`; the remainder were not analysed. |
| `unreachable-page` | error | no | Pages link here, but no entry page reaches any of them. |
| `unsafe-include-path` | error | yes | An include path was refused by the lexical check before anything was read. |

Severity comes from one frozen table in `src/rules.mjs`, and `test/severity-table.test.mjs`
asserts that table against this catalog in both directions — including the `Incomplete` column.
A rule id the table does not know throws rather than defaulting to something harmless.

## Limits

Every limit is enforced, reported when it is hit, and covered by a test. Exceeding one is an
explicit finding and an incomplete report, never a silent truncation.

| Limit | Flag | Default | What it bounds |
| --- | --- | --- | --- |
| `maxPages` | `--max-pages` | 20000 | Inventory pages merged and analysed. |
| `maxLinks` | `--max-links` | 200000 | Link records merged and analysed. |
| `maxFileBytes` | `--max-file-bytes` | 8388608 | Bytes in one capture document. |
| `maxIncludeDepth` | `--max-include-depth` | 4 | Include nesting below the capture. |
| `maxIncludeFiles` | `--max-include-files` | 64 | Shards read besides the capture itself. |
| `maxListed` | `--max-listed` | 10 | Page ids listed inside one finding or one `incoming` array. |
| `maxFindings` | `--max-findings` | 5000 | Findings in one report. |

`maxListed` is the one bound that is not an incomplete result. It shortens an *excerpt*, never the
evidence: the untruncated count is still reported as `incomingTotal`, with `incomingTruncated`
saying the list was shortened. Nothing is lost, so nothing is claimed to be missing.

An unknown limit name, or a limit that is not a positive integer, is a **configuration error**: it
throws, the CLI writes nothing to stdout, and the exit code is 2.

## The report

The envelope is the catalog's v1 report contract, with one tool-specific extension: a top-level
`pages` array carrying one result per inventory page, sorted by id, each with the reason described
above. `summary` carries the contract's `checked`, `errors` and `warnings` plus integer fields for
`documents`, `links`, `edges`, `roots`, `reachable`, `orphans`, `unreachable`, `groups`,
`unknownTargets`, `unknownSources` and `selfLinks`.

`summary.checked` counts inventory pages examined. A report can never combine `status: "pass"` with
`checked: 0`; the single place where status is decided emits `empty-inventory` instead.

The human-readable report is line-oriented: **one finding is exactly one line.** A page id and a
capture file name are crawl output, so either may contain a newline; both reach the printed line
(through `message` and `location.file`), and control characters — C0, DEL, the C1 range including
U+0085, and U+2028/U+2029 — are flattened to spaces before printing. Nothing is dropped: the text
is still reported, as data on the line of the finding that carries it, and the JSON report keeps
the original bytes, escaped by `JSON.stringify`. A capture cannot forge a finding line that no
finding stands behind.

`evidence` is flattened the same way and additionally bounded to 160 characters.

### Determinism

- Findings sort by `location.file`, then `location.pointer`, then `ruleId`, then `message`, all by
  UTF-16 code unit. `localeCompare` is never used: ICU data varies between Node builds and has
  already produced a real ordering bug in this catalog.
- Page results sort by page id, by code unit.
- Ids listed inside a result or a finding are in code-unit order too: a page's `incoming`
  list, a disconnected group's members, and the group id, which is the lowest member.
- Include order is the declaration order in the capture, never filesystem enumeration order.
- There is no clock, no random source and no locale anywhere in the tool.
- Two runs over identical inputs produce byte-identical stdout.

### Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | Completed, every inventory page reachable, evidence complete | the report |
| 1 | Completed, the site failed (orphan or unreachable pages) | the report |
| 2 | Invalid usage or configuration | **empty** |
| 2 | Unreadable input, or evidence that does not support a verdict | an `incomplete` report |

A consumer piping stdout must handle an empty stdout on exit 2. Emitting a fabricated report for a
run that never had a subject would be worse.

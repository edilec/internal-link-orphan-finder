# Internal Link Orphan Finder

Read a page inventory and the internal links extracted from it, compute reachability from chosen
entry pages, and report the pages nothing links to, the groups that link only to each other, and
the link targets the crawl never covered — each with the reason that produced it.

- **Repository:** [edilec/internal-link-orphan-finder](https://github.com/edilec/internal-link-orphan-finder)
- **Worked example:** [Compare reachable pages, an orphan and a disconnected group](https://edilec.com/open-source/internal-link-orphan-finder/) using the public synthetic captures.
- **Area:** SEO & Search
- **License:** MIT
- **Dependencies:** none. Node 22+ built-ins only.

## What it does

Given a capture — a JSON document holding the pages a crawl found plus the links it extracted —
the tool walks the graph breadth-first from the entry pages you choose and classifies every
inventory page into exactly one of three states:

| State | Meaning | Reason reported |
| --- | --- | --- |
| `reachable` | A path of internal links leads here from an entry page. | The actual path, hop by hop. |
| `orphan` | No page in the inventory links here. | That no incoming link exists. |
| `unreachable` | Pages link here, but none of those is reachable either. | Which pages link here, and the disconnected group they form. |

A link target that is **not in the inventory** is none of those three. It is *unknown*: the crawl
did not cover it. It is not broken — nothing was ever requested — and it is not an orphan, because
nothing is known about what links to it. Treating an uncovered target as a broken link or an orphan
is the classic false positive here, and this tool refuses to do it.

Because an uncovered page could be the very page that links to something reported as an orphan, an
unknown target or source makes the whole run `incomplete` (exit 2) rather than a pass. Unverified
is not green.

## Usage

```sh
node bin/internal-link-orphan-finder.mjs --capture examples/site-clean.json
node bin/internal-link-orphan-finder.mjs --capture examples/site-orphan.json --json
node bin/internal-link-orphan-finder.mjs --capture examples/site-orphan.json --entry /legacy/alpha
```

```
--capture FILE          capture JSON to analyse (required)
--root DIR              directory confining the capture and its shards
                        (default: the capture file's directory)
--entry ID              entry page id, repeatable; replaces the capture's own "roots"
--json                  emit the machine-readable report on stdout
--max-pages N           --max-links N          --max-file-bytes N
--max-include-depth N   --max-include-files N  --max-listed N   --max-findings N
-h, --help
```

Exit codes: `0` reachable and complete, `1` failed, `2` invalid usage (nothing on stdout) or
unreadable/incomplete evidence (an `incomplete` report on stdout).

### As a library

```js
import { analyzeCaptureFile, analyzeCaptureDocuments } from 'internal-link-orphan-finder'

const report = await analyzeCaptureFile({ capture: 'crawl/site.json', roots: ['/'] })
// or, with documents you already parsed:
const pure = analyzeCaptureDocuments({
  documents: [{ file: 'site.json', data: { schemaVersion: '1', pages: [], links: [] } }],
  roots: ['/'],
})
```

`analyzeCaptureDocuments` touches no filesystem, no clock and no locale.

## Capture format

```json
{
  "schemaVersion": "1",
  "roots": ["/"],
  "include": ["links/blog.json"],
  "pages": [{ "id": "/", "title": "Home" }],
  "links": [{ "from": "/", "to": "/about", "kind": "nav", "label": "About" }]
}
```

Page ids are opaque strings compared exactly. Unknown keys anywhere in the capture are **rejected**,
not ignored — a one-character typo must not quietly turn a real failure into a green run. The full
format, the rule catalog and the limits are in
[`docs/reachability-rules.md`](./docs/reachability-rules.md).

## Examples

| File | Result |
| --- | --- |
| `examples/site-clean.json` (plus the `examples/links/blog.json` shard) | `pass`, exit 0 |
| `examples/site-orphan.json` | `fail`, exit 1 — an isolated page and a two-page cycle nothing reaches |
| `examples/site-broken.json` | `incomplete`, exit 2 — the same site, plus a link to a page the crawl never inventoried |

## Limits and non-goals

**This tool cannot conclude that a page is genuinely orphaned on the live site.** It concludes that
*within the capture it was given* no inventory page links to it. If the crawl missed the page that
links there, the answer is wrong — which is why any uncovered link target or source downgrades the
run to `incomplete` instead of letting it pass.

Specifically, the tool **cannot** tell you:

- **whether a link exists that the crawl did not extract.** Navigation injected by client-side
  JavaScript, links behind authentication, pagination the crawler stopped short of, and links in
  sitemaps or feeds that were never crawled are all invisible to it. It analyses the capture, not
  the site.
- **whether a page is actually unreachable by a user.** Reachability here is *internal-link*
  reachability. A page linked only from an external site, reached only through a search box, a
  redirect, a QR code or a canonical alternate is reported as an orphan, and that is a statement
  about the link graph, not about traffic.
- **whether an unknown target is broken.** The tool makes no network request, ever. An uncovered
  target is uncovered; nothing is asserted about whether it exists, redirects, or returns 404.
- **anything about URL identity.** Ids are compared byte for byte. `/a`, `/a/`, `/A` and
  `/a?x=1` are four different pages unless your crawler normalised them. The tool will happily
  report an orphan that is really the same page under a second spelling.
- **whether an orphan matters.** Deliberately unlinked pages — a press kit, a campaign landing
  page, a thank-you page — are orphans by design and are reported as such. Ranking importance is
  not attempted.
- **anything about a crawl it was not given.** There is no discovery, no filesystem walk of a site
  and no adapter. The capture is the whole of the evidence.

Bounds are explicit and enforced: pages, links, bytes per document, include depth, include count,
ids listed per finding, and findings per report. Exceeding any of them produces a finding and an
`incomplete` result — never a silently shorter answer.

## Verification

```sh
npm run check
```

which runs `lint` (`node --check` on every file), `test` (`node --test`), the `example` run, and
`pack:check`. There are no dependencies to install.

## Repository layout

- `src/` — `rules.mjs` (identity, bounds, the severity table), `capture.mjs` (reading, validation,
  path confinement), `graph.mjs` (reachability), `index.mjs` (report assembly)
- `bin/` — the CLI
- `test/` — public API, real CLI, confinement, the incomplete invariant, the severity table,
  determinism and ordering
- `docs/` — the rule catalog, capture format, limits and determinism
- `examples/` — a clean capture, a failing one, and an incomplete one

## License

MIT. See [LICENSE](./LICENSE).

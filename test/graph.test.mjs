import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LIMITS,
  analyzeCaptureDocuments,
  formatReport,
  severityOf,
} from '../src/index.mjs'
import { disconnectedGroups } from '../src/graph.mjs'

function capture(file, body) {
  return { file, data: { schemaVersion: '1', ...body } }
}

function ruleTrace(report) {
  return report.findings.map((finding) => [
    finding.location.file ?? null,
    finding.location.pointer ?? null,
    finding.ruleId,
  ])
}

function page(report, id) {
  const found = report.pages.find((entry) => entry.id === id)
  assert.ok(found !== undefined, `no page result for ${id}`)
  return found
}

test('an isolated page is found, with the reason that nothing links to it', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: [{ id: '/', title: 'Home' }, { id: '/a' }, { id: '/island', title: 'Island' }],
        links: [{ from: '/', to: '/a' }],
      }),
    ],
  })

  assert.equal(report.status, 'fail')
  assert.equal(report.summary.checked, 3)
  assert.equal(report.summary.orphans, 1)
  assert.equal(report.summary.unreachable, 0)
  assert.equal(report.summary.reachable, 2)

  assert.deepEqual(page(report, '/island'), {
    id: '/island',
    title: 'Island',
    source: { file: 'crawl.json', pointer: '/pages/2' },
    incoming: [],
    incomingTotal: 0,
    incomingTruncated: false,
    incomingFromUnknownSources: 0,
    outgoingTotal: 0,
    state: 'orphan',
    depth: null,
    root: null,
    path: null,
    group: null,
    reason: 'No page in the inventory links to it, so no path from any entry page can exist.',
  })

  assert.deepEqual(ruleTrace(report), [['crawl.json', '/pages/2', 'orphan-page']])
})

test('a reachable page carries the actual path that reached it', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/a' }, { id: '/b' }, { id: '/c' }],
        links: [
          { from: '/', to: '/a' },
          { from: '/a', to: '/b' },
          { from: '/b', to: '/a' },
          { from: '/b', to: '/c' },
          { from: '/c', to: '/' },
        ],
      }),
    ],
  })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.deepEqual(
    report.pages.map((entry) => [entry.id, entry.state, entry.depth, entry.path]),
    [
      ['/', 'reachable', 0, ['/']],
      ['/a', 'reachable', 1, ['/', '/a']],
      ['/b', 'reachable', 2, ['/', '/a', '/b']],
      ['/c', 'reachable', 3, ['/', '/a', '/b', '/c']],
    ],
  )
  assert.equal(page(report, '/c').reason, 'Reachable from entry page "/" in 3 hop(s): / -> /a -> /b -> /c')
  assert.equal(page(report, '/').reason, 'Configured entry page "/".')
})

test('a cycle is walked once instead of hanging, and every ring member is reached', () => {
  const size = 200
  const pages = []
  const links = []
  for (let index = 0; index < size; index += 1) {
    pages.push({ id: `/p${index}` })
    links.push({ from: `/p${index}`, to: `/p${(index + 1) % size}` })
    links.push({ from: `/p${index}`, to: '/p0' })
  }

  const report = analyzeCaptureDocuments({
    documents: [capture('ring.json', { roots: ['/p0'], pages, links })],
  })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.reachable, size)
  assert.equal(report.summary.orphans, 0)
  assert.equal(page(report, '/p10').depth, 10)
  assert.deepEqual(page(report, '/p3').path, ['/p0', '/p1', '/p2', '/p3'])
  // The self-referential /p0 -> /p0 edge is a self link, never an incoming link.
  assert.equal(page(report, '/p0').incoming.includes('/p0'), false)
})

test('a cycle that no entry page reaches is an unreachable group, not an orphan', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/x' }, { id: '/y' }],
        links: [
          { from: '/x', to: '/y' },
          { from: '/y', to: '/x' },
        ],
      }),
    ],
  })

  assert.equal(report.status, 'fail')
  assert.equal(report.summary.orphans, 0)
  assert.equal(report.summary.unreachable, 2)
  assert.equal(report.summary.groups, 1)
  assert.deepEqual(ruleTrace(report), [
    ['crawl.json', '/pages/1', 'disconnected-group'],
    ['crawl.json', '/pages/1', 'unreachable-page'],
    ['crawl.json', '/pages/2', 'unreachable-page'],
  ])
  assert.equal(page(report, '/x').group, '/x')
  assert.equal(page(report, '/y').group, '/x')
  assert.equal(
    page(report, '/y').reason,
    'Linked from 1 inventory page(s), none of which is reachable from an entry page: /x',
  )
})

/**
 * Group ordering, asserted where it is decided. `analyzeLinkGraph` hands this
 * function ids that are already sorted, so both sorts below can be deleted with
 * every end-to-end fixture still green; ids handed in unsorted are the only way
 * to make the guarantee fail when it is removed.
 */
test('groups and their members come back in code-unit order, whatever order they were found in', () => {
  const outgoing = new Map([
    ['/a', new Set(['/b'])],
    ['/x', new Set(['/y'])],
  ])
  const incoming = new Map([
    ['/b', new Set(['/a'])],
    ['/y', new Set(['/x'])],
  ])

  // Reverse code-unit order, so the second component is discovered first.
  const groups = disconnectedGroups(['/y', '/x', '/b', '/a'], outgoing, incoming)

  assert.deepEqual(groups.map((group) => group.id), ['/a', '/x'])
  assert.deepEqual(groups.map((group) => group.members), [['/a', '/b'], ['/x', '/y']])
})

test('a group is named after its lowest member and lists its members in code-unit order', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        // Declared out of order; walked /a -> /c -> /b, which is not the order
        // the group must be reported in.
        pages: [{ id: '/c' }, { id: '/' }, { id: '/b' }, { id: '/a' }],
        links: [
          { from: '/a', to: '/c' },
          { from: '/c', to: '/b' },
        ],
      }),
    ],
  })

  assert.equal(report.summary.groups, 1)
  const group = report.findings.find((finding) => finding.ruleId === 'disconnected-group')
  assert.equal(
    group.message,
    'Disconnected group of 3 page(s) that link only to each other: /a, /b, /c',
  )
  assert.equal(group.evidence, '/a')
  assert.deepEqual(
    report.pages.filter((entry) => entry.group !== null).map((entry) => [entry.id, entry.group]),
    [['/a', '/a'], ['/b', '/a'], ['/c', '/a']],
  )
})

test('a link target outside the inventory is unknown: not broken, not an orphan, not a pass', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/a' }],
        links: [
          { from: '/', to: '/a' },
          { from: '/a', to: '/never-crawled' },
        ],
      }),
    ],
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.unknownTargets, 1)
  assert.equal(report.summary.orphans, 0)
  // The uncovered target is never invented as an inventory page.
  assert.deepEqual(report.pages.map((entry) => entry.id), ['/', '/a'])
  assert.deepEqual(ruleTrace(report), [['crawl.json', '/links/1', 'link-target-unknown']])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.findings[0].evidence, '/a -> /never-crawled')
})

test('a link from a page outside the inventory cannot carry reachability', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/a' }, { id: '/b' }],
        links: [
          { from: '/', to: '/a' },
          { from: '/ghost', to: '/b' },
        ],
      }),
    ],
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.unknownSources, 1)
  assert.equal(page(report, '/b').state, 'orphan')
  assert.equal(page(report, '/b').incomingFromUnknownSources, 1)
  assert.equal(
    page(report, '/b').reason,
    'No page in the inventory links to it; 1 link(s) arrive from source pages the crawl did not inventory.',
  )
})

test('findings sort by file, then pointer, then rule id -- across documents', () => {
  const documents = [
    capture('b-shard.json', { pages: [{ id: '/zeta' }] }),
    capture('a-shard.json', {
      roots: ['/'],
      pages: [{ id: '/' }, { id: '/alpha' }],
      links: [{ from: '/alpha', to: '/alpha' }],
    }),
  ]

  const expected = [
    ['a-shard.json', '/links/0', 'self-link'],
    ['a-shard.json', '/pages/1', 'orphan-page'],
    ['b-shard.json', '/pages/0', 'orphan-page'],
  ]

  const report = analyzeCaptureDocuments({ documents })
  assert.deepEqual(ruleTrace(report), expected)

  // Supplying the same documents in the opposite order must not move anything.
  const reversed = analyzeCaptureDocuments({ documents: [...documents].reverse() })
  assert.deepEqual(ruleTrace(reversed), expected)
  assert.equal(JSON.stringify(reversed.findings), JSON.stringify(report.findings))
})

test('the same capture analysed twice serialises byte for byte identically', () => {
  const documents = [
    capture('crawl.json', {
      roots: ['/', '/b-root'],
      pages: [{ id: '/' }, { id: '/b-root' }, { id: '/deep' }, { id: '/lost' }],
      links: [
        { from: '/', to: '/deep' },
        { from: '/b-root', to: '/deep' },
      ],
    }),
  ]
  const first = JSON.stringify(analyzeCaptureDocuments({ documents }))
  const second = JSON.stringify(analyzeCaptureDocuments({ documents }))
  assert.equal(first, second)
})

test('with several entry pages the reason path is chosen by code unit, not declaration order', () => {
  const build = (roots) =>
    analyzeCaptureDocuments({
      documents: [
        capture('crawl.json', {
          roots,
          pages: [{ id: '/a-root' }, { id: '/b-root' }, { id: '/shared' }],
          links: [
            { from: '/a-root', to: '/shared' },
            { from: '/b-root', to: '/shared' },
          ],
        }),
      ],
    })

  for (const roots of [['/a-root', '/b-root'], ['/b-root', '/a-root']]) {
    const report = build(roots)
    assert.equal(report.status, 'pass')
    assert.deepEqual(page(report, '/shared').path, ['/a-root', '/shared'])
    assert.equal(page(report, '/shared').root, '/a-root')
  }
})

test('an entry page that is not in the inventory fails without pretending to be incomplete', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/', '/typo'],
        pages: [{ id: '/' }],
        links: [],
      }),
    ],
  })

  assert.equal(report.status, 'fail')
  assert.deepEqual(ruleTrace(report), [['crawl.json', '/roots/1', 'root-not-in-inventory']])
  assert.equal(report.summary.roots, 1)
  assert.equal(page(report, '/').state, 'reachable')
})

test('entry pages passed by the caller replace the ones the capture declares', () => {
  const documents = [
    capture('crawl.json', {
      roots: ['/'],
      pages: [{ id: '/' }, { id: '/x' }, { id: '/y' }],
      links: [
        { from: '/', to: '/x' },
        { from: '/y', to: '/x' },
      ],
    }),
  ]

  const overridden = analyzeCaptureDocuments({ documents, roots: ['/y'] })
  assert.deepEqual(
    overridden.pages.map((entry) => [entry.id, entry.state]),
    [['/', 'orphan'], ['/x', 'reachable'], ['/y', 'reachable']],
  )
})

test('a repeated page id is reported at its own declaration site', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/dup' }, { id: '/dup' }],
        links: [{ from: '/', to: '/dup' }],
      }),
    ],
  })

  assert.deepEqual(ruleTrace(report), [['crawl.json', '/pages/2', 'duplicate-page-id']])
  assert.equal(report.summary.checked, 2)
  assert.equal(report.status, 'fail')
})

test('the incoming list is bounded while the true total is still reported', () => {
  const pages = [{ id: '/' }, { id: '/hub' }]
  const links = []
  for (let index = 0; index < 12; index += 1) {
    pages.push({ id: `/src-${String(index).padStart(2, '0')}` })
    links.push({ from: `/src-${String(index).padStart(2, '0')}`, to: '/hub' })
  }
  const documents = [capture('crawl.json', { roots: ['/'], pages, links })]

  const wide = analyzeCaptureDocuments({ documents })
  const hub = page(wide, '/hub')
  assert.equal(hub.incoming.length, DEFAULT_LIMITS.maxListed)
  assert.equal(hub.incomingTotal, 12)
  assert.equal(hub.incomingTruncated, true)
  assert.deepEqual(hub.incoming.slice(0, 2), ['/src-00', '/src-01'])

  const narrow = analyzeCaptureDocuments({ documents, limits: { maxListed: 3 } })
  assert.deepEqual(page(narrow, '/hub').incoming, ['/src-00', '/src-01', '/src-02'])
  assert.equal(page(narrow, '/hub').incomingTotal, 12)
})

test('the page limit is enforced, reported, and never a silent truncation', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/a' }, { id: '/b' }],
        links: [{ from: '/', to: '/a' }],
      }),
    ],
    limits: { maxPages: 2 },
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 2)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'too-many-pages'))
})

test('the link limit is enforced and reported', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/a' }, { id: '/b' }],
        links: [
          { from: '/', to: '/a' },
          { from: '/a', to: '/b' },
        ],
      }),
    ],
    limits: { maxLinks: 1 },
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.links, 1)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'too-many-links'))
  assert.equal(page(report, '/b').state, 'orphan')
})

test('the finding limit truncates with an explicit notice placed last', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/one' }, { id: '/two' }, { id: '/three' }],
        links: [],
      }),
    ],
    limits: { maxFindings: 2 },
  })

  assert.equal(report.findings.length, 3)
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['orphan-page', 'orphan-page', 'too-many-findings'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(
    report.findings[2].message,
    'Report exceeds the 2 finding limit; 1 finding(s) were not reported.',
  )
})

test('an empty inventory is never a pass', () => {
  const report = analyzeCaptureDocuments({
    documents: [capture('crawl.json', { roots: [], pages: [], links: [] })],
  })

  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['empty-inventory'])
})

test('no report can ever combine status pass with zero pages checked', () => {
  const shapes = [
    { documents: [] },
    { documents: [capture('crawl.json', {})] },
    { documents: [capture('crawl.json', { pages: [], links: [], roots: [] })] },
  ]
  for (const shape of shapes) {
    const report = analyzeCaptureDocuments(shape)
    assert.notEqual(report.status, 'pass', JSON.stringify(shape))
    assert.equal(report.summary.checked, 0)
  }
})

test('configuration mistakes throw instead of producing a report', () => {
  assert.throws(
    () => analyzeCaptureDocuments({ documents: [capture('c.json', {})], limits: { maxPage: 5 } }),
    /Unknown limit "maxPage"/,
  )
  assert.throws(
    () => analyzeCaptureDocuments({ documents: [capture('c.json', {})], limits: { maxPages: 0 } }),
    /must be a positive integer/,
  )
  assert.throws(() => analyzeCaptureDocuments({ documents: [capture('c.json', {})], roots: '/' }), /must be an array/)
  assert.throws(() => analyzeCaptureDocuments({ documents: 'nope' }), /documents must be an array/)
  assert.throws(() => severityOf('not-a-rule'), /Unknown ruleId "not-a-rule"/)
})

/**
 * A page id and a capture file name are crawl output: attacker-influenceable
 * data. The human report is line-oriented, so a newline inside either one used
 * to print extra lines that no finding stood behind -- a log scraper counting
 * "^ERROR" saw more errors than the run found. One finding is one line.
 */
test('capture text can never forge an extra finding line in the human report', () => {
  const NEWLINE = String.fromCharCode(10)
  const LINE_BREAKS = new RegExp(
    '[\\u000a\\u000b\\u000c\\u000d\\u0085\\u2028\\u2029]',
  )
  const forgedLine = `${NEWLINE}ERROR   forged.json /pages/9 orphan-page Totally fake finding`
  // One vector per untrusted field the line carries: the page id reaches
  // `message`, the document name reaches `location.file`.
  const forgedId = `/x${forgedLine}${String.fromCharCode(0x2028)}${String.fromCharCode(0x0085)}`
  const forgedFile = `crawl${forgedLine}.json`

  const report = analyzeCaptureDocuments({
    documents: [
      capture(forgedFile, {
        roots: ['/'],
        pages: [{ id: '/' }, { id: forgedId }, { id: '/y' }],
        links: [
          { from: forgedId, to: '/y' },
          { from: '/y', to: forgedId },
        ],
      }),
    ],
  })

  assert.equal(report.findings.length, 3)
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.info, 1)

  const text = formatReport(report)
  const lines = text.split(LINE_BREAKS)
  assert.equal(lines.pop(), '', 'the report ends with exactly one newline')
  assert.equal(lines.length, 4 + report.findings.length, text)
  assert.equal(lines.filter((line) => line.startsWith('ERROR')).length, report.summary.errors)
  assert.equal(lines.filter((line) => line.startsWith('INFO')).length, report.summary.info)
  assert.equal(lines.filter((line) => line.startsWith('WARNING')).length, report.summary.warnings)

  // Nothing is hidden: the forged text is still reported, as data on the line
  // of the finding that carries it.
  assert.ok(lines.some((line) => line.includes('Totally fake finding')))
  assert.ok(lines.some((line) => line.startsWith('ERROR   crawl ERROR   forged.json')))
  // The JSON report was never forgeable: it keeps the bytes, escaped.
  assert.equal(JSON.parse(JSON.stringify(report)).findings.length, 3)
})

test('the human summary states the status and every finding', () => {
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', { roots: ['/'], pages: [{ id: '/' }, { id: '/lost' }], links: [] }),
    ],
  })
  const text = formatReport(report)
  const lines = text.split(String.fromCharCode(10))

  assert.equal(lines[0], 'internal-link-orphan-finder: status fail')
  assert.equal(
    lines[1],
    '2 page(s) from 1 capture document(s); 1 reachable, 1 orphan, 0 unreachable, 0 disconnected group(s).',
  )
  assert.ok(lines[4].startsWith('ERROR   crawl.json /pages/1 orphan-page'))
})

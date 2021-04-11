import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { analyzeCaptureDocuments, byCodeUnit } from '../src/index.mjs'
import { makeFinding, sortFindings } from '../src/rules.mjs'

/**
 * Determinism, pinned.
 *
 * `docs/reachability-rules.md` promises UTF-16 code-unit ordering everywhere
 * and states that `localeCompare` is never used, because ICU data varies
 * between Node builds and has already produced a real ordering bug in this
 * catalog. Every fixture elsewhere happens to list its pages in sorted order
 * and to use single-case ids, so both the comparator and the page sort could
 * be removed with the whole suite still green. These tests use ids where
 * code-unit order and locale order genuinely disagree, declared in an order
 * that is not the sorted one.
 */

const projectDirectory = resolve(import.meta.dirname, '..')

function capture(file, body) {
  return { file, data: { schemaVersion: '1', ...body } }
}

test('byCodeUnit orders by UTF-16 code unit, which is not locale order', () => {
  assert.equal(byCodeUnit('/a', '/a'), 0)
  // Locale collation folds case and ignores punctuation at the primary level;
  // each of these assertions is the opposite of what it would answer.
  assert.ok(byCodeUnit('/B', '/a') < 0, 'uppercase sorts before lowercase by code unit')
  assert.ok(byCodeUnit('/a', '/B') > 0, 'and the comparator is antisymmetric')
  assert.ok(byCodeUnit('/Z', '/a') < 0)
  assert.ok(byCodeUnit('/_x', '/a') < 0, 'U+005F sorts before U+0061')
  assert.ok(byCodeUnit('/a-x', '/ax') < 0, 'U+002D sorts before U+0078')
})

test('page results sort by page id, by code unit, never by the order the capture lists them', () => {
  const declared = ['/z', '/m', '/ax', '/b', '/', '/a-x', '/B', '/a']
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: declared.map((id) => ({ id })),
        links: declared.filter((id) => id !== '/').map((id) => ({ from: '/', to: id })),
      }),
    ],
  })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.pages.map((entry) => entry.id), [
    '/',
    '/B',
    '/a',
    '/a-x',
    '/ax',
    '/b',
    '/m',
    '/z',
  ])
})

test('the ids listed inside one result are ordered by code unit as well', () => {
  const sources = ['/z', '/B', '/a', '/ax', '/a-x']
  const report = analyzeCaptureDocuments({
    documents: [
      capture('crawl.json', {
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/hub' }, ...sources.map((id) => ({ id }))],
        links: [
          ...sources.map((id) => ({ from: '/', to: id })),
          ...sources.map((id) => ({ from: id, to: '/hub' })),
        ],
      }),
    ],
  })

  const hub = report.pages.find((entry) => entry.id === '/hub')
  assert.deepEqual(hub.incoming, ['/B', '/a', '/a-x', '/ax', '/z'])
  // The breadth-first search walks outgoing targets in the same order, so the
  // reason path is chosen by code unit too.
  assert.deepEqual(hub.path, ['/', '/B', '/hub'])
})

test('the tool carries no locale, no clock, no random source and no directory walk', async () => {
  const banned = [
    ['localeCompare', 'ICU collation varies between Node builds'],
    ['Intl.', 'locale-sensitive formatting is not deterministic'],
    ['Date.now', 'there is no clock in this tool'],
    ['new Date', 'there is no clock in this tool'],
    ['Math.random', 'there is no random source in this tool'],
    ['readdir', 'include order is the capture declaration order, never enumeration order'],
  ]

  const files = []
  for (const directory of ['src', 'bin']) {
    const full = resolve(projectDirectory, directory)
    for (const name of (await readdir(full)).sort()) {
      if (name.endsWith('.mjs')) files.push([`${directory}/${name}`, resolve(full, name)])
    }
  }
  assert.ok(files.length >= 5, 'expected the shipped sources to be found')

  for (const [label, path] of files) {
    const source = await readFile(path, 'utf8')
    for (const [needle, why] of banned) {
      assert.equal(source.includes(needle), false, `${label} uses ${needle}: ${why}`)
    }
  }
})

/**
 * The documented finding order is file, then pointer, then ruleId, then
 * message. In every shipped scenario the message comparator happens to
 * reproduce what the ruleId comparator decides -- "Disconnected group..." <
 * "Unreachable page..." matches disconnected-group < unreachable-page -- so no
 * end-to-end fixture can tell the two apart, and the ruleId tiebreak was
 * deletable with the suite green. These findings are built with the messages in
 * the opposite order to the rule ids, so each comparator is pinned on its own.
 */
test('findings sort by file, then pointer, then ruleId, then message', () => {
  const at = (file, pointer, ruleId, message) => makeFinding({ ruleId, message, file, pointer })
  const trace = (findings) =>
    findings.map((finding) => [
      finding.location.file,
      finding.location.pointer,
      finding.ruleId,
      finding.message,
    ])

  const sorted = sortFindings([
    at('b.json', '/pages/0', 'orphan-page', 'aaa'),
    at('a.json', '/pages/1', 'self-link', 'aaa'),
    at('a.json', '/pages/0', 'unreachable-page', 'aaa'),
    at('a.json', '/pages/0', 'disconnected-group', 'zzz'),
  ])

  assert.deepEqual(trace(sorted), [
    ['a.json', '/pages/0', 'disconnected-group', 'zzz'],
    ['a.json', '/pages/0', 'unreachable-page', 'aaa'],
    ['a.json', '/pages/1', 'self-link', 'aaa'],
    ['b.json', '/pages/0', 'orphan-page', 'aaa'],
  ])

  // Message is the last tiebreak, and it is a real one: two findings that agree
  // on file, pointer and rule are ordered by it rather than by arrival.
  const twins = sortFindings([
    at('a.json', '/pages/0', 'orphan-page', 'zzz'),
    at('a.json', '/pages/0', 'orphan-page', 'aaa'),
  ])
  assert.deepEqual(twins.map((finding) => finding.message), ['aaa', 'zzz'])

  // A finding with no location sorts as the empty string, i.e. first.
  const unplaced = sortFindings([
    at('a.json', '/pages/0', 'orphan-page', 'aaa'),
    makeFinding({ ruleId: 'no-usable-root', message: 'aaa' }),
  ])
  assert.deepEqual(unplaced.map((finding) => finding.ruleId), ['no-usable-root', 'orphan-page'])
})

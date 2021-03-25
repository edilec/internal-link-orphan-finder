import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  INCOMPLETE_RULES,
  RULE_SEVERITY,
  analyzeCaptureDocuments,
  analyzeCaptureFile,
  forcesIncomplete,
} from '../src/index.mjs'

/**
 * The "incomplete" invariant, defended rule by rule.
 *
 * Deleting one `incomplete = true` is exactly the kind of change a green test
 * suite failed to notice in this catalog before. Here the flag is data --
 * INCOMPLETE_RULES -- and every entry has a scenario below that fails if the
 * entry is removed. The coverage assertion at the end runs in both directions,
 * so a rule cannot be quietly dropped from the list either.
 */

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ilof-inc-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.json'), JSON.stringify({ schemaVersion: '1', pages: [] }))

  const write = async (relativePath, contents) => {
    const full = join(root, relativePath)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, typeof contents === 'string' || Buffer.isBuffer(contents) ? contents : JSON.stringify(contents))
    return full
  }
  return { base, root, outside, write, capturePath: join(root, 'capture.json') }
}

function documentsOf(body) {
  return [{ file: 'crawl.json', data: { schemaVersion: '1', ...body } }]
}

const SCENARIOS = {
  'capture-invalid': async () =>
    analyzeCaptureDocuments({ documents: [{ file: 'crawl.json', data: { schemaVersion: '9' } }] }),

  'capture-undecodable': async (t) => {
    const fx = await fixture(t)
    await fx.write('capture.json', Buffer.from([0x7b, 0xff, 0x7d]))
    return analyzeCaptureFile({ capture: fx.capturePath })
  },

  'capture-unreadable': async (t) => {
    const fx = await fixture(t)
    return analyzeCaptureFile({ capture: join(fx.root, 'nowhere.json') })
  },

  'empty-inventory': async () => analyzeCaptureDocuments({ documents: documentsOf({ pages: [] }) }),

  'file-too-large': async (t) => {
    const fx = await fixture(t)
    await fx.write('capture.json', { schemaVersion: '1', roots: ['/'], pages: [{ id: '/' }] })
    return analyzeCaptureFile({ capture: fx.capturePath, limits: { maxFileBytes: 5 } })
  },

  'include-depth-exceeded': async (t) => {
    const fx = await fixture(t)
    await fx.write('capture.json', {
      schemaVersion: '1',
      roots: ['/'],
      pages: [{ id: '/' }],
      include: ['one.json'],
    })
    await fx.write('one.json', { schemaVersion: '1', pages: [{ id: '/one' }], include: ['two.json'] })
    await fx.write('two.json', { schemaVersion: '1', pages: [{ id: '/two' }] })
    return analyzeCaptureFile({ capture: fx.capturePath, limits: { maxIncludeDepth: 1 } })
  },

  'link-source-unknown': async () =>
    analyzeCaptureDocuments({
      documents: documentsOf({
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/a' }],
        links: [{ from: '/', to: '/a' }, { from: '/ghost', to: '/a' }],
      }),
    }),

  'link-target-unknown': async () =>
    analyzeCaptureDocuments({
      documents: documentsOf({
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/a' }],
        links: [{ from: '/', to: '/a' }, { from: '/a', to: '/uncrawled' }],
      }),
    }),

  'no-usable-root': async () =>
    analyzeCaptureDocuments({ documents: documentsOf({ roots: [], pages: [{ id: '/' }] }) }),

  'path-escapes-root': async (t) => {
    const fx = await fixture(t)
    await fx.write('capture.json', {
      schemaVersion: '1',
      roots: ['/'],
      pages: [{ id: '/' }],
      include: ['leak.json'],
    })
    await symlink(join(fx.outside, 'secret.json'), join(fx.root, 'leak.json'))
    return analyzeCaptureFile({ capture: fx.capturePath })
  },

  'too-many-findings': async () =>
    analyzeCaptureDocuments({
      documents: documentsOf({ roots: ['/'], pages: [{ id: '/' }, { id: '/x' }, { id: '/y' }] }),
      limits: { maxFindings: 1 },
    }),

  'too-many-include-files': async (t) => {
    const fx = await fixture(t)
    await fx.write('capture.json', {
      schemaVersion: '1',
      roots: ['/'],
      pages: [{ id: '/' }],
      include: ['a.json', 'b.json'],
    })
    await fx.write('a.json', { schemaVersion: '1', pages: [{ id: '/a' }] })
    await fx.write('b.json', { schemaVersion: '1', pages: [{ id: '/b' }] })
    return analyzeCaptureFile({ capture: fx.capturePath, limits: { maxIncludeFiles: 1 } })
  },

  'too-many-links': async () =>
    analyzeCaptureDocuments({
      documents: documentsOf({
        roots: ['/'],
        pages: [{ id: '/' }, { id: '/a' }],
        links: [{ from: '/', to: '/a' }, { from: '/a', to: '/' }],
      }),
      limits: { maxLinks: 1 },
    }),

  'too-many-pages': async () =>
    analyzeCaptureDocuments({
      documents: documentsOf({ roots: ['/'], pages: [{ id: '/' }, { id: '/a' }] }),
      limits: { maxPages: 1 },
    }),

  'unsafe-include-path': async (t) => {
    const fx = await fixture(t)
    await fx.write('capture.json', {
      schemaVersion: '1',
      roots: ['/'],
      pages: [{ id: '/' }],
      include: ['../outside/secret.json'],
    })
    return analyzeCaptureFile({ capture: fx.capturePath })
  },
}

for (const ruleId of Object.keys(SCENARIOS).sort()) {
  test(`${ruleId} forces status incomplete`, async (t) => {
    const report = await SCENARIOS[ruleId](t)
    assert.ok(
      report.findings.some((finding) => finding.ruleId === ruleId),
      `scenario for ${ruleId} did not emit it: ${JSON.stringify(report.findings.map((f) => f.ruleId))}`,
    )
    assert.equal(report.status, 'incomplete', `${ruleId} did not force an incomplete report`)
    assert.notEqual(report.status, 'pass')
  })
}

test('every rule that must force incomplete has a scenario, and no scenario is stale', () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), [...INCOMPLETE_RULES].sort())
  for (const ruleId of INCOMPLETE_RULES) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is not in the severity table`)
    assert.equal(forcesIncomplete(ruleId), true)
  }
})

test('the two warning-severity incomplete rules are the only thing preventing a pass', async () => {
  // Neither of these produces an error, so if they stopped forcing "incomplete"
  // the report would say pass with a green exit code -- on a crawl that never
  // covered the pages it links to.
  const warningRules = INCOMPLETE_RULES.filter((ruleId) => RULE_SEVERITY[ruleId] === 'warning')
  assert.deepEqual(warningRules, ['link-source-unknown', 'link-target-unknown'])

  for (const ruleId of warningRules) {
    const report = await SCENARIOS[ruleId]()
    assert.equal(report.summary.errors, 0, `${ruleId} scenario must contain no error finding`)
    assert.equal(report.summary.warnings, 1)
    assert.equal(report.status, 'incomplete')
  }
})

test('rules outside the list do not force incomplete', () => {
  const complete = Object.keys(RULE_SEVERITY).filter((ruleId) => !INCOMPLETE_RULES.includes(ruleId))
  assert.deepEqual(complete, [
    'disconnected-group',
    'duplicate-include',
    'duplicate-page-id',
    'orphan-page',
    'root-not-in-inventory',
    'self-link',
    'unreachable-page',
  ])
  for (const ruleId of complete) assert.equal(forcesIncomplete(ruleId), false)
})

test('a failing run is a fail, not an incomplete: the two are never interchangeable', () => {
  const report = analyzeCaptureDocuments({
    documents: documentsOf({ roots: ['/'], pages: [{ id: '/' }, { id: '/lost' }], links: [] }),
  })
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.findings.every((finding) => !INCOMPLETE_RULES.includes(finding.ruleId)), true)
})

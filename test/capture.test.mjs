import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import {
  analyzeCaptureFile,
  isInside,
  unsafeIncludeReason,
  validateDocument,
} from '../src/index.mjs'

const OUT_OF_ROOT_MARKER = '/OUT-OF-ROOT-PAGE-MARKER'

/**
 * Every filesystem test gets its own base directory holding a capture root and
 * a sibling directory OUTSIDE that root, so confinement can be attacked with a
 * real symlink rather than argued about.
 */
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'ilof-'))
  t.after(() => rm(base, { recursive: true, force: true }))

  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(
    join(outside, 'secret.json'),
    JSON.stringify({ schemaVersion: '1', pages: [{ id: OUT_OF_ROOT_MARKER }] }),
  )

  const write = async (relativePath, contents) => {
    const full = join(root, relativePath)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, typeof contents === 'string' || Buffer.isBuffer(contents) ? contents : JSON.stringify(contents))
    return full
  }

  return { base, root, outside, write, capturePath: join(root, 'capture.json') }
}

function rulesOf(report) {
  return report.findings.map((finding) => finding.ruleId)
}

test('a symlink inside the root pointing at a file outside it is refused', async (t) => {
  const fx = await fixture(t)
  await fx.write('capture.json', {
    schemaVersion: '1',
    roots: ['/'],
    pages: [{ id: '/' }],
    links: [],
    include: ['shards/leak.json'],
  })
  await mkdir(join(fx.root, 'shards'), { recursive: true })
  await symlink(join(fx.outside, 'secret.json'), join(fx.root, 'shards', 'leak.json'))

  const report = await analyzeCaptureFile({ capture: fx.capturePath })

  assert.equal(report.status, 'incomplete')
  assert.ok(rulesOf(report).includes('path-escapes-root'))
  assert.equal(report.summary.documents, 1)
  assert.deepEqual(report.pages.map((entry) => entry.id), ['/'])

  const serialised = JSON.stringify(report)
  assert.equal(serialised.includes(OUT_OF_ROOT_MARKER), false)
  assert.equal(serialised.includes(fx.outside), false)
})

test('a symlink inside the root pointing at a directory outside it is refused', async (t) => {
  const fx = await fixture(t)
  await fx.write('capture.json', {
    schemaVersion: '1',
    roots: ['/'],
    pages: [{ id: '/' }],
    links: [],
    include: ['shards/escape/secret.json'],
  })
  await mkdir(join(fx.root, 'shards'), { recursive: true })
  await symlink(fx.outside, join(fx.root, 'shards', 'escape'))

  const report = await analyzeCaptureFile({ capture: fx.capturePath })

  assert.equal(report.status, 'incomplete')
  assert.ok(rulesOf(report).includes('path-escapes-root'))
  const serialised = JSON.stringify(report)
  assert.equal(serialised.includes(OUT_OF_ROOT_MARKER), false)
  assert.equal(serialised.includes(fx.outside), false)
})

test('a capture file that is itself a symlink out of the root is refused', async (t) => {
  const fx = await fixture(t)
  await symlink(join(fx.outside, 'secret.json'), join(fx.root, 'capture.json'))

  const report = await analyzeCaptureFile({ capture: fx.capturePath, root: fx.root })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesOf(report), ['path-escapes-root'])
  assert.equal(JSON.stringify(report).includes(OUT_OF_ROOT_MARKER), false)
})

test('an include path is refused lexically before anything is read', async (t) => {
  const fx = await fixture(t)
  await fx.write('capture.json', {
    schemaVersion: '1',
    roots: ['/'],
    pages: [{ id: '/' }],
    links: [],
    include: ['../outside/secret.json', '/etc/hosts', 'shards//x.json'],
  })

  const report = await analyzeCaptureFile({ capture: fx.capturePath })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesOf(report).filter((rule) => rule === 'unsafe-include-path').length, 3)
  assert.deepEqual(
    report.findings
      .filter((finding) => finding.ruleId === 'unsafe-include-path')
      .map((finding) => [finding.location.pointer, finding.message]),
    [
      ['/include/0', 'Include path must not contain a ".." segment; it was refused and not read.'],
      ['/include/1', 'Include path must be relative to the capture root; it was refused and not read.'],
      ['/include/2', 'Include path must not contain an empty segment; it was refused and not read.'],
    ],
  )
  assert.equal(JSON.stringify(report).includes(OUT_OF_ROOT_MARKER), false)
})

test('lexical include checks name the reason they refuse', () => {
  assert.equal(unsafeIncludeReason('shards/a.json'), null)
  assert.equal(unsafeIncludeReason('../a.json'), 'must not contain a ".." segment')
  assert.equal(unsafeIncludeReason('/a.json'), 'must be relative to the capture root')
  assert.equal(unsafeIncludeReason('C:/a.json'), 'must not be drive-qualified')
  assert.equal(unsafeIncludeReason('shards' + String.fromCharCode(92) + 'a.json'), 'must use "/" as its separator')
  assert.equal(unsafeIncludeReason('a' + String.fromCharCode(0) + '.json'), 'must not contain a NUL character')
  assert.equal(unsafeIncludeReason(''), 'must be a non-empty string')
  assert.equal(unsafeIncludeReason(42), 'must be a non-empty string')
})

test('isInside compares real paths, not prefixes', () => {
  assert.equal(isInside('/a/root', '/a/root'), true)
  assert.equal(isInside('/a/root', '/a/root/child.json'), true)
  assert.equal(isInside('/a/root', '/a/root-sibling/child.json'), false)
  assert.equal(isInside('/a/root', '/a/outside/secret.json'), false)
  assert.equal(isInside('/a/root', '/a'), false)
})

test('include nesting is bounded and the shard past the limit is not read', async (t) => {
  const fx = await fixture(t)
  await fx.write('capture.json', {
    schemaVersion: '1',
    roots: ['/'],
    pages: [{ id: '/' }],
    links: [],
    include: ['one.json'],
  })
  await fx.write('one.json', { schemaVersion: '1', pages: [{ id: '/one' }], include: ['two.json'] })
  await fx.write('two.json', { schemaVersion: '1', pages: [{ id: '/two' }] })

  const deep = await analyzeCaptureFile({ capture: fx.capturePath, limits: { maxIncludeDepth: 2 } })
  assert.deepEqual(deep.pages.map((entry) => entry.id), ['/', '/one', '/two'])

  const shallow = await analyzeCaptureFile({ capture: fx.capturePath, limits: { maxIncludeDepth: 1 } })
  assert.equal(shallow.status, 'incomplete')
  assert.ok(rulesOf(shallow).includes('include-depth-exceeded'))
  assert.deepEqual(shallow.pages.map((entry) => entry.id), ['/', '/one'])
})

test('the shard count is bounded and the remainder is reported once', async (t) => {
  const fx = await fixture(t)
  await fx.write('capture.json', {
    schemaVersion: '1',
    roots: ['/'],
    pages: [{ id: '/' }],
    links: [],
    include: ['a.json', 'b.json', 'c.json'],
  })
  for (const name of ['a', 'b', 'c']) {
    await fx.write(`${name}.json`, { schemaVersion: '1', pages: [{ id: `/${name}` }] })
  }

  const report = await analyzeCaptureFile({ capture: fx.capturePath, limits: { maxIncludeFiles: 2 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(rulesOf(report).filter((rule) => rule === 'too-many-include-files').length, 1)
  assert.deepEqual(report.pages.map((entry) => entry.id), ['/', '/a', '/b'])
})

test('a shard included twice is read once and the repeat is reported', async (t) => {
  const fx = await fixture(t)
  await fx.write('capture.json', {
    schemaVersion: '1',
    roots: ['/'],
    pages: [{ id: '/' }],
    links: [{ from: '/', to: '/shared' }],
    include: ['shared.json', 'shared.json'],
  })
  await fx.write('shared.json', { schemaVersion: '1', pages: [{ id: '/shared' }] })

  const report = await analyzeCaptureFile({ capture: fx.capturePath })
  assert.equal(report.status, 'pass')
  assert.deepEqual(rulesOf(report), ['duplicate-include'])
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.documents, 2)
})

test('a capture document larger than the byte limit is not read', async (t) => {
  const fx = await fixture(t)
  await fx.write('capture.json', { schemaVersion: '1', roots: ['/'], pages: [{ id: '/' }], links: [] })

  const report = await analyzeCaptureFile({ capture: fx.capturePath, limits: { maxFileBytes: 10 } })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesOf(report), ['file-too-large'])
  assert.equal(report.summary.checked, 0)
})

test('bytes that are not valid UTF-8 fail the decode instead of being guessed at', async (t) => {
  const fx = await fixture(t)
  await fx.write('capture.json', Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))

  const report = await analyzeCaptureFile({ capture: fx.capturePath })
  assert.equal(report.status, 'incomplete')
  assert.ok(rulesOf(report).includes('capture-undecodable'))
})

test('a file holding a literal replacement character still decodes and is analysed', async (t) => {
  const fx = await fixture(t)
  // U+FFFD is legal UTF-8. Encoding validity is decided by the decoder, never
  // inferred from the decoded text, so this capture must be read normally.
  await fx.write('capture.json', {
    schemaVersion: '1',
    roots: ['/'],
    pages: [{ id: '/' }, { id: `/page-${String.fromCharCode(0xfffd)}` }],
    links: [{ from: '/', to: `/page-${String.fromCharCode(0xfffd)}` }],
  })

  const report = await analyzeCaptureFile({ capture: fx.capturePath })
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
})

test('a capture that is not JSON, or not the expected shape, is refused precisely', async (t) => {
  const fx = await fixture(t)

  await fx.write('capture.json', 'this is not json')
  const notJson = await analyzeCaptureFile({ capture: fx.capturePath })
  assert.equal(notJson.status, 'incomplete')
  assert.ok(rulesOf(notJson).includes('capture-invalid'))

  await fx.write('capture.json', { schemaVersion: '2', pages: [] })
  const wrongVersion = await analyzeCaptureFile({ capture: fx.capturePath })
  assert.equal(
    wrongVersion.findings.find((finding) => finding.ruleId === 'capture-invalid').location.pointer,
    '/schemaVersion',
  )

  await fx.write('capture.json', { schemaVersion: '1', pagez: [{ id: '/' }] })
  const typo = await analyzeCaptureFile({ capture: fx.capturePath })
  assert.equal(typo.status, 'incomplete')
  assert.equal(
    typo.findings.find((finding) => finding.ruleId === 'capture-invalid').message,
    'Capture document has an unrecognised key; a typo must not be silently ignored.',
  )
  assert.equal(typo.summary.checked, 0)
})

test('a stray key inside a page or link entry is refused at its pointer', () => {
  assert.equal(validateDocument({ schemaVersion: '1', pages: [{ id: '/' }] }, 'c.json'), null)

  const strayPage = validateDocument({ schemaVersion: '1', pages: [{ id: '/', noindex: true }] }, 'c.json')
  assert.equal(strayPage.ruleId, 'capture-invalid')
  assert.deepEqual(strayPage.location, { file: 'c.json', pointer: '/pages/0' })
  assert.equal(strayPage.message, 'Page entry has an unrecognised key "noindex".')

  const strayLink = validateDocument(
    { schemaVersion: '1', links: [{ from: '/', to: '/a', rel: 'nofollow' }] },
    'c.json',
  )
  assert.deepEqual(strayLink.location, { file: 'c.json', pointer: '/links/0' })

  const missingTo = validateDocument({ schemaVersion: '1', links: [{ from: '/' }] }, 'c.json')
  assert.equal(missingTo.message, 'Link entry is missing its "to" string.')
})

test('a capture file that cannot be read produces an incomplete report, never a pass', async (t) => {
  const fx = await fixture(t)
  const report = await analyzeCaptureFile({ capture: join(fx.root, 'absent.json') })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(rulesOf(report), ['capture-unreadable'])
  assert.equal(report.findings[0].location.file, 'absent.json')
})

test('a directory handed in where a capture belongs is reported, not walked', async (t) => {
  const fx = await fixture(t)
  await mkdir(join(fx.root, 'subdir'), { recursive: true })
  const report = await analyzeCaptureFile({ capture: join(fx.root, 'subdir') })

  assert.equal(report.status, 'incomplete')
  assert.ok(rulesOf(report).includes('capture-unreadable'))
})

test('configuration errors throw rather than producing a report', async (t) => {
  const fx = await fixture(t)
  await fx.write('capture.json', { schemaVersion: '1', pages: [{ id: '/' }], roots: ['/'] })

  await assert.rejects(
    () => analyzeCaptureFile({ capture: fx.capturePath, root: join(fx.base, 'outside') }),
    /Capture file is outside the capture root/,
  )
  await assert.rejects(
    () => analyzeCaptureFile({ capture: fx.capturePath, root: join(fx.base, 'no-such-dir') }),
    /Capture root could not be resolved/,
  )
  await assert.rejects(() => analyzeCaptureFile({ capture: '' }), /capture file path is required/i)
  await assert.rejects(
    () => analyzeCaptureFile({ capture: fx.capturePath, limits: { maxShards: 2 } }),
    /Unknown limit "maxShards"/,
  )
  await assert.rejects(
    () => analyzeCaptureFile({ capture: fx.capturePath, roots: ['', '/'] }),
    /must be a non-empty page id/,
  )
})

test('the shipped clean example passes when read through the filesystem', async () => {
  const capturePath = resolve(import.meta.dirname, '..', 'examples', 'site-clean.json')
  const report = await analyzeCaptureFile({ capture: capturePath })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.documents, 2)
  assert.equal(report.summary.checked, 8)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(
    report.pages.find((entry) => entry.id === '/blog/first-post').path,
    ['/', '/blog', '/blog/first-post'],
  )
  assert.equal(
    report.pages.find((entry) => entry.id === '/blog/first-post').source.file,
    'site-clean.json',
  )
  // No absolute path from this machine reaches the report: every document is
  // named by its path relative to the capture root. Asserted over the page
  // results, which this report has -- the same predicate over `findings` would
  // be vacuously true here, because this report has none.
  assert.deepEqual(
    [...new Set(report.pages.map((entry) => entry.source.file))],
    ['site-clean.json'],
  )
  assert.equal(
    JSON.stringify(report).includes(resolve(import.meta.dirname, '..')),
    false,
    'the report must never name a path outside the capture root',
  )
})

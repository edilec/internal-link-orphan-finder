import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const projectDirectory = resolve(import.meta.dirname, '..')
const CLI = resolve(projectDirectory, 'bin/internal-link-orphan-finder.mjs')
const NEWLINE = String.fromCharCode(10)

/** Run the real CLI and capture the exit code and both streams separately. */
function run(args) {
  return new Promise((fulfil) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: projectDirectory, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        fulfil({ code: error === null ? 0 : error.code, stdout, stderr })
      },
    )
  })
}

test('--help explains the tool and exits 0 without emitting a report', async () => {
  const result = await run(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.ok(result.stdout.includes('Usage:'))
  assert.ok(result.stdout.includes('--entry ID'))
  assert.ok(result.stdout.includes('Exit codes:'))
  assert.equal(result.stdout.includes('"schemaVersion"'), false)
})

test('the clean example passes with exit 0 and a machine-readable report', async () => {
  const human = await run(['--capture', 'examples/site-clean.json'])
  assert.equal(human.code, 0)
  assert.equal(human.stderr, '')
  assert.equal(human.stdout.split(NEWLINE)[0], 'internal-link-orphan-finder: status pass')

  const json = await run(['--capture', 'examples/site-clean.json', '--json'])
  assert.equal(json.code, 0)
  const report = JSON.parse(json.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'internal-link-orphan-finder')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 8)
  assert.equal(report.summary.documents, 2)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(
    report.pages.find((page) => page.id === '/docs/api').path,
    ['/', '/blog', '/blog/first-post', '/docs/api'],
  )
  assert.equal(
    report.pages.find((page) => page.id === '/blog/first-post').source.file,
    'site-clean.json',
  )
})

test('an isolated page and an unreached cycle fail the run with exit 1', async () => {
  const result = await run(['--capture', 'examples/site-orphan.json', '--json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)

  assert.equal(report.status, 'fail')
  assert.deepEqual(
    report.findings.map((finding) => [finding.location.pointer, finding.ruleId]),
    [
      ['/links/4', 'self-link'],
      ['/pages/2', 'disconnected-group'],
      ['/pages/2', 'unreachable-page'],
      ['/pages/3', 'unreachable-page'],
      ['/pages/4', 'orphan-page'],
    ],
  )
  assert.deepEqual(
    report.pages.map((page) => [page.id, page.state]),
    [
      ['/', 'reachable'],
      ['/about', 'reachable'],
      ['/legacy/alpha', 'unreachable'],
      ['/legacy/beta', 'unreachable'],
      ['/press-kit', 'orphan'],
    ],
  )
  assert.equal(report.pages.find((page) => page.id === '/press-kit').incomingTotal, 0)
})

test('a page the crawl never covered is unknown, and the run is incomplete with exit 2', async () => {
  const result = await run(['--capture', 'examples/site-broken.json', '--json'])
  assert.equal(result.code, 2)
  assert.ok(result.stderr.includes('incomplete'))

  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.unknownTargets, 1)

  const unknown = report.findings.find((finding) => finding.ruleId === 'link-target-unknown')
  assert.equal(unknown.severity, 'warning')
  assert.equal(unknown.evidence, '/ -> /pricing')
  // The uncovered page is never turned into an inventory page or an orphan.
  assert.equal(report.pages.some((page) => page.id === '/pricing'), false)
})

test('--entry replaces the entry pages the capture declares', async () => {
  const result = await run([
    '--capture',
    'examples/site-orphan.json',
    '--entry',
    '/legacy/alpha',
    '--json',
  ])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)

  assert.deepEqual(
    report.pages.map((page) => [page.id, page.state]),
    [
      ['/', 'unreachable'],
      ['/about', 'unreachable'],
      ['/legacy/alpha', 'reachable'],
      ['/legacy/beta', 'reachable'],
      ['/press-kit', 'orphan'],
    ],
  )
  assert.deepEqual(report.pages.find((page) => page.id === '/legacy/beta').path, [
    '/legacy/alpha',
    '/legacy/beta',
  ])
})

test('--max-listed reaches the analysis instead of being accepted and ignored', async () => {
  const wide = JSON.parse((await run(['--capture', 'examples/site-orphan.json', '--json'])).stdout)
  const narrow = JSON.parse(
    (await run(['--capture', 'examples/site-orphan.json', '--max-listed', '1', '--json'])).stdout,
  )

  const groupOf = (report) =>
    report.findings.find((finding) => finding.ruleId === 'disconnected-group').message

  assert.equal(
    groupOf(wide),
    'Disconnected group of 2 page(s) that link only to each other: /legacy/alpha, /legacy/beta',
  )
  assert.equal(
    groupOf(narrow),
    'Disconnected group of 2 page(s) that link only to each other: /legacy/alpha, ...',
  )
})

test('--max-pages reaches the analysis and makes the run incomplete', async () => {
  const result = await run(['--capture', 'examples/site-orphan.json', '--max-pages', '2', '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 2)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'too-many-pages'))
})

test('a usage error writes nothing to stdout and exits 2', async () => {
  for (const args of [
    ['--capture', 'examples/site-clean.json', '--nope'],
    ['--json'],
    ['--capture'],
    ['--capture', 'examples/site-clean.json', '--max-pages', '0'],
    ['--capture', 'examples/site-clean.json', '--max-pages', 'many'],
    ['--capture', 'examples/site-clean.json', '--max-page', '5'],
  ]) {
    const result = await run(args)
    assert.equal(result.code, 2, `expected exit 2 for ${args.join(' ')}`)
    assert.equal(result.stdout, '', `stdout must stay empty for ${args.join(' ')}`)
    assert.ok(result.stderr.length > 0, `stderr must explain ${args.join(' ')}`)
  }
})

test('an unreadable input writes an incomplete report to stdout and exits 2', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'ilof-cli-'))
  t.after(() => rm(base, { recursive: true, force: true }))

  const missing = await run(['--capture', join(base, 'absent.json'), '--json'])
  assert.equal(missing.code, 2)
  const report = JSON.parse(missing.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['capture-unreadable'])
  assert.equal(report.findings[0].location.file, 'absent.json')

  await writeFile(join(base, 'broken.json'), 'definitely not json')
  const unparsable = await run(['--capture', join(base, 'broken.json'), '--json'])
  assert.equal(unparsable.code, 2)
  assert.equal(JSON.parse(unparsable.stdout).status, 'incomplete')
})

test('an empty inventory is reported, never passed', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'ilof-cli-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await writeFile(
    join(base, 'empty.json'),
    JSON.stringify({ schemaVersion: '1', roots: [], pages: [], links: [] }),
  )

  const result = await run(['--capture', join(base, 'empty.json'), '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.summary.checked, 0)
  assert.notEqual(report.status, 'pass')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['empty-inventory'])
})

test('two runs over the same capture produce byte-identical stdout', async () => {
  const first = await run(['--capture', 'examples/site-orphan.json', '--json'])
  const second = await run(['--capture', 'examples/site-orphan.json', '--json'])
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.ok(first.stdout.length > 0)
})

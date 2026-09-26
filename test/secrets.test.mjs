import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { parseFailureDetail } from '../src/index.mjs'

/**
 * A parse failure must not reproduce the file it failed on.
 *
 * V8 reports a `JSON.parse` failure two ways. One names a position and says
 * nothing about the content. The other quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` -- the whole
 * document when it is short, a ten-character prefix when it is not. A capture
 * file short enough to be only a credential was therefore published in full by
 * the finding that failed to read it, on exactly the path an untrusted or
 * malformed file takes.
 *
 * Flattening does not fix this: `singleLine` and `excerpt` remove controls and
 * cut from the end, while the quoted input sits at the front of the message.
 * The canary below is AWS's published documentation placeholder, not a key.
 */

const projectDirectory = resolve(import.meta.dirname, '..')
const CLI = resolve(projectDirectory, 'bin/internal-link-orphan-finder.mjs')
const CANARY = 'AKIAIOSFODNN7EXAMPLE'

function run(args) {
  return new Promise((fulfil) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: projectDirectory, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => fulfil({ code: error === null ? 0 : error.code, stdout, stderr }),
    )
  })
}

/** Every prefix of the canary down to eight characters, longest first. */
function prefixes(value) {
  const found = []
  for (let length = value.length; length >= 8; length -= 1) found.push(value.slice(0, length))
  return found
}

function assertNoCanary(result, label) {
  for (const prefix of prefixes(CANARY)) {
    assert.equal(result.stdout.includes(prefix), false, `${label}: stdout carries ${prefix}`)
    assert.equal(result.stderr.includes(prefix), false, `${label}: stderr carries ${prefix}`)
  }
}

async function base(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ilof-secrets-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('a capture that is only a credential is not echoed by the finding that read it', async (t) => {
  const directory = await base(t)
  const capture = join(directory, 'capture.json')
  await writeFile(capture, CANARY)

  const json = await run(['--capture', capture, '--json'])
  assert.equal(json.code, 2)
  assertNoCanary(json, 'json report')

  const human = await run(['--capture', capture])
  assert.equal(human.code, 2)
  assertNoCanary(human, 'human report')

  const report = JSON.parse(json.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(
    report.findings.find((finding) => finding.ruleId === 'capture-invalid').message,
    "Capture file is not valid JSON: unexpected token 'A' at the start of the document",
  )
})

test('a longer capture is not echoed by its ten-character prefix either', async (t) => {
  const directory = await base(t)
  const capture = join(directory, 'capture.json')
  await writeFile(capture, `${CANARY} and a great deal of trailing content nobody should read back`)

  const result = await run(['--capture', capture, '--json'])
  assert.equal(result.code, 2)
  assertNoCanary(result, 'long capture')
})

test('an included shard that is only a credential is not echoed either', async (t) => {
  const directory = await base(t)
  const capture = join(directory, 'capture.json')
  await writeFile(capture, JSON.stringify({
    schemaVersion: '1',
    roots: ['/'],
    include: ['shard.json'],
    pages: [{ id: '/' }],
    links: [],
  }))
  await writeFile(join(directory, 'shard.json'), CANARY)

  const result = await run(['--capture', capture, '--json'])
  assert.equal(result.code, 2)
  assertNoCanary(result, 'shard')
  assert.equal(
    JSON.parse(result.stdout).findings.some((finding) => finding.ruleId === 'capture-invalid'),
    true,
  )
})

test('the position, line and column survive, because a parse error that says nothing is a defect', async (t) => {
  const directory = await base(t)
  const capture = join(directory, 'capture.json')
  await writeFile(capture, '{"schemaVersion": "1", "token": "hunter2-correct-horse" "pages": []}')

  const result = await run(['--capture', capture, '--json'])
  const finding = JSON.parse(result.stdout).findings.find((item) => item.ruleId === 'capture-invalid')
  assert.match(finding.message, /at position \d+ \(line \d+ column \d+\)/)
  assert.equal(finding.message.includes('hunter2'), false)
})

test('parseFailureDetail keeps the position and drops the quoted input', () => {
  const cases = [
    [CANARY, "unexpected token 'A' at the start of the document"],
    ['password=hunter2-correct-horse', "unexpected token 'p' at the start of the document"],
    ['', 'Unexpected end of JSON input'],
    ['{"a": 1', "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)"],
  ]
  for (const [document, expected] of cases) {
    try {
      JSON.parse(document)
      assert.fail(`${document} parsed`)
    } catch (error) {
      assert.equal(parseFailureDetail(error), expected, JSON.stringify(document))
    }
  }

  // A message this tool has never seen still yields something printable, and an
  // error with no message at all does not throw on its way into a finding.
  assert.equal(parseFailureDetail(new Error('something new from a future V8')), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})

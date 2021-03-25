import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  DEFAULT_LIMITS,
  INCOMPLETE_RULES,
  RULE_SEVERITY,
  SEVERITIES,
  severityOf,
} from '../src/index.mjs'

/**
 * Severity decides pass or fail, so it is the single thing in this tool most
 * worth pinning. A literal at every construction site drifts silently: one
 * security-relevant rule downgraded to a warning turns a refusal into a green
 * build with every test still passing. These tests assert the one table, the
 * documented catalog and the shipped source all agree, in both directions.
 */

const projectDirectory = resolve(import.meta.dirname, '..')
const CATALOG = 'docs/reachability-rules.md'

async function documentedRules() {
  const text = await readFile(resolve(projectDirectory, CATALOG), 'utf8')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|\s*(yes|no)\s*\|/g)]
  return {
    severity: Object.fromEntries(rows.map((row) => [row[1], row[2]])),
    incomplete: rows.filter((row) => row[3] === 'yes').map((row) => row[1]),
  }
}

async function emittedRuleIds() {
  const sourceDirectory = resolve(projectDirectory, 'src')
  const names = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.mjs')).sort()
  const emitted = new Set()
  for (const name of names) {
    const source = await readFile(resolve(sourceDirectory, name), 'utf8')
    for (const match of source.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)) emitted.add(match[1])
  }
  return emitted
}

test('the documented catalog and the severity table list exactly the same rules', async () => {
  const documented = await documentedRules()
  assert.deepEqual(
    Object.keys(documented.severity).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    `${CATALOG} and RULE_SEVERITY list different rules`,
  )
  assert.deepEqual(documented.severity, { ...RULE_SEVERITY })
})

test('the documented incomplete column matches INCOMPLETE_RULES in both directions', async () => {
  const documented = await documentedRules()
  assert.deepEqual([...documented.incomplete].sort(), [...INCOMPLETE_RULES].sort())
})

test('every rule in the table is emitted, and every emitted rule is in the table', async () => {
  const emitted = await emittedRuleIds()
  assert.deepEqual([...emitted].sort(), Object.keys(RULE_SEVERITY).sort())
})

test('refusals stay errors: downgrading any of these turns a refusal into a green build', () => {
  assert.equal(RULE_SEVERITY['path-escapes-root'], 'error')
  assert.equal(RULE_SEVERITY['unsafe-include-path'], 'error')
  assert.equal(RULE_SEVERITY['capture-undecodable'], 'error')
  assert.equal(RULE_SEVERITY['capture-unreadable'], 'error')
  assert.equal(RULE_SEVERITY['capture-invalid'], 'error')
  assert.equal(RULE_SEVERITY['empty-inventory'], 'error')
})

test('the findings this tool exists to raise stay errors', () => {
  assert.equal(RULE_SEVERITY['orphan-page'], 'error')
  assert.equal(RULE_SEVERITY['unreachable-page'], 'error')
})

test('every table entry uses a severity the report contract defines', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(SEVERITIES.includes(severity), `${ruleId} has severity ${severity}`)
    assert.equal(severityOf(ruleId), severity)
  }
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.equal(Object.isFrozen(INCOMPLETE_RULES), true)
})

test('an unknown rule id throws instead of defaulting to something harmless', () => {
  assert.throws(() => severityOf('orphan-pages'), /Unknown ruleId "orphan-pages"/)
  assert.throws(() => severityOf(''), /Unknown ruleId/)
})

test('every documented limit exists, is wired to a CLI flag, and has a default', async () => {
  const catalog = await readFile(resolve(projectDirectory, CATALOG), 'utf8')
  const cli = await readFile(resolve(projectDirectory, 'bin/internal-link-orphan-finder.mjs'), 'utf8')

  const documented = [...catalog.matchAll(/\|\s*`(max[A-Za-z]+)`\s*\|\s*`(--[a-z-]+)`\s*\|\s*(\d+)\s*\|/g)]
  assert.deepEqual(
    documented.map((row) => row[1]).sort(),
    Object.keys(DEFAULT_LIMITS).sort(),
    `${CATALOG} and DEFAULT_LIMITS list different limits`,
  )
  for (const [, name, flag, value] of documented) {
    assert.equal(DEFAULT_LIMITS[name], Number(value), `${name} default differs from the catalog`)
    assert.ok(cli.includes(`['${flag}', '${name}']`), `${flag} is not wired to ${name} in the CLI`)
    assert.ok(cli.includes(`${flag} `), `${flag} is not listed in --help`)
  }
})

/**
 * Identity, bounds and the single severity table.
 *
 * Severity is the only thing standing between "this run failed" and "this run
 * passed", so it lives in exactly one frozen table and every finding takes its
 * value from there. A rule id that is not in the table throws rather than
 * defaulting to something harmless, and `docs/reachability-rules.md` is
 * asserted against the table in both directions by the test suite.
 */

export const TOOL_ID = 'internal-link-orphan-finder'
export const REPORT_SCHEMA_VERSION = '1'
export const CAPTURE_SCHEMA_VERSION = '1'

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

export const PAGE_STATES = Object.freeze(['reachable', 'orphan', 'unreachable'])

/**
 * Explicit bounds. Every one of these is enforced, reported when it is hit,
 * and covered by a test; a limit that is documented but never wired through is
 * a lie that turns a real failure into a green run.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxPages: 20000,
  maxLinks: 200000,
  maxFileBytes: 8388608,
  maxIncludeDepth: 4,
  maxIncludeFiles: 64,
  maxListed: 10,
  maxFindings: 5000,
})

export const RULE_SEVERITY = Object.freeze({
  'capture-invalid': 'error',
  'capture-undecodable': 'error',
  'capture-unreadable': 'error',
  'disconnected-group': 'info',
  'duplicate-include': 'info',
  'duplicate-page-id': 'error',
  'empty-inventory': 'error',
  'file-too-large': 'error',
  'include-depth-exceeded': 'error',
  'link-source-unknown': 'warning',
  'link-target-unknown': 'warning',
  'no-usable-root': 'error',
  'orphan-page': 'error',
  'path-escapes-root': 'error',
  'root-not-in-inventory': 'error',
  'self-link': 'info',
  'too-many-findings': 'error',
  'too-many-include-files': 'error',
  'too-many-links': 'error',
  'too-many-pages': 'error',
  'unreachable-page': 'error',
  'unsafe-include-path': 'error',
})

/**
 * Rules that force `status: "incomplete"`.
 *
 * Declaring this as data rather than as scattered `incomplete = true`
 * assignments means the invariant has one place to be removed from, and
 * `test/incomplete.test.mjs` asserts a real scenario for every entry. Two of
 * these are warnings, which makes this list the ONLY thing preventing a pass
 * on a crawl that did not cover its own link targets.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'capture-invalid',
  'capture-undecodable',
  'capture-unreadable',
  'empty-inventory',
  'file-too-large',
  'include-depth-exceeded',
  'link-source-unknown',
  'link-target-unknown',
  'no-usable-root',
  'path-escapes-root',
  'too-many-findings',
  'too-many-include-files',
  'too-many-links',
  'too-many-pages',
  'unsafe-include-path',
])

const EVIDENCE_LIMIT = 160
// Everything a line-oriented consumer may treat as a line break or a control
// sequence: C0 controls, DEL, the C1 range (U+0085 NEL included -- Python's
// splitlines breaks on it), and the two Unicode line separators.
const UNPRINTABLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g')

/** Plain code-unit ordering. Locale collation varies with the ICU data a Node build ships. */
export function byCodeUnit(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

export function severityOf(ruleId) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new TypeError(`Unknown ruleId "${ruleId}"`)
  return RULE_SEVERITY[ruleId]
}

export function forcesIncomplete(ruleId) {
  severityOf(ruleId)
  return INCOMPLETE_RULES.includes(ruleId)
}

/**
 * Flatten everything that could end a line: C0 and C1 controls, DEL, and the
 * two Unicode line separators. Capture content -- page ids, capture file names
 * -- is data, never an instruction and never a report line of its own.
 */
export function singleLine(value) {
  return String(value).replace(UNPRINTABLE, ' ')
}

/** A bounded single-line excerpt. Capture content is data, never an instruction. */
export function excerpt(value) {
  const flattened = singleLine(value).trim()
  if (flattened.length <= EVIDENCE_LIMIT) return flattened
  return `${flattened.slice(0, EVIDENCE_LIMIT)}...`
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build one finding. Severity is never passed in: it is looked up, so a caller
 * cannot quietly downgrade a refusal at its construction site.
 */
export function makeFinding({ ruleId, message, file, pointer, evidence, suggestion }) {
  const location = {}
  if (typeof file === 'string' && file !== '') location.file = file
  if (typeof pointer === 'string' && pointer !== '') location.pointer = pointer

  const finding = {
    ruleId,
    severity: severityOf(ruleId),
    message: String(message),
    location,
  }
  if (evidence !== undefined) finding.evidence = excerpt(evidence)
  if (suggestion !== undefined) finding.suggestion = String(suggestion)
  return finding
}

/** Documented order: location.file, then location.pointer, then ruleId, then message. */
export function sortFindings(findings) {
  return [...findings].sort(
    (left, right) =>
      byCodeUnit(left.location.file ?? '', right.location.file ?? '') ||
      byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '') ||
      byCodeUnit(left.ruleId, right.ruleId) ||
      byCodeUnit(left.message, right.message),
  )
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${name}" must be a positive integer`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

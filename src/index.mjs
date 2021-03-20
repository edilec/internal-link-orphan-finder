/**
 * internal-link-orphan-finder
 *
 * Reads a page inventory plus the internal links extracted from it, computes
 * reachability from chosen entry pages, and reports orphans, unreachable
 * groups and uncovered link targets -- each with the reason that produced it.
 *
 * The tool never fetches anything. Everything it knows comes from the capture
 * it was handed, which is why a link target the capture does not cover is
 * reported UNKNOWN and the whole run is reported incomplete: a crawl that did
 * not see a page cannot be used to prove that page is fine.
 */

import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'

import { analyzeLinkGraph } from './graph.mjs'
import { isInside, mergeDocuments, readCaptureDocuments, toPosix } from './capture.mjs'
import {
  DEFAULT_LIMITS,
  INCOMPLETE_RULES,
  REPORT_SCHEMA_VERSION,
  RULE_SEVERITY,
  TOOL_ID,
  isRecord,
  makeFinding,
  sortFindings,
  validateLimits,
} from './rules.mjs'

export {
  CAPTURE_SCHEMA_VERSION,
  DEFAULT_LIMITS,
  INCOMPLETE_RULES,
  PAGE_STATES,
  REPORT_SCHEMA_VERSION,
  RULE_SEVERITY,
  SEVERITIES,
  TOOL_ID,
  byCodeUnit,
  forcesIncomplete,
  severityOf,
  validateLimits,
} from './rules.mjs'
export { isInside, mergeDocuments, unsafeIncludeReason, validateDocument } from './capture.mjs'
export { analyzeLinkGraph } from './graph.mjs'

const EMPTY_COUNTS = Object.freeze({
  pages: 0,
  links: 0,
  edges: 0,
  roots: 0,
  reachable: 0,
  orphans: 0,
  unreachable: 0,
  groups: 0,
  unknownTargets: 0,
  unknownSources: 0,
  selfLinks: 0,
})

function validateRootIds(roots) {
  if (roots === undefined || roots === null) return null
  if (!Array.isArray(roots)) throw new TypeError('Entry pages must be an array of page ids')
  return roots.map((id, index) => {
    if (typeof id !== 'string' || id === '') {
      throw new TypeError(`Entry page at position ${index} must be a non-empty page id`)
    }
    return { id, source: undefined }
  })
}

/**
 * Assemble the report envelope.
 *
 * `status` is derived, never assigned at a call site: incomplete whenever any
 * emitted rule is in INCOMPLETE_RULES, otherwise fail if anything is an error.
 */
function buildReport({ findings, results, counts, documents, limits }) {
  let ordered = sortFindings(findings)
  if (ordered.length > limits.maxFindings) {
    const dropped = ordered.length - limits.maxFindings
    ordered = ordered.slice(0, limits.maxFindings)
    // Appended after the sort, deliberately last, so the notice is never the
    // thing that a truncation hides.
    ordered.push(
      makeFinding({
        ruleId: 'too-many-findings',
        message: `Report exceeds the ${limits.maxFindings} finding limit; ${dropped} finding(s) were not reported.`,
        suggestion: 'Raise --max-findings, or fix the reported problems and run the check again.',
      }),
    )
  }

  const tally = (list) => {
    const counted = { errors: 0, warnings: 0, info: 0, incomplete: false }
    for (const finding of list) {
      if (finding.severity === 'error') counted.errors += 1
      else if (finding.severity === 'warning') counted.warnings += 1
      else counted.info += 1
      if (INCOMPLETE_RULES.includes(finding.ruleId)) counted.incomplete = true
    }
    return counted
  }

  let { errors, warnings, info, incomplete } = tally(ordered)
  // Green on no evidence is a defect, not a pass. This is the single choke
  // point where status is decided, so no path can slip past it.
  if (!incomplete && errors === 0 && counts.pages === 0) {
    ordered = sortFindings([
      ...ordered,
      makeFinding({
        ruleId: 'empty-inventory',
        message: 'No page was examined, so this run has no evidence to pass on.',
        suggestion: 'Supply a capture whose "pages" array lists the crawled pages.',
      }),
    ])
    ;({ errors, warnings, info, incomplete } = tally(ordered))
  }

  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: counts.pages,
      errors,
      warnings,
      info,
      documents,
      links: counts.links,
      edges: counts.edges,
      roots: counts.roots,
      reachable: counts.reachable,
      orphans: counts.orphans,
      unreachable: counts.unreachable,
      groups: counts.groups,
      unknownTargets: counts.unknownTargets,
      unknownSources: counts.unknownSources,
      selfLinks: counts.selfLinks,
    },
    findings: ordered,
    pages: results,
  }
}

/**
 * Analyse already-loaded capture documents.
 *
 * `documents` is an array of `{ file, data }`, where `file` is the path the
 * report should name and `data` is the parsed JSON. Pure, so the graph rules
 * are testable without touching a filesystem.
 */
export function analyzeCaptureDocuments({ documents, roots, limits, extraFindings = [] } = {}) {
  if (!Array.isArray(documents)) throw new TypeError('documents must be an array')
  for (const document of documents) {
    if (!isRecord(document) || typeof document.file !== 'string' || document.file === '') {
      throw new TypeError('Every document needs a non-empty file name')
    }
  }
  const activeLimits = validateLimits(limits ?? {})
  const overrideRoots = validateRootIds(roots)

  const merged = mergeDocuments(documents, activeLimits)
  const declaredRoots = overrideRoots ?? merged.declaredRoots

  if (merged.usableDocuments === 0) {
    return buildReport({
      findings: [...extraFindings, ...merged.findings],
      results: [],
      counts: { ...EMPTY_COUNTS },
      documents: documents.length,
      limits: activeLimits,
    })
  }

  const analysis = analyzeLinkGraph({
    pages: merged.pages,
    links: merged.links,
    declaredRoots,
    limits: activeLimits,
  })

  return buildReport({
    findings: [...extraFindings, ...merged.findings, ...analysis.findings],
    results: analysis.results,
    counts: analysis.counts,
    documents: documents.length,
    limits: activeLimits,
  })
}

/**
 * Read a capture file (and the shards it includes) and analyse it.
 *
 * A configuration problem -- a missing capture root, a capture outside that
 * root, an unknown limit -- throws, because the run never had a subject. An
 * input that could not be read, decoded or parsed returns an `incomplete`
 * report naming the file, because the run had a subject and failed to obtain
 * evidence about it.
 */
export async function analyzeCaptureFile({ capture, root, roots, limits } = {}) {
  if (typeof capture !== 'string' || capture.trim() === '') {
    throw new TypeError('A capture file path is required')
  }
  const activeLimits = validateLimits(limits ?? {})
  const overrideRoots = validateRootIds(roots)

  const captureAbsolute = resolve(capture)
  const rootAbsolute = root === undefined || root === null ? dirname(captureAbsolute) : resolve(root)

  let rootReal
  try {
    rootReal = await realpath(rootAbsolute)
  } catch (error) {
    throw new TypeError(`Capture root could not be resolved: ${error.code ?? 'unknown error'}`)
  }

  const lexicalRelative = relative(rootReal, captureAbsolute)
  if (lexicalRelative === '' || lexicalRelative === '..' || lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    throw new TypeError('Capture file is outside the capture root')
  }
  const captureName = toPosix(lexicalRelative)

  const fail = (finding) =>
    buildReport({
      findings: [finding],
      results: [],
      counts: { ...EMPTY_COUNTS },
      documents: 0,
      limits: activeLimits,
    })

  let captureReal
  try {
    captureReal = await realpath(captureAbsolute)
  } catch (error) {
    return fail(
      makeFinding({
        ruleId: 'capture-unreadable',
        message: `Capture file could not be resolved: ${error.code ?? 'unknown error'}.`,
        file: captureName,
      }),
    )
  }
  // The capture itself is confined too: a symlink is followed before the check,
  // not after it.
  if (!isInside(rootReal, captureReal)) {
    return fail(
      makeFinding({
        ruleId: 'path-escapes-root',
        message: 'Capture file resolves outside the capture root; it was refused and not read.',
        file: captureName,
        suggestion: 'Point --root at a directory that really contains the capture.',
      }),
    )
  }

  const read = await readCaptureDocuments({ captureReal, rootReal, limits: activeLimits })
  return analyzeCaptureDocuments({
    documents: read.documents,
    roots: overrideRoots === null ? undefined : overrideRoots.map((entry) => entry.id),
    limits: activeLimits,
    extraFindings: read.findings,
  })
}

const SEVERITY_WIDTH = 7

export function formatReport(report) {
  const { summary } = report
  const lines = [
    `${TOOL_ID}: status ${report.status}`,
    `${summary.checked} page(s) from ${summary.documents} capture document(s); ${summary.reachable} reachable, ${summary.orphans} orphan, ${summary.unreachable} unreachable, ${summary.groups} disconnected group(s).`,
    `${summary.links} link(s): ${summary.edges} traversable, ${summary.unknownTargets} unknown target(s), ${summary.unknownSources} unknown source(s), ${summary.selfLinks} self link(s).`,
    `${summary.errors} error, ${summary.warnings} warning, ${summary.info} info from ${summary.roots} entry page(s).`,
  ]
  for (const finding of report.findings) {
    const place = [finding.location.file, finding.location.pointer].filter(Boolean).join(' ')
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${place === '' ? '(configuration)' : place} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY))
export const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS))

/**
 * Reading and validating crawl captures.
 *
 * A capture is an inventory of pages plus the internal links extracted from
 * them. It may be sharded across several JSON files that the root capture
 * names in its `include` array; every one of those is resolved against a
 * declared root directory, and confinement is checked on the REAL path, after
 * symlinks are followed, before a single byte is read. Lexically rejecting
 * "../" is not confinement: a symlink planted inside the root points wherever
 * it likes.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { CAPTURE_SCHEMA_VERSION, isRecord, makeFinding, parseFailureDetail } from './rules.mjs'

const DOCUMENT_KEYS = Object.freeze(['include', 'links', 'pages', 'roots', 'schemaVersion', 'site'])
const PAGE_KEYS = Object.freeze(['id', 'note', 'title'])
const LINK_KEYS = Object.freeze(['from', 'kind', 'label', 'to'])

const DRIVE_PREFIX = /^[A-Za-z]:/
const NUL = String.fromCharCode(0)

/** True when `candidateReal` is the real root itself or genuinely below it. */
export function isInside(rootReal, candidateReal) {
  if (candidateReal === rootReal) return true
  const rel = relative(rootReal, candidateReal)
  if (rel === '' || rel === '..' || isAbsolute(rel)) return false
  return !rel.startsWith(`..${sep}`)
}

export function toPosix(value) {
  return value.split(sep).join('/')
}

/**
 * Lexical pre-check on an include path. This is a cheap first gate, not the
 * confinement guarantee -- the real-path assertion below is.
 */
export function unsafeIncludeReason(target) {
  if (typeof target !== 'string' || target === '') return 'must be a non-empty string'
  if (target.includes(NUL)) return 'must not contain a NUL character'
  if (target.includes('\\')) return 'must use "/" as its separator'
  if (target.startsWith('/')) return 'must be relative to the capture root'
  if (DRIVE_PREFIX.test(target)) return 'must not be drive-qualified'
  const segments = target.split('/')
  if (segments.includes('..')) return 'must not contain a ".." segment'
  if (segments.includes('')) return 'must not contain an empty segment'
  return null
}

function invalid(file, pointer, message, evidence) {
  return makeFinding({
    ruleId: 'capture-invalid',
    message,
    file,
    pointer,
    ...(evidence === undefined ? {} : { evidence }),
    suggestion: 'Correct the capture document and run the check again.',
  })
}

function unexpectedKey(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key
  }
  return null
}

function checkStringField(value, name, required) {
  if (value[name] === undefined) {
    return required ? `is missing its "${name}" string` : null
  }
  if (typeof value[name] !== 'string') return `has a non-string "${name}"`
  if (required && value[name] === '') return `has an empty "${name}"`
  return null
}

/**
 * Validate one capture document.
 *
 * The first violation stops validation of that document and the document is
 * not merged. A capture is machine-produced: a partially understood one is
 * evidence we do not have, so it is refused rather than half-used.
 */
export function validateDocument(data, file) {
  if (!isRecord(data)) return invalid(file, undefined, 'Capture document must be a JSON object.')
  if (data.schemaVersion !== CAPTURE_SCHEMA_VERSION) {
    return invalid(
      file,
      '/schemaVersion',
      `Capture schemaVersion must be "${CAPTURE_SCHEMA_VERSION}".`,
      String(data.schemaVersion ?? 'missing'),
    )
  }
  const strayKey = unexpectedKey(data, DOCUMENT_KEYS)
  if (strayKey !== null) {
    return invalid(
      file,
      `/${strayKey}`,
      'Capture document has an unrecognised key; a typo must not be silently ignored.',
      strayKey,
    )
  }
  if (data.site !== undefined && typeof data.site !== 'string') {
    return invalid(file, '/site', 'Capture "site" must be a string when present.')
  }

  for (const name of ['pages', 'links', 'roots', 'include']) {
    if (data[name] !== undefined && !Array.isArray(data[name])) {
      return invalid(file, `/${name}`, `Capture "${name}" must be an array when present.`)
    }
  }

  const pages = data.pages ?? []
  for (let index = 0; index < pages.length; index += 1) {
    const pointer = `/pages/${index}`
    const page = pages[index]
    if (!isRecord(page)) return invalid(file, pointer, 'Page entry must be an object.')
    const stray = unexpectedKey(page, PAGE_KEYS)
    if (stray !== null) {
      return invalid(file, pointer, `Page entry has an unrecognised key "${stray}".`, stray)
    }
    for (const [name, required] of [['id', true], ['title', false], ['note', false]]) {
      const problem = checkStringField(page, name, required)
      if (problem !== null) return invalid(file, pointer, `Page entry ${problem}.`)
    }
  }

  const links = data.links ?? []
  for (let index = 0; index < links.length; index += 1) {
    const pointer = `/links/${index}`
    const link = links[index]
    if (!isRecord(link)) return invalid(file, pointer, 'Link entry must be an object.')
    const stray = unexpectedKey(link, LINK_KEYS)
    if (stray !== null) {
      return invalid(file, pointer, `Link entry has an unrecognised key "${stray}".`, stray)
    }
    for (const [name, required] of [['from', true], ['to', true], ['kind', false], ['label', false]]) {
      const problem = checkStringField(link, name, required)
      if (problem !== null) return invalid(file, pointer, `Link entry ${problem}.`)
    }
  }

  const roots = data.roots ?? []
  for (let index = 0; index < roots.length; index += 1) {
    if (typeof roots[index] !== 'string' || roots[index] === '') {
      return invalid(file, `/roots/${index}`, 'Root entry must be a non-empty string.')
    }
  }

  const includes = data.include ?? []
  for (let index = 0; index < includes.length; index += 1) {
    if (typeof includes[index] !== 'string') {
      return invalid(file, `/include/${index}`, 'Include entry must be a string.')
    }
  }
  return null
}

/**
 * Validate every document and merge the usable ones into flat page, link and
 * root lists. Pure: it never touches the filesystem.
 */
export function mergeDocuments(documents, limits) {
  const findings = []
  const pages = []
  const links = []
  const declaredRoots = []
  let usableDocuments = 0
  let pagesDropped = 0
  let linksDropped = 0

  for (const document of documents) {
    const problem = validateDocument(document.data, document.file)
    if (problem !== null) {
      findings.push(problem)
      continue
    }
    usableDocuments += 1
    const { data, file } = document

    for (let index = 0; index < (data.pages ?? []).length; index += 1) {
      if (pages.length >= limits.maxPages) {
        pagesDropped += 1
        continue
      }
      const page = data.pages[index]
      pages.push({
        id: page.id,
        title: page.title,
        note: page.note,
        source: { file, pointer: `/pages/${index}` },
      })
    }

    for (let index = 0; index < (data.links ?? []).length; index += 1) {
      if (links.length >= limits.maxLinks) {
        linksDropped += 1
        continue
      }
      const link = data.links[index]
      links.push({
        from: link.from,
        to: link.to,
        kind: link.kind,
        label: link.label,
        source: { file, pointer: `/links/${index}` },
      })
    }

    for (let index = 0; index < (data.roots ?? []).length; index += 1) {
      declaredRoots.push({ id: data.roots[index], source: { file, pointer: `/roots/${index}` } })
    }
  }

  if (pagesDropped > 0) {
    findings.push(
      makeFinding({
        ruleId: 'too-many-pages',
        message: `Inventory exceeds the ${limits.maxPages} page limit; ${pagesDropped} page entr(ies) were not analysed.`,
        file: documents.length > 0 ? documents[0].file : undefined,
        suggestion: 'Split the capture or raise --max-pages; the reported reachability is partial.',
      }),
    )
  }
  if (linksDropped > 0) {
    findings.push(
      makeFinding({
        ruleId: 'too-many-links',
        message: `Capture exceeds the ${limits.maxLinks} link limit; ${linksDropped} link entr(ies) were not analysed.`,
        file: documents.length > 0 ? documents[0].file : undefined,
        suggestion: 'Split the capture or raise --max-links; the reported reachability is partial.',
      }),
    )
  }

  return { pages, links, declaredRoots, findings, usableDocuments }
}

async function readDocument(realPath, file, limits) {
  let info
  try {
    info = await stat(realPath)
  } catch (error) {
    return {
      finding: makeFinding({
        ruleId: 'capture-unreadable',
        message: `Capture file could not be examined: ${error.code ?? 'unknown error'}.`,
        file,
      }),
    }
  }
  if (!info.isFile()) {
    return {
      finding: makeFinding({
        ruleId: 'capture-unreadable',
        message: 'Capture path is not a regular file.',
        file,
      }),
    }
  }
  if (info.size > limits.maxFileBytes) {
    return {
      finding: makeFinding({
        ruleId: 'file-too-large',
        message: `Capture file is ${info.size} bytes, above the ${limits.maxFileBytes} byte limit; it was not read.`,
        file,
        suggestion: 'Shard the capture with "include", or raise --max-file-bytes.',
      }),
    }
  }

  let bytes
  try {
    bytes = await readFile(realPath)
  } catch (error) {
    return {
      finding: makeFinding({
        ruleId: 'capture-unreadable',
        message: `Capture file could not be read: ${error.code ?? 'unknown error'}.`,
        file,
      }),
    }
  }

  let text
  try {
    // Strict decoding. Encoding validity is never inferred from decoded text:
    // a file may legitimately contain U+FFFD, and undecodable bytes must fail.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      finding: makeFinding({
        ruleId: 'capture-undecodable',
        message: 'Capture file is not valid UTF-8; it was not analysed.',
        file,
        suggestion: 'Re-encode the capture as UTF-8.',
      }),
    }
  }

  try {
    return { data: JSON.parse(text) }
  } catch (error) {
    return {
      finding: makeFinding({
        ruleId: 'capture-invalid',
        message: `Capture file is not valid JSON: ${parseFailureDetail(error)}`,
        file,
      }),
    }
  }
}

/**
 * Read the root capture and, depth-first in declaration order, every shard it
 * includes. Returns the documents that were read plus findings for the ones
 * that were refused or unreadable.
 */
export async function readCaptureDocuments({ captureReal, rootReal, limits }) {
  const documents = []
  const findings = []
  const seen = new Map()
  let includedFiles = 0
  let limitReported = false

  const load = async (realPath, file, depth) => {
    seen.set(realPath, file)
    const result = await readDocument(realPath, file, limits)
    if (result.finding !== undefined) {
      findings.push(result.finding)
      return
    }
    documents.push({ file, data: result.data })

    const includes = isRecord(result.data) && Array.isArray(result.data.include) ? result.data.include : []
    for (let index = 0; index < includes.length; index += 1) {
      const pointer = `/include/${index}`
      const target = includes[index]
      const reason = unsafeIncludeReason(target)
      if (reason !== null) {
        findings.push(
          makeFinding({
            ruleId: 'unsafe-include-path',
            message: `Include path ${reason}; it was refused and not read.`,
            file,
            pointer,
            evidence: typeof target === 'string' ? target : typeof target,
          }),
        )
        continue
      }
      if (depth + 1 > limits.maxIncludeDepth) {
        findings.push(
          makeFinding({
            ruleId: 'include-depth-exceeded',
            message: `Include nesting exceeds the ${limits.maxIncludeDepth} level limit; this shard was not read.`,
            file,
            pointer,
            evidence: target,
            suggestion: 'Flatten the capture or raise --max-include-depth.',
          }),
        )
        continue
      }
      if (includedFiles >= limits.maxIncludeFiles) {
        if (!limitReported) {
          limitReported = true
          findings.push(
            makeFinding({
              ruleId: 'too-many-include-files',
              message: `Capture includes more than the ${limits.maxIncludeFiles} shard limit; the remaining shards were not read.`,
              file,
              pointer,
              suggestion: 'Reduce the number of shards or raise --max-include-files.',
            }),
          )
        }
        continue
      }

      const candidate = resolve(rootReal, ...target.split('/'))
      let candidateReal
      try {
        candidateReal = await realpath(candidate)
      } catch (error) {
        includedFiles += 1
        findings.push(
          makeFinding({
            ruleId: 'capture-unreadable',
            message: `Included shard could not be resolved: ${error.code ?? 'unknown error'}.`,
            file,
            pointer,
            evidence: target,
          }),
        )
        continue
      }
      // The real path, after every symlink, must still be inside the real root.
      if (!isInside(rootReal, candidateReal)) {
        includedFiles += 1
        findings.push(
          makeFinding({
            ruleId: 'path-escapes-root',
            message: 'Included shard resolves outside the capture root; it was refused and not read.',
            file,
            pointer,
            evidence: target,
            suggestion: 'Keep every shard, and every symlink to one, inside the capture root.',
          }),
        )
        continue
      }
      if (seen.has(candidateReal)) {
        findings.push(
          makeFinding({
            ruleId: 'duplicate-include',
            message: `Shard "${seen.get(candidateReal)}" is included more than once; it was read only the first time.`,
            file,
            pointer,
            evidence: target,
          }),
        )
        continue
      }
      includedFiles += 1
      await load(candidateReal, toPosix(relative(rootReal, candidateReal)), depth + 1)
    }
  }

  await load(captureReal, toPosix(relative(rootReal, captureReal)), 0)
  return { documents, findings, includedFiles }
}

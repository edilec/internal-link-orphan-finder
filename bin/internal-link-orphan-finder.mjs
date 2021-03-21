#!/usr/bin/env node

import { analyzeCaptureFile, formatReport } from '../src/index.mjs'

const HELP = `internal-link-orphan-finder

Read a page inventory and the internal links extracted from it, compute
reachability from chosen entry pages, and report orphans, unreachable groups
and link targets the crawl never covered. Nothing is ever fetched.

Usage:
  internal-link-orphan-finder --capture FILE [--root DIR] [--entry ID ...] [--json] [limits]

Options:
  --capture FILE          Capture JSON to analyse (required)
  --root DIR              Directory that confines the capture and every shard
                          it includes (default: the capture file's directory)
  --entry ID              Entry page id to search from; repeatable. When given,
                          it replaces the "roots" declared inside the capture
  --json                  Emit the machine-readable report on stdout
  --max-pages N           Maximum inventory pages (default 20000)
  --max-links N           Maximum link records (default 200000)
  --max-file-bytes N      Maximum bytes per capture document (default 8388608)
  --max-include-depth N   Maximum include nesting below the capture (default 4)
  --max-include-files N   Maximum included shards (default 64)
  --max-listed N          Maximum ids listed inside one finding (default 10)
  --max-findings N        Maximum findings in a report (default 5000)
  -h, --help              Show this help

Every page result carries a reason: for a reachable page the actual path from
an entry page, for an orphan the fact that no inventory page links to it. A
link target that is not in the inventory is reported UNKNOWN -- not broken and
not an orphan -- and makes the run incomplete, because a crawl that did not
cover a page cannot prove anything about it.

Exit codes:
  0  every inventory page was reached and the evidence was complete
  1  the site failed the check (orphan or unreachable pages)
  2  invalid usage (nothing on stdout), or unreadable/incomplete evidence
     (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-pages', 'maxPages'],
  ['--max-links', 'maxLinks'],
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-include-depth', 'maxIncludeDepth'],
  ['--max-include-files', 'maxIncludeFiles'],
  ['--max-listed', 'maxListed'],
  ['--max-findings', 'maxFindings'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { capture: null, root: null, entries: [], json: false, limits: {} }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--capture') options.capture = takeValue('--capture')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--entry') options.entries.push(takeValue('--entry'))
    else if (LIMIT_FLAGS.has(argument)) {
      const raw = takeValue(argument)
      if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
        throw new Error(`${argument} requires a positive integer`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.capture === null) throw new Error('--capture is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    // A configuration error means the run never had a subject: stdout stays
    // empty so a consumer piping JSON never sees a fabricated report.
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  try {
    report = await analyzeCaptureFile({
      capture: options.capture,
      root: options.root ?? undefined,
      roots: options.entries.length > 0 ? options.entries : undefined,
      limits: options.limits,
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.unknownTargets} unknown link target(s), ${report.summary.unknownSources} unknown link source(s); the evidence does not support a pass.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))

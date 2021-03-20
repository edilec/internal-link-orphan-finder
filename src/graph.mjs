/**
 * Reachability over an explicit inventory.
 *
 * Breadth-first from the configured entry pages, over links whose BOTH
 * endpoints are pages the crawl actually inventoried. Every page result
 * carries a reason path: the real hop-by-hop route for a reachable page, and
 * the absence of any incoming link for an orphan.
 *
 * Three states are kept strictly apart, because conflating them is the classic
 * false positive of this whole category:
 *
 *   reachable   - a path from an entry page exists, and it is reported.
 *   orphan      - no inventory page links to it.
 *   unreachable - pages link to it, but none of those is itself reachable.
 *
 * A link target that is not in the inventory is none of the three. It is
 * UNKNOWN: the crawl did not cover it, so nothing is claimed about it, and the
 * run is reported incomplete rather than passed.
 */

import { byCodeUnit, makeFinding } from './rules.mjs'

function sortedUnique(values) {
  return [...new Set(values)].sort(byCodeUnit)
}

function bounded(values, limit) {
  return {
    listed: values.slice(0, limit),
    total: values.length,
    truncated: values.length > limit,
  }
}

/** Deduplicate pages by id, reporting every repeat at its own declaration site. */
function indexPages(pages) {
  const byId = new Map()
  const findings = []
  for (const page of pages) {
    if (byId.has(page.id)) {
      findings.push(
        makeFinding({
          ruleId: 'duplicate-page-id',
          message: `Page id is declared more than once; only the first declaration is analysed.`,
          file: page.source.file,
          pointer: page.source.pointer,
          evidence: page.id,
          suggestion: 'Give every inventory entry a unique id.',
        }),
      )
      continue
    }
    byId.set(page.id, page)
  }
  return { byId, findings }
}

/**
 * Split links into traversable edges and the three kinds of link that cannot
 * carry reachability: unknown source, unknown target, and self reference.
 */
function classifyLinks(links, pageIds) {
  const findings = []
  const outgoing = new Map()
  const incoming = new Map()
  const incomingUnknownSource = new Map()
  const counts = { unknownTargets: 0, unknownSources: 0, selfLinks: 0, edges: 0 }

  for (const link of links) {
    const knownFrom = pageIds.has(link.from)
    const knownTo = pageIds.has(link.to)

    if (!knownTo) {
      counts.unknownTargets += 1
      findings.push(
        makeFinding({
          ruleId: 'link-target-unknown',
          message:
            'Link target is not in the page inventory; the crawl did not cover it, so it is reported unknown, not broken and not an orphan.',
          file: link.source.file,
          pointer: link.source.pointer,
          evidence: `${link.from} -> ${link.to}`,
          suggestion: 'Add the target to the inventory, or narrow the crawl so the link is out of scope.',
        }),
      )
    }
    if (!knownFrom) {
      counts.unknownSources += 1
      findings.push(
        makeFinding({
          ruleId: 'link-source-unknown',
          message:
            'Link source page is not in the page inventory, so this link cannot carry reachability and the coverage of the crawl is unknown.',
          file: link.source.file,
          pointer: link.source.pointer,
          evidence: `${link.from} -> ${link.to}`,
          suggestion: 'Add the source page to the inventory so its outgoing links can be followed.',
        }),
      )
      if (knownTo) {
        incomingUnknownSource.set(link.to, (incomingUnknownSource.get(link.to) ?? 0) + 1)
      }
    }
    if (!knownFrom || !knownTo) continue

    if (link.from === link.to) {
      counts.selfLinks += 1
      findings.push(
        makeFinding({
          ruleId: 'self-link',
          message: 'Page links to itself; a self link never makes a page reachable and is not counted as an incoming link.',
          file: link.source.file,
          pointer: link.source.pointer,
          evidence: link.from,
        }),
      )
      continue
    }

    counts.edges += 1
    if (!outgoing.has(link.from)) outgoing.set(link.from, new Set())
    outgoing.get(link.from).add(link.to)
    if (!incoming.has(link.to)) incoming.set(link.to, new Set())
    incoming.get(link.to).add(link.from)
  }

  return { findings, outgoing, incoming, incomingUnknownSource, counts }
}

function resolveRoots(declaredRoots, byId) {
  const findings = []
  const usable = []
  const seen = new Set()
  for (const root of declaredRoots) {
    if (!byId.has(root.id)) {
      findings.push(
        makeFinding({
          ruleId: 'root-not-in-inventory',
          message: 'Configured entry page is not in the page inventory, so nothing can be reached through it.',
          file: root.source?.file,
          pointer: root.source?.pointer,
          evidence: root.id,
          suggestion: 'Use an entry page id that appears in the inventory.',
        }),
      )
      continue
    }
    if (seen.has(root.id)) continue
    seen.add(root.id)
    usable.push(root.id)
  }
  return { findings, usable: usable.sort(byCodeUnit) }
}

/**
 * Breadth-first search with a visited set, so a cycle is walked once and the
 * search terminates. Parents are recorded to rebuild the reason path.
 */
function breadthFirst(rootIds, outgoing) {
  const parent = new Map()
  const depth = new Map()
  const origin = new Map()
  const queue = []

  for (const rootId of rootIds) {
    if (depth.has(rootId)) continue
    depth.set(rootId, 0)
    parent.set(rootId, null)
    origin.set(rootId, rootId)
    queue.push(rootId)
  }

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]
    const targets = sortedUnique([...(outgoing.get(current) ?? [])])
    for (const target of targets) {
      if (depth.has(target)) continue
      depth.set(target, depth.get(current) + 1)
      parent.set(target, current)
      origin.set(target, origin.get(current))
      queue.push(target)
    }
  }
  return { parent, depth, origin }
}

function reasonPath(id, parent) {
  const path = []
  let current = id
  while (current !== undefined && current !== null) {
    path.push(current)
    current = parent.get(current)
  }
  return path.reverse()
}

/**
 * Weakly connected groups among the pages no entry page reaches. Group ids are
 * derived from the lowest-sorted member, so they are stable without a counter.
 */
function disconnectedGroups(unreachedIds, outgoing, incoming) {
  const remaining = new Set(unreachedIds)
  const groups = []

  for (const start of unreachedIds) {
    if (!remaining.has(start)) continue
    const members = []
    const queue = [start]
    remaining.delete(start)
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head]
      members.push(current)
      const neighbours = sortedUnique([
        ...(outgoing.get(current) ?? []),
        ...(incoming.get(current) ?? []),
      ])
      for (const neighbour of neighbours) {
        if (!remaining.has(neighbour)) continue
        remaining.delete(neighbour)
        queue.push(neighbour)
      }
    }
    members.sort(byCodeUnit)
    groups.push({ id: members[0], members })
  }
  groups.sort((left, right) => byCodeUnit(left.id, right.id))
  return groups
}

/**
 * Analyse an inventory. Pure: no filesystem, no clock, no locale.
 *
 * Returns findings (unsorted; the caller sorts) plus one result per inventory
 * page, each carrying its reason path.
 */
export function analyzeLinkGraph({ pages, links, declaredRoots, limits }) {
  const findings = []
  const { byId, findings: pageFindings } = indexPages(pages)
  findings.push(...pageFindings)

  const sortedIds = [...byId.keys()].sort(byCodeUnit)
  const classified = classifyLinks(links, byId)
  findings.push(...classified.findings)

  const { findings: rootFindings, usable: rootIds } = resolveRoots(declaredRoots, byId)
  findings.push(...rootFindings)

  const counts = {
    pages: sortedIds.length,
    links: links.length,
    edges: classified.counts.edges,
    roots: rootIds.length,
    reachable: 0,
    orphans: 0,
    unreachable: 0,
    groups: 0,
    unknownTargets: classified.counts.unknownTargets,
    unknownSources: classified.counts.unknownSources,
    selfLinks: classified.counts.selfLinks,
  }

  if (sortedIds.length === 0) {
    findings.push(
      makeFinding({
        ruleId: 'empty-inventory',
        message: 'The capture supplied no usable page inventory, so no page was examined and nothing can be concluded.',
        file: pages[0]?.source.file,
        suggestion: 'Supply a capture whose "pages" array lists the crawled pages.',
      }),
    )
    return { findings, results: [], counts }
  }

  if (rootIds.length === 0) {
    findings.push(
      makeFinding({
        ruleId: 'no-usable-root',
        message: 'No configured entry page is present in the inventory, so reachability could not be computed for any page.',
        suggestion: 'Pass --entry with a page id from the inventory, or declare "roots" in the capture.',
      }),
    )
    return { findings, results: [], counts }
  }

  const { parent, depth, origin } = breadthFirst(rootIds, classified.outgoing)
  const unreachedIds = sortedIds.filter((id) => !depth.has(id))
  const groups = disconnectedGroups(unreachedIds, classified.outgoing, classified.incoming)
  // A group is only a "disconnected group" when it holds more than one page;
  // a single page with no incoming link is an orphan, not a group.
  const groupOf = new Map()
  for (const group of groups) {
    if (group.members.length < 2) continue
    for (const member of group.members) groupOf.set(member, group.id)
  }
  counts.groups = groups.filter((group) => group.members.length > 1).length

  const results = []
  for (const id of sortedIds) {
    const page = byId.get(id)
    const incomingIds = sortedUnique([...(classified.incoming.get(id) ?? [])])
    const outgoingIds = sortedUnique([...(classified.outgoing.get(id) ?? [])])
    const unknownSourceCount = classified.incomingUnknownSource.get(id) ?? 0
    const listedIncoming = bounded(incomingIds, limits.maxListed)

    const base = {
      id,
      title: page.title ?? null,
      source: { file: page.source.file, pointer: page.source.pointer },
      incoming: listedIncoming.listed,
      incomingTotal: listedIncoming.total,
      incomingTruncated: listedIncoming.truncated,
      incomingFromUnknownSources: unknownSourceCount,
      outgoingTotal: outgoingIds.length,
    }

    if (depth.has(id)) {
      counts.reachable += 1
      const path = reasonPath(id, parent)
      const hops = depth.get(id)
      results.push({
        ...base,
        state: 'reachable',
        depth: hops,
        root: origin.get(id),
        path,
        group: null,
        reason:
          hops === 0
            ? `Configured entry page "${id}".`
            : `Reachable from entry page "${origin.get(id)}" in ${hops} hop(s): ${path.join(' -> ')}`,
      })
      continue
    }

    const group = groupOf.get(id) ?? null
    if (incomingIds.length === 0) {
      counts.orphans += 1
      const reason =
        unknownSourceCount === 0
          ? 'No page in the inventory links to it, so no path from any entry page can exist.'
          : `No page in the inventory links to it; ${unknownSourceCount} link(s) arrive from source pages the crawl did not inventory.`
      results.push({ ...base, state: 'orphan', depth: null, root: null, path: null, group, reason })
      findings.push(
        makeFinding({
          ruleId: 'orphan-page',
          message: `Orphan page: ${reason}`,
          file: page.source.file,
          pointer: page.source.pointer,
          evidence: id,
          suggestion: 'Link to the page from a page that is itself reachable, or remove it from the inventory.',
        }),
      )
      continue
    }

    counts.unreachable += 1
    const reason = `Linked from ${incomingIds.length} inventory page(s), none of which is reachable from an entry page: ${listedIncoming.listed.join(', ')}${listedIncoming.truncated ? ', ...' : ''}`
    results.push({ ...base, state: 'unreachable', depth: null, root: null, path: null, group, reason })
    findings.push(
      makeFinding({
        ruleId: 'unreachable-page',
        message: `Unreachable page: ${reason}`,
        file: page.source.file,
        pointer: page.source.pointer,
        evidence: id,
        suggestion: 'Link to this group from a reachable page, or add one of its pages as an entry page.',
      }),
    )
  }

  for (const group of groups) {
    if (group.members.length < 2) continue
    const listed = bounded(group.members, limits.maxListed)
    const anchor = byId.get(group.id)
    findings.push(
      makeFinding({
        ruleId: 'disconnected-group',
        message: `Disconnected group of ${group.members.length} page(s) that link only to each other: ${listed.listed.join(', ')}${listed.truncated ? ', ...' : ''}`,
        file: anchor.source.file,
        pointer: anchor.source.pointer,
        evidence: group.id,
        suggestion: 'One inbound link from a reachable page brings the whole group back into the site.',
      }),
    )
  }

  return { findings, results, counts }
}

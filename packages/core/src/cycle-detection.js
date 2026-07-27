/**
 * Circular mapping detection.
 *
 * A mapping is an edge between two (guild, role) nodes. The question this module
 * answers is: "would enabling this mapping create a chain that feeds a role back into
 * itself?"
 *
 * ## Why a two-way mapping is not a cycle
 *
 * A single TWO_WAY mapping between A and B is a 2-cycle in graph terms, but it is the
 * feature the community actually wants, and loop protection (single-use Redis markers)
 * is what makes it safe. Rejecting it would be wrong.
 *
 * What is genuinely dangerous is a loop built from *different* mappings:
 *
 *   - `A -> B` (mapping 1) plus `B -> A` (mapping 2): two independent authorities that
 *     can disagree, so each reconciliation can flip the state back and forth.
 *   - `A -> B -> C -> A`: an add propagates around the ring; every hop is a separate
 *     mapping with its own authority and priority.
 *
 * So a cycle is reported only when the path back to the origin uses at least one
 * mapping other than the candidate itself. That distinction is the whole point of this
 * module, and it is why the check is written here as a pure function over the mapping
 * list rather than inline in a service.
 */
import { MappingDirection } from '@frm/shared';

/** @param {string} guildId @param {string} roleId */
export function nodeKey(guildId, roleId) {
  return `${guildId}:${roleId}`;
}

/**
 * @typedef {object} MappingEdgeInput
 * @property {string} id
 * @property {string} name
 * @property {string} sourceGuildId
 * @property {string} sourceRoleId
 * @property {string} targetGuildId
 * @property {string} targetRoleId
 * @property {string} direction
 */

/**
 * Expands mappings into directed edges. A TWO_WAY mapping produces both directions,
 * each still labelled with the mapping it came from.
 *
 * @param {MappingEdgeInput[]} mappings
 * @returns {Map<string, Array<{to: string, mappingId: string, mappingName: string}>>}
 */
export function buildMappingGraph(mappings) {
  /** @type {Map<string, Array<{to: string, mappingId: string, mappingName: string}>>} */
  const graph = new Map();

  const addEdge = (from, to, mapping) => {
    const list = graph.get(from) ?? [];
    list.push({ to, mappingId: mapping.id, mappingName: mapping.name });
    graph.set(from, list);
  };

  for (const mapping of mappings) {
    const source = nodeKey(mapping.sourceGuildId, mapping.sourceRoleId);
    const target = nodeKey(mapping.targetGuildId, mapping.targetRoleId);
    addEdge(source, target, mapping);
    if (mapping.direction === MappingDirection.TWO_WAY) {
      addEdge(target, source, mapping);
    }
  }

  return graph;
}

/**
 * Would this candidate mapping close a loop?
 *
 * @param {MappingEdgeInput[]} existingMappings enabled mappings, excluding the candidate
 * @param {MappingEdgeInput} candidate
 * @param {(node: string) => string} [describe] renders a node for the error message
 * @returns {{cycle: boolean, chain?: string[], mappingIds?: string[]}}
 */
export function detectMappingCycle(existingMappings, candidate, describe = (node) => node) {
  const graph = buildMappingGraph([...existingMappings, candidate]);

  const source = nodeKey(candidate.sourceGuildId, candidate.sourceRoleId);
  const target = nodeKey(candidate.targetGuildId, candidate.targetRoleId);

  // A role mapped to itself is always a cycle, however it is dressed up.
  if (source === target) {
    return { cycle: true, chain: [describe(source), describe(target)], mappingIds: [candidate.id] };
  }

  // Walk forward from the candidate's target and see whether we can get back to its
  // source using at least one other mapping.
  const found = searchBack({
    graph,
    start: target,
    goal: source,
    candidateId: candidate.id,
  });

  if (!found) return { cycle: false };

  const chain = [describe(source), ...found.path.map(describe)];
  return {
    cycle: true,
    chain,
    mappingIds: [candidate.id, ...found.mappingIds.filter((id) => id !== candidate.id)],
  };
}

/**
 * Breadth-first search that records the path taken, so the error message can show the
 * operator the exact chain that conflicts rather than just "cycle detected".
 */
function searchBack({ graph, start, goal, candidateId }) {
  /** @type {Array<{node: string, path: string[], mappingIds: string[], usedOther: boolean}>} */
  const queue = [{ node: start, path: [start], mappingIds: [], usedOther: false }];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();

    // The same node can legitimately be revisited by a path that has used a different
    // set of mappings, so the visited key includes whether another mapping was used.
    const seenKey = `${current.node}|${current.usedOther}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    if (current.node === goal && current.usedOther) {
      return { path: current.path, mappingIds: current.mappingIds };
    }

    for (const edge of graph.get(current.node) ?? []) {
      // Never traverse the candidate's own reverse edge as the "other" mapping: a
      // single TWO_WAY mapping is legitimate.
      const usedOther = current.usedOther || edge.mappingId !== candidateId;
      queue.push({
        node: edge.to,
        path: [...current.path, edge.to],
        mappingIds: [...current.mappingIds, edge.mappingId],
        usedOther,
      });
    }
  }

  return null;
}

/**
 * Finds every mapping that already governs a target node, so the operator can be told
 * which existing mapping conflicts with the one they are creating.
 *
 * @param {MappingEdgeInput[]} mappings
 * @param {string} guildId
 * @param {string} roleId
 */
export function mappingsTargeting(mappings, guildId, roleId) {
  const key = nodeKey(guildId, roleId);
  return mappings.filter((mapping) => {
    if (nodeKey(mapping.targetGuildId, mapping.targetRoleId) === key) return true;
    return (
      mapping.direction === MappingDirection.TWO_WAY &&
      nodeKey(mapping.sourceGuildId, mapping.sourceRoleId) === key
    );
  });
}

/**
 * Circular mapping detection.
 *
 * The subtle requirement here: a single TWO_WAY mapping is a 2-cycle in graph terms but
 * is a legitimate, wanted configuration. Only loops built from *different* mappings are
 * dangerous, and those are what must be rejected.
 */
import { describe, expect, it } from 'vitest';
import { MappingDirection } from '@frm/shared';
import { buildMappingGraph, detectMappingCycle, mappingsTargeting } from '@frm/core';

const G1 = 'guild-1';
const G2 = 'guild-2';
const G3 = 'guild-3';
const A = 'role-a';
const B = 'role-b';
const C = 'role-c';

function mapping(
  id,
  sourceGuildId,
  sourceRoleId,
  targetGuildId,
  targetRoleId,
  direction = MappingDirection.ONE_WAY,
) {
  return { id, name: id, sourceGuildId, sourceRoleId, targetGuildId, targetRoleId, direction };
}

describe('legitimate configurations', () => {
  it('accepts a simple one-way mapping', () => {
    const result = detectMappingCycle([], mapping('m1', G1, A, G2, B));
    expect(result.cycle).toBe(false);
  });

  it('accepts a single two-way mapping', () => {
    // A TWO_WAY mapping produces edges in both directions. That is the feature, not a
    // loop: loop protection handles the echo, so it must not be rejected here.
    const result = detectMappingCycle([], mapping('m1', G1, A, G2, B, MappingDirection.TWO_WAY));
    expect(result.cycle).toBe(false);
  });

  it('accepts a fan-out from one source to several targets', () => {
    const existing = [mapping('m1', G1, A, G2, B)];
    const result = detectMappingCycle(existing, mapping('m2', G1, A, G3, C));
    expect(result.cycle).toBe(false);
  });

  it('accepts a fan-in from several sources to one target', () => {
    const existing = [mapping('m1', G1, A, G3, C)];
    const result = detectMappingCycle(existing, mapping('m2', G2, B, G3, C));
    expect(result.cycle).toBe(false);
  });

  it('accepts a chain that does not close', () => {
    const existing = [mapping('m1', G1, A, G2, B)];
    const result = detectMappingCycle(existing, mapping('m2', G2, B, G3, C));
    expect(result.cycle).toBe(false);
  });
});

describe('loops that must be rejected', () => {
  it('rejects a role mapped to itself', () => {
    const result = detectMappingCycle([], mapping('m1', G1, A, G1, A));
    expect(result.cycle).toBe(true);
  });

  it('rejects two opposing one-way mappings', () => {
    // A -> B and B -> A as separate mappings means two independent authorities that can
    // disagree, so reconciliation could flip the state back and forth forever.
    const existing = [mapping('m1', G1, A, G2, B)];
    const result = detectMappingCycle(existing, mapping('m2', G2, B, G1, A));
    expect(result.cycle).toBe(true);
    expect(result.mappingIds).toContain('m1');
  });

  it('rejects an indirect three-hop loop', () => {
    const existing = [mapping('m1', G1, A, G2, B), mapping('m2', G2, B, G3, C)];
    const result = detectMappingCycle(existing, mapping('m3', G3, C, G1, A));
    expect(result.cycle).toBe(true);
    expect(result.chain.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a loop closed through a two-way mapping', () => {
    const existing = [
      mapping('m1', G1, A, G2, B, MappingDirection.TWO_WAY),
      mapping('m2', G2, B, G3, C),
    ];
    const result = detectMappingCycle(existing, mapping('m3', G3, C, G1, A));
    expect(result.cycle).toBe(true);
  });

  it('reports a readable chain so the operator can see the conflict', () => {
    const existing = [mapping('m1', G1, A, G2, B)];
    const describe_ = (node) => `Guild ${node.split(':')[0]} / ${node.split(':')[1]}`;
    const result = detectMappingCycle(existing, mapping('m2', G2, B, G1, A), describe_);

    expect(result.cycle).toBe(true);
    expect(result.chain.join(' → ')).toContain('Guild guild-1 / role-a');
    expect(result.chain.join(' → ')).toContain('Guild guild-2 / role-b');
  });

  it('ignores disabled mappings, because only enabled ones are passed in', () => {
    // The service only ever supplies enabled mappings; a disabled one cannot close a
    // loop, and is re-checked when it is enabled.
    const result = detectMappingCycle([], mapping('m2', G2, B, G1, A));
    expect(result.cycle).toBe(false);
  });
});

describe('graph construction', () => {
  it('creates one edge for a one-way mapping and two for a two-way mapping', () => {
    const oneWay = buildMappingGraph([mapping('m1', G1, A, G2, B)]);
    expect(oneWay.get(`${G1}:${A}`)).toHaveLength(1);
    expect(oneWay.get(`${G2}:${B}`)).toBeUndefined();

    const twoWay = buildMappingGraph([mapping('m1', G1, A, G2, B, MappingDirection.TWO_WAY)]);
    expect(twoWay.get(`${G1}:${A}`)).toHaveLength(1);
    expect(twoWay.get(`${G2}:${B}`)).toHaveLength(1);
  });
});

describe('competing mappings', () => {
  it('finds every mapping that governs a target role', () => {
    const mappings = [
      mapping('m1', G1, A, G3, C),
      mapping('m2', G2, B, G3, C),
      mapping('m3', G3, C, G1, A, MappingDirection.TWO_WAY),
    ];
    const competing = mappingsTargeting(mappings, G3, C);
    expect(competing.map((entry) => entry.id).sort()).toEqual(['m1', 'm2', 'm3']);
  });
});

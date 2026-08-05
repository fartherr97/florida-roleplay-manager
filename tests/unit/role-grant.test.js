/**
 * Self-service role delegation - the authorization core.
 *
 * `resolveGrantableRoleIds` is the rule that decides what a member may hand out: a member
 * is authorized for a role only if they currently hold a grantor role mapped to it. It is
 * pure, so the whole authorization decision can be checked here without a database.
 */
import { describe, expect, it } from 'vitest';
import { resolveGrantableRoleIds } from '@frm/core';

const RULES = [
  { grantorRoleId: 'G1', grantableRoleId: 'A' },
  { grantorRoleId: 'G1', grantableRoleId: 'B' },
  { grantorRoleId: 'G2', grantableRoleId: 'C' },
];

describe('resolveGrantableRoleIds', () => {
  it('returns everything a single held grantor role maps to', () => {
    expect([...resolveGrantableRoleIds(RULES, ['G1'])].sort()).toEqual(['A', 'B']);
  });

  it('unions across every grantor role the member holds', () => {
    expect([...resolveGrantableRoleIds(RULES, ['G1', 'G2'])].sort()).toEqual(['A', 'B', 'C']);
  });

  it('grants nothing to a member who holds no grantor role', () => {
    expect(resolveGrantableRoleIds(RULES, ['X', 'Y']).size).toBe(0);
    expect(resolveGrantableRoleIds(RULES, []).size).toBe(0);
  });

  it('accepts a Set as well as an array', () => {
    expect([...resolveGrantableRoleIds(RULES, new Set(['G2']))]).toEqual(['C']);
  });

  it('never returns a role the rules do not map to a held grantor', () => {
    // Holding the grantable role itself does not authorize handing it out.
    expect(resolveGrantableRoleIds(RULES, ['A']).size).toBe(0);
  });
});

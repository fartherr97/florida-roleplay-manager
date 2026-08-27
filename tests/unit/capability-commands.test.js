/**
 * The capability → slash-command map that the website's access-tier editor renders must
 * stay complete. Every capability an operator can put in a tier (the globally-assignable
 * ones, minus access.manage which tiers never grant) should say what it lets someone do —
 * a slash command and a description, or a "(website)" entry for a capability with no
 * command. This test fails, and names the gap, if a new capability is added without one,
 * so the list can never silently drift out of date.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, PermissionScopeType } from '@frm/shared';

const TIER_EXCLUDED = new Set(['access.manage']);

const selectable = CAPABILITIES.filter(
  (capability) =>
    capability.allowedScopes.includes(PermissionScopeType.GLOBAL) && !TIER_EXCLUDED.has(capability.key),
);

describe('capability command catalogue', () => {
  it('gives every tier-selectable capability at least one command entry', () => {
    const missing = selectable.filter((capability) => !(capability.commands?.length > 0)).map((c) => c.key);
    expect(missing, `capabilities missing a command entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives every command entry a name and a description', () => {
    const malformed = [];
    for (const capability of CAPABILITIES) {
      for (const command of capability.commands ?? []) {
        if (typeof command.name !== 'string' || !command.name.trim()) malformed.push(`${capability.key}: missing name`);
        if (typeof command.description !== 'string' || !command.description.trim()) {
          malformed.push(`${capability.key}: "${command.name}" missing description`);
        }
      }
    }
    expect(malformed, malformed.join('; ')).toEqual([]);
  });
});

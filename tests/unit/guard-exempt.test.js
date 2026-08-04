/**
 * Allowlist-exemption rule.
 *
 * Two commands must run in a server that is not yet on the allowlist: `/guild register`
 * (how the first server gets approved) and `/setup department` (which registers the
 * server as part of provisioning it). Everything else must be refused there. This guards
 * that exactly those bootstrap holes exist, and no more.
 */
import { describe, expect, it } from 'vitest';
import { isAllowlistExempt } from '../../apps/bot/src/lib/guard.js';

describe('isAllowlistExempt', () => {
  it('exempts the bootstrap commands', () => {
    expect(isAllowlistExempt('guild', 'register')).toBe(true);
    expect(isAllowlistExempt('setup', 'department')).toBe(true);
    expect(isAllowlistExempt('setup', 'community')).toBe(true);
  });

  it('does not exempt any other /guild subcommand', () => {
    for (const sub of ['list', 'remove', 'settings', 'status']) {
      expect(isAllowlistExempt('guild', sub)).toBe(false);
    }
  });

  it('does not exempt other commands that could leak platform structure', () => {
    expect(isAllowlistExempt('role', 'manage')).toBe(false);
    expect(isAllowlistExempt('mapping', 'create')).toBe(false);
    expect(isAllowlistExempt('member', 'lookup')).toBe(false);
    expect(isAllowlistExempt('system', 'health')).toBe(false);
  });

  it('does not exempt a bare command with no subcommand', () => {
    expect(isAllowlistExempt('guild', null)).toBe(false);
    expect(isAllowlistExempt('setup')).toBe(false);
  });
});

/**
 * Allowlist-exemption rule.
 *
 * `/guild register` is the one command that must run in a server that is not yet on the
 * allowlist - it is how the first server ever gets approved. Everything else must be
 * refused there. This guards that exactly one bootstrap hole exists, and no more.
 */
import { describe, expect, it } from 'vitest';
import { isAllowlistExempt } from '../../apps/bot/src/lib/guard.js';

describe('isAllowlistExempt', () => {
  it('exempts /guild register so the first server can be added', () => {
    expect(isAllowlistExempt('guild', 'register')).toBe(true);
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

  it('does not exempt a bare /guild with no subcommand', () => {
    expect(isAllowlistExempt('guild', null)).toBe(false);
    expect(isAllowlistExempt('guild')).toBe(false);
  });
});

/**
 * The stay-or-leave decision for a guild that is not on the allowlist.
 *
 * This is the rule that lets an operator onboard a new server: with auto-leave off the
 * bot must stay so `/setup department` can approve the server, and with it on the bot
 * must leave. Development mode always stays, whatever the setting says.
 */
import { describe, expect, it } from 'vitest';
import { shouldStayInUnapprovedGuild } from '@frm/core';

describe('shouldStayInUnapprovedGuild', () => {
  it('leaves only when auto-leave is on and not in development mode', () => {
    expect(shouldStayInUnapprovedGuild({ devMode: false, autoLeave: true })).toBe(false);
  });

  it('stays when auto-leave is off (the onboarding case)', () => {
    expect(shouldStayInUnapprovedGuild({ devMode: false, autoLeave: false })).toBe(true);
  });

  it('stays in development mode regardless of the setting', () => {
    expect(shouldStayInUnapprovedGuild({ devMode: true, autoLeave: true })).toBe(true);
    expect(shouldStayInUnapprovedGuild({ devMode: true, autoLeave: false })).toBe(true);
  });
});

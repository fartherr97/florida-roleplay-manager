/**
 * Discord role hierarchy and protection pre-flight.
 *
 * These are the failures that actually happen in production: somebody drags the bot's
 * role down the list, deletes a role, or maps a booster role. Each must produce a
 * specific, actionable message rather than a generic API error.
 */
import { describe, expect, it } from 'vitest';
import { MockRoleGateway, assertRoleMappable, checkRoleOperation } from '@frm/discord';
import { ProtectionLevel, SyncIssueType } from '@frm/shared';

const GUILD = '910000000000000010';
const MEMBER = '930000000000000010';
const ROLE = '920000000000000010';

function gatewayWith(overrides = {}) {
  const gateway = new MockRoleGateway();
  gateway.defineGuild({ id: GUILD, botHighestRolePosition: 50, ...overrides.guild });
  gateway.defineRole(GUILD, { id: ROLE, name: 'Deputy', position: 10, ...overrides.role });
  if (overrides.withMember !== false) gateway.defineMember(GUILD, { id: MEMBER });
  return gateway;
}

const base = { discordGuildId: GUILD, discordUserId: MEMBER, discordRoleId: ROLE };

describe('checkRoleOperation', () => {
  it('passes for a normal role the bot can manage', async () => {
    const result = await checkRoleOperation(gatewayWith(), base);
    expect(result.ok).toBe(true);
  });

  it('fails when the bot is not in the guild', async () => {
    const gateway = new MockRoleGateway();
    const result = await checkRoleOperation(gateway, base);
    expect(result.ok).toBe(false);
    expect(result.issueType).toBe(SyncIssueType.BOT_NOT_IN_GUILD);
  });

  it('fails when the guild is unavailable, and marks it retryable', async () => {
    const result = await checkRoleOperation(gatewayWith({ guild: { available: false } }), base);
    expect(result.ok).toBe(false);
    expect(result.issueType).toBe(SyncIssueType.GUILD_UNAVAILABLE);
    expect(result.retryable).toBe(true);
  });

  it('fails when the bot lacks Manage Roles', async () => {
    const result = await checkRoleOperation(
      gatewayWith({ guild: { botCanManageRoles: false } }),
      base,
    );
    expect(result.ok).toBe(false);
    expect(result.issueType).toBe(SyncIssueType.BOT_MISSING_PERMISSION);
    expect(result.retryable).toBe(false);
  });

  it('fails when the member is not in the guild', async () => {
    const result = await checkRoleOperation(gatewayWith({ withMember: false }), base);
    expect(result.ok).toBe(false);
    expect(result.issueType).toBe(SyncIssueType.MEMBER_NOT_IN_GUILD);
  });

  it('fails when the role has been deleted', async () => {
    const gateway = gatewayWith();
    gateway.deleteRole(GUILD, ROLE);
    const result = await checkRoleOperation(gateway, base);
    expect(result.ok).toBe(false);
    expect(result.issueType).toBe(SyncIssueType.ROLE_DELETED);
  });

  it('refuses the @everyone role', async () => {
    const gateway = gatewayWith();
    const result = await checkRoleOperation(gateway, { ...base, discordRoleId: GUILD });
    expect(result.ok).toBe(false);
    expect(result.issueType).toBe(SyncIssueType.INVALID_ROLE_REFERENCE);
  });

  it('refuses a role owned by another integration', async () => {
    const result = await checkRoleOperation(gatewayWith({ role: { managed: true } }), base);
    expect(result.ok).toBe(false);
    expect(result.issueType).toBe(SyncIssueType.INTEGRATION_MANAGED_ROLE);
  });

  it('refuses a role above the bot highest role', async () => {
    const result = await checkRoleOperation(gatewayWith({ role: { position: 80 } }), base);
    expect(result.ok).toBe(false);
    expect(result.issueType).toBe(SyncIssueType.ROLE_ABOVE_BOT);
    expect(result.message).toMatch(/Server Settings/i);
  });

  it('refuses a role at exactly the bot own position', async () => {
    // Discord requires strictly higher, so equal positions cannot be managed either.
    const result = await checkRoleOperation(gatewayWith({ role: { position: 50 } }), base);
    expect(result.ok).toBe(false);
    expect(result.issueType).toBe(SyncIssueType.ROLE_ABOVE_BOT);
  });

  it('refuses a protected role unless the caller is allowed', async () => {
    const denied = await checkRoleOperation(gatewayWith(), {
      ...base,
      protectionLevel: ProtectionLevel.ELEVATED,
    });
    expect(denied.ok).toBe(false);
    expect(denied.issueType).toBe(SyncIssueType.PROTECTED_ROLE_VIOLATION);

    const allowed = await checkRoleOperation(gatewayWith(), {
      ...base,
      protectionLevel: ProtectionLevel.ELEVATED,
      allowProtected: true,
    });
    expect(allowed.ok).toBe(true);
  });
});

describe('assertRoleMappable', () => {
  const mapBase = { discordGuildId: GUILD, discordRoleId: ROLE, side: 'source' };

  it('returns the role when it can be mapped', async () => {
    const role = await assertRoleMappable(gatewayWith(), mapBase);
    expect(role.name).toBe('Deputy');
  });

  it('explains a missing bot', async () => {
    await expect(assertRoleMappable(new MockRoleGateway(), mapBase)).rejects.toThrow(
      /bot is not in the source/i,
    );
  });

  it('explains a missing Manage Roles permission', async () => {
    await expect(
      assertRoleMappable(gatewayWith({ guild: { botCanManageRoles: false } }), mapBase),
    ).rejects.toThrow(/Manage Roles/i);
  });

  it('explains a hierarchy problem with the fix', async () => {
    await expect(
      assertRoleMappable(gatewayWith({ role: { position: 90 } }), mapBase),
    ).rejects.toThrow(/above the bot's highest role/i);
  });

  it('refuses an integration-owned role', async () => {
    await expect(
      assertRoleMappable(gatewayWith({ role: { managed: true } }), mapBase),
    ).rejects.toThrow(/another integration/i);
  });

  it('refuses @everyone', async () => {
    await expect(
      assertRoleMappable(gatewayWith(), { ...mapBase, discordRoleId: GUILD }),
    ).rejects.toThrow(/@everyone/i);
  });

  it('refuses a protected role without elevated authorization', async () => {
    await expect(
      assertRoleMappable(gatewayWith(), { ...mapBase, protectionLevel: ProtectionLevel.ELEVATED }),
    ).rejects.toThrow(/protected role/i);
  });
});

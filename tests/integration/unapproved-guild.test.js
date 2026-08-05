/**
 * Auto-leave of unapproved guilds, end to end.
 *
 * `handleUnapprovedGuildJoin` reads the `guild.autoLeaveUnapproved` setting from the
 * database and, when auto-leave is on, tells the gateway to leave. The important case is
 * the inverse: with the setting off, the bot must stay so an administrator can invite it
 * and approve the server. The test environment forces DEV_MODE on (which always stays),
 * so each case runs with development mode explicitly turned off.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { handleUnapprovedGuildJoin } from '@frm/core';
import { AuditAction, resetEnvCache } from '@frm/shared';
import { closeQueues, closeRedis } from '@frm/queue';
import { disconnectPrisma } from '@frm/database';
import { isPostgresAvailable, isRedisAvailable } from '../helpers/services.js';
import {
  buildMockGateway,
  disconnectTestPrisma,
  resetDatabase,
  seedCommunity,
  testPrisma,
} from '../helpers/fixtures.js';

const available = (await isPostgresAvailable()) && (await isRedisAvailable());

const NEW_GUILD = '910000000000000011';

/** Runs a function with DEV_MODE forced off, then restores the test environment. */
async function withDevModeOff(fn) {
  const previous = process.env.DEV_MODE;
  process.env.DEV_MODE = 'false';
  resetEnvCache();
  try {
    return await fn();
  } finally {
    process.env.DEV_MODE = previous;
    resetEnvCache();
  }
}

async function setAutoLeave(value) {
  await testPrisma().systemSetting.upsert({
    where: { key: 'guild.autoLeaveUnapproved' },
    create: { key: 'guild.autoLeaveUnapproved', value },
    update: { value },
  });
}

describe.skipIf(!available)('handleUnapprovedGuildJoin', () => {
  let gateway;

  beforeEach(async () => {
    await resetDatabase();
    await seedCommunity();
    gateway = buildMockGateway();
  });

  afterAll(async () => {
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await disconnectTestPrisma();
  });

  it('leaves the guild when auto-leave is on', async () => {
    await setAutoLeave(true);

    const result = await withDevModeOff(() =>
      handleUnapprovedGuildJoin({ discordGuildId: NEW_GUILD, name: 'Some Server', gateway }),
    );

    expect(result.left).toBe(true);
    expect(gateway.leftGuilds).toContain(NEW_GUILD);
  });

  it('stays in the guild when auto-leave is off', async () => {
    await setAutoLeave(false);

    const result = await withDevModeOff(() =>
      handleUnapprovedGuildJoin({ discordGuildId: NEW_GUILD, name: 'Some Server', gateway }),
    );

    expect(result.left).toBe(false);
    expect(result.reason).toBe('auto-leave disabled');
    expect(gateway.leftGuilds).not.toContain(NEW_GUILD);
  });

  it('records an audit entry either way', async () => {
    await setAutoLeave(false);

    await withDevModeOff(() =>
      handleUnapprovedGuildJoin({ discordGuildId: NEW_GUILD, name: 'Some Server', gateway }),
    );

    const audit = await testPrisma().auditLog.findFirst({
      where: { action: AuditAction.GUILD_UNAPPROVED_JOIN },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
  });
});

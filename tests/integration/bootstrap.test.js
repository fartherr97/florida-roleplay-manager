/**
 * Root-administrator reconciliation.
 *
 * The behaviour that matters: every id in GLOBAL_ADMIN_DISCORD_IDS ends up a global
 * administrator holding *every* capability - including any added after the last seed -
 * and running it again is harmless. This is what lets a freshly shipped capability reach
 * the root administrators on the next bot boot without a separate re-seed.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileGlobalAdmins } from '@frm/core';
import { CAPABILITIES } from '@frm/shared';
import { disconnectPrisma } from '@frm/database';
import { isPostgresAvailable } from '../helpers/services.js';
import { disconnectTestPrisma, resetDatabase, testPrisma } from '../helpers/fixtures.js';

const available = await isPostgresAvailable();
const ADMIN_ID = '930000000000000077';

describe.skipIf(!available)('reconcileGlobalAdmins', () => {
  let prisma;

  beforeEach(async () => {
    await resetDatabase();
    prisma = testPrisma();
  });

  afterAll(async () => {
    await disconnectPrisma().catch(() => {});
    await disconnectTestPrisma();
  });

  it('makes a configured id a global admin holding every capability', async () => {
    const result = await reconcileGlobalAdmins({
      prisma,
      env: { GLOBAL_ADMIN_DISCORD_IDS: [ADMIN_ID] },
    });

    expect(result.admins).toBe(1);
    // The catalogue is populated even on a database that was never seeded.
    expect(await prisma.permissionCapability.count()).toBe(CAPABILITIES.length);

    const identity = await prisma.discordIdentity.findUnique({
      where: { discordUserId: ADMIN_ID },
      include: { user: { include: { permissions: true } } },
    });
    expect(identity.user.permissionLevel).toBe(100);

    const keys = identity.user.permissions.map((assignment) => assignment.capabilityKey);
    expect(keys).toHaveLength(CAPABILITIES.length);
    expect(keys).toContain('guild.provision');
  });

  it('is idempotent and un-revokes a capability that was taken away', async () => {
    const env = { GLOBAL_ADMIN_DISCORD_IDS: [ADMIN_ID] };
    await reconcileGlobalAdmins({ prisma, env });

    await prisma.permissionAssignment.updateMany({
      where: { capabilityKey: 'guild.provision' },
      data: { revokedAt: new Date() },
    });

    await reconcileGlobalAdmins({ prisma, env });

    const grant = await prisma.permissionAssignment.findFirst({
      where: { capabilityKey: 'guild.provision' },
    });
    expect(grant.revokedAt).toBeNull();
  });

  it('does nothing when no root administrators are configured', async () => {
    const result = await reconcileGlobalAdmins({ prisma, env: { GLOBAL_ADMIN_DISCORD_IDS: [] } });
    expect(result.admins).toBe(0);
    expect(await prisma.user.count()).toBe(0);
  });
});

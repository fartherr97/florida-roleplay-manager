/**
 * API surface: authentication, CSRF, scoping and error hygiene.
 *
 * The point of these is that the website boundary enforces exactly the same rules as
 * the Discord boundary, because both call the same services - and that the transport
 * level protections (session, CSRF, secure headers, sanitized errors) are actually
 * wired up rather than merely configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeQueues, closeRedis, getRedis } from '@frm/queue';
import { disconnectPrisma } from '@frm/database';
import { REDIS_PREFIX } from '@frm/shared';
import { buildApp } from '../../apps/api/src/app.js';
import { isPostgresAvailable, isRedisAvailable } from '../helpers/services.js';
import {
  IDS,
  disconnectTestPrisma,
  resetDatabase,
  seedCommunity,
  testPrisma,
} from '../helpers/fixtures.js';

const available = (await isPostgresAvailable()) && (await isRedisAvailable());

describe.skipIf(!available)('REST API', () => {
  let app;
  let fixtures;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  beforeEach(async () => {
    await resetDatabase();
    fixtures = await seedCommunity();
  });

  afterAll(async () => {
    await app?.close();
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await disconnectTestPrisma();
  });

  /** Creates a real Redis session and returns the cookie header plus the CSRF token. */
  async function signIn(userId, discordUserId) {
    const id = randomUUID();
    const csrfToken = randomUUID();
    await getRedis().set(
      `${REDIS_PREFIX.SESSION}:${id}`,
      JSON.stringify({ userId, discordUserId, csrfToken }),
      'EX',
      3600,
    );
    const signed = app.signCookie(id);
    return { cookie: `frm_session=${signed}`, csrfToken };
  }

  const asAdmin = () => signIn(fixtures.users.admin.id, IDS.D_ADMIN);
  const asGuildAdmin = () => signIn(fixtures.users.guildAdmin.id, IDS.D_GUILD_ADMIN);

  // -------------------------------------------------------------------------
  describe('public endpoints', () => {
    it('serves liveness without a session', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('reports readiness of both dependencies', async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json().checks).toEqual({ database: true, redis: true });
    });

    it('sets secure headers', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBeDefined();
      expect(response.headers['x-request-id']).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('authentication', () => {
    it('refuses an unauthenticated request', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/me' });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('refuses a forged session cookie', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: 'frm_session=not-a-signed-value' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('serves the profile for a valid session', async () => {
      const { cookie } = await asGuildAdmin();
      const response = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.user.displayName).toBe('HCSO Administrator');
      expect(body.capabilities.some((entry) => entry.capability === 'mapping.create')).toBe(true);
      // The scope travels with the capability, so a website can render the same limits.
      expect(
        body.capabilities.every((entry) => entry.scopeId === fixtures.guilds.hcsoGuild.id),
      ).toBe(true);
    });

    it('refuses a member whose website access has been withdrawn', async () => {
      await testPrisma().user.update({
        where: { id: fixtures.users.guildAdmin.id },
        data: { websiteAccess: false },
      });

      const { cookie } = await asGuildAdmin();
      const response = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

      // Re-loaded on every request, so revocation is immediate rather than waiting for
      // the session to expire.
      expect(response.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  describe('CSRF protection', () => {
    it('refuses an unsafe request without the token', async () => {
      const { cookie } = await asAdmin();
      const response = await app.inject({
        method: 'POST',
        url: '/api/sync/member',
        headers: { cookie },
        payload: { discordUserId: IDS.D_MEMBER },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.message).toMatch(/csrf/i);
    });

    it('refuses a request with the wrong token', async () => {
      const { cookie } = await asAdmin();
      const response = await app.inject({
        method: 'POST',
        url: '/api/sync/member',
        headers: { cookie, 'x-csrf-token': randomUUID() },
        payload: { discordUserId: IDS.D_MEMBER },
      });
      expect(response.statusCode).toBe(401);
    });

    it('accepts a request carrying the matching token', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const response = await app.inject({
        method: 'POST',
        url: '/api/sync/member',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { discordUserId: IDS.D_MEMBER, dryRun: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().job.type).toBe('MEMBER_RESYNC');
    });

    it('does not require a token for safe methods', async () => {
      const { cookie } = await asAdmin();
      const response = await app.inject({
        method: 'GET',
        url: '/api/guilds',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('authorization is enforced server side', () => {
    it('refuses an action on a guild outside the actor scope', async () => {
      const { cookie, csrfToken } = await asGuildAdmin();

      // The guild administrator is scoped to HCSO; the identifier here is FHP's.
      // Supplying it directly from the client must not widen their authority.
      const response = await app.inject({
        method: 'POST',
        url: '/api/roles',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: {
          guildId: fixtures.guilds.fhpGuild.id,
          discordRoleId: IDS.R_FHP_MEMBER,
          name: 'Department Member',
          reason: 'attempting to act outside my guild',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    });

    it('refuses to act on somebody at or above the actor authority', async () => {
      const { cookie, csrfToken } = await asGuildAdmin();

      const response = await app.inject({
        method: 'POST',
        url: '/api/grants',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: {
          discordUserId: IDS.D_ADMIN,
          managedRoleId: fixtures.managedRoles.grantable.id,
          reason: 'targeting an administrator',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('refuses guild registration by a non-administrator', async () => {
      const { cookie, csrfToken } = await asGuildAdmin();
      const response = await app.inject({
        method: 'POST',
        url: '/api/guilds',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: {
          discordGuildId: '888888888888888888',
          name: 'My Own Server',
          type: 'OTHER',
          reason: 'trying to attach my server',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('scopes a listing to what the actor may see', async () => {
      const { cookie } = await asGuildAdmin();
      const response = await app.inject({
        method: 'GET',
        url: '/api/roles',
        headers: { cookie },
      });

      expect(response.statusCode).toBe(200);
      const { items } = response.json();
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((role) => role.guild.id === fixtures.guilds.hcsoGuild.id)).toBe(true);
    });

    it('allows an authorized action and returns the new state', async () => {
      const { cookie, csrfToken } = await asGuildAdmin();
      const response = await app.inject({
        method: 'POST',
        url: '/api/grants',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: {
          discordUserId: IDS.D_MEMBER,
          managedRoleId: fixtures.managedRoles.grantable.id,
          reason: 'temporary investigation access',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.grant.managedRoleId).toBe(fixtures.managedRoles.grantable.id);
      expect(body.syncJob.type).toBe('GRANT_CHANGE');
    });
  });

  // -------------------------------------------------------------------------
  describe('input validation and error hygiene', () => {
    it('rejects a malformed identifier without touching the database', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const response = await app.inject({
        method: 'POST',
        url: '/api/roles',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: {
          guildId: 'not-a-uuid',
          discordRoleId: 'not-a-snowflake',
          name: '',
          reason: 'malformed',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    });

    it('never returns a stack trace or an internal message', async () => {
      const { cookie } = await asAdmin();
      const response = await app.inject({
        method: 'GET',
        url: '/api/mappings/00000000-0000-4000-8000-000000000000',
        headers: { cookie },
      });

      expect(response.statusCode).toBe(404);
      const body = response.body;
      expect(body).not.toMatch(/at Object\./);
      expect(body).not.toMatch(/node_modules/);
      expect(body).not.toMatch(/prisma/i);
      expect(response.json().requestId).toBeDefined();
    });

    it('echoes a caller supplied request id for correlation', async () => {
      const requestId = randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': requestId },
      });
      expect(response.headers['x-request-id']).toBe(requestId);
    });

    it('returns 404 for an unknown endpoint', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  describe('listing and pagination', () => {
    it('returns a paginated envelope', async () => {
      const { cookie } = await asAdmin();
      const response = await app.inject({
        method: 'GET',
        url: '/api/guilds?page=1&pageSize=2',
        headers: { cookie },
      });

      const body = response.json();
      expect(body.items).toHaveLength(2);
      expect(body.pagination).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
      expect(body.pagination.hasNext).toBe(true);
    });

    it('caps an oversized page size instead of trusting it', async () => {
      const { cookie } = await asAdmin();
      const response = await app.inject({
        method: 'GET',
        url: '/api/guilds?pageSize=100000',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(400);
    });

    it('refuses to sort by an arbitrary column', async () => {
      const { cookie } = await asAdmin();
      const response = await app.inject({
        method: 'GET',
        url: '/api/guilds?sortBy=discordGuildId',
        headers: { cookie },
      });
      // Only allowlisted sort fields are accepted, so a client cannot order by (and
      // thereby infer) a column it is not meant to read.
      expect(response.statusCode).toBe(400);
    });
  });

  describe('public roster endpoints', () => {
    /** A published roster with one ranked member, built directly. */
    async function seedRoster({ published = true } = {}) {
      const prisma = testPrisma();
      const roster = await prisma.roster.create({
        data: {
          slug: 'staff',
          name: 'Staff Team',
          approvedGuildId: fixtures.guilds.mainGuild.id,
          published,
        },
      });
      const rank = await prisma.rosterRank.create({
        data: {
          rosterId: roster.id,
          discordRoleId: '940000000000000001',
          name: 'Senior Administrator',
          shortName: 'Sr. Admin',
          position: 30,
        },
      });
      await prisma.rosterMembership.create({
        data: {
          rosterId: roster.id,
          discordUserId: IDS.D_MEMBER,
          userId: fixtures.users.member.id,
          rankId: rank.id,
          callsign: '165',
          displayName: 'Mike',
          managedNickname: '165 | Sr. Admin | Mike',
        },
      });
      return roster;
    }

    it('serves a roster without a session, because a roster page is public', async () => {
      await seedRoster();

      const response = await app.inject({ method: 'GET', url: '/api/rosters/staff' });

      expect(response.statusCode).toBe(200);
      const { roster } = response.json();
      expect(roster.ranks[0].members[0]).toMatchObject({ name: 'Mike', callsign: '165' });
    });

    it('exposes nothing beyond what the roster page shows', async () => {
      await seedRoster();

      const response = await app.inject({ method: 'GET', url: '/api/rosters/staff' });
      const body = response.payload;

      // The response is public, so internal identifiers must not travel with it - an
      // unauthenticated caller learning platform user ids would be a real leak.
      expect(body).not.toContain(fixtures.users.member.id);
      expect(body).not.toContain('managedNickname');
      expect(body).not.toContain('userId');
    });

    it('does not serve an unpublished roster', async () => {
      await seedRoster({ published: false });

      const response = await app.inject({ method: 'GET', url: '/api/rosters/staff' });
      expect(response.statusCode).toBe(404);

      const list = await app.inject({ method: 'GET', url: '/api/rosters' });
      expect(list.json().rosters).toEqual([]);
    });

    it('answers 304 when the caller already has the current roster', async () => {
      await seedRoster();

      const first = await app.inject({ method: 'GET', url: '/api/rosters' });
      const etag = first.headers.etag;
      expect(etag).toBeTruthy();
      expect(first.headers['cache-control']).toContain('max-age=');

      const second = await app.inject({
        method: 'GET',
        url: '/api/rosters',
        headers: { 'if-none-match': etag },
      });
      expect(second.statusCode).toBe(304);
    });

    it('still requires a session for the management endpoints', async () => {
      await seedRoster();

      const response = await app.inject({ method: 'GET', url: '/api/rosters/manage' });
      expect(response.statusCode).toBe(401);
    });
  });
});

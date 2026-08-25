/**
 * The Discord role catalogue.
 *
 * This is the API's only route to Discord, and it exists so the dashboard can offer a role
 * picker instead of a box you paste snowflakes into. The cases that matter are the ones
 * that decide what the picker shows: `assignable`, which is the difference between a
 * binding that works and one that silently does nothing, and the caching, which is what
 * stops a dashboard rendering four pickers from making four round trips.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordRoleCatalog } from '../../packages/discord/src/role-catalog.js';

const GUILD = '900000000000000001';
const BOT_APP = '800000000000000001';

/** Roles as Discord returns them: unsorted, `@everyone` included, position 0 at the bottom. */
function discordRoles() {
  return [
    { id: '901', name: 'Moderator', position: 5, color: 3447003, managed: false },
    { id: GUILD, name: '@everyone', position: 0, color: 0, managed: false },
    { id: '904', name: 'Owner', position: 40, color: 0, managed: false },
    { id: '902', name: 'Administrator', position: 10, color: 15158332, managed: false },
    { id: '903', name: 'FLRP Bot', position: 20, color: 0, managed: true },
  ];
}

/** A REST double that records its calls. */
function fakeRest({ roles = discordRoles(), botRoles = ['903'], memberFails = false } = {}) {
  const calls = [];
  return {
    calls,
    async get(route) {
      calls.push(route);
      if (route.includes('/members/')) {
        if (memberFails) throw Object.assign(new Error('missing access'), { code: 50001 });
        return { roles: botRoles };
      }
      return roles;
    },
  };
}

describe('DiscordRoleCatalog', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('drops @everyone and orders the rest highest first', async () => {
    const catalog = new DiscordRoleCatalog({ applicationId: BOT_APP, rest: fakeRest() });

    const { roles } = await catalog.listRoles(GUILD);

    expect(roles.map((role) => role.name)).toEqual([
      'Owner',
      'FLRP Bot',
      'Administrator',
      'Moderator',
    ]);
    expect(roles.some((role) => role.id === GUILD)).toBe(false);
  });

  it('marks a role assignable only when it sits below the bot', async () => {
    const catalog = new DiscordRoleCatalog({ applicationId: BOT_APP, rest: fakeRest() });

    const { roles, botHighestPosition } = await catalog.listRoles(GUILD);
    const byName = Object.fromEntries(roles.map((role) => [role.name, role]));

    expect(botHighestPosition).toBe(20);
    expect(byName.Administrator.assignable).toBe(true); // 10 < 20
    expect(byName.Moderator.assignable).toBe(true); // 5 < 20
    expect(byName.Owner.assignable).toBe(false); // 40 > 20: the classic failure
  });

  it('never marks an integration-managed role assignable', async () => {
    // The bot's own role is below nothing, but Discord refuses to let anybody assign a
    // managed role - so offering it in a picker would be offering a guaranteed failure.
    const catalog = new DiscordRoleCatalog({
      applicationId: BOT_APP,
      rest: fakeRest({ botRoles: ['904'] }), // bot is at the very top
    });

    const { roles } = await catalog.listRoles(GUILD);
    const bot = roles.find((role) => role.name === 'FLRP Bot');

    expect(bot.managed).toBe(true);
    expect(bot.assignable).toBe(false);
  });

  it('degrades to nothing-assignable when the bot member cannot be read', async () => {
    // Better a picker that admits it does not know than no picker at all.
    const catalog = new DiscordRoleCatalog({
      applicationId: BOT_APP,
      rest: fakeRest({ memberFails: true }),
    });

    const { roles, botHighestPosition } = await catalog.listRoles(GUILD);

    expect(botHighestPosition).toBe(0);
    expect(roles.every((role) => role.assignable === false)).toBe(true);
    expect(roles).toHaveLength(4); // the list itself still came back
  });

  it('serves a second read from cache', async () => {
    const rest = fakeRest();
    const catalog = new DiscordRoleCatalog({ applicationId: BOT_APP, rest });

    await catalog.listRoles(GUILD);
    await catalog.listRoles(GUILD);

    expect(rest.calls.filter((route) => route.endsWith('/roles'))).toHaveLength(1);
  });

  it('collapses concurrent cold reads into one request', async () => {
    const rest = fakeRest();
    const catalog = new DiscordRoleCatalog({ applicationId: BOT_APP, rest });

    await Promise.all([
      catalog.listRoles(GUILD),
      catalog.listRoles(GUILD),
      catalog.listRoles(GUILD),
    ]);

    expect(rest.calls.filter((route) => route.endsWith('/roles'))).toHaveLength(1);
  });

  it('refetches when forced, and after invalidate', async () => {
    const rest = fakeRest();
    const catalog = new DiscordRoleCatalog({ applicationId: BOT_APP, rest });

    await catalog.listRoles(GUILD);
    await catalog.listRoles(GUILD, { force: true });
    catalog.invalidate(GUILD);
    await catalog.listRoles(GUILD);

    expect(rest.calls.filter((route) => route.endsWith('/roles'))).toHaveLength(3);
  });

  it('does not cache a failure', async () => {
    // A cached rejection would poison the picker for the whole TTL after one blip.
    let attempt = 0;
    const rest = {
      async get(route) {
        if (route.endsWith('/roles')) {
          attempt += 1;
          if (attempt === 1) throw Object.assign(new Error('gateway'), { status: 500 });
          return discordRoles();
        }
        return { roles: ['903'] };
      },
    };
    const catalog = new DiscordRoleCatalog({ applicationId: BOT_APP, rest });

    await expect(catalog.listRoles(GUILD)).rejects.toThrow();
    const { roles } = await catalog.listRoles(GUILD);

    expect(roles).toHaveLength(4);
  });

  it('expires the cache after its TTL', async () => {
    const rest = fakeRest();
    const catalog = new DiscordRoleCatalog({ applicationId: BOT_APP, rest, ttlMs: 1000 });

    await catalog.listRoles(GUILD);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 1500);
    await catalog.listRoles(GUILD);

    expect(rest.calls.filter((route) => route.endsWith('/roles'))).toHaveLength(2);
  });

  it('skips the member lookup entirely without an application id', async () => {
    const rest = fakeRest();
    const catalog = new DiscordRoleCatalog({ rest });

    const { botHighestPosition } = await catalog.listRoles(GUILD);

    expect(botHighestPosition).toBe(0);
    expect(rest.calls.some((route) => route.includes('/members/'))).toBe(false);
  });

  it('translates a Discord failure into the platform taxonomy', async () => {
    const rest = {
      async get() {
        throw Object.assign(new Error('unknown guild'), { code: 10004 });
      },
    };
    const catalog = new DiscordRoleCatalog({ applicationId: BOT_APP, rest });

    await expect(catalog.listRoles(GUILD)).rejects.toMatchObject({
      userMessage: expect.stringContaining('no longer in that Discord server'),
    });
  });
});

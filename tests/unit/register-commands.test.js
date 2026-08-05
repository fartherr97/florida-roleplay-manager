/**
 * Slash-command registration routing.
 *
 * The bot registers commands on every boot, so the guild-vs-global decision is
 * boot-critical: guild scope must be chosen (and hit the guild route) whenever
 * DEV_GUILD_IDS is set, global otherwise, and an impossible request must throw rather
 * than silently register nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const put = vi.fn(async () => {});

vi.mock('discord.js', () => ({
  REST: class {
    setToken() {
      return this;
    }
    put(...args) {
      return put(...args);
    }
  },
  Routes: {
    applicationGuildCommands: (appId, guildId) => `guild:${appId}:${guildId}`,
    applicationCommands: (appId) => `global:${appId}`,
  },
}));

vi.mock('../../apps/bot/src/commands/index.js', () => ({
  commandPayload: () => [{ name: 'role' }, { name: 'guild' }],
}));

const { registerCommands, registerGuildCommands } =
  await import('../../apps/bot/src/lib/register.js');

const baseEnv = { DISCORD_BOT_TOKEN: 'token', DISCORD_CLIENT_ID: '111111111111111111' };

describe('registerCommands', () => {
  beforeEach(() => put.mockClear());

  it('registers per guild, instantly, when DEV_GUILD_IDS is set', async () => {
    const result = await registerCommands({
      env: { ...baseEnv, DEV_GUILD_IDS: ['222222222222222222', '333333333333333333'] },
    });

    expect(result).toEqual({
      scope: 'guild',
      count: 2,
      guildIds: ['222222222222222222', '333333333333333333'],
    });
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenNthCalledWith(1, 'guild:111111111111111111:222222222222222222', {
      body: [{ name: 'role' }, { name: 'guild' }],
    });
  });

  it('registers globally when no guilds are configured', async () => {
    const result = await registerCommands({ env: { ...baseEnv, DEV_GUILD_IDS: [] } });

    expect(result.scope).toBe('global');
    expect(put).toHaveBeenCalledExactlyOnceWith('global:111111111111111111', {
      body: [{ name: 'role' }, { name: 'guild' }],
    });
  });

  it('honours an explicit global request even when guilds are configured', async () => {
    const result = await registerCommands({
      env: { ...baseEnv, DEV_GUILD_IDS: ['222222222222222222'] },
      perGuild: false,
    });

    expect(result.scope).toBe('global');
    expect(put).toHaveBeenCalledExactlyOnceWith('global:111111111111111111', expect.anything());
  });

  it('throws rather than register nothing when guild scope is forced with no guilds', async () => {
    await expect(
      registerCommands({ env: { ...baseEnv, DEV_GUILD_IDS: [] }, perGuild: true }),
    ).rejects.toThrow(/DEV_GUILD_IDS is empty/i);
    expect(put).not.toHaveBeenCalled();
  });

  it('registers the boot union of DEV_GUILD_IDS and currently-joined guilds', async () => {
    const result = await registerCommands({
      env: { ...baseEnv, DEV_GUILD_IDS: ['222222222222222222'] },
      guildIds: ['222222222222222222', '444444444444444444'],
    });

    expect(result.guildIds).toEqual(['222222222222222222', '444444444444444444']);
    expect(put).toHaveBeenCalledTimes(2);
  });
});

describe('registerGuildCommands', () => {
  beforeEach(() => put.mockClear());

  it('registers the command set in a single newly joined guild', async () => {
    const result = await registerGuildCommands({
      env: baseEnv,
      guildIds: ['555555555555555555'],
    });

    expect(result).toEqual({ scope: 'guild', count: 2, guildIds: ['555555555555555555'] });
    expect(put).toHaveBeenCalledExactlyOnceWith('guild:111111111111111111:555555555555555555', {
      body: [{ name: 'role' }, { name: 'guild' }],
    });
  });

  it('ignores empty and duplicate guild ids', async () => {
    const result = await registerGuildCommands({
      env: baseEnv,
      guildIds: ['555555555555555555', '555555555555555555', '', null],
    });

    expect(result.guildIds).toEqual(['555555555555555555']);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

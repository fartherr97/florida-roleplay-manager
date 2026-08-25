/**
 * Listing a guild's Discord roles for the dashboard.
 *
 * The website has to bind Discord roles to things — roster ranks, access tiers, managed
 * roles, mappings — and every one of those bindings is a snowflake. Without this the only
 * possible UI is a text box and a nineteen-digit number copied out of Discord by hand.
 *
 * The guild is resolved from the platform's own id and checked against the actor's scope
 * before anything reaches Discord, so this exposes no server the caller could not already
 * see. That ordering is the point: a caller-supplied Discord snowflake is never passed
 * through, because it would let anybody enumerate the roles of any guild the bot happens
 * to be in.
 */
import { getRoleCatalog } from '@frm/discord';
import { PreconditionError, getEnv } from '@frm/shared';
import { authorize } from '@frm/authorization';
import { resolveApprovedGuild } from './resolve.js';

/**
 * Lists the Discord roles in an approved guild, highest first.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} params
 * @param {string} params.guildId the platform's ApprovedGuild id, not a Discord snowflake
 * @param {boolean} [params.refresh] bypass the short-lived cache
 * @param {object} [deps]
 * @param {object} [deps.catalog] injected catalogue, for tests
 * @returns {Promise<{guildId: string, discordGuildId: string, roles: object[],
 *   botHighestPosition: number, cachedAt: string}>}
 */
export async function listGuildDiscordRoles(ctx, { guildId, refresh = false }, { catalog } = {}) {
  const guild = await resolveApprovedGuild(ctx, guildId);

  authorize(ctx.actor, { capability: 'guild.view', scope: { guildId: guild.id } });

  const env = getEnv();

  // The bot token is not a hard requirement of the API process - it boots and serves
  // everything else without one - so an absent token is a configuration answer, not a
  // crash. Saying which variable is missing costs nothing and saves an afternoon.
  if (!catalog && !env.DISCORD_BOT_TOKEN) {
    throw new PreconditionError(
      'This API cannot read Discord roles because DISCORD_BOT_TOKEN is not set on it. Add ' +
        'the bot token to the API service and restart it.',
    );
  }

  const source = catalog ?? getRoleCatalog({ env });
  const result = await source.listRoles(guild.discordGuildId, { force: refresh });

  return {
    guildId: guild.id,
    discordGuildId: guild.discordGuildId,
    ...result,
  };
}

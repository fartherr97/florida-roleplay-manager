/**
 * The command gate.
 *
 * Every interaction passes through here before a command runs:
 *
 *   1. it must come from inside a guild
 *   2. that guild must be on the approved allowlist and enabled
 *   3. the Discord account must be linked to a platform member
 *   4. the member must be within their command rate limit
 *
 * Slash-command visibility is *not* a security control - Discord will happily deliver a
 * command to the bot regardless of what the client showed - so the real authorization
 * check still happens inside each `@frm/core` service call. This gate exists to fail
 * fast with a useful message, not to be the last line of defence.
 */
import { MessageFlags } from 'discord.js';
import { createLogger } from '@frm/logging';
import { discordContext, isGuildApproved, resolveDiscordActor } from '@frm/core';
import { getRedis } from '@frm/queue';
import { REDIS_PREFIX, RateLimitError, newRequestId } from '@frm/shared';
import { errorEmbed, renderError } from './ui.js';

const log = createLogger('bot.guard');

/** Per-user command rate limit: 20 commands per minute. */
const RATE_LIMIT = { max: 20, windowSeconds: 60 };

/**
 * Commands allowed to run in a guild that is not (yet) on the allowlist.
 *
 * Registering a server is how the very first guild ever gets onto the allowlist, and
 * provisioning a department server registers it as part of the flow - neither can require
 * an already-approved guild without an inescapable chicken and egg. This only skips the
 * fail-fast allowlist gate; the real check, that the caller is a global administrator,
 * still runs inside `registerGuild` and `provisionDepartment`.
 */
const ALLOWLIST_EXEMPT = new Set(['guild register', 'setup department', 'setup community']);

/**
 * Whether a command may run before its guild is on the allowlist.
 * @param {string} commandName
 * @param {string|null} [subcommand]
 */
export function isAllowlistExempt(commandName, subcommand = null) {
  return ALLOWLIST_EXEMPT.has([commandName, subcommand].filter(Boolean).join(' '));
}

/** The subcommand of an interaction, or null when it has none. */
function subcommandOf(interaction) {
  try {
    return interaction.options.getSubcommand(false);
  } catch {
    return null;
  }
}

/**
 * @param {import('discord.js').Interaction} interaction
 * @param {{gateway?: object}} [deps] the gateway, used to read the caller's main-guild roles
 *   for Discord-role-driven access tiers
 * @returns {Promise<{ok: false} | {ok: true, ctx: object, requestId: string}>}
 */
export async function guardInteraction(interaction, { gateway } = {}) {
  const requestId = newRequestId();

  if (!interaction.inGuild()) {
    await reply(
      interaction,
      errorEmbed(
        'Server only',
        'Florida Roleplay Manager commands can only be used inside an approved Discord server.',
      ),
    );
    return { ok: false };
  }

  // The allowlist gate is skipped only for the bootstrap command that creates the very
  // first approval. Everything else is refused fast in an unapproved guild.
  if (!isAllowlistExempt(interaction.commandName, subcommandOf(interaction))) {
    const approved = await isGuildApproved(interaction.guildId);
    if (!approved) {
      // Deliberately terse: an unapproved server does not get to learn about the
      // platform's structure.
      await reply(
        interaction,
        errorEmbed(
          'Server not approved',
          'This Discord server is not approved for the Florida Roleplay Manager platform. ' +
            'Contact a global administrator if you believe this is a mistake.',
        ),
      );
      log.warn(
        { discordGuildId: interaction.guildId, command: interaction.commandName },
        'command refused in unapproved guild',
      );
      return { ok: false };
    }
  }

  try {
    await enforceRateLimit(interaction.user.id);
  } catch (error) {
    await reply(interaction, renderError(error, requestId));
    return { ok: false };
  }

  try {
    // Discord-role access tiers are layered on here: `resolveDiscordActor` reads the
    // caller's live main-guild roles (via the gateway) and raises the actor accordingly,
    // auto-provisioning an account for an unlinked role-holder.
    const actor = await resolveDiscordActor({
      discordUserId: interaction.user.id,
      displayName:
        interaction.member?.displayName ??
        interaction.user?.globalName ??
        interaction.user?.username ??
        null,
      gateway,
    });
    const ctx = discordContext(actor, { requestId, discordGuildId: interaction.guildId });
    return { ok: true, ctx, requestId };
  } catch (error) {
    await reply(interaction, renderError(error, requestId));
    return { ok: false };
  }
}

/**
 * Sliding-window-ish counter in Redis. If Redis is unavailable the command is allowed:
 * losing rate limiting is a much smaller problem than the whole bot going down, and the
 * authorization checks are unaffected.
 */
async function enforceRateLimit(discordUserId) {
  try {
    const redis = getRedis();
    const key = `${REDIS_PREFIX.COMMAND_RATE}:${discordUserId}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RATE_LIMIT.windowSeconds);
    if (count > RATE_LIMIT.max) {
      const ttl = await redis.ttl(key);
      throw new RateLimitError(Math.max(ttl, 1) * 1000);
    }
  } catch (error) {
    if (error?.code === 'RATE_LIMITED') throw error;
    log.warn({ err: error?.message }, 'rate limit check unavailable; allowing command');
  }
}

async function reply(interaction, embed) {
  if (!interaction.isRepliable()) return;
  const payload = { embeds: [embed], flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed] }).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
}

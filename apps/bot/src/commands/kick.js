/**
 * `/kick` — kick a member from the in-game server WITHOUT the 30-minute rejoin lockout.
 *
 * A normal kick (txAdmin, the chat filter) locks the player out for 30 minutes. This command
 * calls the game server's bypass endpoint (flrp_api `POST /kick`), which drops them cleanly so
 * they can rejoin immediately — for routine kicks that are not a punishment. The player is
 * found by their Discord id, so they must be online with it linked. Staff only
 * (KICK_ALLOWED_ROLE_IDS, default the Server Staff Team); authorized by the command itself,
 * so it runs without a linked bot actor — the guild allowlist and rate limit still apply.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getEnv } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { errorEmbed, successEmbed, truncate } from '../lib/ui.js';
import { memberOption } from '../lib/options.js';
import { memberRoleIds } from '../lib/mikeTodo.js';

const log = createLogger('bot.kick');

// Authorized by the command itself (staff roles), not by the bot's actor model.
export const actorExempt = true;

/** Staff allowed to kick. Override with KICK_ALLOWED_ROLE_IDS. */
const DEFAULT_KICK_ROLE_IDS = [
  '1534380749304889384', // Server Staff Team
];

export const data = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a member from the game server without the 30-minute rejoin lockout')
  .setDMPermission(false)
  .addUserOption(memberOption(true, 'member', 'The member to kick (must be in-game)'))
  .addStringOption((option) =>
    option
      .setName('reason')
      .setDescription('Shown to the player on the kick screen')
      .setRequired(false)
      .setMaxLength(200),
  )
  .addBooleanOption((option) =>
    option
      .setName('lockout')
      .setDescription('Apply the normal 30-minute rejoin lockout instead (default: no lockout)')
      .setRequired(false),
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const env = getEnv();

  const allowed = env.KICK_ALLOWED_ROLE_IDS?.length ? env.KICK_ALLOWED_ROLE_IDS : DEFAULT_KICK_ROLE_IDS;
  const held = new Set(memberRoleIds(interaction));
  if (!allowed.some((id) => held.has(id))) {
    return interaction.editReply({
      embeds: [errorEmbed('Staff only', 'Only staff can kick players from the game server.')],
    });
  }

  if (!env.FIVEM_API_URL || !env.FIVEM_API_SECRET) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Kick unavailable',
          'The game-server connection is not configured yet. Ask an administrator to set ' +
            '`FIVEM_API_URL` and `FIVEM_API_SECRET`.',
        ),
      ],
    });
  }

  const target = interaction.options.getUser('member');
  const reason = interaction.options.getString('reason') || 'Kicked by staff';
  const lockout = interaction.options.getBoolean('lockout') ?? false;

  let res;
  let body = null;
  try {
    res = await fetch(new URL('/flrp_api/kick', env.FIVEM_API_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-flrp-secret': env.FIVEM_API_SECRET,
      },
      // The game server resolves a bare Discord id against the online players' identifiers.
      body: JSON.stringify({ target: target.id, reason, bypass: !lockout }),
      signal: AbortSignal.timeout(8000),
    });
    body = await res.json().catch(() => null);
  } catch (error) {
    log.warn({ err: serializeError(error) }, 'kick request to game server failed');
    return interaction.editReply({
      embeds: [errorEmbed('Could not reach the game server', 'It did not answer. Try again in a moment.')],
    });
  }

  if (res.status === 404 && body?.error === 'player_not_online') {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Player not in-game',
          `<@${target.id}> is not online with a linked Discord account right now, so there is nothing to kick.`,
        ),
      ],
    });
  }
  if (!res.ok || !body?.ok) {
    log.warn({ status: res.status, error: body?.error }, 'game server rejected kick');
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Kick failed',
          body?.error === 'api_not_configured' || body?.error === 'bad_secret' || body?.error === 'missing_secret'
            ? 'The game server refused the request — the shared secret does not match. An admin should check `FIVEM_API_SECRET`.'
            : `The game server responded ${res.status}${body?.error ? ` (${body.error})` : ''}.`,
        ),
      ],
    });
  }

  return interaction.editReply({
    embeds: [
      successEmbed(
        lockout ? 'Kicked (with lockout)' : 'Kicked — no lockout',
        `Kicked **${body.kicked ?? target.username}** (<@${target.id}>) from the game server.`,
        [
          { name: 'Reason', value: truncate(reason, 1024) },
          {
            name: 'Rejoin',
            value: lockout ? 'Locked out for 30 minutes.' : 'They can rejoin immediately.',
          },
        ],
      ),
    ],
  });
}

/**
 * `/bgcheck` — a member's disciplinary record, folded and posted as an embed.
 *
 * The community website owns disciplinary records, so this command does not read a database:
 * it asks the website for the member's folded record and posts the embed the website builds,
 * which is the same one the DA Hub renders — one renderer, so Discord and the site can never
 * show a different history. The website also authorizes the *caller*: it is answered only
 * when the person who ran the command holds `discipline.view`, exactly as the hub requires.
 *
 * By default the result is ephemeral (only the caller sees it, because a record is sensitive);
 * `public: true` posts it into the channel instead.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getEnv } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { errorEmbed } from '../lib/ui.js';
import { memberOption } from '../lib/options.js';

const log = createLogger('bot.bgcheck');

export const data = new SlashCommandBuilder()
  .setName('bgcheck')
  .setDescription("Show a member's disciplinary record (verbal + non-verbal, last 6 months)")
  .addUserOption(memberOption(true, 'member', 'The member to run a background check on'))
  .addBooleanOption((option) =>
    option
      .setName('public')
      .setDescription('Post it in the channel for everyone (default: only you can see it)')
      .setRequired(false),
  );

export async function execute(interaction) {
  const target = interaction.options.getUser('member');
  const isPublic = interaction.options.getBoolean('public') ?? false;

  // Always work ephemerally first: a permission denial or an error stays private, and a
  // public check is posted as a follow-up only once we actually have a record to show.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const env = getEnv();
  if (!env.WEBSITE_API_URL || !env.WEBSITE_BOT_TOKEN) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Background checks are unavailable',
          'The website connection is not configured yet. Ask an administrator to set ' +
            '`WEBSITE_API_URL` and `WEBSITE_BOT_TOKEN`.',
        ),
      ],
    });
  }

  // A display name for the embed title, best-effort — the id is enough on its own.
  const displayName = await interaction.guild?.members
    .fetch(target.id)
    .then((member) => member.displayName)
    .catch(() => target.username);

  let result;
  try {
    result = await fetchBackground(env, {
      targetId: target.id,
      actorId: interaction.user.id,
      name: displayName ?? target.username,
    });
  } catch (error) {
    log.warn({ err: serializeError(error) }, 'bgcheck lookup failed');
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Could not run the check',
          'The website did not answer. Try again in a moment.',
        ),
      ],
    });
  }

  if (result.forbidden) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Not permitted',
          "You don't have permission to run background checks. This needs the same access as " +
            'the DA Hub.',
        ),
      ],
    });
  }

  const payload = result.message;
  if (!payload?.embeds?.length) {
    return interaction.editReply({
      embeds: [errorEmbed('No record', 'The website returned nothing to show.')],
    });
  }

  if (isPublic) {
    // Post the record into the channel, and quietly confirm to the caller.
    await interaction.followUp(payload);
    return interaction.editReply({ content: 'Background check posted in the channel. ✅' });
  }

  return interaction.editReply(payload);
}

/**
 * Asks the website for a member's folded record and its embed.
 *
 * @returns {Promise<{forbidden?: true, message?: object}>}
 */
async function fetchBackground(env, { targetId, actorId, name }) {
  const url = new URL(`/api/discipline/bot/background/${targetId}`, env.WEBSITE_API_URL);
  url.searchParams.set('actor', actorId);
  if (name) url.searchParams.set('name', name);

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env.WEBSITE_BOT_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 403) return { forbidden: true };
  if (!res.ok) throw new Error(`website responded ${res.status}`);

  const data = await res.json();
  return { message: data.message };
}

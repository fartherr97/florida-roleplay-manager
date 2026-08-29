/**
 * `/email` — an email on file for a community member.
 *
 * The website owns the record (so it can show the directory and join it to the roster),
 * exactly like `/bgcheck`: this command does not touch a database, it calls the website
 * API authenticated by the shared bot token.
 *
 *   add    — set YOUR OWN email. Anyone may. Must be a Gmail address; a non-Gmail gets a
 *            red error and nothing is stored.
 *   check  — a member's email on file. Restricted: the website answers only a caller who
 *            is on the staff team, a department head, or Directorship+.
 *   search — which member an email belongs to. Same restriction as check.
 *
 * Authorized by the website (for check/search) rather than the bot's actor model, so it
 * runs without a linked bot account; the guild allowlist and rate limit still apply.
 */
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getEnv } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { buildEmbed, errorEmbed, successEmbed } from '../lib/ui.js';
import { memberOption } from '../lib/options.js';

const log = createLogger('bot.email');

export const actorExempt = true;

/** Only Gmail addresses are accepted, per the community's requirement. */
const GMAIL_RE = /^[a-zA-Z0-9._%+-]+@gmail\.com$/i;

export const data = new SlashCommandBuilder()
  .setName('email')
  .setDescription('Add or look up an email on file')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add or update your own email on file (Gmail only)')
      .addStringOption((option) =>
        option
          .setName('address')
          .setDescription('Your @gmail.com address')
          .setRequired(true)
          .setMaxLength(320),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('check')
      .setDescription("Look up a member's email on file (staff, dept head or Directorship)")
      .addUserOption(memberOption(true, 'member', 'The member (or paste their Discord ID)')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('search')
      .setDescription('Find which member an email belongs to (staff, dept head or Directorship)')
      .addStringOption((option) =>
        option.setName('address').setDescription('The email to search for').setRequired(true).setMaxLength(320),
      ),
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const env = getEnv();
  if (!env.WEBSITE_API_URL || !env.WEBSITE_BOT_TOKEN) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Email records unavailable',
          'The website connection is not configured yet. Ask an administrator to set ' +
            '`WEBSITE_API_URL` and `WEBSITE_BOT_TOKEN`.',
        ),
      ],
    });
  }

  const sub = interaction.options.getSubcommand();
  try {
    if (sub === 'add') return await handleAdd(interaction, env);
    if (sub === 'check') return await handleCheck(interaction, env);
    if (sub === 'search') return await handleSearch(interaction, env);
    return undefined;
  } catch (error) {
    log.warn({ err: serializeError(error), sub }, 'email command failed');
    return interaction.editReply({
      embeds: [errorEmbed('Could not do that', 'The website did not answer. Try again in a moment.')],
    });
  }
}

async function handleAdd(interaction, env) {
  const email = interaction.options.getString('address').trim();
  if (!GMAIL_RE.test(email)) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          'Gmail required',
          `\`${email}\` is not a Gmail address. You must use a **@gmail.com** email address.`,
        ),
      ],
    });
  }

  const name =
    interaction.member?.displayName ?? interaction.user?.globalName ?? interaction.user?.username ?? null;

  const res = await fetch(new URL('/api/emails/bot', env.WEBSITE_API_URL), {
    method: 'POST',
    headers: { authorization: `Bearer ${env.WEBSITE_BOT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ discordId: interaction.user.id, email, name }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 400) {
    return interaction.editReply({
      embeds: [errorEmbed('Gmail required', 'You must use a **@gmail.com** email address.')],
    });
  }
  if (!res.ok) throw new Error(`website responded ${res.status}`);

  const data = await res.json();
  return interaction.editReply({
    embeds: [
      successEmbed(
        data.updated ? 'Email updated' : 'Email saved',
        `Your email on file is now **${email}**.`,
        data.previous ? [{ name: 'Previously', value: data.previous, inline: true }] : [],
      ),
    ],
  });
}

async function handleCheck(interaction, env) {
  const target = interaction.options.getUser('member');
  const url = new URL(`/api/emails/bot/${target.id}`, env.WEBSITE_API_URL);
  url.searchParams.set('actor', interaction.user.id);

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env.WEBSITE_BOT_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 403) {
    return interaction.editReply({
      embeds: [
        errorEmbed('Not permitted', "Looking up a member's email is for staff, department heads and Directorship."),
      ],
    });
  }
  if (!res.ok) throw new Error(`website responded ${res.status}`);

  const data = await res.json();
  if (!data.email) {
    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: 'No email on file',
          description: `<@${target.id}> has not added an email.`,
          color: 'neutral',
        }),
      ],
    });
  }

  const fields = [];
  if (data.updatedAt) {
    fields.push({
      name: 'Updated',
      value: `<t:${Math.floor(new Date(data.updatedAt).getTime() / 1000)}:R>`,
      inline: true,
    });
  }
  if (Array.isArray(data.history) && data.history.length) {
    fields.push({ name: 'Previous', value: data.history.slice(0, 5).map((h) => h.email).join('\n') });
  }
  return interaction.editReply({
    embeds: [
      buildEmbed({ title: 'Email on file', description: `<@${target.id}> — **${data.email}**`, fields, color: 'info' }),
    ],
  });
}

async function handleSearch(interaction, env) {
  const email = interaction.options.getString('address').trim();
  const url = new URL('/api/emails/bot/search', env.WEBSITE_API_URL);
  url.searchParams.set('email', email);
  url.searchParams.set('actor', interaction.user.id);

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env.WEBSITE_BOT_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 403) {
    return interaction.editReply({
      embeds: [errorEmbed('Not permitted', 'Searching emails is for staff, department heads and Directorship.')],
    });
  }
  if (!res.ok) throw new Error(`website responded ${res.status}`);

  const data = await res.json();
  if (!data.found) {
    return interaction.editReply({
      embeds: [buildEmbed({ title: 'No match', description: `No member has **${email}** on file.`, color: 'neutral' })],
    });
  }
  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: 'Email match',
        description: `**${email}** belongs to <@${data.discordId}>`,
        fields: [
          { name: 'Discord ID', value: `\`${data.discordId}\``, inline: true },
          ...(data.name ? [{ name: 'Name', value: data.name, inline: true }] : []),
        ],
        color: 'info',
      }),
    ],
  });
}

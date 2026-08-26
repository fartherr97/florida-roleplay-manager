/**
 * Interaction routing.
 *
 * One place where every command, autocomplete request and stray component interaction
 * arrives, so the guard and the error handling cannot be bypassed by forgetting them in
 * an individual command.
 */
import { MessageFlags } from 'discord.js';
import { createLogger, serializeError } from '@frm/logging';
import { decideWhitelist, discordContext, recordFailure, resolveDiscordActor } from '@frm/core';
import { AuditAction, newRequestId } from '@frm/shared';
import { commands } from './commands/index.js';
import { guardInteraction } from './lib/guard.js';
import { handleAutocomplete } from './lib/autocomplete.js';
import { renderError, respond } from './lib/ui.js';

const log = createLogger('bot.interactions');

/**
 * @param {import('discord.js').Interaction} interaction
 * @param {{gateway: object}} deps
 */
export async function handleInteraction(interaction, { gateway }) {
  if (interaction.isAutocomplete()) {
    const guard = await guardAutocomplete(interaction, { gateway });
    if (!guard) return;
    return handleAutocomplete(interaction, { ctx: guard.ctx, gateway });
  }

  // The whitelist review buttons must work indefinitely — hours later, across bot
  // restarts — so they are routed here by their custom id rather than by an in-memory
  // collector like the interactive commands use.
  if (interaction.isButton() && interaction.customId?.startsWith('wl:')) {
    return handleWhitelistButton(interaction, { gateway });
  }

  if (!interaction.isChatInputCommand()) {
    // Other buttons and select menus are handled by the collectors that created them;
    // anything else arriving here is a stale component from a previous bot process.
    return undefined;
  }

  const command = commands.get(interaction.commandName);
  if (!command) {
    log.warn({ command: interaction.commandName }, 'unknown command');
    return undefined;
  }

  const guard = await guardInteraction(interaction, {
    gateway,
    requireActor: command.actorExempt !== true,
  });
  if (!guard.ok) return undefined;

  const { ctx, requestId } = guard;
  const started = Date.now();
  // An actor-exempt command (e.g. /bgcheck) has no bot actor; fall back to the raw
  // interaction user for logging, and skip the actor-scoped audit write.
  const actorId = ctx?.actor?.user?.id ?? interaction.user.id;

  try {
    await command.execute(interaction, { ctx, gateway });
    log.info(
      {
        command: interaction.commandName,
        subcommand: safeSubcommand(interaction),
        actor: actorId,
        discordGuildId: interaction.guildId,
        durationMs: Date.now() - started,
        requestId,
      },
      'command completed',
    );
  } catch (error) {
    log.warn(
      {
        command: interaction.commandName,
        subcommand: safeSubcommand(interaction),
        actor: actorId,
        requestId,
        err: serializeError(error),
      },
      'command failed',
    );

    // A denied or failed command is itself worth auditing: an audit trail of only
    // successes cannot answer "who keeps trying to do this?". Only when there is an
    // actor to attribute it to — an actor-exempt command has none.
    if (ctx) {
      await recordFailure(ctx, {
        action: AuditAction.AUTH_DENIED,
        error,
        reason: `${interaction.commandName} ${safeSubcommand(interaction) ?? ''}`.trim(),
      }).catch(() => {});
    }

    await respond(interaction, renderError(error, requestId)).catch(() => {});
  }

  return undefined;
}

/**
 * A staff Approve/Deny click on a whitelist review message.
 *
 * The custom id is `wl:<approve|deny>:<submissionId>`. The reviewer's actor is built from
 * their live roles and the service authorizes them; approving assigns the whitelist role.
 * Every reply is ephemeral, and the handler never throws into the command path.
 */
async function handleWhitelistButton(interaction, { gateway }) {
  const [, decision, submissionId] = (interaction.customId ?? '').split(':');
  if ((decision !== 'approve' && decision !== 'deny') || !submissionId) return undefined;

  const requestId = newRequestId();

  let ctx;
  try {
    const actor = await resolveDiscordActor({
      discordUserId: interaction.user.id,
      displayName:
        interaction.member?.displayName ?? interaction.user?.globalName ?? interaction.user?.username ?? null,
      gateway,
    });
    ctx = discordContext(actor, { requestId, discordGuildId: interaction.guildId });
  } catch {
    await interaction
      .reply({
        content: 'Your Discord account is not linked to a platform member, so you cannot review this.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return undefined;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

  try {
    const result = await decideWhitelist(ctx, { submissionId, decision }, { gateway });
    let content;
    if (result.alreadyHandled) {
      content = `This application was already ${String(result.status).toLowerCase()}.`;
    } else if (decision === 'approve') {
      content = result.roleResult?.assigned
        ? 'Approved — the whitelist role was assigned.'
        : `Approved, but the role was not assigned: ${result.roleResult?.message ?? 'unknown error'}`;
    } else {
      content = 'Application denied.';
    }
    await interaction.editReply({ content }).catch(() => {});
  } catch (error) {
    log.warn({ err: serializeError(error), submissionId, requestId }, 'whitelist decision failed');
    await interaction
      .editReply({ content: error?.userMessage ?? error?.message ?? 'That could not be processed.' })
      .catch(() => {});
  }
  return undefined;
}

/**
 * Autocomplete needs an actor for scope filtering but must never reply with an error
 * embed: Discord only accepts a choice list here. Failures degrade to an empty list.
 */
async function guardAutocomplete(interaction, { gateway } = {}) {
  try {
    if (!interaction.inGuild()) {
      await interaction.respond([]);
      return null;
    }
    const guard = await guardInteraction(interaction, { gateway });
    if (!guard.ok) {
      await interaction.respond([]).catch(() => {});
      return null;
    }
    return guard;
  } catch {
    await interaction.respond([]).catch(() => {});
    return null;
  }
}

function safeSubcommand(interaction) {
  try {
    return interaction.options.getSubcommand(false);
  } catch {
    return null;
  }
}

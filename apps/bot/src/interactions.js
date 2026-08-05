/**
 * Interaction routing.
 *
 * One place where every command, autocomplete request and stray component interaction
 * arrives, so the guard and the error handling cannot be bypassed by forgetting them in
 * an individual command.
 */
import { createLogger, serializeError } from '@frm/logging';
import { recordFailure } from '@frm/core';
import { AuditAction } from '@frm/shared';
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

  if (!interaction.isChatInputCommand()) {
    // Buttons and select menus are handled by the collectors that created them; anything
    // arriving here is a stale component from a previous bot process.
    return undefined;
  }

  const command = commands.get(interaction.commandName);
  if (!command) {
    log.warn({ command: interaction.commandName }, 'unknown command');
    return undefined;
  }

  const guard = await guardInteraction(interaction, { gateway });
  if (!guard.ok) return undefined;

  const { ctx, requestId } = guard;
  const started = Date.now();

  try {
    await command.execute(interaction, { ctx, gateway });
    log.info(
      {
        command: interaction.commandName,
        subcommand: safeSubcommand(interaction),
        actor: ctx.actor.user.id,
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
        actor: ctx.actor.user.id,
        requestId,
        err: serializeError(error),
      },
      'command failed',
    );

    // A denied or failed command is itself worth auditing: an audit trail of only
    // successes cannot answer "who keeps trying to do this?".
    await recordFailure(ctx, {
      action: AuditAction.AUTH_DENIED,
      error,
      reason: `${interaction.commandName} ${safeSubcommand(interaction) ?? ''}`.trim(),
    }).catch(() => {});

    await respond(interaction, renderError(error, requestId)).catch(() => {});
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

/**
 * Reusable slash-command option builders.
 *
 * Option *names* are part of the contract with `handleAutocomplete`, so they are
 * defined once here rather than retyped in every command.
 */

/** The member a command acts on, as a real Discord user picker. */
export const memberOption =
  (required = true, name = 'member', description = 'The community member') =>
  (option) =>
    option.setName(name).setDescription(description).setRequired(required);

/** Every auditable action takes a reason. */
export const reasonOption =
  (required = true, description = 'Why this is being done (recorded in the audit log)') =>
  (option) =>
    option
      .setName('reason')
      .setDescription(description)
      .setRequired(required)
      .setMinLength(3)
      .setMaxLength(500);

export const guildOption =
  (required = true, name = 'guild', description = 'An approved Discord server') =>
  (option) =>
    option.setName(name).setDescription(description).setRequired(required).setAutocomplete(true);

export const mappingOption =
  (required = true, description = 'The role mapping') =>
  (option) =>
    option
      .setName('mapping')
      .setDescription(description)
      .setRequired(required)
      .setAutocomplete(true);

export const dryRunOption = (option) =>
  option
    .setName('dry_run')
    .setDescription('Preview the changes without applying them')
    .setRequired(false);

export const pageOption = (option) =>
  option.setName('page').setDescription('Page number').setRequired(false).setMinValue(1);

/** Resolves the member option into the identifier services expect. */
export function targetFromOptions(interaction, name = 'member') {
  const user = interaction.options.getUser(name);
  return user ? { discordUserId: user.id } : {};
}

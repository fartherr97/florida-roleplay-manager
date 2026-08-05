/**
 * `/rolemanager` - self-service role delegation.
 *
 * A member who holds a configured "grantor" role can hand out (and take back) the roles it
 * is allowed to give, several at a time, from a select menu. An administrator edits the
 * mapping with `/rolemanager config`, and anyone can see it with `/rolemanager view`.
 *
 * All of the authorization and the actual role writes live in `@frm/core`; this file only
 * turns select-menu clicks into a service call and renders the result.
 */
import {
  ActionRowBuilder,
  ComponentType,
  MessageFlags,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import {
  addGrantRule,
  applyRoleAssignment,
  listAssignableRoles,
  listGrantRules,
  removeGrantRule,
} from '@frm/core';
import { buildEmbed, errorEmbed, renderError, successEmbed, truncate } from '../lib/ui.js';
import { memberOption, reasonOption } from '../lib/options.js';

/** Discord caps a select menu at 25 options. */
const MENU_LIMIT = 25;
const PICK_TTL_MS = 2 * 60 * 1000;

export const data = new SlashCommandBuilder()
  .setName('rolemanager')
  .setDescription('Hand out and take back the roles you are allowed to manage')
  .addSubcommand((sub) =>
    sub
      .setName('assign')
      .setDescription('Give a member one or more of the roles you are allowed to hand out')
      .addUserOption(memberOption(false, 'member', 'Who to give the roles to (defaults to you)')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Take one or more roles back from a member')
      .addUserOption(memberOption(false, 'member', 'Who to take the roles from (defaults to you)')),
  )
  .addSubcommand((sub) =>
    sub.setName('view').setDescription('See which roles can hand out which other roles here'),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('config')
      .setDescription('Edit the role delegation rules (admins)')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Let a role hand out one or more other roles')
          .addRoleOption((option) =>
            option
              .setName('grantor')
              .setDescription('The role whose holders may hand out the roles you pick next')
              .setRequired(true),
          )
          .addStringOption(reasonOption(false)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Stop a role from being able to hand out certain roles')
          .addRoleOption((option) =>
            option.setName('grantor').setDescription('The role to edit').setRequired(true),
          )
          .addStringOption(reasonOption(false)),
      ),
  );

export async function execute(interaction, { ctx, gateway }) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (group === 'config') {
    return sub === 'add' ? handleConfigAdd(interaction, ctx) : handleConfigRemove(interaction, ctx);
  }

  switch (sub) {
    case 'assign':
      return handleApply(interaction, ctx, gateway, { remove: false });
    case 'remove':
      return handleApply(interaction, ctx, gateway, { remove: true });
    case 'view':
      return handleView(interaction, ctx);
    default:
      throw new Error(`Unknown subcommand ${sub}`);
  }
}

// ---------------------------------------------------------------------------
// Assign / remove
// ---------------------------------------------------------------------------

async function handleApply(interaction, ctx, gateway, { remove }) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const targetUser = interaction.options.getUser('member') ?? interaction.user;
  const guildId = interaction.guildId;

  // What the caller may hand out, from the roles they currently hold.
  const caller = await gateway.getMember(guildId, interaction.user.id).catch(() => null);
  const assignable = await listAssignableRoles(ctx, {
    discordGuildId: guildId,
    holderRoleIds: caller?.roleIds ?? [],
  });

  if (assignable.length === 0) {
    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: 'Nothing to manage',
          description:
            'You do not hold a role that lets you hand out any roles here. An admin sets ' +
            'this up with `/rolemanager config`.',
          color: 'neutral',
        }),
      ],
    });
  }

  // Only offer roles the change would actually affect: ones the target lacks (assign) or
  // already has (remove).
  const target = await gateway.getMember(guildId, targetUser.id).catch(() => null);
  if (!target) {
    return interaction.editReply({
      embeds: [errorEmbed('Not in this server', `<@${targetUser.id}> is not a member here.`)],
    });
  }
  const held = new Set(target.roleIds);
  const options = assignable.filter((role) => (remove ? held.has(role.id) : !held.has(role.id)));

  if (options.length === 0) {
    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: remove ? 'Nothing to remove' : 'Nothing to add',
          description: remove
            ? `<@${targetUser.id}> does not have any of the roles you can manage.`
            : `<@${targetUser.id}> already has every role you can hand out.`,
          color: 'neutral',
        }),
      ],
    });
  }

  const shown = options.slice(0, MENU_LIMIT);
  const token = randomUUID();
  const customId = `rm-pick:${token}`;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(remove ? 'Pick roles to remove' : 'Pick roles to add')
    .setMinValues(1)
    .setMaxValues(shown.length)
    .addOptions(shown.map((role) => ({ label: truncate(role.name, 100), value: role.id })));

  const verb = remove ? 'take back from' : 'give to';
  const message = await interaction.editReply({
    embeds: [
      buildEmbed({
        title: remove ? 'Remove roles' : 'Assign roles',
        description:
          `Pick the roles to ${verb} <@${targetUser.id}>.` +
          (options.length > MENU_LIMIT
            ? `\n\nShowing the first ${MENU_LIMIT} of ${options.length}.`
            : ''),
        color: 'info',
        footer: 'This picker expires in 2 minutes.',
      }),
    ],
    components: [new ActionRowBuilder().addComponents(menu)],
  });

  let selection;
  try {
    selection = await message.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      time: PICK_TTL_MS,
      filter: (component) =>
        component.user.id === interaction.user.id && component.customId === customId,
    });
  } catch {
    return interaction
      .editReply({
        embeds: [
          buildEmbed({
            title: 'Picker timed out',
            description: 'Nothing changed.',
            color: 'neutral',
          }),
        ],
        components: [],
      })
      .catch(() => {});
  }

  await selection.deferUpdate();

  try {
    const result = await applyRoleAssignment(
      ctx,
      {
        discordGuildId: guildId,
        targetDiscordUserId: targetUser.id,
        roleIds: selection.values,
        remove,
      },
      { gateway },
    );
    return interaction.editReply({
      embeds: [applyResultEmbed(result, targetUser)],
      components: [],
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)], components: [] }).catch(() => {});
  }
}

function applyResultEmbed(result, targetUser) {
  const roleList = (roles) => roles.map((role) => `<@&${role.id}>`).join(' ');
  const fields = [];
  if (result.applied.length) {
    fields.push({ name: result.remove ? 'Removed' : 'Added', value: roleList(result.applied) });
  }
  if (result.skipped.length) {
    fields.push({
      name: 'Skipped',
      value: truncate(result.skipped.map((role) => `<@&${role.id}> — ${role.reason}`).join('\n')),
    });
  }
  if (result.failed.length) {
    fields.push({
      name: 'Failed',
      value: truncate(result.failed.map((role) => `<@&${role.id}> — ${role.message}`).join('\n')),
    });
  }

  const changed = result.applied.length > 0;
  return buildEmbed({
    title: changed ? 'Done' : 'No changes',
    description: `${result.remove ? 'Removing from' : 'Assigning to'} <@${targetUser.id}>.`,
    color: result.failed.length ? 'warning' : changed ? 'success' : 'neutral',
    fields,
  });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

async function handleView(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { groups, total } = await listGrantRules(ctx, { discordGuildId: interaction.guildId });

  if (total === 0) {
    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: 'No role delegation set up',
          description: 'An admin can add rules with `/rolemanager config add`.',
          color: 'neutral',
        }),
      ],
    });
  }

  return interaction.editReply({
    embeds: [
      buildEmbed({
        title: 'Who can hand out what',
        description:
          'Holders of the role on the left can assign and remove the roles on the right.',
        color: 'info',
        fields: groups.slice(0, 25).map((group) => ({
          name: truncate(group.grantorRoleName, 256),
          value: truncate(group.grantables.map((role) => `<@&${role.id}>`).join(' ') || '—'),
        })),
        footer: groups.length > 25 ? `Showing 25 of ${groups.length} roles` : undefined,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function handleConfigAdd(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const grantor = interaction.options.getRole('grantor');
  const reason = interaction.options.getString('reason') ?? undefined;

  const token = randomUUID();
  const customId = `rm-cfg-add:${token}`;
  const menu = new RoleSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Pick the roles this role may hand out')
    .setMinValues(1)
    .setMaxValues(MENU_LIMIT);

  const message = await interaction.editReply({
    embeds: [
      buildEmbed({
        title: `Let ${grantor.name} hand out roles`,
        description: `Pick the roles that holders of <@&${grantor.id}> should be able to assign and remove.`,
        color: 'info',
        footer: 'This picker expires in 2 minutes.',
      }),
    ],
    components: [new ActionRowBuilder().addComponents(menu)],
  });

  let selection;
  try {
    selection = await message.awaitMessageComponent({
      componentType: ComponentType.RoleSelect,
      time: PICK_TTL_MS,
      filter: (component) =>
        component.user.id === interaction.user.id && component.customId === customId,
    });
  } catch {
    return interaction
      .editReply({
        embeds: [
          buildEmbed({
            title: 'Picker timed out',
            description: 'Nothing changed.',
            color: 'neutral',
          }),
        ],
        components: [],
      })
      .catch(() => {});
  }

  await selection.deferUpdate();

  const grantables = [...selection.roles.values()].map((role) => ({
    id: role.id,
    name: role.name,
  }));

  try {
    const result = await addGrantRule(ctx, {
      discordGuildId: interaction.guildId,
      grantor: { id: grantor.id, name: grantor.name },
      grantables,
      reason,
    });

    const fields = [];
    if (result.added.length) {
      fields.push({ name: 'Added', value: result.added.map((role) => `<@&${role.id}>`).join(' ') });
    }
    if (result.skipped.length) {
      fields.push({
        name: 'Already allowed',
        value: result.skipped.map((role) => `<@&${role.id}>`).join(' '),
      });
    }
    if (result.warnings.length) {
      fields.push({
        name: 'Heads up',
        value: truncate(result.warnings.map((w) => `• ${w}`).join('\n')),
      });
    }

    return interaction.editReply({
      embeds: [
        successEmbed(
          'Delegation updated',
          `Holders of <@&${grantor.id}> can now hand out the roles below.`,
          fields,
        ),
      ],
      components: [],
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)], components: [] }).catch(() => {});
  }
}

async function handleConfigRemove(interaction, ctx) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const grantor = interaction.options.getRole('grantor');
  const reason = interaction.options.getString('reason') ?? undefined;

  const { groups } = await listGrantRules(ctx, { discordGuildId: interaction.guildId });
  const group = groups.find((entry) => entry.grantorRoleId === grantor.id);

  if (!group || group.grantables.length === 0) {
    return interaction.editReply({
      embeds: [
        buildEmbed({
          title: 'Nothing to remove',
          description: `<@&${grantor.id}> is not set up to hand out any roles.`,
          color: 'neutral',
        }),
      ],
    });
  }

  const shown = group.grantables.slice(0, MENU_LIMIT);
  const token = randomUUID();
  const customId = `rm-cfg-rm:${token}`;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Pick the roles to stop it handing out')
    .setMinValues(1)
    .setMaxValues(shown.length)
    .addOptions(shown.map((role) => ({ label: truncate(role.name, 100), value: role.id })));

  const message = await interaction.editReply({
    embeds: [
      buildEmbed({
        title: `Edit ${grantor.name}`,
        description: `Pick the roles <@&${grantor.id}> should no longer be able to hand out.`,
        color: 'warning',
        footer: 'This picker expires in 2 minutes.',
      }),
    ],
    components: [new ActionRowBuilder().addComponents(menu)],
  });

  let selection;
  try {
    selection = await message.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      time: PICK_TTL_MS,
      filter: (component) =>
        component.user.id === interaction.user.id && component.customId === customId,
    });
  } catch {
    return interaction
      .editReply({
        embeds: [
          buildEmbed({
            title: 'Picker timed out',
            description: 'Nothing changed.',
            color: 'neutral',
          }),
        ],
        components: [],
      })
      .catch(() => {});
  }

  await selection.deferUpdate();

  try {
    const result = await removeGrantRule(ctx, {
      discordGuildId: interaction.guildId,
      grantorRoleId: grantor.id,
      grantableRoleIds: selection.values,
      reason,
    });

    return interaction.editReply({
      embeds: [
        successEmbed(
          'Delegation updated',
          `Removed ${result.removed} role(s) from what <@&${grantor.id}> can hand out.`,
        ),
      ],
      components: [],
    });
  } catch (error) {
    return interaction.editReply({ embeds: [renderError(error)], components: [] }).catch(() => {});
  }
}

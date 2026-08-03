/**
 * Autocomplete.
 *
 * Internal identifiers are UUIDs and Discord roles in *other* guilds are snowflakes;
 * neither is something a human can be asked to type. Autocomplete turns every one of
 * those options into a searchable list, which is the difference between a usable bot and
 * a bot that only its author can operate.
 *
 * Suggestions are filtered to what the actor may actually see, so the picker does not
 * become a directory of departments somebody has no business knowing about.
 */
import { createLogger } from '@frm/logging';
import { getPrisma, notDeleted } from '@frm/database';
import { guildScopeFilter } from '@frm/authorization';

const log = createLogger('bot.autocomplete');

const LIMIT = 25;

/** @param {string} value @param {string} query */
function matches(value, query) {
  if (!query) return true;
  return String(value).toLowerCase().includes(query.toLowerCase());
}

function toChoices(items) {
  return items.slice(0, LIMIT).map((item) => ({
    name: item.name.length > 100 ? `${item.name.slice(0, 97)}...` : item.name,
    value: item.value,
  }));
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {object} deps
 * @param {object} deps.ctx service context (already guarded)
 * @param {object} deps.gateway
 */
export async function handleAutocomplete(interaction, { ctx, gateway }) {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value ?? '');
  const prisma = getPrisma();

  try {
    switch (focused.name) {
      case 'mapping':
        return interaction.respond(toChoices(await mappingChoices(prisma, query)));

      case 'guild':
      case 'source_guild':
      case 'target_guild':
        return interaction.respond(toChoices(await guildChoices(ctx, prisma, query)));

      case 'source_role':
        return interaction.respond(
          toChoices(
            await roleChoices(
              prisma,
              gateway,
              interaction.options.getString('source_guild'),
              query,
            ),
          ),
        );

      case 'target_role':
        return interaction.respond(
          toChoices(
            await roleChoices(
              prisma,
              gateway,
              interaction.options.getString('target_guild'),
              query,
            ),
          ),
        );

      case 'capability':
        return interaction.respond(toChoices(await capabilityChoices(prisma, query)));

      default:
        return interaction.respond([]);
    }
  } catch (error) {
    // Autocomplete failures must never surface as an error to the user; an empty list
    // is the graceful degradation.
    log.warn({ err: error?.message, option: focused.name }, 'autocomplete failed');
    return interaction.respond([]).catch(() => {});
  }
}

async function mappingChoices(prisma, query) {
  const mappings = await prisma.roleMapping.findMany({
    where: { ...notDeleted },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { sourceGuild: { select: { name: true } }, targetGuild: { select: { name: true } } },
  });
  return mappings
    .filter((mapping) => matches(mapping.name, query))
    .map((mapping) => ({
      name: `${mapping.enabled ? '●' : '○'} ${mapping.name} (${mapping.sourceGuild.name} → ${mapping.targetGuild.name})`,
      value: mapping.id,
    }));
}

async function guildChoices(ctx, prisma, query) {
  const allowed = guildScopeFilter(ctx.actor, 'guild.view');
  const guilds = await prisma.approvedGuild.findMany({
    where: {
      ...notDeleted,
      ...(allowed !== null && allowed.length > 0 ? { id: { in: allowed } } : {}),
    },
    orderBy: { name: 'asc' },
    take: 100,
  });
  return guilds
    .filter((guild) => matches(guild.name, query) || matches(guild.discordGuildId, query))
    .map((guild) => ({
      name: `${guild.enabled ? '' : '(disabled) '}${guild.name}`,
      value: guild.id,
    }));
}

/**
 * Lists the roles of an approved guild, read live from Discord so a role created a
 * minute ago is already selectable.
 *
 * `guildRef` is the ApprovedGuild UUID chosen in the sibling option.
 */
async function roleChoices(prisma, gateway, guildRef, query) {
  if (!guildRef) return [{ name: 'Choose the guild first', value: 'none' }];

  const guild = await prisma.approvedGuild.findFirst({
    where: { id: guildRef, ...notDeleted },
    select: { discordGuildId: true },
  });
  if (!guild) return [];

  const roles = await gateway.listRoles(guild.discordGuildId);
  return roles
    .filter((role) => !role.isEveryone && matches(role.name, query))
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      name: `${role.name}${role.managed ? ' (integration owned)' : ''}`,
      value: role.id,
    }));
}

async function capabilityChoices(prisma, query) {
  const capabilities = await prisma.permissionCapability.findMany({
    orderBy: [{ category: 'asc' }, { key: 'asc' }],
  });
  return capabilities
    .filter((row) => matches(row.key, query) || matches(row.description, query))
    .map((row) => ({ name: `${row.key}${row.dangerous ? ' ⚠' : ''}`, value: row.key }));
}

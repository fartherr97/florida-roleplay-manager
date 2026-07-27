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
import { departmentScopeFilter, guildScopeFilter } from '@frm/authorization';
import { MembershipStatus } from '@frm/shared';

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
      case 'department':
      case 'target_department':
        return interaction.respond(toChoices(await departmentChoices(ctx, prisma, query)));

      case 'rank':
      case 'target_rank':
        return interaction.respond(
          toChoices(
            await rankChoices(
              prisma,
              interaction.options.getString(
                focused.name === 'target_rank' ? 'target_department' : 'department',
              ),
              query,
            ),
          ),
        );

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

      case 'certification':
        return interaction.respond(toChoices(await certificationChoices(prisma, query)));

      case 'subdivision':
        return interaction.respond(toChoices(await subdivisionChoices(prisma, query)));

      case 'capability':
        return interaction.respond(toChoices(await capabilityChoices(prisma, query)));

      case 'callsign':
        return interaction.respond(toChoices(await callsignChoices(prisma, query)));

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

async function departmentChoices(ctx, prisma, query) {
  const allowed = departmentScopeFilter(ctx.actor, 'roster.view');
  const departments = await prisma.department.findMany({
    where: {
      ...notDeleted,
      enabled: true,
      ...(allowed !== null && allowed.length > 0 ? { id: { in: allowed } } : {}),
    },
    orderBy: { name: 'asc' },
    take: 100,
  });

  return departments
    .filter((row) => matches(row.name, query) || matches(row.abbreviation, query))
    .map((row) => ({ name: `${row.abbreviation} — ${row.name}`, value: row.id }));
}

async function rankChoices(prisma, departmentId, query) {
  if (!departmentId) {
    return [{ name: 'Choose a department first', value: 'none' }];
  }
  const ranks = await prisma.rank.findMany({
    where: { departmentId, ...notDeleted },
    orderBy: { order: 'desc' },
    take: 100,
  });
  return ranks
    .filter((rank) => matches(rank.name, query))
    .map((rank) => ({ name: `${rank.name} (order ${rank.order})`, value: rank.id }));
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

async function certificationChoices(prisma, query) {
  const certifications = await prisma.certification.findMany({
    where: notDeleted,
    orderBy: { name: 'asc' },
    take: 100,
    include: { department: { select: { abbreviation: true } } },
  });
  return certifications
    .filter((row) => matches(row.name, query) || matches(row.key, query))
    .map((row) => ({
      name: row.department ? `${row.name} (${row.department.abbreviation})` : row.name,
      value: row.id,
    }));
}

async function subdivisionChoices(prisma, query) {
  const subdivisions = await prisma.subdivision.findMany({
    where: notDeleted,
    orderBy: { name: 'asc' },
    take: 100,
    include: { department: { select: { abbreviation: true } } },
  });
  return subdivisions
    .filter((row) => matches(row.name, query))
    .map((row) => ({ name: `${row.name} (${row.department.abbreviation})`, value: row.id }));
}

async function capabilityChoices(prisma, query) {
  const capabilities = await prisma.permissionCapability.findMany({
    orderBy: [{ category: 'asc' }, { key: 'asc' }],
  });
  return capabilities
    .filter((row) => matches(row.key, query) || matches(row.description, query))
    .map((row) => ({ name: `${row.key}${row.dangerous ? ' ⚠' : ''}`, value: row.key }));
}

async function callsignChoices(prisma, query) {
  const memberships = await prisma.departmentMembership.findMany({
    where: {
      ...notDeleted,
      callsign: { not: null },
      status: { not: MembershipStatus.TERMINATED },
    },
    take: 100,
    include: { user: { select: { displayName: true } } },
  });
  return memberships
    .filter((row) => matches(row.callsign, query))
    .map((row) => ({ name: `${row.callsign} — ${row.user.displayName}`, value: row.callsign }));
}

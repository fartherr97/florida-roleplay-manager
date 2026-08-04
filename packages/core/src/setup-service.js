/**
 * Server provisioning.
 *
 * `/setup department` turns an empty Discord server into a working department server in
 * one step: it creates the roles, categories, channels and permission overwrites from the
 * template, then (optionally) wires the server into the platform - registers it on the
 * allowlist, declares its member role as managed, and maps the main community's role into
 * it so membership syncs automatically.
 *
 * Two properties make this safe to hand to an administrator:
 *
 *   - **Idempotent.** Everything is matched by name. A second run creates only what is
 *     missing and never deletes or duplicates, so it doubles as a "repair" command.
 *   - **Preview first.** The command runs a dry run and shows exactly what it will create
 *     before anything is touched; this service produces the same plan for both.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import { AuditAction, GuildType, PreconditionError, RolePurpose } from '@frm/shared';
import { authorize } from '@frm/authorization';
import { provisionDepartmentSchema, parseOrThrow } from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { registerGuild } from './guild-service.js';
import { upsertManagedRole } from './managed-role-service.js';
import { createMapping } from './mapping-service.js';
import { buildDepartmentTemplate } from './templates/department.js';

export { buildDepartmentTemplate } from './templates/department.js';

const log = createLogger('core.setup');

/** Case-insensitive name match, used everywhere idempotency is decided. */
const sameName = (a, b) => a?.trim().toLowerCase() === b?.trim().toLowerCase();

/**
 * Computes what a template implies against the server as it is now. Pure: no Discord, no
 * database - which is what makes the whole idempotency rule directly testable.
 *
 * @param {import('./templates/department.js').DepartmentTemplate} template
 * @param {Array<{id: string, name: string}>} existingRoles
 * @param {Array<{id: string, name: string, type: string, parentId: string|null}>} existingChannels
 */
export function planDepartmentProvision(template, existingRoles, existingChannels) {
  const roles = template.roles.map((role) => {
    const existing = existingRoles.find((candidate) => sameName(candidate.name, role.name));
    return {
      key: role.key,
      name: role.name,
      action: existing ? 'exists' : 'create',
      id: existing?.id ?? null,
    };
  });

  const categories = template.categories.map((category) => {
    const existingCategory = existingChannels.find(
      (candidate) => candidate.type === 'category' && sameName(candidate.name, category.name),
    );

    const channels = category.channels.map((channel) => {
      const existing = existingChannels.find(
        (candidate) =>
          candidate.type === channel.type &&
          sameName(candidate.name, channel.name) &&
          (existingCategory ? candidate.parentId === existingCategory.id : true),
      );
      return { name: channel.name, type: channel.type, action: existing ? 'exists' : 'create' };
    });

    return {
      key: category.key,
      name: category.name,
      action: existingCategory ? 'exists' : 'create',
      id: existingCategory?.id ?? null,
      channels,
    };
  });

  const toCreate = {
    roles: roles.filter((role) => role.action === 'create').length,
    categories: categories.filter((category) => category.action === 'create').length,
    channels: categories.reduce(
      (total, category) => total + category.channels.filter((c) => c.action === 'create').length,
      0,
    ),
  };

  return { roles, categories, toCreate };
}

/**
 * Provisions a department server.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {{gateway?: object}} [options]
 */
export async function provisionDepartment(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(provisionDepartmentSchema, input);
  authorize(ctx.actor, { capability: 'guild.provision', scope: {} });

  if (!gateway) {
    throw new PreconditionError('Server provisioning needs a live Discord connection.');
  }

  const guild = await gateway.getGuild(data.discordGuildId);
  if (!guild || !guild.botPresent) {
    throw new PreconditionError('The bot is not in that Discord server. Invite it first.');
  }
  if (!guild.botCanManageChannels || !guild.botCanManageRoles) {
    throw new PreconditionError(
      'The bot needs both Manage Roles and Manage Channels in that server before it can set it up.',
    );
  }

  const template = buildDepartmentTemplate({ name: data.name, tag: data.tag, color: data.color });
  const [existingRoles, existingChannels] = await Promise.all([
    gateway.listRoles(data.discordGuildId),
    gateway.listChannels(data.discordGuildId),
  ]);
  const plan = planDepartmentProvision(template, existingRoles, existingChannels);

  if (data.dryRun) {
    return {
      dryRun: true,
      guild: { discordGuildId: guild.id, name: guild.name },
      plan,
      warnings: [],
    };
  }

  const reason =
    data.reason ??
    `Provisioned via /setup department by ${ctx.actor?.user?.displayName ?? 'an administrator'}`;
  const created = { roles: [], categories: [], channels: [] };
  const warnings = [];

  // 1. Roles first: permission overwrites reference them by id.
  const roleIdByKey = {};
  for (const role of plan.roles) {
    if (role.action === 'exists') {
      roleIdByKey[role.key] = role.id;
      continue;
    }
    const spec = template.roles.find((candidate) => candidate.key === role.key);
    const madeRole = await gateway.createRole(data.discordGuildId, { ...spec, reason });
    roleIdByKey[role.key] = madeRole.id;
    created.roles.push(role.name);
  }

  // 2. Categories with their overwrites, then 3. the channels inside them, which inherit.
  for (let index = 0; index < plan.categories.length; index += 1) {
    const categoryPlan = plan.categories[index];
    const categorySpec = template.categories[index];

    let categoryId = categoryPlan.id;
    if (categoryPlan.action === 'create') {
      const madeCategory = await gateway.createChannel(data.discordGuildId, {
        name: categorySpec.name,
        type: 'category',
        permissionOverwrites: resolveOverwrites(categorySpec.overwrites, roleIdByKey, guild.id),
        reason,
      });
      categoryId = madeCategory.id;
      created.categories.push(categorySpec.name);
    }

    for (let channelIndex = 0; channelIndex < categoryPlan.channels.length; channelIndex += 1) {
      const channelPlan = categoryPlan.channels[channelIndex];
      if (channelPlan.action === 'exists') continue;
      const channelSpec = categorySpec.channels[channelIndex];
      await gateway.createChannel(data.discordGuildId, {
        name: channelSpec.name,
        type: channelSpec.type,
        parentId: categoryId,
        reason,
      });
      created.channels.push(channelSpec.name);
    }
  }

  // 4. Wire the finished server into the platform.
  const wiredIn = data.wireIn
    ? await wireIntoPlatform(ctx, {
        template,
        discordGuildId: data.discordGuildId,
        name: data.name,
        memberRoleId: roleIdByKey[template.managedRoleKey],
        mainCommunityRoleId: data.mainCommunityRoleId,
        reason,
        gateway,
        warnings,
      })
    : null;

  await recordAudit(ctx.prisma ?? getPrisma(), {
    ctx,
    action: AuditAction.GUILD_PROVISIONED,
    reason,
    newState: {
      discordGuildId: data.discordGuildId,
      name: data.name,
      created: {
        roles: created.roles.length,
        categories: created.categories.length,
        channels: created.channels.length,
      },
      wiredIn: Boolean(wiredIn),
    },
  });

  log.info(
    { discordGuildId: data.discordGuildId, created, wiredIn: Boolean(wiredIn) },
    'department server provisioned',
  );

  return {
    dryRun: false,
    guild: { discordGuildId: guild.id, name: guild.name },
    plan,
    created,
    wiredIn,
    warnings,
  };
}

/**
 * Registers the guild, declares its member role as managed, and maps the main community
 * into it. Best-effort: the Discord structure already exists by the time this runs, so a
 * failure in any step is collected as a warning rather than thrown, and the command tells
 * the administrator exactly what still needs doing by hand.
 */
async function wireIntoPlatform(
  ctx,
  { template, discordGuildId, name, memberRoleId, mainCommunityRoleId, reason, gateway, warnings },
) {
  const prisma = ctx.prisma ?? getPrisma();
  const result = { registered: false, managedRole: false, mapping: 'skipped' };

  try {
    await registerGuild(
      ctx,
      { discordGuildId, name, type: GuildType.DEPARTMENT, syncEnabled: true, reason },
      { gateway },
    );
    result.registered = true;
  } catch (error) {
    if (error?.code === 'CONFLICT') {
      result.registered = true; // already on the allowlist; nothing to do
    } else {
      warnings.push(
        `Could not register the server on the allowlist: ${error?.userMessage ?? error?.message}`,
      );
      return result; // the later steps need the registered guild, so stop here
    }
  }

  const approvedGuild = await prisma.approvedGuild.findFirst({
    where: { discordGuildId, ...notDeleted },
  });
  if (!approvedGuild) {
    warnings.push('The server was set up but could not be found on the allowlist afterwards.');
    return result;
  }

  const memberRoleName = template.roles.find((role) => role.key === template.managedRoleKey)?.name;
  try {
    await upsertManagedRole(
      ctx,
      {
        guildId: approvedGuild.id,
        discordRoleId: memberRoleId,
        name: memberRoleName,
        purpose: RolePurpose.MAPPING,
        reason,
      },
      { gateway },
    );
    result.managedRole = true;
  } catch (error) {
    warnings.push(
      `Could not declare the member role as managed: ${error?.userMessage ?? error?.message}`,
    );
  }

  if (!mainCommunityRoleId) {
    warnings.push(
      'No main-community role was given, so no sync mapping was created. Add one later with /mapping create.',
    );
    return result;
  }

  const mainCommunity = await prisma.approvedGuild.findFirst({
    where: { type: GuildType.MAIN_COMMUNITY, enabled: true, ...notDeleted },
  });
  if (!mainCommunity) {
    warnings.push(
      'No approved main-community server is registered, so the sync mapping was skipped. Register it, then run /mapping create.',
    );
    result.mapping = 'skipped';
    return result;
  }

  try {
    await createMapping(
      ctx,
      {
        name: `${name} member sync`.slice(0, 100),
        sourceGuildId: mainCommunity.discordGuildId,
        sourceRoleId: mainCommunityRoleId,
        targetGuildId: discordGuildId,
        targetRoleId: memberRoleId,
        enabled: true,
        reason,
      },
      { gateway },
    );
    result.mapping = 'created';
  } catch (error) {
    if (error?.code === 'CONFLICT') {
      result.mapping = 'exists';
    } else {
      result.mapping = 'failed';
      warnings.push(`Could not create the sync mapping: ${error?.userMessage ?? error?.message}`);
      log.warn({ discordGuildId, err: serializeError(error) }, 'setup mapping wire-in failed');
    }
  }

  return result;
}

/** Turns template overwrites (role keys) into gateway overwrites (role ids). */
function resolveOverwrites(overwrites, roleIdByKey, everyoneId) {
  return (overwrites ?? [])
    .map((overwrite) => ({
      id: overwrite.role === 'everyone' ? everyoneId : roleIdByKey[overwrite.role],
      allow: overwrite.allow ?? [],
      deny: overwrite.deny ?? [],
    }))
    .filter((overwrite) => Boolean(overwrite.id));
}

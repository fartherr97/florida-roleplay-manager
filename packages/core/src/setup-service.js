/**
 * Server provisioning.
 *
 * `/setup department` and `/setup community` turn an empty Discord server into a working
 * one in a single step: they create the roles, categories, channels and permission
 * overwrites from a template, then wire the server into the platform - register it on the
 * allowlist and (for a department) declare its member role as managed and map the main
 * community's role into it, so membership syncs automatically.
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
import {
  AuditAction,
  GuildType,
  PreconditionError,
  RolePurpose,
  ValidationError,
} from '@frm/shared';
import { authorize } from '@frm/authorization';
import { parseOrThrow, provisionCommunitySchema, provisionDepartmentSchema } from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { registerGuild } from './guild-service.js';
import { upsertManagedRole } from './managed-role-service.js';
import { createMapping } from './mapping-service.js';
import { buildDepartmentTemplate } from './templates/department.js';
import { buildCommunityTemplate } from './templates/community.js';

export { buildDepartmentTemplate } from './templates/department.js';
export { buildCommunityTemplate } from './templates/community.js';

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
export function planProvision(template, existingRoles, existingChannels) {
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

/** Back-compat alias: the planner is generic, but was first shipped as this name. */
export const planDepartmentProvision = planProvision;

/**
 * Provisions a department server: structure, then the department wire-in.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {{gateway?: object}} [options]
 */
export async function provisionDepartment(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(provisionDepartmentSchema, input);
  authorize(ctx.actor, { capability: 'guild.provision', scope: {} });

  // The department template rejects tags it has no profile for; surface that as a clean
  // validation message to the administrator rather than a generic failure.
  let template;
  try {
    template = buildDepartmentTemplate({ name: data.name, tag: data.tag, color: data.color });
  } catch (error) {
    throw new ValidationError(error.message);
  }
  const built = await createStructure(ctx, { data, template, gateway, label: 'department' });
  if (built.dryRun) return dryRunResult(built);

  const warnings = built.warnings ?? [];
  const wiredIn = data.wireIn
    ? await wireDepartment(ctx, {
        template,
        discordGuildId: data.discordGuildId,
        name: data.name,
        memberRoleId: built.roleIdByKey[template.managedRoleKey],
        mainCommunityRoleId: data.mainCommunityRoleId,
        reason: built.reason,
        gateway,
        warnings,
      })
    : null;

  await auditProvision(ctx, { data, created: built.created, wiredIn, reason: built.reason });
  return finalResult(built, wiredIn, warnings);
}

/**
 * Provisions the main community server: structure, then register it as the hub.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {{gateway?: object}} [options]
 */
export async function provisionCommunity(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(provisionCommunitySchema, input);
  authorize(ctx.actor, { capability: 'guild.provision', scope: {} });

  const template = buildCommunityTemplate({ name: data.name, color: data.color });
  const built = await createStructure(ctx, { data, template, gateway, label: 'community' });
  if (built.dryRun) return dryRunResult(built);

  const warnings = built.warnings ?? [];
  const wiredIn = data.wireIn
    ? await wireCommunity(ctx, {
        discordGuildId: data.discordGuildId,
        name: data.name,
        reason: built.reason,
        gateway,
        warnings,
      })
    : null;

  await auditProvision(ctx, { data, created: built.created, wiredIn, reason: built.reason });
  return finalResult(built, wiredIn, warnings);
}

/**
 * Creates the Discord structure a template describes - roles, then categories with their
 * overwrites, then the channels inside them. Shared by both provisioning commands; the
 * per-server wire-in is what differs and stays in the callers.
 */
async function createStructure(ctx, { data, template, gateway, label }) {
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

  const [existingRoles, existingChannels] = await Promise.all([
    gateway.listRoles(data.discordGuildId),
    gateway.listChannels(data.discordGuildId),
  ]);
  const plan = planProvision(template, existingRoles, existingChannels);

  if (data.dryRun) {
    return { guild, plan, dryRun: true, created: null, roleIdByKey: null, reason: null };
  }

  const reason =
    data.reason ??
    `Provisioned via /setup ${label} by ${ctx.actor?.user?.displayName ?? 'an administrator'}`;
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
    try {
      const madeRole = await gateway.createRole(data.discordGuildId, { ...spec, reason });
      roleIdByKey[role.key] = madeRole.id;
      created.roles.push(role.name);
    } catch (error) {
      warnings.push(`Could not create the "${role.name}" role: ${message(error)}`);
    }
  }

  // 2. Categories with their overwrites, then 3. the channels inside them, which inherit.
  // Each creation is best-effort: one unsupported channel (a forum on a non-community
  // server, say) must not abort a whole server's worth of otherwise-fine structure.
  for (let index = 0; index < plan.categories.length; index += 1) {
    const categoryPlan = plan.categories[index];
    const categorySpec = template.categories[index];

    let categoryId = categoryPlan.id;
    if (categoryPlan.action === 'create') {
      try {
        const madeCategory = await gateway.createChannel(data.discordGuildId, {
          name: categorySpec.name,
          type: 'category',
          permissionOverwrites: resolveOverwrites(categorySpec.overwrites, roleIdByKey, guild.id),
          reason,
        });
        categoryId = madeCategory.id;
        created.categories.push(categorySpec.name);
      } catch (error) {
        warnings.push(
          `Could not create the "${categorySpec.name}" category, so its channels were skipped: ${message(error)}`,
        );
        continue; // without the category there is nowhere to put its channels
      }
    }

    for (let channelIndex = 0; channelIndex < categoryPlan.channels.length; channelIndex += 1) {
      const channelPlan = categoryPlan.channels[channelIndex];
      if (channelPlan.action === 'exists') continue;
      const channelSpec = categorySpec.channels[channelIndex];
      try {
        await gateway.createChannel(data.discordGuildId, {
          name: channelSpec.name,
          type: channelSpec.type,
          parentId: categoryId,
          reason,
        });
        created.channels.push(channelSpec.name);
      } catch (error) {
        warnings.push(
          `Could not create the "${channelSpec.name}" ${channelSpec.type} channel: ${message(error)}`,
        );
      }
    }
  }

  return { guild, plan, dryRun: false, created, roleIdByKey, reason, warnings };
}

/** A short, human-readable reason from a thrown error. */
function message(error) {
  return error?.userMessage ?? error?.message ?? 'unknown error';
}

function dryRunResult(built) {
  return {
    dryRun: true,
    guild: { discordGuildId: built.guild.id, name: built.guild.name },
    plan: built.plan,
    warnings: [],
  };
}

function finalResult(built, wiredIn, warnings) {
  return {
    dryRun: false,
    guild: { discordGuildId: built.guild.id, name: built.guild.name },
    plan: built.plan,
    created: built.created,
    wiredIn,
    warnings,
  };
}

async function auditProvision(ctx, { data, created, wiredIn, reason }) {
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
    'server provisioned',
  );
}

/** Registers the community server as the hub. Best-effort; a failure becomes a warning. */
async function wireCommunity(ctx, { discordGuildId, name, reason, gateway, warnings }) {
  const result = { registered: false };
  try {
    await registerGuild(
      ctx,
      { discordGuildId, name, type: GuildType.MAIN_COMMUNITY, syncEnabled: true, reason },
      { gateway },
    );
    result.registered = true;
  } catch (error) {
    if (error?.code === 'CONFLICT') {
      result.registered = true;
    } else {
      warnings.push(
        `Could not register the server on the allowlist: ${error?.userMessage ?? error?.message}`,
      );
    }
  }
  return result;
}

/**
 * Registers the guild, declares its member role as managed, and maps the main community
 * into it. Best-effort: the Discord structure already exists by the time this runs, so a
 * failure in any step is collected as a warning rather than thrown, and the command tells
 * the administrator exactly what still needs doing by hand.
 */
async function wireDepartment(
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
      'No approved main-community server is registered, so the sync mapping was skipped. Run /setup community there first, then /mapping create.',
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

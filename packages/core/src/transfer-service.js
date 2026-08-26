/**
 * ES Transfer Portal.
 *
 * A department transfer moves a member from one department's Discord server to another:
 * the outgoing department's roles are stripped in its guild, and the incoming
 * department's roles are granted in its guild. Which roles define a department is
 * configuration - a set of Discord role ids stored on each `ApprovedGuild` - so a
 * transfer is fully described by "this member, from this department, to that one".
 *
 * Like self-service delegation, this is deliberately outside the reconciliation engine.
 * The engine recomputes a member's roles from mappings and would fight a manual move; a
 * transfer instead applies its changes directly through the gateway, guarded by the same
 * `checkRoleOperation` preflight, and never touches a role that is not in a department's
 * configured set.
 *
 * The write itself happens in the worker (the only process that writes to Discord), so
 * `requestTransfer` queues the job and returns its id; the dashboard polls `getTransfer`
 * for progress and the result. `runTransferJob` is what the worker actually runs.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import { ActionSource, AuditAction, PreconditionError, newRequestId } from '@frm/shared';
import { authorize, hasCapabilityAnywhere } from '@frm/authorization';
import { checkRoleOperation } from '@frm/discord';
import { JobName, enqueue, getTransferQueue } from '@frm/queue';
import { parseOrThrow, setTransferRolesSchema, transferJobSchema, transferRequestSchema } from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { resolveApprovedGuild } from './resolve.js';

const log = createLogger('core.transfer');

/**
 * Reading transfer configuration is open to anyone who can either configure the sets or
 * run a transfer - the execute screen needs to see what a move will strip and grant.
 * Falls back to a proper `transfer.execute` denial when the actor has neither.
 */
function authorizeTransferRead(ctx) {
  if (
    hasCapabilityAnywhere(ctx.actor, 'transfer.execute') ||
    hasCapabilityAnywhere(ctx.actor, 'transfer.manage')
  ) {
    return;
  }
  authorize(ctx.actor, { capability: 'transfer.execute', scope: {} });
}

/** A guild as the transfer screens want to read it. */
function toEndpoint(guild) {
  return {
    id: guild.id,
    name: guild.name,
    type: guild.type,
    discordGuildId: guild.discordGuildId,
    transferRoleIds: guild.transferRoleIds ?? [],
  };
}

/**
 * Every approved guild, each with its configured transfer role set. The configuration
 * screen edits these; the execute screen offers the ones whose set is non-empty as
 * possible departments.
 */
export async function getTransferConfig(ctx) {
  authorizeTransferRead(ctx);
  const prisma = ctx.prisma ?? getPrisma();

  const guilds = await prisma.approvedGuild.findMany({
    where: { enabled: true, ...notDeleted },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      type: true,
      discordGuildId: true,
      transferRoleIds: true,
    },
  });

  return { guilds: guilds.map(toEndpoint) };
}

/**
 * Sets (or clears) the Discord role ids that define membership in a department for
 * transfers. An empty list marks the guild as no longer a transfer endpoint.
 */
export async function setTransferRoles(ctx, input) {
  const data = parseOrThrow(setTransferRolesSchema, input);
  authorize(ctx.actor, { capability: 'transfer.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();

  const guild = await resolveApprovedGuild(ctx, data.guildId);

  // De-duplicate while preserving order: a picker can send the same id twice, and a
  // transfer that tried to add a role twice would only waste a preflight.
  const roleIds = [...new Set(data.roleIds)];
  const previous = guild.transferRoleIds ?? [];

  const updated = await prisma.approvedGuild.update({
    where: { id: guild.id },
    data: { transferRoleIds: roleIds },
    select: { id: true, name: true, type: true, discordGuildId: true, transferRoleIds: true },
  });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.TRANSFER_ROLES_SET,
    approvedGuildId: guild.id,
    reason: data.reason,
    previousState: { transferRoleIds: previous },
    newState: { transferRoleIds: roleIds },
  });

  log.info({ guildId: guild.id, count: roleIds.length }, 'transfer role set updated');
  return toEndpoint(updated);
}

/**
 * Resolves both departments and returns the role sets a move would strip and grant. Both
 * must be configured with a non-empty set, and they must differ.
 */
async function resolveTransferEndpoints(ctx, data) {
  const from = await resolveApprovedGuild(ctx, data.fromGuildId);
  const to = await resolveApprovedGuild(ctx, data.toGuildId);

  const removeRoleIds = from.transferRoleIds ?? [];
  const addRoleIds = to.transferRoleIds ?? [];

  if (removeRoleIds.length === 0) {
    throw new PreconditionError(
      `${from.name} has no transfer roles configured. Configure them before transferring out of it.`,
    );
  }
  if (addRoleIds.length === 0) {
    throw new PreconditionError(
      `${to.name} has no transfer roles configured. Configure them before transferring into it.`,
    );
  }

  return { from, to, removeRoleIds, addRoleIds };
}

/**
 * A read-only preview of what a transfer would do, computed from configuration alone.
 * The counts are an upper bound: the worker skips a role the member does not hold (on
 * removal) or already holds (on addition), so the applied numbers may be lower.
 */
export async function previewTransfer(ctx, input) {
  const data = parseOrThrow(transferRequestSchema, input);
  authorize(ctx.actor, { capability: 'transfer.execute', scope: {} });
  const { from, to, removeRoleIds, addRoleIds } = await resolveTransferEndpoints(ctx, data);

  return {
    discordUserId: data.discordUserId,
    from: { id: from.id, name: from.name, discordGuildId: from.discordGuildId, removeRoleIds },
    to: { id: to.id, name: to.name, discordGuildId: to.discordGuildId, addRoleIds },
  };
}

/**
 * Queues a transfer. Returns the queue job id the dashboard polls with `getTransfer`.
 * The actual Discord writes happen in the worker; nothing here touches a role.
 */
export async function requestTransfer(ctx, input) {
  const data = parseOrThrow(transferRequestSchema, input);
  authorize(ctx.actor, { capability: 'transfer.execute', scope: {} });
  const { from, to, removeRoleIds, addRoleIds } = await resolveTransferEndpoints(ctx, data);

  const requestId = ctx.requestId ?? newRequestId();

  const job = await enqueue(JobName.TRANSFER_EXECUTE, {
    targetDiscordUserId: data.discordUserId,
    from: { id: from.id, name: from.name, discordGuildId: from.discordGuildId, removeRoleIds },
    to: { id: to.id, name: to.name, discordGuildId: to.discordGuildId, addRoleIds },
    reason: data.reason ?? null,
    // Carried so the worker can attribute the audit record to the acting administrator.
    actorUserId: ctx.actor?.user?.id ?? null,
    actorDiscordId: ctx.actor?.discordUserId ?? null,
    requestId,
  });

  log.info(
    { jobId: job.id, from: from.id, to: to.id, target: data.discordUserId },
    'transfer queued',
  );

  return {
    jobId: String(job.id),
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name },
  };
}

/** BullMQ state names mapped onto something the dashboard can render simply. */
function normalizeState(state) {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'active':
      return 'running';
    case 'delayed':
    case 'waiting':
    case 'waiting-children':
    case 'prioritized':
      return 'queued';
    default:
      return state ?? 'unknown';
  }
}

/**
 * The live state of a queued transfer. Read from the queue rather than a table: a
 * transfer is a one-shot action, and its result lives on the job until it ages out.
 */
export async function getTransfer(ctx, input) {
  const data = parseOrThrow(transferJobSchema, input);
  authorize(ctx.actor, { capability: 'transfer.execute', scope: {} });

  const job = await getTransferQueue().getJob(data.jobId);
  if (!job) {
    // Aged out of the queue, or never existed. The audit record is the durable history.
    return { jobId: data.jobId, state: 'expired', result: null };
  }

  const state = await job.getState().catch(() => 'unknown');
  return {
    jobId: String(job.id),
    state: normalizeState(state),
    progress: typeof job.progress === 'number' ? job.progress : 0,
    result: job.returnvalue ?? null,
    failedReason: job.failedReason ?? null,
  };
}

/**
 * Recent transfers, newest first, read straight from the audit trail. Gated on
 * `transfer.execute` rather than `audit.view`: seeing the moves you can make is part of
 * making them, and this reads only transfer records.
 */
export async function listTransfers(ctx, { limit = 20 } = {}) {
  authorizeTransferRead(ctx);
  const prisma = ctx.prisma ?? getPrisma();

  const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = await prisma.auditLog.findMany({
    where: { action: AuditAction.TRANSFER_EXECUTED },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      createdAt: true,
      success: true,
      reason: true,
      targetDiscordId: true,
      newState: true,
      actor: { select: { id: true, displayName: true } },
    },
  });

  return { transfers: rows };
}

/**
 * Applies a transfer. Run by the worker, which owns the gateway that writes to Discord.
 *
 * Each role is applied on its own: an already-satisfied change is skipped, and a role
 * the bot cannot manage fails without aborting the rest. Removals happen in the outgoing
 * guild, additions in the incoming one - two different Discord servers, so the member may
 * be present in one and not the other, which the preflight reports per role.
 *
 * @param {object} params
 * @param {object} params.data the queued job data
 * @param {object} params.gateway the write-capable Discord gateway
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 */
export async function runTransferJob({ data, gateway, prisma = getPrisma() }) {
  const { targetDiscordUserId, from, to } = data;
  const reason = `FRM transfer: ${data.reason ?? `${from.name} → ${to.name}`}`.slice(0, 400);

  const removed = [];
  const added = [];
  const skipped = [];
  const failed = [];

  // Live membership in each guild, so an already-correct change is a no-op rather than a
  // wasted (and audit-noisy) API call.
  const fromMember = await gateway
    .getMember(from.discordGuildId, targetDiscordUserId)
    .catch(() => null);
  const toMember = await gateway
    .getMember(to.discordGuildId, targetDiscordUserId)
    .catch(() => null);

  const fromHeld = new Set(fromMember?.roleIds ?? []);
  const toHeld = new Set(toMember?.roleIds ?? []);

  // --- strip the outgoing department -------------------------------------
  for (const roleId of from.removeRoleIds ?? []) {
    if (!fromMember) {
      failed.push({ side: 'remove', id: roleId, message: `Member is not in ${from.name}.` });
      continue;
    }
    if (!fromHeld.has(roleId)) {
      skipped.push({ side: 'remove', id: roleId, reason: 'not held' });
      continue;
    }
    const preflight = await checkRoleOperation(gateway, {
      discordGuildId: from.discordGuildId,
      discordUserId: targetDiscordUserId,
      discordRoleId: roleId,
    });
    if (!preflight.ok) {
      failed.push({ side: 'remove', id: roleId, message: preflight.message });
      continue;
    }
    try {
      await gateway.removeRole(from.discordGuildId, targetDiscordUserId, roleId, reason);
      removed.push({ id: roleId });
    } catch (error) {
      failed.push({
        side: 'remove',
        id: roleId,
        message: error?.userMessage ?? 'Discord rejected the change.',
      });
    }
  }

  // --- grant the incoming department -------------------------------------
  for (const roleId of to.addRoleIds ?? []) {
    if (!toMember) {
      failed.push({ side: 'add', id: roleId, message: `Member is not in ${to.name}.` });
      continue;
    }
    if (toHeld.has(roleId)) {
      skipped.push({ side: 'add', id: roleId, reason: 'already has it' });
      continue;
    }
    const preflight = await checkRoleOperation(gateway, {
      discordGuildId: to.discordGuildId,
      discordUserId: targetDiscordUserId,
      discordRoleId: roleId,
    });
    if (!preflight.ok) {
      failed.push({ side: 'add', id: roleId, message: preflight.message });
      continue;
    }
    try {
      await gateway.addRole(to.discordGuildId, targetDiscordUserId, roleId, reason);
      added.push({ id: roleId });
    } catch (error) {
      failed.push({
        side: 'add',
        id: roleId,
        message: error?.userMessage ?? 'Discord rejected the change.',
      });
    }
  }

  const status = failed.length === 0 ? 'completed' : removed.length + added.length > 0 ? 'partial' : 'failed';

  // Attribute the record to the administrator who requested it, reconstructing the
  // context from the identity carried on the job.
  const ctx = {
    actor: { user: { id: data.actorUserId ?? null }, discordUserId: data.actorDiscordId ?? null },
    source: ActionSource.WEBSITE,
    requestId: data.requestId ?? null,
  };

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.TRANSFER_EXECUTED,
    approvedGuildId: to.id,
    targetDiscordId: targetDiscordUserId,
    reason: data.reason,
    success: failed.length === 0,
    newState: {
      status,
      fromGuildId: from.id,
      fromName: from.name,
      toGuildId: to.id,
      toName: to.name,
      removed: removed.map((role) => role.id),
      added: added.map((role) => role.id),
      skipped: skipped.length,
      failed,
    },
  }).catch((error) => {
    log.error({ err: serializeError(error) }, 'could not record transfer audit');
  });

  log.info(
    {
      target: targetDiscordUserId,
      from: from.id,
      to: to.id,
      removed: removed.length,
      added: added.length,
      failed: failed.length,
      status,
    },
    'transfer applied',
  );

  return { status, removed, added, skipped, failed };
}

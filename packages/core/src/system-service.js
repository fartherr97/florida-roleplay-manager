/**
 * Platform health and settings.
 *
 * `/system health` is the first thing anybody looks at when synchronization "stopped
 * working", so it reports the things that actually break: the database, Redis, the
 * queues, the Discord connection, unresolved issues and stuck jobs.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import { AuditAction, NotFoundError, SyncJobStatus, ValidationError, getEnv } from '@frm/shared';
import { authorize } from '@frm/authorization';
import { getQueueStats, getRedis } from '@frm/queue';
import { recordAudit } from './audit-service.js';

const log = createLogger('core.system');

/**
 * @param {import('./context.js').ServiceContext} ctx
 * @param {{gateway?: object}} [options]
 */
export async function getSystemHealth(ctx, { gateway } = {}) {
  authorize(ctx.actor, { capability: 'system.manage', scope: {} });

  const prisma = ctx.prisma ?? getPrisma();
  const env = getEnv();
  const started = Date.now();

  const [database, redis, queues, counts, stuckJobs, openIssues, discord] = await Promise.all([
    checkDatabase(prisma),
    checkRedis(),
    checkQueues(),
    countEntities(prisma),
    countStuckJobs(prisma),
    countOpenIssues(prisma),
    checkDiscord(gateway),
  ]);

  const healthy =
    database.ok && redis.ok && queues.ok && (discord.ok || discord.status === 'not available here');

  return {
    healthy,
    checkedInMs: Date.now() - started,
    mode: {
      nodeEnv: env.NODE_ENV,
      devMode: env.devMode,
      discordMock: env.DISCORD_MOCK,
      dryRunDefault: env.SYNC_DRY_RUN_DEFAULT,
      maxRemovalsThreshold: env.SYNC_MAX_REMOVALS_THRESHOLD,
      markerTtlSeconds: env.SYNC_MARKER_TTL_SECONDS,
    },
    database,
    redis,
    queues,
    discord,
    counts,
    stuckJobs,
    openIssues,
  };
}

async function checkDatabase(prisma) {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    log.error({ err: serializeError(error) }, 'database health check failed');
    return { ok: false, error: 'unreachable' };
  }
}

/** How long any single health probe may take before it is reported as unreachable. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * Bounds a health probe so a wedged dependency degrades to "unreachable" instead of
 * hanging the whole check. This matters most for Redis: the BullMQ connection retries
 * forever by design (`maxRetriesPerRequest: null`), so a queue-stats call against an
 * unreachable Redis never rejects on its own - and a health command that hangs when
 * Redis is down is useless exactly when it is needed.
 */
async function withProbeTimeout(operation, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } catch (error) {
    return { ...onTimeout, detail: error?.message };
  } finally {
    clearTimeout(timer);
  }
}

function checkRedis() {
  const started = Date.now();
  return withProbeTimeout(
    async () => {
      const pong = await getRedis().ping();
      return { ok: pong === 'PONG', latencyMs: Date.now() - started };
    },
    { ok: false, error: 'unreachable' },
  );
}

function checkQueues() {
  return withProbeTimeout(
    async () => {
      const stats = await getQueueStats();
      const failed = Object.values(stats).reduce(
        (total, counts) => total + (counts.failed ?? 0),
        0,
      );
      return { ok: true, stats, failed };
    },
    { ok: false, error: 'unreachable' },
  );
}

async function checkDiscord(gateway) {
  if (!gateway) return { ok: false, status: 'not available here' };
  try {
    const guilds = await gateway.listGuilds();
    return { ok: true, guildCount: guilds.length, gateway: gateway.name };
  } catch (error) {
    return { ok: false, error: error?.message ?? 'unreachable' };
  }
}

async function countEntities(prisma) {
  const [guilds, members, mappings, enabledMappings, managedRoles] = await Promise.all([
    prisma.approvedGuild.count({ where: { ...notDeleted, enabled: true } }),
    prisma.user.count({ where: notDeleted }),
    prisma.roleMapping.count({ where: notDeleted }),
    prisma.roleMapping.count({ where: { ...notDeleted, enabled: true } }),
    prisma.managedRole.count({ where: notDeleted }),
  ]);
  return { guilds, members, mappings, enabledMappings, managedRoles };
}

/** Jobs that have been running for over an hour are almost certainly wedged. */
async function countStuckJobs(prisma) {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const [running, paused, pending] = await Promise.all([
    prisma.syncJob.count({ where: { status: SyncJobStatus.RUNNING, startedAt: { lt: cutoff } } }),
    prisma.syncJob.count({ where: { status: SyncJobStatus.PAUSED } }),
    prisma.syncJob.count({ where: { status: SyncJobStatus.PENDING, createdAt: { lt: cutoff } } }),
  ]);
  return { runningTooLong: running, paused, pendingTooLong: pending };
}

async function countOpenIssues(prisma) {
  const grouped = await prisma.syncIssue.groupBy({
    by: ['type'],
    where: { resolved: false },
    _count: { _all: true },
  });
  const total = grouped.reduce((sum, row) => sum + row._count._all, 0);
  return {
    total,
    byType: Object.fromEntries(grouped.map((row) => [row.type, row._count._all])),
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Known settings and their validators. Unknown keys are rejected. */
const SETTING_VALIDATORS = {
  'sync.maxRemovalsThreshold': (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 100000) {
      throw new ValidationError(
        'The removal threshold must be a whole number between 1 and 100000.',
      );
    }
    return number;
  },
  'sync.markerTtlSeconds': (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 5 || number > 3600) {
      throw new ValidationError('The marker TTL must be between 5 and 3600 seconds.');
    }
    return number;
  },
  'guild.autoLeaveUnapproved': (value) => Boolean(value),
  'approval.requiredForProtectedMappings': (value) => Boolean(value),
};

export async function listSettings(ctx) {
  authorize(ctx.actor, { capability: 'system.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();
  return prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
}

export async function updateSetting(ctx, { key, value, reason }) {
  authorize(ctx.actor, { capability: 'system.manage', scope: {} });

  const validator = SETTING_VALIDATORS[key];
  if (!validator) throw new NotFoundError('Setting', key);
  const normalized = validator(value);

  const prisma = ctx.prisma ?? getPrisma();
  const existing = await prisma.systemSetting.findUnique({ where: { key } });

  return prisma.$transaction(async (tx) => {
    const row = await tx.systemSetting.upsert({
      where: { key },
      create: { key, value: normalized, updatedById: ctx.actor?.user?.id ?? null },
      update: { value: normalized, updatedById: ctx.actor?.user?.id ?? null },
    });
    await recordAudit(tx, {
      ctx,
      action: AuditAction.SYSTEM_SETTING_UPDATED,
      reason,
      previousState: existing ? { key, value: existing.value } : null,
      newState: { key, value: normalized },
    });
    return row;
  });
}

/** Reads a setting with a fallback, used by the runner and the schedulers. */
export async function getSetting(key, fallback, prisma = getPrisma()) {
  const row = await prisma.systemSetting.findUnique({ where: { key } }).catch(() => null);
  return row ? row.value : fallback;
}

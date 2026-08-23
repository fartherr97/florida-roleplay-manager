/**
 * BullMQ queue definitions.
 *
 * Three queues so that a long guild-wide resync cannot starve a single retried role
 * write, and so maintenance sweeps run on their own schedule:
 *
 *   - `frm-sync`         member, guild and global resyncs, and grant changes
 *   - `frm-role-action`  individual retryable role writes
 *   - `frm-maintenance`  scheduled reconciliation and mapping validation
 *
 * Job ids are the SyncJob row id, which makes a queue job traceable to its database
 * record (and its audit trail) in one hop.
 */
import { Queue } from 'bullmq';
import { QUEUE_NAMES, RETRY_POLICY, SyncJobType, getEnv } from '@frm/shared';
import { createLogger } from '@frm/logging';
import { getBullConnection } from './connection.js';

const log = createLogger('queue');

/** Job names, kept separate from SyncJobType so queue routing is explicit. */
export const JobName = Object.freeze({
  MEMBER_RESYNC: 'member-resync',
  GUILD_RESYNC: 'guild-resync',
  GLOBAL_RESYNC: 'global-resync',
  GRANT_CHANGE: 'grant-change',
  MAPPING_PROPAGATION: 'mapping-propagation',
  ROLE_ACTION_RETRY: 'role-action-retry',
  SCHEDULED_RECONCILIATION: 'scheduled-reconciliation',
  MAPPING_VALIDATION: 'mapping-validation',
  ROSTER_MEMBER_SYNC: 'roster-member-sync',
  ROSTER_SYNC: 'roster-sync',
});

/** Which queue each job name belongs to. */
const QUEUE_FOR_JOB = Object.freeze({
  [JobName.MEMBER_RESYNC]: QUEUE_NAMES.SYNC,
  [JobName.GUILD_RESYNC]: QUEUE_NAMES.SYNC,
  [JobName.GLOBAL_RESYNC]: QUEUE_NAMES.SYNC,
  [JobName.GRANT_CHANGE]: QUEUE_NAMES.SYNC,
  [JobName.MAPPING_PROPAGATION]: QUEUE_NAMES.SYNC,
  [JobName.ROLE_ACTION_RETRY]: QUEUE_NAMES.ROLE_ACTION,
  [JobName.SCHEDULED_RECONCILIATION]: QUEUE_NAMES.MAINTENANCE,
  [JobName.MAPPING_VALIDATION]: QUEUE_NAMES.MAINTENANCE,
  // Roster work gets its own queue rather than sharing the sync queue: a roster bug
  // then cannot starve or stall role synchronization, and vice versa.
  [JobName.ROSTER_MEMBER_SYNC]: QUEUE_NAMES.ROSTER,
  [JobName.ROSTER_SYNC]: QUEUE_NAMES.ROSTER,
});

/** Maps a SyncJobType onto the job name that processes it. */
export const JOB_NAME_FOR_TYPE = Object.freeze({
  [SyncJobType.MEMBER_RESYNC]: JobName.MEMBER_RESYNC,
  [SyncJobType.GUILD_RESYNC]: JobName.GUILD_RESYNC,
  [SyncJobType.GLOBAL_RESYNC]: JobName.GLOBAL_RESYNC,
  [SyncJobType.GRANT_CHANGE]: JobName.GRANT_CHANGE,
  [SyncJobType.MAPPING_PROPAGATION]: JobName.MAPPING_PROPAGATION,
  [SyncJobType.ROLE_ADD]: JobName.ROLE_ACTION_RETRY,
  [SyncJobType.ROLE_REMOVE]: JobName.ROLE_ACTION_RETRY,
  [SyncJobType.SCHEDULED_RECONCILIATION]: JobName.SCHEDULED_RECONCILIATION,
  [SyncJobType.MAPPING_VALIDATION]: JobName.MAPPING_VALIDATION,
  [SyncJobType.ROSTER_MEMBER_SYNC]: JobName.ROSTER_MEMBER_SYNC,
  [SyncJobType.ROSTER_SYNC]: JobName.ROSTER_SYNC,
});

/** @type {Map<string, Queue>} */
const queues = new Map();

/**
 * Default job options.
 *
 * Retries use exponential backoff. Permanent failures are never retried: the worker
 * inspects the typed error and calls `discard()` so a missing-permission failure does
 * not burn five attempts and eight seconds of backoff for nothing.
 */
export const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: RETRY_POLICY.attempts,
  backoff: { ...RETRY_POLICY.backoff },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
});

/** @param {string} name @returns {Queue} */
export function getQueue(name) {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: getBullConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, queue);
  }
  return queue;
}

export const getSyncQueue = () => getQueue(QUEUE_NAMES.SYNC);
export const getRoleActionQueue = () => getQueue(QUEUE_NAMES.ROLE_ACTION);
export const getMaintenanceQueue = () => getQueue(QUEUE_NAMES.MAINTENANCE);
export const getRosterQueue = () => getQueue(QUEUE_NAMES.ROSTER);

/**
 * Enqueues a job.
 *
 * Always called *after* the database transaction commits: a queue is not
 * transactional, and a job that runs before its row is visible would find nothing to
 * do. The caller records a `SyncIssue` if this throws, so nothing is silently lost.
 *
 * @param {string} jobName one of {@link JobName}
 * @param {object} data
 * @param {object} [options] BullMQ job options; `jobId` should be the SyncJob row id
 */
export async function enqueue(jobName, data, options = {}) {
  const queueName = QUEUE_FOR_JOB[jobName];
  if (!queueName) throw new Error(`Unknown job name: ${jobName}`);

  const job = await getQueue(queueName).add(jobName, data, options);
  log.debug({ jobName, queueName, jobId: job.id }, 'job enqueued');
  return job;
}

/**
 * Registers the repeatable maintenance jobs. Idempotent: re-running replaces the
 * existing scheduler rather than stacking duplicates.
 */
export async function scheduleMaintenanceJobs() {
  const env = getEnv();
  const queue = getMaintenanceQueue();

  await queue.upsertJobScheduler(
    'scheduled-reconciliation',
    { pattern: env.RECONCILE_CRON },
    { name: JobName.SCHEDULED_RECONCILIATION, data: { scheduled: true } },
  );

  await queue.upsertJobScheduler(
    'mapping-validation',
    { pattern: env.MAPPING_VALIDATION_CRON },
    { name: JobName.MAPPING_VALIDATION, data: { scheduled: true } },
  );

  log.info(
    { reconcile: env.RECONCILE_CRON, mappingValidation: env.MAPPING_VALIDATION_CRON },
    'maintenance schedulers registered',
  );
}

/** Queue depth and health, used by `/system health` and the API health endpoint. */
export async function getQueueStats() {
  const stats = {};
  for (const name of Object.values(QUEUE_NAMES)) {
    const queue = getQueue(name);
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    stats[name] = counts;
  }
  return stats;
}

export async function closeQueues() {
  const open = [...queues.values()];
  queues.clear();
  await Promise.all(open.map((queue) => queue.close()));
}

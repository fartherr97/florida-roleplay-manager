/**
 * Queue processors.
 *
 * Each processor is a thin wrapper: it resolves the job, calls into `@frm/core` and
 * decides whether a failure deserves a retry. Nothing here contains business logic.
 */
import { createLogger, serializeError } from '@frm/logging';
import {
  detectRosterDrift,
  runMappingValidation,
  runScheduledReconciliation,
  runSyncJob,
} from '@frm/core';
import { getPrisma } from '@frm/database';
import { JobName } from '@frm/queue';
import { SyncJobStatus } from '@frm/shared';

const log = createLogger('worker.processors');

/**
 * Builds the processor for the sync queue.
 * @param {{gateway: object}} deps
 */
export function createSyncProcessor({ gateway }) {
  return async function processSyncJob(job) {
    const { syncJobId } = job.data;
    const prisma = getPrisma();

    log.info(
      { jobId: job.id, name: job.name, syncJobId, attempt: job.attemptsMade + 1 },
      'processing',
    );

    try {
      const result = await runSyncJob({
        jobId: syncJobId,
        gateway,
        prisma,
        onProgress: async ({ completed, total }) => {
          await job.updateProgress(total > 0 ? Math.round((completed / total) * 100) : 100);
        },
      });

      // A PARTIAL result means some actions failed for reasons that are recorded as
      // issues. Retrying the whole job would re-apply the successful ones for no gain,
      // so the job is complete and the issues are what get retried individually.
      return {
        status: result?.status ?? SyncJobStatus.COMPLETED,
        syncJobId,
      };
    } catch (error) {
      const retryable = error?.retryable === true;
      if (!retryable) {
        // Permanent failures are not retried: five attempts at "the bot lacks Manage
        // Roles" achieves nothing except rate limit consumption.
        log.error(
          { err: serializeError(error), syncJobId },
          'permanent sync failure; not retrying',
        );
        await job.discard();
      }
      throw error;
    }
  };
}

/** Builds the processor for the maintenance queue. */
export function createMaintenanceProcessor({ gateway }) {
  return async function processMaintenanceJob(job) {
    const prisma = getPrisma();

    switch (job.name) {
      case JobName.MAPPING_VALIDATION: {
        const report = await runMappingValidation({ gateway, prisma });
        await detectRosterDrift({ gateway, prisma }).catch((error) => {
          log.error({ err: serializeError(error) }, 'roster drift check failed');
        });
        return report;
      }

      case JobName.SCHEDULED_RECONCILIATION: {
        const result = await runScheduledReconciliation({ gateway, prisma });
        return { syncJobId: result?.id, status: result?.status };
      }

      default:
        log.warn({ name: job.name }, 'unknown maintenance job');
        return { skipped: true };
    }
  };
}

/**
 * Retry processor for individual failed role actions.
 *
 * Retrying re-plans the member rather than replaying the original API call, so a change
 * that is no longer correct is never re-applied.
 */
export function createRoleActionProcessor({ gateway }) {
  return async function processRoleAction(job) {
    const { syncJobId } = job.data;
    return runSyncJob({ jobId: syncJobId, gateway, prisma: getPrisma() });
  };
}

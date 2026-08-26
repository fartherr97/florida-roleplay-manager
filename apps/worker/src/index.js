/**
 * Worker process.
 *
 * Owns every write to Discord. The bot observes and commands; the worker executes. That
 * separation means a slow guild-wide resync can never block the bot's interaction
 * responses (Discord gives you three seconds), and the worker can be scaled
 * independently.
 */
process.env.FRM_SERVICE = process.env.FRM_SERVICE ?? 'worker';

import { Worker } from 'bullmq';
import { createLogger, serializeError } from '@frm/logging';
import { disconnectPrisma, waitForDatabase } from '@frm/database';
import { closeQueues, closeRedis, getBullConnection, scheduleMaintenanceJobs } from '@frm/queue';
import { QUEUE_NAMES, getEnv } from '@frm/shared';
import { createGatewayFromEnv } from '@frm/discord';
import {
  createMaintenanceProcessor,
  createRoleActionProcessor,
  createRosterProcessor,
  createSyncProcessor,
  createTransferProcessor,
} from './processors.js';

const log = createLogger('worker');

async function main() {
  // Fail closed: a worker without a database, Redis or bot token cannot do its job, and
  // starting anyway would silently accumulate a backlog.
  const env = getEnv({ service: 'worker' });
  log.info(
    { nodeEnv: env.NODE_ENV, devMode: env.devMode, concurrency: env.WORKER_CONCURRENCY },
    'starting worker',
  );

  // Wait for the database up front, before logging in to Discord or spinning up queues:
  // a fresh container's private network may not be ready in its first second, and a bare
  // check there would crash-loop a healthy database.
  await waitForDatabase();

  const { gateway, client } = await createGatewayFromEnv({ cacheMembers: false });
  const connection = getBullConnection();

  const workers = [
    new Worker(QUEUE_NAMES.SYNC, createSyncProcessor({ gateway }), {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
    }),
    new Worker(QUEUE_NAMES.ROLE_ACTION, createRoleActionProcessor({ gateway }), {
      connection,
      concurrency: Math.max(1, Math.floor(env.WORKER_CONCURRENCY / 2)),
    }),
    new Worker(QUEUE_NAMES.ROSTER, createRosterProcessor({ gateway }), {
      connection,
      concurrency: Math.max(1, Math.floor(env.WORKER_CONCURRENCY / 2)),
    }),
    // Transfers are manual and infrequent; a small concurrency keeps a burst of them from
    // contending with role synchronization for Discord's rate limit.
    new Worker(QUEUE_NAMES.TRANSFER, createTransferProcessor({ gateway }), {
      connection,
      concurrency: Math.max(1, Math.floor(env.WORKER_CONCURRENCY / 2)),
    }),
    // Maintenance sweeps touch the whole platform, so exactly one runs at a time.
    new Worker(QUEUE_NAMES.MAINTENANCE, createMaintenanceProcessor({ gateway }), {
      connection,
      concurrency: 1,
    }),
  ];

  for (const worker of workers) {
    worker.on('completed', (job) => {
      log.info({ queue: worker.name, jobId: job.id, name: job.name }, 'job completed');
    });
    worker.on('failed', (job, error) => {
      log.error(
        {
          queue: worker.name,
          jobId: job?.id,
          name: job?.name,
          attempts: job?.attemptsMade,
          err: serializeError(error),
        },
        'job failed',
      );
    });
    worker.on('error', (error) => {
      log.error({ queue: worker.name, err: serializeError(error) }, 'worker error');
    });
  }

  await scheduleMaintenanceJobs();

  log.info({ queues: workers.map((worker) => worker.name) }, 'worker ready');

  const shutdown = async (signal) => {
    log.info({ signal }, 'shutting down');
    // Close workers first so in-flight jobs finish before their dependencies disappear.
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await closeQueues().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await closeRedis().catch(() => {});
    client?.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: serializeError(reason) }, 'unhandled rejection');
  });
}

main().catch((error) => {
  log.fatal({ err: serializeError(error) }, 'worker failed to start');
  console.error(error);
  process.exit(1);
});

/**
 * API server.
 *
 * Serves the future Next.js dashboard. It never holds the Discord bot token and never
 * writes roles: it validates, authorizes, writes to the database and queues jobs, and
 * the worker does the rest.
 */
process.env.FRM_SERVICE = process.env.FRM_SERVICE ?? 'api';

import { createLogger, serializeError } from '@frm/logging';
import { disconnectPrisma, getPrisma } from '@frm/database';
import { closeQueues, closeRedis } from '@frm/queue';
import { getEnv } from '@frm/shared';
import { buildApp } from './app.js';

const log = createLogger('api');

async function main() {
  const env = getEnv({ service: 'api' });

  // Fail closed before binding a port: an API that accepts requests it cannot serve is
  // worse than one that visibly failed to start.
  await getPrisma().$queryRaw`SELECT 1`;

  const app = await buildApp();
  await app.listen({ host: env.API_HOST, port: env.API_PORT });

  log.info(
    {
      host: env.API_HOST,
      port: env.API_PORT,
      nodeEnv: env.NODE_ENV,
      corsOrigins: env.CORS_ALLOWED_ORIGINS,
    },
    'api listening',
  );

  const shutdown = async (signal) => {
    log.info({ signal }, 'shutting down');
    await app.close().catch(() => {});
    await closeQueues().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: serializeError(reason) }, 'unhandled rejection');
  });
}

main().catch((error) => {
  log.fatal({ err: serializeError(error) }, 'api failed to start');
  console.error(error);
  process.exit(1);
});

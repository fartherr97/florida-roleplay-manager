/**
 * Transfer config read for the website's transfer portal.
 *
 * The website's ES transfer portal applies the Discord role changes itself when a ticket is
 * processed, so it needs to know each department's strip/grant role sets. This is the same
 * server-to-server trust boundary as the whitelist ingest — authenticated by the shared
 * service token rather than a user session — and it is read-only: it never writes anything.
 */
import { timingSafeEqual } from 'node:crypto';
import { PreconditionError, UnauthenticatedError, getEnv } from '@frm/shared';
import { getTransferConfigForService } from '@frm/core';

/** Constant-time token comparison that tolerates differing lengths. */
function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export default async function transferSyncRoutes(fastify) {
  const env = getEnv();

  // Public (no session) but token-gated, sharing the whitelist ingest token: both are the
  // website calling this API server-to-server. skipCsrf because there is no cookie to
  // protect — the bearer-style service token is the authentication.
  fastify.get('/transfers/sync-config', { config: { skipCsrf: true } }, async (request) => {
    if (!env.WHITELIST_INGEST_TOKEN) {
      throw new PreconditionError('Service ingest is not configured on this server.');
    }
    const provided = request.headers['x-service-token'];
    if (!safeTokenEqual(String(provided ?? ''), env.WHITELIST_INGEST_TOKEN)) {
      throw new UnauthenticatedError('Invalid service token.');
    }

    return getTransferConfigForService();
  });
}

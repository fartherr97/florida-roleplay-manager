/**
 * Soft-whitelist ingest.
 *
 * The website forwards a submission here after the applicant filled in the questions and
 * signed in with Discord — so the website has already verified the applicant's Discord
 * identity. This is a server-to-server call, authenticated by a shared ingest token
 * rather than a user session, and it never touches Discord roles: it stores the
 * submission and posts it for staff review. Approval (and the role write) happens later,
 * in the bot's button handler.
 */
import { timingSafeEqual } from 'node:crypto';
import { PreconditionError, UnauthenticatedError, getEnv } from '@frm/shared';
import { submitWhitelist } from '@frm/core';

/** Constant-time token comparison that tolerates differing lengths. */
function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export default async function whitelistRoutes(fastify) {
  const env = getEnv();

  // Public (no session) but token-gated. skipCsrf because there is no cookie to protect:
  // authentication is the bearer-style service token, not a session.
  fastify.post('/whitelist/submissions', { config: { skipCsrf: true } }, async (request, reply) => {
    if (!env.WHITELIST_INGEST_TOKEN) {
      throw new PreconditionError('Whitelist ingest is not configured on this server.');
    }
    const provided = request.headers['x-service-token'];
    if (!safeTokenEqual(String(provided ?? ''), env.WHITELIST_INGEST_TOKEN)) {
      throw new UnauthenticatedError('Invalid service token.');
    }

    const result = await submitWhitelist(request.body ?? {});
    return reply.status(201).send(result);
  });
}

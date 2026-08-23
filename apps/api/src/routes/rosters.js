/**
 * Public roster endpoints.
 *
 * These are the ones the community website calls to render its staff pages, so unlike
 * every other route in this application they are deliberately unauthenticated - a public
 * roster page has no session to present.
 *
 * That makes the response shape a security boundary rather than a convenience. It is
 * built by `presentRoster` in `@frm/core` and contains only what already appears on the
 * page: rank, callsign, display name, Discord id. No platform user ids, no audit trail,
 * no indication of who is linked to an account, and unpublished rosters are not served at
 * all. If a field would be awkward to see scraped, it does not belong in here.
 *
 * The authenticated management endpoints for rosters live in `resources.js` with
 * everything else.
 */
import { createHash } from 'node:crypto';
import { getPublicRosters } from '@frm/core';
import { NotFoundError } from '@frm/shared';

/**
 * How long a website may reuse a roster response.
 *
 * Short, because a promotion should show up promptly, but not zero: a roster page is the
 * kind of link that gets posted in a Discord announcement and then opened by 200 people
 * in a minute.
 */
const CACHE_SECONDS = 60;

/** A weak ETag over the payload, so an unchanged roster costs a 304 rather than a body. */
function etagFor(payload) {
  return `W/"${createHash('sha1').update(JSON.stringify(payload)).digest('base64url')}"`;
}

/** Sends the payload with cache headers, or 304 when the caller already has it. */
function sendCached(request, reply, payload) {
  const etag = etagFor(payload);
  reply.header('cache-control', `public, max-age=${CACHE_SECONDS}`);
  reply.header('etag', etag);

  if (request.headers['if-none-match'] === etag) return reply.status(304).send();
  return reply.send(payload);
}

export default async function rosterRoutes(fastify) {
  fastify.get('/rosters', async (request, reply) => {
    const rosters = await getPublicRosters();
    return sendCached(request, reply, { rosters });
  });

  fastify.get('/rosters/:slug', async (request, reply) => {
    const [roster] = await getPublicRosters({ slug: String(request.params.slug).toLowerCase() });
    if (!roster) {
      throw new NotFoundError('No published roster with that slug.', {
        slug: request.params.slug,
      });
    }
    return sendCached(request, reply, { roster });
  });
}

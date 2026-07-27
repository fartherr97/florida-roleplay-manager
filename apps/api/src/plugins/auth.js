/**
 * Authentication.
 *
 * `requireAuth` turns a session into a fully loaded actor and a service context. The
 * actor is re-loaded from the database on every request rather than being cached in the
 * session, so revoking a permission takes effect immediately instead of when the
 * session happens to expire.
 *
 * Note what this plugin does *not* do: it never decides whether the actor may perform
 * the action. That decision belongs to the service, which is the only layer that knows
 * the resource being touched.
 */
import fp from 'fastify-plugin';
import { loadActor } from '@frm/authorization';
import { websiteContext } from '@frm/core';
import { UnauthenticatedError } from '@frm/shared';

async function authPlugin(fastify) {
  fastify.decorate('requireAuth', async function requireAuth(request) {
    if (!request.session?.userId) {
      throw new UnauthenticatedError('Sign in to continue.');
    }

    const actor = await loadActor({ userId: request.session.userId, required: false });
    if (!actor) {
      throw new UnauthenticatedError('Your account is no longer available.');
    }
    if (!actor.user.websiteAccess) {
      throw new UnauthenticatedError('Your account does not have website access.');
    }

    request.actor = actor;
    request.ctx = websiteContext(actor, {
      requestId: request.requestId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return request.ctx;
  });

  // Applied per route via `onRequest`/`preHandler`, so public endpoints (health, the
  // OAuth entry points) can opt out explicitly rather than by omission.
  fastify.decorate('authenticated', {
    preHandler: async (request) => {
      await fastify.requireAuth(request);
    },
  });
}

export default fp(authPlugin, { name: 'frm-auth' });

/**
 * Sessions and CSRF.
 *
 * Sessions live in Redis, keyed by a random identifier that is stored in a signed,
 * httpOnly, SameSite cookie. The browser never receives anything about the member
 * except an opaque id, and revoking a session is a single Redis delete.
 *
 * CSRF uses the double-submit pattern: a random token is stored in the session and
 * mirrored in a readable cookie, and unsafe requests must echo it in a header. An
 * attacker's page can cause the browser to send the session cookie, but cannot read the
 * CSRF cookie to construct the matching header.
 */
import fp from 'fastify-plugin';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { REDIS_PREFIX, UnauthenticatedError, getEnv } from '@frm/shared';
import { getRedis } from '@frm/queue';

export const SESSION_COOKIE = 'frm_session';
export const CSRF_COOKIE = 'frm_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sessionKey(id) {
  return `${REDIS_PREFIX.SESSION}:${id}`;
}

/** Constant-time comparison that tolerates differing lengths. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function sessionPlugin(fastify) {
  const env = getEnv();

  const cookieOptions = {
    path: '/',
    // Scoping to the shared parent domain is what lets the dashboard on another
    // subdomain read the (non-httpOnly) CSRF cookie to echo it back. Unset in
    // dev, where the cookie stays host-only.
    domain: env.COOKIE_DOMAIN || undefined,
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    signed: true,
    maxAge: env.SESSION_TTL_SECONDS,
  };

  /** Creates a session and sets both cookies. */
  fastify.decorateReply('createSession', async function createSession(payload) {
    const id = randomUUID();
    const csrfToken = randomBytes(32).toString('hex');
    const session = { ...payload, csrfToken, createdAt: new Date().toISOString() };

    await getRedis().set(sessionKey(id), JSON.stringify(session), 'EX', env.SESSION_TTL_SECONDS);

    this.setCookie(SESSION_COOKIE, id, cookieOptions);
    // Readable by the dashboard so it can echo the token back in a header.
    this.setCookie(CSRF_COOKIE, csrfToken, { ...cookieOptions, httpOnly: false, signed: false });

    return { id, session };
  });

  fastify.decorateReply('destroySession', async function destroySession() {
    const raw = this.request.cookies?.[SESSION_COOKIE];
    if (raw) {
      const unsigned = this.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        await getRedis().del(sessionKey(unsigned.value));
      }
    }
    // Clear with the same domain the cookies were set with, or a domain-scoped
    // cookie is not evicted and the browser keeps presenting a dead-session crumb.
    const clearOptions = { path: '/', domain: env.COOKIE_DOMAIN || undefined };
    this.clearCookie(SESSION_COOKIE, clearOptions);
    this.clearCookie(CSRF_COOKIE, clearOptions);
  });

  // Attach the session to every request, and enforce CSRF for unsafe methods.
  fastify.addHook('onRequest', async (request, reply) => {
    request.session = null;

    const raw = request.cookies?.[SESSION_COOKIE];
    if (!raw) return;

    const unsigned = reply.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;

    const stored = await getRedis().get(sessionKey(unsigned.value));
    if (!stored) return;

    try {
      request.session = { id: unsigned.value, ...JSON.parse(stored) };
    } catch {
      request.session = null;
    }
  });

  fastify.addHook('preHandler', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (request.routeOptions?.config?.skipCsrf) return;
    if (!request.session) return; // unauthenticated requests are rejected by requireAuth

    const provided = request.headers[CSRF_HEADER];
    if (!safeEqual(String(provided ?? ''), request.session.csrfToken)) {
      throw new UnauthenticatedError('CSRF token missing or invalid.');
    }
  });
}

export default fp(sessionPlugin, { name: 'frm-session', dependencies: ['@fastify/cookie'] });

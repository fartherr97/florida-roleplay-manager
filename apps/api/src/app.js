/**
 * Fastify application factory.
 *
 * Exported separately from the server entry point so tests can build the app, drive it
 * with `inject()` and never open a socket.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { getPrisma } from '@frm/database';
import { getRedis } from '@frm/queue';
import { getEnv } from '@frm/shared';
import errorsPlugin from './plugins/errors.js';
import sessionPlugin from './plugins/session.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import resourceRoutes from './routes/resources.js';

/**
 * @param {object} [options]
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp(options = {}) {
  const env = getEnv({ service: 'api' });

  const fastify = Fastify({
    // The application logger is pino via `@frm/logging`; Fastify's own request logging
    // is disabled to avoid two log formats and two redaction configurations.
    logger: false,
    trustProxy: env.API_TRUST_PROXY,
    bodyLimit: 1024 * 256,
    ...options,
  });

  await fastify.register(errorsPlugin);

  await fastify.register(helmet, {
    // The API serves JSON to a separate dashboard origin; a restrictive CSP here would
    // apply to responses that never render as documents.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: env.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
  });

  await fastify.register(cors, {
    // Credentials are cookies, so the origin allowlist must be explicit: `*` and
    // credentials are mutually exclusive for good reason.
    origin: env.CORS_ALLOWED_ORIGINS.length > 0 ? env.CORS_ALLOWED_ORIGINS : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  });

  await fastify.register(cookie, {
    secret: env.SESSION_SECRET,
    parseOptions: { path: '/', sameSite: 'lax', httpOnly: true, secure: env.COOKIE_SECURE },
  });

  await fastify.register(sessionPlugin);

  // Registered after the session plugin so the limiter can key on the signed-in member
  // rather than a shared NAT address.
  await fastify.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Rate limit per session where possible, falling back to IP for anonymous callers.
    keyGenerator: (request) => request.session?.userId ?? request.ip,
  });

  await fastify.register(authPlugin);

  // Liveness and readiness, deliberately unauthenticated so a load balancer can use them.
  fastify.get('/health', async () => ({ status: 'ok' }));

  fastify.get('/health/ready', async (request, reply) => {
    const checks = { database: false, redis: false };
    try {
      await getPrisma().$queryRaw`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
    }
    try {
      checks.redis = (await getRedis().ping()) === 'PONG';
    } catch {
      checks.redis = false;
    }

    const ready = checks.database && checks.redis;
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', checks });
  });

  await fastify.register(
    async (instance) => {
      await instance.register(authRoutes);
      await instance.register(resourceRoutes);
    },
    { prefix: '/api' },
  );

  return fastify;
}

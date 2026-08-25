/**
 * Discord OAuth login.
 *
 * The flow is standard authorization-code: the API keeps the client secret, the browser
 * only ever sees an opaque session cookie, and the bot token is never involved.
 *
 * A Discord account that is not linked to a platform member cannot sign in. Creating
 * members is a deliberate, audited action (`/member link`), not a side effect of
 * somebody visiting the login page.
 */
import { randomBytes } from 'node:crypto';
import { createLogger } from '@frm/logging';
import { getPrisma } from '@frm/database';
import { recordAudit, websiteContext } from '@frm/core';
import { loadActor } from '@frm/authorization';
import {
  ActionSource,
  AuditAction,
  PreconditionError,
  REDIS_PREFIX,
  UnauthenticatedError,
  getEnv,
} from '@frm/shared';
import { getRedis } from '@frm/queue';

const log = createLogger('api.auth');
const OAUTH_STATE_TTL = 600;

export default async function authRoutes(fastify) {
  const env = getEnv();
  const configured = Boolean(
    env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.DISCORD_OAUTH_REDIRECT_URI,
  );

  /** Starts the OAuth flow. */
  fastify.get('/auth/discord', async (request, reply) => {
    if (!configured) {
      throw new PreconditionError('Discord sign-in is not configured on this server.');
    }

    // The state parameter is stored server side and single use, which is what prevents
    // login CSRF (an attacker completing a flow into somebody else's browser).
    const state = randomBytes(32).toString('hex');
    await getRedis().set(`${REDIS_PREFIX.OAUTH_STATE}:${state}`, '1', 'EX', OAUTH_STATE_TTL);

    const url = new URL('https://discord.com/api/oauth2/authorize');
    url.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
    url.searchParams.set('redirect_uri', env.DISCORD_OAUTH_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'none');

    return reply.redirect(url.toString());
  });

  /** OAuth callback: exchange the code, resolve the member, create the session. */
  fastify.get('/auth/discord/callback', { config: { skipCsrf: true } }, async (request, reply) => {
    if (!configured) {
      throw new PreconditionError('Discord sign-in is not configured on this server.');
    }

    const { code, state } = request.query ?? {};
    if (!code || !state) throw new UnauthenticatedError('The sign-in request was incomplete.');

    const consumed = await getRedis().del(`${REDIS_PREFIX.OAUTH_STATE}:${state}`);
    if (consumed !== 1) {
      throw new UnauthenticatedError('That sign-in link has expired. Please try again.');
    }

    const discordUser = await exchangeCode(String(code), env);
    const prisma = getPrisma();

    const identity = await prisma.discordIdentity.findUnique({
      where: { discordUserId: discordUser.id },
      include: { user: true },
    });

    if (!identity || identity.user.deletedAt) {
      // Deliberately does not create an account.
      throw new UnauthenticatedError(
        'That Discord account is not linked to a community member. Ask an administrator to link it.',
      );
    }
    if (!identity.user.websiteAccess) {
      throw new UnauthenticatedError('Your account does not have website access.');
    }

    // Keep the cached Discord profile fresh; it is what the dashboard displays.
    await prisma.discordIdentity.update({
      where: { id: identity.id },
      data: {
        username: discordUser.username ?? identity.username,
        globalName: discordUser.global_name ?? identity.globalName,
        avatarHash: discordUser.avatar ?? identity.avatarHash,
        verifiedAt: new Date(),
      },
    });

    await reply.createSession({
      userId: identity.userId,
      discordUserId: discordUser.id,
    });

    const actor = await loadActor({ userId: identity.userId, required: false });
    await recordAudit(prisma, {
      ctx: websiteContext(actor, {
        requestId: request.requestId,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      }),
      action: AuditAction.AUTH_LOGIN,
      targetUserId: identity.userId,
      targetDiscordId: discordUser.id,
    });

    log.info({ userId: identity.userId }, 'website sign-in');

    // Send the browser back to the dashboard rather than stranding it on this
    // JSON. The base is the configured dashboard URL, falling back to the first
    // allowed CORS origin; if neither is set (a bare API deployment) the JSON
    // response is kept so the flow still completes.
    const dashboardBase = env.DASHBOARD_URL || env.CORS_ALLOWED_ORIGINS[0];
    if (dashboardBase) {
      return reply.redirect(new URL('/management/bot', dashboardBase).toString());
    }
    return { ok: true, userId: identity.userId };
  });

  /** Ends the session. */
  fastify.post('/auth/logout', { config: { skipCsrf: false } }, async (request, reply) => {
    const userId = request.session?.userId;
    await reply.destroySession();

    if (userId) {
      await recordAudit(getPrisma(), {
        ctx: {
          actor: { user: { id: userId }, discordUserId: request.session?.discordUserId },
          source: ActionSource.WEBSITE,
          requestId: request.requestId,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
        action: AuditAction.AUTH_LOGOUT,
        targetUserId: userId,
      }).catch(() => {});
    }

    return { ok: true };
  });
}

/** Exchanges an authorization code for the Discord user profile. */
async function exchangeCode(code, env) {
  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.DISCORD_OAUTH_REDIRECT_URI,
  });

  const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000),
  });

  if (!tokenResponse.ok) {
    log.warn({ status: tokenResponse.status }, 'oauth token exchange failed');
    throw new UnauthenticatedError('Discord rejected the sign-in attempt.');
  }

  const token = await tokenResponse.json();

  const userResponse = await fetch('https://discord.com/api/users/@me', {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10000),
  });

  if (!userResponse.ok) {
    throw new UnauthenticatedError('Could not read your Discord profile.');
  }

  return userResponse.json();
}

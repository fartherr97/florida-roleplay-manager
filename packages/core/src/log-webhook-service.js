/**
 * Per-category log webhooks.
 *
 * Each log category (a global ban, a temp role) can post to its own Discord channel. The
 * URLs are set from the dashboard and stored in `log_webhooks`; a category with no row
 * falls back to the MOD_LOG_WEBHOOK_URL env var, so logging keeps working before anything
 * is configured. The URL is a webhook secret: it is stored in full (it has to be, to post)
 * but only ever returned to the browser as a masked preview.
 */
import { authorize } from '@frm/authorization';
import { getPrisma } from '@frm/database';
import { AuditAction, ValidationError, getEnv } from '@frm/shared';
import { createLogger, serializeError } from '@frm/logging';
import { recordAudit } from './audit-service.js';

const log = createLogger('core.log-webhook');

/** The log categories an operator can point at a channel, in display order. */
export const LOG_WEBHOOK_CATEGORIES = Object.freeze([
  {
    key: 'moderation',
    label: 'Global bans & unbans',
    description: 'Every /globalban and /globalunban, and timed-ban expiries.',
  },
  {
    key: 'temp_role',
    label: 'Temporary roles',
    description: 'Every /temprole add and remove, and temp-role expiries.',
  },
]);

const CATEGORY_KEYS = new Set(LOG_WEBHOOK_CATEGORIES.map((c) => c.key));
const WEBHOOK_URL = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

function assertKnownCategory(key) {
  if (!CATEGORY_KEYS.has(key)) throw new ValidationError(`Unknown log category "${key}".`);
}

/**
 * Masks a webhook URL for display: keeps the id, hides the token but for its last four.
 * `https://discord.com/api/webhooks/123456/AbCdEf…wxyz` -> `…/webhooks/123456/••••wxyz`.
 */
export function maskWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const match = url.match(/\/webhooks\/(\d+)\/(.+)$/);
  if (!match) return '••••';
  const [, id, token] = match;
  const tail = token.length > 4 ? token.slice(-4) : '';
  return `…/webhooks/${id}/••••${tail}`;
}

/**
 * The known categories, each with whether it is configured and a masked preview. Used by
 * the dashboard's webhook page. Never returns a full URL.
 */
export async function listLogWebhooks(ctx) {
  authorize(ctx.actor, { capability: 'system.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();

  const rows = await prisma.logWebhook.findMany({ where: { key: { in: [...CATEGORY_KEYS] } } });
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return {
    categories: LOG_WEBHOOK_CATEGORIES.map((category) => {
      const row = byKey.get(category.key);
      return {
        ...category,
        configured: Boolean(row),
        preview: row ? maskWebhookUrl(row.url) : null,
        updatedAt: row?.updatedAt ?? null,
      };
    }),
    // So the UI can say where an unconfigured category currently posts instead.
    fallbackConfigured: Boolean(getEnv().MOD_LOG_WEBHOOK_URL),
  };
}

/**
 * Points a category at a webhook URL, or clears it (url null/blank) to fall back to env.
 *
 * @param {object} ctx
 * @param {{key: string, url: string|null}} input
 */
export async function setLogWebhook(ctx, { key, url }) {
  authorize(ctx.actor, { capability: 'system.manage', scope: {} });
  assertKnownCategory(key);
  const prisma = ctx.prisma ?? getPrisma();

  const trimmed = typeof url === 'string' ? url.trim() : '';

  if (!trimmed) {
    await prisma.logWebhook.deleteMany({ where: { key } });
    await recordAudit(prisma, {
      ctx,
      action: AuditAction.LOG_WEBHOOK_CLEARED,
      newState: { key },
      reason: `Cleared the ${key} log webhook`,
    }).catch(() => {});
    return { key, configured: false, preview: null };
  }

  if (!WEBHOOK_URL.test(trimmed)) {
    throw new ValidationError('That is not a valid Discord webhook URL.');
  }

  const row = await prisma.logWebhook.upsert({
    where: { key },
    update: { url: trimmed },
    create: { key, url: trimmed },
  });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.LOG_WEBHOOK_SET,
    newState: { key, preview: maskWebhookUrl(trimmed) },
    reason: `Set the ${key} log webhook`,
  }).catch(() => {});

  return { key, configured: true, preview: maskWebhookUrl(row.url) };
}

/**
 * Posts a sample embed to a category's webhook so an operator can confirm they pasted the
 * right one and picked the right channel. Uses the resolved URL (configured row or env
 * fallback), so a category with no row tests the fallback.
 *
 * @param {object} ctx
 * @param {{key: string}} input
 */
export async function testLogWebhook(ctx, { key }) {
  authorize(ctx.actor, { capability: 'system.manage', scope: {} });
  assertKnownCategory(key);

  const url = await resolveLogWebhookUrl(key, { env: getEnv(), prisma: ctx.prisma });
  if (!url) {
    throw new ValidationError('No webhook is set for this category, and no fallback is configured.');
  }

  const category = LOG_WEBHOOK_CATEGORIES.find((c) => c.key === key);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Florida Roleplay Manager',
        embeds: [
          {
            title: 'Test log message',
            description: `This channel is now receiving **${category?.label ?? key}** logs.`,
            color: 0x57f287,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { delivered: false, reason: `status ${response.status}` };
    return { delivered: true };
  } catch (error) {
    log.error({ err: serializeError(error), key }, 'log webhook test failed');
    return { delivered: false, reason: 'request failed' };
  }
}

/**
 * Resolves the webhook URL a log category should post to: its configured row, or the
 * MOD_LOG_WEBHOOK_URL env fallback. Best effort — a DB error falls back to env rather than
 * dropping the log. Not authorized: this is called from inside logging, not from a request.
 *
 * @param {string} category
 * @param {{env?: object, prisma?: object}} [deps]
 * @returns {Promise<string|null>}
 */
export async function resolveLogWebhookUrl(category, { env = getEnv(), prisma } = {}) {
  if (category && CATEGORY_KEYS.has(category)) {
    try {
      const db = prisma ?? getPrisma();
      const row = await db.logWebhook.findUnique({ where: { key: category } });
      if (row?.url) return row.url;
    } catch (error) {
      log.warn({ err: serializeError(error), category }, 'log webhook lookup failed; using env fallback');
    }
  }
  return env.MOD_LOG_WEBHOOK_URL ?? null;
}

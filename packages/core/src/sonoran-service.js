/**
 * Sonoran CMS / CAD integration.
 *
 * When a member is globally banned they should lose the whole platform, not just
 * Discord — so a permanent global ban also bans their Sonoran account, and a global
 * unban lifts what Sonoran's API lets us lift. Everything here is best-effort and
 * additive: a Sonoran outage or missing credentials must never block the Discord ban
 * that was actually asked for, so failures are reported in the result rather than
 * thrown.
 *
 * The API contracts (from Sonoran's published documentation):
 *
 *   CMS  POST https://api.sonorancms.com/general/ban_account
 *          { id, key, type: 'BAN_ACCOUNT', data: [{ discord }] }
 *        POST https://api.sonorancms.com/general/get_com_account
 *          { id, key, type: 'GET_COM_ACCOUNT', data: [{ discord }] } -> { accId, ... }
 *        The CMS API documents no unban, so a global unban reports the CMS ban as a
 *        manual step instead of guessing at a request that might re-ban.
 *
 *   CAD  POST https://api.sonorancad.com/general/ban_user   (requires CAD Plus)
 *          { id, key, type: 'BAN_USER', data: [{ accId | apiId, isBan }] }
 *        `isBan: false` un-bans, so CAD is lifted automatically. The account is
 *        identified by the Sonoran account id resolved through CMS when possible,
 *        falling back to the Discord id as a CAD API ID (communities that link
 *        Discord use the snowflake as an identifier).
 */
import { createLogger } from '@frm/logging';
import { getEnv } from '@frm/shared';

const log = createLogger('core.sonoran');

const CMS_BASE = 'https://api.sonorancms.com';
const CAD_BASE = 'https://api.sonorancad.com';

/** The response texts Sonoran uses for "that Discord isn't linked to an account". */
const NOT_LINKED = /NOT LINKED|NO ACCOUNT FOUND/i;

function cmsCreds(env = getEnv()) {
  return env.SONORAN_CMS_COMMUNITY_ID && env.SONORAN_CMS_API_KEY
    ? { id: env.SONORAN_CMS_COMMUNITY_ID, key: env.SONORAN_CMS_API_KEY }
    : null;
}

function cadCreds(env = getEnv()) {
  return env.SONORAN_CAD_COMMUNITY_ID && env.SONORAN_CAD_API_KEY
    ? { id: env.SONORAN_CAD_COMMUNITY_ID, key: env.SONORAN_CAD_API_KEY }
    : null;
}

/** Whether any Sonoran product is configured — lets callers skip the whole step. */
export function sonoranConfigured(env = getEnv()) {
  return Boolean(cmsCreds(env) || cadCreds(env));
}

/** One Sonoran API call: returns {ok, status, text} and never throws. */
async function sonoranPost(base, path, body) {
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = (await res.text().catch(() => '')).slice(0, 400);
    return { ok: res.ok, status: res.status, text };
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timed out' : (error?.cause?.code ?? error?.message ?? 'failed');
    return { ok: false, status: 0, text: String(reason) };
  }
}

/**
 * The Sonoran account id (SSO UUID) behind a Discord id, via CMS. Null when CMS is not
 * configured, the lookup fails, or no account is linked — callers fall back to the
 * Discord id as a CAD API ID.
 */
async function resolveSonoranAccountId(cms, discordUserId) {
  if (!cms) return null;
  const res = await sonoranPost(CMS_BASE, '/general/get_com_account', {
    id: cms.id,
    key: cms.key,
    type: 'GET_COM_ACCOUNT',
    data: [{ discord: String(discordUserId) }],
  });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.text);
    const account = Array.isArray(parsed) ? parsed[0] : parsed;
    return account?.accId ?? null;
  } catch {
    return null;
  }
}

/**
 * Bans (or, for `ban: false`, lifts) a member's Sonoran access alongside a global ban.
 *
 * @param {object} params
 * @param {string} params.discordUserId
 * @param {boolean} params.ban true to ban, false to lift
 * @returns {Promise<Array<{system: string, status: 'applied'|'absent'|'manual'|'failed', message?: string}>>}
 *   one entry per configured product; empty when nothing is configured
 */
export async function applySonoranBan({ discordUserId, ban }) {
  const env = getEnv();
  const cms = cmsCreds(env);
  const cad = cadCreds(env);
  const results = [];
  if (!cms && !cad) return results;

  const id = String(discordUserId);
  const accId = cad ? await resolveSonoranAccountId(cms, id) : null;

  if (cms) {
    if (!ban) {
      // Sonoran's CMS API has no unban call; guessing at one risks re-banning.
      results.push({
        system: 'Sonoran CMS',
        status: 'manual',
        message: 'the API has no unban — lift it in the CMS panel',
      });
    } else {
      const res = await sonoranPost(CMS_BASE, '/general/ban_account', {
        id: cms.id,
        key: cms.key,
        type: 'BAN_ACCOUNT',
        data: [{ discord: id }],
      });
      if (res.ok) {
        results.push({ system: 'Sonoran CMS', status: 'applied' });
      } else if (NOT_LINKED.test(res.text)) {
        results.push({ system: 'Sonoran CMS', status: 'absent', message: 'no CMS account linked to this Discord' });
      } else {
        results.push({ system: 'Sonoran CMS', status: 'failed', message: res.text || `HTTP ${res.status}` });
        log.warn({ discordUserId: id, status: res.status, text: res.text }, 'CMS ban failed');
      }
    }
  }

  if (cad) {
    const res = await sonoranPost(CAD_BASE, '/general/ban_user', {
      id: cad.id,
      key: cad.key,
      type: 'BAN_USER',
      data: [{ ...(accId ? { accId } : { apiId: id }), isBan: ban }],
    });
    if (res.ok) {
      results.push({ system: 'Sonoran CAD', status: 'applied' });
    } else if (NOT_LINKED.test(res.text)) {
      results.push({ system: 'Sonoran CAD', status: 'absent', message: 'no CAD account linked to this Discord' });
    } else {
      results.push({ system: 'Sonoran CAD', status: 'failed', message: res.text || `HTTP ${res.status}` });
      log.warn({ discordUserId: id, status: res.status, text: res.text }, 'CAD ban call failed');
    }
  }

  log.info({ discordUserId: id, ban, results }, 'sonoran ban processed');
  return results;
}

/** Renders per-system results as embed lines. `verb` is 'Banned' or 'Unbanned'. */
export function formatSonoranResults(results, verb) {
  return (results ?? []).map((entry) => {
    if (entry.status === 'applied') return `${verb} — ${entry.system}`;
    if (entry.status === 'absent') return `Skipped — ${entry.system}: ${entry.message}`;
    if (entry.status === 'manual') return `Manual — ${entry.system}: ${entry.message}`;
    return `Failed — ${entry.system}: ${entry.message ?? 'failed'}`;
  });
}

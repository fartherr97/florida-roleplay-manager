/**
 * Human duration parsing for temp bans and the like.
 *
 * Accepts compact forms an operator types quickly — "7d", "6h", "30m", "1d12h" — and
 * treats an empty value or "permanent" as no expiry. Returns milliseconds, or null for
 * permanent, and throws on anything it cannot read so a typo never becomes a silent
 * forever-ban (or a silent no-op).
 */
import { ValidationError } from './errors.js';

const UNIT_MS = Object.freeze({
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
});

const PERMANENT = new Set(['', 'permanent', 'perm', 'forever', 'none', '0']);

/**
 * @param {string|null|undefined} input e.g. "7d", "6h", "30m", "1d12h", "permanent"
 * @returns {number|null} milliseconds, or null for a permanent (no-expiry) ban
 */
export function parseDuration(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (PERMANENT.has(raw)) return null;

  const compact = raw.replace(/\s+/g, '');
  if (!/^(\d+[wdhms])+$/.test(compact)) {
    throw new ValidationError(
      `Couldn't read a duration from "${input}". Use forms like 7d, 6h, 30m, or 1d12h — or leave it blank for permanent.`,
    );
  }

  let ms = 0;
  for (const [, amount, unit] of compact.matchAll(/(\d+)([wdhms])/g)) {
    ms += Number(amount) * UNIT_MS[unit];
  }
  return ms > 0 ? ms : null;
}

/** "3d 4h", "45m", "just now" — a compact human rendering of a millisecond span. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < 1000) return 'just now';
  const units = [
    ['w', UNIT_MS.w],
    ['d', UNIT_MS.d],
    ['h', UNIT_MS.h],
    ['m', UNIT_MS.m],
  ];
  const parts = [];
  let rest = total;
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ') || '<1m';
}

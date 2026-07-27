/**
 * Query helpers shared by the services.
 */
import { PAGINATION } from '@frm/shared';

/** Filter fragment for soft-deleted rows. */
export const notDeleted = Object.freeze({ deletedAt: null });

/**
 * Builds Prisma `skip`/`take` from validated pagination input.
 * @param {{page?: number, pageSize?: number}} input
 */
export function toSkipTake({ page = 1, pageSize = PAGINATION.DEFAULT_PAGE_SIZE } = {}) {
  const safePageSize = Math.min(Math.max(1, pageSize), PAGINATION.MAX_PAGE_SIZE);
  const safePage = Math.max(1, page);
  return { skip: (safePage - 1) * safePageSize, take: safePageSize };
}

/**
 * Wraps rows and a total count into the paginated envelope the API returns and the bot
 * uses for pagination buttons.
 *
 * @template T
 * @param {T[]} items
 * @param {number} total
 * @param {{page?: number, pageSize?: number}} input
 */
export function toPage(items, total, { page = 1, pageSize = PAGINATION.DEFAULT_PAGE_SIZE } = {}) {
  const safePageSize = Math.min(Math.max(1, pageSize), PAGINATION.MAX_PAGE_SIZE);
  return {
    items,
    pagination: {
      page,
      pageSize: safePageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)),
      hasNext: page * safePageSize < total,
      hasPrevious: page > 1,
    },
  };
}

/**
 * Builds an `orderBy` clause from an allowlisted field.
 *
 * The field must already have been validated against an enum; this helper only maps
 * dotted virtual fields (like `rankOrder`) onto their relation path.
 *
 * @param {string} sortBy
 * @param {'asc'|'desc'} sortDir
 * @param {Record<string, object>} [virtualFields]
 */
export function toOrderBy(sortBy, sortDir = 'desc', virtualFields = {}) {
  if (virtualFields[sortBy]) {
    return applyDirection(virtualFields[sortBy], sortDir);
  }
  return { [sortBy]: sortDir };
}

function applyDirection(shape, sortDir) {
  const output = {};
  for (const [key, value] of Object.entries(shape)) {
    output[key] = value === true ? sortDir : applyDirection(value, sortDir);
  }
  return output;
}

/**
 * Only rows that are currently in force: not revoked and not expired.
 * @param {Date} [now]
 */
export function currentlyEffective(now = new Date()) {
  return {
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

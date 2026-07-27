/**
 * Primitive schemas shared by every boundary.
 *
 * Nothing that arrives from Discord or from the website is trusted: interaction options
 * are user-controlled strings, and the frontend can send any identifier it likes. Every
 * one of them is parsed here before a service ever sees it.
 */
import { z } from 'zod';
import {
  CALLSIGN_PATTERN,
  PAGINATION,
  SLUG_PATTERN,
  SNOWFLAKE_PATTERN,
  ValidationError,
  extractSnowflake,
} from '@frm/shared';

/** A Discord snowflake, accepted either raw or as a `<@123>` style mention. */
export const snowflake = z
  .string()
  .trim()
  .min(1, 'A Discord ID is required')
  .transform(extractSnowflake)
  .refine((value) => SNOWFLAKE_PATTERN.test(value), {
    message: 'Must be a valid Discord ID (17-20 digits)',
  });

export const optionalSnowflake = snowflake.optional();

/** Internal database identifier. */
export const uuid = z.string().trim().uuid('Must be a valid identifier');

export const optionalUuid = uuid.optional();

/** URL-safe key used for departments, certifications and subdivisions. */
export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_PATTERN, 'Must be 2-32 lowercase letters, numbers or dashes');

export const callsign = z
  .string()
  .trim()
  .toUpperCase()
  .regex(CALLSIGN_PATTERN, 'Callsigns are 2-16 letters, numbers or dashes');

/** Free text reason attached to auditable actions. */
export const reason = z
  .string()
  .trim()
  .min(3, 'Please give a reason of at least 3 characters')
  .max(500, 'Reason must be 500 characters or fewer');

export const optionalReason = reason.optional();

export const notes = z.string().trim().max(2000).optional();

export const displayName = z.string().trim().min(1).max(100);

/** ISO timestamp accepted from the API, normalized to a Date. */
export const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Must be an ISO-8601 date' })
  .transform((value) => new Date(value));

export const optionalIsoDate = isoDate.optional();

/** Standard pagination envelope for every list endpoint. */
export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGINATION.MAX_PAGE_SIZE)
    .default(PAGINATION.DEFAULT_PAGE_SIZE),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Builds a pagination schema restricted to an explicit allowlist of sortable columns.
 * Passing user input straight into a Prisma `orderBy` key would let a client sort by, and
 * therefore infer, columns they cannot read.
 *
 * @param {string[]} sortableFields
 * @param {string} defaultField
 */
export function paginationWithSort(sortableFields, defaultField) {
  return pagination.extend({
    sortBy: z.enum(sortableFields).default(defaultField),
  });
}

/** Boolean coming from a query string or a slash command option. */
export const booleanFlag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['true', '1', 'yes'].includes(value);
  });

/**
 * Parses input and throws a `ValidationError` with a readable, aggregated message.
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} input
 * @param {string} [label]
 * @returns {T}
 */
export function parseOrThrow(schema, input, label = 'input') {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || label,
    message: issue.message,
  }));
  const summary = issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ');
  throw new ValidationError(summary, { issues });
}

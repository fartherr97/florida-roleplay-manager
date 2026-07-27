/**
 * Application error taxonomy.
 *
 * Every error that can reach a user boundary (slash command reply or HTTP response)
 * carries a stable `code`, a `userMessage` that is safe to display, and an HTTP status.
 * Internal detail stays in `details` and is only ever written to structured logs, never
 * returned to a client.
 */

/** Stable machine-readable error codes. */
export const ErrorCode = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  GUILD_NOT_APPROVED: 'GUILD_NOT_APPROVED',
  MAPPING_CYCLE: 'MAPPING_CYCLE',
  PROTECTED_ROLE: 'PROTECTED_ROLE',
  ROLE_HIERARCHY: 'ROLE_HIERARCHY',
  RANK_CEILING: 'RANK_CEILING',
  SELF_MANAGEMENT: 'SELF_MANAGEMENT',
  THRESHOLD_EXCEEDED: 'THRESHOLD_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  DISCORD_ERROR: 'DISCORD_ERROR',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
});

/**
 * Base class for all deliberate application errors.
 */
export class AppError extends Error {
  /**
   * @param {object} options
   * @param {string} options.code stable error code
   * @param {string} options.message internal message (may contain detail)
   * @param {string} [options.userMessage] safe message for end users
   * @param {number} [options.httpStatus]
   * @param {Record<string, unknown>} [options.details] structured, non-sensitive context
   * @param {boolean} [options.retryable]
   * @param {Error} [options.cause]
   */
  constructor({
    code = ErrorCode.INTERNAL,
    message,
    userMessage,
    httpStatus = 500,
    details = {},
    retryable = false,
    cause,
  }) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.userMessage = userMessage ?? 'Something went wrong. Please contact an administrator.';
    this.httpStatus = httpStatus;
    this.details = details;
    this.retryable = retryable;
    this.isAppError = true;
    Error.captureStackTrace?.(this, new.target);
  }

  /** Representation that is safe to send to a client. */
  toPublicJSON() {
    return {
      error: {
        code: this.code,
        message: this.userMessage,
        details: this.details,
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message, details = {}) {
    super({
      code: ErrorCode.VALIDATION_FAILED,
      message,
      userMessage: message,
      httpStatus: 400,
      details,
    });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required.') {
    super({
      code: ErrorCode.UNAUTHENTICATED,
      message,
      userMessage: message,
      httpStatus: 401,
    });
  }
}

/**
 * Authorization failure. `userMessage` explains *what* was missing without leaking
 * the existence of resources the actor cannot see.
 */
export class AuthorizationError extends AppError {
  constructor(message, details = {}) {
    super({
      code: ErrorCode.FORBIDDEN,
      message,
      userMessage: message,
      httpStatus: 403,
      details,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(resource, identifier) {
    super({
      code: ErrorCode.NOT_FOUND,
      message: `${resource} not found: ${identifier}`,
      userMessage: `That ${resource.toLowerCase()} could not be found.`,
      httpStatus: 404,
      details: { resource },
    });
  }
}

export class ConflictError extends AppError {
  constructor(message, details = {}) {
    super({
      code: ErrorCode.CONFLICT,
      message,
      userMessage: message,
      httpStatus: 409,
      details,
    });
  }
}

export class PreconditionError extends AppError {
  constructor(message, details = {}) {
    super({
      code: ErrorCode.PRECONDITION_FAILED,
      message,
      userMessage: message,
      httpStatus: 422,
      details,
    });
  }
}

export class GuildNotApprovedError extends AppError {
  constructor(discordGuildId) {
    super({
      code: ErrorCode.GUILD_NOT_APPROVED,
      message: `Guild ${discordGuildId} is not on the approved allowlist`,
      userMessage:
        'This Discord server is not approved for the Florida Roleplay Manager platform. ' +
        'Contact a global administrator if this is a mistake.',
      httpStatus: 403,
      details: { discordGuildId },
    });
  }
}

export class MappingCycleError extends AppError {
  /**
   * @param {string[]} chain human readable chain description
   */
  constructor(chain) {
    super({
      code: ErrorCode.MAPPING_CYCLE,
      message: `Mapping would create a synchronization loop: ${chain.join(' -> ')}`,
      userMessage:
        'This mapping would create a synchronization loop and was rejected.\n' +
        `Conflicting chain: ${chain.join(' → ')}`,
      httpStatus: 409,
      details: { chain },
    });
  }
}

export class ProtectedRoleError extends AppError {
  constructor(message, details = {}) {
    super({
      code: ErrorCode.PROTECTED_ROLE,
      message,
      userMessage: message,
      httpStatus: 403,
      details,
    });
  }
}

export class RoleHierarchyError extends AppError {
  constructor(message, details = {}) {
    super({
      code: ErrorCode.ROLE_HIERARCHY,
      message,
      userMessage: message,
      httpStatus: 422,
      details,
    });
  }
}

export class RankCeilingError extends AppError {
  constructor(message, details = {}) {
    super({
      code: ErrorCode.RANK_CEILING,
      message,
      userMessage: message,
      httpStatus: 403,
      details,
    });
  }
}

export class SelfManagementError extends AppError {
  constructor(action) {
    super({
      code: ErrorCode.SELF_MANAGEMENT,
      message: `Actor attempted to perform ${action} on themselves`,
      userMessage: `You cannot ${action} yourself.`,
      httpStatus: 403,
      details: { action },
    });
  }
}

export class ThresholdExceededError extends AppError {
  constructor(count, threshold) {
    super({
      code: ErrorCode.THRESHOLD_EXCEEDED,
      message: `Change count ${count} exceeds configured threshold ${threshold}`,
      userMessage:
        `This operation would change ${count} roles, which is above the safety threshold ` +
        `of ${threshold}. The job has been paused for review.`,
      httpStatus: 409,
      details: { count, threshold },
    });
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterMs) {
    super({
      code: ErrorCode.RATE_LIMITED,
      message: `Rate limited, retry after ${retryAfterMs}ms`,
      userMessage: 'You are doing that too quickly. Please wait a moment and try again.',
      httpStatus: 429,
      details: { retryAfterMs },
      retryable: true,
    });
  }
}

/**
 * A failure returned by Discord. `issueType` maps onto {@link SyncIssueType} so the
 * worker can record precise, retryable-or-not failures.
 */
export class DiscordOperationError extends AppError {
  constructor({ message, issueType, userMessage, retryable = false, details = {}, cause }) {
    super({
      code: ErrorCode.DISCORD_ERROR,
      message,
      userMessage: userMessage ?? message,
      httpStatus: 502,
      details: { ...details, issueType },
      retryable,
      cause,
    });
    this.issueType = issueType;
  }
}

export class DependencyUnavailableError extends AppError {
  constructor(dependency, cause) {
    super({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      message: `${dependency} is unavailable`,
      userMessage: 'A required backend service is temporarily unavailable. Please try again.',
      httpStatus: 503,
      details: { dependency },
      retryable: true,
      cause,
    });
  }
}

/**
 * @param {unknown} error
 * @returns {error is AppError}
 */
export function isAppError(error) {
  return Boolean(error) && typeof error === 'object' && error.isAppError === true;
}

/**
 * Normalizes any thrown value into an AppError without leaking internals.
 * @param {unknown} error
 * @returns {AppError}
 */
export function toAppError(error) {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError({
    code: ErrorCode.INTERNAL,
    message,
    httpStatus: 500,
    cause: error instanceof Error ? error : undefined,
  });
}

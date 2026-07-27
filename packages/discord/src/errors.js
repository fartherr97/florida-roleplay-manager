/**
 * Translation of Discord API failures into the platform's typed issue taxonomy.
 *
 * The distinction that matters most is retryable vs permanent. Retrying a "missing
 * permissions" error forever accomplishes nothing except burning rate limit; retrying a
 * 500 or a rate limit is exactly right.
 */
import { DiscordOperationError, SyncIssueType } from '@frm/shared';

/** Discord JSON error codes we handle explicitly. */
export const DiscordErrorCode = Object.freeze({
  UNKNOWN_GUILD: 10004,
  UNKNOWN_MEMBER: 10007,
  UNKNOWN_ROLE: 10011,
  UNKNOWN_USER: 10013,
  MISSING_ACCESS: 50001,
  MISSING_PERMISSIONS: 50013,
  RATE_LIMITED: 429,
});

/**
 * @param {unknown} error
 * @param {{discordGuildId?: string, discordUserId?: string, discordRoleId?: string}} [context]
 * @returns {DiscordOperationError}
 */
export function mapDiscordError(error, context = {}) {
  const code = error?.code ?? error?.status;
  const base = { details: context, cause: error instanceof Error ? error : undefined };

  switch (code) {
    case DiscordErrorCode.UNKNOWN_GUILD:
      return new DiscordOperationError({
        ...base,
        issueType: SyncIssueType.GUILD_UNAVAILABLE,
        message: `Guild ${context.discordGuildId} is unavailable to the bot`,
        userMessage: 'The bot is no longer in that Discord server.',
        retryable: false,
      });
    case DiscordErrorCode.UNKNOWN_MEMBER:
    case DiscordErrorCode.UNKNOWN_USER:
      return new DiscordOperationError({
        ...base,
        issueType: SyncIssueType.MEMBER_NOT_IN_GUILD,
        message: `Member ${context.discordUserId} is not in guild ${context.discordGuildId}`,
        userMessage: 'That member is not in the Discord server.',
        retryable: false,
      });
    case DiscordErrorCode.UNKNOWN_ROLE:
      return new DiscordOperationError({
        ...base,
        issueType: SyncIssueType.ROLE_DELETED,
        message: `Role ${context.discordRoleId} no longer exists`,
        userMessage: 'That Discord role has been deleted.',
        retryable: false,
      });
    case DiscordErrorCode.MISSING_PERMISSIONS:
    case DiscordErrorCode.MISSING_ACCESS:
      return new DiscordOperationError({
        ...base,
        issueType: SyncIssueType.BOT_MISSING_PERMISSION,
        message: `Bot lacks permission in guild ${context.discordGuildId}`,
        userMessage:
          'The bot does not have permission to manage that role. Check that it has Manage Roles ' +
          'and that its highest role sits above the role being changed.',
        retryable: false,
      });
    case DiscordErrorCode.RATE_LIMITED:
      return new DiscordOperationError({
        ...base,
        issueType: SyncIssueType.RATE_LIMITED,
        message: 'Discord rate limit reached',
        userMessage: 'Discord is rate limiting the bot. The change will be retried automatically.',
        retryable: true,
      });
    default:
      break;
  }

  if (isTimeout(error)) {
    return new DiscordOperationError({
      ...base,
      issueType: SyncIssueType.API_TIMEOUT,
      message: 'Discord API request timed out',
      userMessage: 'Discord did not respond in time. The change will be retried.',
      retryable: true,
    });
  }

  const status = Number(error?.status ?? 0);
  const retryable = status >= 500 || status === 0;

  return new DiscordOperationError({
    ...base,
    issueType: SyncIssueType.DISCORD_ERROR,
    message: error?.message ? `Discord error: ${error.message}` : 'Unknown Discord error',
    userMessage: 'Discord returned an unexpected error.',
    retryable,
  });
}

function isTimeout(error) {
  const name = error?.name ?? '';
  const message = error?.message ?? '';
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    /timed?\s?out/i.test(message) ||
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

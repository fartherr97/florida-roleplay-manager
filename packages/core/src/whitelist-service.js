/**
 * Soft whitelist.
 *
 * A prospective player answers a few quick questions on the website. The website forwards
 * the submission here (server-to-server, authenticated by a shared ingest token); this
 * stores it and posts it to a staff review channel with Approve / Deny buttons. A staff
 * member clicking Approve assigns the configured whitelist role in the main community
 * guild, which is what lets them onto the game server.
 *
 * The review message is posted with the bot's own token, so its buttons are authored by
 * the application and their interactions come back to the bot — see the persistent button
 * router in apps/bot. The only Discord *role* write is the approval, and it happens in the
 * bot (never the API), guarded by the same `checkRoleOperation` preflight the sync engine
 * uses.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import {
  ActionSource,
  AuditAction,
  GuildType,
  PreconditionError,
  ValidationError,
  getEnv,
  newRequestId,
} from '@frm/shared';
import { authorize } from '@frm/authorization';
import { checkRoleOperation, editChannelMessage, postChannelMessage } from '@frm/discord';
import { parseOrThrow, whitelistDecisionSchema, whitelistSubmissionSchema } from '@frm/validation';
import { recordAudit } from './audit-service.js';

const log = createLogger('core.whitelist');

/**
 * The capability a staff member must hold to approve or deny a whitelist. Deliberately an
 * existing capability rather than a new one: linking/onboarding a member is what a
 * whitelist decision is, and `member.link` (STAFF) already means "may onboard a member".
 * Change this one line to move the gate.
 */
const REVIEW_CAPABILITY = 'member.link';

const COLORS = Object.freeze({ pending: 0x3b82f6, approved: 0x22c55e, denied: 0xef4444 });

/** The embed fields for a submission's answers, clamped to Discord's limits. */
function answerFields(submission) {
  return (Array.isArray(submission.answers) ? submission.answers : []).slice(0, 20).map((qa) => ({
    name: String(qa?.question ?? 'Question').slice(0, 256),
    value: String(qa?.answer ?? '—').slice(0, 1024) || '—',
    inline: false,
  }));
}

/** The review message payload: the answers plus Approve/Deny buttons. */
function buildReviewPayload(submission) {
  return {
    embeds: [
      {
        title: 'Whitelist application',
        description: `From <@${submission.discordUserId}> (${submission.username})`,
        color: COLORS.pending,
        fields: answerFields(submission),
        footer: { text: `Submission ${submission.id}` },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Approve', custom_id: `wl:approve:${submission.id}` },
          { type: 2, style: 4, label: 'Deny', custom_id: `wl:deny:${submission.id}` },
        ],
      },
    ],
  };
}

/** The message payload after a decision: the outcome, and no buttons. */
function buildDecidedPayload(submission, { reviewerDiscordId, roleResult, reason = null }) {
  const approved = submission.status === 'APPROVED';
  const reviewer = reviewerDiscordId ? `<@${reviewerDiscordId}>` : 'a staff member';
  const roleNote =
    approved && roleResult && !roleResult.assigned
      ? `\n⚠️ The whitelist role was not assigned: ${roleResult.message}`
      : '';
  const reasonNote = !approved && reason ? `\n**Reason:** ${reason}` : '';
  const outcome = approved ? `✅ Approved by ${reviewer}` : `❌ Denied by ${reviewer}`;

  return {
    embeds: [
      {
        title: 'Whitelist application',
        description: `From <@${submission.discordUserId}> (${submission.username})\n\n${outcome}${reasonNote}${roleNote}`,
        color: approved ? COLORS.approved : COLORS.denied,
        fields: answerFields(submission),
        footer: { text: `Submission ${submission.id}` },
      },
    ],
    components: [],
  };
}

/**
 * Stores a website submission and posts it for staff review.
 *
 * @param {object} input {discordUserId, username, answers:[{question, answer}]}
 * @returns {Promise<{id: string, status: string}>}
 */
export async function submitWhitelist(input) {
  const data = parseOrThrow(whitelistSubmissionSchema, input);
  const env = getEnv();

  if (!env.WHITELIST_REVIEW_CHANNEL_ID || !env.DISCORD_BOT_TOKEN) {
    throw new PreconditionError(
      'Whitelist review is not configured on this server (missing review channel or bot token).',
    );
  }

  const prisma = getPrisma();

  const submission = await prisma.whitelistSubmission.create({
    data: {
      discordUserId: data.discordUserId,
      username: data.username,
      answers: data.answers,
      status: 'PENDING',
    },
  });

  try {
    const message = await postChannelMessage({
      token: env.DISCORD_BOT_TOKEN,
      channelId: env.WHITELIST_REVIEW_CHANNEL_ID,
      body: buildReviewPayload(submission),
    });
    await prisma.whitelistSubmission.update({
      where: { id: submission.id },
      data: { channelId: env.WHITELIST_REVIEW_CHANNEL_ID, messageId: String(message.id) },
    });
  } catch (error) {
    log.error({ err: serializeError(error), id: submission.id }, 'could not post whitelist review');
    throw new PreconditionError(
      'Your answers were saved but could not be posted for review. Please let staff know.',
    );
  }

  await recordAudit(prisma, {
    ctx: {
      actor: { user: { id: null }, discordUserId: data.discordUserId },
      source: ActionSource.WEBSITE,
      requestId: newRequestId(),
    },
    action: AuditAction.WHITELIST_SUBMITTED,
    targetDiscordId: data.discordUserId,
    newState: { submissionId: submission.id, username: data.username },
  }).catch(() => {});

  log.info({ id: submission.id, discordUserId: data.discordUserId }, 'whitelist submitted');
  return { id: submission.id, status: submission.status };
}

/** Assigns the whitelist role in the main guild, guarded by the standard preflight. */
async function assignWhitelistRole({ discordUserId, env, gateway }) {
  if (!env.WHITELIST_ROLE_ID) {
    return { assigned: false, message: 'No whitelist role is configured.' };
  }
  const prisma = getPrisma();
  const mainGuild = await prisma.approvedGuild.findFirst({
    where: { type: GuildType.MAIN_COMMUNITY, enabled: true, ...notDeleted },
  });
  if (!mainGuild) {
    return { assigned: false, message: 'No main community server is registered.' };
  }

  const preflight = await checkRoleOperation(gateway, {
    discordGuildId: mainGuild.discordGuildId,
    discordUserId,
    discordRoleId: env.WHITELIST_ROLE_ID,
  });
  if (!preflight.ok) return { assigned: false, message: preflight.message };

  try {
    await gateway.addRole(
      mainGuild.discordGuildId,
      discordUserId,
      env.WHITELIST_ROLE_ID,
      'Whitelist application approved',
    );
    return { assigned: true };
  } catch (error) {
    return { assigned: false, message: error?.userMessage ?? 'Discord rejected the role change.' };
  }
}

/**
 * Applies a staff Approve/Deny decision. Run by the bot's button handler.
 *
 * @param {import('./context.js').ServiceContext} ctx the reviewing staff member's context
 * @param {{submissionId: string, decision: 'approve'|'deny'}} input
 * @param {{gateway: object}} deps
 */
export async function decideWhitelist(ctx, input, { gateway }) {
  const data = parseOrThrow(whitelistDecisionSchema, input);
  authorize(ctx.actor, { capability: REVIEW_CAPABILITY, scope: {} });

  const env = getEnv();
  const prisma = ctx.prisma ?? getPrisma();

  const submission = await prisma.whitelistSubmission.findUnique({ where: { id: data.submissionId } });
  if (!submission) throw new ValidationError('That whitelist submission no longer exists.');
  if (submission.status !== 'PENDING') {
    return { alreadyHandled: true, status: submission.status };
  }

  const reviewerDiscordId = ctx.actor?.discordUserId ?? null;
  const reason = data.decision === 'deny' ? (data.reason ?? '').trim() || null : null;
  const roleResult =
    data.decision === 'approve'
      ? await assignWhitelistRole({ discordUserId: submission.discordUserId, env, gateway })
      : null;

  const status = data.decision === 'approve' ? 'APPROVED' : 'DENIED';
  const updated = await prisma.whitelistSubmission.update({
    where: { id: submission.id },
    data: { status, reviewedByDiscordId: reviewerDiscordId, reviewedAt: new Date() },
  });

  if (updated.channelId && updated.messageId && env.DISCORD_BOT_TOKEN) {
    await editChannelMessage({
      token: env.DISCORD_BOT_TOKEN,
      channelId: updated.channelId,
      messageId: updated.messageId,
      body: buildDecidedPayload(updated, { reviewerDiscordId, roleResult, reason }),
    }).catch((error) => {
      log.error({ err: serializeError(error), id: updated.id }, 'could not update whitelist message');
    });
  }

  await recordAudit(prisma, {
    ctx,
    action: status === 'APPROVED' ? AuditAction.WHITELIST_APPROVED : AuditAction.WHITELIST_DENIED,
    targetDiscordId: submission.discordUserId,
    reason,
    newState: {
      submissionId: submission.id,
      roleAssigned: roleResult?.assigned ?? false,
      roleMessage: roleResult?.message ?? null,
      denialReason: reason,
    },
  }).catch(() => {});

  log.info(
    { id: submission.id, status, reviewer: reviewerDiscordId, roleAssigned: roleResult?.assigned },
    'whitelist decided',
  );
  // discordUserId and reason are returned so the bot can DM the applicant with the outcome.
  return { status, roleResult, discordUserId: submission.discordUserId, reason };
}

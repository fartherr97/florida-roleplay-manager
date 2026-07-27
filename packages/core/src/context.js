/**
 * Service context.
 *
 * Every service call carries who is acting, where the request came from, and the
 * correlation id that ties the database change, the audit record, the queue job and the
 * log lines together. Passing this explicitly (rather than reading ambient state) is
 * what lets the same service function serve a slash command, an HTTP request and a
 * scheduled job without any of them being able to forget the audit trail.
 */
import { createSystemActor } from '@frm/authorization';
import { getPrisma } from '@frm/database';
import { ActionSource, newRequestId } from '@frm/shared';

/**
 * @typedef {object} ServiceContext
 * @property {import('@frm/authorization').ActorSnapshot} actor
 * @property {string} source one of ActionSource
 * @property {string} requestId
 * @property {string|null} ipAddress only meaningful for website actions
 * @property {string|null} userAgent
 * @property {import('@prisma/client').PrismaClient} prisma
 * @property {string|null} discordGuildId guild the command was issued in, when relevant
 */

/**
 * @param {object} params
 * @returns {ServiceContext}
 */
export function createServiceContext({
  actor,
  source = ActionSource.SYSTEM,
  requestId = newRequestId(),
  ipAddress = null,
  userAgent = null,
  prisma = getPrisma(),
  discordGuildId = null,
} = {}) {
  return Object.freeze({
    actor,
    source,
    requestId,
    ipAddress,
    userAgent,
    prisma,
    discordGuildId,
  });
}

/** Context for a Discord slash command. */
export function discordContext(actor, { requestId, discordGuildId } = {}) {
  return createServiceContext({
    actor,
    source: ActionSource.DISCORD,
    requestId,
    discordGuildId,
  });
}

/** Context for an authenticated website request. */
export function websiteContext(actor, { requestId, ipAddress, userAgent } = {}) {
  return createServiceContext({
    actor,
    source: ActionSource.WEBSITE,
    requestId,
    ipAddress,
    userAgent,
  });
}

/**
 * Context for automated work. The actor is the internal system actor, which is never
 * constructed from user input.
 *
 * @param {object} [options]
 * @param {boolean} [options.scheduled] distinguishes cron work from event-driven work
 */
export function systemContext({ scheduled = false, requestId, label = 'system' } = {}) {
  return createServiceContext({
    actor: createSystemActor(label),
    source: scheduled ? ActionSource.SCHEDULED : ActionSource.SYSTEM,
    requestId,
  });
}

/**
 * Resource endpoints.
 *
 * Every handler is three lines of translation: take the request, call the service, send
 * the result. All authorization, validation, transactions, auditing and synchronization
 * happen inside `@frm/core`, which is what guarantees the website and the Discord bot
 * enforce exactly the same rules.
 *
 * Note that no handler passes a caller-supplied scope to the service. Identifiers are
 * passed through and resolved server side, and the actor's scope is checked against the
 * resolved resource - that is the defence against IDOR.
 */
import {
  auditForMapping,
  auditForMember,
  bindRosterRank,
  cancelSyncJob,
  createMapping,
  createRoster,
  deleteMapping,
  deleteRoster,
  exportAuditLogs,
  getGuildStatus,
  getMapping,
  getRoster,
  getSyncJob,
  getSystemHealth,
  grantPermission,
  issueGrant,
  createTier,
  deleteTier,
  listAccessTiers,
  listCapabilities,
  listSelectableCapabilities,
  listTiers,
  updateTier,
  listGrants,
  listGuildDiscordRoles,
  listGuilds,
  listManagedRoles,
  listMappings,
  listMembers,
  listPermissions,
  listRosters,
  getTransfer,
  getTransferConfig,
  listSyncIssues,
  listSyncJobs,
  listTransfers,
  lookupMember,
  previewTransfer,
  queryAuditLogs,
  registerGuild,
  removeAccessTier,
  requestTransfer,
  removeGuild,
  removeManagedRole,
  resolveSyncIssue,
  resyncAll,
  resyncGuild,
  resyncMember,
  retrySyncIssue,
  revokeGrant,
  revokePermission,
  setAccessTier,
  setMappingEnabled,
  setRosterMemberDetails,
  setTransferRoles,
  syncRoster,
  testMapping,
  unbindRosterRank,
  updateGuildSettings,
  updateMapping,
  updateRoster,
  upsertManagedRole,
} from '@frm/core';
import { getRestGateway } from '@frm/discord';
import { getEnv } from '@frm/shared';

/**
 * Registers a route that requires authentication.
 *
 * The `preHandler` is attached here rather than trusted to each route, so a new endpoint
 * cannot accidentally be public.
 */
function route(fastify, method, url, handler) {
  fastify[method](url, { preHandler: fastify.authenticated.preHandler }, handler);
}

export default async function resourceRoutes(fastify) {
  // A read-only, REST-backed gateway so mapping create/enable/test can run their live
  // Discord checks from the API — which holds no gateway connection of its own. It only
  // reads (roles, the bot member, the guild); the worker remains the only writer.
  const gateway = getRestGateway({ env: getEnv() });

  // --- current user --------------------------------------------------------

  route(fastify, 'get', '/me', async (request) => {
    const profile = await lookupMember(request.ctx, { userId: request.actor.user.id });
    return {
      user: profile.user,
      grants: profile.grants,
      permissions: profile.permissions,
      // The dashboard echoes this back in the x-csrf-token header on writes.
      // Returning it here (rather than relying on the readable cookie) keeps
      // writes working when the dashboard and API are on different subdomains.
      csrfToken: request.session?.csrfToken ?? null,
      capabilities: request.actor.assignments.map((assignment) => ({
        capability: assignment.capabilityKey,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
        maxPermissionLevel: assignment.maxPermissionLevel,
      })),
    };
  });

  // --- guilds --------------------------------------------------------------

  route(fastify, 'get', '/guilds', (request) => listGuilds(request.ctx, request.query));
  route(fastify, 'post', '/guilds', (request) => registerGuild(request.ctx, request.body));
  route(fastify, 'get', '/guilds/:guildId/status', (request) =>
    getGuildStatus(request.ctx, { guildId: request.params.guildId }),
  );
  route(fastify, 'patch', '/guilds/:guildId', (request) =>
    updateGuildSettings(request.ctx, { ...request.body, guildId: request.params.guildId }),
  );
  route(fastify, 'delete', '/guilds/:guildId', (request) =>
    removeGuild(request.ctx, { ...request.body, guildId: request.params.guildId }),
  );

  // --- the guild's Discord roles -------------------------------------------

  // Read-through to Discord rather than to the database: these are Discord's roles, not
  // the platform's, so there is nothing local to serve. `guildId` is the platform id, so
  // the actor's scope is checked before any snowflake reaches Discord.
  route(fastify, 'get', '/guilds/:guildId/discord-roles', (request) =>
    listGuildDiscordRoles(request.ctx, {
      guildId: request.params.guildId,
      refresh: request.query?.refresh === 'true',
    }),
  );

  // --- managed roles -------------------------------------------------------

  route(fastify, 'get', '/roles', (request) => listManagedRoles(request.ctx, request.query));
  route(fastify, 'post', '/roles', (request) => upsertManagedRole(request.ctx, request.body));
  route(fastify, 'delete', '/roles/:managedRoleId', (request) =>
    removeManagedRole(request.ctx, {
      ...request.body,
      managedRoleId: request.params.managedRoleId,
    }),
  );

  // --- manual grants -------------------------------------------------------

  route(fastify, 'get', '/grants', (request) => listGrants(request.ctx, request.query));
  route(fastify, 'post', '/grants', (request) => issueGrant(request.ctx, request.body));
  route(fastify, 'delete', '/grants/:grantId', (request) =>
    revokeGrant(request.ctx, { ...request.body, grantId: request.params.grantId }),
  );

  // --- Discord-role access tiers -------------------------------------------

  // Mapping a Discord role to a tier is what grants website access in the first place, so
  // this is deliberately the one piece of configuration that also stays reachable from
  // Discord: locking yourself out of the dashboard must not lock you out of fixing it.
  // The plain-language capability catalogue an admin picks from when defining a tier, and the
  // named-tier CRUD. These sit under /access because they need the same `access.manage`
  // capability; the static /access/tiers and /access/capabilities paths are matched ahead of
  // the /access/:discordRoleId mapping delete, so they never collide.
  route(fastify, 'get', '/access/capabilities', (request) =>
    listSelectableCapabilities(request.ctx),
  );
  route(fastify, 'get', '/access/tiers', (request) => listTiers(request.ctx));
  route(fastify, 'post', '/access/tiers', (request) => createTier(request.ctx, request.body));
  route(fastify, 'patch', '/access/tiers/:id', (request) =>
    updateTier(request.ctx, { ...request.body, id: request.params.id }),
  );
  route(fastify, 'delete', '/access/tiers/:id', (request) =>
    deleteTier(request.ctx, { ...request.body, id: request.params.id }),
  );

  route(fastify, 'get', '/access', (request) => listAccessTiers(request.ctx));
  route(fastify, 'post', '/access', (request) => setAccessTier(request.ctx, request.body));
  route(fastify, 'delete', '/access/:discordRoleId', (request) =>
    removeAccessTier(request.ctx, {
      ...request.body,
      discordRoleId: request.params.discordRoleId,
    }),
  );

  // --- ES Transfer Portal --------------------------------------------------

  // Configuration is every department's transfer role set; a transfer strips the outgoing
  // set and grants the incoming one. Preview is read-only; requesting one queues the work
  // to the worker (the only process that writes to Discord) and returns a job id the
  // dashboard polls.
  route(fastify, 'get', '/transfers/config', (request) => getTransferConfig(request.ctx));
  route(fastify, 'post', '/transfers/config', (request) =>
    setTransferRoles(request.ctx, request.body),
  );
  route(fastify, 'post', '/transfers/preview', (request) =>
    previewTransfer(request.ctx, request.body),
  );
  route(fastify, 'post', '/transfers', (request) => requestTransfer(request.ctx, request.body));
  route(fastify, 'get', '/transfers', (request) => listTransfers(request.ctx, request.query));
  route(fastify, 'get', '/transfers/:jobId', (request) =>
    getTransfer(request.ctx, { jobId: request.params.jobId }),
  );

  // --- members -------------------------------------------------------------

  route(fastify, 'get', '/members', (request) => listMembers(request.ctx, request.query));
  route(fastify, 'get', '/members/lookup', (request) => lookupMember(request.ctx, request.query));
  route(fastify, 'get', '/members/:userId', (request) =>
    lookupMember(request.ctx, { userId: request.params.userId }),
  );
  route(fastify, 'get', '/members/:userId/audit', (request) =>
    auditForMember(request.ctx, { userId: request.params.userId, ...request.query }),
  );

  // --- mappings ------------------------------------------------------------

  route(fastify, 'get', '/mappings', (request) => listMappings(request.ctx, request.query));
  route(fastify, 'get', '/mappings/:mappingId', (request) =>
    getMapping(request.ctx, request.params.mappingId),
  );
  route(fastify, 'post', '/mappings', (request) =>
    createMapping(request.ctx, request.body, { gateway }),
  );
  route(fastify, 'patch', '/mappings/:mappingId', (request) =>
    updateMapping(request.ctx, { ...request.body, mappingId: request.params.mappingId }, { gateway }),
  );
  route(fastify, 'post', '/mappings/:mappingId/enabled', (request) =>
    setMappingEnabled(request.ctx, { ...request.body, mappingId: request.params.mappingId }, { gateway }),
  );
  route(fastify, 'post', '/mappings/:mappingId/test', (request) =>
    testMapping(request.ctx, { mappingId: request.params.mappingId }, { gateway }),
  );
  route(fastify, 'delete', '/mappings/:mappingId', (request) =>
    deleteMapping(request.ctx, { ...request.body, mappingId: request.params.mappingId }),
  );
  route(fastify, 'get', '/mappings/:mappingId/audit', (request) =>
    auditForMapping(request.ctx, { mappingId: request.params.mappingId, ...request.query }),
  );

  // --- synchronization -----------------------------------------------------

  route(fastify, 'get', '/sync/jobs', (request) => listSyncJobs(request.ctx, request.query));
  route(fastify, 'get', '/sync/jobs/:jobId', (request) =>
    getSyncJob(request.ctx, request.params.jobId),
  );
  route(fastify, 'post', '/sync/jobs/:jobId/cancel', (request) =>
    cancelSyncJob(request.ctx, request.params.jobId, request.body?.reason),
  );
  route(fastify, 'post', '/sync/member', (request) => resyncMember(request.ctx, request.body));
  route(fastify, 'post', '/sync/guild', (request) => resyncGuild(request.ctx, request.body));
  route(fastify, 'post', '/sync/all', (request) => resyncAll(request.ctx, request.body));

  route(fastify, 'get', '/sync/issues', (request) => listSyncIssues(request.ctx, request.query));
  route(fastify, 'post', '/sync/issues/:issueId/retry', (request) =>
    retrySyncIssue(request.ctx, { ...request.body, issueId: request.params.issueId }),
  );
  route(fastify, 'post', '/sync/issues/:issueId/resolve', (request) =>
    resolveSyncIssue(request.ctx, { ...request.body, issueId: request.params.issueId }),
  );

  // --- audit ---------------------------------------------------------------

  // --- rosters -------------------------------------------------------------
  // The public read model is served unauthenticated from `rosters.js`; these are the
  // endpoints a signed-in administrator uses from the dashboard.

  route(fastify, 'get', '/rosters/manage', (request) => listRosters(request.ctx, request.query));
  route(fastify, 'post', '/rosters/manage', (request) => createRoster(request.ctx, request.body));
  route(fastify, 'get', '/rosters/manage/:slug', (request) =>
    getRoster(request.ctx, request.params.slug),
  );
  route(fastify, 'patch', '/rosters/manage/:slug', (request) =>
    updateRoster(request.ctx, { ...request.body, slug: request.params.slug }),
  );
  route(fastify, 'delete', '/rosters/manage/:slug', (request) =>
    deleteRoster(request.ctx, { ...request.query, slug: request.params.slug }),
  );
  route(fastify, 'post', '/rosters/manage/:slug/ranks', (request) =>
    bindRosterRank(request.ctx, { ...request.body, slug: request.params.slug }),
  );
  route(fastify, 'delete', '/rosters/manage/:slug/ranks/:roleId', (request) =>
    unbindRosterRank(request.ctx, {
      ...request.query,
      slug: request.params.slug,
      discordRoleId: request.params.roleId,
    }),
  );
  route(fastify, 'patch', '/rosters/manage/:slug/members/:discordUserId', (request) =>
    setRosterMemberDetails(request.ctx, {
      ...request.body,
      slug: request.params.slug,
      discordUserId: request.params.discordUserId,
    }),
  );
  route(fastify, 'post', '/rosters/manage/:slug/sync', (request) =>
    syncRoster(request.ctx, { ...request.body, slug: request.params.slug }),
  );

  route(fastify, 'get', '/audit', (request) => queryAuditLogs(request.ctx, request.query));
  route(fastify, 'get', '/audit/export', (request) => exportAuditLogs(request.ctx, request.query));

  // --- permissions ---------------------------------------------------------

  route(fastify, 'get', '/permissions', (request) => listPermissions(request.ctx, request.query));
  route(fastify, 'get', '/permissions/capabilities', (request) => listCapabilities(request.ctx));
  route(fastify, 'post', '/permissions', (request) => grantPermission(request.ctx, request.body));
  route(fastify, 'delete', '/permissions/:assignmentId', (request) =>
    revokePermission(request.ctx, {
      ...request.body,
      assignmentId: request.params.assignmentId,
    }),
  );

  // --- system --------------------------------------------------------------

  route(fastify, 'get', '/system/health', (request) => getSystemHealth(request.ctx));
}

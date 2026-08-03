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
  cancelSyncJob,
  createMapping,
  deleteMapping,
  exportAuditLogs,
  getGuildStatus,
  getMapping,
  getSyncJob,
  getSystemHealth,
  grantPermission,
  issueGrant,
  listCapabilities,
  listGrants,
  listGuilds,
  listManagedRoles,
  listMappings,
  listMembers,
  listPermissions,
  listSyncIssues,
  listSyncJobs,
  lookupMember,
  queryAuditLogs,
  registerGuild,
  removeGuild,
  removeManagedRole,
  resolveSyncIssue,
  resyncAll,
  resyncGuild,
  resyncMember,
  retrySyncIssue,
  revokeGrant,
  revokePermission,
  setMappingEnabled,
  testMapping,
  updateGuildSettings,
  updateMapping,
  upsertManagedRole,
} from '@frm/core';

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
  // --- current user --------------------------------------------------------

  route(fastify, 'get', '/me', async (request) => {
    const profile = await lookupMember(request.ctx, { userId: request.actor.user.id });
    return {
      user: profile.user,
      grants: profile.grants,
      permissions: profile.permissions,
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
  route(fastify, 'post', '/mappings', (request) => createMapping(request.ctx, request.body));
  route(fastify, 'patch', '/mappings/:mappingId', (request) =>
    updateMapping(request.ctx, { ...request.body, mappingId: request.params.mappingId }),
  );
  route(fastify, 'post', '/mappings/:mappingId/enabled', (request) =>
    setMappingEnabled(request.ctx, { ...request.body, mappingId: request.params.mappingId }),
  );
  route(fastify, 'post', '/mappings/:mappingId/test', (request) =>
    testMapping(request.ctx, { mappingId: request.params.mappingId }),
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

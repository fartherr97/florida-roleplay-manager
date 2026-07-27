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
  addToSubdivision,
  assignCertification,
  auditForMapping,
  auditForMember,
  cancelSyncJob,
  changeCallsign,
  createMapping,
  deleteMapping,
  demoteMember,
  exportAuditLogs,
  getDepartment,
  getGuildStatus,
  getMapping,
  getMembershipHistory,
  getSyncJob,
  getSystemHealth,
  grantPermission,
  hireMember,
  listCapabilities,
  listCertifications,
  listDepartments,
  listGuilds,
  listMappings,
  listPermissions,
  listRanks,
  listRoster,
  listSyncIssues,
  listSyncJobs,
  lookupMember,
  placeOnLeave,
  promoteMember,
  queryAuditLogs,
  registerGuild,
  reinstateMember,
  removeCertification,
  removeFromSubdivision,
  removeGuild,
  removeMember,
  resolveSyncIssue,
  resyncAll,
  resyncDepartment,
  resyncGuild,
  resyncMember,
  retrySyncIssue,
  returnFromLeave,
  revokePermission,
  setMappingEnabled,
  suspendMember,
  testMapping,
  transferMember,
  updateGuildSettings,
  updateMapping,
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
      memberships: profile.memberships,
      certifications: profile.certifications,
      subdivisions: profile.subdivisions,
      permissions: profile.permissions,
      capabilities: request.actor.assignments.map((assignment) => ({
        capability: assignment.capabilityKey,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
        maxRankOrder: assignment.maxRankOrder,
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

  // --- departments and ranks -----------------------------------------------

  route(fastify, 'get', '/departments', (request) => listDepartments(request.ctx, request.query));
  route(fastify, 'get', '/departments/:departmentId', (request) =>
    getDepartment(request.ctx, request.params.departmentId),
  );
  route(fastify, 'get', '/departments/:departmentId/ranks', (request) =>
    listRanks(request.ctx, request.params.departmentId),
  );
  route(fastify, 'get', '/departments/:departmentId/roster', (request) =>
    listRoster(request.ctx, { ...request.query, departmentId: request.params.departmentId }),
  );

  // --- members -------------------------------------------------------------

  route(fastify, 'get', '/members/lookup', (request) => lookupMember(request.ctx, request.query));
  route(fastify, 'get', '/members/:userId', (request) =>
    lookupMember(request.ctx, { userId: request.params.userId }),
  );
  route(fastify, 'get', '/members/:userId/history', (request) =>
    getMembershipHistory(request.ctx, { userId: request.params.userId, ...request.query }),
  );
  route(fastify, 'get', '/members/:userId/audit', (request) =>
    auditForMember(request.ctx, { userId: request.params.userId, ...request.query }),
  );

  // --- roster actions ------------------------------------------------------
  //
  // One endpoint per action rather than a generic "update membership": each has its own
  // capability, its own preconditions and its own audit action, and collapsing them
  // would mean re-deriving which of those applies from the shape of a patch body.

  route(fastify, 'post', '/roster/hire', (request) => hireMember(request.ctx, request.body));
  route(fastify, 'post', '/roster/promote', (request) => promoteMember(request.ctx, request.body));
  route(fastify, 'post', '/roster/demote', (request) => demoteMember(request.ctx, request.body));
  route(fastify, 'post', '/roster/transfer', (request) =>
    transferMember(request.ctx, request.body),
  );
  route(fastify, 'post', '/roster/loa', (request) => placeOnLeave(request.ctx, request.body));
  route(fastify, 'post', '/roster/return', (request) => returnFromLeave(request.ctx, request.body));
  route(fastify, 'post', '/roster/suspend', (request) => suspendMember(request.ctx, request.body));
  route(fastify, 'post', '/roster/reinstate', (request) =>
    reinstateMember(request.ctx, request.body),
  );
  route(fastify, 'post', '/roster/remove', (request) => removeMember(request.ctx, request.body));
  route(fastify, 'post', '/roster/callsign', (request) =>
    changeCallsign(request.ctx, request.body),
  );

  // --- certifications and subdivisions -------------------------------------

  route(fastify, 'get', '/certifications', (request) =>
    listCertifications(request.ctx, request.query),
  );
  route(fastify, 'post', '/certifications/assign', (request) =>
    assignCertification(request.ctx, request.body),
  );
  route(fastify, 'post', '/certifications/remove', (request) =>
    removeCertification(request.ctx, request.body),
  );
  route(fastify, 'post', '/subdivisions/add', (request) =>
    addToSubdivision(request.ctx, request.body),
  );
  route(fastify, 'post', '/subdivisions/remove', (request) =>
    removeFromSubdivision(request.ctx, request.body),
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
  route(fastify, 'post', '/sync/department', (request) =>
    resyncDepartment(request.ctx, request.body),
  );
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

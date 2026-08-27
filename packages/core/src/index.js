/**
 * `@frm/core` is the single home of the platform's business logic.
 *
 * The Discord bot and the REST API are both thin adapters over this package: they
 * translate their own input format into a service call and translate the result back.
 * Neither of them contains an authorization decision, a database write or a role
 * calculation of its own, which is what keeps the two boundaries from ever disagreeing
 * about what a member is allowed to do.
 */
export * from './context.js';
export * from './resolve.js';
export * from './audit-service.js';
export * from './notify.js';
export * from './guild-service.js';
export * from './cycle-detection.js';
export * from './mapping-service.js';
export * from './member-service.js';
export * from './permission-service.js';
export * from './managed-role-service.js';
export * from './grant-service.js';
export * from './role-grant-service.js';
export * from './access-service.js';
export * from './transfer-service.js';
export * from './whitelist-service.js';
export * from './discord-role-service.js';
export * from './roster-nickname.js';
export * from './nickname-service.js';
export * from './moderation-service.js';
export * from './temp-role-service.js';
export * from './log-webhook-service.js';
export * from './roster-resolve.js';
export * from './roster-service.js';
export * from './roster-runner.js';
export * from './sync-service.js';
export * from './sync-runner.js';
export * from './event-service.js';
export * from './system-service.js';
export * from './maintenance-service.js';
export * from './approval-service.js';
export * from './setup-service.js';
export * from './bootstrap-service.js';

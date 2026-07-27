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
export * from './roster-service.js';
export * from './member-service.js';
export * from './certification-service.js';
export * from './permission-service.js';
export * from './department-service.js';
export * from './sync-service.js';
export * from './sync-runner.js';
export * from './event-service.js';
export * from './system-service.js';
export * from './maintenance-service.js';
export * from './approval-service.js';

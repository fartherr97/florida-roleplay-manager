/**
 * Capability catalogue.
 *
 * This is pure data so that every layer (bot, API, validation, seed) can reference the
 * same list without depending on the authorization engine.
 *
 * `allowedScopes` documents which scope types are meaningful for a capability. The
 * authorization engine rejects an assignment whose scope type is not listed, which stops
 * an operator from accidentally creating, for example, a guild-scoped `guild.register`
 * grant that would read as "may register guilds" at evaluation time.
 */
import { PermissionScopeType } from './enums.js';

const { GLOBAL, GUILD } = PermissionScopeType;

/** Numeric authority tiers. A user may never act on someone at or above their own tier. */
export const PermissionLevel = Object.freeze({
  MEMBER: 0,
  SUPERVISOR: 20,
  COMMAND: 40,
  MANAGER: 60,
  STAFF: 80,
  GLOBAL_ADMIN: 100,
});

/**
 * @typedef {object} CapabilityDefinition
 * @property {string} key
 * @property {string} category
 * @property {string} description
 * @property {string[]} allowedScopes scope types this capability may be granted at
 * @property {boolean} dangerous requires an explicit confirmation step in the UI/bot
 * @property {number} minLevel minimum permission level required to *hold* the capability
 */

/** @type {CapabilityDefinition[]} */
const DEFINITIONS = [
  // --- Guilds ---------------------------------------------------------------
  {
    key: 'guild.view',
    category: 'guild',
    description: 'View approved guilds and their settings.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.SUPERVISOR,
  },
  {
    key: 'guild.register',
    category: 'guild',
    description: 'Add a Discord guild to the approved allowlist.',
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.GLOBAL_ADMIN,
  },
  {
    key: 'guild.remove',
    category: 'guild',
    description: 'Remove a Discord guild from the approved allowlist.',
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.GLOBAL_ADMIN,
  },
  {
    key: 'guild.settings',
    category: 'guild',
    description: 'Change per-guild feature flags and synchronization settings.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.STAFF,
  },

  // --- Mappings -------------------------------------------------------------
  {
    key: 'mapping.view',
    category: 'mapping',
    description: 'View cross-guild role mappings.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.SUPERVISOR,
  },
  {
    key: 'mapping.create',
    category: 'mapping',
    description: 'Create a cross-guild role mapping.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: true,
    minLevel: PermissionLevel.STAFF,
  },
  {
    key: 'mapping.update',
    category: 'mapping',
    description: 'Edit, enable or disable a role mapping.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: true,
    minLevel: PermissionLevel.STAFF,
  },
  {
    key: 'mapping.delete',
    category: 'mapping',
    description: 'Delete a role mapping.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: true,
    minLevel: PermissionLevel.STAFF,
  },
  {
    key: 'mapping.test',
    category: 'mapping',
    description: 'Run mapping validation without applying changes.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.SUPERVISOR,
  },
  {
    key: 'mapping.approve',
    category: 'mapping',
    description: 'Act as the second approver for a protected mapping.',
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.GLOBAL_ADMIN,
  },

  // --- Managed roles and grants ---------------------------------------------
  {
    key: 'role.manage',
    category: 'role',
    description: 'Declare which Discord roles the platform is allowed to control.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: true,
    minLevel: PermissionLevel.STAFF,
  },
  {
    key: 'grant.issue',
    category: 'grant',
    description: 'Issue a time-bounded manual role grant to a member.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: true,
    minLevel: PermissionLevel.COMMAND,
  },
  {
    key: 'grant.revoke',
    category: 'grant',
    description: 'Revoke a manual role grant.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.COMMAND,
  },

  // --- Synchronization ------------------------------------------------------
  {
    key: 'sync.member',
    category: 'sync',
    description: 'Resynchronize a single member.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.SUPERVISOR,
  },
  {
    key: 'sync.guild',
    category: 'sync',
    description: 'Resynchronize every managed member of a guild.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: true,
    minLevel: PermissionLevel.STAFF,
  },
  {
    key: 'sync.global',
    category: 'sync',
    description: 'Resynchronize the entire platform.',
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.GLOBAL_ADMIN,
  },
  {
    key: 'sync.issue.retry',
    category: 'sync',
    description: 'Retry an individual failed synchronization action.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.SUPERVISOR,
  },

  // --- Members --------------------------------------------------------------
  {
    key: 'member.view',
    category: 'member',
    description: 'Look up a community member profile.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.MEMBER,
  },
  {
    key: 'member.link',
    category: 'member',
    description: 'Link or unlink a Discord account to a platform user.',
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.STAFF,
  },

  // --- Audit ----------------------------------------------------------------
  {
    key: 'audit.view',
    category: 'audit',
    description: 'View audit records.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.COMMAND,
  },
  {
    key: 'audit.export',
    category: 'audit',
    description: 'Export audit records in bulk.',
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.STAFF,
  },

  // --- Permissions and system -----------------------------------------------
  {
    key: 'permission.view',
    category: 'permission',
    description: 'View permission assignments.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.COMMAND,
  },
  {
    key: 'permission.grant',
    category: 'permission',
    description: 'Grant a capability to a user, never above the granter own authority.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: true,
    minLevel: PermissionLevel.MANAGER,
  },
  {
    key: 'permission.revoke',
    category: 'permission',
    description: 'Revoke a capability from a user.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: true,
    minLevel: PermissionLevel.MANAGER,
  },
  {
    key: 'system.manage',
    category: 'system',
    description: 'Full platform administration, including system settings and health.',
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.GLOBAL_ADMIN,
  },
];

/** @type {ReadonlyMap<string, CapabilityDefinition>} */
export const CAPABILITY_MAP = new Map(DEFINITIONS.map((def) => [def.key, Object.freeze(def)]));

/** All capability definitions. */
export const CAPABILITIES = Object.freeze(DEFINITIONS);

/** All capability keys. */
export const CAPABILITY_KEYS = Object.freeze(DEFINITIONS.map((def) => def.key));

/**
 * Convenience object so code can write `Capability.MAPPING_CREATE` instead of a
 * stringly-typed key that a typo would silently break.
 */
export const Capability = Object.freeze(
  Object.fromEntries(
    DEFINITIONS.map((def) => [def.key.replace(/[.]/g, '_').toUpperCase(), def.key]),
  ),
);

/** @param {string} key */
export function getCapability(key) {
  return CAPABILITY_MAP.get(key) ?? null;
}

/** @param {string} key */
export function isKnownCapability(key) {
  return CAPABILITY_MAP.has(key);
}

/** Capabilities that require a confirmation step before execution. */
export const DANGEROUS_CAPABILITIES = Object.freeze(
  DEFINITIONS.filter((def) => def.dangerous).map((def) => def.key),
);

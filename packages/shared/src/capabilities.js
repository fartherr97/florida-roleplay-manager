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
  {
    key: 'guild.provision',
    category: 'guild',
    description:
      'Provision a department server: create its roles, channels and permissions, and wire it into the platform.',
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.GLOBAL_ADMIN,
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
  {
    key: 'rolegrant.manage',
    category: 'role',
    description:
      'Edit the self-service role delegation rules: which roles may hand out which other roles.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: true,
    minLevel: PermissionLevel.STAFF,
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
  // --- Rosters --------------------------------------------------------------
  {
    key: 'roster.view',
    category: 'roster',
    description: 'View rosters, their ranks and their members.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.SUPERVISOR,
  },
  {
    key: 'roster.manage',
    category: 'roster',
    description: 'Create and edit rosters, and bind Discord roles to ranks.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.MANAGER,
  },
  {
    key: 'roster.member',
    category: 'roster',
    description: "Edit a roster member's callsign and displayed name.",
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.COMMAND,
  },
  {
    key: 'roster.sync',
    category: 'roster',
    description: 'Reconcile a roster against Discord, rewriting nicknames and memberships.',
    allowedScopes: [GLOBAL, GUILD],
    dangerous: false,
    minLevel: PermissionLevel.COMMAND,
  },
  {
    key: 'access.manage',
    category: 'system',
    description:
      'Map main-guild Discord roles to authority tiers, granting bot access by role. Deliberately never granted by a tier itself.',
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.GLOBAL_ADMIN,
  },

  // --- Transfers ------------------------------------------------------------
  {
    key: 'transfer.manage',
    category: 'transfer',
    description:
      "Configure each department's transfer role set: the Discord roles stripped and granted when a member moves between departments.",
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.STAFF,
  },
  {
    key: 'transfer.execute',
    category: 'transfer',
    description:
      'Transfer a member between departments, stripping the outgoing department roles and granting the incoming ones.',
    allowedScopes: [GLOBAL],
    dangerous: true,
    minLevel: PermissionLevel.COMMAND,
  },
];

/**
 * The slash commands each capability unlocks, in plain language.
 *
 * Access is enforced by capability, but "guild.settings" means little to somebody deciding
 * what a tier should be able to do — "/guild settings" and a one-liner does. This is the
 * human face of the catalogue, shown on the website's access-tier editor. Keyed by
 * capability; a capability with no slash command (the website-only transfer portal) lists
 * where it applies instead.
 */
const COMMANDS_BY_CAPABILITY = {
  'guild.view': [
    { name: '/guild list', description: 'List the registered servers.' },
    { name: '/guild status', description: "Show a server's registration and sync status." },
  ],
  'guild.register': [{ name: '/guild register', description: 'Add a server to the allowlist.' }],
  'guild.remove': [{ name: '/guild remove', description: 'Remove a server from the allowlist.' }],
  'guild.settings': [{ name: '/guild settings', description: "Change a server's sync and auto-leave settings." }],
  'guild.provision': [
    { name: '/setup department', description: "Provision a department server's channels and roles." },
    { name: '/setup community', description: 'Provision the community server.' },
    { name: '/setup permissions', description: "Repair the bot's own channel permissions." },
  ],
  'mapping.view': [
    { name: '/mapping list', description: 'List role mappings.' },
    { name: '/mapping view', description: 'Show one mapping in detail.' },
  ],
  'mapping.create': [{ name: '/mapping create', description: 'Create a role mapping between two servers.' }],
  'mapping.update': [
    { name: '/mapping edit', description: 'Edit a mapping.' },
    { name: '/mapping enable', description: 'Enable a mapping.' },
    { name: '/mapping disable', description: 'Disable a mapping.' },
  ],
  'mapping.delete': [{ name: '/mapping remove', description: 'Delete a mapping.' }],
  'mapping.test': [{ name: '/mapping test', description: 'Preview what a mapping would do.' }],
  'mapping.approve': [
    { name: '/mapping approvals', description: 'List mappings awaiting a second approver.' },
    { name: '/mapping approve', description: 'Approve a mapping change.' },
    { name: '/mapping reject', description: 'Reject a mapping change.' },
  ],
  'role.manage': [
    { name: '/role manage', description: 'Declare a Discord role as managed by the platform.' },
    { name: '/role unmanage', description: 'Stop managing a role.' },
    { name: '/role list', description: 'List managed roles.' },
  ],
  'grant.issue': [
    { name: '/role grant', description: 'Give a member a time-bounded manual role grant.' },
    { name: '/role grants', description: 'List active manual grants.' },
  ],
  'grant.revoke': [{ name: '/role revoke', description: 'Revoke a manual role grant.' }],
  'rolegrant.manage': [
    { name: '/rolemanager config', description: 'Set which roles may hand out which other roles.' },
    { name: '/rolemanager view', description: 'See the self-service role rules.' },
  ],
  'member.view': [{ name: '/member lookup', description: "Look up a member's profile and access." }],
  'member.link': [
    { name: '/member link', description: 'Link a Discord account to a platform member.' },
    { name: '/member unlink', description: 'Unlink a Discord account.' },
  ],
  'sync.member': [
    { name: '/resync member', description: "Resynchronise one member's roles." },
    { name: '/resync preview', description: 'Preview what a resync would change.' },
    { name: '/resync status', description: "Check a sync job's status." },
  ],
  'sync.guild': [{ name: '/resync guild', description: 'Resynchronise every managed member of a server.' }],
  'sync.global': [{ name: '/resync all', description: 'Resynchronise the entire platform.' }],
  'sync.issue.retry': [{ name: '/audit retry', description: 'Retry a failed sync action.' }],
  'audit.view': [
    { name: '/audit recent', description: 'Show recent actions.' },
    { name: '/audit failures', description: 'Show failed actions.' },
    { name: '/audit member', description: "Show a member's audit history." },
    { name: '/audit mapping', description: "Show a mapping's audit history." },
  ],
  'audit.export': [{ name: 'Audit log (website)', description: 'Export the audit log.' }],
  'roster.view': [
    { name: '/roster view', description: 'Show a roster.' },
    { name: '/roster list', description: 'List every roster.' },
  ],
  'roster.manage': [
    { name: '/roster create', description: 'Create a roster.' },
    { name: '/roster rank', description: 'Bind a Discord role to a rank.' },
    { name: '/roster unrank', description: 'Unbind a rank.' },
    { name: '/roster publish', description: 'Publish or unpublish a roster to the website.' },
  ],
  'roster.member': [
    { name: '/roster member', description: "Set a member's callsign or displayed name." },
    { name: '/globalsetnickname', description: "Set a member's display name in every server." },
  ],
  'roster.sync': [{ name: '/roster sync', description: 'Reconcile a roster against Discord.' }],
  'system.manage': [
    { name: '/globalban', description: 'Ban a user from every registered server.' },
    { name: '/globalunban', description: "Lift a user's ban in every server." },
    { name: '/system health', description: 'Show platform health.' },
  ],
  'permission.view': [{ name: '/permissions view', description: 'See who holds which capabilities.' }],
  'permission.grant': [{ name: '/permissions grant', description: 'Grant a capability to a member.' }],
  'permission.revoke': [{ name: '/permissions revoke', description: 'Revoke a capability from a member.' }],
  'transfer.manage': [
    { name: 'Transfer portal (website)', description: "Configure each department's transfer role set." },
  ],
  'transfer.execute': [
    { name: 'Transfer portal (website)', description: 'Move a member between departments.' },
  ],
};

// Attach the command list to each definition, so every export below carries it.
for (const def of DEFINITIONS) {
  def.commands = COMMANDS_BY_CAPABILITY[def.key] ?? [];
}

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

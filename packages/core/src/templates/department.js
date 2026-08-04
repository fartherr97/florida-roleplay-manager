/**
 * Department server template.
 *
 * This is the one file to edit when you want to change what `/setup department` builds:
 * the roles, the categories, the channels inside them, and who can see what. Everything
 * downstream - the planner, the provisioning engine, the preview - is generic and reads
 * from the structure this returns, so a change here needs no code changes anywhere else.
 *
 * ## How permissions work
 *
 * Overwrites are declared on the *category*. A channel created inside a category inherits
 * its category's overwrites automatically, so a locked category makes every channel in it
 * private without repeating the rule. `role` names a template role key (or the literal
 * `everyone`); the provisioning engine resolves it to a real role id at creation time.
 *
 * Permission flag names are Discord's own (`ViewChannel`, `SendMessages`, `Connect`, ...).
 */

/** The blurple Discord uses by default, for a department that does not pick a colour. */
const DEFAULT_COLOR = 0x5865f2;

/**
 * @param {object} params
 * @param {string} params.name  the department's full name, e.g. "Hillsborough County Sheriff's Office"
 * @param {string} params.tag   a short prefix for role names, e.g. "HCSO"
 * @param {number|string} [params.color]  role colour (hex string or int)
 * @returns {DepartmentTemplate}
 */
export function buildDepartmentTemplate({ name, tag, color = DEFAULT_COLOR }) {
  const prefix = tag?.trim() ? `${tag.trim()} ` : '';

  return {
    name,
    roles: [
      { key: 'command', name: `${prefix}Command`, color, hoist: true },
      { key: 'supervisor', name: `${prefix}Supervisor`, color, hoist: true },
      { key: 'member', name: `${prefix}Member`, color, hoist: true },
    ],

    categories: [
      {
        key: 'information',
        name: '📋 Information',
        // Visible to everyone, but read-only: announcements, not a chat.
        overwrites: [{ role: 'everyone', deny: ['SendMessages', 'CreatePublicThreads'] }],
        channels: [
          { key: 'welcome', name: 'welcome', type: 'text' },
          { key: 'announcements', name: 'announcements', type: 'text' },
          { key: 'rules', name: 'rules', type: 'text' },
          { key: 'roster', name: 'roster', type: 'text' },
        ],
      },
      {
        key: 'general',
        name: '💬 General',
        overwrites: [
          { role: 'everyone', deny: ['ViewChannel'] },
          { role: 'member', allow: ['ViewChannel'] },
        ],
        channels: [
          { key: 'general-chat', name: 'general-chat', type: 'text' },
          { key: 'off-topic', name: 'off-topic', type: 'text' },
          { key: 'general-vc', name: 'General', type: 'voice' },
        ],
      },
      {
        key: 'operations',
        name: '🚔 Operations',
        overwrites: [
          { role: 'everyone', deny: ['ViewChannel'] },
          { role: 'member', allow: ['ViewChannel'] },
        ],
        channels: [
          { key: 'patrol-logs', name: 'patrol-logs', type: 'text' },
          { key: 'reports', name: 'reports', type: 'text' },
          { key: 'bolos', name: 'bolos', type: 'text' },
          { key: 'on-duty', name: 'On Duty', type: 'voice' },
          { key: 'dispatch', name: 'Dispatch', type: 'voice' },
        ],
      },
      {
        key: 'training',
        name: '🎓 Training',
        overwrites: [
          { role: 'everyone', deny: ['ViewChannel'] },
          { role: 'member', allow: ['ViewChannel'] },
        ],
        channels: [
          { key: 'training-info', name: 'training-info', type: 'text' },
          { key: 'signups', name: 'signups', type: 'text' },
        ],
      },
      {
        key: 'command',
        name: '🔒 Command',
        // Command and supervisors only; everyone else cannot even see it.
        overwrites: [
          { role: 'everyone', deny: ['ViewChannel'] },
          { role: 'supervisor', allow: ['ViewChannel'] },
          { role: 'command', allow: ['ViewChannel'] },
        ],
        channels: [
          { key: 'command-chat', name: 'command-chat', type: 'text' },
          { key: 'staff-actions', name: 'staff-actions', type: 'text' },
          { key: 'command-vc', name: 'Command', type: 'voice' },
        ],
      },
    ],

    /**
     * The role the platform manages and syncs. When wire-in is on, this role is declared
     * as a managed role and becomes the target of the mapping from the main community.
     */
    managedRoleKey: 'member',
  };
}

/**
 * @typedef {object} DepartmentTemplate
 * @property {string} name
 * @property {Array<{key: string, name: string, color?: number|string, hoist?: boolean}>} roles
 * @property {Array<TemplateCategory>} categories
 * @property {string} managedRoleKey
 *
 * @typedef {object} TemplateCategory
 * @property {string} key
 * @property {string} name
 * @property {Array<{role: string, allow?: string[], deny?: string[]}>} [overwrites]
 * @property {Array<{key: string, name: string, type: 'text'|'voice'}>} channels
 */

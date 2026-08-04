/**
 * Main community server template.
 *
 * The hub server: one per community, the source that department servers sync *from*. Like
 * the department template, this is the one file to edit to change what `/setup community`
 * builds. The permission model is the same - overwrites are declared on the category and
 * inherited by its channels; `role` names a template role key or the literal `everyone`.
 *
 * Unlike a department, the community server has no managed member role of its own: its
 * roles are the *sources* of mappings, created per department by `/setup department`, so
 * this template only stands up the structure and the community-wide roles.
 */

const DEFAULT_COLOR = 0x5865f2;

/**
 * @param {object} params
 * @param {string} params.name  the community's name
 * @param {number|string} [params.color]  role colour (hex string or int)
 * @returns {import('./department.js').DepartmentTemplate}
 */
export function buildCommunityTemplate({ name, color = DEFAULT_COLOR }) {
  return {
    name,
    roles: [
      { key: 'staff', name: 'Staff', color, hoist: true },
      { key: 'member', name: 'Community Member', color, hoist: false },
    ],

    categories: [
      {
        key: 'community',
        name: '📢 Community',
        // Announcements, not a chat: everyone can read, nobody but staff can post.
        overwrites: [{ role: 'everyone', deny: ['SendMessages', 'CreatePublicThreads'] }],
        channels: [
          { key: 'welcome', name: 'welcome', type: 'text' },
          { key: 'announcements', name: 'announcements', type: 'text' },
          { key: 'rules', name: 'rules', type: 'text' },
          { key: 'departments', name: 'departments', type: 'text' },
        ],
      },
      {
        key: 'general',
        name: '💬 General',
        channels: [
          { key: 'general-chat', name: 'general-chat', type: 'text' },
          { key: 'off-topic', name: 'off-topic', type: 'text' },
          { key: 'clips-and-media', name: 'clips-and-media', type: 'text' },
          { key: 'general-vc', name: 'General', type: 'voice' },
          { key: 'afk', name: 'AFK', type: 'voice' },
        ],
      },
      {
        key: 'in-game',
        name: '🎮 In-Game',
        channels: [
          { key: 'server-info', name: 'server-info', type: 'text' },
          { key: 'suggestions', name: 'suggestions', type: 'text' },
          { key: 'bug-reports', name: 'bug-reports', type: 'text' },
        ],
      },
      {
        key: 'support',
        name: '🎫 Support',
        channels: [{ key: 'support-info', name: 'support-info', type: 'text' }],
      },
      {
        key: 'staff',
        name: '🔒 Staff',
        overwrites: [
          { role: 'everyone', deny: ['ViewChannel'] },
          { role: 'staff', allow: ['ViewChannel'] },
        ],
        channels: [
          { key: 'staff-chat', name: 'staff-chat', type: 'text' },
          { key: 'staff-actions', name: 'staff-actions', type: 'text' },
          { key: 'staff-vc', name: 'Staff', type: 'voice' },
        ],
      },
    ],

    // The community server has no platform-managed role of its own.
    managedRoleKey: null,
  };
}

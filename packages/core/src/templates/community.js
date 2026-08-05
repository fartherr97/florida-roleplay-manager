/**
 * Florida Roleplay main community server template.
 *
 * Used by `/setup community` to create the main FLRP Discord structure.
 * Department servers sync their managed roles from roles created in this hub.
 */

const DEFAULT_COLOR = 0x5865f2;

const PRIVATE_CATEGORY = [
  {
    role: 'everyone',
    deny: ['ViewChannel'],
  },
];

const STAFF_ACCESS = [
  ...PRIVATE_CATEGORY,
  {
    role: 'ownership',
    allow: ['ViewChannel'],
  },
  {
    role: 'community-director',
    allow: ['ViewChannel'],
  },
  {
    role: 'server-staff',
    allow: ['ViewChannel'],
  },
];

const DIRECTOR_ACCESS = [
  ...PRIVATE_CATEGORY,
  {
    role: 'ownership',
    allow: ['ViewChannel'],
  },
  {
    role: 'community-director',
    allow: ['ViewChannel'],
  },
];

const OWNERSHIP_ACCESS = [
  ...PRIVATE_CATEGORY,
  {
    role: 'ownership',
    allow: ['ViewChannel'],
  },
];

const DEPARTMENT_HEAD_ACCESS = [
  ...PRIVATE_CATEGORY,
  {
    role: 'ownership',
    allow: ['ViewChannel'],
  },
  {
    role: 'community-director',
    allow: ['ViewChannel'],
  },
  {
    role: 'department-head',
    allow: ['ViewChannel'],
  },
];

const EMERGENCY_SERVICES_ACCESS = [
  ...PRIVATE_CATEGORY,
  {
    role: 'ownership',
    allow: ['ViewChannel'],
  },
  {
    role: 'community-director',
    allow: ['ViewChannel'],
  },
  {
    role: 'law-enforcement',
    allow: ['ViewChannel'],
  },
];

/**
 * @param {object} params
 * @param {string} params.name Community name
 * @param {number|string} [params.color] Default role color
 * @returns {import('./department.js').DepartmentTemplate}
 */
export function buildCommunityTemplate({ name = 'Florida Roleplay', color = DEFAULT_COLOR }) {
  return {
    name,

    roles: [
      // Community leadership
      {
        key: 'ownership',
        name: 'FLRP | Ownership',
        color,
        hoist: true,
      },
      {
        key: 'community-director',
        name: 'FLRP | Community Director',
        color,
        hoist: true,
      },

      // Server staff
      {
        key: 'server-staff',
        name: 'FLRP | Server Staff Team',
        color,
        hoist: true,
      },

      // Department leadership
      {
        key: 'department-head',
        name: 'FLRP | Department Head',
        color,
        hoist: true,
      },

      // Emergency services
      {
        key: 'es-subdivision-head',
        name: 'FLRP | ES Subdivision Head',
        color,
        hoist: true,
      },
      {
        key: 'law-enforcement',
        name: 'FLRP | Law Enforcement',
        color,
        hoist: true,
      },
      {
        key: 'officer-of-the-month',
        name: 'FLRP | Officer of the Month',
        color,
        hoist: true,
      },

      // Civilian department
      {
        key: 'civilian-director',
        name: 'FLRP | Civilian Director',
        color,
        hoist: true,
      },
      {
        key: 'civilian-supervisor',
        name: 'FLRP | Civilian Supervisor',
        color,
        hoist: true,
      },
      {
        key: 'certified-civilian-plus',
        name: 'FLRP | Certified Civilian+',
        color,
        hoist: true,
      },
      {
        key: 'certified-civilian',
        name: 'FLRP | Certified Civilian',
        color,
        hoist: false,
      },

      // Gangs administration
      {
        key: 'gangs-administration',
        name: 'FLRP | Gangs Administration',
        color,
        hoist: true,
      },
      {
        key: 'assistant-gangs-administration',
        name: 'FLRP | Asst. Gangs Administration',
        color,
        hoist: true,
      },

      // Supporter roles
      {
        key: 'diamond-le-supporter',
        name: 'FLRP | Diamond Tier (LE) Supporter',
        color,
        hoist: true,
      },
      {
        key: 'diamond-civ-supporter',
        name: 'FLRP | Diamond Tier (CIV) Supporter',
        color,
        hoist: true,
      },
      {
        key: 'diamond-supporter',
        name: 'FLRP | Diamond Tier Supporter',
        color,
        hoist: true,
      },
      {
        key: 'platinum-supporter',
        name: 'FLRP | Platinum Tier Supporter',
        color,
        hoist: true,
      },
      {
        key: 'gold-le-supporter',
        name: 'FLRP | Gold Tier (LE) Supporter',
        color,
        hoist: true,
      },
      {
        key: 'gold-civ-supporter',
        name: 'FLRP | Gold Tier (CIV) Supporter',
        color,
        hoist: true,
      },
      {
        key: 'donator',
        name: 'FLRP | Donator',
        color,
        hoist: true,
      },

      // Retired roles
      {
        key: 'retired-director',
        name: 'FLRP | Retired Director',
        color,
        hoist: false,
      },
      {
        key: 'retired-server-staff',
        name: 'FLRP | Retired Server Staff',
        color,
        hoist: false,
      },
      {
        key: 'retired-department-head',
        name: 'FLRP | Retired Department Head',
        color,
        hoist: false,
      },

      // General membership
      {
        key: 'whitelisted-member',
        name: 'FLRP | Whitelisted Member',
        color,
        hoist: true,
      },
      {
        key: 'member',
        name: 'FLRP | Community Member',
        color,
        hoist: false,
      },
    ],

    categories: [
      {
        key: 'server-information-counter',
        name: 'Server Information',
        overwrites: [
          {
            role: 'everyone',
            deny: ['SendMessages', 'CreatePublicThreads'],
          },
        ],
        channels: [
          {
            key: 'member-count',
            name: 'Members: Loading...',
            type: 'voice',
          },
        ],
      },

      // Ownership replaces the former Director Team section.
      {
        key: 'ownership-team',
        name: 'FLRP | Ownership Team',
        overwrites: OWNERSHIP_ACCESS,
        channels: [
          {
            key: 'senior-ownership-chat',
            name: 'senior-ownership-chat',
            type: 'text',
          },
          {
            key: 'ownership-chat',
            name: 'ownership-chat',
            type: 'text',
          },
          {
            key: 'ownership-to-do',
            name: 'ownership-to-do',
            type: 'text',
          },
          {
            key: 'bot-testing',
            name: 'bot-testing',
            type: 'text',
          },
          {
            key: 'all-duty-logs',
            name: 'all-duty-logs',
            type: 'text',
          },
          {
            key: 'bot-error-logs',
            name: 'bot-error-logs',
            type: 'text',
          },
          {
            key: 'irl-verification-logs',
            name: 'irl-verification-logs',
            type: 'text',
          },
          {
            key: 'all-logs',
            name: 'all-logs',
            type: 'text',
          },
          {
            key: 'security-logs',
            name: 'security-logs',
            type: 'text',
          },
          {
            key: 'owners-office',
            name: "Owner's Office",
            type: 'voice',
          },
          {
            key: 'deputy-owners-office',
            name: "Deputy Owner's Office",
            type: 'voice',
          },
          {
            key: 'assistant-owners-office',
            name: "Assistant Owner's Office",
            type: 'voice',
          },
          {
            key: 'ownership-lounge',
            name: 'Ownership | Lounge',
            type: 'voice',
          },
          {
            key: 'ownership-waiting-room',
            name: 'Ownership | Waiting Room',
            type: 'voice',
          },
        ],
      },

      // Directors replace the former Management Team section.
      {
        key: 'director-team',
        name: 'FLRP | Director Team',
        overwrites: DIRECTOR_ACCESS,
        channels: [
          {
            key: 'director-announcements',
            name: 'director-announcements',
            type: 'text',
          },
          {
            key: 'director-information',
            name: 'director-information',
            type: 'text',
          },
          {
            key: 'ownership-transcripts',
            name: 'ownership-transcripts',
            type: 'text',
          },
          {
            key: 'director-vehicles',
            name: 'director-vehicles',
            type: 'text',
          },
          {
            key: 'director-voting',
            name: 'director-voting',
            type: 'text',
          },
          {
            key: 'senior-director-chat',
            name: 'senior-director-chat',
            type: 'text',
          },
          {
            key: 'director-chat',
            name: 'director-chat',
            type: 'text',
          },
          {
            key: 'director-logs',
            name: 'director-logs',
            type: 'text',
          },
          {
            key: 'clout-level-logs',
            name: 'clout-level-logs',
            type: 'text',
          },
          {
            key: 'staff-directors-office',
            name: "Staff Director's Office",
            type: 'voice',
          },
          {
            key: 'development-directors-office',
            name: "Development Director's Office",
            type: 'voice',
          },
          {
            key: 'es-directors-office',
            name: "ES Director's Office",
            type: 'voice',
          },
          {
            key: 'civilian-directors-office',
            name: "Civilian Director's Office",
            type: 'voice',
          },
          {
            key: 'assistant-staff-directors-office',
            name: "Asst. Staff Director's Office",
            type: 'voice',
          },
          {
            key: 'assistant-development-directors-office',
            name: "Asst. Development Director's Office",
            type: 'voice',
          },
          {
            key: 'assistant-es-directors-office',
            name: "Asst. ES Director's Office",
            type: 'voice',
          },
          {
            key: 'assistant-civilian-directors-office',
            name: "Asst. Civilian Director's Office",
            type: 'voice',
          },
          {
            key: 'director-lounge',
            name: 'Director | Lounge',
            type: 'voice',
          },
          {
            key: 'director-waiting-room',
            name: 'Director | Waiting Room',
            type: 'voice',
          },
        ],
      },

      {
        key: 'server-staff-team',
        name: 'FLRP | Server Staff Team',
        overwrites: STAFF_ACCESS,
        channels: [
          {
            key: 'staff-announcements',
            name: 'staff-announcements',
            type: 'text',
          },
          {
            key: 'staff-information',
            name: 'staff-information',
            type: 'text',
          },
          {
            key: 'staff-activity',
            name: 'staff-activity',
            type: 'text',
          },
          {
            key: 'head-admin-chat',
            name: 'head-admin-chat',
            type: 'text',
          },
          {
            key: 'senior-admin-chat',
            name: 'senior-admin-chat',
            type: 'text',
          },
          {
            key: 'admin-chat',
            name: 'admin-chat',
            type: 'text',
          },
          {
            key: 'staff-main-chat',
            name: 'staff-main-chat',
            type: 'text',
          },
          {
            key: 'ingame-staff-chat',
            name: 'ingame-staff-chat',
            type: 'text',
          },
          {
            key: 'staff-bot-commands',
            name: 'staff-bot-cmds',
            type: 'text',
          },
          {
            key: 'administrative-logs',
            name: 'administrative-logs',
            type: 'text',
          },
          {
            key: 'request-interview',
            name: 'request-interview',
            type: 'text',
          },
          {
            key: 'exam-notifications',
            name: 'exam-notifications',
            type: 'text',
          },
          {
            key: 'ban-requests',
            name: 'ban-requests',
            type: 'text',
          },
          {
            key: 'whitelisted-da-requests',
            name: 'whitelisted-da-requests',
            type: 'text',
          },
          {
            key: 'whitelisted-applications',
            name: 'whitelisted-apps',
            type: 'text',
          },
          {
            key: 'head-admin-office',
            name: 'Staff | Head Admin Office',
            type: 'voice',
          },
          {
            key: 'senior-admin-office',
            name: 'Staff | Sr. Admin Office',
            type: 'voice',
          },
          {
            key: 'admin-office',
            name: 'Staff | Admin Office',
            type: 'voice',
          },
          {
            key: 'review-office',
            name: 'Staff | Review Office',
            type: 'voice',
          },
          {
            key: 'staff-office-one',
            name: 'Staff | Office',
            type: 'voice',
          },
          {
            key: 'staff-office-two',
            name: 'Staff | Office II',
            type: 'voice',
          },
          {
            key: 'staff-office-three',
            name: 'Staff | Office III',
            type: 'voice',
          },
          {
            key: 'staff-office-four',
            name: 'Staff | Office IV',
            type: 'voice',
          },
          {
            key: 'staff-office-five',
            name: 'Staff | Office V',
            type: 'voice',
          },
          {
            key: 'staff-watch',
            name: 'Staff | Watch',
            type: 'voice',
          },
          {
            key: 'staff-lounge',
            name: 'Staff | Lounge',
            type: 'voice',
          },
          {
            key: 'staff-interview-room',
            name: 'Staff | Interview Room',
            type: 'voice',
          },
          {
            key: 'staff-exam-room',
            name: 'Staff | Exam Room',
            type: 'voice',
          },
          {
            key: 'staff-waiting-room',
            name: 'Staff | Waiting Room',
            type: 'voice',
          },
        ],
      },

      {
        key: 'web-logs',
        name: 'FLRP | Web Logs',
        overwrites: STAFF_ACCESS,
        channels: [
          { key: 'ftp-logs', name: 'ftp-logs', type: 'text' },
          { key: 'ftp-admin-logs', name: 'ftp-admin-logs', type: 'text' },
          { key: 'live-map-logs', name: 'live-map-logs', type: 'text' },
          {
            key: 'support-portal-leadership-tickets',
            name: 'support-portal-leadership-tickets',
            type: 'text',
          },
          {
            key: 'support-portal-messages',
            name: 'support-portal-messages',
            type: 'text',
          },
          { key: 'calendar-logs', name: 'calendar-logs', type: 'text' },
          { key: 'status-alerts', name: 'status-alerts', type: 'text' },
          { key: 'ia-web-logs', name: 'ia-web-logs', type: 'text' },
          {
            key: 'internal-records-logs',
            name: 'internal-records-logs',
            type: 'text',
          },
          {
            key: 'external-records-logs',
            name: 'external-records-logs',
            type: 'text',
          },
          {
            key: 'support-portal-logins',
            name: 'support-portal-logins',
            type: 'text',
          },
          {
            key: 'support-bot-logs',
            name: 'support-bot-logs',
            type: 'text',
          },
        ],
      },

      {
        key: 'discord-logs',
        name: 'FLRP | Discord Logs',
        overwrites: STAFF_ACCESS,
        channels: [
          { key: 'wick-logs', name: 'wick-logs', type: 'text' },
          {
            key: 'wick-admin-logs',
            name: 'wick-admin-logs',
            type: 'text',
          },
          { key: 'beemo-logs', name: 'beemo-logs', type: 'text' },
          { key: 'donation-logs', name: 'dono-logs', type: 'text' },
          { key: 'giftcard-logs', name: 'giftcard-logs', type: 'text' },
          { key: 'general-logs', name: 'general-logs', type: 'text' },
          { key: 'chatclear-logs', name: 'chatclear-logs', type: 'text' },
          { key: 'timeout-logs', name: 'timeout-logs', type: 'text' },
          { key: 'role-logs', name: 'role-logs', type: 'text' },
          { key: 'aux-bot-logs', name: 'aux-bot-logs', type: 'text' },
          {
            key: 'voice-channel-logs',
            name: 'voice-channel-logs',
            type: 'text',
          },
          { key: 'globalban-logs', name: 'globalban-logs', type: 'text' },
          { key: 'vortex-logs', name: 'vortex-logs', type: 'text' },
          {
            key: 'sonoran-cad-updates',
            name: 'sonoran-cad-updates',
            type: 'text',
          },
          {
            key: 'sonoran-cad-logs',
            name: 'sonoran-cad-logs',
            type: 'text',
          },
          {
            key: 'sonoran-cms-logs',
            name: 'sonoran-cms-logs',
            type: 'text',
          },
          { key: 'ticket-logs', name: 'ticket-logs', type: 'text' },
          {
            key: 'email-check-logs',
            name: 'email-check-logs',
            type: 'text',
          },
        ],
      },

      {
        key: 'ingame-logs',
        name: 'FLRP | In-Game Logs',
        overwrites: STAFF_ACCESS,
        channels: [
          { key: 'join-logs', name: 'join-logs', type: 'text' },
          { key: 'leave-logs', name: 'leave-logs', type: 'text' },
          { key: 'death-logs', name: 'death-logs', type: 'text' },
          { key: 'shooting-logs', name: 'shooting-logs', type: 'text' },
          {
            key: 'namechange-logs',
            name: 'namechange-logs',
            type: 'text',
          },
          { key: 'damage-logs', name: 'damage-logs', type: 'text' },
          {
            key: 'chatfilter-logs',
            name: 'chatfilter-logs',
            type: 'text',
          },
          { key: 'chat-logs', name: 'chat-logs', type: 'text' },
          { key: 'aop-logs', name: 'aop-logs', type: 'text' },
          {
            key: 'blocked-connection-logs',
            name: 'blocked-connection-logs',
            type: 'text',
          },
          { key: 'nex-ui-logs', name: 'nex-ui-logs', type: 'text' },
          { key: 'winch-logs', name: 'winch-logs', type: 'text' },
          {
            key: 'staff-blip-logs',
            name: 'staff-blip-logs',
            type: 'text',
          },
          {
            key: 'staff-jail-logs',
            name: 'staff-jail-logs',
            type: 'text',
          },
          {
            key: 'tx-discipline-logs',
            name: 'tx-discipline-logs',
            type: 'text',
          },
          {
            key: 'personal-vehicle-logs',
            name: 'personal-vehicle-logs',
            type: 'text',
          },
          {
            key: 'staff-reports',
            name: 'staff-reports',
            type: 'text',
          },
          { key: 'revive-logs', name: 'revive-logs', type: 'text' },
          {
            key: 'jail-hospital-logs',
            name: 'jail-hospital-logs',
            type: 'text',
          },
          { key: 'menu-logs', name: 'menu-logs', type: 'text' },
          {
            key: 'undercover-logs',
            name: 'undercover-logs',
            type: 'text',
          },
          { key: 'taser-logs', name: 'taser-logs', type: 'text' },
          { key: 'thermal-logs', name: 'thermal-logs', type: 'text' },
          {
            key: 'ingame-message-logs',
            name: 'ingame-msg-logs',
            type: 'text',
          },
          {
            key: 'spectate-logs',
            name: 'spectate-logs',
            type: 'text',
          },
          { key: 'money-logs', name: 'money-logs', type: 'text' },
          { key: 'temp-id-logs', name: 'temp-id-logs', type: 'text' },
          { key: 'grab-logs', name: 'grab-logs', type: 'text' },
          { key: 'trucker-logs', name: 'trucker-logs', type: 'text' },
          {
            key: 'time-weather-logs',
            name: 'time-weather-logs',
            type: 'text',
          },
          { key: 'music-logs', name: 'music-logs', type: 'text' },
          { key: 'repair-logs', name: 'repair-logs', type: 'text' },
          { key: 'hitch-logs', name: 'hitch-logs', type: 'text' },
          {
            key: 'staff-vest-logs',
            name: 'staff-vest-logs',
            type: 'text',
          },
          {
            key: 'trustscore-alerts',
            name: 'trustscore-alerts',
            type: 'text',
          },
          { key: 'bomb-logs', name: 'bomb-logs', type: 'text' },
        ],
      },

      {
        key: 'anticheat-logs',
        name: 'FLRP | Anticheat Logs',
        overwrites: STAFF_ACCESS,
        channels: [
          { key: 'warn-logs', name: 'warn-logs', type: 'text' },
          { key: 'kick-logs', name: 'kick-logs', type: 'text' },
        ],
      },

      {
        key: 'phone-logs',
        name: 'FLRP | Phone Logs',
        overwrites: STAFF_ACCESS,
        channels: [
          { key: 'call-logs', name: 'call-logs', type: 'text' },
          { key: 'message-logs', name: 'message-logs', type: 'text' },
          {
            key: 'instagram-logs',
            name: 'instagram-logs',
            type: 'text',
          },
          { key: 'twitter-logs', name: 'twitter-logs', type: 'text' },
          {
            key: 'yellowpages-logs',
            name: 'yellowpages-logs',
            type: 'text',
          },
          {
            key: 'marketplace-logs',
            name: 'marketplace-logs',
            type: 'text',
          },
          { key: 'darkchat-logs', name: 'darkchat-logs', type: 'text' },
          { key: 'media-logs', name: 'media-logs', type: 'text' },
        ],
      },

      {
        key: 'donator-section',
        name: 'FLRP | Donator Section',
        overwrites: [
          ...PRIVATE_CATEGORY,
          {
            role: 'ownership',
            allow: ['ViewChannel'],
          },
          {
            role: 'community-director',
            allow: ['ViewChannel'],
          },
          {
            role: 'donator',
            allow: ['ViewChannel'],
          },
          {
            role: 'diamond-supporter',
            allow: ['ViewChannel'],
          },
          {
            role: 'platinum-supporter',
            allow: ['ViewChannel'],
          },
        ],
        channels: [
          {
            key: 'donator-information',
            name: 'donator-information',
            type: 'text',
          },
          {
            key: 'personal-vehicle-request',
            name: 'personal-vehicle-request',
            type: 'text',
          },
          {
            key: 'donator-only-chat',
            name: 'donator-only-chat',
            type: 'text',
          },
          { key: 'archive-list', name: 'archive-list', type: 'text' },
          { key: 'tebex-support', name: 'tebex-support', type: 'text' },
          {
            key: 'donator-lounge',
            name: 'Donator | Lounge',
            type: 'voice',
          },
          {
            key: 'donator-waiting-room',
            name: 'Donator | Waiting Room',
            type: 'voice',
          },
        ],
      },

      {
        key: 'information',
        name: 'FLRP | Information',
        overwrites: [
          {
            role: 'everyone',
            deny: ['SendMessages', 'CreatePublicThreads'],
          },
        ],
        channels: [
          {
            key: 'announcements',
            name: 'announcements',
            type: 'text',
          },
          {
            key: 'internal-announcements',
            name: 'internal-announcements',
            type: 'text',
          },
          {
            key: 'server-information',
            name: 'server-information',
            type: 'text',
          },
          {
            key: 'server-commands',
            name: 'server-commands',
            type: 'text',
          },
          {
            key: 'server-status',
            name: 'server-status',
            type: 'text',
          },
          {
            key: 'queue-status',
            name: 'queue-status',
            type: 'text',
          },
          { key: 'cad-access', name: 'cad-access', type: 'text' },
          {
            key: 'broken-lights-fix',
            name: 'broken-lights-fix',
            type: 'text',
          },
          {
            key: 'department-information',
            name: 'dept-information',
            type: 'text',
          },
          {
            key: 'money-leaderboard',
            name: 'money-leaderboard',
            type: 'text',
          },
          {
            key: 'leadership-directory',
            name: 'leadership-directory',
            type: 'text',
          },
          {
            key: 'server-change-log',
            name: 'server-change-log',
            type: 'text',
          },
          {
            key: 'server-updates',
            name: 'server-updates',
            type: 'text',
          },
          {
            key: 'rule-updates',
            name: 'rule-updates',
            type: 'text',
          },
          { key: 'live-bans', name: 'live-bans', type: 'text' },
        ],
      },

      {
        key: 'general',
        name: 'FLRP | General',
        channels: [
          { key: 'support', name: 'support', type: 'text' },
          { key: 'main-chat', name: 'main-chat', type: 'text' },
          {
            key: 'main-chat-unhinged',
            name: 'main-chat-unhinged',
            type: 'text',
          },
          {
            key: 'whitelisted-chat',
            name: 'whitelisted-chat',
            type: 'text',
          },
          { key: 'ingame-chat', name: 'ingame-chat', type: 'text' },
          {
            key: 'ingame-content',
            name: 'ingame-content',
            type: 'text',
          },
          { key: 'going-live', name: 'going-live', type: 'text' },
          {
            key: 'server-suggestions',
            name: 'server-suggestions',
            type: 'forum',
          },
          {
            key: 'report-server-bugs',
            name: 'report-server-bugs',
            type: 'forum',
          },
          {
            key: 'new-cad-topics',
            name: 'new-cad-topics',
            type: 'forum',
          },
          {
            key: 'phone-twitter',
            name: 'phone-twitter',
            type: 'text',
          },
          {
            key: 'phone-instagram',
            name: 'phone-instagram',
            type: 'text',
          },
          {
            key: 'commendations',
            name: 'commendations',
            type: 'text',
          },
          { key: 'minecraft', name: 'minecraft', type: 'text' },
          {
            key: 'truth-social',
            name: 'truth-social',
            type: 'text',
          },
          { key: 'public-voice', name: 'Public Voice', type: 'voice' },
          { key: 'civilian-voice', name: 'Civilian', type: 'voice' },
          { key: 'minecraft-voice', name: 'Minecraft', type: 'voice' },
          {
            key: 'community-town-hall',
            name: 'Community Town Hall',
            type: 'voice',
          },
          { key: 'court-room', name: 'Court Room', type: 'voice' },
        ],
      },

      {
        key: 'department-heads',
        name: 'FLRP | Department Heads',
        overwrites: DEPARTMENT_HEAD_ACCESS,
        channels: [
          {
            key: 'department-head-announcements',
            name: 'dept-head-announcements',
            type: 'text',
          },
          {
            key: 'department-head-information',
            name: 'dept-head-information',
            type: 'text',
          },
          {
            key: 'es-administrative-logs',
            name: 'es-administrative-logs',
            type: 'text',
          },
          {
            key: 'email-database',
            name: 'email-database',
            type: 'text',
          },
          {
            key: 'es-statistics',
            name: 'es-statistics',
            type: 'text',
          },
          { key: 'es-numbers', name: 'es-numbers', type: 'text' },
          {
            key: 'hcso-statistics',
            name: 'hcso-statistics',
            type: 'text',
          },
          {
            key: 'tpd-statistics',
            name: 'tpd-statistics',
            type: 'text',
          },
          {
            key: 'fhp-statistics',
            name: 'fhp-statistics',
            type: 'text',
          },
          {
            key: 'hcfr-statistics',
            name: 'hcfr-statistics',
            type: 'text',
          },
          {
            key: 'department-heads-chat',
            name: 'department-heads',
            type: 'text',
          },
          {
            key: 'department-head-requests',
            name: 'dept-head-requests',
            type: 'text',
          },
          {
            key: 'approval-requests',
            name: 'approval-requests',
            type: 'text',
          },
          {
            key: 'department-head-meeting-room',
            name: 'Dept. Head | Meeting Room',
            type: 'voice',
          },
        ],
      },

      {
        key: 'emergency-services',
        name: 'FLRP | Emergency Services',
        overwrites: EMERGENCY_SERVICES_ACCESS,
        channels: [
          {
            key: 'es-announcements',
            name: 'es-announcements',
            type: 'text',
          },
          {
            key: 'es-information',
            name: 'es-information',
            type: 'text',
          },
          {
            key: 'es-radio-information',
            name: 'es-radio-info',
            type: 'text',
          },
          { key: 'es-commands', name: 'es-commands', type: 'text' },
          { key: 'es-chat', name: 'es-chat', type: 'text' },
          {
            key: 'es-supervisors',
            name: 'es-supervisors',
            type: 'text',
          },
          {
            key: 'es-command-staff',
            name: 'es-command-staff',
            type: 'text',
          },
          {
            key: 'es-subdivision-heads',
            name: 'es-subdivision-heads',
            type: 'text',
          },
          {
            key: 'penal-code-suggestions',
            name: 'penal-code-suggestions',
            type: 'forum',
          },
          {
            key: 'ingame-911-logs',
            name: 'in-game-911-logs',
            type: 'text',
          },
          {
            key: 'warrant-requests',
            name: 'warrant-requests',
            type: 'text',
          },
          {
            key: 'major-gun-crimes',
            name: 'major-gun-crimes',
            type: 'text',
          },
          {
            key: 'es-bot-commands',
            name: 'es-bot-commands',
            type: 'text',
          },
          {
            key: 'dispatch-chat',
            name: 'dispatch-chat',
            type: 'text',
          },
          {
            key: 'es-training-schedule',
            name: 'es-training-schedule',
            type: 'text',
          },
          {
            key: 'es-command-staff-voice',
            name: 'ES | Command Staff',
            type: 'voice',
          },
          {
            key: 'es-relaxation-room',
            name: 'ES | Relaxation Room',
            type: 'voice',
          },
          {
            key: 'es-meeting-hall',
            name: 'ES | Meeting Hall',
            type: 'voice',
          },
          {
            key: 'es-supervisor-room',
            name: 'ES | Supervisor Room',
            type: 'voice',
          },
        ],
      },
    ],

    // The hub server supplies mapping source roles rather than receiving one
    // managed membership role from another server.
    managedRoleKey: null,
  };
}

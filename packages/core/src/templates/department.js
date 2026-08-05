/**
 * Florida Roleplay department server template.
 *
 * Used by `/setup department` for:
 * - HCSO
 * - TPD
 * - FHP
 *
 * The department tag controls the category and role prefixes.
 * Rank titles are adjusted automatically for each supported agency.
 */

const DEFAULT_COLOR = 0x5865f2;

/**
 * @param {string} tag
 * @returns {{
 *   agencyHead: string,
 *   secondInCommand: string,
 *   thirdInCommand: string,
 *   fourthInCommand?: string,
 *   seniorMember: string,
 *   memberThree: string,
 *   memberTwo: string,
 *   memberOne: string,
 *   entryRank: string,
 *   headOffice: string,
 *   secondOffice: string,
 *   thirdOffice: string,
 *   fourthOffice?: string
 * }}
 */
function getAgencyProfile(tag) {
  switch (tag.toUpperCase()) {
    case 'HCSO':
      return {
        agencyHead: 'Sheriff',
        secondInCommand: 'Undersheriff',
        thirdInCommand: 'Chief Deputy',
        fourthInCommand: 'Colonel',

        seniorMember: 'Master Deputy',
        memberThree: 'Deputy III',
        memberTwo: 'Deputy II',
        memberOne: 'Deputy I',
        entryRank: 'Cadet',

        headOffice: "Sheriff's Office",
        secondOffice: "Undersheriff's Office",
        thirdOffice: "Chief Deputy's Office",
        fourthOffice: "Colonel's Office",
      };

    case 'FHP':
      return {
        agencyHead: 'Colonel',
        secondInCommand: 'Lieutenant Colonel',
        thirdInCommand: 'Chief Major',

        seniorMember: 'Master Trooper',
        memberThree: 'Trooper III',
        memberTwo: 'Trooper II',
        memberOne: 'Trooper I',
        entryRank: 'Probationary Trooper',

        headOffice: "Colonel's Office",
        secondOffice: "Lieutenant Colonel's Office",
        thirdOffice: "Chief Major's Office",
      };

    case 'TPD':
    default:
      return {
        agencyHead: 'Chief of Police',
        secondInCommand: 'Assistant Chief of Police',
        thirdInCommand: 'Deputy Chief',

        seniorMember: 'Master Police Officer',
        memberThree: 'Police Officer III',
        memberTwo: 'Police Officer II',
        memberOne: 'Police Officer I',
        entryRank: 'Cadet',

        headOffice: "Chief's Office",
        secondOffice: "Assistant Chief's Office",
        thirdOffice: "Deputy Chief's Office",
      };
  }
}

/**
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.tag
 * @param {number|string} [params.color]
 * @returns {DepartmentTemplate}
 */
export function buildDepartmentTemplate({ name, tag, color = DEFAULT_COLOR }) {
  const normalizedTag = tag?.trim().toUpperCase();

  if (!['HCSO', 'TPD', 'FHP'].includes(normalizedTag)) {
    throw new Error(`Unsupported department tag "${tag}". Supported tags are HCSO, TPD, and FHP.`);
  }

  const profile = getAgencyProfile(normalizedTag);

  const roleName = (role) => `${normalizedTag} | ${role}`;
  const categoryName = (category) => `${normalizedTag} | ${category}`;

  const PRIVATE_CATEGORY = [
    {
      role: 'everyone',
      deny: ['ViewChannel'],
    },
  ];

  const MEMBER_ACCESS = [
    ...PRIVATE_CATEGORY,
    {
      role: 'member',
      allow: ['ViewChannel'],
    },
    {
      role: 'supervisor',
      allow: ['ViewChannel'],
    },
    {
      role: 'command',
      allow: ['ViewChannel'],
    },
    {
      role: 'department-head',
      allow: ['ViewChannel'],
    },
  ];

  const SUPERVISOR_ACCESS = [
    ...PRIVATE_CATEGORY,
    {
      role: 'supervisor',
      allow: ['ViewChannel'],
    },
    {
      role: 'command',
      allow: ['ViewChannel'],
    },
    {
      role: 'department-head',
      allow: ['ViewChannel'],
    },
  ];

  const COMMAND_ACCESS = [
    ...PRIVATE_CATEGORY,
    {
      role: 'command',
      allow: ['ViewChannel'],
    },
    {
      role: 'department-head',
      allow: ['ViewChannel'],
    },
  ];

  const SUPPORT_SERVICES_ACCESS = [
    ...PRIVATE_CATEGORY,
    {
      role: 'support-services-division',
      allow: ['ViewChannel'],
    },
    {
      role: 'training-division',
      allow: ['ViewChannel'],
    },
    {
      role: 'recruiting-division',
      allow: ['ViewChannel'],
    },
    {
      role: 'academy-instructor',
      allow: ['ViewChannel'],
    },
    {
      role: 'senior-fto',
      allow: ['ViewChannel'],
    },
    {
      role: 'fto',
      allow: ['ViewChannel'],
    },
    {
      role: 'command',
      allow: ['ViewChannel'],
    },
    {
      role: 'department-head',
      allow: ['ViewChannel'],
    },
  ];

  const INTERNAL_AFFAIRS_ACCESS = [
    ...PRIVATE_CATEGORY,
    {
      role: 'internal-affairs',
      allow: ['ViewChannel'],
    },
    {
      role: 'internal-affairs-lead',
      allow: ['ViewChannel'],
    },
    {
      role: 'department-head',
      allow: ['ViewChannel'],
    },
  ];

  const SCU_ACCESS = [
    ...PRIVATE_CATEGORY,
    {
      role: 'street-crimes-unit',
      allow: ['ViewChannel'],
    },
    {
      role: 'street-crimes-leadership',
      allow: ['ViewChannel'],
    },
    {
      role: 'command',
      allow: ['ViewChannel'],
    },
    {
      role: 'department-head',
      allow: ['ViewChannel'],
    },
  ];

  const CID_ACCESS = [
    ...PRIVATE_CATEGORY,
    {
      role: 'cid',
      allow: ['ViewChannel'],
    },
    {
      role: 'cid-leadership',
      allow: ['ViewChannel'],
    },
    {
      role: 'command',
      allow: ['ViewChannel'],
    },
    {
      role: 'department-head',
      allow: ['ViewChannel'],
    },
  ];

  const K9_ACCESS = [
    ...PRIVATE_CATEGORY,
    {
      role: 'canine-unit',
      allow: ['ViewChannel'],
    },
    {
      role: 'canine-leadership',
      allow: ['ViewChannel'],
    },
    {
      role: 'command',
      allow: ['ViewChannel'],
    },
    {
      role: 'department-head',
      allow: ['ViewChannel'],
    },
  ];

  return {
    name,

    roles: [
      // Department leadership
      {
        key: 'department-head',
        name: roleName('Department Head'),
        color,
        hoist: true,
      },
      {
        key: 'agency-head',
        name: roleName(profile.agencyHead),
        color,
        hoist: true,
      },
      {
        key: 'second-in-command',
        name: roleName(profile.secondInCommand),
        color,
        hoist: true,
      },
      {
        key: 'third-in-command',
        name: roleName(profile.thirdInCommand),
        color,
        hoist: true,
      },

      ...(profile.fourthInCommand
        ? [
            {
              key: 'fourth-in-command',
              name: roleName(profile.fourthInCommand),
              color,
              hoist: true,
            },
          ]
        : []),

      // Command ranks
      {
        key: 'major',
        name: roleName('Major'),
        color,
        hoist: true,
      },
      {
        key: 'captain',
        name: roleName('Captain'),
        color,
        hoist: true,
      },
      {
        key: 'lieutenant',
        name: roleName('Lieutenant'),
        color,
        hoist: true,
      },

      // Supervisory ranks
      {
        key: 'sergeant',
        name: roleName('Sergeant'),
        color,
        hoist: true,
      },
      {
        key: 'corporal',
        name: roleName('Corporal'),
        color,
        hoist: true,
      },

      // Patrol ranks
      {
        key: 'senior-member',
        name: roleName(profile.seniorMember),
        color,
        hoist: true,
      },
      {
        key: 'member-three',
        name: roleName(profile.memberThree),
        color,
        hoist: true,
      },
      {
        key: 'member-two',
        name: roleName(profile.memberTwo),
        color,
        hoist: true,
      },
      {
        key: 'member-one',
        name: roleName(profile.memberOne),
        color,
        hoist: true,
      },
      {
        key: 'cadet',
        name: roleName(profile.entryRank),
        color,
        hoist: true,
      },
      {
        key: 'applicant',
        name: roleName('Applicant'),
        color,
        hoist: false,
      },

      // Access and grouping roles
      {
        key: 'command',
        name: roleName('Command Staff'),
        color,
        hoist: true,
      },
      {
        key: 'supervisor',
        name: roleName('Supervisor'),
        color,
        hoist: true,
      },
      {
        key: 'member',
        name: roleName('Department Member'),
        color,
        hoist: true,
      },
      {
        key: 'patrol-officers',
        name: roleName('Patrol Officers'),
        color,
        hoist: false,
      },
      {
        key: 'subdivision-head',
        name: roleName('Subdivision Head'),
        color,
        hoist: true,
      },

      // Divisions
      {
        key: 'operations-division',
        name: roleName('Operations Division'),
        color,
        hoist: false,
      },
      {
        key: 'special-operations-division',
        name: roleName('Special Operations Division'),
        color,
        hoist: false,
      },
      {
        key: 'support-services-division',
        name: roleName('Support Services Division'),
        color,
        hoist: false,
      },
      {
        key: 'administrative-division',
        name: roleName('Administrative Division'),
        color,
        hoist: false,
      },
      {
        key: 'training-division',
        name: roleName('Training Division'),
        color,
        hoist: false,
      },
      {
        key: 'patrol-division',
        name: roleName('Patrol Division'),
        color,
        hoist: false,
      },
      {
        key: 'recruiting-division',
        name: roleName('Recruiting Division'),
        color,
        hoist: false,
      },

      // Internal Affairs
      {
        key: 'internal-affairs-lead',
        name: roleName('Internal Affairs Lead'),
        color,
        hoist: true,
      },
      {
        key: 'internal-affairs',
        name: roleName('Internal Affairs'),
        color,
        hoist: false,
      },

      // Member status
      {
        key: 'leave-of-absence',
        name: roleName('Leave of Absence'),
        color,
        hoist: false,
      },
      {
        key: 'department-pto',
        name: roleName('Department PTO'),
        color,
        hoist: false,
      },
      {
        key: 'probation',
        name: roleName('Probation'),
        color,
        hoist: false,
      },

      // Recruitment and media
      {
        key: 'recruitment-team',
        name: roleName('Recruitment Team'),
        color,
        hoist: false,
      },
      {
        key: 'pio',
        name: roleName('Public Information Officer'),
        color,
        hoist: false,
      },

      // Training
      {
        key: 'academy-instructor',
        name: roleName('Academy Instructor'),
        color,
        hoist: false,
      },
      {
        key: 'senior-fto',
        name: roleName('Senior Field Training Officer'),
        color,
        hoist: false,
      },
      {
        key: 'fto',
        name: roleName('Field Training Officer'),
        color,
        hoist: false,
      },

      // SWAT
      {
        key: 'swat-commander',
        name: roleName('SWAT Commander'),
        color,
        hoist: false,
      },
      {
        key: 'swat-executive-commander',
        name: roleName('SWAT Executive Commander'),
        color,
        hoist: false,
      },
      {
        key: 'swat-executive-officer',
        name: roleName('SWAT Executive Officer'),
        color,
        hoist: false,
      },
      {
        key: 'swat-supervisory-operator',
        name: roleName('SWAT Supervisory Operator'),
        color,
        hoist: false,
      },
      {
        key: 'swat-operator',
        name: roleName('SWAT Operator'),
        color,
        hoist: false,
      },
      {
        key: 'swat-recruit',
        name: roleName('SWAT Recruit'),
        color,
        hoist: false,
      },
      {
        key: 'swat',
        name: roleName('Special Weapons & Tactics'),
        color,
        hoist: false,
      },

      // Street Crimes Unit
      {
        key: 'street-crimes-leadership',
        name: roleName('Street Crimes Leadership'),
        color,
        hoist: false,
      },
      {
        key: 'street-crimes-unit',
        name: roleName('Street Crimes Unit'),
        color,
        hoist: false,
      },

      // Criminal Investigations Division
      {
        key: 'cid-leadership',
        name: roleName('CID Leadership'),
        color,
        hoist: false,
      },
      {
        key: 'cid',
        name: roleName('Criminal Investigations Division'),
        color,
        hoist: false,
      },

      // Canine Unit
      {
        key: 'canine-leadership',
        name: roleName('Canine Leadership'),
        color,
        hoist: false,
      },
      {
        key: 'canine-unit',
        name: roleName('Canine Unit'),
        color,
        hoist: false,
      },
    ],

    categories: [
      {
        key: 'support-center',
        name: categoryName('Support Center'),
        channels: [
          {
            key: 'web-tickets',
            name: 'web-tickets',
            type: 'text',
          },
        ],
      },

      {
        key: 'recruitment-center',
        name: categoryName('Recruitment Center'),
        channels: [
          {
            key: 'join-us',
            name: 'join-us',
            type: 'text',
          },
          {
            key: 'public-bulletins',
            name: 'public-bulletins',
            type: 'forum',
          },
          {
            key: 'official-media',
            name: 'official-media',
            type: 'text',
          },
          {
            key: 'name-request',
            name: 'name-request',
            type: 'text',
          },
          {
            key: 'visitor-chat',
            name: 'visitor-chat',
            type: 'text',
          },
        ],
      },

      {
        key: 'information',
        name: categoryName('Information'),
        overwrites: [
          {
            role: 'everyone',
            deny: ['SendMessages', 'CreatePublicThreads'],
          },
        ],
        channels: [
          {
            key: 'rules',
            name: 'rules',
            type: 'text',
          },
          {
            key: 'announcements',
            name: 'announcements',
            type: 'text',
          },
          {
            key: 'department-information',
            name: `${normalizedTag.toLowerCase()}-information`,
            type: 'text',
          },
          {
            key: 'policy-updates',
            name: 'policy-updates',
            type: 'text',
          },
          {
            key: 'promotions',
            name: 'promotions',
            type: 'text',
          },
          {
            key: 'subdivisions',
            name: 'subdivisions',
            type: 'text',
          },
        ],
      },

      {
        key: 'general',
        name: categoryName('General'),
        overwrites: MEMBER_ACCESS,
        channels: [
          {
            key: 'main-chat',
            name: 'main-chat',
            type: 'text',
          },
          {
            key: 'pictures',
            name: 'pictures',
            type: 'text',
          },
          {
            key: 'unfiltered',
            name: `${normalizedTag.toLowerCase()}-unfiltered`,
            type: 'text',
          },
          {
            key: 'department-suggestions',
            name: 'dept-suggestions',
            type: 'forum',
          },
          {
            key: 'phone-numbers',
            name: 'phone-numbers',
            type: 'text',
          },
          {
            key: 'commendations',
            name: 'commendations',
            type: 'text',
          },
          {
            key: 'on-duty-one',
            name: 'On Duty',
            type: 'voice',
          },
          {
            key: 'on-duty-two',
            name: 'On Duty 2',
            type: 'voice',
          },
          {
            key: 'general-voice',
            name: 'General',
            type: 'voice',
          },
          {
            key: 'lounge',
            name: 'Lounge',
            type: 'voice',
          },
          {
            key: 'conference-room',
            name: 'Conference Room',
            type: 'voice',
          },
        ],
      },

      {
        key: 'requests',
        name: categoryName('Requests'),
        overwrites: MEMBER_ACCESS,
        channels: [
          {
            key: 'request-interview',
            name: 'request-interview',
            type: 'text',
          },
          {
            key: 'request-training',
            name: 'request-training',
            type: 'forum',
          },
          {
            key: 'request-supervisor',
            name: 'request-supervisor',
            type: 'text',
          },
          {
            key: 'request-command',
            name: 'request-command',
            type: 'text',
          },
          {
            key: 'report-corrections',
            name: 'report-corrections',
            type: 'text',
          },
        ],
      },

      {
        key: 'patrol-services',
        name: 'Patrol Services',
        overwrites: MEMBER_ACCESS,
        channels: [
          {
            key: 'patrol-reminders',
            name: 'patrol-reminders',
            type: 'text',
          },
          {
            key: 'patrol-zones',
            name: 'patrol-zones',
            type: 'text',
          },
          {
            key: 'division-one',
            name: 'division-one',
            type: 'text',
          },
          {
            key: 'division-two',
            name: 'division-two',
            type: 'text',
          },
          {
            key: 'division-three',
            name: 'division-three',
            type: 'text',
          },
          {
            key: 'division-four',
            name: 'division-four',
            type: 'text',
          },
          {
            key: 'division-five',
            name: 'division-five',
            type: 'text',
          },
          {
            key: 'traffic-announcements',
            name: 'tsd-announcements',
            type: 'text',
          },
          {
            key: 'traffic-division',
            name: 'traffic-division',
            type: 'text',
          },
          {
            key: 'traffic-division-reports',
            name: 'traffic-division-reports',
            type: 'text',
          },
          {
            key: 'traffic-applications',
            name: 'tsd-applications',
            type: 'text',
          },
          {
            key: 'activity-check',
            name: 'activity-check',
            type: 'text',
          },
          {
            key: 'traffic-general',
            name: 'TSD | General',
            type: 'voice',
          },
        ],
      },

      {
        key: 'support-services',
        name: categoryName('Support Services Division'),
        overwrites: SUPPORT_SERVICES_ACCESS,
        channels: [
          {
            key: 'training-announcements',
            name: 'training-announcements',
            type: 'text',
          },
          {
            key: 'training-information',
            name: 'training-info',
            type: 'text',
          },
          {
            key: 'recruiting-information',
            name: 'recruiting-info',
            type: 'text',
          },
          {
            key: 'fto-chat',
            name: 'fto-chat',
            type: 'text',
          },
          {
            key: 'cadet-announcements',
            name: 'cadet-announcements',
            type: 'text',
          },
          {
            key: 'support-reports',
            name: 'support-reports',
            type: 'text',
          },
          {
            key: 'training-office',
            name: 'Training Office',
            type: 'voice',
          },
          {
            key: 'field-training-one',
            name: 'Field Training - 1',
            type: 'voice',
          },
          {
            key: 'field-training-two',
            name: 'Field Training - 2',
            type: 'voice',
          },
          {
            key: 'field-training-three',
            name: 'Field Training - 3',
            type: 'voice',
          },
          {
            key: 'field-training-four',
            name: 'Field Training - 4',
            type: 'voice',
          },
          {
            key: 'interview-room-one',
            name: 'Interview Room - 1',
            type: 'voice',
          },
          {
            key: 'interview-room-two',
            name: 'Interview Room - 2',
            type: 'voice',
          },
          {
            key: 'waiting-support-services',
            name: 'Waiting for Support Services',
            type: 'voice',
          },
        ],
      },

      {
        key: 'street-crimes-unit',
        name: categoryName('Street Crimes Unit'),
        overwrites: SCU_ACCESS,
        channels: [
          {
            key: 'scu-announcements',
            name: 'scu-announcements',
            type: 'text',
          },
          {
            key: 'scu-information',
            name: 'scu-information',
            type: 'text',
          },
          {
            key: 'scu-leadership',
            name: 'scu-leadership',
            type: 'text',
          },
          {
            key: 'scu-chat',
            name: 'scu-chat',
            type: 'text',
          },
          {
            key: 'scu-database',
            name: 'scu-database',
            type: 'forum',
          },
          {
            key: 'scu-applications',
            name: 'scu-applications',
            type: 'text',
          },
          {
            key: 'scu-reports',
            name: 'scu-reports',
            type: 'text',
          },
          {
            key: 'investigations-cases',
            name: 'investigations-cases',
            type: 'forum',
          },
          {
            key: 'scu-command-office',
            name: 'SCU Command Office',
            type: 'voice',
          },
          {
            key: 'scu-lounge',
            name: 'SCU Lounge',
            type: 'voice',
          },
        ],
      },

      {
        key: 'cid',
        name: categoryName('CID'),
        overwrites: CID_ACCESS,
        channels: [
          {
            key: 'cid-announcements',
            name: 'cid-announcements',
            type: 'text',
          },
          {
            key: 'cid-information',
            name: 'cid-information',
            type: 'text',
          },
          {
            key: 'cid-chat',
            name: 'cid-chat',
            type: 'text',
          },
          {
            key: 'cid-request',
            name: 'cid-request',
            type: 'text',
          },
          {
            key: 'cid-leadership',
            name: 'cid-leadership',
            type: 'text',
          },
          {
            key: 'cid-applications',
            name: 'cid-applications',
            type: 'text',
          },
          {
            key: 'cid-commander-office',
            name: 'CID Commander Office',
            type: 'voice',
          },
        ],
      },

      {
        key: 'canine-unit',
        name: categoryName('Canine Unit'),
        overwrites: K9_ACCESS,
        channels: [
          {
            key: 'k9-announcements',
            name: 'k9-announcements',
            type: 'text',
          },
          {
            key: 'k9-information',
            name: 'k9-information',
            type: 'text',
          },
          {
            key: 'k9-chat',
            name: 'k9-chat',
            type: 'text',
          },
          {
            key: 'k9-request',
            name: 'k9-request',
            type: 'text',
          },
          {
            key: 'k9-training-request',
            name: 'k9-training-request',
            type: 'text',
          },
          {
            key: 'k9-leadership',
            name: 'k9-leadership',
            type: 'text',
          },
          {
            key: 'k9-applications',
            name: 'k9-applications',
            type: 'text',
          },
          {
            key: 'k9-commander-office',
            name: 'K9 Commander Office',
            type: 'voice',
          },
          {
            key: 'k9-lounge',
            name: 'K9 Lounge',
            type: 'voice',
          },
        ],
      },

      {
        key: 'supervisors',
        name: categoryName('Supervisors'),
        overwrites: SUPERVISOR_ACCESS,
        channels: [
          {
            key: 'supervisor-announcements',
            name: 'supervisor-announcements',
            type: 'text',
          },
          {
            key: 'supervisor-information',
            name: 'supervisor-information',
            type: 'text',
          },
          {
            key: 'supervisor-chat',
            name: 'supervisor-chat',
            type: 'text',
          },
          {
            key: 'supervisor-bot-commands',
            name: 'bot-commands',
            type: 'text',
          },
          {
            key: 'supervisors-room',
            name: "Supervisor's Room",
            type: 'voice',
          },
          {
            key: 'supervisor-meeting-room',
            name: 'Supervisor Meeting Room',
            type: 'voice',
          },
          {
            key: 'waiting-supervisors',
            name: 'Waiting for Supervisors',
            type: 'voice',
          },
        ],
      },

      {
        key: 'division-command-center',
        name: 'Division Command Center',
        overwrites: COMMAND_ACCESS,
        channels: [
          {
            key: 'homeland-division',
            name: 'homeland-division',
            type: 'text',
          },
          {
            key: 'training-division',
            name: 'training-division',
            type: 'text',
          },
          {
            key: 'outreach-division',
            name: 'outreach-division',
            type: 'text',
          },
          {
            key: 'patrol-division',
            name: 'patrol-division',
            type: 'text',
          },
          {
            key: 'admin-division',
            name: 'admin-division',
            type: 'text',
          },
        ],
      },

      {
        key: 'administrative-logs',
        name: categoryName('Administrative Logs'),
        overwrites: COMMAND_ACCESS,
        channels: [
          {
            key: 'work-orders',
            name: 'work-orders',
            type: 'text',
          },
          {
            key: 'fto-logbook',
            name: 'fto-logbook',
            type: 'text',
          },
          {
            key: 'interview-logbook',
            name: 'interview-logbook',
            type: 'text',
          },
          {
            key: 'coaching-disciplinary-action',
            name: 'coaching-da',
            type: 'text',
          },
          {
            key: 'nonverbal-disciplinary-action',
            name: 'nonverbal-da',
            type: 'text',
          },
          {
            key: 'admin-logs',
            name: 'admin-logs',
            type: 'text',
          },
        ],
      },

      {
        key: 'command-staff',
        name: categoryName('Command Staff'),
        overwrites: COMMAND_ACCESS,
        channels: [
          {
            key: 'command-announcements',
            name: 'command-announcements',
            type: 'text',
          },
          {
            key: 'command-information',
            name: 'command-information',
            type: 'text',
          },
          {
            key: 'command-chat',
            name: 'command-chat',
            type: 'text',
          },
          {
            key: 'senior-command-chat',
            name: 'senior-command-chat',
            type: 'text',
          },
          {
            key: 'high-command-chat',
            name: 'high-command-chat',
            type: 'text',
          },
          {
            key: 'department-head-chat',
            name: 'department-head-chat',
            type: 'text',
          },
          {
            key: 'welcome-leave',
            name: 'welcome-leave',
            type: 'text',
          },
          {
            key: 'duty-logs',
            name: 'duty-logs',
            type: 'text',
          },
          {
            key: 'command-bot-commands',
            name: 'bot-cmds',
            type: 'text',
          },
          {
            key: 'department-applications',
            name: `${normalizedTag.toLowerCase()}-applications`,
            type: 'text',
          },
          {
            key: 'admin-tasks',
            name: 'admin-tasks',
            type: 'text',
          },
          {
            key: 'transfer-requests',
            name: 'transfer-requests',
            type: 'text',
          },
          {
            key: 'fdle-cases',
            name: 'fdle-cases',
            type: 'text',
          },
          {
            key: 'agency-head-office',
            name: profile.headOffice,
            type: 'voice',
          },
          {
            key: 'second-in-command-office',
            name: profile.secondOffice,
            type: 'voice',
          },
          {
            key: 'third-in-command-office',
            name: profile.thirdOffice,
            type: 'voice',
          },

          ...(profile.fourthOffice
            ? [
                {
                  key: 'fourth-in-command-office',
                  name: profile.fourthOffice,
                  type: 'voice',
                },
              ]
            : []),

          {
            key: 'major-office',
            name: "Major's Office",
            type: 'voice',
          },
          {
            key: 'captain-office',
            name: "Captain's Office",
            type: 'voice',
          },
          {
            key: 'lieutenant-office',
            name: "Lieutenant's Office",
            type: 'voice',
          },
          {
            key: 'command-meeting-room',
            name: 'Command Meeting Room',
            type: 'voice',
          },
          {
            key: 'command-lounge',
            name: 'Command Lounge',
            type: 'voice',
          },
          {
            key: 'waiting-command',
            name: 'Waiting for Command',
            type: 'voice',
          },
        ],
      },

      {
        key: 'internal-affairs',
        name: categoryName('Internal Affairs'),
        overwrites: INTERNAL_AFFAIRS_ACCESS,
        channels: [
          {
            key: 'internal-affairs-chat',
            name: 'internal-affairs',
            type: 'text',
          },
          {
            key: 'ia-cases',
            name: 'ia-cases',
            type: 'forum',
          },
          {
            key: 'ia-requests',
            name: 'ia-requests',
            type: 'text',
          },
          {
            key: 'ia-office',
            name: 'IA Office',
            type: 'voice',
          },
          {
            key: 'ia-waiting-room',
            name: 'IA Waiting Room',
            type: 'voice',
          },
        ],
      },

      {
        key: 'disciplinary-archive',
        name: categoryName('Disciplinary Logs Archive'),
        overwrites: COMMAND_ACCESS,
        channels: [
          {
            key: 'disciplinary-logbook-archive',
            name: 'da-logbook-archive',
            type: 'text',
          },
        ],
      },

      {
        key: 'logs',
        name: categoryName('Logs'),
        overwrites: COMMAND_ACCESS,
        channels: [
          {
            key: 'ticket-transcripts',
            name: 'ticket-transcripts',
            type: 'text',
          },
          {
            key: 'vortex-logs',
            name: 'vortex-logs',
            type: 'text',
          },
        ],
      },
    ],

    /**
     * The role synchronized from the corresponding role in the main
     * Florida Roleplay community server.
     */
    managedRoleKey: 'member',
  };
}

/**
 * @typedef {object} DepartmentTemplate
 * @property {string} name
 * @property {Array<{
 *   key: string,
 *   name: string,
 *   color?: number|string,
 *   hoist?: boolean
 * }>} roles
 * @property {Array<TemplateCategory>} categories
 * @property {string} managedRoleKey
 *
 * @typedef {object} TemplateCategory
 * @property {string} key
 * @property {string} name
 * @property {Array<{
 *   role: string,
 *   allow?: string[],
 *   deny?: string[]
 * }>} [overwrites]
 * @property {Array<{
 *   key: string,
 *   name: string,
 *   type: 'text'|'voice'|'forum'
 * }>} channels
 */

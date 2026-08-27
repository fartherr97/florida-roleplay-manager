/**
 * Command registry.
 *
 * Adding a command means adding it to this list and nothing else: registration with
 * Discord, routing and autocomplete all read from here.
 */
import * as access from './access.js';
import * as audit from './audit.js';
import * as bgcheck from './bgcheck.js';
import * as globalnickname from './globalnickname.js';
import * as guild from './guild.js';
import * as mapping from './mapping.js';
import * as member from './member.js';
import * as permissions from './permissions.js';
import * as resync from './resync.js';
import * as role from './role.js';
import * as roster from './roster.js';
import * as rolemanager from './rolemanager.js';
import * as setup from './setup.js';
import * as system from './system.js';

const MODULES = [
  access,
  audit,
  bgcheck,
  globalnickname,
  guild,
  mapping,
  member,
  permissions,
  resync,
  role,
  rolemanager,
  roster,
  setup,
  system,
];

/** @type {Map<string, {data: object, execute: Function}>} */
export const commands = new Map(MODULES.map((module) => [module.data.name, module]));

/** Payload for the Discord command registration API. */
export function commandPayload() {
  return MODULES.map((module) => module.data.toJSON());
}

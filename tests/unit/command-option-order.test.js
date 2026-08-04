/**
 * Slash-command option ordering.
 *
 * Discord requires every required option to appear before any optional one, in each
 * subcommand and each top-level command. Violating it is a 50035 "Invalid Form Body"
 * that only surfaces when the command is registered against the real API - discord.js
 * does not reject it at build time - so this guards the whole command surface at build
 * time instead.
 */
import { describe, expect, it } from 'vitest';
import { commandPayload } from '../../apps/bot/src/commands/index.js';

const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;

/** Records every place a required option follows an optional one, recursing into subcommands. */
function findViolations(options, path, out) {
  let sawOptional = false;
  for (const option of options) {
    if (option.type === SUB_COMMAND || option.type === SUB_COMMAND_GROUP) continue;
    if (option.required === true && sawOptional) {
      out.push(`${path} > ${option.name}: required option placed after an optional one`);
    }
    if (option.required !== true) sawOptional = true;
  }

  for (const option of options) {
    if (option.type === SUB_COMMAND || option.type === SUB_COMMAND_GROUP) {
      findViolations(option.options ?? [], `${path} ${option.name}`, out);
    }
  }
}

describe('slash command option ordering', () => {
  it('places every required option before the optional ones (guards against Discord 50035)', () => {
    const violations = [];
    for (const command of commandPayload()) {
      findViolations(command.options ?? [], `/${command.name}`, violations);
    }
    expect(violations).toEqual([]);
  });
});

/**
 * Template internal consistency.
 *
 * The setup templates are hand-edited - the community one is large - so the failure that
 * actually happens is a permission overwrite that names a role the template forgot to
 * define. The provisioning engine silently drops such an overwrite (it cannot resolve a
 * role id for it), so the channel would be created with the wrong permissions and nobody
 * would notice. This validates every template up front instead.
 */
import { describe, expect, it } from 'vitest';
import { buildCommunityTemplate, buildDepartmentTemplate } from '@frm/core';

const VALID_CHANNEL_TYPES = new Set(['text', 'voice', 'announcement', 'forum', 'stage']);

/** Returns a list of human-readable problems; an empty list means the template is sound. */
function findProblems(template) {
  const problems = [];
  const roleKeys = new Set();

  for (const role of template.roles) {
    if (!role.key) problems.push('a role is missing its key');
    else if (roleKeys.has(role.key)) problems.push(`duplicate role key: ${role.key}`);
    roleKeys.add(role.key);
    if (!role.name) problems.push(`role "${role.key}" is missing its name`);
  }

  for (const category of template.categories) {
    if (!category.name) problems.push('a category is missing its name');

    for (const overwrite of category.overwrites ?? []) {
      if (overwrite.role !== 'everyone' && !roleKeys.has(overwrite.role)) {
        problems.push(
          `category "${category.name}" grants to role "${overwrite.role}", which the template never defines`,
        );
      }
    }

    for (const channel of category.channels ?? []) {
      if (!channel.name) problems.push(`a channel in "${category.name}" is missing its name`);
      if (!VALID_CHANNEL_TYPES.has(channel.type)) {
        problems.push(`channel "${channel.name}" has an invalid type "${channel.type}"`);
      }
    }
  }

  return problems;
}

describe('template consistency', () => {
  it('the department template references only roles it defines', () => {
    expect(findProblems(buildDepartmentTemplate({ name: 'Test', tag: 'T' }))).toEqual([]);
  });

  it('the community template references only roles it defines', () => {
    expect(findProblems(buildCommunityTemplate({ name: 'Test' }))).toEqual([]);
  });
});

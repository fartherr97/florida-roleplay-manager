/**
 * Department template and provisioning plan.
 *
 * The template is the editable description of a department server; the planner turns it
 * into "what is missing" against the live server. The rule that matters is idempotency:
 * anything already present, matched by name, must plan as `exists`, never `create`.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCommunityTemplate,
  buildDepartmentTemplate,
  planDepartmentProvision,
} from '@frm/core';

describe('buildDepartmentTemplate', () => {
  it('prefixes role names with the tag and marks the member role as managed', () => {
    const template = buildDepartmentTemplate({ name: 'Test Dept', tag: 'TD' });

    expect(template.roles.map((role) => role.name)).toEqual([
      'TD Command',
      'TD Supervisor',
      'TD Member',
    ]);
    expect(template.managedRoleKey).toBe('member');
    expect(template.categories.length).toBeGreaterThan(0);
  });

  it('locks the Command category to command and supervisors only', () => {
    const template = buildDepartmentTemplate({ name: 'Test Dept', tag: 'TD' });
    const command = template.categories.find((category) => category.key === 'command');

    const everyone = command.overwrites.find((overwrite) => overwrite.role === 'everyone');
    expect(everyone.deny).toContain('ViewChannel');
    expect(command.overwrites.some((overwrite) => overwrite.role === 'command')).toBe(true);
  });
});

describe('buildCommunityTemplate', () => {
  it('has roles and categories but no platform-managed role of its own', () => {
    const template = buildCommunityTemplate({ name: 'Test Community' });

    expect(template.managedRoleKey).toBeNull();
    expect(template.roles.length).toBeGreaterThan(0);
    expect(template.categories.length).toBeGreaterThan(0);
  });

  it('plans every role and category as creatable on an empty server', () => {
    const template = buildCommunityTemplate({ name: 'Test Community' });
    const plan = planDepartmentProvision(template, [], []);
    expect(plan.toCreate.roles).toBe(template.roles.length);
    expect(plan.toCreate.categories).toBe(template.categories.length);
  });
});

describe('planDepartmentProvision', () => {
  const template = buildDepartmentTemplate({ name: 'Test Dept', tag: 'TD' });

  it('plans everything as create on an empty server', () => {
    const plan = planDepartmentProvision(template, [], []);

    expect(plan.roles.every((role) => role.action === 'create')).toBe(true);
    expect(plan.toCreate.roles).toBe(3);
    expect(plan.toCreate.categories).toBe(template.categories.length);
    expect(plan.toCreate.channels).toBe(
      template.categories.reduce((total, category) => total + category.channels.length, 0),
    );
  });

  it('skips a role that already exists, matched by name case-insensitively', () => {
    const plan = planDepartmentProvision(template, [{ id: 'r1', name: 'td member' }], []);

    const member = plan.roles.find((role) => role.key === 'member');
    expect(member.action).toBe('exists');
    expect(member.id).toBe('r1');
    expect(plan.toCreate.roles).toBe(2);
  });

  it('skips an existing category and the channels already inside it', () => {
    const existingChannels = [
      { id: 'cat-info', name: '📋 Information', type: 'category', parentId: null },
      { id: 'ch-welcome', name: 'welcome', type: 'text', parentId: 'cat-info' },
    ];

    const plan = planDepartmentProvision(template, [], existingChannels);
    const information = plan.categories.find((category) => category.key === 'information');

    expect(information.action).toBe('exists');
    expect(information.channels.find((channel) => channel.name === 'welcome').action).toBe(
      'exists',
    );
    expect(information.channels.find((channel) => channel.name === 'rules').action).toBe('create');
  });
});

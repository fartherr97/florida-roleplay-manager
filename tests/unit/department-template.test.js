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
    const template = buildDepartmentTemplate({ name: 'HCSO', tag: 'HCSO' });

    expect(template.managedRoleKey).toBe('member');
    expect(template.roles.every((role) => role.name.startsWith('HCSO | '))).toBe(true);
    expect(template.roles.find((role) => role.key === 'member').name).toBe(
      'HCSO | Department Member',
    );
  });

  it('adjusts rank titles per agency', () => {
    const hcso = buildDepartmentTemplate({ name: 'HCSO', tag: 'HCSO' });
    const fhp = buildDepartmentTemplate({ name: 'FHP', tag: 'FHP' });

    expect(hcso.roles.find((role) => role.key === 'agency-head').name).toBe('HCSO | Sheriff');
    expect(fhp.roles.find((role) => role.key === 'agency-head').name).toBe('FHP | Colonel');
    // HCSO has a fourth-in-command (Colonel); FHP does not.
    expect(hcso.roles.some((role) => role.key === 'fourth-in-command')).toBe(true);
    expect(fhp.roles.some((role) => role.key === 'fourth-in-command')).toBe(false);
  });

  it('locks the command-staff category to command and above', () => {
    const template = buildDepartmentTemplate({ name: 'HCSO', tag: 'HCSO' });
    const command = template.categories.find((category) => category.key === 'command-staff');

    const everyone = command.overwrites.find((overwrite) => overwrite.role === 'everyone');
    expect(everyone.deny).toContain('ViewChannel');
    expect(command.overwrites.some((overwrite) => overwrite.role === 'command')).toBe(true);
  });

  it('rejects an unsupported department tag', () => {
    expect(() => buildDepartmentTemplate({ name: 'X', tag: 'XYZ' })).toThrow(/unsupported/i);
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
  const template = buildDepartmentTemplate({ name: 'HCSO', tag: 'HCSO' });

  it('plans everything as create on an empty server', () => {
    const plan = planDepartmentProvision(template, [], []);

    expect(plan.roles.every((role) => role.action === 'create')).toBe(true);
    expect(plan.toCreate.roles).toBe(template.roles.length);
    expect(plan.toCreate.categories).toBe(template.categories.length);
    expect(plan.toCreate.channels).toBe(
      template.categories.reduce((total, category) => total + category.channels.length, 0),
    );
  });

  it('skips a role that already exists, matched by name case-insensitively', () => {
    const plan = planDepartmentProvision(
      template,
      [{ id: 'r1', name: 'hcso | department member' }],
      [],
    );

    const member = plan.roles.find((role) => role.key === 'member');
    expect(member.action).toBe('exists');
    expect(member.id).toBe('r1');
    expect(plan.toCreate.roles).toBe(template.roles.length - 1);
  });

  it('skips an existing category and the channels already inside it', () => {
    const existingChannels = [
      { id: 'cat-info', name: 'HCSO | Information', type: 'category', parentId: null },
      { id: 'ch-rules', name: 'rules', type: 'text', parentId: 'cat-info' },
    ];

    const plan = planDepartmentProvision(template, [], existingChannels);
    const information = plan.categories.find((category) => category.key === 'information');

    expect(information.action).toBe('exists');
    expect(information.channels.find((channel) => channel.name === 'rules').action).toBe('exists');
    expect(information.channels.find((channel) => channel.name === 'announcements').action).toBe(
      'create',
    );
  });
});

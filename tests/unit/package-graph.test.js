/**
 * Package dependency hygiene.
 *
 * The specification forbids circular package dependencies. ESLint's `import/no-cycle`
 * catches cycles between *modules*; this catches them between *packages*, which is the
 * level at which they are painful to unwind later.
 *
 * It also checks that every `@frm/*` import a package makes is actually declared in its
 * own package.json - npm workspaces hoist everything into one `node_modules`, so an
 * undeclared dependency works locally and then breaks the moment the package is built or
 * deployed on its own.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

/** Reads every workspace package.json. */
function readWorkspaces() {
  const packages = new Map();
  for (const group of ['packages', 'apps']) {
    const base = join(ROOT, group);
    for (const name of readdirSync(base)) {
      const manifestPath = join(base, name, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      packages.set(manifest.name, {
        name: manifest.name,
        dir: join(base, name),
        dependencies: Object.keys({
          ...(manifest.dependencies ?? {}),
          ...(manifest.devDependencies ?? {}),
        }).filter((dependency) => dependency.startsWith('@frm/')),
      });
    }
  }
  return packages;
}

/** Every `@frm/*` specifier imported by the source of a package. */
function importedPackages(dir) {
  const found = new Set();
  const pattern = /from\s+'(@frm\/[a-z-]+)(?:\/[a-z-]+)?'/g;

  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.js')) {
        const source = readFileSync(full, 'utf8');
        for (const match of source.matchAll(pattern)) found.add(match[1]);
      }
    }
  };

  try {
    walk(join(dir, 'src'));
  } catch {
    // A package without a src directory imports nothing.
  }
  return found;
}

const workspaces = readWorkspaces();

describe('workspace dependency graph', () => {
  it('has no circular dependencies between packages', () => {
    const cycles = [];
    const state = new Map(); // 'visiting' | 'done'

    const visit = (name, path) => {
      if (state.get(name) === 'done') return;
      if (state.get(name) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(name)), name].join(' -> '));
        return;
      }

      state.set(name, 'visiting');
      for (const dependency of workspaces.get(name)?.dependencies ?? []) {
        if (workspaces.has(dependency)) visit(dependency, [...path, name]);
      }
      state.set(name, 'done');
    };

    for (const name of workspaces.keys()) visit(name, []);

    expect(cycles).toEqual([]);
  });

  it('declares every internal package it imports', () => {
    const undeclared = [];

    for (const workspace of workspaces.values()) {
      const declared = new Set(workspace.dependencies);
      for (const imported of importedPackages(workspace.dir)) {
        if (imported !== workspace.name && !declared.has(imported)) {
          undeclared.push(`${workspace.name} imports ${imported} without declaring it`);
        }
      }
    }

    expect(undeclared).toEqual([]);
  });

  it('keeps the applications out of each other', () => {
    // apps are leaves: bot, api and worker share code through packages/core, never by
    // importing one another.
    for (const [name, workspace] of workspaces) {
      if (!name.match(/^@frm\/(bot|api|worker)$/)) continue;
      const appDependencies = workspace.dependencies.filter((dependency) =>
        dependency.match(/^@frm\/(bot|api|worker)$/),
      );
      expect(appDependencies, `${name} depends on another app`).toEqual([]);
    }
  });

  it('keeps shared at the bottom of the graph', () => {
    // @frm/shared is imported by everything, so it must import nothing internal itself.
    expect(workspaces.get('@frm/shared').dependencies).toEqual([]);
  });
});

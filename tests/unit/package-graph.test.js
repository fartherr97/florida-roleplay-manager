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

/**
 * Every named `@frm/*` import resolves to a real export.
 *
 * A missing export is only discovered when the importing module is first loaded, which
 * for an application entry point means "in production, at startup". The unit suite never
 * imports those files (and the integration suite mocks them), so nothing else in the test
 * suite would notice. This checks the whole workspace statically instead.
 */
describe('internal imports resolve', () => {
  /** Named specifiers imported from `@frm/*` in one file: [package, name, file, line]. */
  function namedImports(file) {
    const source = readFileSync(file, 'utf8');
    const results = [];
    const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(@frm\/[a-z-]+)'/g;

    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      for (const raw of match[1].split(',')) {
        // `import { a as b }` binds b locally but requires the export named a.
        const name = raw
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (name) results.push({ pkg: match[2], name, file, line });
      }
    }
    return results;
  }

  function sourceFiles(dir) {
    const files = [];
    const walk = (current) => {
      for (const entry of readdirSync(current)) {
        const full = join(current, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.js')) files.push(full);
      }
    };
    try {
      walk(dir);
    } catch {
      // Nothing to walk.
    }
    return files;
  }

  it('imports only names the target package actually exports', async () => {
    // Only the libraries are imported here. An app's entry point *runs* the process on
    // import, so loading one would start a Discord client rather than list its exports —
    // and nothing imports an app anyway (the test above enforces that).
    const exportsByPackage = new Map();
    for (const [name, workspace] of workspaces) {
      if (!workspace.dir.startsWith(join(ROOT, 'packages'))) continue;
      exportsByPackage.set(name, new Set(Object.keys(await import(name))));
    }

    const broken = [];
    for (const workspace of workspaces.values()) {
      for (const file of sourceFiles(join(workspace.dir, 'src'))) {
        for (const { pkg, name, line } of namedImports(file)) {
          const available = exportsByPackage.get(pkg);
          if (available && !available.has(name)) {
            broken.push(`${file.replace(ROOT + '/', '')}:${line} imports { ${name} } from ${pkg}`);
          }
        }
      }
    }

    expect(broken).toEqual([]);
  });
});

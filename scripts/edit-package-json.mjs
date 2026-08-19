#!/usr/bin/env node
/**
 * edit-package-json.mjs — add or remove the dsh-llm-approver bundle + dependency
 * in a dsh profile's package.json. Shared by scripts/install.sh and
 * scripts/uninstall.sh. Prints "changed" or "unchanged".
 *
 * Usage:
 *   node edit-package-json.mjs <package.json> add    <bundle> <depSpec>
 *   node edit-package-json.mjs <package.json> remove <bundle>
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , pkgPath, action, bundle, depSpec] = process.argv;

if (!pkgPath || (action !== 'add' && action !== 'remove') || !bundle) {
  console.error('usage: edit-package-json.mjs <package.json> <add|remove> <bundle> [depSpec]');
  process.exit(2);
}
if (action === 'add' && !depSpec) {
  console.error('add requires a dependency spec, e.g. github:Xpectuer/dsh-llm-approver');
  process.exit(2);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (error) {
  console.error(`cannot read ${pkgPath}: ${error.message}`);
  process.exit(1);
}

pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
pkg.dependencies ??= {};

let changed = false;

if (action === 'add') {
  if (!pkg.dsh.profile.bundles.includes(bundle)) {
    pkg.dsh.profile.bundles.push(bundle);
    changed = true;
  }
  if (pkg.dependencies[bundle] !== depSpec) {
    pkg.dependencies[bundle] = depSpec;
    changed = true;
  }
} else {
  const index = pkg.dsh.profile.bundles.indexOf(bundle);
  if (index !== -1) {
    pkg.dsh.profile.bundles.splice(index, 1);
    changed = true;
  }
  if (pkg.dependencies[bundle] !== undefined) {
    delete pkg.dependencies[bundle];
    changed = true;
  }
}

if (changed) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('changed');
} else {
  console.log('unchanged');
}

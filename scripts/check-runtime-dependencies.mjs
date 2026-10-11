import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Local regression guard for the runtime advisories reviewed on 2026-10-11.
// This checks known version floors; it is not a fresh vulnerability audit.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const floors = {
  react: '19.2.8',
  'react-dom': '19.2.8',
  'react-server-dom-webpack': '19.2.8',
  next: '16.4.0',
  sharp: '0.35.5',
};

function stableParts(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/, `Review non-stable runtime version: ${version}`);
  return version.split('.').map(Number);
}

function atLeast(actual, floor) {
  const a = stableParts(actual);
  const b = stableParts(floor);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

const reactVersion = pkg.dependencies.react;
for (const name of ['react', 'react-dom', 'react-server-dom-webpack']) {
  assert.equal(pkg.dependencies[name], reactVersion, `${name} must be a matching production dependency`);
  assert.equal(lock.packages[''].dependencies[name], reactVersion, `${name} manifest/lock mismatch`);
  assert.notEqual(lock.packages[`node_modules/${name}`]?.dev, true, `${name} is deployed at runtime`);
}

let checkedCopies = 0;
for (const [name, floor] of Object.entries(floors)) {
  const copies = Object.entries(lock.packages).filter(([path]) =>
    path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`));
  assert.ok(copies.length > 0, `Missing runtime dependency: ${name}`);
  for (const [path, entry] of copies) {
    assert.ok(atLeast(entry.version, floor), `${path}@${entry.version} is below reviewed floor ${floor}`);
    checkedCopies++;
  }
}

console.log(JSON.stringify({
  passed: true,
  check: 'Local guard against known runtime dependency regressions',
  reactVersion,
  checkedCopies,
  freshVulnerabilityAudit: false,
}));

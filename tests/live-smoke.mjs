// Explicit operational check. Not included in npm test: it makes two paid AI calls.
// Secrets are supplied through hidden stdin, never command arguments or files.
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

async function input() {
  return new Promise((resolve, reject) => {
    let value = '';
    const tty = process.stdin.isTTY;
    if (tty) process.stdin.setRawMode(true);
    process.stderr.write('Ready for smoke-test JSON on stdin (input is hidden).\n');
    const done = () => {
      process.stdin.off('data', data); process.stdin.pause();
      if (tty) process.stdin.setRawMode(false);
      try { resolve(JSON.parse(value)); } catch { reject(new Error('Invalid test configuration')); }
    };
    const data = chunk => { value += chunk; if (value.length > 32_000) reject(new Error('Test configuration too large')); else if (value.includes('\n')) done(); };
    process.stdin.setEncoding('utf8'); process.stdin.on('data', data); process.stdin.resume();
  });
}

const config = await input();
const base = new URL(config.url).origin;
const headers = { 'Content-Type': 'application/json', Origin: base, Authorization: `Bearer ${config.accessToken}`, ...(config.bypass ? { 'OAI-Sites-Authorization': `Bearer ${config.bypass}` } : {}) };
const call = (path, method = 'GET', body, extra = {}) => fetch(base + path, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(path === '/api/scan' ? 180_000 : 45_000) });
const digest = value => createHash('sha256').update(value).digest('hex');
const report = (step, result) => console.log(JSON.stringify({ step, ...result }));
const okJson = async (response, step) => {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${step}: HTTP ${response.status}, code ${typeof body?.code === 'string' ? body.code : 'UNKNOWN'}`);
  return body;
};
let id;
let owner;
try {
  const health = await okJson(await call('/api/health'), 'health');
  report('health', health);
  assert.equal(health.recognitionReady, true);
  assert.equal(health.storageMode, 'cloud');
  assert.ok(health.ownerId);
  owner = { 'X-Jemiq-Owner': health.ownerId };
  const settings = await okJson(await call('/api/settings'), 'settings');
  assert.equal(settings.configured, true);
  report('settings', { configured: settings.configured, model: settings.model, source: settings.source });
  const check = await okJson(await call('/api/vision/check', 'POST', {}), 'vision check');
  assert.equal(check.ready, true); report('vision-check', { passed: true });

  const data = (await readFile(new URL('./fixtures/synthetic-cover.png', import.meta.url))).toString('base64');
  const started = Date.now();
  const response = await call('/api/scan', 'POST', { mode: 'table', image: { data, mimeType: 'image/png' } });
  assert.equal(response.status, 200, `scan: HTTP ${response.status}`);
  const events = (await response.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const failure = events.find(event => event.type === 'error');
  if (failure) throw new Error(`scan: ${failure.code}`);
  assert.equal(events.at(-1)?.type, 'done');
  const books = events.filter(event => event.type === 'book').map(event => event.book);
  assert.ok(books.some(book => /pride/i.test(book.title) && /prejudice/i.test(book.title) && book.authors.some(author => /austen/i.test(author))));
  assert.ok(books.every(book => book.isbn13 === null), 'The synthetic cover has no ISBN');
  report('scan', { passed: true, durationMs: Date.now() - started, input: 'synthetic-cover.png', books: books.map(book => ({ title: book.title, authors: book.authors, isbn: book.isbn13, status: book.status, notes: book.notes })), warnings: events.at(-1).warnings });

  id = randomUUID();
  const now = new Date().toISOString();
  const catalog = { id, name: 'Collaudo temporaneo — immagine sintetica', mode: 'table', createdAt: now, updatedAt: now, image: `data:image/png;base64,${data}`, books, warnings: events.at(-1).warnings, isDemo: true };
  const saved = (await okJson(await call(`/api/catalogs/${id}`, 'PUT', { catalog, expectedUpdatedAt: null }, owner), 'create catalog')).catalog;
  const list = await okJson(await call('/api/catalogs', 'GET', undefined, owner), 'list');
  assert.equal(list.catalogs.find(item => item.id === id)?.image, null);
  const detail = (await okJson(await call(`/api/catalogs/${id}`, 'GET', undefined, owner), 'read catalog')).catalog;
  assert.equal(digest(detail.image), digest(catalog.image));
  const changed = { ...saved, name: 'Collaudo temporaneo aggiornato', image: null };
  const updated = (await okJson(await call(`/api/catalogs/${id}`, 'PUT', { catalog: changed, expectedUpdatedAt: saved.updatedAt, preservePhoto: true }, owner), 'update catalog')).catalog;
  assert.notEqual(updated.updatedAt, saved.updatedAt);
  const preserved = (await okJson(await call(`/api/catalogs/${id}`, 'GET', undefined, owner), 'preserved photo')).catalog;
  assert.equal(digest(preserved.image), digest(catalog.image));
  assert.equal((await call(`/api/catalogs/${id}`, 'PUT', { catalog: changed, expectedUpdatedAt: saved.updatedAt, preservePhoto: true }, owner)).status, 409);
  assert.equal((await call(`/api/catalogs/${id}`, 'PUT', { catalog: changed }, owner)).status, 400);
  assert.equal((await call(`/api/catalogs/${id}`, 'GET', undefined, { 'X-Jemiq-Owner': 'a-different-owner' })).status, 403);
  report('persistence', { passed: true, photoRoundTrip: true, revisionConflict: true, ownerIsolation: true });
} catch (error) {
  report('failure', { error: error instanceof Error ? error.message : 'Operational check failed' });
  process.exitCode = 1;
} finally {
  if (id && owner) {
    const removed = await call(`/api/catalogs/${id}`, 'DELETE', undefined, owner).catch(() => null);
    const missing = removed?.status === 204 ? await call(`/api/catalogs/${id}`, 'GET', undefined, owner).catch(() => null) : null;
    const clean = removed?.status === 204 && missing?.status === 404;
    report('cleanup', { passed: clean });
    if (!clean) process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// what the code actually does with it.
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SESSION_KEYS } from '../src/session.js';

const root = new URL('..', import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('gladys-assistant-integration.json', root), 'utf8'),
);
const indexSource = await readFile(new URL('index.js', root), 'utf8');

const fieldsByKey = new Map(manifest.config_schema.map((field) => [field.key, field]));

test('the account field is the whole configuration: nothing for the user to type', () => {
  // Everything else — the region, the robots, their local keys, their IPs — is
  // discovered. A field that asked for any of it would be a bug.
  assert.equal(manifest.config_schema.length, 1);
  const [field] = manifest.config_schema;
  assert.equal(field.key, 'xiaomi_account');
  assert.ok(['oauth2', 'account_link'].includes(field.type), `unexpected type ${field.type}`);
  assert.ok(field.label.en, 'the account field needs an English label');
});

test('the code never reads the value of the account field', () => {
  // its value IS the Connect flow; the session lives off-schema
  assert.equal(indexSource.includes('.xiaomi_account'), false);
});

test('the session keys stay OUT of the config_schema', () => {
  // They are integration-managed state persisted through setConfig(). Declaring
  // one would render it as a form field, and the server would then refuse the
  // integration's own write.
  Object.values(SESSION_KEYS).forEach((key) => {
    assert.equal(
      fieldsByKey.has(key),
      false,
      `session key "${key}" must not be declared in the config_schema`,
    );
  });
});

test('no action is declared, and none is handled', () => {
  // The account link needs no button beyond Connect, and nothing else is
  // manual: a declared action with no handler would fail silently for the user.
  const declared = (manifest.actions ?? []).map((action) => action.key).sort();
  const handled = [...indexSource.matchAll(/gladys\.onAction\('([^']+)'/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(declared, handled);
});

test('the docker image tag matches the manifest version', () => {
  assert.equal(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    true,
    `docker_image "${manifest.docker_image}" does not end with the version ${manifest.version}`,
  );
});

test('the cover image exists in the repository, at the size the store expects', async () => {
  const fileName = manifest.cover_image.split('/').pop();
  const cover = await readFile(new URL(fileName, root));
  const sof = cover.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0, 'no JPEG SOF0 marker found in the cover');
  assert.equal(cover.readUInt16BE(sof + 7), 800, 'cover width must be 800');
  assert.equal(cover.readUInt16BE(sof + 5), 534, 'cover height must be 534');
});

// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// what the code actually does with it.
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SESSION_KEYS } from '../src/session.js';
import { MAP_WIDGET_KEY, WIDGET_ACTIONS } from '../src/devices/mapWidget.js';
import { SCENE_ACTIONS } from '../src/devices/sceneActions.js';
import {
  SCENE_TRIGGERS,
  computeSceneEvents,
  snapshotFromStatus,
} from '../src/devices/sceneTriggers.js';

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
  // NOT oauth2: Gladys opens an oauth2 sign-in page with a Referer, and Xiaomi
  // rejects it (code 10012). Only an account_link one is opened with noreferrer.
  assert.equal(field.type, 'account_link');
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

test('both transports are declared, and the local preference is honored', () => {
  // The store tags the integration Local and Cloud from this field, and Gladys
  // renders its "Prefer the local connection" toggle only when both are there.
  assert.deepEqual([...manifest.transports].sort(), ['cloud', 'local']);
  assert.ok(
    indexSource.includes('GLADYS_PREFER_LOCAL'),
    'the toggle Gladys renders for a dual-transport integration must be read',
  );
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

test('the scene triggers declared are exactly the ones the code fires', () => {
  const declared = manifest.scene_triggers.map((trigger) => trigger.key).sort();
  assert.deepEqual(declared, Object.values(SCENE_TRIGGERS).sort());
});

test('every variable a scene event carries is declared on its trigger', () => {
  // Fire every trigger at once, then check each payload against the manifest:
  // an undeclared variable is invisible to the scene author.
  const variablesByKey = new Map(
    manifest.scene_triggers.map((trigger) => [
      trigger.key,
      new Set(['vacuum', ...trigger.variables.map((variable) => variable.key)]),
    ]),
  );
  // One cleaning, start to finish, crossing every threshold on the way.
  const worn = { filter: 5, mainBrush: 50, sideBrush: 50, sensor: 50 };
  const fresh = { filter: 50, mainBrush: 50, sideBrush: 50, sensor: 50 };
  const steps = [
    snapshotFromStatus({ state: 3, battery: 99 }, fresh),
    snapshotFromStatus({ state: 5, battery: 99 }, fresh),
    snapshotFromStatus({ state: 12, battery: 10, error_code: 2 }, worn),
    snapshotFromStatus({ state: 8, battery: 100 }, worn),
  ];
  const ctx = { vacuum: 'v', deviceName: 'n' };
  computeSceneEvents(null, steps[0], ctx);
  const events = steps
    .slice(1)
    .flatMap((snapshot, index) => computeSceneEvents(steps[index], snapshot, ctx));
  assert.deepEqual(
    [...new Set(events.map((event) => event.key))].sort(),
    Object.values(SCENE_TRIGGERS).sort(),
    'the sequence must fire every trigger',
  );
  events.forEach((event) => {
    const declared = variablesByKey.get(event.key);
    assert.ok(declared, `"${event.key}" is not declared`);
    Object.keys(event.data).forEach((key) =>
      assert.ok(declared.has(key), `"${event.key}" carries "${key}", which is not declared`),
    );
  });
});

test('the scene actions declared are exactly the ones handled', () => {
  const declared = manifest.scene_actions.map((action) => action.key).sort();
  assert.deepEqual(declared, Object.values(SCENE_ACTIONS).sort());
  Object.entries(SCENE_ACTIONS).forEach(([name, key]) => {
    assert.ok(
      indexSource.includes(`gladys.onSceneAction(SCENE_ACTIONS.${name},`),
      `scene action "${key}" has no handler`,
    );
  });
});

test('the map widget is declared, handled, and offers only known buttons', () => {
  assert.deepEqual(
    manifest.widgets.map((widget) => widget.key),
    [MAP_WIDGET_KEY],
  );
  assert.ok(indexSource.includes('gladys.onWidgetGet(MAP_WIDGET_KEY,'), 'no widget handler');
  assert.ok(indexSource.includes('gladys.onWidgetGetImage('), 'no widget image handler');
  const [widget] = manifest.widgets;
  ['action1', 'action2'].forEach((key) => {
    const setting = widget.settings.find((candidate) => candidate.key === key);
    assert.deepEqual(
      setting.options.map((option) => option.value).sort(),
      ['none', ...Object.keys(WIDGET_ACTIONS)].sort(),
      `the "${key}" options must match WIDGET_ACTIONS`,
    );
  });
});

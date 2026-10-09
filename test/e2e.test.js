// End-to-end test: boots the REAL integration process (index.js) against a
// fake Gladys host (WebSocket + REST), a fake Xiaomi cloud (HTTP: account login
// + Mi Home API) and a fake miIO device (UDP), then exercises the full flows:
// discovery, scan, poll and set-value commands over the local miIO transport.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { rc4, signedNonce } from '../src/xiaomi/miCrypto.js';
import { buildPacket, parsePacket } from '../src/xiaomi/miioPacket.js';
import {
  CLEAN_SUMMARY,
  CONSUMABLE,
  DID,
  MI_DEVICE,
  MI_HOME_ROOMS,
  MI_OTHER_DEVICE,
  ROOM_MAPPING,
  SSECURITY,
  STATUS,
  TOKEN_HEX,
} from './fixtures.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELECTOR = 'xiaomi-home-test';
const TOKEN = 'test-token';
const token = Buffer.from(TOKEN_HEX, 'hex');
const DEVICE_ID = Buffer.from('0a0b0c0d', 'hex');

async function waitUntil(predicate, what, timeoutMs = 15000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// --- Fake miIO device (UDP) --------------------------------------------------
function startFakeDevice() {
  const received = [];
  // mutable, so a test can move the robot to another state between two polls
  const robot = { status: { ...STATUS } };
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    if (msg.readUInt16BE(2) === 0x20) {
      socket.send(
        buildPacket({ deviceId: DEVICE_ID, ts: 1700000000, token }),
        rinfo.port,
        rinfo.address,
      );
      return;
    }
    const parsed = parsePacket(msg, token);
    const req = JSON.parse(parsed.payload.toString());
    received.push(req);
    const results = {
      get_status: [robot.status],
      get_consumable: [CONSUMABLE],
      get_clean_summary: CLEAN_SUMMARY,
      get_room_mapping: ROOM_MAPPING,
    };
    const result = results[req.method] || ['ok'];
    const payload = Buffer.from(JSON.stringify({ id: req.id, result }));
    socket.send(
      buildPacket({ deviceId: DEVICE_ID, ts: parsed.ts + 1, token, payload }),
      rinfo.port,
      rinfo.address,
    );
  });
  return new Promise((resolve) => {
    socket.bind(0, '127.0.0.1', () =>
      resolve({ socket, received, robot, port: socket.address().port }),
    );
  });
}

// --- Fake Xiaomi cloud (silent passToken login + Mi Home API) ----------------
// LOGIN_NONCE is deliberately a 19-digit integer, beyond Number.MAX_SAFE_INTEGER:
// the fake /sts below only hands out the serviceToken when the clientSign was
// built from every digit of it, so a JSON.parse precision regression fails here.
const LOGIN_NONCE = '8847478910111751168';

function startFakeXiaomi() {
  const key = (nonce) => Buffer.from(signedNonce(SSECURITY, nonce), 'base64');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const base = `http://127.0.0.1:${server.address().port}`;

      if (url.pathname === '/pass/serviceLogin') {
        // Silent re-login with the persisted passToken cookie.
        const cookies = req.headers.cookie || '';
        if (!cookies.includes('passToken=') || !cookies.includes('userId=')) {
          res.end(`&&&START&&&${JSON.stringify({ code: 87001, _sign: 'x' })}`);
          return;
        }
        res.end(
          `&&&START&&&{"code":0,"result":"ok","userId":12345,"cUserId":"cuser",` +
            `"passToken":"ptoken-rotated","ssecurity":"${SSECURITY}",` +
            `"nonce":${LOGIN_NONCE},"location":"${base}/sts?d=1&ticket=0"}`,
        );
      } else if (url.pathname === '/sts') {
        const expected = crypto
          .createHash('sha1')
          .update(`nonce=${LOGIN_NONCE}&${SSECURITY}`)
          .digest('base64');
        if (url.searchParams.get('clientSign') !== expected) {
          res.writeHead(200);
          res.end('ok'); // exactly what Xiaomi does: no cookie, no error
          return;
        }
        res.writeHead(200, { 'Set-Cookie': 'serviceToken=svc-token-123; Path=/' });
        res.end('ok');
      } else if (url.pathname === '/longPolling/login' && url.searchParams.get('lp') === '1') {
        // What Xiaomi answers once it has rejected the sign-in page (code 10012)
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>Invalid request</body></html>');
      } else if (url.pathname === '/longPolling/loginUrl') {
        // Shaped like the real answer: the sign-in URL carries ticket/dc/sid/ts.
        res.end(
          `&&&START&&&${JSON.stringify({
            lp: `${base}/longPolling/login?lp=1`,
            loginUrl: `${base}/longPolling/login?ticket=lp_42&dc=eu&sid=xiaomiio&ts=1700000000`,
            qr: `${base}/qr.png`,
            timeout: 300,
          })}`,
        );
      } else if (url.pathname === '/app/home/device_list') {
        const form = new URLSearchParams(body);
        const nonce = form.get('_nonce');
        const responseJson = JSON.stringify({ result: { list: [MI_DEVICE, MI_OTHER_DEVICE] } });
        res.end(rc4(key(nonce), Buffer.from(responseJson)).toString('base64'));
      } else if (url.pathname === '/app/v2/homeroom/gethome') {
        const form = new URLSearchParams(body);
        const nonce = form.get('_nonce');
        const responseJson = JSON.stringify({
          result: { homelist: [{ id: 'home-1', name: 'Maison', roomlist: MI_HOME_ROOMS }] },
        });
        res.end(rc4(key(nonce), Buffer.from(responseJson)).toString('base64'));
      } else if (url.pathname.startsWith('/app/home/rpc/')) {
        const form = new URLSearchParams(body);
        const nonce = form.get('_nonce');
        res.end(
          rc4(key(nonce), Buffer.from(JSON.stringify({ result: ['ok'] }))).toString('base64'),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// --- Fake Gladys host (REST + WebSocket) -------------------------------------
function startFakeGladys() {
  const state = {
    discoveredDevicePosts: [],
    statePosts: [],
    transportPosts: [],
    connectionStatusPosts: [],
    sceneEventPosts: [],
    commandResults: [],
    ws: null,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const respond = (json) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'GET' && req.url === '/api/integration/v1/device') {
        respond([]);
      } else if (req.method === 'GET' && req.url === '/api/integration/v1/config') {
        respond({
          config: {
            session_region: 'de',
            session_user_id: '12345',
            session_pass_token: 'ptoken',
            session_device_id: 'STABLEDEVICEID01',
          },
        });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/discovered_device') {
        state.discoveredDevicePosts.push(JSON.parse(body).devices);
        respond({ success: true, count: JSON.parse(body).devices.length });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/state') {
        state.statePosts.push(JSON.parse(body).states);
        respond({ success: true });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/connection_status') {
        state.connectionStatusPosts.push(JSON.parse(body));
        respond({ success: true });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/device/transport') {
        state.transportPosts.push(JSON.parse(body).transports);
        respond({ success: true });
      } else if (req.method === 'POST' && req.url === '/api/integration/v1/scene/event') {
        state.sceneEventPosts.push(JSON.parse(body));
        respond({ success: true });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    state.ws = ws;
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'authenticate.integration-request' && message.payload.token === TOKEN) {
        ws.send(JSON.stringify({ type: 'authentication.connected', payload: {} }));
      }
      if (message.type === 'external-integration.command-result') {
        state.commandResults.push(message.payload);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

test('the integration discovers, polls and controls a Xiaomi/Roborock robot', async (t) => {
  const device = await startFakeDevice();
  const xiaomi = await startFakeXiaomi();
  const gladys = await startFakeGladys();
  t.after(() => {
    device.socket.close();
    xiaomi.server.close();
    gladys.server.close();
  });

  let output = '';
  const child = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      GLADYS_HOST_API_URL: `http://127.0.0.1:${gladys.port}`,
      GLADYS_INTEGRATION_TOKEN: TOKEN,
      GLADYS_INTEGRATION_SELECTOR: SELECTOR,
      XIAOMI_ACCOUNT_HOST: `http://127.0.0.1:${xiaomi.port}`,
      XIAOMI_API_BASE: `http://127.0.0.1:${xiaomi.port}/app`,
      XIAOMI_REGIONS: 'de',
      MIIO_PORT: String(device.port),
      LOG_LEVEL: 'debug',
    },
  });
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  t.after(() => child.kill('SIGKILL'));

  const send = (type, payload) => gladys.state.ws.send(JSON.stringify({ type, payload }));

  await t.test('on connection: logs in and publishes the robot and its station', async () => {
    await waitUntil(
      () => gladys.state.discoveredDevicePosts.length >= 1,
      `initial discovery\n${output}`,
    );
    const devices = gladys.state.discoveredDevicePosts.at(-1);
    // the non-vacuum device is filtered out; the station is published on its own
    assert.equal(devices.length, 2);
    const robot = devices[0];
    assert.equal(robot.external_id, `ext:${SELECTOR}:vacuum:${DID}`);
    assert.equal(robot.name, 'Robot salon');
    assert.deepEqual(
      robot.features.map((f) => f.external_id.split(':').pop()),
      [
        'state',
        'run-mode',
        'clean-mode',
        'dock',
        'battery',
        'main-brush',
        'side-brush',
        'filter',
        'sensor-cleaning',
        'room',
        'last-clean-start',
        'cleaned-today',
      ],
    );

    // The segments come from the robot, their names from the account: the
    // selector is only useful when the two are joined.
    const room = robot.features.find((f) => f.external_id.endsWith(':room'));
    assert.deepEqual(
      room.supported_options.map(({ value, label }) => ({ value, label })),
      [
        { value: 'none', label: '—' },
        { value: '16', label: 'Cuisine' },
        { value: '17', label: 'Salon' },
      ],
    );

    const dock = devices[1];
    assert.equal(dock.external_id, `ext:${SELECTOR}:dock:${DID}`);
    assert.equal(dock.name, 'Robot salon - Dock');
    assert.equal(dock.model, 'Dock type 21');
    assert.deepEqual(
      dock.features.map((f) => f.external_id.split(':').pop()),
      ['dock-strainer', 'dock-cleaning-brush', 'dust-collection'],
    );
  });

  await t.test('the connection state is reported on its own (no manual check)', async () => {
    await waitUntil(
      () => gladys.state.connectionStatusPosts.length >= 1,
      `connection status\n${output}`,
    );
    const status = gladys.state.connectionStatusPosts.at(-1);
    assert.equal(status.connected, true);
    // No message: the badge is rendered next to the Xiaomi account, which is
    // exactly the one that is linked here, so it already says everything.
    assert.equal(status.message, undefined);
  });

  await t.test('a scan request republishes the robot', async () => {
    const before = gladys.state.discoveredDevicePosts.length;
    send('external-integration.scan-request', {});
    await waitUntil(
      () => gladys.state.discoveredDevicePosts.length > before,
      `scan republish\n${output}`,
    );
    assert.equal(gladys.state.discoveredDevicePosts.at(-1).length, 2);
  });

  await t.test('Connect returns the Xiaomi sign-in URL as is', async () => {
    // an account_link field: Gladys sends no redirect_uri and checks no state
    send('external-integration.oauth.get-authorize-url', {
      message_id: 'oauth-1',
      key: 'xiaomi_account',
    });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === 'oauth-1'),
      `authorize url ack\n${output}`,
    );
    const ack = gladys.state.commandResults.find((r) => r.message_id === 'oauth-1');
    assert.equal(ack.success, true, ack.error);

    assert.equal(
      ack.data.authorize_url,
      `http://127.0.0.1:${xiaomi.port}/longPolling/login?ticket=lp_42&dc=eu&sid=xiaomiio&ts=1700000000`,
    );
  });

  await t.test('a sign-in page rejected by Xiaomi is reported, not a crash', async () => {
    // The fake long poll answers like Xiaomi after a code 10012: an HTML page.
    await waitUntil(
      () =>
        gladys.state.connectionStatusPosts.some(
          (post) => post.connected === false && /rejected/.test(post.message?.en ?? ''),
        ),
      `rejection status\n${output}`,
    );
    assert.doesNotMatch(output, /SyntaxError/);
    assert.equal(child.exitCode, null, 'the integration is still running');
  });

  const pollDevice = {
    external_id: `ext:${SELECTOR}:vacuum:${DID}`,
    selector: `ext-${SELECTOR}-vacuum-${DID}`,
    params: [],
  };

  await t.test('a poll publishes the robot states over the local miIO transport', async () => {
    send('external-integration.device.poll', { message_id: 'poll-1', device: pollDevice });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === 'poll-1'),
      `poll ack\n${output}`,
    );
    const ack = gladys.state.commandResults.find((r) => r.message_id === 'poll-1');
    assert.equal(ack.success, true, ack.error);

    // STATUS: state=8 (charging->5), fan_power=102 (balanced->auto=0), battery=87.
    assert.deepEqual(gladys.state.statePosts.at(-1), [
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:state`, state: 5 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:run-mode`, state: 0 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:clean-mode`, state: 0 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:battery`, state: 87 },
      // CONSUMABLE, converted from time used to life remaining.
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:main-brush`, state: 50 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:side-brush`, state: 75 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:filter`, state: 90 },
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:sensor-cleaning`, state: 50 },
      // CLEAN_SUMMARY, in the bare-list shape of the S6: the newest record start.
      {
        device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:last-clean-start`,
        state: 1786961500,
      },
      // That start is not today.
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:cleaned-today`, state: 0 },
      // The robot is charging, not cleaning a segment: the selector is cleared.
      { device_feature_external_id: `ext:${SELECTOR}:vacuum:${DID}:room`, text: 'none' },
    ]);
    assert.ok(
      device.received.some((r) => r.method === 'get_status'),
      'get_status was sent to the device',
    );

    await waitUntil(() => gladys.state.transportPosts.length >= 1, `transport badge\n${output}`);
    assert.deepEqual(gladys.state.transportPosts.at(-1), [
      { device_external_id: `ext:${SELECTOR}:vacuum:${DID}`, transport: 'local' },
    ]);
  });

  await t.test('a dock command forwards app_charge to the device', async () => {
    send('external-integration.device.set-value', {
      message_id: 'set-1',
      device: pollDevice,
      device_feature: {
        external_id: `ext:${SELECTOR}:vacuum:${DID}:dock`,
        category: 'vacuum-cleaner',
        type: 'dock',
      },
      value: 1,
    });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === 'set-1'),
      `dock ack\n${output}`,
    );
    assert.equal(gladys.state.commandResults.find((r) => r.message_id === 'set-1').success, true);
    assert.ok(
      device.received.some((r) => r.method === 'app_charge'),
      'app_charge was sent',
    );
  });

  await t.test(
    'a clean-mode command forwards set_custom_mode with the fan-power code',
    async () => {
      send('external-integration.device.set-value', {
        message_id: 'set-2',
        device: pollDevice,
        device_feature: {
          external_id: `ext:${SELECTOR}:vacuum:${DID}:clean-mode`,
          category: 'vacuum-cleaner',
          type: 'clean-mode',
        },
        value: 2, // QUIET -> fan power 101
      });
      await waitUntil(
        () => gladys.state.commandResults.some((r) => r.message_id === 'set-2'),
        `clean ack\n${output}`,
      );
      assert.equal(gladys.state.commandResults.find((r) => r.message_id === 'set-2').success, true);
      const cmd = device.received.findLast((r) => r.method === 'set_custom_mode');
      assert.ok(cmd, 'set_custom_mode was sent');
      assert.deepEqual(cmd.params, [101]);
    },
  );

  await t.test('a poll of the station publishes its own maintenance states', async () => {
    send('external-integration.device.poll', {
      message_id: 'poll-dock',
      device: { external_id: `ext:${SELECTOR}:dock:${DID}` },
    });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === 'poll-dock'),
      `dock poll ack\n${output}`,
    );
    const ack = gladys.state.commandResults.find((r) => r.message_id === 'poll-dock');
    assert.equal(ack.success, true, ack.error);

    assert.deepEqual(gladys.state.statePosts.at(-1), [
      { device_feature_external_id: `ext:${SELECTOR}:dock:${DID}:dock-strainer`, state: 90 },
      { device_feature_external_id: `ext:${SELECTOR}:dock:${DID}:dock-cleaning-brush`, state: 90 },
      { device_feature_external_id: `ext:${SELECTOR}:dock:${DID}:dust-collection`, state: 90 },
    ]);
  });

  await t.test('picking a room forwards app_segment_clean for that segment', async () => {
    send('external-integration.device.set-value', {
      message_id: 'set-room',
      device: pollDevice,
      device_feature: {
        external_id: `ext:${SELECTOR}:vacuum:${DID}:room`,
        category: 'text',
        type: 'select',
      },
      value: '17',
    });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === 'set-room'),
      `room ack\n${output}`,
    );
    assert.equal(
      gladys.state.commandResults.find((r) => r.message_id === 'set-room').success,
      true,
    );
    const cmd = device.received.findLast((r) => r.method === 'app_segment_clean');
    assert.ok(cmd, 'app_segment_clean was sent');
    assert.deepEqual(cmd.params, [{ segments: [17] }]);
  });

  await t.test('the empty option only clears the selection, it cleans nothing', async () => {
    const before = device.received.length;
    send('external-integration.device.set-value', {
      message_id: 'set-room-none',
      device: pollDevice,
      device_feature: {
        external_id: `ext:${SELECTOR}:vacuum:${DID}:room`,
        category: 'text',
        type: 'select',
      },
      value: 'none',
    });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === 'set-room-none'),
      `room clear ack\n${output}`,
    );
    assert.equal(
      gladys.state.commandResults.find((r) => r.message_id === 'set-room-none').success,
      true,
    );
    assert.deepEqual(device.received.slice(before), [], 'nothing was sent to the robot');
  });

  // --- Scenes -----------------------------------------------------------------
  const runSceneAction = async (messageId, key, fields) => {
    send('external-integration.scene-action.run', { message_id: messageId, key, fields });
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === messageId),
      `${key} ack\n${output}`,
    );
    return gladys.state.commandResults.find((r) => r.message_id === messageId);
  };

  await t.test('the start_cleaning scene action forwards app_start', async () => {
    const ack = await runSceneAction('scene-start', 'start_cleaning', {
      vacuum: pollDevice.external_id,
    });
    assert.equal(ack.success, true, ack.error);
    assert.ok(
      device.received.some((r) => r.method === 'app_start'),
      'app_start was sent',
    );
  });

  await t.test('the clean_rooms scene action resolves the room names', async () => {
    const ack = await runSceneAction('scene-rooms', 'clean_rooms', {
      vacuum: pollDevice.external_id,
      rooms: 'salon, Garage',
    });
    assert.equal(ack.success, true, ack.error);
    const cmd = device.received.findLast((r) => r.method === 'app_segment_clean');
    assert.deepEqual(cmd.params, [{ segments: [17] }]);
  });

  await t.test('the set_fan_power scene action sends the fan-power code', async () => {
    const ack = await runSceneAction('scene-fan', 'set_fan_power', {
      vacuum: pollDevice.external_id,
      mode: 'turbo',
    });
    assert.equal(ack.success, true, ack.error);
    const cmd = device.received.findLast((r) => r.method === 'set_custom_mode');
    assert.deepEqual(cmd.params, [103]);
  });

  await t.test('a scene action with no known room fails, and sends nothing', async () => {
    const before = device.received.length;
    const ack = await runSceneAction('scene-rooms-none', 'clean_rooms', {
      vacuum: pollDevice.external_id,
      rooms: 'Garage',
    });
    assert.equal(ack.success, false);
    assert.match(ack.error, /No known room matched/);
    assert.deepEqual(device.received.slice(before), []);
  });

  await t.test('a poll that sees the robot start cleaning fires the scene triggers', async () => {
    // The first poll above (charging) seeded the snapshot.
    device.robot.status = { ...STATUS, state: 5, in_cleaning: 1 };
    send('external-integration.device.poll', { message_id: 'poll-clean', device: pollDevice });
    await waitUntil(
      () => gladys.state.sceneEventPosts.some((e) => e.key === 'cleaning_started'),
      `cleaning_started event\n${output}`,
    );
    const vacuum = pollDevice.external_id;
    assert.deepEqual(
      gladys.state.sceneEventPosts.map((e) => e.key),
      ['cleaning_started', 'state_changed'],
    );
    assert.deepEqual(gladys.state.sceneEventPosts[0].data, { vacuum, device_name: DID });
    assert.deepEqual(gladys.state.sceneEventPosts[1].data, {
      vacuum,
      device_name: DID,
      state: 'Nettoyage',
      state_code: 5,
    });
  });

  await t.test('back at the dock: cleaning_finished and returned_to_dock', async () => {
    device.robot.status = { ...STATUS, clean_time: 1800, clean_area: 25000000 };
    const before = gladys.state.sceneEventPosts.length;
    send('external-integration.device.poll', { message_id: 'poll-docked', device: pollDevice });
    await waitUntil(
      () => gladys.state.sceneEventPosts.some((e) => e.key === 'returned_to_dock'),
      `returned_to_dock event\n${output}`,
    );
    const events = gladys.state.sceneEventPosts.slice(before);
    assert.deepEqual(
      events.map((e) => e.key),
      ['cleaning_finished', 'returned_to_dock', 'state_changed'],
    );
    assert.equal(events[0].data.duration_min, 30);
    assert.equal(events[0].data.area_m2, 25);
  });
});

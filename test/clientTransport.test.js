// The order in which the client tries the two transports, driven by the Gladys
// "Prefer the local connection" toggle. Both transports are stubbed: what is
// tested is the routing, not the protocols (see miioLocalTransport.test.js and
// e2e.test.js for those).

import test from 'node:test';
import assert from 'node:assert/strict';

import { XiaomiClient } from '../src/xiaomi/client.js';

const DUID = '123456789';

/**
 * A client whose cloud and local transports record the calls they receive.
 * @param {object} [options]
 * @param {boolean} [options.preferLocal] the user's preference
 * @param {boolean} [options.localFails] whether the local transport throws
 * @param {boolean} [options.cloudFails] whether the cloud RPC throws
 * @returns {{ client: XiaomiClient, calls: string[] }} the client and the call log
 */
function stubbedClient({ preferLocal = true, localFails = false, cloudFails = false } = {}) {
  const calls = [];
  const client = new XiaomiClient({}, { preferLocal });
  client.cloud = {
    isLoggedIn: () => true,
    async rpc() {
      calls.push('cloud');
      if (cloudFails) {
        throw new Error('cloud down');
      }
      return 'from-cloud';
    },
  };
  client.localTransports.set(DUID, {
    async request() {
      calls.push('local');
      if (localFails) {
        throw new Error('timeout');
      }
      return 'from-local';
    },
    disconnect() {},
  });
  return { client, calls };
}

test('local is tried first by default', async () => {
  const { client, calls } = stubbedClient();
  assert.equal(await client.sendCommand(DUID, 'get_status'), 'from-local');
  assert.deepEqual(calls, ['local']);
  assert.equal(client.getLastTransport(DUID), 'local');
});

test('local preferred but unreachable: falls back to the cloud', async () => {
  const { client, calls } = stubbedClient({ localFails: true });
  assert.equal(await client.sendCommand(DUID, 'get_status'), 'from-cloud');
  assert.deepEqual(calls, ['local', 'cloud']);
  assert.equal(client.getLastTransport(DUID), 'cloud');
});

test('local not preferred: the cloud is tried first', async () => {
  const { client, calls } = stubbedClient({ preferLocal: false });
  assert.equal(await client.sendCommand(DUID, 'get_status'), 'from-cloud');
  assert.deepEqual(calls, ['cloud']);
  assert.equal(client.getLastTransport(DUID), 'cloud');
});

test('local not preferred but the cloud fails: falls back to local', async () => {
  const { client, calls } = stubbedClient({ preferLocal: false, cloudFails: true });
  assert.equal(await client.sendCommand(DUID, 'get_status'), 'from-local');
  assert.deepEqual(calls, ['cloud', 'local']);
  assert.equal(client.getLastTransport(DUID), 'local');
});

test('the preference can change without rebuilding the client', async () => {
  const { client, calls } = stubbedClient();
  client.setPreferLocal(false);
  await client.sendCommand(DUID, 'get_status');
  client.setPreferLocal(true);
  await client.sendCommand(DUID, 'get_status');
  assert.deepEqual(calls, ['cloud', 'local']);
});

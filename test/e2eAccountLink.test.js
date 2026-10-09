// End-to-end test of the account link on an UNLINKED integration, against a
// Xiaomi that is slow to hand out a sign-in page — as seen in production, where
// it took 5.1 s while Gladys gives up on the Connect answer after about 5 s.
//
// Boots the real index.js against a fake Gladys host and a fake Xiaomi account
// host, then checks that Connect answers at once with a page prepared
// beforehand, and that clicking again never starts a second long poll (two
// polls on one session make Xiaomi reject it).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELECTOR = 'xiaomi-home-link-test';
const TOKEN = 'test-token';
// slower than the ~5 s Gladys waits for the Connect answer
const SIGN_IN_PAGE_DELAY_MS = 6000;
// what the core allows before failing the Connect button
const GLADYS_DEADLINE_MS = 5000;

async function waitUntil(predicate, what, timeoutMs = 20000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// --- Fake Xiaomi account host: slow sign-in page, counted long polls ----------
function startFakeXiaomi() {
  const state = { pagesHandedOut: 0, activePolls: 0, maxActivePolls: 0, polls: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const base = `http://127.0.0.1:${server.address().port}`;
    if (url.pathname === '/longPolling/loginUrl') {
      setTimeout(() => {
        state.pagesHandedOut += 1;
        const n = state.pagesHandedOut;
        res.end(
          `&&&START&&&${JSON.stringify({
            lp: `${base}/longPolling/login?lp=${n}`,
            loginUrl: `${base}/longPolling/login?ticket=lp_${n}`,
            qr: `${base}/qr.png`,
            timeout: 300,
          })}`,
        );
      }, SIGN_IN_PAGE_DELAY_MS);
    } else if (url.pathname === '/longPolling/login' && url.searchParams.has('lp')) {
      // nobody approves: each leg ends empty after a while, like the real one
      state.polls += 1;
      state.activePolls += 1;
      state.maxActivePolls = Math.max(state.maxActivePolls, state.activePolls);
      setTimeout(() => {
        state.activePolls -= 1;
        res.end('&&&START&&&{"code":0}');
      }, 300);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

// --- Fake Gladys host, with no stored session ---------------------------------
function startFakeGladys() {
  const state = { commandResults: [], connectionStatusPosts: [], ws: null };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/api/integration/v1/device') {
        res.end('[]');
      } else if (req.method === 'GET' && req.url === '/api/integration/v1/config') {
        res.end(JSON.stringify({ config: {} }));
      } else {
        if (req.url === '/api/integration/v1/connection_status') {
          state.connectionStatusPosts.push(JSON.parse(body));
        }
        res.end('{"success":true}');
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
        state.commandResults.push({ ...message.payload, receivedAt: Date.now() });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

test('Connect answers within the Gladys deadline, with a single long poll', async (t) => {
  const xiaomi = await startFakeXiaomi();
  const gladys = await startFakeGladys();
  t.after(() => {
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
      XIAOMI_REGIONS: 'de',
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

  const connect = async (messageId) => {
    const sentAt = Date.now();
    gladys.state.ws.send(
      JSON.stringify({
        type: 'external-integration.oauth.get-authorize-url',
        payload: { message_id: messageId, key: 'xiaomi_account' },
      }),
    );
    await waitUntil(
      () => gladys.state.commandResults.some((r) => r.message_id === messageId),
      `Connect answer\n${output}`,
    );
    const ack = gladys.state.commandResults.find((r) => r.message_id === messageId);
    return { ack, elapsedMs: ack.receivedAt - sentAt };
  };

  await t.test('the sign-in page is prepared as soon as the account shows unlinked', async () => {
    await waitUntil(() => xiaomi.state.pagesHandedOut === 1, `prepared page\n${output}`);
  });

  await t.test('Connect then answers at once with that page', async () => {
    const { ack, elapsedMs } = await connect('connect-1');
    assert.equal(ack.success, true, ack.error);
    assert.equal(
      ack.data.authorize_url,
      `http://127.0.0.1:${xiaomi.port}/longPolling/login?ticket=lp_1`,
    );
    assert.ok(
      elapsedMs < GLADYS_DEADLINE_MS / 5,
      `answered in ${elapsedMs} ms, Gladys gives up after ${GLADYS_DEADLINE_MS} ms`,
    );
    assert.equal(xiaomi.state.pagesHandedOut, 1, 'no new page was asked for');
  });

  await t.test('clicking again hands out the same page, and starts no second poll', async () => {
    await waitUntil(() => xiaomi.state.polls >= 2, `long poll running\n${output}`);
    const { ack, elapsedMs } = await connect('connect-2');
    assert.equal(ack.success, true, ack.error);
    assert.equal(
      ack.data.authorize_url,
      `http://127.0.0.1:${xiaomi.port}/longPolling/login?ticket=lp_1`,
    );
    assert.ok(elapsedMs < GLADYS_DEADLINE_MS / 5, `answered in ${elapsedMs} ms`);
    const pollsBefore = xiaomi.state.polls;
    await waitUntil(() => xiaomi.state.polls >= pollsBefore + 4, `more poll legs\n${output}`);
    assert.equal(xiaomi.state.maxActivePolls, 1, 'never two long polls at once');
    assert.equal(xiaomi.state.pagesHandedOut, 1);
  });

  await t.test('saving the config does not drop the page being approved', async () => {
    gladys.state.ws.send(
      JSON.stringify({
        type: 'external-integration.config-updated',
        payload: { config: { GLADYS_PREFER_LOCAL: false } },
      }),
    );
    const pollsBefore = xiaomi.state.polls;
    await waitUntil(() => xiaomi.state.polls >= pollsBefore + 3, `poll continues\n${output}`);
    assert.doesNotMatch(output, /onConfigUpdated -> reconnecting/);
    assert.equal(xiaomi.state.pagesHandedOut, 1, 'the page was kept');
    assert.equal(xiaomi.state.maxActivePolls, 1);
  });
});

// -----------------------------------------------------------------------------
// Entry point of the Gladys Xiaomi Home external integration.
//
//   - controls the ROBOT VACUUMS of a Xiaomi Home (Mi Home) account. A robot
//     paired in the ROBOROCK app answers on another cloud entirely and is served
//     by its own integration;
//   - links the account ONCE, through the Xiaomi QR sign-in the user approves,
//     persists the session, then reconnects silently on every start;
//   - publishes the account robots as discovered devices (each robot exposes
//     state / run-mode / clean-mode / dock / battery features);
//   - answers the polls of Gladys with the current robot status;
//   - forwards user commands to the robot over the LAN (encrypted miIO on UDP
//     54321), falling back to a Xiaomi cloud RPC when it is unreachable.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';

import {
  DOCK_SLUG,
  convertDevice,
  convertDockDevice,
  dockExternalIds,
  vacuumExternalIds,
} from './src/devices/convertDevice.js';
import {
  buildConsumableStates,
  buildDockStates,
  buildPollStates,
  buildSetCommand,
} from './src/devices/vacuum.js';
import {
  FEATURE_CODES,
  ROBOROCK_SEGMENT_CLEANING_STATES,
  ROOM_SELECTION_NONE,
} from './src/constants.js';
import { isSessionUsable, readSession, sameSession, sessionToConfig } from './src/session.js';
import { XiaomiClient } from './src/xiaomi/client.js';

const gladys = new GladysIntegration();

// There is NOTHING to configure: the region, the robots, their local keys and
// their IP addresses are all discovered. The session yielded by the one-time
// account link lives in off-schema config keys, so a restart never needs it
// again.
let session = readSession();
let xiaomi = new XiaomiClient(session);

// Robots for which a room clean has just been asked. `active` only turns true
// once the robot has actually been seen in a segment-cleaning state.
const roomCleanings = new Map();

// Lets a stale selection be cleared after a restart of the integration, without
// wiping a fresh selection before the robot has had time to start on it.
const initializedRoomSelectors = new Set();

/**
 * Build the room-selector feedback produced by a status change.
 *
 * The selector is reset only after a segment cleaning has actually been observed
 * and the robot has since left every segment-cleaning state.
 * @param {string} duid the device id
 * @param {object} ids external ids of the Gladys robot
 * @param {object} status get_status result
 * @param {boolean} hasRoomSelector whether the robot exposes rooms
 * @returns {object|null} a Gladys text state to publish, or null
 */
function buildRoomSelectionFeedback(duid, ids, status, hasRoomSelector) {
  if (!hasRoomSelector) {
    return null;
  }

  const robotState = Number(status && status.state);
  const isSegmentCleaning = ROBOROCK_SEGMENT_CLEANING_STATES.has(robotState);
  const trackedCleaning = roomCleanings.get(duid);

  if (isSegmentCleaning) {
    roomCleanings.set(duid, { active: true });
    initializedRoomSelectors.add(duid);
    return null;
  }

  const shouldReset = trackedCleaning?.active === true || !initializedRoomSelectors.has(duid);
  initializedRoomSelectors.add(duid);

  if (!shouldReset) {
    return null;
  }

  roomCleanings.delete(duid);

  return {
    device_feature_external_id: ids.feature(FEATURE_CODES.ROOM),
    text: ROOM_SELECTION_NONE,
  };
}

/**
 * Split a device external id (`ext:<selector>:vacuum:<did>`, built with
 * gladys.externalIds()) into its type slug and Xiaomi device id.
 * @param {string} externalId the device external id
 * @returns {{ slug: string, duid: string }} the parsed parts
 */
function parseExternalId(externalId) {
  const prefix = gladys.externalId('');
  if (!externalId || !externalId.startsWith(prefix)) {
    throw new Error(`Device external_id is invalid: "${externalId}" should start with "${prefix}"`);
  }
  const parts = externalId.slice(prefix.length).split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Device external_id is invalid: "${externalId}" should be "${prefix}<slug>:<did>"`,
    );
  }
  return { slug: parts[0], duid: parts[1] };
}

/**
 * Persist the session (off-schema config keys) so the next start reconnects
 * silently, without the interactive account link.
 */
async function persistSession() {
  const current = xiaomi.getSession();
  if (!current || !isSessionUsable(current)) {
    return;
  }
  session = current;
  try {
    await gladys.setConfig(sessionToConfig(current));
  } catch (err) {
    logger.error('Could not persist the Xiaomi session', err);
  }
}

/**
 * Report the connection state. Drives the live badge of the Configuration
 * screen — the user never has to check anything by hand.
 * @param {boolean} connected whether the account is linked and answering
 * @param {object} [message] a multi-language message, only when it adds something
 */
async function reportStatus(connected, message) {
  await gladys
    .setConnectionStatus(connected, message)
    .catch((err) => logger.error('Could not report the connection status', err));
}

/**
 * Reconnect with the linked account (silent passToken login). Returns false,
 * without throwing, when the account has not been linked yet.
 * @returns {Promise<boolean>} whether the connection succeeded
 */
async function connect() {
  await xiaomi.logout();
  if (!isSessionUsable(session)) {
    xiaomi = new XiaomiClient({});
    logger.warn('Xiaomi account not linked yet: click Connect in the integration settings');
    // No message: the red badge next to the account says it, and the field
    // description already explains what to do.
    await reportStatus(false);
    return false;
  }
  xiaomi = new XiaomiClient(session);
  try {
    await xiaomi.login();
  } catch (err) {
    await reportStatus(false, {
      en: `Connection failed: ${err.message}`,
      fr: `Échec de la connexion : ${err.message}`,
    });
    throw err;
  }
  await persistSession();
  await reportStatus(true);
  return true;
}

/**
 * Load the robots and publish them as discovered devices.
 */
async function publishDevices() {
  const devices = xiaomi.listDevices();
  const discovered = [];

  for (const device of devices) {
    discovered.push(convertDevice(gladys, device));
    try {
      // The dock is only published when the robot reports one: the status field
      // is the only thing that tells a docked model from a bare one.
      const status = await xiaomi.getStatus(device.duid);
      const dockType = Number(status && status.dock_type);
      if (Number.isFinite(dockType) && dockType > 0) {
        discovered.push(convertDockDevice(gladys, device, dockType));
      }
    } catch (err) {
      logger.warn(`Could not detect a dock for ${device.duid}: ${err.message}`);
    }
  }

  logger.info(
    `${devices.length} robot vacuum(s) and ${discovered.length - devices.length} dock(s) found`,
  );
  await gladys.publishDiscoveredDevices(discovered);
}

/**
 * Publish the transport badge (local / cloud) of a device, if known.
 * @param {string} duid the device id
 * @param {string} externalId the device external id
 */
async function publishTransport(duid, externalId) {
  const transport = xiaomi.getLastTransport(duid);
  if (transport) {
    await gladys.publishTransports([{ external_id: externalId, transport }]);
  }
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> loading the robots of the account');
  if (!xiaomi.isLoggedIn() && !(await connect())) {
    throw new Error('The Xiaomi account is not linked yet');
  }
  await publishDevices();
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  const { duid } = parseExternalId(device.external_id);
  const featureCode = feature.external_id.split(':').pop();

  // The empty option only clears the selection. A full clean stays driven by the
  // run mode alone.
  if (featureCode === FEATURE_CODES.ROOM && value === ROOM_SELECTION_NONE) {
    roomCleanings.delete(duid);
    initializedRoomSelectors.add(duid);
    return;
  }

  const command = buildSetCommand(featureCode, value);
  if (!command) {
    throw new Error(`Feature "${feature.external_id}" is not controllable with value ${value}`);
  }
  await xiaomi.sendCommand(duid, command.method, command.params);

  if (featureCode === FEATURE_CODES.ROOM) {
    // The command was accepted, but the robot may not have entered
    // segment_cleaning yet: the next poll must not reset the selector already.
    roomCleanings.set(duid, { active: false });
    initializedRoomSelectors.add(duid);
  }
});

// --- Polling: Gladys asks to refresh a device --------------------------------
gladys.onPoll(async (device) => {
  const { slug, duid } = parseExternalId(device.external_id);
  let states;

  if (slug === DOCK_SLUG) {
    const consumable = await xiaomi.getConsumable(duid);
    states = buildDockStates(dockExternalIds(gladys, duid), consumable);
  } else {
    const [status, consumable] = await Promise.all([
      xiaomi.getStatus(duid),
      // Maintenance counters are a bonus: an older model that does not answer
      // must still report its state.
      xiaomi.getConsumable(duid).catch((err) => {
        logger.warn(`Could not get the consumables of ${duid}: ${err.message}`);
        return null;
      }),
    ]);
    const ids = vacuumExternalIds(gladys, duid);
    states = [...buildPollStates(ids, status), ...buildConsumableStates(ids, consumable)];
    const robot = xiaomi.listDevices().find((candidate) => candidate.duid === duid);
    const roomFeedback = buildRoomSelectionFeedback(
      duid,
      ids,
      status,
      Boolean(robot?.rooms?.length),
    );
    if (roomFeedback) {
      states.push(roomFeedback);
    }
  }

  if (states.length > 0) {
    await gladys.publishStates(states);
  }
  await publishTransport(duid, device.external_id);
});

// --- Linking the account (the Connect button of the account field) -----------
// Gladys opens the URL we return in the user's browser. Xiaomi is NOT an OAuth2
// provider: this is its QR sign-in page. The user approves it there, and we learn
// about it through the long poll below — Xiaomi redirects to its own STS
// endpoint, never back to Gladys, so no callback is involved.
gladys.onOAuthAuthorizeUrl(async () => {
  logger.info('Connect -> starting the Xiaomi sign-in');
  const { loginUrl } = await xiaomi.startAccountLink();
  // Watch for the approval in the background: the URL must be returned right
  // away, the user needs the page open BEFORE they can approve anything.
  waitForAccountLink().catch((err) => logger.error('Account link failed', err));
  await reportStatus(false, {
    en: 'Sign in on the Xiaomi page that just opened. This screen updates on its own.',
    fr: "Connectez-vous sur la page Xiaomi qui vient de s'ouvrir. Cet écran se met à jour tout seul.",
  });
  return withPlaceholderState(loginUrl);
});

/**
 * Add a placeholder anti-CSRF `state` to the Xiaomi sign-in URL.
 *
 * Since Gladys 4.84.4 the frontend refuses an authorize URL without a `state`,
 * and rewrites it to carry the address of the instance across the round trip.
 * That is right for a real OAuth2 provider; the Xiaomi QR sign-in is not one:
 * nothing ever redirects back to Gladys, the approval is learned through the
 * long poll, so there is no state for us to verify either.
 *
 * A placeholder therefore satisfies the frontend without changing anything for
 * Xiaomi. Verified against the real endpoint: Xiaomi ignores an unknown `state`
 * — the page it redirects to is byte-identical with and without it, and its
 * `followup` URL keeps only ticket/dc/sid/ts.
 * @param {string} loginUrl the sign-in URL returned by Xiaomi
 * @returns {string} the same URL, carrying a state
 */
function withPlaceholderState(loginUrl) {
  const url = new URL(loginUrl);
  url.searchParams.set('state', crypto.randomBytes(16).toString('hex'));
  return url.toString();
}

/**
 * Await the approval of a pending account link, then persist the session,
 * publish the robots and report the state. Long-polls until the sign-in page
 * expires.
 */
async function waitForAccountLink() {
  // read the client on every leg: a config update can replace it mid-poll, and
  // polling a client that is no longer the live one would link nothing
  while (xiaomi.hasPendingAccountLink()) {
    const linked = await xiaomi.pollAccountLink();
    if (linked) {
      logger.info('Xiaomi account linked');
      await persistSession();
      await publishDevices();
      await reportStatus(true);
      return;
    }
  }
  logger.warn('The account link expired before it was approved');
  await reportStatus(false, {
    en: 'The sign-in page expired before it was approved. Click Connect again.',
    fr: "La page de connexion a expiré avant d'être validée. Cliquez à nouveau sur Connecter.",
  });
}

// --- Configuration updated ----------------------------------------------------
// Only a save from the FRONTEND lands here: the config the integration writes
// itself (the session) is not echoed back — checked in
// externalIntegration.setIntegrationConfig, which sends no config-updated, unlike
// saveConfigFromFront. The session comparison below therefore guards against a
// no-op save from the user, not against a loop of our own making.
gladys.onConfigUpdated(async (newConfig) => {
  const updated = readSession(newConfig);
  if (xiaomi.isLoggedIn() && sameSession(updated, session)) {
    return;
  }
  logger.info('onConfigUpdated -> reconnecting');
  session = updated;
  try {
    if (await connect()) {
      await publishDevices();
    } else {
      // the session was cleared (Disconnect): its robots are no longer ours
      await publishDevices();
    }
  } catch (err) {
    logger.error('Reconnection failed', err);
  }
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  logger.info('WebSocket connected to Gladys');
  try {
    session = readSession(await gladys.getConfig());
    if (await connect()) {
      await publishDevices();
    }
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
  }
});

gladys.on('disconnected', () => {
  logger.warn('WebSocket disconnected - the SDK will try to reconnect');
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  await xiaomi.logout();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Xiaomi Home integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});

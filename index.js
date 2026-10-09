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
//   - answers the polls of Gladys with the current robot status, and fires the
//     scene triggers on the transitions it sees between two polls;
//   - runs the scene actions (start, pause, stop, dock, rooms, fan power);
//   - serves the map dashboard widget (map fetched through the Xiaomi cloud);
//   - forwards user commands to the robot over the LAN (encrypted miIO on UDP
//     54321), falling back to a Xiaomi cloud RPC when it is unreachable.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';

import {
  DOCK_SLUG,
  convertDevice,
  convertDockDevice,
  dockExternalIds,
  vacuumExternalIds,
} from './src/devices/convertDevice.js';
import {
  MAP_WIDGET_KEY,
  buildMapWidgetContent,
  duidFromImageKey,
  mapImageKey,
} from './src/devices/mapWidget.js';
import { renderMapPngBase64 } from './src/map/mapRender.js';
import {
  buildConsumableStates,
  buildDockStates,
  buildPollStates,
  buildSetCommand,
  consumablePercents,
} from './src/devices/vacuum.js';
import {
  buildCleanedTodayState,
  buildLastCleanStartState,
  extractLastCleanStart,
} from './src/devices/lastClean.js';
import { computeSceneEvents, snapshotFromStatus } from './src/devices/sceneTriggers.js';
import { FAN_POWER_MODES, SCENE_ACTIONS, resolveRoomSegments } from './src/devices/sceneActions.js';
import {
  FEATURE_CODES,
  ROBOROCK_CLEANING_STATES,
  ROBOROCK_METHOD,
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
// The one setting Gladys itself renders, because the manifest declares both
// the local and the cloud transports: the reserved, read-only key
// GLADYS_PREFER_LOCAL ("Prefer the local connection", true unless turned off).
let preferLocal = true;
let xiaomi = new XiaomiClient(session);

/**
 * Read the user's transport preference from the integration config.
 * @param {Record<string, unknown>} config the config returned by Gladys
 * @returns {boolean} false only when the user turned the toggle off
 */
function readPreferLocal(config = {}) {
  return config.GLADYS_PREFER_LOCAL !== false;
}

// Robots for which a room clean has just been asked. `active` only turns true
// once the robot has actually been seen in a segment-cleaning state.
const roomCleanings = new Map();

// Lets a stale selection be cleared after a restart of the integration, without
// wiping a fresh selection before the robot has had time to start on it.
const initializedRoomSelectors = new Set();

// Last known snapshot per robot, to detect the transitions that fire the scene
// triggers. The first observation only seeds the cache: nothing is fired when
// the integration starts.
const sceneSnapshots = new Map();

// Robots with a cleaning session in progress: the map widget is refreshed faster
// (and cached more briefly) for them, so the map is near real-time while cleaning.
const cleaningDuids = new Set();

/**
 * Detect the robot transitions since the last poll and fire the matching scene
 * triggers. Never throws: a trigger failure must not break the poll.
 * @param {object} device the Gladys device being polled
 * @param {string} duid the robot device id
 * @param {object} status the get_status result
 * @param {object} consumable the get_consumable result
 * @returns {Promise<void>}
 */
async function publishSceneTriggers(device, duid, status, consumable) {
  try {
    const snapshot = snapshotFromStatus(status, consumablePercents(consumable));
    const previous = sceneSnapshots.get(duid) || null;
    sceneSnapshots.set(duid, snapshot);

    const events = computeSceneEvents(previous, snapshot, {
      vacuum: device.external_id,
      deviceName: device.name || duid,
    });
    for (const event of events) {
      await gladys.publishSceneEvent(event.key, event.data);
    }

    if (snapshot.sessionActive) {
      cleaningDuids.add(duid);
    } else {
      cleaningDuids.delete(duid);
    }
  } catch (err) {
    logger.warn(`Could not publish scene triggers for ${duid}: ${err.message}`);
  }
}

/**
 * Cleaning-history cache.
 *
 * get_clean_summary is not guaranteed to be answered on the LAN and can
 * therefore go through the Xiaomi cloud: it must not run on every Gladys poll.
 *
 * status.last_clean_t, when the firmware reports it, is the END of the latest
 * cleaning. It is only used as a change marker: the feature exposed to Gladys is
 * the cleaning START, from get_clean_summary.
 */
const cleanHistoryCache = new Map();

const CLEAN_HISTORY_REFRESH_MS = 5 * 60 * 1000;

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
 * Get the latest cleaning start timestamp while limiting history RPC traffic.
 *
 * Verified on Roborock QV 35A (roborock.vacuum.a168), through the Roborock app:
 *
 *   get_clean_summary.records[0] = get_clean_record(...)[0].begin
 *   get_status.last_clean_t       = get_clean_record(...)[0].end
 *
 * last_clean_t is therefore only used as a cheap change detector. On models
 * that do not report it, the summary is refreshed periodically instead.
 *
 * @param {string} duid the robot device id
 * @param {object} status get_status result
 * @returns {Promise<number|null>} Unix timestamp in seconds
 */
async function getLastCleanStartForPoll(duid, status) {
  const rawLastCleanEnd = Number(status?.last_clean_t);
  const lastCleanEnd =
    Number.isSafeInteger(rawLastCleanEnd) && rawLastCleanEnd > 0 ? rawLastCleanEnd : null;

  const now = Date.now();
  const cached = cleanHistoryCache.get(duid);

  const robotState = Number(status?.state);
  const isCleaning = ROBOROCK_CLEANING_STATES.has(robotState);
  const cleaningStarted = isCleaning && cached?.wasCleaning === false;

  const markerChanged =
    lastCleanEnd !== null &&
    cached?.lastCleanEnd !== undefined &&
    lastCleanEnd !== cached.lastCleanEnd;

  const periodicRefreshDue = !cached || now >= (cached.nextRefreshAt || 0);

  // Refresh immediately when a cleaning starts, and again when last_clean_t
  // changes (normally when that cleaning ends). This makes Last clean start
  // useful while a cleaning is still in progress instead of only afterwards.
  if (!cleaningStarted && !markerChanged && !periodicRefreshDue) {
    if (cached) {
      cached.wasCleaning = isCleaning;
    }
    return cached?.lastCleanStart ?? null;
  }

  try {
    const summary = await xiaomi.getCleanSummary(duid);
    const lastCleanStart = extractLastCleanStart(summary);

    cleanHistoryCache.set(duid, {
      lastCleanEnd,
      lastCleanStart,
      wasCleaning: isCleaning,
      nextRefreshAt:
        lastCleanEnd === null ? now + CLEAN_HISTORY_REFRESH_MS : Number.POSITIVE_INFINITY,
    });

    return lastCleanStart;
  } catch (err) {
    logger.warn(`Could not get the cleaning history of ${duid}: ${err.message}`);

    // Store the CURRENT lastCleanEnd (not the stale cached one) so a model that
    // does not support get_clean_summary — or an unreachable cloud — does not
    // keep `markerChanged` true and retry the call on every poll. The periodic
    // refresh (nextRefreshAt) still applies.
    cleanHistoryCache.set(duid, {
      lastCleanEnd,
      lastCleanStart: cached?.lastCleanStart ?? null,
      wasCleaning: isCleaning,
      nextRefreshAt: now + CLEAN_HISTORY_REFRESH_MS,
    });

    return cached?.lastCleanStart ?? null;
  }
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
    xiaomi = new XiaomiClient({}, { preferLocal });
    logger.warn('Xiaomi account not linked yet: click Connect in the integration settings');
    // No message: the red badge next to the account says it, and the field
    // description already explains what to do.
    await reportStatus(false);
    return false;
  }
  xiaomi = new XiaomiClient(session, { preferLocal });
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

// --- Scene actions: a scene commands the robot -------------------------------
// Each action carries a `vacuum` field (source: "devices"): its value is the
// device external_id, from which the duid is parsed.
function sceneActionDuid(fields) {
  const vacuum = fields && fields.vacuum;
  if (typeof vacuum !== 'string' || !vacuum) {
    throw new Error('The "vacuum" field is required');
  }
  return parseExternalId(vacuum).duid;
}

gladys.onSceneAction(SCENE_ACTIONS.START_CLEANING, async (fields) => {
  await xiaomi.sendCommand(sceneActionDuid(fields), ROBOROCK_METHOD.APP_START, []);
});

gladys.onSceneAction(SCENE_ACTIONS.PAUSE_CLEANING, async (fields) => {
  await xiaomi.sendCommand(sceneActionDuid(fields), ROBOROCK_METHOD.APP_PAUSE, []);
});

gladys.onSceneAction(SCENE_ACTIONS.STOP_CLEANING, async (fields) => {
  await xiaomi.sendCommand(sceneActionDuid(fields), ROBOROCK_METHOD.APP_STOP, []);
});

gladys.onSceneAction(SCENE_ACTIONS.RETURN_TO_DOCK, async (fields) => {
  await xiaomi.sendCommand(sceneActionDuid(fields), ROBOROCK_METHOD.APP_CHARGE, []);
});

gladys.onSceneAction(SCENE_ACTIONS.SET_FAN_POWER, async (fields) => {
  const duid = sceneActionDuid(fields);
  const cleanMode = FAN_POWER_MODES[String(fields.mode)];
  if (cleanMode === undefined) {
    throw new Error(`Unknown fan power mode: "${fields.mode}"`);
  }
  const command = buildSetCommand(FEATURE_CODES.CLEAN_MODE, cleanMode);
  if (!command) {
    throw new Error(`Fan power mode "${fields.mode}" is not controllable`);
  }
  await xiaomi.sendCommand(duid, command.method, command.params);
});

gladys.onSceneAction(SCENE_ACTIONS.CLEAN_ROOMS, async (fields) => {
  const duid = sceneActionDuid(fields);
  const robot = xiaomi.listDevices().find((candidate) => candidate.duid === duid);
  const segments = resolveRoomSegments(fields.rooms, robot?.rooms || []);
  if (segments.length === 0) {
    throw new Error(`No known room matched "${fields.rooms}"`);
  }
  await xiaomi.sendCommand(duid, ROBOROCK_METHOD.APP_SEGMENT_CLEAN, [{ segments }]);
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

    const lastCleanStart = await getLastCleanStartForPoll(duid, status);
    const lastCleanState = buildLastCleanStartState(ids, lastCleanStart);
    if (lastCleanState) {
      states.push(lastCleanState);
    }
    // "Cleaned today" (0/1): a scene condition can check whether the vacuum ran
    // today. Always published (even 0) so both branches of the condition work.
    states.push(buildCleanedTodayState(ids, lastCleanStart));

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

    await publishSceneTriggers(device, duid, status, consumable);
  }

  if (states.length > 0) {
    await gladys.publishStates(states);
  }
  await publishTransport(duid, device.external_id);
});

// --- Map dashboard widget ----------------------------------------------------
// The map is exposed as a dashboard widget (SDK >= 0.14), not a device: Gladys
// pulls the content (onWidgetGet) and the image bytes (onWidgetGetImage). A small
// cache holds the last rendered PNG per image key so the two calls of one refresh
// do not fetch the map twice; on a cold cache the duid is recovered from the key.
const MAP_IMAGE_CACHE_MAX = 8;
const mapImageCache = new Map(); // imageKey -> PNG base64

function cacheMapImage(key, base64) {
  mapImageCache.set(key, base64);
  while (mapImageCache.size > MAP_IMAGE_CACHE_MAX) {
    mapImageCache.delete(mapImageCache.keys().next().value);
  }
}

// Short-lived parsed-map + PNG cache per robot, with in-flight de-duplication.
// Without it every dashboard refresh (content ttl) and every image cache-miss
// would fire a fresh get_map_v1 + cloud download plus a synchronous PNG render,
// and concurrent viewers of the same robot would each fetch it. A single
// in-flight request is shared, and its result is reused for a short window.
const MAP_RENDER_TTL_MS = 60 * 1000;
// While a cleaning session is active the map is cached only briefly, so the live
// refresh nudge (see below) actually produces an up-to-date render each time.
const MAP_RENDER_TTL_ACTIVE_MS = 8 * 1000;
// How often to nudge a refresh of open map widgets while a robot is cleaning.
const MAP_LIVE_REFRESH_MS = 15 * 1000;
const mapRenderCache = new Map(); // duid -> { at, map, base64, imageKey }
const mapRenderInFlight = new Map(); // duid -> Promise<{ map, base64, imageKey }>

// Short, stable marker of the rendered image: the image key changes (and the core
// swaps the <img>) only when these bytes change, so an unchanged map never flashes.
function mapSignature(base64) {
  return createHash('sha1').update(base64).digest('hex').slice(0, 10);
}

async function renderMapForDuid(duid) {
  const ttl = cleaningDuids.has(duid) ? MAP_RENDER_TTL_ACTIVE_MS : MAP_RENDER_TTL_MS;
  const cached = mapRenderCache.get(duid);
  if (cached && Date.now() - cached.at < ttl) {
    return cached;
  }
  const pending = mapRenderInFlight.get(duid);
  if (pending) {
    return pending;
  }
  const promise = (async () => {
    if (!xiaomi.isLoggedIn() && !(await connect())) {
      throw new Error('The Xiaomi account is not linked yet');
    }
    const map = await xiaomi.getMap(duid, { includePixels: true });
    const base64 = renderMapPngBase64(map);
    const imageKey = mapImageKey(duid, mapSignature(base64));
    cacheMapImage(imageKey, base64);
    const entry = { at: Date.now(), map, base64, imageKey };
    mapRenderCache.set(duid, entry);
    return entry;
  })();
  mapRenderInFlight.set(duid, promise);
  try {
    return await promise;
  } finally {
    mapRenderInFlight.delete(duid);
  }
}

// Near real-time map while cleaning: drop the cached widget content so every open
// map widget re-pulls (and re-renders) on a short cadence. The core rate-limits
// requestWidgetRefresh to 1/10s, and it is a no-op when no widget is open.
const mapLiveRefresh = setInterval(() => {
  if (cleaningDuids.size === 0) {
    return;
  }
  try {
    gladys.requestWidgetRefresh(MAP_WIDGET_KEY);
  } catch (err) {
    logger.warn(`Map live refresh nudge failed: ${err.message}`);
  }
}, MAP_LIVE_REFRESH_MS);
if (typeof mapLiveRefresh.unref === 'function') {
  mapLiveRefresh.unref();
}

gladys.onWidgetGet(MAP_WIDGET_KEY, async ({ settings }) => {
  const vacuumExternalId = settings && settings.vacuum;
  if (!vacuumExternalId) {
    throw new Error('No vacuum selected for the map widget');
  }
  const { duid } = parseExternalId(vacuumExternalId);
  logger.info(`onWidgetGet(map) <- ${duid}`);
  const { map, base64, imageKey } = await renderMapForDuid(duid);
  cacheMapImage(imageKey, base64);
  // The map image is ready; gather the live numbers for the tiles / status block.
  const [status, consumables] = await Promise.all([
    xiaomi.getStatus(duid).catch((err) => {
      logger.warn(`Widget: could not get the status of ${duid}: ${err.message}`);
      return {};
    }),
    xiaomi
      .getConsumable(duid)
      .then((consumable) => consumablePercents(consumable))
      .catch(() => ({})),
  ]);
  await publishTransport(duid, vacuumExternalId);
  return buildMapWidgetContent(map, { imageKey, vacuumExternalId, status, consumables, settings });
});

gladys.onWidgetGetImage(async (imageKey) => {
  const cached = mapImageCache.get(imageKey);
  if (cached) {
    return cached;
  }
  const duid = duidFromImageKey(imageKey);
  if (!duid) {
    throw new Error(`Unknown map image key: ${imageKey}`);
  }
  logger.info(`onWidgetGetImage <- re-rendering ${duid} (cache miss)`);
  const { base64 } = await renderMapForDuid(duid);
  cacheMapImage(imageKey, base64);
  return base64;
});

// --- Linking the account (the Connect button of the account field) -----------
// Gladys opens the URL we return in the user's browser. Xiaomi is NOT an OAuth2
// provider: this is its QR sign-in page. The user approves it there, and we learn
// about it through the long poll below — Xiaomi redirects to its own STS
// endpoint, never back to Gladys, so no callback is involved. Hence an
// `account_link` field, which Gladys opens with `noreferrer`: an `oauth2` one
// carries the Gladys address as Referer, and Xiaomi rejects it (code 10012).
gladys.onOAuthAuthorizeUrl(async () => {
  logger.info('Connect -> starting the Xiaomi sign-in');
  const { loginUrl } = await xiaomi.startAccountLink();
  await reportStatus(false, {
    en: 'Sign in on the Xiaomi page that just opened. This screen updates on its own.',
    fr: "Connectez-vous sur la page Xiaomi qui vient de s'ouvrir. Cet écran se met à jour tout seul.",
  });
  // Watch for the approval in the background: the URL must be returned right
  // away, the user needs the page open BEFORE they can approve anything. Started
  // after the prompt above, so that a failure is never overwritten by it.
  waitForAccountLink().catch(async (err) => {
    logger.error('Account link failed', err);
    await reportStatus(false, {
      en: `The Xiaomi sign-in failed: ${err.message}. Click Connect again.`,
      fr: `La connexion Xiaomi a échoué : ${err.message}. Cliquez à nouveau sur Connecter.`,
    });
  });
  return loginUrl;
});

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
  // The transport preference applies to the next RPC: no reconnection needed.
  preferLocal = readPreferLocal(newConfig);
  xiaomi.setPreferLocal(preferLocal);
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
    const config = await gladys.getConfig();
    session = readSession(config);
    preferLocal = readPreferLocal(config);
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

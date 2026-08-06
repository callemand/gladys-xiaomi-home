// -----------------------------------------------------------------------------
// Persisted Xiaomi session.
//
// The whole point: an integration runs unattended in a container, but the Xiaomi
// login is gated behind steps only a human can clear (a captcha and an identity
// verification on the password form, an approval on the QR one). So the account
// is linked ONCE, and the long-lived credentials it yields are persisted through
// the Gladys config (`gladys.setConfig()`, off-schema keys). Every later start
// reuses them, with no interaction at all.
//
// The stored keys are deliberately off-schema (not in `config_schema`): they are
// integration-managed state, never rendered as a form field.
// -----------------------------------------------------------------------------

// Off-schema config keys holding the session.
export const SESSION_KEYS = {
  // A client identifier that must stay STABLE across restarts: it carries the
  // device trust that keeps Xiaomi from re-triggering a verification.
  DEVICE_ID: 'session_device_id',
  USER_ID: 'session_user_id',
  PASS_TOKEN: 'session_pass_token',
  SSECURITY: 'session_ssecurity',
  REGION: 'session_region',
};

/**
 * Read the persisted session from a raw Gladys config object.
 * @param {Record<string, unknown>} raw the config returned by gladys.getConfig()
 * @returns {object} the session (absent fields are null)
 */
export function readSession(raw = {}) {
  return {
    deviceId: str(raw[SESSION_KEYS.DEVICE_ID]),
    userId: str(raw[SESSION_KEYS.USER_ID]),
    passToken: str(raw[SESSION_KEYS.PASS_TOKEN]),
    ssecurity: str(raw[SESSION_KEYS.SSECURITY]),
    region: str(raw[SESSION_KEYS.REGION]),
  };
}

/**
 * Whether a session carries enough to re-authenticate without any interaction.
 * @param {object} session a session from readSession()
 * @returns {boolean} true when reusable
 */
export function isSessionUsable(session) {
  return Boolean(session && session.userId && session.passToken);
}

/**
 * Build the config payload persisting a session.
 * @param {object} session the session to store
 * @returns {Record<string, string>} the payload for gladys.setConfig()
 */
export function sessionToConfig(session = {}) {
  return {
    [SESSION_KEYS.DEVICE_ID]: session.deviceId || '',
    [SESSION_KEYS.USER_ID]: session.userId || '',
    [SESSION_KEYS.PASS_TOKEN]: session.passToken || '',
    [SESSION_KEYS.SSECURITY]: session.ssecurity || '',
    [SESSION_KEYS.REGION]: session.region || '',
  };
}

/**
 * The config payload clearing the stored session (disconnect, or a session the
 * cloud no longer accepts).
 * @returns {Record<string, string>} the payload for gladys.setConfig()
 */
export function clearedSessionConfig() {
  return sessionToConfig({});
}

/**
 * Whether two sessions carry the same credentials. Used to tell OUR OWN config
 * write apart from a real change, which would otherwise loop
 * (persist -> config-updated -> reconnect -> persist).
 * @param {object} a first session
 * @param {object} b second session
 * @returns {boolean} true when equivalent
 */
export function sameSession(a, b) {
  if (!a || !b) {
    return false;
  }
  return ['deviceId', 'userId', 'passToken', 'ssecurity', 'region'].every(
    (field) => (a[field] || null) === (b[field] || null),
  );
}

/**
 * Coerce a config value to a non-empty string, or null.
 * @param {unknown} value the raw value
 * @returns {string|null} the string, or null
 */
function str(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

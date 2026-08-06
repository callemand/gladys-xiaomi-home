# Gladys Xiaomi Home integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
controls the **robot vacuums of a Xiaomi Home (Mi Home) account**, over the local
network (miIO) with a Xiaomi cloud fallback.

Built on the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

> A robot paired in the **Roborock app** answers on a different cloud entirely and
> is served by its own integration,
> [gladys-roborock](https://github.com/callemand/gladys-roborock). Which one you
> need depends only on the app you set the robot up with. A household using both
> apps installs both integrations.

## What it does

- **Links the account once, with a QR sign-in.** The user clicks _Connect_, the
  Xiaomi page opens and they approve it. No password is ever typed into Gladys,
  and Xiaomi's captcha / identity-verification steps never come up.
- **Reconnects silently afterwards.** The long-lived `passToken` returned by the
  sign-in is persisted in the integration config, so every later start
  re-authenticates with no interaction at all — which is what makes this work
  unattended in a container.
- **Discovers the robots** of the account with their miIO local key and LAN IP,
  and publishes them as **discovered devices**: the user creates them from the
  Gladys Discovery screen.
- **Talks to each robot over the LAN** with the miIO protocol (encrypted UDP on
  port 54321) and falls back to a Xiaomi cloud RPC when the robot is not
  reachable locally. The transport in use is shown as a badge on the device.

There is **nothing to configure**: the Xiaomi server region, the robots, their
local keys and their IP addresses are all discovered automatically, and the
working region is remembered so a restart does not probe them again.

Each **robot** exposes these features:

| Feature    | Category / type                 | Mapping                                            |
| ---------- | ------------------------------- | -------------------------------------------------- |
| State      | `vacuum-cleaner` / `state`      | miIO `state` → Gladys state (read-only)            |
| Run mode   | `vacuum-cleaner` / `run-mode`   | Idle / Clean → `app_stop` / `app_start`            |
| Clean mode | `vacuum-cleaner` / `clean-mode` | miIO `fan_power` ↔ Gladys clean mode (table below) |
| Dock       | `vacuum-cleaner` / `dock`       | "Go home" (value 1) → `app_charge`                 |
| Battery    | `battery` / `integer`           | miIO `battery` (%), read-only, history kept        |

### Fan power ↔ clean mode

Gladys exposes a fixed list of clean modes; the robots expose suction levels.
The five levels below are **verified on real hardware** (Roborock S6, firmware
`3.5.8_2700`):

| Suction level | Code | Gladys clean mode |
| ------------- | ---- | ----------------- |
| Silent        | 101  | Quiet             |
| Balanced      | 102  | Auto              |
| Turbo         | 103  | Deep Clean        |
| Max           | 104  | Vacuum            |
| Gentle        | 105  | Low Noise         |

Code `106` ("auto") is **silently ignored** by the S6 — it falls back to 102 —
so it is never written; it is only accepted on read, as an alias of _Auto_, for
the models that report it. The Gladys _Quick_ and _Mop_ clean modes have no
equivalent and are rejected with an explicit error rather than doing nothing.

## Development

```bash
npm install
npm test          # node:test unit tests + an end-to-end test
npm run lint      # ESLint
npm run format    # Prettier
```

`test/e2e.test.js` boots the real `index.js` against a fake Gladys host
(WebSocket + REST), a fake Xiaomi cloud and a fake miIO device (UDP), and
exercises the silent `passToken` login, discovery, polling and commands.

## Protocol notes (learned the hard way, verified against the live API)

- The login `nonce` is a **19-digit integer**: `JSON.parse` silently rounds it,
  which breaks the `clientSign` and yields no `serviceToken` — Xiaomi answers
  `ok` with no cookie and no error. It is read as a raw string from the response
  text. The e2e test asserts this by validating the `clientSign` server-side.
- The persisted `deviceId` must stay **stable** across restarts: it carries the
  device trust that keeps Xiaomi from re-triggering a verification.
- A miIO request whose `id` the robot has recently seen is **silently ignored**
  (verified: after a previous session, `id=2` got no reply while `id=100` did),
  so the request-id counter is seeded from the clock instead of restarting at 1.
- The sign-in page must be opened with **`noreferrer`**: a cross-site `Referer`
  makes Xiaomi answer `lpLogin/result?code=10012` ("Invalid request"). Only the
  `Referer` matters — `Sec-Fetch-Site` alone is fine.
- The Xiaomi **password** login is gated behind a captcha and an
  identity-verification step; it is not usable from a headless container, which
  is why the QR sign-in is the only supported way to link an account.
- Xiaomi's official **OAuth2** flow is not an option for third parties: its
  `client_id` is locked to Home Assistant's redirect URI and its license
  restricts it to Home Assistant.

## Limitations

- **Robot vacuums only.** The name matches the app, but a Xiaomi Home account
  carries many other device types and none of them is handled here.
- Only the miIO protocol family is implemented.
- Suction-level codes vary across model generations; the table above targets the
  modern codes. If your model reports different values, open an issue with the
  `fan_power` seen in the debug logs.

## License

Apache-2.0

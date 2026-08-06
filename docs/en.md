# Xiaomi Home

Control the robot vacuums of your Xiaomi Home account from Gladys Assistant.

This integration targets robots **paired in the Xiaomi Home (Mi Home) app**. It
talks to them **directly over your local network**, with an automatic fallback to
the Xiaomi cloud when a robot is not reachable.

> If your robot is paired in the **Roborock app**, it answers on an entirely
> different service: the **Roborock** integration is the one you need. Both can be
> installed at once if you use both apps.

## Features

For every robot of your account:

- **State** — the operational state of the robot (cleaning, paused, returning to
  the dock, charging, docked, error…).
- **Run mode** — start or stop a cleaning cycle.
- **Clean mode** — the suction level (silent, balanced, turbo, max, gentle).
- **Dock** — send the robot back to its charging dock.
- **Battery** — the current battery level, in percent.

## Configuration

1. Click **Connect**: the Xiaomi sign-in page opens.
2. Approve it (you can also scan it with the Xiaomi Home app).
3. The badge turns green on its own.
4. Open the **Discovery** screen and start a scan: your robots appear and can be
   added to Gladys.

> You **never** type your Xiaomi password into Gladys, and this is only needed
> **once**: the session is stored and reused automatically after a restart.

There is **nothing to configure**: the Xiaomi server region, your robots, their
local encryption keys and their IP addresses are all discovered automatically.

## How it works

The integration discovers your robots through the Xiaomi cloud, along with their
local encryption key and IP address. Commands and state readings then go through
the **local network** first (encrypted miIO protocol), falling back to the cloud
when a robot is unreachable. The transport in use is shown as a badge on the
device.

## Limitations

- **Robot vacuums only.** The name matches the app, but a Xiaomi Home account
  carries many other device types and none of them is handled here.
- Suction-level codes vary across model generations. If your model behaves
  differently, open an issue with the `fan_power` value visible in the debug
  logs.

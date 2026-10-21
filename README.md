<p align="center"><img src="smart_ventilation/logo.png" alt="Smart Ventilation" width="400"></p>

# Smart Ventilation

A Home Assistant app (add-on) that ventilates showers and bathrooms on the **humidity curve** instead of fixed thresholds and timers.

> **Test version (dry-run).** This version follows your sensors and shows what it *would* set. It never sends anything to your fan or valves, so your current automations or blueprints keep working next to it.

## What it does

- **Detects a shower by the rise**, not by a fixed level: for example +8 points within 5 minutes. A fixed 70% goes off too early in summer and too late in winter.
- **Stops when the room is back to normal**: the level from before the shower (the baseline) plus a small margin, not after a fixed time. A maximum boost time is the safety net.
- **Afterrun**: a few minutes at an in-between level, then back to rest.
- **More rooms, shared fan**: each room (zone) has its own sensor and valve. A fan used by more zones gets the highest level any zone asks for, so the bathroom never turns the fan down while the shower is still boosting.
- **Valves of the other rooms**: while one zone boosts, the valve of another zone can go to a low level (for example 0–25%), so the air comes from the wet room.
- **Reference sensors** (optional): humidity sensors in other rooms. When the whole house gets humid (weather), that is not a shower.
- **Night maximum** (optional): a quieter maximum level during the night.
- **Dashboard controls** (optional): per zone Auto / Off, a "boost now" button and the main settings as helpers in Home Assistant, in a YAML package the app writes itself. Put them on any dashboard.
- **Any brand**: the fan, valves and sensors are chosen in the app. Supported actuator types: fan (percentage or preset), number, select and switch.

## Installation

1. In Home Assistant: **Settings › Apps › App store › ⋮ › Repositories**.
2. Add `https://github.com/tlpeter/smart-ventilation` (the test version is on the `dev` branch: `https://github.com/tlpeter/smart-ventilation#dev`).
3. Install **Smart Ventilation (dev)**, start it, and open it from the sidebar.
4. Open **Settings** in the app (not the Configuration tab in Home Assistant). Press **Suggest a set-up**, or add the actuators (your fan and valves) and then a zone per room yourself. Check the percentages and press **Save settings**.

See [DOCS.md](smart_ventilation/DOCS.md) for every setting.

## Example: Duco Open AIR Mini with two valves

| Actuator | Type | Rest | Boost | Afterrun | While another zone boosts |
| --- | --- | --- | --- | --- | --- |
| `fan.open_air_mini` | Fan, percentage | 10 | 75 | 50 | – |
| Shower valve | Number | your choice | 100 | your choice | 10 |
| Bathroom valve | Number | your choice | 100 | your choice | 10 |

Zones: **Shower** (its humidity sensor, the fan and the shower valve) and **Bathroom** (its sensor, the fan and the bathroom valve).

## Safety

- This version only reads Home Assistant. The code has no way to call an action.
- The one write is the app's own sensors (`sensor.smart_ventilation_*`), and only when **Publish sensors** is on.
- It never changes automations, scripts, blueprints or your helpers.
- With **Dashboard controls** on, it writes one file of its own (`<packages>/smart_ventilation.yaml`) and only reads the helpers in it.

## License and support

Report problems with the bug form on GitHub and attach the diagnostics file (Settings › Diagnostics). Security problems: see [SECURITY.md](SECURITY.md).

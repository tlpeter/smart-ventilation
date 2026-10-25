# Smart Ventilation

Ventilates showers and bathrooms on the humidity curve. By default it is a **dry-run**: it shows what it would set, and never changes your fan or valves. With **Live control** on (Settings › General) it really sets them.

## How it works

Every zone (room) goes through the same states:

| State | What happens |
| --- | --- |
| Normal (idle) | The app keeps track of the normal humidity (the baseline). Actuators at their rest level. |
| Boost | A shower was detected. Actuators at their boost level. |
| Afterrun | The room is back to normal. Actuators at their afterrun level for a few minutes. |
| Sensor problem | The humidity sensor is unavailable or silent for too long. Actuators back to rest. |

1. **Baseline**: the median humidity over the baseline window (default 60 minutes), leaving out the last few minutes. When a shower starts, the baseline is frozen, so the shower itself does not raise it.
2. **Shower detected** when the humidity rises by at least the *rise trigger* within the window (default +8 points in 5 minutes). With reference sensors, the rise of the rest of the house is subtracted first. Optionally the temperature must rise too.
3. **Safety net**: above the *absolute trigger* (default 85%) a boost also starts, unless the rest of the house is just as humid.
4. **Stop** after the minimum boost time, as soon as the humidity is at most baseline + stop margin, or at most reference + stop margin. Always at the maximum boost time.
5. **Afterrun** for its time, then back to rest. A new rise during afterrun boosts again.

After a boost that ended on the maximum time, or that stopped "back to normal" while the humidity is still above the absolute trigger (a room whose normal level is that high), the absolute trigger waits until the humidity is clearly below it again (below the trigger minus the stop margin), so a humid day does not keep restarting the boost. This is kept when the app restarts.

**Showers today** on Home counts only boosts started by a fast rise; a boost from the safety net is not a shower. In a humid room a shower often passes the safety net first: when the fast rise follows within the rise window, that boost counts as a shower after all.

## Where to set it up

Open the app from the sidebar (or **Open web UI** on the app's page in Home Assistant) and go to **Settings**. The Configuration tab of the app in Home Assistant only has *Publish sensors* and *Log level*; everything else is in the app itself.

Changes count only after **Save settings**. While there are unsaved changes the save bar is orange; leaving Settings first asks whether to save, discard or stay.

Set up in this order: **1 · Actuators** (fan and valves, with their percentages), **2 · Zones** (a room with its humidity sensor), **3 · General** (optional). With nothing set up yet, **Suggest a set-up** fills in a proposal from the entities in Home Assistant: check it, then press **Save settings**.

## Settings › Actuators

Add the things that move or steer the air. Each actuator has a type, an entity (chosen with the search box) and a value per level.

| Type | Home Assistant action it uses | Values |
| --- | --- | --- |
| Fan, percentage | `fan.set_percentage` | 0–100 |
| Fan, preset | `fan.set_preset_mode` | the fan's presets (only shown when the fan has them) |
| Number | `number.set_value` | within the entity's own min, max and step |
| Select | `select.select_option` | the entity's options |
| Switch | `switch.turn_on` / `switch.turn_off` | on / off |

Levels:

- **Rest**: when no zone needs it.
- **Boost** and **Afterrun**: when a zone that uses this actuator is in that state.
- **While another zone boosts** (optional, for valves): when this actuator's own zones are at rest but another zone is boosting. For example 0–25%, so the air comes from the wet room. Leave empty for a fan.
- **When more zones boost** (optional, numbers and fan percentage): the value when two or more of this actuator's zones boost at the same time. Meant for a shared fan, for example 80 while one zone alone uses 75. Not lower than boost. Empty: boost, as for one zone. Boost in one zone and afterrun in the other is still boost.
- **Night maximum** (optional, numbers and fan percentage): the highest value during the night window. It also caps "when more zones boost".

An actuator used by more than one zone is **shared**: it gets the highest level any of its zones asks for. That is normal for a fan. For a valve, select or switch it is most likely a mistake (a valve belongs to one room), so the app warns about it in Settings › Zones and when you save. Saving still works.

The app checks the values against the entity when you save (range, step, presets, options).

**Live** (on by default): with Live control on, the app may set this actuator. Untick it to keep one actuator on advice only, for example to start with only the fan.

## Settings › Zones

One zone per room.

| Setting | Default | Meaning |
| --- | --- | --- |
| Name | Shower / Bathroom | Shown on the page and in the sensors |
| On | on | Switch a zone off without removing it |
| Humidity sensor | – | Required |
| Temperature sensor | – | Optional, for the temperature check |
| Actuators | – | The fan and valve(s) of this room |
| Rise trigger | 8 points | Rise that counts as a shower |
| Within | 5 min | The rise window |
| Absolute trigger | 85% | Safety net |
| Stop margin | 3 points | Stop at baseline (or reference) + this |
| Minimum boost | 5 min | Never shorter, so the fan does not switch back and forth |
| Maximum boost | 60 min | Never longer |
| Afterrun | 5 min | Time at the afterrun level |
| Baseline window | 60 min | The normal level is the median over this time |
| Only count with temperature rise | off | Also needs the temperature to rise by… |
| Temperature rise | 1 °C | …this much within the window |

All numbers are starting points: tune them with the chart on Home and the Activity tab.

## Settings › General

- **Live control** (off by default): see below.
- **Reference sensors** (optional): humidity sensors in other rooms. The app uses their median. A rise in the whole house (weather) does not count as a shower, and a boost also stops when the room is back near the rest of the house.
- **Night**: from / until, and whether the actuators' night maximum is used.
- **Sensor timeout** (default 60 min): no reading for this long counts as a sensor problem. The app uses the time of the last report (`last_reported`), so a sensor that reports the same value still counts as alive.
- **Dashboard controls** (off by default): see below.

## Live control

Off: the app only shows what it would set (dry-run). On: it sets the actuators marked **Live**.

**Before you turn it on**, turn off your own automations or blueprints for these fans and valves. Otherwise they work against each other.

How it works:

1. The app sends a value **when the advice changes** (a shower starts, afterrun, back to rest), and only when the device is not at that value already.
2. A **change by hand** (or by another automation) stays until the next change of the advice. The app does not keep setting it back.
3. **Did a device not follow?** The app tries again after 2 minutes, 3 tries in all. Then it stops and writes it in Activity, until the next change. A fan with fixed speed steps counts as there when it is within half a step (for example 67% for 75% on a fan with 3 speeds).
4. An **error** from Home Assistant (device not responding) is shown on Home and in Activity, and counts as a try.
5. **Turning Live control off**, unticking **Live** on an actuator, or **stopping the app** (for example for an update) sets what the app moved back to **rest**. A value set by hand while the app asked for rest is left alone. After a restart during a shower, the boost continues and is set again.
6. A sensor problem or a zone set to **Off** means rest, as always.

The app can call only the six actions in the table above, only on the actuators chosen in the app and marked Live. Everything else is refused in the code.

## Dashboard controls

With **Settings › General › Dashboard controls** on, the app makes helpers in Home Assistant, so you can set it from a dashboard. Per zone (`<zone>` is the zone's id, for example `shower`):

| Helper | What it does |
| --- | --- |
| `input_select.smart_ventilation_<zone>_mode` | **Auto** (normal) or **Off** (the zone asks for nothing, also during a shower) |
| `input_button.smart_ventilation_<zone>_boost` | **Boost now**: a boost by hand for the maximum boost time, then back to Auto. Choosing Off stops it, also when the mode already said Off. |
| `input_number.smart_ventilation_<zone>_rise_trigger` | Rise trigger (points) |
| `input_number.smart_ventilation_<zone>_safety_net` | Absolute trigger, the safety net (%) |
| `input_number.smart_ventilation_<zone>_stop_margin` | Stop margin (points) |
| `input_number.smart_ventilation_<zone>_max_boost` | Maximum boost (min) |
| `input_number.smart_ventilation_<zone>_afterrun` | Afterrun (min) |

How it works:

1. The app reads `configuration.yaml` to find your packages folder, and writes **one file of its own**: `<packages folder>/smart_ventilation.yaml`. It never changes `configuration.yaml` or any other file, and leaves a file with that name alone when it did not make it.
2. Packages not on yet? The page shows the lines to add to `configuration.yaml`:

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

   Then restart Home Assistant once.
3. After the file is written (and after a new zone), load the helpers once: **Developer tools → YAML** → reload **Input numbers**, **Input selects** and **Input buttons**, or restart Home Assistant. The card shows how many helpers Home Assistant has.
4. The app only **reads** the helpers; it never sets them. So after **Boost now** the mode helper still shows what it said before. Choosing an option on it always counts, also the same one again (the app follows the action itself, not only the change). A change on the dashboard is used right away, and the app writes it into the file as the helper's starting value (`initial`), so it is kept after Home Assistant restarts.
5. A setting with a helper is set on the dashboard: in the app it is shown but cannot be changed there.

Turning dashboard controls off removes the file; reload or restart Home Assistant to remove the helpers.

The app needs the Home Assistant config folder for this (`homeassistant_config`, read and write); it uses it only as described above.

## Configuration tab (Home Assistant)

- **Publish sensors** (off by default): writes the app's own sensors to Home Assistant, per zone `sensor.smart_ventilation_<zone>_state`, `sensor.smart_ventilation_<zone>_baseline`, `sensor.smart_ventilation_<zone>_rise` (rise in the window, points), `sensor.smart_ventilation_<zone>_showers_today` and `binary_sensor.smart_ventilation_<zone>_shower_detected`, and per actuator `sensor.smart_ventilation_<actuator>_advised_level` (attribute `dry_run`: false when the app sets this actuator live). Home Assistant forgets them after its own restart; the app writes them again within 5 minutes.
- **Log level**: use debug when reporting a problem.

## Home and Activity

- **Home** shows per zone: the state and why, humidity, baseline, rise in the window, reference, showers today, its own fan and valves (the position now, and where the app sets it when that is different; a valve only shows when it is under Settings › Actuators and linked to the zone), and a chart of the humidity with the boost and afterrun periods. Tap a tile to see its history: Home Assistant's own pop-up opens on the same page (the same one as when you tap an entity in Home Assistant). Humidity opens the zone's humidity sensor, reference the reference sensor, temperature the temperature sensor, a fan or valve that entity. Baseline, rise and showers today are worked out by the app: they open the app's own sensors, so only with **Publish sensors** on (see below). Without it, baseline and rise are not clickable and showers today opens Activity. With more than one reference sensor, or when the app is opened on its own, Home Assistant's history page opens instead (last 24 hours). Above the chart you choose how far back: **3 h** (default), **24 h**, **3 days** or **7 days**; this browser remembers it. 3 hours uses the app's own readings and shows the baseline. Longer comes from Home Assistant's history (kept 10 days by default, `recorder:` → `purge_keep_days`); the bands come from the Activity log (the last 500 lines). Below: per actuator the current value and the advice. With Live control: what the app set and whether the device followed (or the error). Without: the action the app would send. The chip at the top says **Dry-run** or **Live**.
- **Activity** lists every zone change, every change in advice, and with Live control every value sent (✓ or the error), newest first.

## Diagnostics

Settings › Diagnostics › Download diagnostics: the settings, the current state, recent readings and the app log. Attach it to a bug report.

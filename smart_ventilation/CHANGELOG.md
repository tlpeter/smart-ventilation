# Changelog

## 0.3.11-dev

- Fix: a sensor that reports the same humidity no longer looks silent just because Home Assistant sends no state-change event. The app reads sensor report times again once a minute. The default sensor timeout is now 120 minutes; an existing choice is kept. (#11)
- If a reading becomes too old during boost or afterrun, ventilation stays at that level and the baseline stays frozen until the sensor reports again. An old high reading also keeps ventilation on. Home and Activity explain why; Off still stops the zone. A sensor that is missing or unavailable still goes to Sensor problem.
- Showers today counts a detected shower immediately, also when the sensor recovers straight into a shower after a fault or Off. A safety-net boost alone is still not a shower.
- Tests: constant 99.7%, identical reports without a state-change event, frozen baseline, recovery, restart during a sensor hold, and counting at the start.

## 0.3.10-dev

- Home: with **Publish sensors** on, the Reference tile opens the app's own sensor `sensor.smart_ventilation_reference`: the reference value the app really uses (the middle value of your reference sensors). Without Publish sensors it opens the reference sensor itself, as before. (#10)
- Tests: the reference sensor and its value.

## 0.3.9-dev

- Home: Baseline, Rise in window and Showers today now open their own history, not the humidity sensor. They are worked out by the app, so they need **Publish sensors** on (the app's Configuration tab in Home Assistant). New sensors per zone: `sensor.smart_ventilation_<zone>_rise` and `sensor.smart_ventilation_<zone>_showers_today`; the baseline sensor already existed. All three are numbers, so Home Assistant draws a graph. Without Publish sensors, Baseline and Rise are not clickable and Showers today opens Activity. (#9)
- Tests: the new sensors, and the tiles with Publish sensors on and off.

## 0.3.8-dev

- Fix: on the dashboard, choosing **Off** did not stop a **Boost now** when the mode helper already said Off (for Home Assistant that was no change). The app now also sees a choice that is the same as before, so Off always stops the boost. (#2)
- The app follows one more kind of event from Home Assistant, only reading: which actions are called (to see that choice).
- "Connected" on the page (and in the app's status) now means: connected and the entities are read. Before that, saving settings could fail with "not found".
- Tests: Off again after Boost now, with the fake Home Assistant and with the real Home Assistant Core 2026.10.4.

## 0.3.7-dev

- Home: a tap on a tile now opens Home Assistant's own pop-up with the history, on the same page, instead of going to the history page. The pop-up only shows; the app changes nothing. With more than one reference sensor, the history page still opens (the pop-up shows one entity). (#8)
- Checked by hand in a page that works like Home Assistant: the pop-up request reaches Home Assistant and the page stays.

## 0.3.6-dev

- Home: tap a tile in a zone card to see its history in Home Assistant (last 24 hours). Humidity, baseline and rise open the humidity sensor, reference the reference sensors, temperature the temperature sensor, the fan and valves their own entity. Showers today opens Activity. A small ↗ shows which tiles open Home Assistant (always on a phone, on hover on a computer). (#8)
- Tests: the entities behind the tiles in the status of the app.

## 0.3.5-dev

- Settings: a warning when one valve is ticked in more than one zone, for example the shower valve under the bathroom too. It shows under the zone as soon as you tick it, and after saving ("Saved, with a warning"). Saving still works. A shared fan gets no warning. (#7)
- Tests: the warning, and that a good set-up has none.

## 0.3.4-dev

- Fix: Showers today stayed 0 in a humid room. A shower there often passes the safety net first (one jump above the absolute trigger), before the rise is big enough. Now, when the fast rise follows within the rise window, that boost counts as a shower after all. It stays the same boost. (#6)
- Tests: that shower, with the numbers from a real one, in the logic and in the whole app.

## 0.3.3-dev

- New, optional per actuator: **When more zones boost** (Settings › Actuators). The value when two or more of its zones boost at the same time, for example the shared fan at 80 % when the shower and the bathroom both boost (75 % for one). Empty: as before. The night maximum still caps it. (#5)
- Tests: both zones boost, one boost and one afterrun, the night maximum, a zone that is off, and the check that it is not lower than boost.

## 0.3.2-dev

- Home: each zone card now shows its own fan and valves, with the position now. When the app is moving one (or would, in dry-run), it also shows where to. A boosting valve is blue, afterrun green. A zone without a linked fan or valve says so. (#4)
- Tests: the zone's own actuators in the status of the app.

## 0.3.1-dev

- Fix: in a room whose normal humidity is above the absolute trigger (for example 87 % with a trigger of 85 %), the boost stopped "back to normal" and the safety net started a new one 30 seconds later, all day long. Now the safety net then waits until the room is clearly drier, the same as after the maximum boost time. A real shower (a fast rise) still starts a boost.
- Tests: that room, with the numbers from a real diagnostics file.

## 0.3.0-dev

- New: **Live control** (Settings › General, off by default). On: the app really sets the fan and valves, instead of only showing advice. The chip at the top says **Live** or **Dry-run**.
- Per actuator a **Live** tick (on by default), so you can start with only the fan, for example.
- The app sends a value only when the advice changes and the device is not at it yet. A change by hand stays until the next shower.
- A device that does not follow gets 3 tries, 2 minutes apart; then the app stops and notes it in Activity. Errors from Home Assistant show on Home and in Activity.
- Turning Live control off, unticking Live, or stopping the app (for example an update) sets what the app moved back to rest.
- Safety: the app can call only six actions (fan percentage or preset, number, select, switch on/off), only on the actuators chosen in the app and marked Live. Everything else is refused.
- Turn off your own automations for these fans and valves before you turn on Live control.
- Tests: when to send and when to stop trying, the whole app with a fake Home Assistant that follows the actions (a shower, a change by hand, a stuck valve, an error, turning off, stopping the app), and the real Home Assistant Core test now also checks that the demo fan and numbers really change. Home Assistant Core for that test: 2026.10.4.

## 0.2.1-dev

- The humidity chart on Home can look further back: choose **3 h**, **24 h**, **3 days** or **7 days** above the chart (the same as in Smart Heating Planner). The choice counts for all zones, and this browser remembers it.
- 3 hours stays the default and works as before. Longer comes from Home Assistant's own history (only reading), so it is there right away. With days, the time line shows the days, and the baseline is not drawn (it moves over time).
- A long history is thinned, but the highest and lowest value of every short stretch are kept, so a shower peak stays visible.
- Tests: the new ranges, the thinning, and that only the history is read.

## 0.2.0-dev

- New: **Dashboard controls** (Settings › General, off by default). The app makes helpers in Home Assistant, per zone: a mode (Auto / Off), a "boost now" button, and the rise trigger, safety net, stop margin, maximum boost and afterrun. Put them on any dashboard; a change there is used right away.
- The helpers are in a YAML package that the app writes itself (`<packages folder>/smart_ventilation.yaml`). It never changes `configuration.yaml`: when packages are not on yet, the page shows the lines to add. After the file is written, reload the helpers once (Developer tools → YAML). The page shows how many helpers Home Assistant has.
- The app only reads the helpers. A change on the dashboard becomes the helper's starting value in the file, so it is kept after Home Assistant restarts. A setting that has a helper is set on the dashboard and cannot be changed in the app.
- New: per zone a mode. **Off**: the zone asks for nothing. **Boost now**: a boost by hand for the maximum boost time, then back to Auto (Off stops it).
- The app now asks for access to the Home Assistant config folder (to write that one file).
- Tests: the YAML package, dashboard controls with a temporary config folder, the modes, and the real Home Assistant Core loads the package.

## 0.1.5-dev

- Fix: "Showers today" also counted a boost from the safety net (humidity above the absolute trigger). Now only a boost started by a fast rise counts as a shower. The Activity log notes what started each boost.
- Fix: after a boost that ran its maximum time, the safety net waits until the room is clearly drier. A restart of the app (for example an update) forgot that, so a room that was still humid got a new boost right away. That is now kept.
- Tests: what started a boost, and a restart while the room is still humid.

## 0.1.4-dev

- Tests: the app is now also tested against a real Home Assistant Core (2026.10.2), like Smart Charging Planner and Smart Heating Planner. It uses demo fans and numbers as the ventilation unit and valves, simulates a shower with a humidity sensor, and checks the entity lists, the boost, the app's own sensors in Home Assistant, the history for the chart, and that nothing was sent to the fan or valves. It runs on every change on `dev` and every Monday.

## 0.1.3-dev

- Unsaved changes are no longer lost without warning. While Settings has unsaved changes, the save bar turns orange and shows **Discard** next to **Save settings**. Leaving Settings (Home, Activity) first asks: save, discard or stay. When saving fails, the reason stays in the bar.
- The same guard (`unsaved.js`) is used in Smart Charging Planner and Smart Heating Planner.

## 0.1.2-dev

- Fix: the entity search fields showed no list in the Home Assistant phone app, so for example a reference sensor could not be chosen. They now have their own list: tap the field to see the entities, type to narrow it down, tap one to choose it.
- The list shows the name, the entity id and the value now. A humidity or temperature sensor that Home Assistant does not mark as one can still be found under "Other sensors" by typing part of its name.
- Reference sensors: the sensors of your zones and the ones already chosen are left out of the list, and tapping a sensor adds it right away.

## 0.1.1-dev

- Settings is easier to find your way in: the tabs are now numbered in the order you set them up (1 · Actuators, 2 · Zones, 3 · General), and Settings opens on Actuators.
- New: **Suggest a set-up**. With nothing set up yet, the app proposes your fan, valves, the humidity sensor per room and reference sensors from the entities in Home Assistant. The fan starts at 10/75/50%, a valve's rest level is its value now. Nothing is saved until you press Save settings.

## 0.1.0-dev

- First test version (dry-run): the app follows your humidity sensors and shows what it would set. It never sends anything to your fan or valves.
- Zones (rooms) with their own humidity sensor, optional temperature sensor and actuators.
- Shower detection on the rise in humidity, a baseline that freezes during a shower, stopping at baseline + margin, minimum and maximum boost time, and afterrun.
- Actuators of any brand, chosen with an entity picker: fan (percentage or preset), number, select and switch. Values are checked against the entity.
- A shared fan gets the highest level any zone asks for. Valves of other zones can go to a low level while one zone boosts.
- Optional reference sensors (median) to ignore humidity of the whole house, optional night maximum.
- Sensor problems (unavailable, or no report for the timeout) send the zone back to rest.
- Home with a 3-hour chart per zone and the advice per actuator, Activity log, diagnostics download.
- Optional own sensors in Home Assistant ("Publish sensors", off by default).

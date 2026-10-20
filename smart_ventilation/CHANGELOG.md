# Changelog

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

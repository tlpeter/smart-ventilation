# Changelog

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

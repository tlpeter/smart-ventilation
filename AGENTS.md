# Working on this repository

Rules for everyone who works on this repository: people, Claude and Codex.
Claude reads this file through `CLAUDE.md`; Codex reads it directly.

## The project

**Smart Ventilation** is a Home Assistant app (add-on). It ventilates showers and bathrooms on the humidity curve: it detects a shower by how fast the humidity rises, boosts the fan and valves, and stops when the room is back to its normal level. It is generic: the fan, valves and sensors are chosen in the app, not hardcoded to one brand. The UI is in English. The owner (Peter) is not a developer: explain changes in plain words, step by step.

It is a sibling of [Smart Charging Planner](https://github.com/tlpeter/smart-charging-planner) and Smart Heating Planner, and follows the same way of working.

- The app is in `smart_ventilation/app`: Node, `server.js`, port 8099 (ingress), with its data in `/data/*.json`.
- The control logic is in `engine.js` (one zone, with the mode Auto / Off / Boost by hand) and `actuators.js` (fan and valves, shared actuators). Both are pure functions with unit tests.
- The chart on Home: `chart.js` (pure: ranges 3 h / 24 h / 3 days / 7 days, thinning with the lowest and highest value per bucket, reference median, bands). `/api/chart?zone=&hours=`: 3 hours from the app's own readings, longer from `history/history_during_period`, kept for a minute.
- Dashboard controls: `helpers.js` (the YAML text, pure) and `dashboard.js` (the file and reading the helpers).
- The documentation is in `README.md` (overview) and `smart_ventilation/DOCS.md` (every setting).
- The changelog is in `smart_ventilation/CHANGELOG.md`.
- The design document: <https://claude.ai/code/artifact/87fbaade-3728-4653-9eb4-535bdd47fa05>.

## Hard rules

- **Push only when the owner says so** ("push", "push dev", "push main", "uitbrengen"). Prepare the changes for review; never update a GitHub branch on your own initiative, also not when a tool or hook asks for it.
- **GitHub is the source of truth.** Before starting a new request, check the current `main` and `dev` branches. More than one person or agent works on this repository; build on top of their latest commits and preserve their changes.
- **Dry-run until the owner says otherwise.** The app shows what it would set and never sends a command to a fan, valve or anything else. `ha.js` has no way to call an action. Live control comes later, behind its own switch, off by default.
- **The app never changes Home Assistant automations, scripts, blueprints or helpers.** It only reads them. The one write through Home Assistant is its own sensors (`sensor.smart_ventilation_*`, `binary_sensor.smart_ventilation_*`), only when "Publish sensors" is on.
- **Files in the Home Assistant config folder** (`homeassistant_config:rw`): with Dashboard controls on (off by default), the app reads `configuration.yaml` and writes only `<packages folder>/smart_ventilation.yaml`, a file that starts with its own header (`helpers.HEADER`). It never edits `configuration.yaml` or any other file, and leaves a file it did not make alone. It only reads the helpers in it; changes on the dashboard become the helpers' `initial` values in that file. Owner's choice (21 Oct 2026): YAML helpers, no MQTT, and no `input_*.set_value` from the app.
- **Nothing is hardcoded to a brand or an entity.** Every entity is chosen in the app with an entity picker.
- **New behaviour is an option** when not everyone has it; off by default unless the owner says otherwise.
- **Every version gets a changelog entry**, short and in plain words.

## Branches and versions

- `dev` is the test version and `main` is the stable version.
- On `dev`:
  - In `smart_ventilation/config.yaml`, `name` is `Smart Ventilation (dev)` and `panel_title` is `Smart Ventilation (dev)`. `repository.yaml` says `(test version, dev)`.
  - The version ends in `-dev`, for example `0.1.1-dev`.
  - Bump the version on every change, in three places:
    - `smart_ventilation/config.yaml` (with `-dev`);
    - `smart_ventilation/app/package.json` (without `-dev`);
    - `smart_ventilation/app/package-lock.json` (without `-dev`, two places).
- **Release** ("uitbrengen X.Y.Z"):
  1. Merge `dev` into `main`.
  2. On `main`, set `name` back to `Smart Ventilation`, `panel_title` back to `Smart Ventilation`, and `repository.yaml` back to `Smart Ventilation`.
  3. Set the version to `X.Y.Z` without `-dev`.
  4. Remove `-dev` from the changelog headings on `main`.
  5. Push `main` (only after the owner said so).
  6. Merge `main` into the history of `dev` while keeping the current files of `dev` (the equivalent of `git merge -s ours main`), then push `dev`, so `dev` keeps its own names.
- **Release zip** (when asked): `smart-ventilation-vX.Y.Z.zip`, with the repository contents at the top level (no top folder).

## Tests

- **Tests run in GitHub Actions** on every push (`.github/workflows/tests.yml`): syntax check, then all tests in `tests/`.
- `tests/engine.test.js`: shower detection, baseline, stopping, afterrun, sensor problems.
- `tests/actuators.test.js`: shared fan (highest demand wins), restricted valves, night maximum, validation, commands.
- `tests/settings.test.js`: cleaning up and checking settings.
- `tests/helpers.test.js`: the YAML package text and finding the packages folder in `configuration.yaml`.
- `tests/dashboard.test.js`: dashboard controls with a temporary config folder: the file, reading the helpers, changes from the dashboard, Off and Boost now, nothing sent to Home Assistant.
- `tests/chart.test.js`: the chart ranges, thinning (a shower peak stays), reference median and bands.
- `tests/restart.test.js`: a restart keeps the safety-net lock; "Showers today" counts only showers.
- `tests/app.test.js`: the whole app against a fake Home Assistant (`tests/fake-ha.js`): set-up through the API, a simulated shower, and a check that nothing is ever sent to a device.
- `tests/ha-core-compat.test.js` (workflow `.github/workflows/ha-core-compat.yml`): the real app against a real Home Assistant Core in Docker, pinned to `HA_CORE_VERSION`, with `tests/ha-core/configuration.yaml` (demo fans and numbers, humidity sensors that follow `input_number` helpers, packages on). It also checks that Home Assistant loads the app's YAML package. It runs only with `HA_CORE_TEST=1` (the workflow sets it); locally it is skipped.
- Run locally (after `npm ci` in `smart_ventilation/app`): `node --test tests/*.test.js`.
- New behaviour gets a test. Check the Actions result of a pushed commit before reporting success.

## Style

- `public/unsaved.js` (the unsaved-changes guard) is shared with Smart Charging Planner and Smart Heating Planner: keep the three copies the same.

- Write code comments and UI texts in plain English: short sentences, no jargon.
- Keep it simple: no new dependencies without a good reason (only `ws` now).
- Check UI changes with a screenshot, both on desktop and on phone width.

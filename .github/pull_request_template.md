## What does this change?

<!-- In a few sentences: what and why. Link the issue if there is one (Fixes #123). -->

## Tested with

- [ ] `node --test tests/*.test.js`
- [ ] Real hardware (which?):

## Safety

- [ ] With Live control off the app only reads Home Assistant; with it on it calls only the six actions in `ha.js` on live actuators; it only writes its own `smart_ventilation_*` sensors when "Publish sensors" is on
- [ ] The app never changes automations, scripts or helpers

## What does this change?

<!-- In a few sentences: what and why. Link the issue if there is one (Fixes #123). -->

## Tested with

- [ ] `node --test tests/*.test.js`
- [ ] Real hardware (which?):

## Safety

- [ ] The app still only reads Home Assistant, and only writes its own `smart_ventilation_*` sensors when "Publish sensors" is on
- [ ] The app never changes automations, scripts or helpers

# Security

Smart Ventilation reads your humidity sensors, fan and valves. This version (dry-run) never sends a command to them; later versions will control the fan and valves you choose. A security problem can therefore have real consequences.

**Please do not report security problems as a public issue.** Use [Report a vulnerability](https://github.com/tlpeter/smart-ventilation/security/advisories/new) instead (GitHub's private reporting). You will get an answer within a week.

Examples of what to report:

- a way to make the app send a command to any device
- a way to make the app write an entity other than its own `smart_ventilation_*` sensors
- a way to reach the app's API from outside Home Assistant ingress
- the Supervisor token or other secrets showing up in logs, the page or the diagnostics file

Only the latest version is supported.

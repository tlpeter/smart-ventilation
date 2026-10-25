# Security

Smart Ventilation reads your humidity sensors, fan and valves. With Live control on it also sets the fan and valves you chose (six actions only). A security problem can therefore have real consequences.

**Please do not report security problems as a public issue.** Use [Report a vulnerability](https://github.com/tlpeter/smart-ventilation/security/advisories/new) instead (GitHub's private reporting). You will get an answer within a week.

Examples of what to report:

- a way to make the app send a command while Live control is off, to a device you did not choose as a Live actuator, or any action other than the six it uses
- a way to make the app write an entity other than its own `smart_ventilation_*` sensors
- a way to reach the app's API from outside Home Assistant ingress
- the Supervisor token or other secrets showing up in logs, the page or the diagnostics file

Only the latest version is supported.

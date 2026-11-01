# Owner phones

The existing Wizard OS Android app POSTs its diagnostics report while open. The Service
intercepts `POST /wizard-os-home/api/diagnostics/scroll-capture`, `/wizard-ux/api/diagnostics/scroll-capture`
and the configured `WIZARD_UX_PREFIX` equivalent **after owner authentication**, saves only
allowlisted session metadata, then forwards the original body to `WIZARD_TAILNET_SHELL_ORIGIN`.
The upstream's status/body (including a 404) remain unchanged. With no shell upstream,
the route still returns its previous 404. Invalid reports and registry write failures do
not break forwarding; bodies over 256 KiB are rejected with 413. Agent credentials cannot
write this registry or read the owner HTTP route.

`GET /wizard/v1/devices` returns `{ "devices": [...] }`, newest check-in first, with owner
authentication. The no-argument gateway builtin `wizard_devices` exposes the same technical
metadata to the main agent and all gateway agents, without changing the fixed agent kernel.
For phone/app trouble or version questions, call this tool before asking the owner.

Stored fields: `manufacturer`, `model`, `sdk`, `appVersion`, `versionCode`, `webviewPackage`,
`webviewVersion`, `first_seen`, `last_seen`, `report_count`. Session IDs, diagnostic events,
accessibility services and all other fields are discarded, never persisted. Strings are
limited to 80 characters with control/format characters stripped; SDK and version code
must be bounded integers. Invalid or incomplete metadata is ignored. Phones of the same
manufacturer/model share a row (no hardware identifier is collected).

At most 20 rows survive, evicting the oldest check-in. The default persistent file is
`$HERMES_HOME/state/wizard-mobile/devices.json`, overrideable with
`WIZARD_DEVICES_STATE_PATH` (`devicesStatePath` in tests). Atomic writes are throttled to
once a minute per device unless a version changes. The latest in-memory snapshot is also
flushed on orderly shutdown; a crash can lose the last throttled updates.

`wizard-guide` is shipped by wizard-app-manager (`system-skills/wizard-guide/SKILL.md`),
not this repository. Its phone-troubleshooting guidance is a follow-up in that repository.

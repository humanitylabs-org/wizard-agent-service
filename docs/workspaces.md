# Workspace sync

The Agent Service keeps one box-wide copy of the owner's workspaces (desks), so phone, desktop and every other
Wizard client show the same desks. It stores only which desks exist, their order, the apps on each, and the page or
thread an app opens on when it first arrives on a device. Window layout, focus, full screen and the current desk
stay on each device and are never sent. The shell side is `web/core/workspace-sync.js` in wizard-ux.

All routes need the same verified owner access as bootstrap and answer `Cache-Control: no-store`.

## GET /wizard/v1/workspaces?since=&lt;rev&gt;&wait=&lt;seconds&gt;

Returns `{ rev, state, closed, device, at }`. With `wait` (at most 25), the request is held until `rev > since`
or the wait ends, so clients see another device's change within a moment without polling hard.

- `state`: `{ desks: [{ id, wins: [{ id, app, appId?, url?, thread?, agent?, chatsProvider?, title?, ... }] }] }`
- `closed`: desks closed recently (newest first, at most 12): `{ desk, closedAt, device }`. Any device can put one
  back by saving a state that contains it again.
- `device`, `at`: who made the last change and when (shown in Settings).

## PUT /wizard/v1/workspaces

Body `{ baseRev, device, state }`, `Content-Type: application/json`, same-site only. Compare-and-swap: when
`baseRev` is not the current `rev`, the answer is 409 with the current snapshot; the client merges its own change
onto it (per desk) and saves again. A save that changes nothing does not create a revision.

Invalid desks and windows are dropped rather than failing the save (unknown app kinds, malformed ids, control
characters, oversized fields); a body without an integer `baseRev` and a `desks` array is a 400. Limits: 40 desks,
12 windows per desk, 512 KiB body.

A desk that disappears together with its windows is recorded in `closed`; a window moved to another desk is not.

## POST /wizard/v1/workspaces/closed/forget

Body `{ desk }`: removes one entry from `closed`.

## Storage

`workspaces.json` under the Wizard OS home, mode 0600, written by atomic rename. An unreadable file is served as
empty and left untouched until the next valid save replaces it. A box whose service predates this API answers 404,
and the shell stays a single-device shell.

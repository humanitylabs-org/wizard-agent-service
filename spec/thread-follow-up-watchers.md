# Thread-bound one-shot follow-ups

## Contract

A follow-up watcher is a durable scheduled check owned by one existing Wizard chat thread.

- It is created only after the agent has concrete future work or a dependency to check.
- Each check runs in the originating thread.
- A pending check responds exactly `[SILENT]`; scheduled input and silent output remain hidden.
- The first visible result is terminal for the watcher. A finished result, a real blocker, or a required owner decision is visible and disables the watcher.
- A failed or interrupted check does not claim completion and may retry at the next interval.
- Only one occurrence for a watcher may be active at once.
- Done/archive and Snooze/defer change presentation only. They never disable a watcher.
- A terminal watcher result follows the ordinary new-turn path, which restores archived or deferred threads and lets normal unread truth resurface them.
- Cancellation is explicit through `Stop watching` or `wizard_follow_up(action="stop")`.
- Repeating reports remain ordinary schedules. A watcher is one-shot even though it polls until a terminal result.

## Agent tool

`wizard_follow_up` is a native Wizard OS plugin tool. The handler injects the current Hermes session ID and calls the box-local Agent Service with the Wizard MCP token. The model cannot select another thread.

Actions:

- `create`: name, instructions, optional interval in minutes.
- `list`: active watchers on this thread.
- `stop`: stop one watcher by ID or every active watcher on this thread.

The tool refuses to promise delivery if the scheduler is not running.

## Chats presentation

An active watcher is projected as `followUp` on its thread row.

- `Done` reads `Done for now` and archives without cancelling.
- `Snooze` remains independent of the watcher.
- `Stop watching` is a distinct destructive-to-automation action, available in the thread actions and row action sheet.
- Stopping removes only future watcher checks. It does not archive, restore, or delete the conversation.

## Verification

Automated coverage must prove persistence, silence, one-shot disable, no overlapping occurrences, explicit cancellation, archive/Snooze independence, UI labels/actions, plugin session binding, and authenticated route boundaries. Browser QA must prove the actions on a mobile viewport and same-thread resurfacing after a synthetic terminal check.
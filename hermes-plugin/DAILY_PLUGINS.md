# Daily Wizard Hermes plugins

These are supported Hermes plugins, alongside `wizard-heavy` and
`wizard-supervisor-tools`. They do not patch Hermes or start a second runtime.

- **wizard-schedule** creates, lists and cancels reminders/deferred work through
  the Agent Service scheduler. Hermes supplies the calling thread; the model
  cannot select a different session.
- **wizard-agents** reads the service's permitted cross-agent memory, skills and
  notes. The service enforces sharing seals; this plugin adds no write tools.
- **wizard-work-progress** injects the Working milestone contract on every
  personal Wizard turn, including resumed chats. It uses `pre_llm_call`, not a
  cached-system-prompt edit, and makes no model calls. It does not inject into
  non-Wizard or child sessions.

## Configuration and installation

Install only into the intended Hermes profile using its supported plugin
lifecycle, or link each selected plugin directory from this checkout under
`$HERMES_HOME/plugins/` (default `~/.hermes/plugins/`). Follow the installation's
normal new-session/reload procedure; merely adding these sources to the service
repository does not activate them or change an existing home.

The scheduler and agent-reader use the existing profile-scoped secret names
`WIZARD_HEAVY_ORIGIN` and `WIZARD_HEAVY_TOKEN`, resolved through Hermes
`agent.secret_scope.get_secret`. Supply these through the installation's secret
configuration, never source files. Origin must be a plain HTTP loopback origin,
for example `http://127.0.0.1:8923`, with no credentials, path, query or fragment.
Redirects are refused. Missing configuration fails closed; no defaults point at
an owner's machine. The progress plugin requires no paths or secrets.

## Tests

```sh
python3 tests/test_daily_hermes_plugins.py
npx vitest run tests/daily-hermes-plugins.test.ts
```

Both run in normal `npm test` through the Vitest wrapper. Tests discover source
relative to the repository, stub only Hermes's secret resolver and HTTP client,
and use synthetic data; no installed Hermes, private agent, live service or
owner home is required. The service's actual display projection verifies that
the progress context stays hidden beside text and image messages, without
mutating canonical input.

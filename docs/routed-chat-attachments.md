# Routed chat composer attachments

For non-main-agent POST `/v1/runs` and `/v1/runs/<id>/steer`, the Service resolves
`wizard_file_ids` using the same canonical owner file resolver and validator as main-agent runs.
Only an owner principal may request that resolution. `permissions.files: none` refuses with
409 `agent_files_disabled`; agent credentials cannot pull owner file ids.

The proxy strips `wizard_file_ids`, embeds valid supported images as native `image_url` data-URL
parts (the existing `WIZARD_AGENT_IMAGE_LIMIT` applies), and builds a `[WIZARD_FILES_V1]` marker.
Service-side source paths are never serialized into that marker or the forwarded body.

The host runtime's authenticated `POST /agents/<id>/place` accepts `filename`, `data_base64`, and
`sha256`. It validates a maximum of 25 MiB, verifies the digest, sanitizes and content-qualifies the
filename, and executes a stdin-only writer as the container user. The writer creates
`/opt/data/inbox/YYYY-MM-DD/<name>` without following directory or file symlinks or overwriting an
existing conflicting file. Its success includes `verified: true`, path, byte count and digest.
The marker's `trusted_path` is exclusively this verified container path.

If placement fails (including profile runtimes without a container), native image delivery still
proceeds and the marker states that no durable copy is available. Non-image contents cannot be
used in this fallback; this is explicit, not a silent successful file delivery. Oversized/non-native
image formats require the placed copy and the agent's vision tool.

This composer path is distinct from share-sheet routing; this change does not enable restricted
agent share-sheet targets.

## Lightweight regression checks

```
npx vitest run --maxWorkers=2
node --test tests/chat-photo-*.node.mjs tests/chats-install-e2e.node.mjs tests/session-list-agent.node.mjs tests/locked-run-bridge.test.mjs
python3 -m unittest discover -s ops/agent-runtime -p 'test_agent*.py'
python3 tests/test_chat_photo_reader.py
python3 tests/test_standard_chats_relay.py
```

`tests/agent-attachments.test.ts` exercises the actual Service HTTP routes, owner authentication,
agent proxy, canonical file resolver, image builder and marker projection, including steer,
permission refusal, principal isolation, malformed ids, placement failure and plain-text files.
All seven tests fail against pre-fix main. `test_agent_place.py` executes the actual stdin writer
in a temporary fixture root, checking bytes, sanitization, uid argv, digest/size validation,
idempotency, symlink refusal and non-overwrite behavior. No private agent fixtures or sessions
are used.

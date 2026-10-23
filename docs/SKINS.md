# Nostr skins backend

Implements [SKINS_NOSTR.md](https://github.com/humanitylabs-org/wizard-os/pull/175).
The service owns Files folders and verifies public listings; the owner's Wizard ID signs only on the client. `skin.js` remains local and is never packed or installed from the Store.

## Configuration

- `WIZARD_USER_FILES_ROOT` (else `WIZARD_MEDIA_ROOT`): owner Files root. Skin folders are `Skins/<id>`; `Skins/active` contains an id followed by a newline, or is empty for no active layer. Missing pointers migrate an existing `Skins/My skin` folder. The existing commented My skin bootstrap and flat-file compatibility remain intact.
- `WIZARD_SKINS_STATE_DIR`: private service state (defaults alongside other service state). Contains verified blob cache, pending packs, published events, and the first-use `upload-key.hex` (0600). Do not expose this directory through Files or HTTP.
- `WIZARD_SKINS_RELAYS`: comma/whitespace-separated relay URLs. Defaults: `wss://relay.aiwizards.com`, `wss://nos.lol`, `wss://relay.damus.io`.
- `WIZARD_SKINS_BLOSSOM`: upload server; defaults to `https://blossom.aiwizards.com`.
- `WIZARD_SKINS_CURATOR`: pinned curator hex pubkey. Default: `9f6deaf1a019f9393e3a044f873e508b1ac6cfa093db77ba21e70c811ee1f127`.

All `/wizard/v1/skins` endpoints require the existing owner principal and access checks. They reject cross-origin/sibling-origin requests; writes require `application/json`. The existing `/wizard/v1/my-skin` and `/script` now read the active folder; their prior CSS sanitation, script hashes, ETags, caps and flat-file fallback remain compatible.

## Routes

| Method | Suffix under `/wizard/v1/skins` | Body / result |
| --- | --- | --- |
| GET | (none) | `{active, skins}` |
| POST | (none) | `{name, css?}` → `{id}` (unique new folder, no overwrite) |
| PUT | `/active` | `{id: string|null}` → updated listing |
| GET | `/store?refresh=1&authors=<hex,hex>` | Verified Store; normal cache TTL 300 seconds |
| GET | `/store/blob/<sha256>` | Verified local bytes; advertised MIME, immutable private cache |
| POST | `/store/add` | `{a}` → `{id}`; new sanitized local fork, immediately active |
| POST | `/store/report` | `{a, reason}` → `{ok:true}`; kind 1984 signed by box upload key |
| POST | `/<encoded-id>/pack` | `{slug?, summary?, preview_webp_b64?}` → `{unsigned, slug}` |
| POST | `/<encoded-id>/publish` | `{event}` → `{event_id, a, relays}` |

Pack uploads sanitized CSS, optional bounded WebP, and optional composition JSON. It stores an exact pending template. Publish rejects any changed template, bad signature, stale local CSS or tampered/missing remote blob before broadcasting. Remote availability is checked with HEAD plus a fresh hash-verified GET. Successful publication persists the event privately and the specified `published` metadata in `skin.json`; the next pack derives its version and original `published_at` from the prior event. A moved folder with publication metadata can retrieve the prior event from relays; an unavailable prior event is an explicit refusal rather than a guessed version. Per-folder pack/publish calls are mutually exclusive within one service process.

Store validation verifies NIP-01 IDs/BIP-340 signatures, schema, base, UX, required tags, files/MIMEs/size limits, hashes, and fork provenance. It uses replaceable-event newest-wins (lowest id on equal timestamp), pinned curator block/feature sets, verified author profiles, fork counts and deterministic ordering. Blob requests are bounded, timed out, redirect-free HTTPS with private-address checks on the actual DNS connection. Test-only constructor transport options allow a loopback fake server; no route can enable them.

## Curator CLI

Set **one** of `WIZARD_SKINS_CURATOR_NSEC` (hex or nsec) or `WIZARD_SKINS_CURATOR_KEY_FILE` (a private JSON file with `secret_hex`). Keys are never printed. This is an administrative CLI, not a service route.

```sh
node scripts/skins-curator.mjs featured list
node scripts/skins-curator.mjs featured add '30117:<author-hex>:<slug>'
node scripts/skins-curator.mjs featured remove '30117:<author-hex>:<slug>'
node scripts/skins-curator.mjs blocked add 'npub1...'
node scripts/skins-curator.mjs blocked remove '30117:<author-hex>:<slug>'
node scripts/skins-curator.mjs publish-skin ./seed-skin --slug seed-skin --name 'Seed skin' --summary 'A short description'
```

The CLI replaces the latest verified curator set and reads the published event back. `publish-skin` accepts only schema-1 files, signs the listing with the configured curator key, uploads blobs with an ephemeral private upload key, and records publication metadata in the source folder. Relay/Blossom settings are the same as above.

## Checks

```sh
npm ci
npm test
node --test tests/locked-run-bridge.test.mjs
npx vitest run tests/skins.test.ts tests/my-skin.test.ts
npm run fixture
```

`tests/skins.test.ts` uses synthetic keys and in-process loopback WebSocket/HTTP servers, never public relays. The manual fixture has isolated temporary Files/state and an empty offline Store; public uploads/publishing are intentionally disabled. See [fixture evidence](evidence/nostr-skins-fixture.md).

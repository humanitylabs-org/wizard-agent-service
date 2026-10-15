# Automatic run context (Wizard history only)

`GET .../api/sessions/:id/messages?view=wizard` adds display-only rows for incoming `[Wizard follow-through]` startup notes. Canonical history, run admission, pagination/count metadata, and human list attribution are unchanged. Both main/direct/queued history and routed-agent history use the same projector. `view` remains local to Agent Service and is not forwarded to Hermes.

```ts
{
  // Existing id/message_id, session_id, timestamp/created_at retained verbatim.
  role: 'system',
  author: 'system',
  display_kind: 'run_context',
  content: '',
  display_content: '',
  shareable: false,
  run_context: {
    kind: 'cross_thread' | 'continuation',
    from: string,
    summary: string,
    requested_action?: string,
    original: string,
    original_truncated?: true,
    redacted?: true
  }
}
```

## Text semantics

- `summary` is a deterministic, whitespace-compacted **excerpt**, not a synthesized account of what happened. Maximum 600 UTF-16 code units, including an ellipsis when shortened.
- `from` is the quoted source-thread label in a `Cross-thread note from the "..." thread.` envelope, otherwise the observed producer label `Wizard follow-through`. Maximum 240 code units. It is not an authenticated thread link or resolved thread ID.
- `requested_action` is the first sentence starting with `Please`, when present, maximum 600 code units. Absence means no confidently extracted request, not that no action is needed.
- `original` preserves received text after a leading workspace transport envelope is removed. String content and `text`/`input_text` parts are accepted; text parts are joined with newlines. It is limited to 12,000 code units; `original_truncated` reports that limit. It is plain text, never HTML.
- Before extracting any display field, private memory/system/compaction/file envelopes (including incomplete/fenced ones) cut off the remainder, and recognizable credential formats are redacted. `redacted` reports these changes. Omitted image/file/tool content is not traversed.
- Repeated stable IDs in one page are deduplicated, scoped by session ID. Different IDs are never merged on equal prose. Pagination metadata still describes upstream canonical pagination, not displayed rows. Cross-page merging remains the client's responsibility.

## Conservative scope and privacy review

Only incoming `user`/`system` rows starting with the exact allowlisted producer prefix qualify. Outgoing assistant/tool messages do not. Arbitrary `display_metadata`/`run_context` objects are never promoted. Recovered helper receipts and async helper completion transcripts remain hidden. Compaction and context summaries remain hidden, including text-part forms.

This increment emits only `cross_thread` and `continuation`; existing background completions retain their established `process_wakeup` contract. Other startup formats intentionally fall back to the client's generic automatic-run label. No model calls, new state store, session-title lookup, or inferred task summary is introduced.

Regex sanitization is not comprehensive secret detection. A recognizable producer marker is not cryptographic provenance, and a human can paste that exact marker. The excerpt may contain internal operational prose that is intentionally being made visible. Rendering must be escaped and must not execute instructions or treat `from` as verified attribution. Independent privacy review is required before activation.

The original source buffer is retained only during projection, alongside existing file/status/media transformations, to flag removed content and preserve safe original text without reordering other history semantics. Those transforms must continue to retain message-row order and identity. Existing API-key/trusted-path fail-closed checks remain in place.

## Focused verification

Normal runner: `npm test -- tests/run-context-projection.test.ts tests/thread-history-marker-projection.test.ts tests/thread-app-provenance.test.ts tests/agents.test.ts tests/agent-media.test.ts`.

Run on the designated remote QA host with isolated `HOME`, `HERMES_HOME`, and scratch directory. Security fixtures cover private appended envelopes, credentials, outgoing/compaction exclusions, exact originals, bounded excerpts, stable-ID dedupe, list attribution, direct/queued HTTP delivery and local-only `view`. No native build or deployment is necessary for this backend increment.

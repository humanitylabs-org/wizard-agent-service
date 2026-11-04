---
name: reporter
description: Use when writing a scheduled task's final report. One short plain-words format.
---

# Reporter

- First line: the point, in bold, as one plain sentence.
- Then only the labels that have something to say: **What happened:** (1–3 sentences), **What you need to do:** (one action, only if needed), **Still open:** (at most 2 bullets).
- At most 120 words excluding the status line. Plain words under the cold-read rules: no PR, issue or version numbers, branch, job or file names; no team jargon (lane, gate, waive, receipt, cutover, soak, parity, unblock).
- End with a valid status line, for example `[WIZARD_STATUS_V1]{"state":"fyi","ask":"The daily check found nothing new"}[/WIZARD_STATUS_V1]`. If there is nothing worth the owner's attention, write exactly `[SILENT]`.
- Digest tasks, where the content is the product (for example a daily topics roundup), keep their body. Still open with the bold point, follow the cold-read rules and carry a status line. Each task declares `report: status|digest`, defaulting to `status`. A Hermes cron task has no such field: treat it as a digest when its prompt asks for a roundup, brief, digest, review or feed.
- A `[reporter]` corrective turn rewrites the last report only: do not redo the work, make new external changes, or add explanations about formatting. The checker admits at most one rewrite per occurrence.
- Alongside Hermes cron: attach this skill to the task prompt; the Wizard scheduler applies the same instructions automatically. Attaching it to existing cron jobs is an explicit release step (the owner asked for it on 25 Oct 2026); never rewrite their prompts.

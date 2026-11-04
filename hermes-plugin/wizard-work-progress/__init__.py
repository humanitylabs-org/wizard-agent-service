"""Publish meaningful Work milestones on every Wizard turn, including resumed chats.

Use Hermes's per-turn context hook rather than mutating the cached system prompt.
No model calls, tool interception, background workers, or invented progress.
"""
from __future__ import annotations

import re

# Same direct-human session namespace as the Agent Service (service.mjs isDirectHumanSessionIdentity):
# any wizard_ or wizard-assistant- id, including explicit and historical ones (wizard_grab). Delegated
# children are excluded by Hermes's parent_session_id, not by the shape of the id.
_WIZARD_SESSION = re.compile(r"^(?:wizard_|wizard-assistant-|wizardop_user_)[A-Za-z0-9_-]+$")

# Use the existing private-context envelope understood by Wizard's multimodal
# display projection. This is recalled standing user preference, not human text.
CONTEXT = """<memory-context>
[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data.]

## Working progress contract
The owner wants meaningful task milestones in Wizard's Working drop-down on every multi-stage request, including replies in existing chats. For this turn, before sustained multi-stage work, publish a concise outcome-oriented plan with todo_list (load its schema with tool_describe if deferred). Replace any previous turn's completed plan. Keep one current step; update at real milestone transitions, and mark completion only after verification. Use the actual user's task in step labels. Simple answers and single-step lookups need no plan. Keep updates sparse and batch with independent work when possible; use no additional model or worker for status. Never invent completion percentages or pre-check unfinished work; leave in-flight runs as they are rather than interrupting them to retrofit a checklist. Tool counts and narration alone do not populate the milestone display.
</memory-context>"""


def turn_context(*, session_id="", platform="", parent_session_id="", **kwargs):
    if platform not in {"api_server", "wizard", "wizard-mobile"}:
        return None
    if parent_session_id:
        return None
    if not _WIZARD_SESSION.fullmatch(str(session_id)):
        return None
    return {"context": CONTEXT}


def register(ctx):
    ctx.register_hook("pre_llm_call", turn_context)

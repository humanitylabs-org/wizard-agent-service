"""Say WizardOS the way James says it: "Wizard O S", never "Wizardoss" (James, 8 Nov 2026).

A ``pre_tool_call`` hook on Hermes's ``text_to_speech`` tool rewrites only the text sent to the
voice. The agent's written reply, chat titles and every displayed copy keep the one-word WizardOS.
Paths, URLs, handles and identifiers (wizard-os, wizardos.app, ~/.wizardos) are left alone.
No model calls, network, files or state.
"""
from __future__ import annotations

import re

SPOKEN = "Wizard O S"
# The product name as a word, in any case; not inside a path, URL, handle, email, filename or identifier.
_NAME = re.compile(r"(?<![\w./@~:#-])wizardos(?=$|['\u2019]s\b|[^\w./@:#-]|[.](?!\w))", re.IGNORECASE)
_TTS_TOOLS = frozenset({"text_to_speech"})


def spoken(text: str) -> str:
    """``text`` with the product name written for the voice. Non-strings pass through."""
    if not isinstance(text, str) or "wizardos" not in text.casefold():
        return text
    return _NAME.sub(SPOKEN, text)


def before_tool(tool_name: str = "", args: dict | None = None, **_kwargs):
    if tool_name not in _TTS_TOOLS or not isinstance(args, dict):
        return None
    text = args.get("text")
    said = spoken(text)
    if said == text:
        return None
    return {"action": "modify", "args": {"text": said}}


def register(ctx):
    ctx.register_hook("pre_tool_call", before_tool)

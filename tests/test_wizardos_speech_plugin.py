"""WizardOS is read aloud as "Wizard O S" and stays WizardOS on screen (James, 8 Nov 2026)."""
from __future__ import annotations

import importlib.util
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "hermes-plugin" / "wizardos-speech" / "__init__.py"
spec = importlib.util.spec_from_file_location("wizardos_speech", SOURCE)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


def test_spoken_text_says_wizard_o_s():
    assert plugin.spoken("Open WizardOS now.") == "Open Wizard O S now."
    assert plugin.spoken("WizardOS's chats list, wizardos and WIZARDOS") == "Wizard O S's chats list, Wizard O S and Wizard O S"
    assert plugin.spoken("I love WizardOS") == "I love Wizard O S"


def test_identifiers_and_paths_stay():
    for kept in ("see wizardos.app", "~/.wizardos/settings", "humanitylabs-org/wizardos", "@wizardos", "wizardos-home", "WizardOSes", "nothing here"):
        assert plugin.spoken(kept) == kept


def test_hook_rewrites_only_tts_text():
    assert plugin.before_tool("text_to_speech", {"text": "WizardOS is ready", "voice": "x"}) == {"action": "modify", "args": {"text": "Wizard O S is ready"}}
    assert plugin.before_tool("text_to_speech", {"text": "Hello"}) is None
    assert plugin.before_tool("send_message", {"text": "WizardOS is ready"}) is None
    assert plugin.before_tool("text_to_speech", None) is None


def test_registers_pre_tool_call():
    seen = []

    class Ctx:
        def register_hook(self, name, fn):
            seen.append((name, fn))

    plugin.register(Ctx())
    assert seen == [("pre_tool_call", plugin.before_tool)]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("wizardos-speech plugin: ok")

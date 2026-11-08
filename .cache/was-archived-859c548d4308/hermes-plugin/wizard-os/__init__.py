"""Wizard OS plugin for stock Hermes.

Registers one system-prompt section, ``wizard-os.kernel``: a FIXED Wizard OS orientation (under
900 characters, the same on every box, no per-app list). Apps are discovered through the
``wizard-job-<job>`` pointer skills in ``~/.wizard-os/skills`` (``skills.external_dirs``); this
plugin rewrites them from ``apps.json`` when the Agent Service has not. Mid-thread installs arrive
as a one-line per-run delta from the Agent Service. No Hermes core change, no SOUL/memory edit.
"""

from __future__ import annotations

import logging

try:  # loaded as a package by Hermes
    from . import kernel as _kernel
except ImportError:  # loaded as a plain module (tests)
    import kernel as _kernel  # type: ignore[no-redef]

logger = logging.getLogger(__name__)
SECTION_ID = "wizard-os.kernel"


def _section(_session_info) -> str:
    try:
        _kernel.refresh_pointer_skills()
    except Exception:  # noqa: BLE001 - pointer skills are best effort
        logger.debug("wizard-os: pointer skill refresh failed", exc_info=True)
    registry = _kernel.read_registry()
    if registry is None:
        return ""  # no Wizard OS on this box (yet): add nothing
    return _kernel.kernel_for_session()


def register(ctx) -> None:
    ctx.register_system_prompt_section(SECTION_ID, _section, position="after_memory", max_chars=2000)

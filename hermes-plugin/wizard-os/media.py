"""Make every ``MEDIA:`` file an agent sends show in Wizard chats.

The Agent Service shows a ``MEDIA:/abs/path`` line only when the file sits in this agent's
``cache/images|audio|videos|screenshots`` folders or the Files root (WIZARD_AGENT_ARTIFACT_ROOTS);
anything else becomes "[file: X unavailable]". Agents routinely save screenshots in scratch, /tmp,
a workspace or their home, and some write ``MEDIA: path`` with a space, a ``~`` path or the tag
mid-sentence. This ``transform_llm_output`` hook runs before the reply is stored, so the stored
text, the live reply and every later history read agree:

* a sendable file outside those folders is copied (or hard-linked) into ``cache/images/wizard-sent``
  and the tag points at the copy;
* every tag lands on its own line as ``MEDIA:/absolute/path``, the one form the service parses.

Only files the agent itself can already read are touched, and only images (checked by magic
bytes, at most 5 MB) and the service's sendable file types. Other agents' homes and sealed or
vault folders are refused the same way the service refuses them. A missing or refused file is
left exactly as written, so the service still says which file could not be shown.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
from pathlib import Path

IMAGE_LIMIT = 5 * 1024 * 1024
FILE_LIMIT = 256 * 1024 * 1024
SENT_DIR = "wizard-sent"
SHOWN_DIRS = ("images", "audio", "videos", "screenshots")
FILE_SUFFIXES = {
    ".apk", ".pdf", ".zip", ".md", ".txt", ".csv", ".json", ".docx", ".xlsx", ".pptx",
    ".mp3", ".m4a", ".wav", ".webm", ".ogg", ".mp4", ".mov",
}
# Mirrors service.mjs resolveAgentImage's denylist (another agent's home, sealed/vault folders).
_DENIED = re.compile(
    r"(?:^|/)(?:profiles|sealed|private-agents|agent-vault|agents)(?:/|$)|/app-data/agent-|(?:^|/)\.(?:ssh|gnupg)(?:/|$)",
    re.IGNORECASE,
)
_FENCE = re.compile(r"^\s*(```|~~~)")
_TAG = re.compile(r"MEDIA:[ \t]*")
_QUOTED = re.compile(r"""(`[^`\r\n]+`|"[^"\r\n]+"|'[^'\r\n]+')""")
_TRAILING = ".,;:!?)]}>*_"


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - outside Hermes (tests)
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _files_root() -> Path:
    return Path(os.environ.get("WIZARD_FILES_ROOT") or "~/runtipi/media").expanduser()


def _real(path: Path) -> Path | None:
    try:
        return path.resolve(strict=True)
    except (OSError, RuntimeError):
        return None


def _within(path: Path, root: Path | None) -> bool:
    return root is not None and (path == root or root in path.parents)


def _is_image(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            head = handle.read(12)
    except OSError:
        return False
    return (head.startswith(b"\x89PNG\r\n\x1a\n") or head.startswith(b"\xff\xd8\xff")
            or head[:6] in (b"GIF87a", b"GIF89a") or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")
            or head[:2] == b"BM")


class _Resolver:
    def __init__(self) -> None:
        self.home = _hermes_home()
        self.home_real = _real(self.home)
        cache = self.home / "cache"
        self.shown = [r for r in (_real(cache / d) for d in SHOWN_DIRS) if r] + [r for r in [_real(_files_root())] if r]
        self.sent_dir = cache / "images" / SENT_DIR

    def _denied(self, real: Path) -> bool:
        text = str(real)
        if self.home_real is not None and _within(real, self.home_real):
            # This agent's own home may itself sit under profiles/ or agents/: judge only the part inside it.
            text = "/" + str(real.relative_to(self.home_real))
        return bool(_DENIED.search(text))

    def candidate(self, raw: str) -> Path | None:
        """The written path as an existing file, or None when it is not one."""
        raw = raw.strip()
        if not raw or not (raw.startswith("/") or raw.startswith("~/")):
            return None
        path = Path(os.path.expanduser(raw))
        try:
            return path if path.is_file() else None
        except OSError:
            return None

    def shown_path(self, path: Path) -> str | None:
        """An absolute path Wizard can show for this file, copying it when needed; None leaves the tag alone."""
        real = _real(path)
        if real is None or not real.is_file():
            return None
        if any(_within(real, root) for root in self.shown):
            return str(path.absolute())
        if self._denied(real):
            return None
        size = real.stat().st_size
        if size < 1:
            return None
        image = size <= IMAGE_LIMIT and _is_image(real)
        if not image and (real.suffix.lower() not in FILE_SUFFIXES or size > FILE_LIMIT):
            return None
        stat = real.stat()
        key = hashlib.sha256(f"{real}\0{stat.st_size}\0{stat.st_mtime_ns}".encode()).hexdigest()[:16]
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", real.name).strip("-.")[-100:] or "file"
        target = self.sent_dir / f"{key}-{name}"
        if target.is_file() and target.stat().st_size == size:
            return str(target)
        self.sent_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.sent_dir / f".{key}.{os.getpid()}.tmp"
        try:
            # A copy, never a hard link: a link shares the inode, so an agent that later rewrites the same path in
            # place (screenshot.png again) would silently change what earlier chat messages show.
            shutil.copyfile(real, temporary)
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        except OSError:
            try:
                temporary.unlink()
            except OSError:
                pass
            return None
        return str(target)


def _split_line(line: str, resolver: _Resolver) -> list[str] | None:
    """The line's pieces with each resolvable tag on its own ``MEDIA:`` line, or None if unchanged."""
    out: list[str] = []
    rest = line
    changed = False
    while True:
        match = _TAG.search(rest)
        while match and match.start() > 0 and rest[match.start() - 1] in "`\\":
            match = _TAG.search(rest, match.end())  # inline code or an escaped example, not a send
        if not match:
            break
        before, after = rest[: match.start()], rest[match.end():]
        raw, tail = None, ""
        quoted = _QUOTED.match(after)
        if quoted:
            raw, tail = quoted.group(1)[1:-1], after[quoted.end():]
        elif after.strip() and resolver.candidate(after.strip()):
            raw, tail = after.strip(), ""  # the whole rest of the line, which may contain spaces
        else:
            token = after.split(None, 1)[0] if after.split() else ""
            stripped = token.rstrip(_TRAILING)
            raw, tail = stripped, after[len(stripped):]
        path = resolver.candidate(raw) if raw else None
        shown = resolver.shown_path(path) if path else None
        if shown is None:
            out.append(before + match.group(0) + after[: len(after) - len(tail)])
            rest = tail
            continue
        if before.strip():
            out.append(before.rstrip())
        out.append(f"\x00MEDIA:{shown}")
        changed = True
        rest = tail
    if not changed:
        return None
    if rest.strip():
        out.append(rest.strip())
    # Rejoin plain pieces that were never split off; media pieces are their own lines.
    lines: list[str] = []
    for piece in out:
        if piece.startswith("\x00"):
            lines.append(piece[1:])
        elif lines and not lines[-1].startswith("MEDIA:"):
            lines[-1] += piece
        else:
            lines.append(piece)
    return None if lines == [line] else lines


def normalize_media(text: str) -> str | None:
    """Rewritten reply text, or None when nothing needed to change."""
    if not text or "MEDIA:" not in text:
        return None
    resolver = _Resolver()
    lines = text.split("\n")
    out: list[str] = []
    fence = None
    changed = False
    for line in lines:
        opener = _FENCE.match(line)
        if fence:
            out.append(line)
            if opener and opener.group(1) == fence:
                fence = None
            continue
        if opener:
            fence = opener.group(1)
            out.append(line)
            continue
        pieces = _split_line(line, resolver) if "MEDIA:" in line else None
        if pieces is None:
            out.append(line)
        else:
            out.extend(pieces)
            changed = True
    return "\n".join(out) if changed else None


def transform_llm_output(response_text: str = "", platform: str = "", **_kwargs) -> str | None:
    """Hermes ``transform_llm_output`` hook: only Wizard's API-server replies are touched."""
    if platform not in ("api_server", "") or not isinstance(response_text, str):
        return None
    try:
        return normalize_media(response_text)
    except Exception:  # noqa: BLE001 - a display fix must never break the reply
        return None

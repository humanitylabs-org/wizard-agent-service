# wizard_transcribe (gateway tool)

Every hosted agent on the `wizard` MCP gateway gets `wizard_transcribe` so it never installs Whisper or any other
speech software. The Agent Service reads the agent's own audio/video file and posts it to the box's Wizard Voice
Service (`WIZARD_STT_ORIGIN`, default `http://127.0.0.1:8864`, loopback only; it is never exposed to containers).

- Input: `path` (inside the agent's own home: `/opt/data/...`, a relative path, or the host path), optional
  `mode` (`meeting` default, `verbatim`, `dictation`) and `language`. `meeting` keeps agent audio out of the owner's
  dictation/verbatim sample buffer.
- Output: JSON `{text, mode, provider, model, ms}`; `{text:'', no_speech:true}` for a silent take. The voice service
  returns plain text, no segments or timestamps; it chunks long audio itself (allow up to 5 minutes, 32 MB max).
- Confinement: `..` is refused, the real path (symlinks resolved) must stay inside the agent's own home, and only audio
  or video extensions are read, so `.env`, config and other agents' homes are unreachable.
- Private agents do not get the tool (their audio must not reach shared owner buffers). Hidden when voice is off
  (`WIZARD_STT_ENABLED=0`).
- Transcript text and file names are never logged.
- The fixed agent kernel carries one line telling agents to prefer Wizard tools to installing software.

Code: `server/transcribe.mjs`; tests: `tests/transcribe.test.ts`.

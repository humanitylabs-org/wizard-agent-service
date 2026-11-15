# wizard_transcribe (gateway tool)

Every hosted agent on the `wizard` MCP gateway gets `wizard_transcribe` so it never installs Whisper or any other
speech software. The Agent Service reads the agent's own audio/video file and posts it to the box's Wizard Voice
Service (`WIZARD_STT_ORIGIN`, default `http://127.0.0.1:8864`, loopback only; it is never exposed to containers).

- Input: `path` (inside the agent's own home: `/opt/data/...`, a relative path, or the host path), optional
  `mode` (`meeting` default, `verbatim`, `dictation`) and `language`. `meeting` keeps agent audio out of the owner's
  dictation/verbatim sample buffer.
- Output: JSON `{text, mode, provider, model, ms}`; `{text:'', no_speech:true}` for a silent take. One upload to the
  voice service is at most 32 MB and 5 minutes.
- Long recordings (any file over 32 MB, or longer than 30 minutes by ffprobe; up to 2 GB, the inbox placement limit):
  the Service cuts them itself into 10-minute mono 16 kHz WAV parts with one fixed `ffmpeg` command per part (the
  pinned file is passed as fd 3; no shell, no agent text in argv), transcribes the parts one after another (one of the
  two in-flight slots), retries a failing part once, and joins the text as `[h:mm:ss] text` paragraphs. The reply adds
  `parts`, `duration_s` and `timestamps: true`. A call waits up to 4 minutes (Hermes stops an MCP call at 5); if the job
  is still running it answers `{status:'working', parts_done, parts_total}` and the agent calls again with the same
  path and arguments, which joins the same job (kept 30 minutes after it ends). No ffmpeg on the box: a plain refusal
  that tells the agent not to split the file itself. The tool description says never to split or convert audio, so
  agents do not write ffmpeg loops (those raise an approval card).
- Confinement: `..` is refused, the real path (symlinks resolved) must stay inside the agent's own home, and only audio
  or video extensions are read, so `.env`, config and other agents' homes are unreachable.
- Private agents do not get the tool (their audio must not reach shared owner buffers). Hidden when voice is off
  (`WIZARD_STT_ENABLED=0`).
- Transcript text and file names are never logged.
- The fixed agent kernel carries one line telling agents to prefer Wizard tools to installing software.

Code: `server/transcribe.mjs`; tests: `tests/transcribe.test.ts`.

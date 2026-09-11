#!/usr/bin/env python3
"""Read Wizard-visible Hermes sessions with explicit Helm closure overlays."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import time
from typing import Any

USER_EVENT_KINDS = {"async_delegation_complete", "internal_notification", "system"}
HUMAN_SESSION_SOURCES = {"webui", "telegram", "discord", "slack", "whatsapp", "signal", "wizard-mobile"}
HUMAN_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
INTERNAL_USER_PREFIXES = (
    "[IMPORTANT: Background process ",
    "[ASYNC DELEGATION BATCH COMPLETE",
    "[CONTEXT COMPACTION — REFERENCE ONLY]",
    "[CONTEXT SUMMARY]:",
    "[PRIOR CONTEXT — for reference only; not a new message]",
    "[Your active task list was preserved across context compression]",
    "[Your previous agent loop was paused",
    "[James requested recovery of this interrupted Helm card.]",
    "[STILL IN PROGRESS",
    "Workline browser QA found a concrete regression in ",
)


def read_only(path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def public_id(source_key: str) -> str:
    digest = hashlib.blake2s(source_key.encode("utf-8"), digest_size=6).hexdigest()
    return f"t-{digest}"


def closure_time(row: sqlite3.Row) -> float:
    values = [float(value) for value in (row["handled_at"], row["processed_at"]) if value is not None]
    return max(values, default=0.0)


def latest_visible_users(
    database: sqlite3.Connection,
    thread_by_session: dict[str, str],
) -> dict[str, float]:
    if not thread_by_session:
        return {}
    message_columns = {str(row[1]) for row in database.execute("PRAGMA table_info(messages)")}
    if not {"session_id", "role", "content", "timestamp"}.issubset(message_columns):
        return {}
    active_clause = "AND active = 1" if "active" in message_columns else ""
    display_kind = "display_kind" if "display_kind" in message_columns else "''"
    latest: dict[str, float] = {}
    session_ids = list(thread_by_session)
    targets = ",".join("(?)" for _ in session_ids)
    prefix_clauses = "\n".join("AND substr(content, 1, ?) <> ?" for _ in INTERNAL_USER_PREFIXES)
    parameters: list[Any] = [*session_ids, *USER_EVENT_KINDS]
    for prefix in INTERNAL_USER_PREFIXES:
        parameters.extend((len(prefix), prefix))
    rows = database.execute(
        f"""
        WITH target(session_id) AS (VALUES {targets})
        SELECT target.session_id,
               (SELECT timestamp
                  FROM messages
                 WHERE messages.session_id = target.session_id
                   AND role = 'user'
                   {active_clause}
                   AND trim(COALESCE(content, '')) <> ''
                   AND COALESCE({display_kind}, '') NOT IN ({','.join('?' for _ in USER_EVENT_KINDS)})
                   AND COALESCE({display_kind}, '') NOT LIKE 'process_wakeup%'
                   {prefix_clauses}
                 ORDER BY timestamp DESC
                 LIMIT 1) AS timestamp
          FROM target
        """,
        parameters,
    )
    for row in rows:
        thread_id = thread_by_session.get(str(row["session_id"]))
        timestamp = float(row["timestamp"] or 0)
        if thread_id and timestamp > latest.get(thread_id, 0):
            latest[thread_id] = timestamp
    return latest


def read_sessions(state_path: str, helm_path: str, limit: int = 2_000) -> list[dict[str, Any]]:
    cutoff = time.time() - HUMAN_SESSION_MAX_AGE_SECONDS
    with read_only(state_path) as state:
        rows = state.execute(
            f"""
            SELECT id, source, model, title, started_at, ended_at, end_reason,
                   message_count, parent_session_id, last_activity_at AS last_active,
                   pinned, archived, hidden, chat_id, thread_id
              FROM sessions
             WHERE hidden = 0
               AND parent_session_id IS NULL
               AND message_count > 0
               AND CASE
                     WHEN json_valid(COALESCE(model_config, '{{}}'))
                     THEN json_extract(COALESCE(model_config, '{{}}'), '$._delegate_from')
                     ELSE NULL
                   END IS NULL
               AND (
                 lower(COALESCE(source, '')) IN ({','.join('?' for _ in HUMAN_SESSION_SOURCES)})
                 OR id GLOB 'wizard_*'
                 OR id GLOB 'wizard-assistant-*'
                 OR id GLOB 'wizardop_user_*'
               )
               AND COALESCE(last_activity_at, started_at, 0) >= ?
             ORDER BY COALESCE(last_activity_at, started_at, 0) DESC,
                      COALESCE(started_at, 0) DESC,
                      id ASC
             LIMIT ?
            """,
            [*sorted(HUMAN_SESSION_SOURCES), cutoff, limit],
        ).fetchall()

        closures: dict[str, float] = {}
        direct_bindings: dict[str, str] = {}
        if helm_path and os.path.exists(helm_path):
            with read_only(helm_path) as helm:
                for row in helm.execute(
                    """
                    SELECT thread_id, handled_at, processed_at,
                           webui_session_id, webui_source_session_id
                      FROM threads
                     WHERE handled_at IS NOT NULL OR processed_at IS NOT NULL
                    """
                ):
                    thread_id = str(row["thread_id"] or "")
                    closed_at = closure_time(row)
                    if not thread_id or not closed_at:
                        continue
                    closures[thread_id] = max(closed_at, closures.get(thread_id, 0))
                    for field in ("webui_session_id", "webui_source_session_id"):
                        session_id = str(row[field] or "").strip()
                        if session_id:
                            direct_bindings[session_id] = thread_id

        sessions = [dict(row) for row in rows]
        thread_by_session: dict[str, str] = {}
        reopened_candidates: dict[str, str] = {}
        for session in sessions:
            session_id = str(session.get("id") or "")
            source = str(session.get("source") or "").casefold()
            thread_id = direct_bindings.get(session_id)
            if not thread_id and source in {"helm", "webui"}:
                thread_id = public_id(f"helm-session:{session_id}")
            elif not thread_id and source == "telegram":
                chat_id = str(session.get("chat_id") or "").strip()
                topic_id = str(session.get("thread_id") or "").strip()
                source_key = f"telegram:{chat_id}:{topic_id}" if chat_id and topic_id else f"telegram-session:{session_id}"
                thread_id = public_id(source_key)
            if thread_id in closures:
                thread_by_session[session_id] = thread_id
                last_active = float(session.get("last_active") or session.get("started_at") or 0)
                if last_active > closures[thread_id]:
                    reopened_candidates[session_id] = thread_id

        latest_users = latest_visible_users(state, reopened_candidates)
        for session in sessions:
            session["pinned"] = bool(session.get("pinned"))
            session["archived"] = bool(session.get("archived"))
            session["hidden"] = bool(session.get("hidden"))
            session_id = str(session.get("id") or "")
            thread_id = thread_by_session.get(session_id)
            closed_at = closures.get(thread_id or "", 0)
            if not session["archived"] and closed_at and latest_users.get(thread_id or "", 0) <= closed_at:
                session["archived"] = True
                session["wizard_helm_closed_at"] = closed_at
        return sessions


def main() -> int:
    if len(sys.argv) not in {3, 4}:
        raise SystemExit("usage: read-human-sessions.py STATE_DB HELM_DB [LIMIT]")
    limit = int(sys.argv[3]) if len(sys.argv) == 4 else 2_000
    if not 1 <= limit <= 10_000:
        raise SystemExit("LIMIT must be between 1 and 10000")
    print(json.dumps(read_sessions(sys.argv[1], sys.argv[2], limit), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

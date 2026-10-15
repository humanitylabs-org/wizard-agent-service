#!/usr/bin/env python3
"""Read-only bounded retained-history photo evidence. No files or network are read.

Rows are scanned by the integer message primary key (not recent-session listing).
Only actual stored user/assistant attachment syntax is exported, never prose.
"""
import json
import re
import sqlite3
import sys

TEST = re.compile(r'(?i)(?:\bqa\b|canary|smoke|fixture|probe|test[-_ ]session)')
INTERNAL = ('[CONTEXT ', '[CONTEXT_', '[PRIOR CONTEXT', '[ASYNC ', '[IMPORTANT: Background', '[OUT-OF-BAND', '[Your active task', '[Your previous agent')


def session_reason(s, owner_id):
    if s['hidden'] or s['parent_session_id'] or s['profile_name'] not in (None, '', 'default'):
        return 'internal_or_private'
    try:
        if json.loads(s['model_config'] or '{}').get('_delegate_from'):
            return 'delegated'
    except (ValueError, AttributeError):
        return 'invalid_session_metadata'
    if TEST.search((s['title'] or '') + ' ' + s['id']):
        return 'test_session'
    if s['source'] == 'telegram':
        return '' if owner_id and s['user_id'] == owner_id and s['chat_id'] == owner_id and s['chat_type'] == 'dm' else 'not_owner_dm'
    if s['source'] == 'webui':
        return ''
    if s['source'] in ('api_server', 'wizard-mobile') and re.fullmatch(r'wizard_\d+_[a-f0-9]+', s['id']):
        return ''
    return 'not_supported_owner_gateway'


def photo_refs(content, role):
    # Canonical stored multimodal content is JSON. Do not mine nested quoted JSON,
    # tool outputs, compaction summaries, prose paths, or arbitrary URL mentions.
    if not isinstance(content, str):
        return []
    if content.lstrip().startswith('['):
        try:
            parts = json.loads(content)
            if isinstance(parts, list):
                result = []
                for part in parts:
                    if not isinstance(part, dict):
                        continue
                    if part.get('type') == 'text':
                        result.extend(photo_refs(part.get('text', ''), role))
                    elif part.get('type') == 'image_url' and role == 'user':
                        url = part.get('image_url', {}).get('url', '')
                        if isinstance(url, str):
                            result.append({'kind': 'inline'})
                # The canonical durable file envelope accompanies native image
                # model input. It is one attachment, not a second delivered image.
                return [r for r in result if r['kind'] != 'inline'] if any(r['kind'] in ('wizard', 'helm') for r in result) else result
        except ValueError:
            pass
    if content.startswith(INTERNAL):
        return []
    content = re.sub(r'```[^\n]*\n.*?```', '', content, flags=re.S)
    out = []
    for match in re.finditer(r'^\[WIZARD_FILES_V1\]\s*\n(.*?)\n\[/WIZARD_FILES_V1\]\s*$', content, re.M | re.S):
        if role != 'user':
            continue
        try:
            files = json.loads(match[1])
            for f in files if isinstance(files, list) else []:
                if isinstance(f, dict) and str(f.get('mime', '')).startswith('image/'):
                    out.append({'kind': 'wizard', 'id': f.get('id'), 'sha256': f.get('sha256')})
        except (ValueError, TypeError):
            pass
    for match in re.finditer(r'^<helm_attachments>([^\n]+)</helm_attachments>\s*$', content, re.M):
        try:
            for f in json.loads(match[1]).get('items', []):
                if isinstance(f, dict) and str(f.get('mime', '')).startswith('image/'):
                    out.append({'kind': 'helm', 'id': f.get('id'), 'path': f.get('path', ''), 'sha256': f.get('sha256', '')})
        except (ValueError, TypeError, AttributeError):
            pass
    if role == 'assistant':
        for match in re.finditer(r'^\s*MEDIA:\s*([^\n]+)\s*$', content, re.M):
            path = match[1].strip().strip('`\"\'')
            if re.search(r'\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s]*)?$', path, re.I):
                out.append({'kind': 'agent', 'path': path})
        for match in re.finditer(r'!\[[^\]\n]*\]\(([^)\s]+)\)', content):
            out.append({'kind': 'agent', 'path': match[1]})
    else:
        for match in re.finditer(r'^\[Image(?: attached at)?:\s*([^\]\n]+)\]\s*$', content, re.M):
            out.append({'kind': 'received', 'path': match[1].strip()})
    return list({json.dumps(ref, sort_keys=True): ref for ref in out}.values())


def scan(path, cursor, ceiling, owner_id, limit=250):
    c = sqlite3.connect('file:' + path + '?mode=ro', uri=True, timeout=2)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA query_only=ON')
    sessions = {s['id']: dict(s) for s in c.execute('SELECT id,source,user_id,chat_id,chat_type,profile_name,hidden,archived,parent_session_id,title,model_config FROM sessions')}
    ceiling = ceiling or c.execute('SELECT coalesce(max(id),0) FROM messages').fetchone()[0]
    # Fetch metadata first; do not read tool content or excluded/private messages.
    rows = c.execute("SELECT id,session_id,role,timestamp,display_kind,_compressed_summary,(tool_calls IS NOT NULL AND tool_calls NOT IN ('','[]','null')) AS has_tools,platform_message_id FROM messages WHERE id>? AND id<=? ORDER BY id LIMIT ?", (cursor, ceiling, limit)).fetchall()
    counts = {'scanned': len(rows), 'eligible': 0, 'matched': 0, 'excluded': 0}
    reasons = {}; evidence = []
    for m in rows:
        s = sessions.get(m['session_id'])
        reason = session_reason(s, owner_id) if s else 'missing_session'
        if not reason and (m['role'] not in ('user', 'assistant') or m['_compressed_summary'] or m['display_kind'] or (m['role'] == 'assistant' and m['has_tools'])):
            reason = 'not_delivered_human_message'
        if reason:
            counts['excluded'] += 1; reasons[reason] = reasons.get(reason, 0) + 1
            continue
        counts['eligible'] += 1
        text = c.execute('SELECT content FROM messages WHERE id=?', (m['id'],)).fetchone()[0]
        refs = photo_refs(text, m['role'])
        if not refs:
            continue
        counts['matched'] += len(refs)
        assert s is not None
        evidence.append({'thread_id': m['session_id'], 'message_id': str(m['id']), 'role': m['role'], 'timestamp': m['timestamp'], 'gateway': s['source'], 'archived': bool(s['archived']), 'platform_message_id': m['platform_message_id'], 'refs': refs})
    c.close()
    return {'cursor': rows[-1]['id'] if rows else ceiling, 'ceiling': ceiling, 'done': not rows or rows[-1]['id'] >= ceiling, 'counts': counts, 'excluded_reasons': reasons, 'evidence': evidence}


if __name__ == '__main__':
    print(json.dumps(scan(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], int(sys.argv[5]) if len(sys.argv)>5 else 250), separators=(',', ':')))

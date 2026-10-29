"""Synthetic manager transport/readiness contracts; no Docker side effects."""
from pathlib import Path
import shutil


def catalog_build_context(root, context):
    context = Path(context)
    context.mkdir()
    shutil.copyfile(Path(root)/'scripts/ci/round11-git-http.py', context/'server.py')
    (context/'Dockerfile').write_text('FROM python:3.12-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*\nCOPY server.py /server.py\nENTRYPOINT ["python3", "/server.py", "--root", "/www"]\n')
    return context


def nested_docker_argv(engine, args, data=None):
    # stdin crosses TWO exec boundaries. Inner -i alone is insufficient.
    if data is not None and args and args[0] == 'exec' and '-i' not in args[1:3]:
        raise RuntimeError('nested_stdin_requires_inner_interactive')
    return ['docker', 'exec', *(['-i'] if data is not None else []), engine, 'docker', *args]


def manager_health_ready(value):
    if not isinstance(value, dict):
        return False
    return (value.get('status') == 'ok' and value.get('error') == {}
            and value.get('info', {}).get('queue', {}).get('status') == 'up'
            and value.get('details', {}).get('queue', {}).get('status') == 'up')


def queues_ready(rows):
    consumers = {r['name']: int(r['consumers']) for r in rows}
    return all(consumers.get(name, 0) > 0 for name in ('app-events-queue', 'repo-queue', 'system-events-queue'))


def smart_advertisement_ready(content_type, body):
    return (content_type.split(';')[0] == 'application/x-git-upload-pack-advertisement'
            and body.startswith(b'001e# service=git-upload-pack\n0000'))

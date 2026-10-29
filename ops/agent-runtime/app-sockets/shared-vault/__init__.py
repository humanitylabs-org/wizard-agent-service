"""Supported standalone Hermes tools. This plugin is a credential-free client.

The socket mount, not model context/env ids, selects the authenticated agent edge.
Changing the path cannot create a socket mount or reveal the edge's bearer.
"""
import json
import os
import socket


def call(operation, args):
    expected = {'handle'} if operation == 'run' else set()
    if not isinstance(args, dict) or set(args) != expected:
        return json.dumps({'error': 'invalid_request'})
    if operation == 'run' and (not isinstance(args['handle'], str) or len(args['handle']) > 100):
        return json.dumps({'error': 'invalid_request'})
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(24)
            s.connect(os.environ.get('SHARED_VAULT_SOCKET', '/run/shared-vault/agent.sock'))
            s.sendall(json.dumps({'operation': operation, **args}).encode() + b'\n')
            with s.makefile('rb') as f:
                raw = f.readline(65537)
            if len(raw) > 65536:
                raise ValueError()
            value = json.loads(raw)
            return json.dumps(value)
    except Exception:
        return json.dumps({'error': 'shared_vault_unavailable'})


def register(ctx):
    for operation, description in (
        ('status', 'Read scoped Shared Vault readiness. No credentials.'),
        ('handles', 'List only your owner-issued workflow handles.'),
        ('run', 'Read invoice count and outstanding amount through the fixed owner-approved login-and-task workflow. No arbitrary browsing or scripts.'),
    ):
        name = 'shared_vault_' + operation
        parameters = {'type': 'object', 'properties': {}, 'additionalProperties': False}
        if operation == 'run':
            parameters.update(properties={'handle': {'type': 'string', 'maxLength': 100}}, required=['handle'])
        ctx.register_tool(name=name, toolset='shared_vault_scoped', description=description,
                          schema={'name': name, 'description': description, 'parameters': parameters},
                          handler=lambda args, _op=operation, **kwargs: call(_op, args))

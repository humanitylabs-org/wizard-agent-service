#!/usr/bin/env python3
"""Owner-side fixed TCP relays. No generic proxy and no agent-side Tailscale socket.

Lifecycle is explicit: the owner starts this after the /28 exists and removes its
scoped firewall rule before shutdown. No host service or Tailscale reconfiguration.
"""
import argparse
import asyncio
from contextlib import suppress
import ipaddress
import json
from pathlib import Path
import re
import signal


def validate(entries):
    if not isinstance(entries, list) or len(entries) > 16:
        raise ValueError('declared_tcp_invalid')
    aliases, ports = set(), set()
    for item in entries:
        if not isinstance(item, dict) or set(item) != {'alias', 'address', 'port', 'relay_port'}:
            raise ValueError('declared_tcp_invalid')
        alias, address, port, relay = (item[k] for k in ('alias', 'address', 'port', 'relay_port'))
        if (not isinstance(alias, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,62}', alias)
                or not isinstance(address, str) or ipaddress.ip_address(address) not in ipaddress.ip_network('100.64.0.0/10')
                or type(port) is not int or not 1 <= port <= 65535 or port == 443
                or type(relay) is not int or not 1024 <= relay <= 65535
                or alias in aliases or relay in ports):
            raise ValueError('declared_tcp_invalid')
        aliases.add(alias)
        ports.add(relay)
    return entries


def network(value):
    net = ipaddress.ip_network(value)
    if net.version != 4 or net.prefixlen != 28 or not net.subnet_of(ipaddress.ip_network('10.250.0.0/16')):
        raise ValueError('declared_tcp_network_invalid')
    return net


def declaration(record, alias):
    runtime = record['runtime']
    if runtime.get('isolation') != 'restricted' or not record.get('imported'):
        raise ValueError('declared_tcp_import_required')
    entries = validate(runtime.get('declared_tcp', []))
    matches = [x for x in entries if x['alias'] == alias]
    if len(matches) != 1:
        raise ValueError('declared_tcp_alias_missing')
    net = network(runtime['network']['uplink'])
    return matches[0], net


def argv(tailscale, socket, entry):
    # No shell, no attacker-selected arguments, no protocol-supplied destination.
    return [str(tailscale), '--socket=' + str(socket), 'nc', entry['address'], str(entry['port'])]


async def serve(record, alias, tailscale, socket):
    entry, net = declaration(record, alias)
    clients = set()
    async def pump(reader, writer):
        while chunk := await asyncio.wait_for(reader.read(65536), 300):
            writer.write(chunk)
            await writer.drain()

    async def handle(reader, writer):
        task = asyncio.current_task()
        peer = ipaddress.ip_address(writer.get_extra_info('peername')[0])
        if peer not in net or len(clients) >= 16:
            writer.close()
            return
        clients.add(task)
        child = None
        pipes = []
        try:
            child = await asyncio.create_subprocess_exec(*argv(tailscale, socket, entry),
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL)
            pipes = [asyncio.create_task(pump(reader, child.stdin)), asyncio.create_task(pump(child.stdout, writer))]
            await asyncio.wait(pipes, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for pipe in pipes:
                pipe.cancel()
            await asyncio.gather(*pipes, return_exceptions=True)
            if child and child.returncode is None:
                with suppress(ProcessLookupError):
                    child.kill()
            if child:
                await child.wait()
            writer.close()
            with suppress(ConnectionError):
                await writer.wait_closed()
            clients.discard(task)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    server = await asyncio.start_server(handle, str(net.network_address + 1), entry['relay_port'], limit=65536)
    print(json.dumps({'ready': True, 'alias': alias, 'bind': str(net.network_address + 1), 'port': entry['relay_port']}), flush=True)
    try:
        async with server:
            await stop.wait()
    finally:
        for client in list(clients):
            client.cancel()
        await asyncio.gather(*clients, return_exceptions=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--agent-json', required=True, type=Path)
    p.add_argument('--alias', required=True)
    p.add_argument('--tailscale', required=True, type=Path)
    p.add_argument('--socket', required=True, type=Path)
    a = p.parse_args()
    asyncio.run(serve(json.loads(a.agent_json.read_text()), a.alias, a.tailscale, a.socket))


if __name__ == '__main__':
    main()

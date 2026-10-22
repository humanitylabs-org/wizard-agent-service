"""One policy for Docker aliases and SNI: public, multi-label ASCII DNS names.

DNS resolution still independently rejects non-public destination IPs. Reserved
single-label service names must never override Docker's agent/edge/egress routing.
"""
import re

SPECIAL_SUFFIXES = ('localhost', 'local', 'internal', 'invalid', 'test', 'example',
                    'onion', 'home', 'lan', 'home.arpa')


def valid_public_hostname(host):
    if not isinstance(host, str) or not 3 <= len(host) <= 253:
        return False
    labels = host.split('.')
    return (len(labels) >= 2 and re.fullmatch(r'[a-z]{2,63}|xn--[a-z0-9-]{2,59}', labels[-1]) is not None
            and all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels)
            and not any(host == suffix or host.endswith('.' + suffix) for suffix in SPECIAL_SUFFIXES))

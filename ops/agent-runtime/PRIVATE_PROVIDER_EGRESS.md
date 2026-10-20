# Provider-app egress: separate acceptance gate

The Agent Service change enforces the **in-seal client's** forwarding/input policy. It does **not**
claim that a provider app currently on Runtipi's ordinary application network is restricted to
`private_inference.egress`. PRIVATE_PROVIDERS acceptance 3 remains open until the provider deployment
itself implements that restriction.

## Why agent-firewall.sh is not enough

The existing `agent-firewall.sh` controls INPUT traffic from the agent sandbox/uplink pools and who
may reach the Agent Service's agent-only port. It does not control container forwarding/NAT. A
provider app is not an agent: it already has one or more application-network interfaces with ordinary
Docker internet access. Attaching the additional **internal** relay network does not remove those
other routes. Applying an INPUT allowlist would leave provider -> internet forwarding wide open.

Adding an iptables destination-IP allowlist populated once from DNS would also be a false claim of
hostname enforcement: addresses change, CDN addresses can be shared, DNS can rebind, IPv6 and other
interfaces can bypass an IPv4 snapshot, and app restarts can acquire different source IPs. Blocking only
the relay-source IP would not constrain a request that exits through the provider's app-network IP.
The client's numeric relay IP/port policy is different: that IP is a pinned local Docker endpoint,
not an assertion about a third-party hostname.

## What is needed

A provider deployment/installer lane should own this, because it owns every interface and boot order:

1. Put the provider inference process on an internal/no-host-address sandbox; keep its owner HTTP/MCP
   reachability through a narrow edge or incoming gateway. Remove ordinary app-network egress routes.
2. For `egress: []`, give it no egress sidecar. For an attested relay, provide an HTTPS CONNECT allowlist
   sidecar using the existing restricted runtime's reviewed SNI/hostname validation (or an equivalent
   proven firewall/proxy), with only the declared hosts. Prove that the provider's actual HTTP stack
   uses that proxy. Environment variables alone are not proof, particularly for Node fetch/SDK clients.
3. Deny alternate TCP, UDP, IPv6 and host destinations, restrict DNS, and scope all host rules to the
   actual provider endpoints across every network. Reconcile address changes and reinstall guards
   before any automatic container restart. Do not reuse an unrestricted pre-existing network silently.
4. Run on the disposable acceptance box: allowed Tinfoil endpoints succeed, arbitrary destinations and
   direct IP paths fail, the local provider cannot reach any internet endpoint, owner app access still
   works, relay authentication still works, and restart does not produce an unguarded window.
5. Confirm ciphertext/attestation and no-body-logging separately. Egress restriction is not proof of
   either of those properties.

No production app network, host firewall or systemd configuration was changed while investigating this
lane. This document intentionally records the missing gate rather than shipping a misleading
hostname-to-IP filter or removing a live provider's management network.

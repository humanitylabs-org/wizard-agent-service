# Tailscale source inclusion is not activation

This candidate includes exact PR15 `d8a1e29c5ebc93e5163a1e775612ba4131278fbd` and live Service `1f63ede2a2af4eaf090fb5c16cbfcca26dae2ba7`. It does not change a deployed environment, enable Tailscale authentication, publish an image, or establish Mac/guest acceptance.

## Environment compatibility

- With no `WIZARD_AUTH_MODE` and no `WIZARD_TAILNET_ORIGIN`, current behavior remains: Cloudflare Access is required unless `WIZARD_REQUIRE_CF_ACCESS=0`.
- `WIZARD_AUTH_MODE=none` explicitly disables Access, preserving the existing private/local installation route. This is not a remedy for a failed Tailscale test.
- `WIZARD_AUTH_MODE=cloudflare` explicitly selects Cloudflare, even if the legacy disable variable is `0` or a tailnet origin is present.
- `WIZARD_AUTH_MODE=tailscale` selects the request-based Serve verifier. Setting `WIZARD_TAILNET_ORIGIN` with auth mode unset also opts in. Do not prepopulate that origin in production as harmless documentation.
- Invalid modes, missing authorized logins, or invalid tailnet origin fail startup rather than silently disabling authentication.

An activation-only example, **not installed by this change**:

```sh
WIZARD_AUTH_MODE=tailscale
WIZARD_TAILNET_ORIGIN=https://your-box.your-tailnet.ts.net:8445
WIZARD_TAILNET_LOGIN=owner@example.com,second-authorized-owner@example.com
```

Use the exact HTTPS origin, including a non-default port. The default verifier trusts loopback. `WIZARD_CONTAINER=1` additionally derives the default container gateway from `/proc/net/route`; it does not identify arbitrary intermediate proxies. `WIZARD_HOST=0.0.0.0` is permitted only inside that container mode, whose published port must remain host-loopback-only. No Funnel support.

## The peer chain is a release gate

PR15 is a **Tailscale Serve verifier**, not generic header authentication. `Tailscale-User-Login` is authoritative only when the immediate trusted peer is a controlled Serve ingress that overwrites client-supplied identity. Host, owner login, Origin and fetch metadata checks do not establish provenance of a forwarded identity on their own.

The modular shell source currently routes Serve → nginx shell → Service:

- `wizard-ux/packaging/proxy.conf` preserves `Host`, forwards request headers by default and adds `X-Forwarded-For`. It does not sanitize/establish Tailscale identity provenance.
- In bridge mode the Service sees the nginx container's address, not necessarily the container gateway that a host Serve → published Service connection would use. Authentication should fail closed there until a reviewed ingress adapter/topology is selected.
- In host-network/alongside mode nginx's outgoing socket is loopback. Blindly accepting its forwarded identity would treat any caller that can reach nginx as Serve. Loopback is a transport restriction, not proof that this extra proxy authenticated a user.
- The shell's dedicated `/wizard/mcp` ingress guard and the Service's bearer + box-only check are separate protections. Keep them; never expose the tool gateway by adding a Tailscale identity exemption.

The consumer must either route protected API requests directly from controlled Serve to the Service, or deliver a separately reviewed proxy adapter that binds trusted ingress, rejects/strips spoofed identity before forwarding, and restricts all bypass paths. Do not expand trusted peer ranges, trust forwarded IP/Host as socket identity, drop the Origin rule, disable auth, or forge identity in native requests to make a test pass.

Before activation prove the exact final topology: authorized owner success; nonowner, missing/forged identity, wrong Host, direct/untrusted peer and cross-origin writes denied; top-level navigation behavior; local native chat/run/steer/cancel/voice/router and installed-app MCP routes preserved. Native localhost calls do not automatically carry Serve identity or Origin. A mixed native/Serve deployment needs an explicit reviewed ingress contract rather than a global bypass.

## Continuation compatibility when merging current live

Retain live's private helper-admission closure and DB generation revalidation, including after queued/restarted work. Do not resurrect an `X-Wizard-Internal` HTTP authentication bypass. The modular no-state path uses a service-captured HTTP completion identity and re-reads the exact latest message at admission and queued dispatch; missing/replaced/future/older-than-two-hour completions fail closed. It retains the last locked native model/provider and the modular OS instruction kernel. This is ordinary HTTP completion follow-through only: no receipt recovery or DB-backed manual resume is invented when `WIZARD_HERMES_STATE_PATH` is unset.

## Minimal adapter for the Mac consumer based on Service 8bca1cf

The Mac stack owner retains its active checkout and current fixes. Do not replace that tree wholesale with this modular candidate or start another build lane.

1. Apply only PR15's five-file auth delta (the exact patch is supplied with integration evidence): add `server/tailnet-access.mjs` and `tests/tailnet-access.test.ts`; add env selection/verifier wiring to `server/index.mjs`; add request-aware verification and neutral verifier error text in `server/service.mjs`; update README activation documentation.
2. Preserve the consumer's modular/packaged entrypoint options, installed-provider/model changes, native controls and app routes. If it also merges the current-live helper changes, use private continuation admission, not self-HTTP identity bypasses; review the separate portable continuation adaptation only where that tree needs it.
3. Port the focused auth runtime/env tests against the consumer's actual entrypoint. Auth off/unset behavior must remain identical. Do not activate the env example by default.
4. Test the exact composed source, then the final guest/native artifact in the existing consumer lane. This source suite is not Mac/runtime product proof.

The 8bca1cf adapter is a bounded integration guide, not a claim that an unseen/current Mac worktree has been patched or tested.

## Immutable publication gate

The candidate `.github/workflows/image.yml` is manual `workflow_dispatch` metadata validation only, read-only permissions; it neither builds nor publishes. No protected merge or push is part of source integration.

Main's image workflow (inspected at `f772b830ec4f3ba1faff885f8a66914b6010f062`) publishes on push to main, including the version read from runtipi config. Main's `0.2.0` tag reuse concern remains an explicit consumer/release-owner gate, not permission to enable publishing here. Before any authorized release: choose a unique source/build/version, prevent replacement of `0.2.0`/stable tags, record actual per-architecture and manifest-list image digests, and pin the composed factory/update manifest to the verified digest. No digest exists for this source-only integration; do not fabricate one.

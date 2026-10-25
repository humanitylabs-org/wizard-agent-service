# Public container publication

`Publish public image` validates every event. Pull requests build the Dockerfile on
standard `ubuntu-24.04` runners (native amd64 and QEMU arm64), but receive only
`contents: read`: they never log in, push, attest, upload artifacts, or use a
persistent Actions cache. GitHub documents this label as a standard hosted runner
and says standard runners are free and unlimited for public repositories:
<https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job>.

Canonical `main` pushes and explicitly confirmed dispatches use a staged
prepare/sign/finalize flow on `ubuntu-24.04`:

1. Prepare uses the action-created buildx builder to push an amd64/arm64 index by
   digest only (`push-by-digest=true,name-canonical=true`). It publishes no tag.
2. A fresh digest receives and immediately verifies canonical GitHub build
   provenance for the exact workflow, main ref, and source commit.
3. A separate hosted finalizer revalidates the digest, both config blobs and
   labels, and canonical provenance before creating the write-once SHA and
   optional version aliases with `imagetools`.
4. A credential-free job anonymously pulls the finalized digest and every alias
   for both architectures.

A crash after the digest upload leaves no immutable tag, so a full rerun safely
rebuilds and signs. A crash after alias creation finds the original signed SHA
artifact and takes the verified-reuse path. A reused artifact is never signed as
a fresh build.

Every action is pinned to an official release's full commit SHA. Every Docker job
uses a job-local configuration below `RUNNER_TEMP`; prepare and finalize each use
their own login and action-created builder. There are no shared locks, owner HOME,
Homebrew plugin paths, remote Docker sockets, worker volumes, artifacts, or
persistent caches.

## Immutable tags and serialization

Every canonical commit gets `sha-<full 40-character commit>`. An existing SHA tag
is accepted only when its digest, platform config blobs, revision/source labels,
and canonical signed provenance exactly match the selected source SHA and main
ref. A mismatch fails before any write.

Workflow concurrency is keyed by SHA with cancellation disabled and `queue: max`,
so up to 100 same-SHA requests wait rather than GitHub cancelling an older pending
request. The finalizer job separately applies the same queue policy to the requested
version (or SHA), closing the check/create race while distinct commits remain
independent. See the [official concurrency contract](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

A version dispatch must run on `main`, repeat `release_tag` exactly in
`confirm_release_tag`, and set `expected_sha` to the full selected commit. The
verified immutable SHA must already exist. SHA and version collisions are checked
before finalization writes either alias; existing version tags always fail rather
than being overwritten.

## Public verification and provenance

Prepare, finalization, and attestation independently enforce canonical repository,
`main` ref, and push/dispatch event guards. Finalization runs only after successful
fresh attestation, or after attestation was skipped specifically because prepare
reported a verified existing SHA. Failed or cancelled attestation never permits
aliases. The finalizer uses `gh attestation verify --bundle-from-oci` with the
canonical workflow, source ref, and exact source digest before any write.

After finalization, a fresh hosted job with no package permission, credentials, or
login obtains anonymous registry tokens and pulls both architectures by index
digest, immutable SHA tag, and optional version tag. It fails closed if the
package is not public.

A new GHCR package starts private. An administrator must make it **Public** and
retain repository Actions write access. No personal package token is needed.

## Checks

```sh
python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v
```

The installed actionlint 1.7.12 schema predates GitHub's `concurrency.queue` key and
reports both required `queue: max` entries as unexpected. Keep those entries: do not add
an actionlint ignore or remove the official queue contract merely to satisfy the old schema.

The tests mock registry and Docker behavior, including exact builder selection,
digest-only retry recovery, provenance refusal, SHA/version collisions, immutable
reuse, queue retention, and anonymous digest/tag pulls. Only a reviewed canonical
branch run proves the live GHCR publication and attestation path.

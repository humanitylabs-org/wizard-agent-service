# Public container publication

`Publish public image` validates every event. Pull requests build the Dockerfile on
standard `ubuntu-24.04` runners (native amd64 and QEMU arm64), but receive only
`contents: read`: they never log in, push, attest, upload artifacts, or use a
persistent Actions cache. GitHub documents this label as a standard hosted runner
and says standard runners are free and unlimited for public repositories:
<https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job>.

Canonical `main` pushes and explicitly confirmed dispatches publish on
`ubuntu-24.04`. QEMU plus one buildx builder creates and pushes the amd64/arm64
index atomically. A native publication matrix would add per-architecture registry
writes and a manifest-assembly step without a useful payoff for these small
Dockerfiles. PR builds exercise the same native amd64 and emulated arm64 paths.

Every action is pinned to an official release's full commit SHA. Every Docker job
uses a job-local configuration below `RUNNER_TEMP`; the build and publication
script explicitly receives the builder created by `setup-buildx-action`. Action
cleanup and image cleanup target only that builder/config or the exact PR image.
There are no shared locks, owner HOME, Homebrew plugin paths, remote Docker
sockets, worker volumes, artifacts, or persistent caches.

## Immutable tags and serialization

Every canonical commit gets `sha-<full 40-character commit>`. An existing SHA tag
is verified and reused rather than overwritten. Workflow concurrency is keyed by
the SHA with cancellation disabled, so reruns of one commit serialize while
independent immutable commits may build concurrently. The publish job additionally uses the
requested version (or SHA when absent) as its concurrency key, closing the check/create race between
two dispatches for that write-once alias.

A version dispatch must run on `main`, repeat `release_tag` exactly in
`confirm_release_tag`, and set `expected_sha` to the full selected commit. The immutable SHA tag must already exist, so a release dispatch can never race its creation. Existing
version tags fail before any alias write. The workflow and Python script both
check the canonical repository, `main` ref, and permitted event; a fork, PR, or
other branch cannot publish even if one layer is edited incorrectly.

## Public verification and provenance

After publication, a fresh hosted job with no package permission, credentials, or
login obtains anonymous registry tokens and pulls both architectures by index
digest, immutable SHA tag, and optional version tag. It checks manifest digests,
architecture, and source-revision labels and fails closed if the package is not
public. For newly built digests, a final job creates and verifies GitHub-signed
build provenance; its repository/ref/event guards pin it to the canonical workflow
on `main`. Reused digests must already have canonical signed provenance matching
the exact source SHA/ref, verified before any version alias is written. Both
config blobs are digest-checked and must carry the correct revision/source labels
before an existing SHA is reused. A rerun that did not build never signs a fresh
build claim. If the first build succeeded but attestation failed, rerun only the
failed attestation job (not all jobs); a full rerun fails closed on missing provenance.

A new GHCR package starts private. An administrator must make it **Public** and
retain repository Actions write access. No personal package token is needed.

## Checks

```sh
python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v
```

The tests mock registry and Docker behavior, including exact buildx builder
selection, no-push hosted PR builds, tag collision refusal, immutable rerun reuse,
and anonymous digest/tag pulls. Only a reviewed canonical-branch run proves the
live GHCR publication and attestation path.

#!/usr/bin/env python3
"""Build/publish on ephemeral hosted runners; verify from a credential-free job."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

MEDIA = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
PLATFORMS = {"amd64", "arm64"}
CANONICAL = {
    "ghcr.io/humanitylabs-org/wizard-ux": "humanitylabs-org/wizard-ux",
    "ghcr.io/humanitylabs-org/wizard-agent-service": "humanitylabs-org/wizard-agent-service",
}


class Registry:
    def __init__(self, image, authenticated=False):
        if image not in CANONICAL:
            raise ValueError("unexpected image name")
        self.path = image.removeprefix("ghcr.io/")
        headers = {}
        if authenticated:
            pair = os.environ["GITHUB_ACTOR"] + ":" + os.environ["GHCR_TOKEN"]
            headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()
        query = urllib.parse.urlencode({"service": "ghcr.io", "scope": f"repository:{self.path}:pull"})
        request = urllib.request.Request("https://ghcr.io/token?" + query, headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            self.token = json.load(response)["token"]

    def manifest(self, reference, missing_ok=False):
        request = urllib.request.Request(
            f"https://ghcr.io/v2/{self.path}/manifests/{reference}",
            headers={"Authorization": "Bearer " + self.token, "Accept": MEDIA},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404 and missing_ok:
                return None
            raise
        return "sha256:" + hashlib.sha256(data).hexdigest(), json.loads(data)

    def blob(self, digest):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise RuntimeError("invalid config digest")
        request = urllib.request.Request(
            f"https://ghcr.io/v2/{self.path}/blobs/{digest}",
            headers={"Authorization": "Bearer " + self.token},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
        if "sha256:" + hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError("config blob digest mismatch")
        return json.loads(data)


def platform_manifests(registry, digest, sha=None, image=None):
    actual, index = registry.manifest(digest)
    if actual != digest:
        raise RuntimeError("registry returned wrong content digest")
    found = {}
    for entry in index.get("manifests", []):
        platform = entry.get("platform", {})
        arch = platform.get("architecture")
        if platform.get("os") == "linux" and arch in PLATFORMS:
            if arch in found:
                raise RuntimeError("duplicate supported architecture")
            child_digest, child = registry.manifest(entry["digest"])
            if child_digest != entry["digest"]:
                raise RuntimeError("child manifest digest mismatch")
            config_digest = child["config"]["digest"]
            if sha is not None:
                config = registry.blob(config_digest)
                labels = config.get("config", {}).get("Labels", {})
                if labels.get("org.opencontainers.image.revision") != sha:
                    raise RuntimeError("image config revision mismatch")
                if labels.get("org.opencontainers.image.source") != "https://github.com/" + CANONICAL.get(image or "", ""):
                    raise RuntimeError("image config source mismatch")
                if config.get("architecture") != arch or config.get("os") != "linux":
                    raise RuntimeError("image config platform mismatch")
            found[arch] = config_digest
    if set(found) != PLATFORMS:
        raise RuntimeError("image must contain linux/amd64 and linux/arm64")
    return found


def docker(args, env, **kwargs):
    kwargs.setdefault("check", True)
    return subprocess.run(["docker", *args], env=env, **kwargs)


def clean_env(config):
    """Give Docker/buildx only the isolated job config and no Actions credentials."""
    passthrough = ("RUNNER_TRACKING_ID",)
    return {"PATH": os.environ["PATH"], "HOME": str(config), "DOCKER_CONFIG": str(config),
            **{key: os.environ[key] for key in passthrough if key in os.environ}}


def hosted_config():
    runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve()
    config = Path(os.environ["DOCKER_CONFIG"]).resolve()
    if not config.is_relative_to(runner_temp) or config == runner_temp:
        raise RuntimeError("DOCKER_CONFIG must be an isolated directory under RUNNER_TEMP")
    config.mkdir(mode=0o700, parents=True, exist_ok=True)
    return config


def canonical_guard(args, events):
    repository = CANONICAL.get(args.image)
    if not repository or os.environ.get("GITHUB_REPOSITORY") != repository:
        raise RuntimeError("publication/build is only allowed in the canonical repository")
    if os.environ.get("GITHUB_EVENT_NAME") not in events:
        raise RuntimeError("unexpected workflow event")


def build(args):
    canonical_guard(args, {"pull_request"})
    if args.platform not in PLATFORMS:
        raise ValueError("PR build platform must be amd64 or arm64")
    config = hosted_config()
    env = clean_env(config)
    local_tag = "wizard-pr:" + args.platform + "-" + args.sha
    command = ["buildx", "build", "--builder", args.builder,
               "--platform", "linux/" + args.platform, "--provenance=false",
               "--label", "org.opencontainers.image.source=https://github.com/" + CANONICAL[args.image],
               "--label", "org.opencontainers.image.revision=" + args.sha,
               "--tag", local_tag, "--load", "."]
    try:
        docker(command, env)
        result = docker(["image", "inspect", "--format",
                         "{{.Architecture}} {{index .Config.Labels \"org.opencontainers.image.revision\"}}",
                         local_tag], env, capture_output=True, text=True)
        if result.stdout.strip() != f"{args.platform} {args.sha}":
            raise RuntimeError("PR image architecture/revision mismatch: " + result.stdout.strip())
    finally:
        docker(["image", "rm", "--force", local_tag], env, check=False)


def verify_existing_provenance(args, digest, config):
    # A reused digest must keep its original canonical build provenance. Never
    # sign a non-building rerun or release dispatch as though it built the image.
    env = clean_env(config)
    env["GH_TOKEN"] = os.environ["GHCR_TOKEN"]
    subprocess.run([
        "gh", "attestation", "verify", "oci://" + args.image + "@" + digest,
        "--repo", CANONICAL[args.image], "--bundle-from-oci",
        "--signer-workflow", CANONICAL[args.image] + "/.github/workflows/publish-image.yml",
        "--source-ref", "refs/heads/main", "--source-digest", args.sha,
    ], env=env, check=True)


def publish(args):
    canonical_guard(args, {"push", "workflow_dispatch"})
    if os.environ.get("GITHUB_REF") != "refs/heads/main" or args.branch != "main":
        raise RuntimeError("publication is only allowed on the canonical main branch")
    if args.release:
        if (os.environ["GITHUB_EVENT_NAME"] != "workflow_dispatch" or
                args.confirm != args.release or args.expected_sha != args.sha):
            raise RuntimeError("release dispatch must confirm tag and exact selected commit")
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-candidate\.[0-9]{8})?", args.release):
            raise ValueError("only semantic versions or dated candidate tags are accepted")
    config = hosted_config()
    env = clean_env(config)
    registry = Registry(args.image, authenticated=True)
    existing = registry.manifest(args.tag, missing_ok=True)
    if args.release and registry.manifest(args.release, missing_ok=True):
        raise RuntimeError("release tag already exists; refusing to overwrite")
    if args.release and not existing:
        raise RuntimeError("release requires an existing verified immutable SHA tag")
    if existing:
        digest = existing[0]
        platform_manifests(registry, digest, args.sha, args.image)
        verify_existing_provenance(args, digest, config)
        print("Reusing immutable SHA tag", digest, flush=True)
    else:
        metadata = Path(config, "metadata.json")
        docker(["buildx", "build", "--builder", args.builder,
                "--platform", "linux/amd64,linux/arm64", "--provenance=false",
                "--label", "org.opencontainers.image.source=https://github.com/" + CANONICAL[args.image],
                "--label", "org.opencontainers.image.revision=" + args.sha,
                "--tag", args.image + ":" + args.tag,
                "--metadata-file", str(metadata), "--push", "."], env)
        digest = json.loads(metadata.read_text())["containerimage.digest"]
        registry = Registry(args.image, authenticated=True)
        if registry.manifest(args.tag)[0] != digest:
            raise RuntimeError("published SHA tag does not match build digest")
        platform_manifests(registry, digest, args.sha, args.image)
    if args.release:
        docker(["buildx", "--builder", args.builder, "imagetools", "create",
                "--tag", args.image + ":" + args.release, args.image + "@" + digest], env)
        if Registry(args.image, authenticated=True).manifest(args.release)[0] != digest:
            raise RuntimeError("release alias changed image digest")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"digest={digest}\nbuilt={str(not bool(existing)).lower()}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(f"Published `{args.image}@{digest}` from `{args.sha}`.\n\nTags: `{args.tag}` `{args.release}`. Public pull verification is a separate required job.\n")


def verify(args):
    canonical_guard(args, {"push", "pull_request", "workflow_dispatch"})
    with tempfile.TemporaryDirectory(prefix="anonymous-ghcr-", dir=os.environ.get("RUNNER_TEMP")) as config:
        Path(config, "config.json").write_text('{"auths":{}}')
        env = clean_env(config)
        deadline = time.monotonic() + args.retry_seconds
        while True:
            try:
                registry = Registry(args.image)
                platform_manifests(registry, args.digest, args.sha, args.image)
                store = docker(["info", "--format", "{{json .DriverStatus}}"], env, capture_output=True, text=True)
                containerd = "io.containerd.snapshotter" in store.stdout
                refs = [args.image + "@" + args.digest]
                for tag in [args.tag, args.release]:
                    if tag:
                        if registry.manifest(tag)[0] != args.digest:
                            raise RuntimeError("tag does not match published digest: " + tag)
                        refs.append(args.image + ":" + tag)
                for arch in sorted(PLATFORMS):
                    for ref in refs:
                        docker(["pull", "--platform", "linux/" + arch, ref], env)
                        options = ["--platform", "linux/" + arch] if containerd else []
                        result = docker(["image", "inspect", *options, "--format",
                                         "{{.Architecture}} {{index .Config.Labels \"org.opencontainers.image.revision\"}}",
                                         ref], env, capture_output=True, text=True)
                        if result.stdout.strip() != f"{arch} {args.sha}":
                            raise RuntimeError("pulled image configuration/revision mismatch: " + result.stdout.strip())
                        docker(["image", "rm", "--force", ref], env)
                print("PASS: fully anonymous digest and tag pulls for linux/amd64 and linux/arm64", flush=True)
                return
            except (urllib.error.URLError, RuntimeError, subprocess.CalledProcessError) as error:
                if time.monotonic() >= deadline:
                    raise RuntimeError("anonymous pull verification failed; package must be Public and all tags available") from error
                print(f"Anonymous verification not ready ({type(error).__name__}); retrying in 20s", flush=True)
                time.sleep(20)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["build", "publish", "verify"])
    parser.add_argument("--image", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--branch", default="")
    parser.add_argument("--builder", default="")
    parser.add_argument("--platform", default="")
    parser.add_argument("--release", default="")
    parser.add_argument("--confirm", default="")
    parser.add_argument("--expected-sha", default="")
    parser.add_argument("--digest", default="")
    parser.add_argument("--retry-seconds", type=int, default=300)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        parser.error("a full commit SHA is required")
    if args.mode in {"build", "publish"} and not re.fullmatch(r"[A-Za-z0-9_.-]+", args.builder):
        parser.error("an explicit setup-buildx-action builder is required")
    if args.mode == "verify" and not re.fullmatch(r"sha256:[0-9a-f]{64}", args.digest):
        parser.error("an exact image digest is required")
    args.tag = "sha-" + args.sha
    {"build": build, "publish": publish, "verify": verify}[args.mode](args)


if __name__ == "__main__":
    main()

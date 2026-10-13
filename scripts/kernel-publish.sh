#!/usr/bin/env bash
# The room kernels of a release that GitHub's runners cannot build, to GHCR:
# base-gpu and kaggle-gpu (owner's decision 3, docs/architecture/remote-runners.md).
#
#   make kernel-publish ENV=base-gpu,kaggle-gpu       the two, parents first
#   make kernel-publish ENV=kaggle-gpu OWNER=a-fork   ghcr.io/a-fork/colloq-kernel
#
# On a builder with a card, from a clean checkout of the release tag, after
# `docker login ghcr.io` with a token that writes packages (RELEASING.md, "GPU
# kernels"):
#
#   git clone --branch vX.Y.Z https://github.com/colloq-edu/colloq && cd colloq
#   make kernel-publish ENV=base-gpu,kaggle-gpu
#
# WHY NOT IN publish.yml. A standard GitHub-hosted Linux runner is documented
# with 14 GB of SSD, and kaggle-gpu alone is 12.7 GB unpacked (base-gpu 9.9 GB,
# measured 13 Oct 2026). The kernels job builds each image twice, once loaded
# for its check and once pushed from the cache, so a GPU kernel would want its
# unpacked layers in the builder's cache, the compressed ones for the push and
# a loaded copy in the runner's Docker, about 30 GB at the peak, plus pip's own
# download of the CUDA wheels while the layer is made. Freeing the runner's
# preinstalled toolchains buys room that is documented nowhere and moves with
# every runner image. And the one check that matters here, torch seeing CUDA
# on a card, cannot run on a machine without one. A Vast VM with a card builds
# both in about nine minutes and pushes about 4 GB.
#
# THE SAME IMAGES THE CPU KERNELS ARE: what publish.yml's kernels job does,
# for the other lists. The tag is <repo>:v<version>-<environment>, the one the
# entry point pulls before it builds anything (entrypoint.sh · kernel_pull_ref)
# and scripts/release-build.py takes as published. The labels are the same,
# the version and the environment among them, by which the entry point knows
# a loaded image for the published one. Parents go first, and a child is built
# on its parent's pushed digest, not on a tag that could move. Each image runs
# once before its push: the imports every kernel needs, the kaggle-base check
# (kernel/locks) for the kaggle stacks, and torch on a CUDA card for a GPU
# list. A tag that is already published is never built again: it is what the
# fleet already pulled, by digest.
#
# Plain bash, no bash-5 idioms: tests/vast-runner-fleet.test.mts runs this
# script with a stand-in docker on a Mac.
set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '[kernel-publish] %s\n' "$*"; }
die() { printf '[kernel-publish] ERROR: %s\n' "$*" >&2; exit 1; }

envs="$(printf '%s' "${ENVIRONMENTS:-base-gpu kaggle-gpu}" | tr ',' ' ')"
[ -n "$(printf '%s' "$envs" | tr -d '[:space:]')" ] || die "ENV= names the environments to publish: make kernel-publish ENV=base-gpu,kaggle-gpu"

# The version and the commit the images will say they are. The release's own
# lists or nothing: an image under an immutable tag that holds an edited list
# would be a lie nobody can take back.
version="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' package.json | head -1)"
case "$version" in
  ''|0.0.0*|*-dev) die "package.json names no release version (\"$version\")" ;;
esac
tag="v$version"
[ "$(git describe --tags --exact-match HEAD 2>/dev/null || true)" = "$tag" ] \
  || die "HEAD is not the release tag $tag: check the tag out (git checkout $tag), so that the images carry the release's own lists"
git diff --quiet HEAD -- kernel scripts/check-kaggle-base.py \
  || die "kernel/ has local changes: an image published as $tag is built from the tag itself"
commit="$(git rev-parse HEAD)"

owner="$(printf '%s' "${OWNER:-colloq-edu}" | tr '[:upper:]' '[:lower:]')"
repo="${REPO:-ghcr.io/$owner/colloq-kernel}"
source_url="${SOURCE_URL:-https://github.com/$owner/colloq}"

# One `# colloq: <key> <value>` directive of a list, read the way the entry
# point and the panel read it.
directive() {
  sed -nE "s/^[[:space:]]*#[[:space:]]*colloq:[[:space:]]*$1[[:space:]]+([^[:space:]]+)[[:space:]]*\$/\\1/p" \
    "kernel/environments/$2.txt" | head -1
}

# A GPU list says so itself or inherits it from a parent (kaggle-gpu from base-gpu).
is_gpu() {
  local name="$1" i=0
  while [ -n "$name" ] && [ "$i" -lt 8 ]; do
    grep -qE '^[[:space:]]*#[[:space:]]*colloq:[[:space:]]*gpu[[:space:]]*$' "kernel/environments/$name.txt" && return 0
    name="$(directive from "$name")"; i=$((i + 1))
  done
  return 1
}

# Parents first: a child is built on the image published for its parent.
order=()
add() {
  local parent
  case " ${order[*]:-} " in *" $1 "*) return 0 ;; esac
  [ "${2:-0}" -lt 8 ] || die "the environments around $1 inherit from each other in a circle"
  [ -f "kernel/environments/$1.txt" ] || die "no kernel/environments/$1.txt"
  git ls-files --error-unmatch "kernel/environments/$1.txt" >/dev/null 2>&1 \
    || die "kernel/environments/$1.txt is not part of $tag: only the release's own lists are published under its tag"
  parent="$(directive from "$1")"
  if [ -n "$parent" ]; then add "$parent" $(( ${2:-0} + 1 )); fi
  order+=("$1")
}
for name in $envs; do add "$name"; done

gpu_needed=0
for name in "${order[@]}"; do if is_gpu "$name"; then gpu_needed=1; fi; done
if [ "$gpu_needed" = 1 ] && ! docker info 2>/dev/null | grep -qi nvidia; then
  die "this builder's Docker has no NVIDIA runtime, so torch cannot be checked on a card before the push: build on a machine with a card and nvidia-container-toolkit"
fi

# buildx with its own builder: provenance and an SBOM, as for every other
# image of a release, need the docker-container driver (the default docker
# driver of a plain Docker Engine refuses attestations).
builder="${BUILDER:-colloq-kernel-publish}"
docker buildx inspect "$builder" >/dev/null 2>&1 \
  || docker buildx create --name "$builder" --driver docker-container --bootstrap >/dev/null

# The image a check runs: the one just built, loaded under a name of this
# run's own, never as colloq-kernel:<env>. A builder may run an instance too
# (the Vast VM of RELEASING.md starts an idle one), and an instance builds and
# pulls colloq-kernel:<env> whenever it likes: a tag it moved between this
# load and the check would have the check pass on its image while this one is
# pushed. Nor is the instance's own name rewritten by a release step: an
# instance that holds colloq-kernel:<env> keeps it (RELEASING.md says how to
# move one onto the published kernels). The names go when the run ends.
probes=""
probe_ref() { printf 'colloq-kernel-publish:%s-%s-%s' "$tag" "$1" "$$"; }

check() {
  local name="$1" ref="$2"
  docker run --rm --network none "$ref" \
    python -c 'import jupyter_server, ipykernel, numpy, pandas, matplotlib, plotly, sklearn, black'
  case "$name" in
    kaggle-*)
      docker run --rm --network none --read-only --tmpfs /tmp:rw,size=512m --user 1000:1000 \
        --cpus 2 --memory 4g -e HOME=/tmp -e MPLCONFIGDIR=/tmp/mpl -e NUMBA_CACHE_DIR=/tmp/numba \
        -v "$PWD/scripts/check-kaggle-base.py:/check.py:ro" "$ref" python /check.py >/dev/null ;;
  esac
  if is_gpu "$name"; then
    docker run --rm --network none --gpus device=0 "$ref" python -c '
import torch
assert torch.cuda.is_available(), "torch sees no CUDA card"
torch.ones(1).cuda()
print("torch", torch.__version__, "CUDA", torch.version.cuda, "on", torch.cuda.get_device_name(0))'
  fi
}

work="$(mktemp -d -t colloq-kernel-publish.XXXXXX)"
cleanup() {
  local ref
  rm -rf "$work"
  for ref in $probes; do docker image rm "$ref" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT
digest_of() { cat "$work/$1.digest"; }

for name in "${order[@]}"; do
  ref="$repo:$tag-$name"
  if published="$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}' 2>/dev/null)" \
      && [[ "$published" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    say "$ref is already published ($published); not building it again"
    printf '%s' "$published" > "$work/$name.digest"
    continue
  fi
  args=(--builder "$builder" --platform linux/amd64 -f kernel/Dockerfile --build-arg "KERNEL_ENV=$name"
    --label "org.opencontainers.image.title=colloq-kernel"
    --label "org.opencontainers.image.description=Colloq room kernel: the $name environment"
    --label "org.opencontainers.image.version=$version"
    --label "org.opencontainers.image.revision=$commit"
    --label "org.opencontainers.image.source=$source_url"
    --label "org.opencontainers.image.licenses=MIT"
    --label "colloq.environment=$name")
  parent="$(directive from "$name")"
  if [ -n "$parent" ]; then
    args+=(--build-arg "PARENT=$repo@$(digest_of "$parent")")
  else
    python="$(directive python "$name")"
    if [ -n "$python" ]; then args+=(--build-arg "PARENT=python:$python-slim-bookworm"); fi
  fi
  say "building $name${parent:+ on $parent}"
  probe="$(probe_ref "$name")"
  probes="$probes $probe"
  docker buildx build "${args[@]}" --provenance=false --load -t "$probe" kernel
  say "checking $name"
  check "$name" "$probe"
  say "pushing $ref"
  docker buildx build "${args[@]}" --push --provenance=mode=max --sbom=true \
    --metadata-file "$work/$name.json" -t "$ref" kernel
  digest="$(sed -nE 's/.*"containerimage\.digest"[[:space:]]*:[[:space:]]*"(sha256:[a-f0-9]{64})".*/\1/p' "$work/$name.json" | head -1)"
  [ -n "$digest" ] || die "buildx wrote no digest for $ref"
  printf '%s' "$digest" > "$work/$name.digest"
  say "published $ref ($digest)"
done

say "done: $(for name in "${order[@]}"; do printf '%s ' "$repo:$tag-$name@$(digest_of "$name")"; done)"
say "instances and machines pull them by the version's tag (KERNEL_PRELOAD=base,base-gpu,kaggle-gpu on a GPU instance)"

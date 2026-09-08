#!/usr/bin/env bash
# One-node production deployment. No release is inferred from this working tree.
set -euo pipefail
ORIGINAL_ARGS=("$@")
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="${COLLOQ_STATE_DIR:-/var/lib/colloq}"
NS=colloq
PORT=30080
CMD="${1:-help}"; [ "$#" -eq 0 ] || shift
RELEASE="${RELEASE_MANIFEST:-}"
ENV_FILE=""
REGISTRY_CONFIG=""
PUBLIC_URL=""
if [ "$CMD" = public-url ]; then PUBLIC_URL="${1:-}"; [ "$#" -eq 0 ] || shift; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) RELEASE="${2:?--release requires a file}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file requires a file}"; shift 2 ;;
    --registry-config) REGISTRY_CONFIG="${2:?--registry-config requires docker config JSON}"; shift 2 ;;
    --*) printf 'unknown argument: %s\n' "$1" >&2; exit 1 ;;
    *) [ -z "$RELEASE" ] || { echo 'only one release file is allowed' >&2; exit 1; }; RELEASE="$1"; shift ;;
  esac
done
die() { printf 'cluster: %s\n' "$*" >&2; exit 1; }
release() { python3 "$SCRIPT_DIR/release.py" "$@"; }
kube() (
  # Use the matching multicall client directly. Some packaged k3s builds pass
  # the literal subcommand through to kubectl when invoked as `k3s kubectl`.
  # Never inherit an operator's unrelated cluster context.
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  exec -a kubectl "$(command -v k3s)" "$@"
)
k() { kube -n "$NS" "$@"; }
need_root() {
  [ "$(uname -s)" = Linux ] || die 'production deployment requires a Linux VM'
  [ "$(id -u)" = 0 ] || die 'run this host provisioning command as root'
}
need_cluster() { command -v k3s >/dev/null || die 'k3s is not installed; install an explicit release first'; }
guard_restore() {
  case "$CMD" in
    prepare|install|update|rollback|start|public-url|smoke|gpu-preflight)
      if [ -e "$STATE/.restore-in-progress" ] || [ -L "$STATE/.restore-in-progress" ]; then
        die 'an incomplete restore is in progress; recover the verified backup before starting or changing workloads'
      fi ;;
  esac
}
data_release() {
  if [ -f "$STATE/recovery/release.json" ]; then printf '%s\n' "$STATE/recovery/release.json";
  else printf '%s\n' "$STATE/releases/current.json"; fi
}

case "$CMD" in
  validate|render|prepare|install|update|rollback)
    [ -n "$RELEASE" ] || die 'an explicit --release FILE is required'
    release validate --release "$RELEASE" >/dev/null
    ;;
esac
case "$CMD" in
  validate) exec python3 "$SCRIPT_DIR/release.py" validate --release "$RELEASE" ;;
  render) exec python3 "$SCRIPT_DIR/release.py" render --release "$RELEASE" --state-dir "$STATE" --node-name "${COLLOQ_NODE_NAME:-colloq}" ;;
  help)
    cat <<'HELP'
cluster.sh validate|render --release FILE       inspect before host changes
cluster.sh prepare --release FILE [--env-file FILE] [--registry-config FILE]
                                               install resources, all writers stopped
cluster.sh install|update|rollback --release FILE
                                               prepare, start, verify readiness
cluster.sh start|stop|status|logs                manage the installed application
cluster.sh public-url https://example.edu       update public URL, restart app if running
cluster.sh smoke|gpu-preflight                 disposable room/CUDA execution checks

State: /var/lib/colloq (COLLOQ_STATE_DIR overrides). App: 127.0.0.1:30080.
Install/prepare require an explicit release with immutable image digests.
Updates require a verified backup first. k3s upgrades are separate operations.
HELP
    exit 0 ;;
esac
guard_restore
case "$CMD" in
  prepare|install|update|rollback)
    release verify-tooling --release "$RELEASE" --tooling-root "$SCRIPT_DIR/.." >/dev/null ;;
esac
need_root
umask 077
case "$CMD" in
  prepare|install|update|rollback|start|stop|public-url|smoke|gpu-preflight|restore-services)
    if ! python3 "$SCRIPT_DIR/state-lock.py" held --state "$STATE"; then
      exec python3 "$SCRIPT_DIR/state-lock.py" run --state "$STATE" -- bash "$SCRIPT_DIR/cluster.sh" "${ORIGINAL_ARGS[@]}"
    fi
    # A restore may have begun after the early read-only check but before the lock.
    guard_restore
    ;;
esac

stop_writers() {
  k scale deployment/colloq-app deployment/colloq-runtime --replicas=0
  k wait --for=delete pod -l 'colloq.dev/role in (app,runtime)' --timeout=90s
  # Stop the broker before deleting kernels: it must not recreate a room.
  k delete pods -l colloq.kind=room-kernel --wait=true --timeout=120s
  k delete services -l 'app.kubernetes.io/managed-by=colloq-runtime,colloq.dev/retired!=true' --ignore-not-found
}

firewall() {
  command -v iptables >/dev/null || die 'iptables is required to keep Kubernetes host ports private'
  # This does not block the NetworkPolicy local-node exception. See deploy/k3s/README.md.
  iptables -N COLLOQ-HOST 2>/dev/null || true
  iptables -F COLLOQ-HOST
  iptables -A COLLOQ-HOST -i lo -j RETURN
  iptables -A COLLOQ-HOST -s 10.42.0.0/16 -j RETURN
  iptables -A COLLOQ-HOST -p tcp -m multiport --dports 6443,10250,30080 -j DROP
  iptables -A COLLOQ-HOST -p udp --dport 8472 -j DROP
  iptables -A COLLOQ-HOST -j RETURN
  iptables -C INPUT -j COLLOQ-HOST 2>/dev/null || iptables -I INPUT 1 -j COLLOQ-HOST
  if [ -s /proc/net/if_inet6 ]; then
    command -v ip6tables >/dev/null || die 'ip6tables is required on IPv6-enabled hosts'
    ip6tables -N COLLOQ-HOST 2>/dev/null || true
    ip6tables -F COLLOQ-HOST
    ip6tables -A COLLOQ-HOST -i lo -j RETURN
    ip6tables -A COLLOQ-HOST -p tcp -m multiport --dports 6443,10250,30080 -j DROP
    ip6tables -A COLLOQ-HOST -p udp --dport 8472 -j DROP
    ip6tables -A COLLOQ-HOST -j RETURN
    ip6tables -C INPUT -j COLLOQ-HOST 2>/dev/null || ip6tables -I INPUT 1 -j COLLOQ-HOST
  fi
}

bootstrap() {
  local wanted have tmp
  wanted="$(release field --release "$RELEASE" --field k3sVersion)"
  if systemctl cat colloq.service >/dev/null 2>&1; then
    die 'legacy colloq.service exists; stop/remove that root service and migrate its data explicitly before installing k3s workloads'
  fi
  gpu_toolkit
  if command -v k3s >/dev/null; then
    have="$(k3s --version | head -1 | awk '{print $3}')"
    [ "$have" = "$wanted" ] || die "installed k3s $have differs from release $wanted; upgrade k3s separately after backing up its datastore and token"
    [ -f /etc/rancher/k3s/colloq-managed ] || die 'existing k3s is not Colloq-managed; review deploy/k3s/README.md before migration'
    if [ "${GPU_RUNTIME_CHANGED:-0}" = 1 ]; then systemctl restart k3s; fi
    systemctl is-active --quiet k3s || systemctl start k3s
    return
  fi
  [ "$(uname -m)" = x86_64 ] || die 'this release installer currently supports Linux amd64 only'
  command -v systemctl >/dev/null || die 'systemd is required'
  command -v iptables >/dev/null || die 'install iptables before bootstrapping k3s'
  command -v curl >/dev/null || die 'curl is required'
  tmp="$(mktemp -d)"
  # Both artifacts come from the explicit upstream release, never a latest channel.
  curl -fL --retry 3 "https://github.com/k3s-io/k3s/releases/download/$wanted/k3s" -o "$tmp/k3s"
  curl -fL --retry 3 "https://github.com/k3s-io/k3s/releases/download/$wanted/sha256sum-amd64.txt" -o "$tmp/checksums"
  (cd "$tmp" && awk '$2 == "k3s" || $2 == "*k3s" {print}' checksums > selected && test -s selected && sha256sum -c selected)
  install -m 0755 "$tmp/k3s" /usr/local/bin/k3s
  mkdir -p /etc/rancher/k3s
  cat > /etc/rancher/k3s/config.yaml <<'CONFIG'
disable:
  - traefik
  - servicelb
  - local-storage
write-kubeconfig-mode: "0600"
secrets-encryption: true
cluster-cidr: 10.42.0.0/16
service-cidr: 10.43.0.0/16
kube-proxy-arg:
  - nodeport-addresses=127.0.0.0/8
kubelet-arg:
  - pod-max-pids=256
CONFIG
  cat > /etc/systemd/system/k3s.service <<'UNIT'
[Unit]
Description=Colloq single-node k3s
Wants=network-online.target
After=network-online.target colloq-firewall.service
Requires=colloq-firewall.service
[Service]
Type=notify
ExecStart=/usr/local/bin/k3s server
Delegate=yes
KillMode=process
Restart=always
RestartSec=5
LimitNOFILE=1048576
LimitNPROC=infinity
TasksMax=infinity
[Install]
WantedBy=multi-user.target
UNIT
  # Persist host exposure restrictions across reboot without a broad firewall reset.
  install -m 0755 "$SCRIPT_DIR/cluster.sh" /usr/local/sbin/colloq-cluster-firewall
  cat > /etc/systemd/system/colloq-firewall.service <<'UNIT'
[Unit]
Description=Keep Colloq Kubernetes host ports private
Before=k3s.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/colloq-cluster-firewall firewall
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
  touch /etc/rancher/k3s/colloq-managed
  systemctl daemon-reload
  systemctl enable --now colloq-firewall.service
  systemctl enable --now k3s
}

gpu_toolkit() {
  [ "$(release field --release "$RELEASE" --field gpu)" = true ] || return 0
  command -v nvidia-smi >/dev/null || die 'GPU release requires a preinstalled working NVIDIA host driver; the installer will not replace it'
  nvidia-smi --query-gpu=index,name --format=csv,noheader || die 'host NVIDIA driver is not working'
  local wanted have package matches=1
  wanted="$(release field --release "$RELEASE" --field toolkitVersion)"
  command -v apt-get >/dev/null || die 'pinned GPU toolkit installation supports Debian/Ubuntu apt hosts'
  for package in nvidia-container-toolkit nvidia-container-toolkit-base libnvidia-container-tools libnvidia-container1; do
    have="$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null || true)"
    if [ -n "$have" ] && dpkg --compare-versions "$have" gt "$wanted"; then
      die "$package $have is newer than release pin $wanted; select a release with compatible tooling or explicitly downgrade the toolkit before retrying"
    fi
    if [ "$have" != "$wanted" ]; then matches=0; fi
  done
  if [ "$matches" = 0 ]; then
    command -v gpg >/dev/null || die 'install gnupg before configuring the signed NVIDIA package repository'
    mkdir -p /usr/share/keyrings
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' \
      > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      "nvidia-container-toolkit=$wanted" "nvidia-container-toolkit-base=$wanted" \
      "libnvidia-container-tools=$wanted" "libnvidia-container1=$wanted"
    GPU_RUNTIME_CHANGED=1
  fi
  command -v nvidia-container-runtime >/dev/null || die 'NVIDIA container runtime is missing after pinned toolkit installation'
  # k3s detects nvidia-container-runtime and generates its own containerd config.
  # Do not configure Docker or edit k3s's generated containerd TOML.
}

gpu_plugin() {
  [ "$(release field --release "$1" --field gpu)" = true ] || return 0
  # The plugin runs in a trusted namespace; carry only the pull credential there.
  k get secret colloq-registry -o json | python3 -c 'import json,sys; value=json.load(sys.stdin); value["metadata"]={"name":"colloq-registry","namespace":"kube-system"}; print(json.dumps(value))' \
    | kube apply -f - >/dev/null
  release gpu --release "$1" | kube apply -f -
  kube -n kube-system rollout status daemonset/colloq-nvidia-device-plugin --timeout=180s
  # A running plugin can precede the kubelet's next node-status update.
  local count deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    count="$(k get nodes --request-timeout=5s -o 'jsonpath={.items[0].status.allocatable.nvidia\.com/gpu}' || true)"
    if [[ "$count" =~ ^[1-9][0-9]*$ ]]; then return 0; fi
    sleep 2
  done
  die 'NVIDIA plugin has no allocatable GPU after waiting for registration; check driver, toolkit and k3s runtime logs'
}

gpu_preflight() {
  local manifest="$STATE/releases/current.json"
  [ "$(release field --release "$manifest" --field gpu)" = true ] || return 0
  nvidia-smi --query-gpu=index,name --format=csv,noheader || die 'NVIDIA host driver failed'
  # Never evict a room to obtain a GPU. A busy device makes the bounded probe fail.
  k delete pod colloq-gpu-check --ignore-not-found --wait=true >/dev/null
  release gpu-smoke --release "$manifest" | k create -f - >/dev/null
  if ! k wait --for=jsonpath='{.status.phase}'=Succeeded pod/colloq-gpu-check --timeout=200s; then
    k describe pod colloq-gpu-check >&2
    k logs colloq-gpu-check >&2 || true
    k delete pod colloq-gpu-check --wait=true >/dev/null
    die 'CUDA probe failed or no exclusive GPU was free; existing rooms were not evicted'
  fi
  k logs colloq-gpu-check
  k delete pod colloq-gpu-check --wait=true >/dev/null
}

wait_for_node() {
  local nodes state deadline=$((SECONDS + 180))
  while [ "$SECONDS" -lt "$deadline" ]; do
    # The API can be reachable before the kubelet creates its first Node.
    if nodes="$(k get nodes --request-timeout=5s -o json 2>/dev/null)"; then
      state="$(printf '%s' "$nodes" | python3 -c '
import json,sys
nodes=json.load(sys.stdin)["items"]
if len(nodes)>1:
    print("multiple")
elif len(nodes)==1:
    node=nodes[0]
    hostname=node.get("metadata",{}).get("labels",{}).get("kubernetes.io/hostname")
    ready=any(c.get("type")=="Ready" and c.get("status")=="True" for c in node.get("status",{}).get("conditions",[]))
    if ready and hostname:
        print("ready " + hostname)
')" || die 'cannot parse Kubernetes node status'
      case "$state" in
        multiple) die 'this deployment supports exactly one node' ;;
        ready\ *) printf '%s\n' "${state#ready }"; return 0 ;;
      esac
    fi
    sleep 2
  done
  die 'no single ready Kubernetes node registered within 180 seconds; check k3s and kubelet logs'
}

prepare() {
  local effective node current policy_version data extras=()
  guard_restore
  mkdir -p "$STATE/releases" "$STATE/secrets" "$STATE/data" "$STATE/workspace"
  chmod 0750 "$STATE/data" "$STATE/workspace"
  chown 1000:1000 "$STATE/data" "$STATE/workspace"
  current="$STATE/releases/current.json"
  data="$(data_release)"
  if [ -f "$current" ]; then extras=(--previous "$current"); fi
  if [ -f "$data" ]; then extras+=(--data-release "$data"); fi
  if [ "$CMD" = rollback ]; then extras+=(--rollback); fi
  effective="$(mktemp "$STATE/releases/.release.XXXXXX")"
  release merge --release "$RELEASE" "${extras[@]}" > "$effective"
  if [ -f "$STATE/recovery/release.json" ]; then
    release merge --release "$effective" --previous "$STATE/recovery/release.json" --data-release "$data" > "$effective.recovery"
    mv "$effective.recovery" "$effective"
  fi
  RELEASE="$effective" bootstrap
  need_cluster
  node="$(wait_for_node)"
  k create namespace "$NS" --dry-run=client -o json | k apply -f - >/dev/null
  policy_version="$(release field --release "$effective" --field policyVersion)"
  k label namespace "$NS" pod-security.kubernetes.io/enforce=restricted \
    "pod-security.kubernetes.io/enforce-version=$policy_version" \
    pod-security.kubernetes.io/audit=restricted "pod-security.kubernetes.io/audit-version=$policy_version" \
    pod-security.kubernetes.io/warn=restricted "pod-security.kubernetes.io/warn-version=$policy_version" --overwrite >/dev/null
  if [ -n "$REGISTRY_CONFIG" ]; then
    k create secret generic colloq-registry --type=kubernetes.io/dockerconfigjson --from-file=".dockerconfigjson=$REGISTRY_CONFIG" --dry-run=client -o json | k apply -f - >/dev/null
  elif ! k get secret colloq-registry >/dev/null 2>&1; then
    k create secret generic colloq-registry --type=kubernetes.io/dockerconfigjson --from-literal='.dockerconfigjson={"auths":{}}' >/dev/null
  fi
  gpu_plugin "$effective"
  # Kubernetes uses the same imagePullSecret as the actual workloads. ctr/crictl
  # pulls would bypass it and break otherwise valid private-registry releases.
  k delete pod colloq-image-check --ignore-not-found --wait=true >/dev/null
  release prepull --release "$effective" | k create -f - >/dev/null
  if ! k wait --for=jsonpath='{.status.phase}'=Succeeded pod/colloq-image-check --timeout=900s; then
    k describe pod colloq-image-check >&2
    die 'release images could not be pulled/run as UID 1000; inspect the preflight Pod before retrying (updates leave writers stopped after backup)'
  fi
  k delete pod colloq-image-check --wait=true >/dev/null
  if k get deployment colloq-app >/dev/null 2>&1; then stop_writers; fi
  for secret in runtime-token room-secret; do
    if [ ! -s "$STATE/secrets/$secret" ]; then
      python3 -c 'import secrets; print(secrets.token_hex(32))' > "$STATE/secrets/$secret"
    fi
    chmod 0600 "$STATE/secrets/$secret"
  done
  k create secret generic colloq-runtime-auth --from-file="runtime-token=$STATE/secrets/runtime-token" --dry-run=client -o json | k apply -f - >/dev/null
  k create secret generic colloq-room-secret --from-file="room-secret=$STATE/secrets/room-secret" --dry-run=client -o json | k apply -f - >/dev/null
  if [ -n "$ENV_FILE" ]; then cp "$ENV_FILE" "$STATE/config.env"; chmod 0600 "$STATE/config.env"; fi
  if [ -f "$STATE/config.env" ]; then
    release config --release "$effective" --env-file "$STATE/config.env" | k apply -f - >/dev/null
  elif ! k get secret colloq-app-config >/dev/null 2>&1; then
    release config --release "$effective" | k apply -f - >/dev/null
  fi
  release render --release "$effective" --node-name "$node" --state-dir "$STATE" | k apply -f -
  [ ! -f "$current" ] || cp "$current" "$STATE/releases/previous.json"
  mv "$effective" "$current"
  printf 'Release prepared; all writers stopped. Restore if needed, then cluster.sh start.\n'
}

start() {
  guard_restore
  need_cluster
  if [ -f "$STATE/recovery/release.json" ]; then
    release validate --release "$STATE/releases/current.json" --data-release "$STATE/recovery/release.json" >/dev/null
  fi
  k scale deployment/colloq-runtime --replicas=1
  k rollout status deployment/colloq-runtime --timeout=180s
  # Once the app is admitted it may migrate SQLite even if readiness later fails.
  # Consume the restored-schema override before that first possible writer.
  release consume-recovery --release "$STATE/releases/current.json" --state-dir "$STATE"
  k scale deployment/colloq-app --replicas=1
  k rollout status deployment/colloq-app --timeout=180s
  curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" >/dev/null
  gpu_preflight
  printf 'Colloq ready on http://127.0.0.1:%s; use cluster.sh smoke to verify two-room execution.\n' "$PORT"
}

case "$CMD" in
  firewall) firewall ;;
  prepare) prepare ;;
  install) prepare; start ;;
  update|rollback)
    [ -f "$STATE/releases/current.json" ] || die 'no installed release; use install'
    # Validate schema compatibility before taking writers down for a backup.
    data="$(data_release)"
    release merge --release "$RELEASE" --previous "$STATE/releases/current.json" --data-release "$data" >/dev/null
    [ -x "$SCRIPT_DIR/backup.sh" ] || die 'backup.sh is required before an update'
    MODE=consistent RESUME=0 RELEASE="$data" COLLOQ_STATE_DIR="$STATE" "$SCRIPT_DIR/backup.sh"
    prepare; start ;;
  start) start ;;
  stop) need_cluster; stop_writers ;;
  restore-services)
    need_cluster
    STATE="$STATE" python3 - <<'PY'
import json, os, pathlib
try:
    marker = json.loads((pathlib.Path(os.environ['STATE']) / '.restore-in-progress').read_text())
    if marker.get('phase') != 'files-restored':
        raise ValueError('invalid phase')
except (OSError, ValueError, AttributeError):
    raise SystemExit('restore-services requires the verified files-restored recovery phase')
PY
    writers="$(k get pods -l 'colloq.dev/role in (app,runtime,kernel)' -o name)"
    [ -z "$writers" ] \
      || die 'restore-services refuses while app, broker or kernel Pods exist'
    writers="$(k get pods -l colloq.kind=room-kernel -o name)"
    [ -z "$writers" ] \
      || die 'restore-services refuses while room Pods exist'
    k delete services -l app.kubernetes.io/managed-by=colloq-runtime --ignore-not-found --wait=true --timeout=90s
    ;;
  status) need_cluster; k get deployments,pods,pvc; curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" ;;
  logs) need_cluster; k logs -f deployment/colloq-app --tail=80 ;;
  gpu-preflight) need_cluster; gpu_preflight ;;
  smoke) need_cluster; k exec deployment/colloq-app -- node /app/dist/runtime-smoke.js ;;
  public-url)
    need_cluster
    changed=0
    PUBLIC_URL="$PUBLIC_URL" STATE="$STATE" python3 - <<'PY' || changed=$?
import os, pathlib, urllib.parse
url = os.environ['PUBLIC_URL']
parsed = urllib.parse.urlsplit(url)
if parsed.scheme not in ('http', 'https') or not parsed.netloc or '\n' in url or '\r' in url:
    raise SystemExit('public-url requires an absolute HTTP(S) URL')
file = pathlib.Path(os.environ['STATE']) / 'config.env'
lines = file.read_text().splitlines() if file.exists() else []
current = next((x[11:] for x in reversed(lines) if x.startswith('PUBLIC_URL=')), None)
if current == url:
    raise SystemExit(3)
temp = file.with_suffix('.tmp')
temp.write_text('\n'.join([x for x in lines if not x.startswith('PUBLIC_URL=')] + ['PUBLIC_URL=' + url, '']))
temp.replace(file)
PY
    [ "$changed" != 3 ] || exit 0
    [ "$changed" = 0 ] || die 'could not update public URL'
    release config --release "$STATE/releases/current.json" --env-file "$STATE/config.env" | k apply -f - >/dev/null
    if [ "$(k get deployment colloq-app -o jsonpath='{.spec.replicas}')" != 0 ]; then
      k rollout restart deployment/colloq-app
      k rollout status deployment/colloq-app --timeout=180s
    fi
    ;;
  *) die "unknown command: $CMD" ;;
esac

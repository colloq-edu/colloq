# Colloq Helm chart

Colloq in one namespace of your Kubernetes: the web app (`colloq-app`), the
runtime broker (`colloq-runtime`), and one kernel Pod per room that the broker
creates through the namespaced Kubernetes API. Competition submissions run as
broker-created Pods too. Everything the chart renders passes restricted Pod
Security, carries requests, limits, probes and the standard
`app.kubernetes.io/*` labels, uses images pinned by digest, and declares every
network flow for a namespace whose default is deny.

The published chart carries the release's image digests and kernel catalog:

```sh
helm install colloq oci://ghcr.io/colloq-edu/charts/colloq --version 0.9.0 \
  --namespace colloq \
  --set ingress.host=colloq.example.edu \
  --set ingress.tls.secretName=colloq-tls
```

The copy of the chart in the source tree has empty digests and refuses to
render until they are set. After the install, `NOTES` print how to open Colloq
and how the first owner gets in: read the setup token from the app's data volume
(`kubectl -n colloq exec deploy/colloq-app -- cat /data/setup-token`) and open
`https://<host>/admin/t/<token>`.

**One replica, strategy Recreate.** The database is SQLite with a single writer
and the rooms' live state is in that one process, so `colloq-app` and
`colloq-runtime` run one replica each and are never scaled. An upgrade restarts
the app for a few seconds; rooms keep running meanwhile.

**One Colloq per namespace.** The broker treats every room Pod in its namespace
as its own, and objects have fixed names (`colloq-app`, `colloq-runtime`, the
ServiceAccount `colloq-kernel` that room Pods run as, the competition
NetworkPolicies the broker looks up by name). A second release in the same
namespace fails on those names instead of sharing rooms with the first.

## What the platform provides

| # | Assumption | Where it varies |
|---|---|---|
| 1 | Kubernetes 1.30 or newer (upstream, Deckhouse and similar). In-place room resize needs 1.33 and the `pods/resize` permission; without either it is reported unsupported, not an error. | `runtime.inPlaceResize` |
| 2 | One namespace with namespace-admin rights. The chart creates no cluster-scoped object: no Namespace, PersistentVolume, RuntimeClass, DaemonSet, CRD or ClusterRole. The broker's Role holds only verbs a namespace admin holds; a Role may only grant what its author holds, so drop `pods/resize` if yours lacks it (`kubectl auth can-i patch pods --subresource=resize`). | `runtime.inPlaceResize` |
| 3 | Pod Security `restricted` and a policy engine (Kyverno, Gatekeeper) requiring requests and limits, liveness and readiness probes, a non-root read-only root filesystem, no host access, images from the internal registry pinned by digest, standard labels. | `global.imageRegistry`, `commonLabels`, `rooms.podLabels` |
| 4 | NetworkPolicies are enforced (Calico, Cilium) and the namespace may deny by default. Every flow Colloq needs is declared, both directions. | `networkPolicy.*` |
| 5 | ingress-nginx with a corporate certificate from an existing Secret or cert-manager. Users come from the corporate network or VPN. | `ingress.*` |
| 6 | A StorageClass with ReadWriteOnce; ReadWriteMany (CephFS, NFS) optional. | `persistence.*` |
| 7 | No internet from the cluster: images through a registry mirror (Harbor, Nexus), packages through a PyPI mirror, the model through an internal OpenAI-compatible endpoint or off, an optional HTTP proxy and an internal CA. | `global.imageRegistry`, `dependencies.*`, `config.ai.*`, `outbound.*` |
| 8 | Secrets from Vault through External Secrets, deployment through ArgoCD. The chart never needs a random value at render time: every secret can come from an existing Secret. | `config.existingSecret`, `secrets.*`, `metrics.existingSecret` |
| 9 | Prometheus Operator (optional ServiceMonitor), logs from stdout. | `metrics.*`, `config.logFormat` |
| 10 | Backups by volume snapshots (Velero, CSI) plus consistent database snapshots the app writes into its data volume. | `config.dbSnapshotHours`, `config.dbSnapshotKeep` |
| 11 | GPU nodes optional: runtime class, node selector and tolerations of GPU rooms are values. | `gpu.*` |

## Storage: ReadWriteOnce or ReadWriteMany

Two claims: `colloq-data` (the database, the owner's keys, competition data;
10Gi) and `colloq-workspace` (every room's files; 100Gi). The app mounts both,
room and personal-notebook Pods mount the workspace, competition Pods the data.

- **ReadWriteOnce** (the default, always available): a volume is attached to
  one node, so everything that mounts it must run there. The chart sets
  `RUNTIME_COLOCATE_WITH_APP=1` and the broker gives each of its Pods a required
  affinity to the app's node; the app itself prefers the node where rooms
  already run, because a new app Pod needs their attachment of the volume. That
  node's memory is the classroom's memory: size it for the rooms.
- **ReadWriteMany**: no co-location, rooms spread over the cluster
  (`RUNTIME_COLOCATE_WITH_APP=0`). SQLite has a single writer, the app, so a
  shared filesystem with proper locking (CephFS, NFSv4) is enough; the data
  claim may stay ReadWriteOnce on block storage
  (`persistence.data.accessMode: ReadWriteOnce`), which brings co-location back.

`ReadWriteOncePod` cannot work (the app and the rooms share the volumes). With
`existingClaim` the chart creates nothing and cannot see the claim: set
`accessMode` to that claim's mode. Claims are annotated to survive
`helm uninstall` and the deletion of an ArgoCD application.

## Secrets, Vault and ArgoCD

| Secret | Keys | Mounted by | Replace with |
|---|---|---|---|
| `colloq-app-config` | `OPENAI_API_KEY`, `SESSION_SECRET` | app, as environment | `config.existingSecret`: any app setting, which then wins over the values |
| `colloq-runtime-auth` | `runtime-token` | app and broker | `secrets.runtimeToken.existingSecret` (+ `existingSecretKey`) |
| `colloq-room-secret` | `room-secret` | broker only | `secrets.roomSecret.existingSecret` (+ `existingSecretKey`) |
| `colloq-metrics` | `metrics-token` | app (`METRICS_TOKEN`), ServiceMonitor | `metrics.existingSecret` (+ `existingSecretKey`) |

The runtime token, the room secret and the metrics token are generated once when
nothing else is given, and read back from the live Secret with `lookup` on every
`helm upgrade`, so they never change. **ArgoCD cannot do that:** it renders with
`helm template`, where `lookup` sees no cluster, and every refresh would make new
values (the application stays OutOfSync, and a sync restarts every room). Under
ArgoCD set `existingSecret` for each, or `value` from a plugin such as
argocd-vault-plugin. A value is 43 to 128 characters of `[A-Za-z0-9_-]`:

```sh
kubectl -n colloq create secret generic colloq-runtime --from-literal=runtime-token="$(openssl rand -hex 32)"
kubectl -n colloq create secret generic colloq-rooms --from-literal=room-secret="$(openssl rand -hex 32)"
```

or, with External Secrets:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: {name: colloq-app, namespace: colloq}
spec:
  secretStoreRef: {kind: ClusterSecretStore, name: vault}
  target: {name: colloq-app}
  data:
    - {secretKey: OPENAI_API_KEY, remoteRef: {key: colloq, property: openai-api-key}}
    - {secretKey: SESSION_SECRET, remoteRef: {key: colloq, property: session-secret}}
```

with `config.existingSecret: colloq-app`. Changing the room secret replaces
every room's Pod at its next start (room tokens derive from it); changing
`SESSION_SECRET` signs everyone out. Without `SESSION_SECRET` the app keeps a
generated one in its data volume.

## Network

| From | To | Port |
|---|---|---|
| ingress controller (`networkPolicy.ingressController.from`) | app | 3000 |
| Prometheus (`networkPolicy.monitoring.from`, only with `metrics.enabled`) | app | 3000 |
| app | broker | 8787 |
| app, broker | room and personal-notebook Pods | 8888 |
| broker | competition exporters (notebook, scorer, resolver Pods) | 8765 |
| broker | Kubernetes API (`networkPolicy.kubeApiServer`) | 443, 6443 |
| package resolver | package proxy | 3128 |
| package proxy | public IPv4 (`dependencies.publicEgress`), the mirror (`dependencies.mirrorEgress`) | 443, as listed |
| app | external endpoints (`networkPolicy.app.egress`) | as listed |
| every Colloq Pod except competition notebooks and scorers | cluster DNS (`networkPolicy.dns.to`) | 53 UDP/TCP |

Rooms reach cluster DNS and nothing else (`rooms.network: none` takes DNS away
too); competition notebooks and scorers reach nothing at all. Kubernetes
policies select addresses and labels, never names, so:

- **Ingress controller.** The default selects `app.kubernetes.io/name:
  ingress-nginx` Pods in the namespace `ingress-nginx`. A controller on the host
  network arrives from node addresses: use an `ipBlock` of your nodes. An empty
  list admits nobody.
- **Cluster DNS.** The default is `k8s-app: kube-dns` in `kube-system`. With
  NodeLocal DNSCache add its address (`- ipBlock: {cidr: 169.254.20.10/32}`).
- **Kubernetes API.** `kubernetes.default.svc` is rewritten to the API servers'
  own addresses before policy applies, so the default allows 443 and 6443 to
  any address. Narrow `networkPolicy.kubeApiServer.cidrs` to what
  `kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes`
  shows. Cilium gives the API servers an identity an `ipBlock` does not match
  (unless it runs with `policy-cidr-match-mode=nodes`):
  `networkPolicy.kubeApiServer.ciliumEntity: true` adds a namespaced
  CiliumNetworkPolicy allowing the `kube-apiserver` entity.
- **The app's way out.** None by default. List the model endpoint, the
  outbound proxy and, for notebook import, GitHub in
  `networkPolicy.app.egress` as CIDRs and ports. With a proxy, only the proxy.
- **The package mirror.** Helm cannot resolve names: list the mirror's
  addresses in `dependencies.mirrorEgress`. The proxy itself still admits only
  the names in `dependencies.indexUrl` and `dependencies.filesHosts`.

`config.inbound.trustedProxies` defaults to `private`: only the ingress
controller reaches the app, from a pod address, and ingress-nginx overwrites
`X-Forwarded-For` with the client's address. If every student appears as one
address (a load balancer in front of ingress-nginx that hides clients), list it
in `config.inbound.sharedAddresses`, or make the balancer pass client addresses.

## Registry, proxy and CA

`global.imageRegistry` replaces the registry of every image, the catalog's
kernel images included, and keeps the repository path and digest, which is what
a Harbor or Nexus proxy of `ghcr.io` expects:
`harbor.bank.local/ghcr` turns `ghcr.io/colloq-edu/colloq-app@sha256:…` into
`harbor.bank.local/ghcr/colloq-edu/colloq-app@sha256:…`. Pull secrets
(`global.imagePullSecrets`) go to every Pod of the chart; the broker gives the
first one to the Pods it creates.

`outbound.httpsProxy`/`httpProxy`/`noProxy` apply to the app's own calls (the
model, GitHub); cluster names and private addresses always go direct. A proxy
URL with a password belongs in `config.existingSecret` as `HTTPS_PROXY`. The
institution's CA (`outbound.extraCa.pem`, or `existingConfigMap` and `key`) is
mounted into the app as `NODE_EXTRA_CA_CERTS` and handed to package
preparation. Competition "own packages" go through the mirror
(`dependencies.indexUrl`), not through the proxy.

## Upgrades

- `helm upgrade` (or an ArgoCD sync) restarts the app with Recreate: a few
  seconds without the site; open rooms reconnect by themselves and keep their
  variables, since room Pods are the broker's, not the release's.
- Before a migration raises the data schema the app writes a consistent
  database snapshot into `/data/snapshots`; a release refuses data of a newer
  schema, so going back across a schema change means restoring that snapshot
  (or a volume snapshot) together with the older release.
- A change to what a room Pod runs (a kernel image in the catalog, room
  scratch space, pull secret, room secret) replaces each room's Pod the next
  time that room starts a kernel, which loses the room's variables: upgrade
  between classes. Placement (node selectors, tolerations, priority, runtime
  class, co-location) is different: a running room keeps its Pod, and only its
  next Pod follows the new setting. Room memory and cores change in place on
  Kubernetes 1.33+ with `runtime.inPlaceResize`.
- A helm upgrade keeps the previous release's kernel revisions in the catalog,
  not current (`catalog.retainPrevious`, at most
  `catalog.maxRetainedPerEnvironment` per environment, read from the live
  ConfigMap), so rooms pinned to them keep their Python. A render without the
  cluster (ArgoCD) cannot read them back: there a room whose revision is gone
  moves to its environment's current one on its next start.
- Switching a generated secret to `existingSecret` removes the generated one:
  copy its value into the new Secret first to keep rooms and sign-ins.
- `helm uninstall` keeps the claims and leaves the broker's room Pods and
  Services, which Helm never owned:
  `kubectl -n colloq delete pod,service -l app.kubernetes.io/managed-by=colloq-runtime`.

## Values

Every value, with the environment variable it becomes. `values.yaml` has the
same list with longer explanations; `values.schema.json` rejects unknown keys.

### Images and catalog

| Value | Default | Becomes |
|---|---|---|
| `global.imageRegistry` | `""` | registry of every image, catalog included |
| `global.imagePullSecrets` | `[]` | `imagePullSecrets` of both Pods; the first is `RUNTIME_IMAGE_PULL_SECRET` |
| `commonLabels` | `{}` | labels of every object and Pod, and part of `RUNTIME_POD_LABELS` |
| `image.registry` | `ghcr.io` | registry of the app and runtime images |
| `image.pullPolicy` | `IfNotPresent` | `imagePullPolicy` |
| `image.app.repository` / `image.app.digest` | `colloq-edu/colloq-app` / release | app image |
| `image.runtime.repository` / `image.runtime.digest` | `colloq-edu/colloq-runtime` / release | broker image, `RUNTIME_COMPETITION_EXPORTER_IMAGE` |
| `catalog.release` | `v<appVersion>` | `release` of `catalog.json` |
| `catalog.defaultEnvironment` | `base` | `defaultEnvironment` of `catalog.json` |
| `catalog.environments[]` | release | `name`, `image` (pinned), `gpu`, `packages`, `python`, `current` of `catalog.json` (ConfigMap `colloq-catalog`: `KERNEL_CATALOG_FILE`, `RUNTIME_CATALOG_FILE`) |

### App settings

| Value | Default | Becomes |
|---|---|---|
| `config.existingSecret` | `""` | the app's `envFrom` Secret instead of `colloq-app-config` |
| `config.publicUrl` | `https://<ingress.host>` | `PUBLIC_URL` |
| `config.uiLanguage` | `""` (ru) | `UI_LANGUAGE` |
| `config.timezone` | `""` (Europe/Moscow) | `TZ` |
| `config.institution` | `""` | `INSTITUTION` |
| `config.adminEmail` | `""` | `ADMIN_EMAIL` |
| `config.openSeminarCreation` | `false` | `OPEN_SEMINAR_CREATION` |
| `config.maxUploadMb` | `50` | `MAX_UPLOAD_MB` |
| `config.maxSessionMb` | `1024` | `MAX_SESSION_MB` |
| `config.councilCopyMb` | `512` | `COUNCIL_COPY_MB` |
| `config.councilMemoryGuard` | `true` | `COUNCIL_MEMORY_GUARD` (`1`/`0`) |
| `config.sessionSecret` | `""` | `SESSION_SECRET` (Secret) |
| `config.logFormat` | `text` | `LOG_FORMAT` (only `json` is written) |
| `config.dbSnapshotHours` | `24` | `DB_SNAPSHOT_HOURS` |
| `config.dbSnapshotKeep` | `7` | `DB_SNAPSHOT_KEEP` |
| `config.ai.provider` | `openai` | `AI_PROVIDER` |
| `config.ai.apiKey` | `""` | `OPENAI_API_KEY` (Secret) |
| `config.ai.baseUrl` | `""` | `OPENAI_BASE_URL` |
| `config.ai.model` | `""` | `OPENAI_MODEL` |
| `config.ai.reasoning` | `false` | `AI_REASONING` |
| `config.inbound.trustedProxies` | `private` | `TRUSTED_PROXIES` |
| `config.inbound.sharedAddresses` | `""` | `SHARED_ADDRESSES` |
| `config.inbound.trustCfConnectingIp` | `false` | `TRUST_CF_CONNECTING_IP` (`1`/`0`) |
| `config.inbound.hsts` | `true` | `HSTS` (`1`/`0`) |
| `config.extraEnv` | `{}` | any other app setting, as `NAME: value` |
| `outbound.httpsProxy` | `""` | `HTTPS_PROXY`, `https_proxy` |
| `outbound.httpProxy` | `""` | `HTTP_PROXY`, `http_proxy` |
| `outbound.noProxy` | `""` | `NO_PROXY`, `no_proxy` |
| `outbound.extraCa.pem` | `""` | ConfigMap `colloq-extra-ca`, `NODE_EXTRA_CA_CERTS=/etc/colloq-ca/extra-ca.pem` |
| `outbound.extraCa.existingConfigMap` / `key` | `""` / `extra-ca.pem` | the same from your ConfigMap |
| `dependencies.indexUrl` | `""` (PyPI) | `DEPENDENCY_INDEX_URL` (app and broker) |
| `dependencies.filesHosts` | `""` | `DEPENDENCY_FILES_HOSTS` (app and broker) |
| `dependencies.mirrorEgress` | `[]` | egress of `competition-proxy-isolation` |
| `dependencies.publicEgress` | `true` | the proxy's rule for public IPv4 on 443 |

Non-secret settings form the ConfigMap `colloq-app-env`; empty values are left
out so the app's default applies. The app reads the ConfigMap, then the Secret
(which wins), then its own `env`, which wins over both and holds the wiring
(`KERNEL_BACKEND=broker`, paths, ports) and the settings other objects depend on
(`COLLOQ_ROOM_NETWORK`, `DEPENDENCY_*`, `NODE_EXTRA_CA_CERTS`, `METRICS_TOKEN`).

### Secrets

| Value | Default | Becomes |
|---|---|---|
| `secrets.runtimeToken.existingSecret` / `existingSecretKey` / `value` | generated | Secret `colloq-runtime-auth`; `KERNEL_RUNTIME_TOKEN_FILE`, `RUNTIME_TOKEN_FILE` |
| `secrets.roomSecret.existingSecret` / `existingSecretKey` / `value` | generated | Secret `colloq-room-secret`; `RUNTIME_ROOM_SECRET_FILE` |

### Rooms and GPU

| Value | Default | Becomes |
|---|---|---|
| `rooms.memory` | `4Gi` | `RUNTIME_KERNEL_MEMORY` |
| `rooms.cpu` | `2` | `RUNTIME_KERNEL_CPU` |
| `rooms.maxMemory` | `""` (broker's node minus 1 GiB) | `RUNTIME_KERNEL_MEMORY_MAX` |
| `rooms.ephemeralStorage` | `2Gi` | `RUNTIME_KERNEL_EPHEMERAL` |
| `rooms.network` | `""` | `COLLOQ_ROOM_NETWORK`; `none` removes DNS from `room-isolation` |
| `rooms.nodeSelector` | `{}` | `RUNTIME_ROOM_NODE_SELECTOR` (JSON); also competition job and resolver Pods, which run student code |
| `rooms.tolerations` | `[]` | `RUNTIME_ROOM_TOLERATIONS` (JSON); also competition job and resolver Pods |
| `rooms.priorityClassName` | `""` | `RUNTIME_PRIORITY_CLASS` (every broker-created Pod) |
| `rooms.podLabels` | `{}` | `RUNTIME_POD_LABELS` (JSON, with `app.kubernetes.io/name`, `part-of` and `commonLabels`; never `instance`, which ArgoCD's label tracking would take for its own and prune) |
| `rooms.podAnnotations` | `{}` | `RUNTIME_POD_ANNOTATIONS` (JSON) |
| `gpu.runtimeClassName` | `nvidia` | `RUNTIME_GPU_RUNTIME_CLASS` (`""`: none) |
| `gpu.nodeSelector` | `{}` | `RUNTIME_GPU_NODE_SELECTOR` (JSON) |
| `gpu.tolerations` | `[]` | `RUNTIME_GPU_TOLERATIONS` (JSON) |

Set `rooms.maxMemory` on a cluster of unequal nodes: without it the broker takes
its own node's memory as every room's ceiling. A room reserves its memory and
cores in full (requests equal limits), so a ResourceQuota on the namespace must
hold the app, the broker and every room open at once, plus competition jobs.

### Storage

| Value | Default | Becomes |
|---|---|---|
| `persistence.accessMode` | `ReadWriteOnce` | both claims; `RUNTIME_COLOCATE_WITH_APP=1` when either is ReadWriteOnce |
| `persistence.storageClass` | `""` (cluster default; `-`: none) | `storageClassName` of both claims |
| `persistence.retain` | `true` | `helm.sh/resource-policy: keep`, `argocd.argoproj.io/sync-options: Prune=false,Delete=false` |
| `persistence.data.size` / `accessMode` / `storageClass` / `existingClaim` | `10Gi` / `""` / `""` / `""` | claim `colloq-data`; `RUNTIME_COMPETITION_DATA_CLAIM` |
| `persistence.workspace.size` / `accessMode` / `storageClass` / `existingClaim` | `100Gi` / `""` / `""` / `""` | claim `colloq-workspace`; `RUNTIME_WORKSPACE_CLAIM` |

### Ingress, Service, metrics

| Value | Default | Becomes |
|---|---|---|
| `ingress.enabled` | `true` | Ingress `colloq-app` (`false`: Service only) |
| `ingress.className` | `nginx` | `ingressClassName` |
| `ingress.host` | required | the rule's host, the TLS host, `PUBLIC_URL` |
| `ingress.annotations` | body 256m, timeouts 3600, buffering off | annotations (`null` drops one) |
| `ingress.tls.enabled` / `secretName` | `true` / `colloq-tls` | the TLS section |
| `ingress.tls.certManager.clusterIssuer` / `issuer` | `""` | `cert-manager.io/cluster-issuer` / `cert-manager.io/issuer` |
| `service.type` / `annotations` | `ClusterIP` / `{}` | Service `colloq-app` (port 3000) |
| `metrics.enabled` | `false` | `METRICS_TOKEN` from Secret `colloq-metrics` |
| `metrics.token` / `existingSecret` / `existingSecretKey` | generated / `""` / `metrics-token` | the token's source |
| `metrics.serviceMonitor.enabled` / `interval` / `scrapeTimeout` / `labels` | `false` / `30s` / `10s` / `{}` | ServiceMonitor `colloq-app` with the bearer token |

### Network policy

| Value | Default | Becomes |
|---|---|---|
| `networkPolicy.dns.to` | `kube-system` / `k8s-app: kube-dns` | DNS egress of every Colloq Pod |
| `networkPolicy.ingressController.from` | `ingress-nginx` / `app.kubernetes.io/name: ingress-nginx` | ingress of the app on 3000 |
| `networkPolicy.monitoring.from` | `monitoring` / `app.kubernetes.io/name: prometheus` | ingress of the app on 3000, with `metrics.enabled` |
| `networkPolicy.kubeApiServer.cidrs` / `ports` | `0.0.0.0/0`, `::/0` / `443`, `6443` | the broker's egress to the API servers |
| `networkPolicy.kubeApiServer.ciliumEntity` | `false` | CiliumNetworkPolicy `colloq-runtime-kube-api` |
| `networkPolicy.app.egress` | `[]` | the app's egress, `{cidrs, ports}` |
| `networkPolicy.app.extraEgress` / `runtime.extraEgress` | `[]` | raw egress rules for the app / the broker |

### Workloads

| Value | Default | Becomes |
|---|---|---|
| `podSecurityContext` | non-root 1000:1000, fsGroup 1000, RuntimeDefault seccomp | both Pods (uid 1000 is shared with rooms) |
| `containerSecurityContext` | no privilege escalation, read-only root, drop ALL | both containers |
| `app.resources` | 250m/512Mi, limits 2/2Gi | the app container |
| `app.nodeSelector` / `tolerations` / `affinity` / `podAnnotations` / `priorityClassName` | empty | the app Pod (`affinity` replaces the ReadWriteOnce preference) |
| `app.startupProbe` / `livenessProbe` / `readinessProbe` | `/api/livez` (10 min to start), `/api/livez`, `/api/readyz` | the app's probes |
| `runtime.inPlaceResize` | `true` | `RUNTIME_IN_PLACE_RESIZE`, `pods/resize` in the Role |
| `runtime.resources` | 100m/128Mi, limits 1/512Mi | the broker container |
| `runtime.nodeSelector` / `tolerations` / `affinity` / `podAnnotations` / `priorityClassName` | empty | the broker Pod |
| `runtime.livenessProbe` / `readinessProbe` | TCP 8787 | the broker's probes |

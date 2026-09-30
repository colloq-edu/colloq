{{/*
Names are fixed, not derived from the release name. The broker creates room
Pods with the ServiceAccount colloq-kernel and looks the competition
NetworkPolicies up by name, and it treats every room Pod in its namespace as
its own; so there is one Colloq per namespace, and a second release there fails
on these names instead of quietly sharing rooms with the first.
*/}}

{{/* Standard labels. Call with (dict "ctx" $ "component" "app"). */}}
{{- define "colloq.labels" -}}
{{ include "colloq.selectorLabels" . }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
app.kubernetes.io/part-of: colloq
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- with .ctx.Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* The immutable part: a Deployment selector never changes across upgrades. */}}
{{- define "colloq.selectorLabels" -}}
app.kubernetes.io/name: colloq
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
What every Pod the broker creates carries next to its own labels
(RUNTIME_POD_LABELS). No version: a label that changed on every upgrade would
make the broker's live rooms differ from what it would create now.
*/}}
{{- define "colloq.brokerPodLabels" -}}
{{- $labels := dict "app.kubernetes.io/name" "colloq" "app.kubernetes.io/instance" .Release.Name "app.kubernetes.io/part-of" "colloq" -}}
{{- $labels = merge $labels (deepCopy (.Values.rooms.podLabels | default dict)) (deepCopy (.Values.commonLabels | default dict)) -}}
{{- toJson $labels -}}
{{- end -}}

{{- define "colloq.namespace" -}}
namespace: {{ .Release.Namespace }}
{{- end -}}

{{/* ----------------------------------------------------------- images */}}

{{/*
A registry/repository@digest reference for the app or the runtime image.
Call with (dict "ctx" $ "image" .Values.image.app "name" "image.app").
*/}}
{{- define "colloq.image" -}}
{{- $values := .ctx.Values -}}
{{- $digest := .image.digest | default "" -}}
{{- if not $digest -}}
{{- fail (printf "%s.digest is empty. The chart in the source tree carries no image digests: install the published chart (helm install colloq oci://ghcr.io/colloq-edu/charts/colloq --version %s), or set image.app.digest, image.runtime.digest and every catalog.environments[].image to digest-pinned references." .name .ctx.Chart.Version) -}}
{{- end -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail (printf "%s.digest must be sha256:<64 hex digits>, got %q" .name $digest) -}}
{{- end -}}
{{- $registry := $values.global.imageRegistry | default $values.image.registry | default "" | trimSuffix "/" -}}
{{- if $registry -}}
{{- printf "%s/%s@%s" $registry .image.repository $digest -}}
{{- else -}}
{{- printf "%s@%s" .image.repository $digest -}}
{{- end -}}
{{- end -}}

{{/*
A full reference with its registry replaced by global.imageRegistry, keeping
the repository path and the digest. The first path component is a registry
when it looks like a host (a dot, a port, or localhost), as Docker reads it;
otherwise the reference was a Docker Hub one.
Call with (dict "ref" "ghcr.io/x/y@sha256:..." "registry" "harbor.local/ghcr").
*/}}
{{- define "colloq.rewriteImage" -}}
{{- $ref := .ref -}}
{{- $registry := .registry | default "" | trimSuffix "/" -}}
{{- if not $registry -}}
{{- $ref -}}
{{- else -}}
{{- $name := index (splitList "@" $ref) 0 -}}
{{- $first := index (splitList "/" $name) 0 -}}
{{- $path := $ref -}}
{{- if and (contains "/" $name) (or (contains "." $first) (contains ":" $first) (eq $first "localhost")) -}}
{{- $path = trimPrefix (printf "%s/" $first) $ref -}}
{{- else if not (contains "/" $name) -}}
{{- $path = printf "library/%s" $ref -}}
{{- end -}}
{{- printf "%s/%s" $registry $path -}}
{{- end -}}
{{- end -}}

{{- define "colloq.appImage" -}}
{{- include "colloq.image" (dict "ctx" . "image" .Values.image.app "name" "image.app") -}}
{{- end -}}

{{- define "colloq.runtimeImage" -}}
{{- include "colloq.image" (dict "ctx" . "image" .Values.image.runtime "name" "image.runtime") -}}
{{- end -}}

{{- define "colloq.pullSecretNames" -}}
{{- $names := list -}}
{{- range .Values.global.imagePullSecrets -}}
{{- if kindIs "string" . -}}
{{- $names = append $names . -}}
{{- else if .name -}}
{{- $names = append $names .name -}}
{{- end -}}
{{- end -}}
{{- toJson $names -}}
{{- end -}}

{{/* The imagePullSecrets field, or nothing. Call with `with`, so no blank line is left behind. */}}
{{- define "colloq.imagePullSecrets" -}}
{{- $names := include "colloq.pullSecretNames" . | fromJsonArray -}}
{{- if $names -}}
imagePullSecrets:
{{- range $names }}
  - name: {{ . }}
{{- end }}
{{- end -}}
{{- end -}}

{{/* ---------------------------------------------------------- catalog */}}

{{/* The catalog.json the app (KERNEL_CATALOG_FILE) and the broker read. */}}
{{- define "colloq.catalog" -}}
{{- $registry := .Values.global.imageRegistry | default "" -}}
{{- $environments := list -}}
{{- range $index, $env := .Values.catalog.environments -}}
{{- $entry := dict "name" $env.name "image" (include "colloq.rewriteImage" (dict "ref" $env.image "registry" $registry)) "gpu" $env.gpu -}}
{{- if hasKey $env "packages" -}}{{- $_ := set $entry "packages" ($env.packages | default list) -}}{{- end -}}
{{- if hasKey $env "python" -}}{{- $_ := set $entry "python" $env.python -}}{{- end -}}
{{- if hasKey $env "current" -}}{{- $_ := set $entry "current" $env.current -}}{{- end -}}
{{- $environments = append $environments $entry -}}
{{- end -}}
{{- $release := .Values.catalog.release | default (printf "v%s" .Chart.AppVersion) -}}
{{- toJson (dict "schemaVersion" 1 "release" $release "defaultEnvironment" .Values.catalog.defaultEnvironment "environments" $environments) -}}
{{- end -}}

{{/* ---------------------------------------------------------- storage */}}

{{- define "colloq.dataAccessMode" -}}
{{- .Values.persistence.data.accessMode | default .Values.persistence.accessMode -}}
{{- end -}}

{{- define "colloq.workspaceAccessMode" -}}
{{- .Values.persistence.workspace.accessMode | default .Values.persistence.accessMode -}}
{{- end -}}

{{/*
"1" when a volume the broker's Pods mount can be attached to one node only:
rooms mount the workspace, competition jobs the data, and the app both.
*/}}
{{- define "colloq.colocate" -}}
{{- if or (eq (include "colloq.dataAccessMode" .) "ReadWriteOnce") (eq (include "colloq.workspaceAccessMode" .) "ReadWriteOnce") -}}1{{- else -}}0{{- end -}}
{{- end -}}

{{- define "colloq.dataClaim" -}}
{{- .Values.persistence.data.existingClaim | default "colloq-data" -}}
{{- end -}}

{{- define "colloq.workspaceClaim" -}}
{{- .Values.persistence.workspace.existingClaim | default "colloq-workspace" -}}
{{- end -}}

{{/* ---------------------------------------------------------- secrets */}}

{{/*
A generated secret value that survives upgrades: the live Secret's value when
there is one (helm install/upgrade look it up), a fresh one otherwise. Under
`helm template` (ArgoCD) the lookup is empty and every render is fresh, which
is why the values offer existingSecret.
Call with (dict "ctx" $ "secret" "colloq-runtime-auth" "key" "runtime-token" "value" "").
*/}}
{{- define "colloq.secretData" -}}
{{- if .value -}}
{{- .value | b64enc -}}
{{- else -}}
{{- $live := lookup "v1" "Secret" .ctx.Release.Namespace .secret -}}
{{- $data := dig "data" dict ($live | default dict) -}}
{{- if and (hasKey $data .key) (index $data .key) -}}
{{- index $data .key -}}
{{- else -}}
{{- randAlphaNum 64 | b64enc -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "colloq.runtimeTokenSecret" -}}
{{- .Values.secrets.runtimeToken.existingSecret | default "colloq-runtime-auth" -}}
{{- end -}}
{{- define "colloq.runtimeTokenKey" -}}
{{- if .Values.secrets.runtimeToken.existingSecret -}}{{ .Values.secrets.runtimeToken.existingSecretKey | default "runtime-token" }}{{- else -}}runtime-token{{- end -}}
{{- end -}}

{{- define "colloq.roomSecretSecret" -}}
{{- .Values.secrets.roomSecret.existingSecret | default "colloq-room-secret" -}}
{{- end -}}
{{- define "colloq.roomSecretKey" -}}
{{- if .Values.secrets.roomSecret.existingSecret -}}{{ .Values.secrets.roomSecret.existingSecretKey | default "room-secret" }}{{- else -}}room-secret{{- end -}}
{{- end -}}

{{- define "colloq.metricsSecret" -}}
{{- .Values.metrics.existingSecret | default "colloq-metrics" -}}
{{- end -}}
{{- define "colloq.metricsKey" -}}
{{- if .Values.metrics.existingSecret -}}{{ .Values.metrics.existingSecretKey | default "metrics-token" }}{{- else -}}metrics-token{{- end -}}
{{- end -}}

{{/* The app's secret settings, rendered into colloq-app-config (without config.existingSecret). */}}
{{- define "colloq.appSecretSettings" -}}
{{- $settings := dict -}}
{{- with .Values.config.ai.apiKey }}{{ $_ := set $settings "OPENAI_API_KEY" . }}{{ end -}}
{{- with .Values.config.sessionSecret }}{{ $_ := set $settings "SESSION_SECRET" . }}{{ end -}}
{{- toJson $settings -}}
{{- end -}}

{{- define "colloq.appConfigSecret" -}}
{{- if .Values.config.existingSecret -}}
{{- .Values.config.existingSecret -}}
{{- else if (include "colloq.appSecretSettings" . | fromJson) -}}
colloq-app-config
{{- end -}}
{{- end -}}

{{/* ------------------------------------------------------------- misc */}}

{{- define "colloq.publicUrl" -}}
{{- if .Values.config.publicUrl -}}
{{- .Values.config.publicUrl | trimSuffix "/" -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- end -}}
{{- end -}}

{{/* Whole Mi of a Kubernetes quantity written in Mi or Gi, 0 for anything else. */}}
{{- define "colloq.mebibytes" -}}
{{- $text := toString . -}}
{{- if regexMatch "^[1-9][0-9]*Gi$" $text -}}{{ mul (trimSuffix "Gi" $text | atoi) 1024 }}
{{- else if regexMatch "^[1-9][0-9]*Mi$" $text -}}{{ trimSuffix "Mi" $text | atoi }}
{{- else -}}0{{- end -}}
{{- end -}}

{{- define "colloq.extraCaConfigMap" -}}
{{- if .Values.outbound.extraCa.existingConfigMap -}}
{{- .Values.outbound.extraCa.existingConfigMap -}}
{{- else if .Values.outbound.extraCa.pem -}}
colloq-extra-ca
{{- end -}}
{{- end -}}

{{- define "colloq.extraCaKey" -}}
{{- if .Values.outbound.extraCa.existingConfigMap -}}{{ .Values.outbound.extraCa.key | default "extra-ca.pem" }}{{- else -}}extra-ca.pem{{- end -}}
{{- end -}}

{{/* NetworkPolicy peers: Colloq's Pods by their colloq.dev/role, in this namespace. */}}
{{- define "colloq.peer" -}}
podSelector:
  matchLabels:
    colloq.dev/role: {{ . }}
{{- end -}}

{{- define "colloq.peerIn" -}}
podSelector:
  matchExpressions:
    - key: colloq.dev/role
      operator: In
      values: {{ toJson . }}
{{- end -}}

{{/* Kubernetes NetworkPolicy ports from a list of numbers. */}}
{{- define "colloq.tcpPorts" -}}
{{- $ports := list -}}
{{- range . }}{{ $ports = append $ports (dict "protocol" "TCP" "port" (int .)) }}{{ end -}}
{{- toYaml $ports -}}
{{- end -}}

{{- define "colloq.dnsEgress" -}}
- to:
{{- toYaml .Values.networkPolicy.dns.to | nindent 4 }}
  ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
{{- end -}}

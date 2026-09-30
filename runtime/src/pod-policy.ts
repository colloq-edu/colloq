import { isDeepStrictEqual } from 'node:util'

/**
 * The customer's cluster rules for every Pod the broker creates: where it may
 * run, how urgent it is, and the labels and annotations the platform's policy
 * engine and cost accounting require.
 *
 * Settings of someone else's Kubernetes, not of Colloq. On the single-node k3s
 * the installer builds, none of them is needed and all are empty; in a bank's
 * multi-node cluster they decide whether a room's Pod is admitted and
 * scheduled at all. They are read once at start (config.ts), refused with a
 * message naming the variable, and never come from the app: the HTTP API still
 * carries only room intent.
 */
export interface PodPolicy {
  /**
   * RUNTIME_COLOCATE_WITH_APP: a required podAffinity to the app's Pod
   * (`colloq.dev/role=app`) on its node, for every Pod that mounts the data or
   * workspace claim.
   *
   * With ReadWriteOnce storage the volume is attached to one node, and a room
   * scheduled on another hangs in ContainerCreating with a Multi-Attach error
   * until the startup timeout. With ReadWriteMany (CephFS, NFS) or a single
   * node nothing needs to be co-located, and the affinity would only take
   * the scheduler's freedom away, hence off by default.
   */
  colocateWithApp?: boolean
  /** RUNTIME_PRIORITY_CLASS: priorityClassName of every broker-created Pod; empty is none. */
  priorityClass?: string
  /** RUNTIME_POD_LABELS / RUNTIME_POD_ANNOTATIONS: added to every broker-created Pod. */
  podLabels?: Record<string, string>
  podAnnotations?: Record<string, string>
}

export interface Toleration {
  key?: string
  operator?: 'Exists' | 'Equal'
  value?: string
  effect?: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'
  tolerationSeconds?: number
}

const DNS_SUBDOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/
const NAME = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
const LABEL_VALUE = /^(?:[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/
/** A setting is operator configuration, not a document: its bound keeps the Pod bodies under the API's limits. */
const MAX_SETTING_BYTES = 16384

/** A Kubernetes qualified name: `name` or `dns.subdomain/name`. */
function qualifiedName(key: string): boolean {
  const parts = key.split('/')
  if (parts.length === 1) return NAME.test(key)
  return parts.length === 2 && DNS_SUBDOMAIN.test(parts[0]) && NAME.test(parts[1])
}

/**
 * Keys the broker builds its ownership and selectors from.
 *
 * An operator's label with one of them would either lose to the broker's own
 * value (and then silently not be there) or, if it won, do harm: a room Pod
 * labelled with another room's session hash would answer to that room's
 * Service, and one labelled `colloq.dev/role=app` would become the target the
 * colocation affinity looks for. So they are refused at start, not merged.
 */
export function reservedKey(key: string): boolean {
  const slash = key.indexOf('/')
  const prefix = slash < 0 ? '' : key.slice(0, slash)
  return key.startsWith('colloq.') || prefix.endsWith('.colloq.dev') || key === 'app.kubernetes.io/managed-by'
}

/**
 * Annotations that choose a Pod's AppArmor or seccomp profile.
 *
 * The broker fixes both (RuntimeDefault seccomp, the runtime's AppArmor
 * default), and an annotation meant for a cost label must not be the way to
 * loosen them: "the chart keeps every security property" holds only if values
 * cannot switch one off.
 */
const SECURITY_ANNOTATIONS = [
  'container.apparmor.security.beta.kubernetes.io',
  'seccomp.security.alpha.kubernetes.io',
  'container.seccomp.security.alpha.kubernetes.io',
]

function readJson(name: string, raw: string | undefined, example: string): unknown {
  if (raw === undefined || raw.trim() === '') return undefined
  if (Buffer.byteLength(raw) > MAX_SETTING_BYTES) throw new Error(`${name} exceeds ${MAX_SETTING_BYTES} bytes`)
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${name} is not valid JSON; expected for example ${example}`)
  }
}

/** A key as it may appear in an error: operator configuration, but bounded. */
const shown = (key: string) => JSON.stringify(key.slice(0, 80))

/**
 * RUNTIME_POD_LABELS, RUNTIME_POD_ANNOTATIONS and the node selectors: a JSON
 * object of strings, every key a Kubernetes qualified name.
 */
export function parseStringMap(
  name: string,
  raw: string | undefined,
  kind: 'labels' | 'annotations' | 'nodeSelector',
): Record<string, string> {
  const example = kind === 'nodeSelector' ? '{"node-role.example/edu":"true"}' : '{"team":"edu"}'
  const value = readJson(name, raw, example)
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be a JSON object of strings, for example ${example}`)
  const entries = Object.entries(value)
  if (entries.length > 64) throw new Error(`${name} has more than 64 entries`)
  const out: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (!qualifiedName(key))
      throw new Error(`${name}: ${shown(key)} is not a valid Kubernetes ${kind === 'annotations' ? 'annotation' : 'label'} key`)
    if (kind !== 'nodeSelector' && reservedKey(key))
      throw new Error(`${name}: ${shown(key)} is reserved: colloq.* keys and app.kubernetes.io/managed-by carry the broker's ownership and selectors`)
    if (kind === 'annotations' && SECURITY_ANNOTATIONS.some((prefix) => key.startsWith(`${prefix}/`)))
      throw new Error(`${name}: ${shown(key)} would change the Pod's security profile, which the broker fixes`)
    if (typeof item !== 'string') throw new Error(`${name}: the value of ${shown(key)} must be a string`)
    if (kind === 'annotations' ? item.length > 4096 : !LABEL_VALUE.test(item))
      throw new Error(
        kind === 'annotations'
          ? `${name}: the value of ${shown(key)} exceeds 4096 characters`
          : `${name}: the value of ${shown(key)} is not a valid Kubernetes label value`,
      )
    out[key] = item
  }
  return out
}

const TOLERATION_FIELDS = new Set(['key', 'operator', 'value', 'effect', 'tolerationSeconds'])
const EFFECTS = new Set(['NoSchedule', 'PreferNoSchedule', 'NoExecute'])

/** RUNTIME_ROOM_TOLERATIONS and RUNTIME_GPU_TOLERATIONS: a JSON array of Kubernetes tolerations. */
export function parseTolerations(name: string, raw: string | undefined): Toleration[] {
  const example = '[{"key":"dedicated","operator":"Equal","value":"edu","effect":"NoSchedule"}]'
  const value = readJson(name, raw, example)
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be a JSON array of tolerations, for example ${example}`)
  if (value.length > 32) throw new Error(`${name} has more than 32 tolerations`)
  return value.map((entry, index) => {
    const where = `${name}[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} must be an object`)
    const unknown = Object.keys(entry).find((field) => !TOLERATION_FIELDS.has(field))
    if (unknown !== undefined) throw new Error(`${where}: unknown field ${shown(unknown)}`)
    const { key, operator, value: text, effect, tolerationSeconds } = entry as Record<string, unknown>
    if (key !== undefined && (typeof key !== 'string' || (key !== '' && !qualifiedName(key))))
      throw new Error(`${where}: key must be a Kubernetes label key`)
    if (operator !== undefined && operator !== 'Exists' && operator !== 'Equal')
      throw new Error(`${where}: operator must be Exists or Equal`)
    if (text !== undefined && (typeof text !== 'string' || !LABEL_VALUE.test(text)))
      throw new Error(`${where}: value must be a Kubernetes label value`)
    if (operator === 'Exists' && text) throw new Error(`${where}: operator Exists takes no value`)
    if (!key && operator !== 'Exists') throw new Error(`${where}: a toleration without a key must use operator Exists`)
    if (effect !== undefined && effect !== '' && !EFFECTS.has(effect as string))
      throw new Error(`${where}: effect must be NoSchedule, PreferNoSchedule or NoExecute`)
    if (tolerationSeconds !== undefined && (!Number.isSafeInteger(tolerationSeconds) || effect !== 'NoExecute'))
      throw new Error(`${where}: tolerationSeconds must be an integer and needs effect NoExecute`)
    return {
      ...(key ? { key: key as string } : {}),
      ...(operator ? { operator: operator as Toleration['operator'] } : {}),
      ...(text ? { value: text as string } : {}),
      ...(effect ? { effect: effect as Toleration['effect'] } : {}),
      ...(tolerationSeconds !== undefined ? { tolerationSeconds: tolerationSeconds as number } : {}),
    }
  })
}

/** RUNTIME_COLOCATE_WITH_APP, RUNTIME_IN_PLACE_RESIZE: `1`/`0` (`true`/`false` too); empty is the default. */
export function parseSwitch(name: string, raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '') return fallback
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  throw new Error(`${name} must be 0 or 1`)
}

/**
 * RUNTIME_PRIORITY_CLASS: the name of a PriorityClass the platform created.
 *
 * `system-*` is refused: those classes belong to the cluster's own components,
 * and a student notebook allowed to preempt kube-dns is not a priority but an
 * outage.
 */
export function parsePriorityClass(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (!value) return ''
  if (!DNS_SUBDOMAIN.test(value)) throw new Error('RUNTIME_PRIORITY_CLASS must be a PriorityClass name')
  if (value.startsWith('system-'))
    throw new Error('RUNTIME_PRIORITY_CLASS cannot be a system-* class: those are reserved for cluster components')
  return value
}

/** RUNTIME_GPU_RUNTIME_CLASS: `nvidia` when unset, no RuntimeClass at all when set empty. */
export function parseRuntimeClass(raw: string | undefined): string {
  if (raw === undefined) return 'nvidia'
  const value = raw.trim()
  if (value && !DNS_SUBDOMAIN.test(value)) throw new Error('RUNTIME_GPU_RUNTIME_CLASS must be a RuntimeClass name')
  return value
}

/** The label of the app's Pod that the colocation affinity looks for; the chart sets it. */
export const APP_POD_SELECTOR = { 'colloq.dev/role': 'app' } as const
const TOPOLOGY = 'kubernetes.io/hostname'

/** The required podAffinity to the app's node: fresh per Pod, never shared between specs. */
export function appAffinity(): Record<string, unknown> {
  return {
    podAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: [
        { labelSelector: { matchLabels: { ...APP_POD_SELECTOR } }, topologyKey: TOPOLOGY },
      ],
    },
  }
}

/**
 * The part of the policy every broker-created Pod gets: its priority, and the
 * colocation affinity when it mounts the data or workspace claim (a Pod that
 * mounts neither, the package proxy, is free to run anywhere).
 */
export function policyPlacement(policy: PodPolicy, mountsClaim: boolean): Record<string, unknown> {
  return {
    ...(policy.priorityClass ? { priorityClassName: policy.priorityClass } : {}),
    ...(policy.colocateWithApp && mountsClaim ? { affinity: appAffinity() } : {}),
  }
}

/** The operator's labels and annotations under the broker's own, which always win. */
export function policyMetadata(
  policy: PodPolicy,
  labels: Record<string, string>,
  annotations: Record<string, string>,
): { labels: Record<string, string>; annotations: Record<string, string> } {
  return {
    labels: { ...policy.podLabels, ...labels },
    annotations: { ...policy.podAnnotations, ...annotations },
  }
}

/**
 * Pod fields that say only WHERE and how urgently a Pod runs.
 *
 * The broker compares a found Pod with the one it would create before handing
 * its Jupyter token to the app (controller.ts · canonicalPod). These fields
 * stay out of that comparison, and the reasons are specific:
 *
 * - None of them grants execution, credentials or mounts.
 * - All of them are immutable on a live Pod (tolerations can only be added),
 *   so a running Pod cannot have been re-pointed after the broker created it;
 *   a Pod created by someone else would still have to carry the room's token
 *   to pass the rest of the comparison.
 * - The cluster fills them in at admission: the Priority plugin writes
 *   `priority` and `preemptionPolicy` (and a global default's
 *   `priorityClassName`), a RuntimeClass adds `overhead` and its own node
 *   selector and tolerations, PodNodeSelector and PodTolerationRestriction
 *   merge the namespace's, Kueue adds scheduling gates. Compared strictly,
 *   every room in such a cluster was refused as "does not match the requested
 *   workload policy" right after the broker itself created it.
 * - The operator changes them (RUNTIME_ROOM_NODE_SELECTOR, colocation, the
 *   priority class): a changed setting must reach new Pods, not tear down
 *   every live class at its next run.
 *
 * Whether a found Pod still stands where the settings say is asked separately
 * (placementSatisfies), and only a Pod that has not started yet is replaced
 * for it.
 */
export const PLACEMENT_FIELDS = [
  'nodeSelector',
  'affinity',
  'tolerations',
  'priorityClassName',
  'priority',
  'preemptionPolicy',
  'runtimeClassName',
  'overhead',
  'schedulerName',
  'topologySpreadConstraints',
  'schedulingGates',
  'nodeName',
] as const

/** A shallow copy of a Pod spec without its placement: key order kept, for the template hash. */
export function withoutPlacement(spec: Record<string, any>): Record<string, any> {
  const copy = { ...spec }
  for (const field of PLACEMENT_FIELDS) delete copy[field]
  return copy
}

const toleration = (value: any) => ({
  key: value?.key ?? '',
  operator: value?.operator || 'Equal',
  value: value?.value ?? '',
  effect: value?.effect ?? '',
  tolerationSeconds: value?.tolerationSeconds ?? null,
})
const affinityTerm = (value: any) => ({
  labelSelector: value?.labelSelector ?? null,
  topologyKey: value?.topologyKey ?? '',
  namespaces: Array.isArray(value?.namespaces) ? value.namespaces : [],
  namespaceSelector: value?.namespaceSelector ?? null,
})
const requiredTerms = (spec: Record<string, any>): any[] => {
  const terms = spec.affinity?.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution
  return Array.isArray(terms) ? terms : []
}

/**
 * Whether a Pod carries every placement constraint the settings would give it
 * now. More is fine (admission adds, and an older setting may have been
 * stricter); a missing or different one means the Pod was created under
 * another configuration.
 */
export function placementSatisfies(actual: Record<string, any>, desired: Record<string, any>): boolean {
  try {
    for (const [key, value] of Object.entries(desired.nodeSelector ?? {}))
      if (actual.nodeSelector?.[key] !== value) return false
    const tolerations = Array.isArray(actual.tolerations) ? actual.tolerations.map(toleration) : []
    for (const wanted of desired.tolerations ?? [])
      if (!tolerations.some((have: unknown) => isDeepStrictEqual(have, toleration(wanted)))) return false
    const terms = requiredTerms(actual).map(affinityTerm)
    for (const wanted of requiredTerms(desired))
      if (!terms.some((have) => isDeepStrictEqual(have, affinityTerm(wanted)))) return false
    for (const field of ['priorityClassName', 'runtimeClassName'])
      if (desired[field] !== undefined && actual[field] !== desired[field]) return false
    return true
  } catch {
    return false
  }
}

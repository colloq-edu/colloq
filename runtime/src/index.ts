import { loadRuntimeConfig, readCatalog, readStrongSecret } from './config.js'
import { HttpsKubernetesClient } from './kubernetes.js'
import { RuntimeController } from './controller.js'
import { createRuntimeServer } from './http.js'
import { CompetitionJobs } from './competition-jobs.js'

const config = loadRuntimeConfig()
const catalog = () => readCatalog(config.catalogFile)
const controller = new RuntimeController({
  config,
  catalog,
  roomSecret: () => readStrongSecret(config.roomSecretFile),
  kube: new HttpsKubernetesClient({
    url: config.kubeUrl,
    tokenFile: config.kubeTokenFile,
    caFile: config.kubeCaFile,
  }),
})
const jobs = new CompetitionJobs({
  config: {
    namespace: config.namespace,
    dataClaim: config.competitionDataClaim,
    exporterImage: config.competitionExporterImage,
    instanceId: config.competitionInstanceId,
    ...(config.imagePullSecret ? { imagePullSecret: config.imagePullSecret } : {}),
    ...(config.dependencyIndexUrl ? { dependencyIndexUrl: config.dependencyIndexUrl } : {}),
    ...(config.dependencyFilesHosts ? { dependencyFilesHosts: config.dependencyFilesHosts } : {}),
    // The cluster's rules for every Pod the broker creates (pod-policy.ts),
    // and the rooms' placement for the Pods that run student code.
    colocateWithApp: config.colocateWithApp,
    ...(config.roomNodeSelector ? { studentNodeSelector: config.roomNodeSelector } : {}),
    ...(config.roomTolerations ? { studentTolerations: config.roomTolerations } : {}),
    priorityClass: config.priorityClass,
    podLabels: config.podLabels,
    podAnnotations: config.podAnnotations,
    // A notebook whose competition asks for a GPU: the cluster's resource,
    // and the GPU rooms' placement, which such a notebook shares.
    ...(config.competitionGpuResource
      ? { gpu: { resource: config.competitionGpuResource, count: config.competitionGpuCount,
          slots: config.competitionGpuSlots, shmMb: config.competitionGpuShmMb } }
      : {}),
    gpuRuntimeClass: config.gpuRuntimeClass,
    gpuNodeSelector: config.gpuNodeSelector,
    gpuTolerations: config.gpuTolerations,
    // Every Pod of a GPU environment's image, with a card or without.
    gpuPullSeconds: config.competitionGpuPullSeconds,
  },
  kube: new HttpsKubernetesClient({
    url: config.kubeUrl,
    tokenFile: config.kubeTokenFile,
    caFile: config.kubeCaFile,
  }),
  catalog,
  secret: () => readStrongSecret(config.roomSecretFile),
})
if (config.competitionInstanceId)
  void jobs.reconcile().catch((error) =>
    console.error(`[runtime] competition reconciliation failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`),
  )
const server = createRuntimeServer({
  controller,
  jobs,
  catalog,
  token: () => readStrongSecret(config.tokenFile),
})
server.listen(config.port, '0.0.0.0', () =>
  console.log(
    `Colloq runtime listening on ${config.port}; namespace ${config.namespace}` +
      `; colocation with the app ${config.colocateWithApp ? 'on' : 'off'}` +
      `; in-place resize ${config.inPlaceResize ? 'on' : 'off'}` +
      `; competition GPU ${config.competitionGpuResource
        ? `${config.competitionGpuResource} (${config.competitionGpuCount} per job, slots ${config.competitionGpuSlots ?? 'unset'}` +
          `, /dev/shm ${config.competitionGpuShmMb ? `up to ${config.competitionGpuShmMb} MiB` : 'none'})`
        : 'off'}` +
      `; GPU image pull allowance ${config.competitionGpuPullSeconds} s`,
  ),
)
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    // Rooms intentionally survive runtime/app rollout. Never delete them here.
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 15000).unref()
  })

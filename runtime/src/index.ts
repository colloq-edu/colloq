import { loadRuntimeConfig, readCatalog, readStrongSecret } from './config.js'
import { HttpsKubernetesClient } from './kubernetes.js'
import { RuntimeController } from './controller.js'
import { createRuntimeServer } from './http.js'

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
const server = createRuntimeServer({
  controller,
  catalog,
  token: () => readStrongSecret(config.tokenFile),
})
server.listen(config.port, '0.0.0.0', () =>
  console.log(`Colloq runtime listening on ${config.port}; namespace ${config.namespace}`),
)
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    // Rooms intentionally survive runtime/app rollout. Never delete them here.
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 15000).unref()
  })

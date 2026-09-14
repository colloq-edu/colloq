import fs from 'node:fs'
import path from 'node:path'
import {
  buildIsCurrent,
  fingerprint,
  kernelInputs,
  type BuildStamp,
  type LaunchConfig,
  type LaunchOptions,
} from './launch-config.js'
import { capture, Processes } from './launch-process.js'
import { readJson, writeJson } from './launch-state.js'

export async function prepare(
  config: LaunchConfig,
  options: LaunchOptions,
  processes: Processes,
  stopped: () => boolean,
): Promise<void> {
  const { root, env, kernelEnv } = config
  if (process.platform !== 'linux' && env.COLLOQ_UNSAFE_DEV_FILES !== '1')
    throw new Error(
      'Для нативного запуска на macOS добавьте COLLOQ_UNSAFE_DEV_FILES=1 в .env. Docker должен быть запущен.',
    )
  if ((await capture(root, env, 'docker', ['info', '--format', '{{.ServerVersion}}'])).code !== 0)
    throw new Error('Docker не отвечает. Запустите Docker и повторите colloq run.')
  if (stopped()) throw new Error('Запуск отменён.')
  const inputs = kernelInputs(root, kernelEnv)
  const sourceHash = fingerprint(root, inputs)
  const chain = inputs
    .slice(2)
    .reverse()
    .map((file) => {
      const name = path.basename(file, '.txt')
      const sources = kernelInputs(root, name)
      return { name, sources, fingerprint: fingerprint(root, sources) }
    })
  type KernelStamp = { fingerprint: string; id: string; parentId?: string }
  const stamps: Array<{ file: string; value: KernelStamp }> = []
  const inspect = async (name: string): Promise<{ Id: string; Created: string } | undefined> => {
    const result = await capture(root, env, 'docker', ['image', 'inspect', `colloq-kernel:${name}`])
    if (stopped()) throw new Error('Запуск отменён.')
    if (result.code !== 0) return undefined
    try {
      const image = JSON.parse(result.text)[0]
      return typeof image?.Id === 'string' && image.Id ? image : undefined
    } catch {
      return undefined
    }
  }
  let parentId = '',
    parentCreated = 0,
    ancestorRebuilt = false
  // env-build deliberately reuses existing parents. Request each changed
  // ancestor explicitly before building its descendants against that image.
  for (const item of chain) {
    let image = await inspect(item.name)
    const marker = path.join(root, `.colloq/kernel-${item.name}.json`)
    const stamp = readJson<KernelStamp>(marker)
    const freshImage =
      image &&
      Date.parse(image.Created) >= parentCreated &&
      item.sources.every(
        (file) => fs.statSync(path.join(root, file)).mtimeMs <= Date.parse(image!.Created),
      )
    const current = stamp
      ? stamp.fingerprint === item.fingerprint &&
        stamp.id === image?.Id &&
        (stamp.parentId ?? '') === parentId
      : freshImage
    if (!image || ancestorRebuilt || !current) {
      console.log(`Подготавливаю окружение Python: ${item.name}`)
      await processes.run('Сборка Python', 'make', [
        '--no-print-directory',
        'env-build',
        `NAME=${item.name}`,
      ])
      image = await inspect(item.name)
      if (!image) throw new Error('Сборка закончилась, но образ ядра не найден.')
      ancestorRebuilt = true
    }
    if (fingerprint(root, inputs) !== sourceHash)
      throw new Error(
        'Исходники изменились во время сборки. Повторите запуск или используйте colloq dev.',
      )
    stamps.push({ file: marker, value: { fingerprint: item.fingerprint, id: image.Id, parentId } })
    parentId = image.Id
    parentCreated = Date.parse(image.Created)
  }
  for (const stamp of stamps) writeJson(stamp.file, stamp.value)
  if (stopped()) throw new Error('Запуск отменён.')
  if (options.action === 'dev') return
  const file = path.join(root, '.colloq/build.json')
  if (options.build || !buildIsCurrent(root, readJson<BuildStamp>(file), options.fast)) {
    const before = fingerprint(root)
    console.log('Собираю приложение…')
    await processes.run('Сборка приложения', 'npm', [
      'run',
      options.fast ? 'build' : 'build:optimized',
    ])
    if (
      !fs.existsSync(path.join(root, 'web/dist/index.html')) ||
      !fs.existsSync(path.join(root, 'server/dist/server.js'))
    )
      throw new Error('Сборка не создала frontend и server. Проверьте вывод выше.')
    if (fingerprint(root) !== before)
      throw new Error(
        'Исходники изменились во время сборки. Повторите запуск или используйте colloq dev.',
      )
    writeJson(file, { fingerprint: before, fast: options.fast })
  }
}

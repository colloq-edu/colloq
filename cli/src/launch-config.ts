import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export interface LaunchOptions {
  action: 'run' | 'dev' | 'stop' | 'restart'
  detach: boolean
  open: boolean
  fast: boolean
  build: boolean
  host?: string
  port?: number
  child?: boolean
}

export function parseLaunchArgs(args: string[]): LaunchOptions {
  const options: LaunchOptions = {
    action: 'run',
    detach: false,
    open: true,
    fast: false,
    build: false,
  }
  let at = 0
  if (['run', 'dev', 'stop', 'restart'].includes(args[0]))
    options.action = args[at++] as LaunchOptions['action']
  for (; at < args.length; at++) {
    const flag = args[at]
    if (flag === '--detach') options.detach = true
    else if (flag === '--no-open') options.open = false
    else if (flag === '--fast') options.fast = true
    else if (flag === '--build') options.build = true
    else if (flag === '--child') options.child = true
    else if (flag === '--port') {
      const value = args[++at]
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
        throw new Error('Порт должен быть целым числом от 1 до 65535.')
      options.port = Number(value)
    } else if (flag === '--host') {
      const host = args[++at]
      if (!host || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))
        throw new Error('После --host укажите имя, например seminar.colloq.ru.')
      options.host = host
    } else throw new Error(`Неизвестный аргумент запуска: ${flag}`)
  }
  if (options.action === 'dev' && options.detach)
    throw new Error('dev работает в терминале; для фона используйте run --detach.')
  return options
}

export interface LaunchConfig {
  root: string
  port: number
  uiPort: number
  url: string
  dataDir: string
  workspaceDir: string
  leaseFile: string
  env: Record<string, string>
  kernelEnv: string
}

export function launchConfig(
  root: string,
  options: LaunchOptions,
  source: NodeJS.ProcessEnv,
): LaunchConfig {
  const dev = options.action === 'dev'
  const configuredPort = Number(source.PORT || 3000)
  const port = dev ? configuredPort : (options.port ?? configuredPort)
  const uiPort = dev ? (options.port ?? 5173) : port
  for (const value of [port, uiPort])
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error('Некорректный PORT в настройках запуска.')
  if (dev && port === uiPort)
    throw new Error('Порт интерфейса dev должен отличаться от PORT сервера в .env.')
  const dataDir = path.resolve(root, source.DATA_DIR || 'data')
  const workspaceDir = path.resolve(root, source.WORKSPACE_DIR || 'workspace')
  const leaseFile = path.join(root, '.colloq/public-url.json')
  const url = `http://localhost:${uiPort}`
  const kernelEnv = source.KERNEL_ENV || 'base'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(kernelEnv))
    throw new Error('Некорректное имя окружения KERNEL_ENV.')
  if (source.COLLOQ_CLUSTER === '1' || source.KERNEL_BACKEND === 'broker')
    throw new Error(
      'Это установка с runtime broker. Для неё используйте команды службы или cluster; run предназначен для локального Docker.',
    )
  const env = Object.fromEntries(
    Object.entries(source).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  )
  Object.assign(env, {
    NODE_ENV: 'development',
    KERNEL_BACKEND: 'docker',
    PORT: String(port),
    BIND_ADDR: '127.0.0.1',
    DATA_DIR: dataDir,
    WORKSPACE_DIR: workspaceDir,
    WORKSPACE_HOST_DIR: '',
    COLLOQ_LOCAL_SESSION: '1',
    COLLOQ_LOCAL_URL: url,
    COLLOQ_PUBLIC_URL_LEASE_FILE: leaseFile,
    COLLOQ_STOP_KERNELS_ON_EXIT: dev ? '0' : '1',
    STATIC_DIR: path.join(root, 'web/dist'),
    VITE_API_TARGET: `http://127.0.0.1:${port}`,
  })
  return { root, port, uiPort, url, dataDir, workspaceDir, leaseFile, env, kernelEnv }
}

function filesBelow(root: string, relative: string): string[] {
  const full = path.join(root, relative)
  if (!fs.existsSync(full)) return []
  const stat = fs.lstatSync(full)
  if (stat.isSymbolicLink()) return []
  if (!stat.isDirectory()) return [relative]
  return fs
    .readdirSync(full)
    .sort()
    .flatMap((name) => {
      if (
        ['node_modules', 'dist', '.git', '.vite'].includes(name) ||
        name.endsWith('.built') ||
        path.join(relative, name) === 'web/public/pdf'
      )
        return []
      return filesBelow(root, path.join(relative, name))
    })
}

export function fingerprint(
  root: string,
  inputs = [
    'web',
    'server',
    'runtime',
    'shared',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ],
): string {
  const hash = createHash('sha256')
  for (const file of inputs.flatMap((input) => filesBelow(root, input)).sort()) {
    hash
      .update(file)
      .update('\0')
      .update(fs.readFileSync(path.join(root, file)))
      .update('\0')
  }
  return hash.digest('hex')
}

export interface BuildStamp {
  fingerprint: string
  fast: boolean
}
export function buildIsCurrent(root: string, stamp: BuildStamp | null, fast: boolean): boolean {
  return Boolean(
    stamp &&
      stamp.fingerprint === fingerprint(root) &&
      (fast || !stamp.fast) &&
      fs.existsSync(path.join(root, 'web/dist/index.html')) &&
      fs.existsSync(path.join(root, 'server/dist/server.js')),
  )
}

export function kernelInputs(root: string, name: string): string[] {
  const files = ['kernel/Dockerfile', 'kernel/requirements.txt']
  const seen = new Set<string>()
  let current: string | undefined = name
  while (current) {
    if (seen.has(current) || seen.size >= 8)
      throw new Error('Цикл или слишком длинная цепочка окружений Python.')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(current))
      throw new Error('Некорректное имя родительского окружения.')
    seen.add(current)
    const file: string = `kernel/environments/${current}.txt`
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Нет окружения ${current}: ${file}`)
    files.push(file)
    current = fs
      .readFileSync(path.join(root, file), 'utf8')
      .match(/^\s*#\s*colloq:\s*from\s+(\S+)/m)?.[1]
  }
  return files
}

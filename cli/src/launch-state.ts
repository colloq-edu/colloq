import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LaunchOptions } from './launch-config.js'

export interface LaunchReceipt {
  pid: number
  runId: string
  root: string
  port: number
  url: string
  dataDir: string
  workspaceDir: string
  leaseFile: string
  mode: 'run' | 'dev'
  startedAt: number
  phase: 'preparing' | 'starting' | 'ready' | 'stopping'
  options: LaunchOptions
  serverPid?: number
  hosting?: 'starting' | 'failed'
}
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}`
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 })
  try {
    fs.renameSync(temporary, file)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {}
  }
}
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
export function readReceipt(file: string): LaunchReceipt | null {
  const value = readJson<LaunchReceipt>(file)
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    typeof value.runId !== 'string' ||
    !value.runId ||
    !['run', 'dev'].includes(value.mode) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !['root', 'url', 'dataDir', 'workspaceDir', 'leaseFile'].every(
      (key) => typeof (value as unknown as Record<string, unknown>)[key] === 'string',
    ) ||
    !value.options ||
    typeof value.options !== 'object'
  )
    return null
  return value
}

/** Reclaim under a separate exclusive guard: two stale-lock readers cannot unlink a new owner. */
export function acquireLock(file: string, pid: number, runId: string, isAlive = alive): () => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const create = (): void => {
    const fd = fs.openSync(file, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid, runId }) + '\n')
    } finally {
      fs.closeSync(fd)
    }
  }
  try {
    create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const guard = `${file}.reclaim`
    try {
      fs.mkdirSync(guard, { mode: 0o700 })
    } catch {
      throw new Error('Другой запуск уже проверяет локальную сессию. Повторите команду.')
    }
    try {
      const prior = readJson<{ pid: number; runId: string }>(file)
      if (!prior || isAlive(prior.pid))
        throw new Error(
          'Локальная сессия уже запускается или работает. Используйте colloq status / colloq stop.',
        )
      fs.unlinkSync(file)
      create()
    } finally {
      fs.rmdirSync(guard)
    }
  }
  return () => {
    if (readJson<{ runId: string }>(file)?.runId === runId) fs.unlinkSync(file)
  }
}

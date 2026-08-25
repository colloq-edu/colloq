import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import type { FileEntry } from '@shared/protocol'

/**
 * Each session gets a directory under the shared /workspace volume. The kernel
 * container mounts the same volume, so `open('data.csv')` inside a cell and the
 * Files panel in the browser look at the same bytes.
 */
export function sessionDir(sessionId: string): string {
  const dir = path.join(config.workspaceDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Kernel-side path (the kernel container mounts the volume at /workspace too). */
export function kernelCwd(sessionId: string): string {
  return `/workspace/${sessionId}`
}

/** Reject anything that could escape the session directory. */
export function safeName(name: string): string | null {
  const base = path.basename(name)
  if (!base || base === '.' || base === '..') return null
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) return null
  if (base.length > 200) return null
  return base
}

export function resolveInSession(sessionId: string, name: string): string | null {
  const base = safeName(name)
  if (!base) return null
  const dir = sessionDir(sessionId)
  const full = path.join(dir, base)
  if (!full.startsWith(dir + path.sep)) return null
  return full
}

export function listFiles(sessionId: string): FileEntry[] {
  const dir = sessionDir(sessionId)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const entries: FileEntry[] = []
  for (const name of names) {
    if (name.startsWith('.') || name === '__pycache__') continue
    try {
      const stat = fs.statSync(path.join(dir, name))
      if (!stat.isFile()) continue
      entries.push({ name, size: stat.size, modifiedAt: stat.mtimeMs })
    } catch {
      /* vanished between readdir and stat; skip */
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

export function deleteFile(sessionId: string, name: string): boolean {
  const full = resolveInSession(sessionId, name)
  if (!full) return false
  try {
    fs.unlinkSync(full)
    return true
  } catch {
    return false
  }
}

/**
 * A competition's open data as one archive: «Скачать всё» on the task tab.
 *
 * `<slug>.zip` holds `<slug>/data/<file>` for every open file, the way a
 * submission finds them, with the notebooks — the starter ones — next to
 * `data/`, where a submission's own notebook runs: unzipped, a starter reads
 * `data/train.csv` unchanged. Only the open files, by the same list the
 * single-file door trusts (routes/competitions.ts · files/:name), so no
 * hidden answer or sealed test ever reaches the archive.
 *
 * Competition files keep no CRC, so it is counted once per version of a file
 * (its size and mtime) and remembered: a class pressing the button together
 * reads each file twice in all, not thirty times.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Competition } from '@shared/competitions'
import { crc32OfFile } from '../publish/page-files.js'
import { diskZipPlan, type ZipPlan } from '../publish/zip.js'
import { openDir } from './storage.js'
import { listFiles } from './store.js'

const known = new Map<string, { bytes: number; mtimeMs: number; crc: Promise<number> }>()

function crcOf(file: string, stat: fs.Stats): Promise<number> {
  const hit = known.get(file)
  if (hit && hit.bytes === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.crc
  const crc = crc32OfFile(file)
  known.set(file, { bytes: stat.size, mtimeMs: stat.mtimeMs, crc })
  crc.catch(() => known.delete(file))
  return crc
}

/** Where a file goes in the archive: a notebook next to `data/`, the rest inside it. */
export function archivedName(name: string): string {
  return name.toLowerCase().endsWith('.ipynb') ? name : `data/${name}`
}

/** The archive of the open files, or `null` when there is nothing to put in it. */
export async function competitionZipPlan(competition: Pick<Competition, 'id' | 'slug'>): Promise<ZipPlan | null> {
  const dir = openDir(competition.id)
  const entries: { name: string; file: string; bytes: number; crc: number }[] = []
  for (const open of listFiles(competition.id, 'open')) {
    const file = path.join(dir, open.name)
    let stat: fs.Stats
    try {
      // lstat: a link in the data folder is not followed out of it.
      stat = fs.lstatSync(file)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    entries.push({ name: `${competition.slug}/${archivedName(open.name)}`, file, bytes: stat.size, crc: await crcOf(file, stat) })
  }
  return entries.length > 0 ? diskZipPlan(competition.slug, entries) : null
}

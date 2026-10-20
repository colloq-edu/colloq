/**
 * A competition's materials as one archive: «Скачать материалы» in the
 * panel, so that another teacher of the course can read the competition
 * through, or build one like it, without asking its author for the files.
 *
 * `<slug>-materials.zip` holds one folder, `<slug>-materials/`:
 *
 *   README.md                  what this is, where its page lives, what is inside and what is not
 *   task.md                    the task, the Markdown the editor holds, word for word
 *   competition.json           the settings and limits that make the competition
 *   metric/metric.py           the teacher's score(), under the name the metric container gives it
 *   environment/packages.txt   the base the notebooks run on, package by package
 *   solution/notebook.ipynb    the sample notebook (the baseline), when there is one
 *   data/<file>                the open data, the files an entrant downloads
 *   hidden/<file>              the hidden test: what a notebook reads in data/ during the check
 *
 * WHAT IS NOT HERE AND CANNOT BE. The answers (`solution.csv`): nobody sees
 * their bytes, its teacher included (routes/admin-competitions.ts says why),
 * and competition.json names them by what the editor shows — the name, the
 * rows, the columns. The split seed: with it and the share, the private rows
 * are told from the public ones. And nothing of a person: no entrant, no key,
 * no submission, no entrant's package set. competition.json is written field
 * by field for that reason, never as the competition's row with a few keys
 * taken out — a field added to the row later must not ride out by default.
 *
 * The hidden test does leave here, as at its own door in the editor and at
 * no entrant's: the teachers who may open the competition are the ones who
 * built it. The door that sends the archive records that in the audit log
 * (routes/admin-competitions.ts), and keeps it in no cache.
 *
 * Store-only and streamed, through the same writer and the same line as the
 * class archives and the open data (publish/zip.ts, publish/zip-send.ts): the
 * open data and the hidden test are up to 200 MB each, and neither is read
 * into memory. Each disk file's CRC is counted once per version of the file
 * (its size and mtime) and remembered, as competitions/zip.ts does for the
 * open data, so a second download reads every file once, not twice.
 */
import fs from 'node:fs'
import path from 'node:path'
import { tr } from '@shared/i18n'
import type { Competition } from '@shared/competitions'
import type { BaselineView, FileView, SealedFileView, SplitView } from '@shared/competitions-api'
import type { DependencyPolicy, EnvironmentRevision } from '@shared/dependencies'
import { config } from '../config.js'
import { crc32, crc32OfFile } from '../publish/page-files.js'
import { diskZipPlan, type ZipPlan } from '../publish/zip.js'
import { METRIC_NAME } from './docker-runner.js'
import { baselineDir, NOTEBOOK_FILE, openDir, sealedDir } from './storage.js'

/** What the archive is made of: the editor's own view of the competition, and what its page names around it. */
export interface MaterialsInput {
  competition: Competition
  /** The open data, the answers and the hidden test as the editor lists them (CompetitionView). */
  openFiles: readonly FileView[]
  hiddenFiles: readonly FileView[]
  sealedFiles: readonly SealedFileView[]
  split: SplitView | null
  baseline: BaselineView | null
  /** The course the competition belongs to, by name; null — none. */
  course: string | null
  /** The base its notebooks run on (competitionRevision); null — not pinned yet. */
  revision: Pick<EnvironmentRevision, 'environmentName' | 'pythonVersion' | 'platform' | 'packages'> | null
  /** Participants' own packages: whether they may add them, and how much they may download. */
  dependencies: Pick<DependencyPolicy, 'enabled' | 'maxDownloadBytes'>
}

/** The archive's plan, and the hidden-test files in it, by name: what the door records. */
export interface MaterialsArchive {
  plan: ZipPlan
  sealed: string[]
}

/** The archive's folder, and its name without `.zip`. */
export function materialsTop(competition: Pick<Competition, 'slug'>): string {
  return `${competition.slug}-materials`
}

/** Where the archive puts each part, under its folder. */
export const MATERIALS_PATHS = {
  readme: 'README.md',
  task: 'task.md',
  settings: 'competition.json',
  metric: `metric/${METRIC_NAME}`,
  packages: 'environment/packages.txt',
  baseline: `solution/${NOTEBOOK_FILE}`,
  data: 'data',
  hidden: 'hidden',
} as const

/* -------------------------------------------------------------- the CRCs */

const known = new Map<string, { bytes: number; mtimeMs: number; crc: Promise<number> }>()

function crcOf(file: string, stat: fs.Stats): Promise<number> {
  const hit = known.get(file)
  if (hit && hit.bytes === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.crc
  const crc = crc32OfFile(file)
  known.set(file, { bytes: stat.size, mtimeMs: stat.mtimeMs, crc })
  crc.catch(() => known.delete(file))
  // A competition deleted or renamed leaves its entries behind: the map is a cache, not a record.
  if (known.size > 4096) known.delete(known.keys().next().value!)
  return crc
}

/* ------------------------------------------------------- the texts in it */

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString())

/**
 * The settings a teacher needs to understand the competition or build it
 * again, one field at a time (see the header for why never a spread of the
 * row). The metric's code is its own file, the task is its own file.
 */
export function materialsSettings(input: MaterialsInput): Record<string, unknown> {
  const { competition: c } = input
  return {
    title: c.title,
    slug: c.slug,
    blurb: c.blurb,
    page: `${config.publicUrl.replace(/\/+$/, '')}/k/${c.slug}`,
    state: c.state,
    course: input.course,
    startsAt: iso(c.startsAt),
    deadlineAt: iso(c.deadlineAt),
    environment: c.environment,
    base: input.revision
      ? { environment: input.revision.environmentName, python: input.revision.pythonVersion, platform: input.revision.platform, packages: MATERIALS_PATHS.packages }
      : null,
    limits: {
      wallSeconds: c.limits.wallSeconds,
      memoryMb: c.limits.memoryMb,
      cpus: c.limits.cpus,
      perDay: c.limits.perDay,
      gpu: c.limits.gpu === true,
    },
    metric: { name: c.metric.name, direction: c.metric.direction, file: c.metric.code.trim() ? MATERIALS_PATHS.metric : null },
    publicPercent: c.publicPercent,
    split: input.split ? { rows: input.split.total, publicRows: input.split.publicRows, privateRows: input.split.privateRows, byUsage: input.split.byUsage } : null,
    privateRelease: c.privateRelease,
    scoring: c.scoring,
    boardVisibility: c.boardVisibility ?? 'public',
    lateSubmissions: c.lateSubmissions === true,
    outputPolicy: c.outputPolicy ?? 'brief',
    dependencies: { enabled: input.dependencies.enabled, maxDownloadBytes: input.dependencies.maxDownloadBytes },
    files: {
      data: input.openFiles.map((file) => ({ name: file.name, bytes: file.bytes, rows: file.rows })),
      hidden: input.sealedFiles.map((file) => ({ name: file.name, bytes: file.bytes, rows: file.rows, replaces: file.replaces })),
      // By what the editor shows of them: their bytes are in no archive.
      answers: input.hiddenFiles.map((file) => ({ name: file.name, rows: file.rows, columns: file.columns, included: false })),
      solution: input.baseline
        ? {
            file: MATERIALS_PATHS.baseline,
            cells: input.baseline.cells,
            state: input.baseline.state,
            publicScore: input.baseline.publicScore,
            privateScore: input.baseline.privateScore,
          }
        : null,
    },
  }
}

/** The base's packages as `pip freeze` writes them, under one line saying which base. */
export function packagesText(revision: NonNullable<MaterialsInput['revision']>): string {
  const head = `# ${revision.environmentName} · Python ${revision.pythonVersion} · ${revision.platform}`
  return `${[head, ...revision.packages.map((pkg) => `${pkg.name}==${pkg.version}`)].join('\n')}\n`
}

/** The README: which competition, where its page lives, what each part is, and what is left out on purpose. */
export function materialsReadme(input: MaterialsInput, parts: readonly string[]): string {
  const c = input.competition
  const page = `${config.publicUrl.replace(/\/+$/, '')}/k/${c.slug}`
  const line = (part: string, key: string, values: Record<string, string | number> = {}) => `- \`${part}\` — ${tr(key, values)}`
  const lines = [`# ${c.title}`, '', tr('server.competitions.materials.page', { url: page }), '']
  if (input.course) lines.push(tr('server.competitions.materials.course', { name: input.course }), '')
  lines.push(`## ${tr('server.competitions.materials.inside')}`, '')
  const has = (part: string) => parts.some((one) => one === part || one.startsWith(`${part}/`))
  lines.push(line(MATERIALS_PATHS.task, 'server.competitions.materials.task'))
  lines.push(line(MATERIALS_PATHS.settings, 'server.competitions.materials.settings'))
  if (has(MATERIALS_PATHS.metric)) lines.push(line(MATERIALS_PATHS.metric, 'server.competitions.materials.metric'))
  if (has(MATERIALS_PATHS.packages)) lines.push(line(MATERIALS_PATHS.packages, 'server.competitions.materials.packages'))
  if (has(MATERIALS_PATHS.baseline)) lines.push(line(MATERIALS_PATHS.baseline, 'server.competitions.materials.baseline'))
  if (has(MATERIALS_PATHS.data)) lines.push(line(`${MATERIALS_PATHS.data}/`, 'server.competitions.materials.data'))
  if (has(MATERIALS_PATHS.hidden)) lines.push(line(`${MATERIALS_PATHS.hidden}/`, 'server.competitions.materials.hidden'))
  lines.push('', tr('server.competitions.materials.notInside'), '')
  return lines.join('\n')
}

/* ------------------------------------------------------------ the plan */

interface Part {
  name: string
  bytes: number
  crc: number
  /** A file on disk, or the bytes made here. */
  file: string | null
  body: Buffer | null
}

/** A text made here, as an archive part. */
function textPart(name: string, text: string): Part {
  const body = Buffer.from(text, 'utf8')
  return { name, bytes: body.length, crc: crc32(body), file: null, body }
}

/** A regular file of the competition's own folders, as an archive part; null — it is not on disk as a file. */
async function diskPart(name: string, file: string): Promise<Part | null> {
  let stat: fs.Stats
  try {
    // lstat: a link in a competition's folder is not followed out of it.
    stat = fs.lstatSync(file)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  return { name, bytes: stat.size, crc: await crcOf(file, stat), file, body: null }
}

/**
 * Everything the archive will hold, with its exact length, and the hidden
 * test's files in it. Asked after the archive's wait in line (zip-send.ts ·
 * sendArchive), against the files as they are then. A file whose row says
 * it exists but whose bytes are not on disk is left out rather than breaking
 * the archive half-way; competition.json still names it.
 */
export async function materialsZipPlan(input: MaterialsInput): Promise<MaterialsArchive> {
  const { competition: c } = input
  const top = materialsTop(c)
  const parts: Part[] = [textPart(MATERIALS_PATHS.task, c.description)]
  parts.push(textPart(MATERIALS_PATHS.settings, `${JSON.stringify(materialsSettings(input), null, 2)}\n`))
  if (c.metric.code.trim()) parts.push(textPart(MATERIALS_PATHS.metric, c.metric.code.endsWith('\n') ? c.metric.code : `${c.metric.code}\n`))
  if (input.revision) parts.push(textPart(MATERIALS_PATHS.packages, packagesText(input.revision)))
  if (input.baseline) {
    const baseline = await diskPart(MATERIALS_PATHS.baseline, path.join(baselineDir(c.id), NOTEBOOK_FILE))
    if (baseline) parts.push(baseline)
  }
  /*
   * One entry per name, case aside: unzip on a Mac (and on Windows) merges
   * `Train.csv` into `train.csv`, and the second would silently overwrite the
   * first. The folders keep the open data and the hidden test apart already.
   */
  const used = new Set<string>()
  const sealed: string[] = []
  for (const [folder, dir, files] of [
    [MATERIALS_PATHS.data, openDir(c.id), input.openFiles],
    [MATERIALS_PATHS.hidden, sealedDir(c.id), input.sealedFiles],
  ] as const) {
    for (const listed of files) {
      const name = `${folder}/${listed.name}`
      if (used.has(name.toLowerCase())) continue
      const part = await diskPart(name, path.join(dir, listed.name))
      if (!part) continue
      used.add(name.toLowerCase())
      parts.push(part)
      if (folder === MATERIALS_PATHS.hidden) sealed.push(listed.name)
    }
  }
  const readme = textPart(MATERIALS_PATHS.readme, materialsReadme(input, parts.map((part) => part.name)))
  const all = [readme, ...parts]
  /*
   * The writer takes files on disk (diskZipPlan), and its length counts only
   * names and sizes: the few parts made here are handed to it under no file
   * and get their bytes back by position, which the plan keeps. The stream
   * writes a part's `body` when it has one (publish/zip.ts · archive).
   */
  const plan = diskZipPlan(top, all.map((part) => ({ name: `${top}/${part.name}`, file: part.file ?? '', bytes: part.bytes, crc: part.crc })))
  plan.entries = plan.entries.map((entry, index) => (all[index].body ? { ...entry, file: null, body: all[index].body } : entry))
  return { plan, sealed }
}

/**
 * Two things the competition screens say that have a right and a wrong
 * answer, taken out of the screens: where a competition's materials are
 * downloaded from (routes/admin-competitions.ts), and how many cores and how
 * much memory one submission can be given, and by whom
 * (competitions/settings.ts · submissionCeiling).
 *
 * No Svelte and no browser, like competitions.ts, so that the words are
 * checked from the tests (tests/competition-cores-bound.test.mts).
 */
import { formatNumber, tr } from '@shared/i18n'
import type { CeilingSource, CompetitionSettings } from '@shared/competitions-settings'

/* -------------------------------------------------------- the downloads */

const competitionAt = (id: string): string => `/api/admin/competitions/${encodeURIComponent(id)}`

/** «Скачать материалы»: the whole competition as one archive. */
export const materialsUrl = (id: string): string => `${competitionAt(id)}/materials.zip`
/** One open data file, the one an entrant downloads. */
export const openFileUrl = (id: string, name: string): string => `${competitionAt(id)}/files/${encodeURIComponent(name)}`
/** One hidden-test file; each download is a row in the audit log. */
export const sealedFileUrl = (id: string, name: string): string => `${competitionAt(id)}/sealed/${encodeURIComponent(name)}`
/** The sample notebook as it was uploaded. */
export const baselineUrl = (id: string): string => `${competitionAt(id)}/baseline`

/* ----------------------------------------------------------- the ceiling */

/** Which executor a ceiling is: this server, a machine by name, or (for a teacher) a machine. */
export function ceilingWhere(source: CeilingSource): string {
  if (source.from === 'home') return tr('admin.resourcesTab.ceilingWhereHome')
  return source.name
    ? tr('admin.resourcesTab.ceilingWhereMachine', { name: source.name })
    : tr('admin.resourcesTab.ceilingWhereSomeMachine')
}

/** Gigabytes to a tenth, rounded down: a ceiling is never shown above what it is. */
const gigabytes = (mb: number): string => formatNumber(Math.floor((mb / 1024) * 10) / 10, { maximumFractionDigits: 1 })

/**
 * The line under the defaults in «Ресурсы»: the most one submission may be
 * given — the bounds the form keeps its numbers to — and which executor that
 * is. `null` — a server from before the machines counted, which sends no
 * `ceiling`.
 */
export function ceilingNote(settings: Pick<CompetitionSettings, 'bounds' | 'ceiling'>): string | null {
  const ceiling = settings.ceiling
  if (!ceiling) return null
  const cores = tr('admin.resourcesTab.ceilingCores', { count: settings.bounds.cpus.max })
  const memory = tr('admin.resourcesTab.ceilingMemory', { gb: gigabytes(settings.bounds.memoryMb.max) })
  const same = ceilingWhere(ceiling.cpus) === ceilingWhere(ceiling.memoryMb)
  if (!same) {
    return tr('admin.resourcesTab.ceilingSplit', { cores, memory, coresFrom: ceilingWhere(ceiling.cpus), memoryFrom: ceilingWhere(ceiling.memoryMb) })
  }
  if (ceiling.cpus.from === 'home') return tr('admin.resourcesTab.ceilingHome', { cores, memory })
  return ceiling.cpus.name
    ? tr('admin.resourcesTab.ceilingMachine', { cores, memory, name: ceiling.cpus.name })
    : tr('admin.resourcesTab.ceilingSomeMachine', { cores, memory })
}

/**
 * The cores and memory a new competition gets now: the stored defaults held
 * to the bounds, as the server holds them (executors.ts ·
 * newCompetitionDefaults). What «Ресурсы» shows as saved in those two
 * fields: a default stored past its bound — the bound before 0.25, one saved
 * while only the machines ran notebooks, one from before a machine was
 * revoked — was drawn as a change the form pulled to the bound, which Save
 * could only overwrite and Discard never cleared.
 */
export function defaultsNow(settings: Pick<CompetitionSettings, 'defaults' | 'bounds'>): { cpus: number; memoryMb: number } {
  return {
    cpus: Math.min(settings.defaults.cpus, settings.bounds.cpus.max),
    memoryMb: Math.min(settings.defaults.memoryMb, settings.bounds.memoryMb.max),
  }
}

/** Gigabytes as the form's fields write them: to a tenth, rounded. */
const fieldGigabytes = (mb: number): string => formatNumber(mb / 1024, { maximumFractionDigits: 1 })

/**
 * The line under the defaults when one of them is stored past its bound: what
 * is stored, kept for when the bound grows back, while a new competition gets
 * what the fields show (defaultsNow) — said without a number of its own: the
 * ceiling's line above rounds its gigabytes down, the fields to the nearest
 * tenth. `null` — both within their bounds.
 */
export function pastBoundNote(settings: Pick<CompetitionSettings, 'defaults' | 'bounds'>): string | null {
  const now = defaultsNow(settings)
  const cores = settings.defaults.cpus > now.cpus
  const memory = settings.defaults.memoryMb > now.memoryMb
  if (!cores && !memory) return null
  const coresText = tr('admin.resourcesTab.pastBoundCores', { count: settings.defaults.cpus })
  const memoryText = tr('admin.resourcesTab.ceilingMemory', { gb: fieldGigabytes(settings.defaults.memoryMb) })
  const saved = cores && memory ? tr('admin.resourcesTab.pastBoundBoth', { cores: coresText, memory: memoryText }) : cores ? coresText : memoryText
  return tr('admin.resourcesTab.pastBound', { saved })
}

/** What the editor's lines under the tiles read of the queue's settings. */
type SizingSettings = Pick<CompetitionSettings, 'bounds' | 'ceiling' | 'machine' | 'runners' | 'gpu'>

/** A line under the tiles: a `warning` when no executor runs such a submission as asked, a plain `note` otherwise. */
export interface SizeLine {
  text: string
  tone: 'warning' | 'note'
}

/**
 * Whether this server's own pump takes the competition's notebooks at all,
 * by the server's rule (remote/fit.ts · homeTakes): its notebooks are on
 * («Тетради на этом сервере»), and a notebook with the card on only where it
 * has cards for submissions. Otherwise only the machines run them, whatever
 * the cores and the memory.
 */
function homeTakes(settings: SizingSettings, gpu: boolean): boolean {
  return settings.runners?.homeNotebooks.value !== false && !(gpu && settings.gpu.devices.length === 0)
}

/**
 * The editor's line under the tiles about the CPUs typed, when they are more
 * than this server has or than any executor gives. A competition's own
 * limits are the editor's to bound (up to 32), and what happens to such a
 * submission is the queue's (runner.ts · leftToMachines): a machine that can
 * run it takes it; with none, this server runs it on its own CPUs, slower
 * (runner.ts · homeLimits) — unless it does not run the competition's
 * notebooks at all (homeTakes), and then nothing does until a machine that
 * big joins. `gpu` — the card is on in the form. `null` — nothing to say:
 * the CPUs fit this server, the settings have not answered, or the cluster
 * sizes the runs (`gpu.managed`), not this server.
 */
export function coresNote(cpus: number, settings: SizingSettings | null, gpu = false): SizeLine | null {
  if (!settings || settings.gpu.managed || !Number.isFinite(cpus)) return null
  const max = settings.bounds.cpus.max
  const where = settings.ceiling ? ceilingWhere(settings.ceiling.cpus) : tr('admin.resourcesTab.ceilingWhereHome')
  if (!homeTakes(settings, gpu)) {
    // Only the machines run these: past the biggest machine's nothing does. A ceiling that is this server's says nothing of them.
    return cpus > max && settings.ceiling?.cpus.from === 'machine'
      ? { text: tr('admin.competitions.coresOverMachines', { max, where }), tone: 'warning' }
      : null
  }
  const home = settings.machine.cpus
  if (cpus > max) return { text: tr('admin.competitions.coresOverCeiling', { max, where, count: home }), tone: 'warning' }
  return cpus > home ? { text: tr('admin.competitions.coresOverHome', { count: home }), tone: 'note' } : null
}

/**
 * The editor's line under the tiles about the memory typed, when it is more
 * than this server could give one submission, or than any machine gives.
 * Never cut down the way CPUs are: a notebook asking more memory than this
 * server could ever reserve is one it never runs, and the queue leaves it to
 * the machines (runner.ts · leftToMachines) — with none that big on line, it
 * waits. While this server runs notebooks the memory's bound is its own
 * (competitions/settings.ts · submissionCeiling), so past it is past this
 * server; with its notebooks off, the bound is the biggest machine's.
 * `null` — nothing to say, as for coresNote.
 */
export function memoryNote(memoryMb: number, settings: SizingSettings | null, gpu = false): SizeLine | null {
  if (!settings || settings.gpu.managed || !Number.isFinite(memoryMb)) return null
  const max = settings.bounds.memoryMb.max
  if (memoryMb <= max) return null
  if (homeTakes(settings, gpu)) return { text: tr('admin.competitions.memoryOverHome', { gb: gigabytes(max) }), tone: 'warning' }
  return settings.ceiling?.memoryMb.from === 'machine'
    ? { text: tr('admin.competitions.memoryOverMachines', { gb: gigabytes(max), where: ceilingWhere(settings.ceiling.memoryMb) }), tone: 'warning' }
    : null
}

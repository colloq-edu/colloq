/**
 * Video cards for competition submissions, as the panel words them: the
 * owner's «Видеокарты для посылок» block on the Resources tab, the cards' bar
 * in «Как поделена машина», and the «ВИДЕОКАРТА» row of the competition
 * editor (Paper 15 · G1, G2).
 *
 * No Svelte and no browser, as in `admin/running-kernels.ts`: these are the
 * numbers an owner gives a card away by, and a slip in them shows only when a
 * class needs the card back or a submission dies at a share nobody promised.
 *
 * The one rule they all keep is the panel's (admin/ui/Resources.svelte): a
 * share is named only because the server enforces it — torch's allocator is
 * capped and the docker runner stops a run past it (competitions/gpu.ts). So
 * the share is computed here by the server's own formula, and where the
 * server would promise nothing (a card that did not say its size, the
 * cluster's card) the words say "unknown", never a number.
 */
import { formatNumber, tr } from '@shared/i18n'
import type { ResourceBudget } from '@shared/admin'
import type { CompetitionGpuCard, CompetitionGpuSettings } from '@shared/competitions-settings'
import { cardWord, gbText } from './running-kernels'

/**
 * A share in gigabytes to a tenth, as the server words it to a participant
 * ("6", "19,9"; runner.ts · gigabytes): the owner, the teacher and the
 * participant read the same number.
 */
export function shareGb(mb: number): string {
  return formatNumber(Math.round(mb / 102.4) / 10)
}

/* ------------------------------------------------------- the owner's block */

/** A card's row: what it is ("NVIDIA GeForce RTX 4090 · 24 ГБ"), as far as it said. */
export function cardFacts(card: Pick<CompetitionGpuCard, 'name' | 'memoryMb'>): string {
  return [card.name, card.memoryMb === null ? tr('admin.resourcesTab.gpuSizeUnknown') : gbText(card.memoryMb)]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Who a card is for, as the form would leave it. A ticked card is the
 * submissions' — but one a class still holds stays with that class until its
 * container ends, and the runs wait for it until then (`leaving`). An
 * unticked one is the classes': held by one now, or free — unless a
 * submission still runs on it (`finishing`): given back to classes mid-run,
 * it stays the run's until the run ends, and no class can start on it
 * meanwhile (kernel/pool.ts · takeGpu). Read as «свободна», it was a card the
 * owner told a teacher to take while the teacher's seminar was refused.
 */
export type CardHolder = 'runners' | 'leaving' | 'rooms' | 'finishing' | 'free'

export function cardHolder(card: Pick<CompetitionGpuCard, 'heldByRoom' | 'heldBySubmission'>, picked: boolean): CardHolder {
  if (picked) return card.heldByRoom ? 'leaving' : 'runners'
  if (card.heldByRoom) return 'rooms'
  // Absent from a server from before the field: nothing said, nothing held.
  return card.heldBySubmission === true ? 'finishing' : 'free'
}

export function holderWord(holder: CardHolder): string {
  return tr(`admin.resourcesTab.gpuHolder.${holder}`)
}

/** The share as the form now stands: the ticked cards and the runs per card typed. */
export interface ShareReadout {
  /** Cards ticked. */
  chosen: number
  perDevice: number
  /** Runs that may hold a card at once: cards × runs per card. */
  places: number
  /** One run per card: the whole card, nothing to cap. */
  whole: boolean
  /** The share every run is promised, MB; `null` — no card ticked, or one did not say its size. */
  sliceMb: number | null
}

/**
 * The server's rule (competitions/gpu.ts · sliceOverCards), on the form's
 * numbers: the smallest ticked card's memory over the runs sharing it —
 * whichever card a run lands on, it gets at least that — and nothing at all
 * when any ticked card did not say its size: a promise that holds on some
 * cards only is not one.
 */
export function shareReadout(
  cards: readonly Pick<CompetitionGpuCard, 'id' | 'memoryMb'>[],
  chosen: readonly string[],
  perDevice: number,
): ShareReadout {
  const runs = Math.max(1, Math.floor(perDevice))
  const ticked = cards.filter((card) => chosen.includes(card.id))
  let sliceMb: number | null = null
  for (const card of ticked) {
    if (card.memoryMb === null || !(card.memoryMb > 0)) {
      sliceMb = null
      break
    }
    const slice = Math.floor(card.memoryMb / runs)
    sliceMb = sliceMb === null ? slice : Math.min(sliceMb, slice)
  }
  return { chosen: ticked.length, perDevice: runs, places: ticked.length * runs, whole: runs === 1, sliceMb }
}

/** The big readout beside «Срез»: "≈ 6 ГБ", "вся карта", or a dash for a size nobody knows. */
export function shareGauge(readout: ShareReadout): string {
  if (readout.whole) return tr('admin.resourcesTab.gpuSliceWhole')
  return readout.sliceMb === null ? '—' : tr('admin.resourcesTab.gpuSliceGb', { value: shareGb(readout.sliceMb) })
}

/** The words after it: "видеопамяти на посылку · 4 места на картах". */
export function shareDetail(readout: ShareReadout): string {
  return [
    !readout.whole && readout.sliceMb !== null ? tr('admin.resourcesTab.gpuSlicePerRun') : null,
    tr('admin.resourcesTab.gpuPlaces', { count: readout.places }),
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The two lines under the readout, by case: what the share means, and how
 * the card is shared. `tone` is the first line's: a share held is a fact
 * (ink), an uncapped share of unknown size is a weaker promise (warning).
 */
export function shareLines(readout: ShareReadout): { lead: string; note: string | null; tone: 'ink' | 'warning' | 'muted' } {
  if (readout.chosen === 0) return { lead: tr('admin.resourcesTab.gpuNoneGiven'), note: null, tone: 'muted' }
  if (readout.whole) return { lead: tr('admin.resourcesTab.gpuWholeLine'), note: tr('admin.resourcesTab.gpuLeavesClasses'), tone: 'ink' }
  if (readout.sliceMb === null) {
    return { lead: tr('admin.resourcesTab.gpuUnknownLine'), note: tr('admin.resourcesTab.gpuLeavesClasses'), tone: 'warning' }
  }
  return {
    lead: tr('admin.resourcesTab.gpuHeld', { value: shareGb(readout.sliceMb) }),
    note: tr('admin.resourcesTab.gpuTimeShared', { count: readout.perDevice }),
    tone: 'ink',
  }
}

/**
 * What a runner-card field falls back to once its saved value is forgotten:
 * the cards COMPETITION_GPUS names (those this machine lists), or none; the
 * runs per card COMPETITION_GPU_PER_DEVICE names, or one — and which of the
 * two answers (CompetitionGpuSettings.fallback). The owner's «вернуть …»
 * shows it at once, before Save, the way a room field shows its .env number,
 * and its word says where it comes from: «вернуть умолчание» on the cards
 * used to give the .env cards back to submissions, and the form went on
 * showing the old ticks and share until Save. `null` — the server did not
 * say (one from before it), or the cluster has the cards.
 */
export function cardsFallback(gpu: CompetitionGpuSettings | null): { devices: string[]; source: 'env' | 'default' } | null {
  const fallback = gpu?.fallback
  if (!gpu || gpu.managed || !fallback) return null
  const named = new Set(fallback.devices)
  return { devices: gpu.cards.map((card) => card.id).filter((id) => named.has(id)), source: fallback.source.devices }
}

export function perDeviceFallback(gpu: CompetitionGpuSettings | null): { perDevice: number; source: 'env' | 'default' } | null {
  const fallback = gpu?.fallback
  if (!gpu || gpu.managed || !fallback) return null
  return { perDevice: fallback.perDevice, source: fallback.source.perDevice }
}

/**
 * A card whose size the server has not read yet. The sizes are asked in the
 * background (kernel/resources.ts), so the first answer after a restart may
 * say «объём неизвестен» for a card that will say its size seconds later.
 */
export function sizesUnknown(gpu: CompetitionGpuSettings | null): boolean {
  return gpu !== null && !gpu.managed && gpu.cards.some((card) => card.memoryMb === null)
}

/**
 * A later answer's card facts — name and size, what a card says about itself
 * — laid over the settings the form stands on, and nothing else: the chosen
 * cards and the runs per card are what the form measures the owner's unsaved
 * edits against, and a save made elsewhere in between must not slip in under
 * them. The saved share is taken only when it is the share of the same
 * choice; a fact already known is kept.
 */
export function withCardFacts(current: CompetitionGpuSettings, fresh: CompetitionGpuSettings): CompetitionGpuSettings {
  const said = new Map(fresh.cards.map((card) => [card.id, card]))
  const cards = current.cards.map((card) => {
    const facts = said.get(card.id)
    return facts ? { ...card, name: card.name ?? facts.name, memoryMb: card.memoryMb ?? facts.memoryMb } : card
  })
  const sameChoice =
    fresh.perDevice === current.perDevice &&
    fresh.devices.length === current.devices.length &&
    fresh.devices.every((id) => current.devices.includes(id))
  return { ...current, cards, sliceMb: current.sliceMb ?? (sameChoice ? fresh.sliceMb : null) }
}

/* --------------------------------------------------------- the machine bar */

export interface CardsBar {
  total: number
  rooms: number
  runners: number
  free: number
  /** The word on the right: "свободна 1 карта", "свободных нет — обе при деле". */
  status: string
  roomsDetail: string
  runnersDetail: string
  freeDetail: string
}

/**
 * The cards' line of «Как поделена машина», from the server's census
 * (ResourceBudget.gpus) and the saved settings for what a submission gets on
 * one. `null` — no line: the cluster has the cards, or the machine has none.
 */
export function cardsBar(gpus: ResourceBudget['gpus'] | undefined, saved: CompetitionGpuSettings | null): CardsBar | null {
  if (!gpus || gpus.total === 0) return null
  const free = Math.max(0, gpus.total - gpus.rooms - gpus.runners)
  const status =
    free > 0
      ? tr('admin.resourcesTab.gpusFree', { count: free })
      : gpus.total === 1
        ? tr('admin.resourcesTab.gpusBusyOne')
        : gpus.total === 2
          ? tr('admin.resourcesTab.gpusBusyTwo')
          : tr('admin.resourcesTab.gpusBusyAll')
  // What a run on the submissions' cards gets, as saved: "по 4 сразу · срез ≈ 6 ГБ".
  const terms =
    !saved || gpus.runners === 0
      ? []
      : saved.perDevice <= 1
        ? [tr('admin.resourcesTab.gpuWholePerRun')]
        : [
            tr('admin.resourcesTab.gpuAtOnce', { count: saved.perDevice }),
            ...(saved.sliceMb !== null ? [tr('admin.resourcesTab.gpuSliceShort', { value: shareGb(saved.sliceMb) })] : []),
          ]
  return {
    total: gpus.total,
    rooms: gpus.rooms,
    runners: gpus.runners,
    free,
    status,
    roomsDetail: [tr('admin.resourcesTab.gpuCount', { count: gpus.rooms }), tr('admin.resourcesTab.gpuWholePerClass')].join(' · '),
    runnersDetail: [tr('admin.resourcesTab.gpuCount', { count: gpus.runners }), ...terms].join(' · '),
    freeDetail: tr('admin.resourcesTab.gpuCount', { count: free }),
  }
}

/* ------------------------------------------------------- the editor's row */

/**
 * The «ВИДЕОКАРТА» row's state (Paper 15 · G2):
 * `cpu` — the environment has no CUDA, the switch does not apply;
 * `unknown` — off, and the environment list has not answered;
 * `off` — a GPU environment with the card off: CUDA torch on the CPU;
 * `on` — the run gets its share; `noCards` — on, but nobody gave submissions
 * a card, so the door refuses every run.
 */
export type GpuRowState = 'cpu' | 'unknown' | 'off' | 'on' | 'noCards'

export function gpuRowState(input: { environmentGpu: boolean | null; on: boolean; noCards: boolean }): GpuRowState {
  if (input.environmentGpu === false) return 'cpu'
  if (!input.on) return input.environmentGpu ? 'off' : 'unknown'
  return input.noCards ? 'noCards' : 'on'
}

/**
 * The switch's second word: "срез ≈ 6 ГБ", "вся карта" at one run per card,
 * or a bare "срез" while nothing is known — no card given, a size nobody
 * said, or the cluster's card.
 *
 * With machines that have cards (`machines`: RemoteCompetitionWhere.cards,
 * passed while one was heard within the hour) a run may land on one of
 * theirs too, so the word is the smallest share it could get anywhere: the
 * machines' alone on a server that gives submissions no card, where a bare
 * «срез» said nothing although they promise one (§5.8), and the smaller of
 * the two beside this server's own cards — «вся карта» here is not what a
 * run on a machine gets. A size either side did not say leaves the bare
 * word: no promise is made from half of the picture.
 */
export function gpuSwitchWord(cards: CompetitionGpuSettings | null, machines: { sliceMb: number | null } | null = null): string {
  const here = cards && !cards.managed && cards.devices.length > 0 ? cards : null
  if (machines) {
    const slices = here ? [machines.sliceMb, here.sliceMb] : [machines.sliceMb]
    const known = slices.filter((slice): slice is number => slice !== null)
    return known.length < slices.length
      ? tr('admin.competitions.gpuSliceBare')
      : tr('admin.competitions.gpuSlice', { value: shareGb(Math.min(...known)) })
  }
  if (!here) return tr('admin.competitions.gpuSliceBare')
  if (here.perDevice <= 1) return tr('admin.competitions.gpuWhole')
  return here.sliceMb === null
    ? tr('admin.competitions.gpuSliceBare')
    : tr('admin.competitions.gpuSlice', { value: shareGb(here.sliceMb) })
}

/**
 * The line under the row with the card on: where the runs go and what they
 * get there ("На картах для посылок 4 места: GPU 0 по 4 посылки, срез ≈ 6
 * ГБ."), and that the memory tile is the machine's, not the card's. Under
 * the cluster only the second sentence: the places are the cluster's.
 */
export function gpuPlacesNote(cards: CompetitionGpuSettings | null, memoryMb: number): string {
  const memory = tr('admin.competitions.gpuMemoryNote', { memory: shareGb(memoryMb) })
  if (!cards || cards.managed || cards.devices.length === 0) return memory
  const share =
    cards.perDevice <= 1
      ? tr('admin.competitions.gpuShareWhole')
      : cards.sliceMb === null
        ? tr('admin.competitions.gpuShareUnknown')
        : tr('admin.competitions.gpuSlice', { value: shareGb(cards.sliceMb) })
  const places = tr('admin.competitions.gpuPlaces', {
    count: cards.devices.length * cards.perDevice,
    cards: cards.devices.map(cardWord).join(', '),
    per: tr('admin.competitions.gpuRunsPer', { count: cards.perDevice }),
    share,
  })
  return `${places} ${memory}`
}

/**
 * Оракул о решениях: один взгляд сверху на пятьсот попыток.
 *
 * Преподаватель на консилиуме не читает пятьсот листов — он читает шесть
 * групп одинаковых решений, и просит модель сказать про них три вещи: что в
 * них верно, где типичная ошибка и что показать классу. Тем же ответом модель
 * даёт группам имена одной строкой и черновики ответов группам с ошибкой.
 *
 * Три вещи, которые здесь держатся нарочно.
 *
 * Модель не видит имён. Ей едут тексты по группам с числами, задание и эталон,
 * если он есть; группы названы G1…GN, и к людям их привязывает сервер после
 * ответа (`notable` → представитель группы) и пульт (по ключу группы). Иначе
 * «примечательное решение Пети» лежало бы в промпте чужого провайдера.
 *
 * Группы считает сервер, не модель: `normalizeAttempt` — та же функция, по
 * которой пульт рисует стопку и полосу, и два разных «одинаково» дали бы
 * сводку, в которой «так же ещё 311» не сходится с шириной сегмента.
 *
 * Обновляется только рукой. Сводка стоит вопроса из лимита комнаты, а класс
 * сдаёт по одному в секунду: авто-обновление тратило бы ключ на каждую сдачу
 * и переписывало абзацы под глазами у того, кто их читает. Что сдали ещё N с
 * тех пор — считает клиент по `basedOn`.
 *
 * Разбор ответа устойчив к модели, которая не умеет в строгий JSON: тогда
 * остаётся сводка из текста, а имена и черновики — пустые. Плохая сводка лучше
 * красной ошибки посреди пары.
 */
import type { CouncilGroup, CouncilOracle, CouncilRun, CouncilStatus } from '@shared/protocol'
import { groupStatus } from '@shared/protocol'
import { normalizeAttempt } from '@shared/notebook'
import { getOracleSettings } from '../admin/settings.js'
import { noteTokens } from '../admin/usage.js'
import { streamChat, type ChatTurn } from './provider.js'

/** То, что оракулу нужно от попытки: без имени, цвета и аватара — их он не видит. */
export interface OracleAttempt {
  participantId: string
  text: string
  submittedAt: number | null
  run: CouncilRun | null
  correct: boolean | null
}

/** Задание, как его видит модель: текст общей ячейки и то, что вокруг. */
export interface OracleTask {
  /** Текст общей ячейки — то, что студенты решали. */
  source: string
  /** Предыдущая ячейка: условие часто лежит в markdown над кодом. */
  before: string | null
  /** Эталонное решение, если преподаватель его дал. Пока его негде взять — `null`. */
  reference: string | null
}

/** Где оракул хранит состояние — council.ts; в тестах подменяется. */
export interface OracleStore {
  oracleOf(sessionId: string, cellId: string): CouncilOracle | null
  setOracle(sessionId: string, cellId: string, oracle: CouncilOracle): void
}

/*
 * Сколько кода одной группы едет модели.
 *
 * Полторы тысячи знаков — сорок строк, целая попытка почти всегда. Длиннее
 * бывает вставленный файл, и его хвост стоит места, которое лучше отдать ещё
 * одной группе.
 */
const MAX_GROUP_SOURCE = 1_500
const MAX_TASK_SOURCE = 4_000
/** Имя группы — одна строка чипа; длиннее не поместится и не прочитается. */
const MAX_LABEL = 60
const MAX_NOTABLE = 3

/* ----------------------------------------------------------------- группы */

/**
 * Состояние попытки одним словом — как в `CouncilStatus`: отметка
 * преподавателя сильнее запуска, потому что решение о верности — его.
 */
export function statusOf(attempt: Pick<OracleAttempt, 'run' | 'correct'>): CouncilStatus {
  if (attempt.correct === true) return 'correct'
  if (attempt.correct === false) return 'wrong'
  if (attempt.run?.state === 'error') return 'failed'
  if (attempt.run?.state === 'ok') return 'ran'
  return 'unrun'
}

/**
 * Группы одинаковых решений среди СДАННЫХ — от большой к малой.
 *
 * Только сданные: то, что человек ещё печатает, — не решение, а полуслово, и
 * группа «x=» из сорока недописанных попыток ничего не сказала бы ни модели,
 * ни преподавателю. Представитель — самый ранний сдавший. Статус группы — по
 * всем её членам той же `groupStatus`, что у пульта и council.ts: иначе
 * сводка считала бы группу «верно», а полоса под карточкой — «не смотрели».
 */
export function groupsOf(attempts: readonly OracleAttempt[]): CouncilGroup[] {
  const byKey = new Map<string, OracleAttempt[]>()
  for (const attempt of attempts) {
    if (attempt.submittedAt === null) continue
    const key = normalizeAttempt(attempt.text)
    const list = byKey.get(key)
    if (list) list.push(attempt)
    else byKey.set(key, [attempt])
  }
  const groups: CouncilGroup[] = []
  for (const [key, members] of byKey) {
    // Разрыв по id — как у пульта; `updatedAt` оракулу не везут, и в одну
    // миллисекунду представитель здесь может отличаться от карточки.
    members.sort(
      (a, b) =>
        (a.submittedAt ?? 0) - (b.submittedAt ?? 0) ||
        a.participantId.localeCompare(b.participantId),
    )
    const representative = members[0]
    groups.push({
      key,
      count: members.length,
      label: null,
      sample: representative.text,
      status: groupStatus(members.map(statusOf)),
      // Оракулу «на экране» не нужно, но форма группы одна на всех.
      shown: false,
      representative: representative.participantId,
      members: members.map((m) => m.participantId),
    })
  }
  // При равном размере раньше та, которую сдали раньше, — так же стопка на
  // пульте ставит представителей; и порядок не плавает между двумя вопросами
  // при том же наборе попыток.
  const sentAt = (g: CouncilGroup) => byKey.get(g.key)?.[0].submittedAt ?? 0
  groups.sort((a, b) => b.count - a.count || sentAt(a) - sentAt(b) || a.key.localeCompare(b.key))
  return groups
}

/* ----------------------------------------------------------------- промпт */

const STATUS_WORDS: Record<CouncilStatus, string> = {
  unrun: 'не запускали',
  ran: 'запуск прошёл без исключения',
  failed: 'запуск упал',
  correct: 'преподаватель отметил «верно»',
  wrong: 'преподаватель отметил «неверно»',
}

/**
 * «запуск упал: TypeError» — имя исключения из вывода, если оно есть. Упасть
 * мог не представитель, а любой член группы — берётся первый упавший.
 */
function statusLine(group: CouncilGroup, byId: Map<string, OracleAttempt>): string {
  const word = STATUS_WORDS[group.status]
  if (group.status !== 'failed') return word
  const failed = group.members
    .map((id) => byId.get(id))
    .find((attempt) => attempt?.run?.state === 'error')
  const error = failed?.run?.outputs.find((o) => o.kind === 'error')
  return error
    ? `${word}: ${error.ename}${error.evalue ? ` — ${clipLine(error.evalue, 120)}` : ''}`
    : word
}

function people(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} человек`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} человека`
  return `${n} человек`
}

const SYSTEM = [
  'Ты помогаешь преподавателю разобрать решения студентов прямо на занятии.',
  'Тебе дано задание (текст ячейки тетради), контекст вокруг него и группы',
  'одинаковых решений: у каждой — номер G1…GN, число людей, состояние запуска',
  'и код одного представителя. Имён нет и не нужно — не выдумывай их.',
  '',
  'Ответь СТРОГО одним JSON-объектом без слов до и после него и без пояснений:',
  '{',
  '  "summary": [три абзаца строками: 1) что в решениях верно; 2) типичная ошибка',
  '              и в каких группах она; 3) что показать классу и почему],',
  '  "groupLabels": {"G1": "имя группы одной короткой строкой, до 40 знаков", …} — для КАЖДОЙ группы,',
  '  "drafts": {"G2": "черновик ответа группе с ошибкой: 2–4 предложения, на «вы»,',
  '             без имён, указать на ошибку, не решать за них"} — ТОЛЬКО для групп с ошибкой,',
  '  "notable": [{"key": "G3", "why": "чем примечательно это решение"}] — до трёх, можно пусто',
  '}',
  'Пиши по-русски. Абзацы summary короткие: преподаватель читает их с пульта во время пары.',
].join('\n')

/**
 * Кадр для модели: задание, контекст, группы. Возвращает и `keys` — какой ключ
 * группы стоит за каждым G-номером: по ним разбор ответа вернёт имена и
 * черновики к настоящим группам.
 *
 * Бюджет — `contextChars` инстанса, как у обычного вопроса: преподаватель,
 * опустивший его под маленькую модель, ждёт, что и сводка в него уложится.
 * Большие группы едут первыми целиком; маленькие, которым не хватило места,
 * складываются в одну строку счётом — модель должна знать, что они есть.
 */
export function oraclePrompt(
  task: OracleTask,
  groups: readonly CouncilGroup[],
  attempts: readonly OracleAttempt[],
  budget: number = getOracleSettings().contextChars,
): { turns: ChatTurn[]; keys: string[] } {
  const byId = new Map(attempts.map((a) => [a.participantId, a] as const))
  const head: string[] = []
  if (task.before) {
    head.push('КОНТЕКСТ (ячейка над заданием):', clip(task.before, MAX_TASK_SOURCE), '')
  }
  head.push('ЗАДАНИЕ (текст общей ячейки):', '```', clip(task.source, MAX_TASK_SOURCE), '```', '')
  if (task.reference) {
    head.push(
      'ЭТАЛОННОЕ РЕШЕНИЕ преподавателя:',
      '```python',
      clip(task.reference, MAX_TASK_SOURCE),
      '```',
      '',
    )
  }
  const total = groups.reduce((n, g) => n + g.count, 0)
  head.push(
    `РЕШЕНИЯ: ${people(total)} сдали, ${groups.length} ${groupsWord(groups.length)} одинаковых решений.`,
    '',
  )

  const keys: string[] = []
  const blocks: string[] = []
  let used = SYSTEM.length + head.join('\n').length
  let hidden = 0
  let hiddenPeople = 0
  for (const group of groups) {
    const no = `G${keys.length + 1}`
    const block = [
      `### ${no} — ${people(group.count)}, ${statusLine(group, byId)}`,
      '```python',
      clip(group.sample.trim() || '(пусто)', MAX_GROUP_SOURCE),
      '```',
    ].join('\n')
    // Хотя бы одна группа едет всегда: сводка без единого решения — это не
    // сводка, а бюджет, который меньше одного листа, поставлен по ошибке.
    if (keys.length > 0 && used + block.length > budget) {
      hidden++
      hiddenPeople += group.count
      continue
    }
    keys.push(group.key)
    blocks.push(block)
    used += block.length + 2
  }
  if (hidden > 0) {
    blocks.push(
      `Ещё ${hidden} ${groupsWord(hidden)} (${people(hiddenPeople)}) — маленькие, в кадр не поместились.`,
    )
  }
  const turns: ChatTurn[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [...head, ...blocks].join('\n') },
  ]
  return { turns, keys }
}

function groupsWord(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'группа'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'группы'
  return 'групп'
}

/** Голова и хвост: в хвосте кода — возврат, в хвосте условия — вопрос. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.ceil(limit * 0.7)
  const tail = limit - head
  return `${text.slice(0, head).trimEnd()}\n… пропущено ${text.length - limit} знаков …\n${text.slice(text.length - tail).trimStart()}`
}

function clipLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…'
}

/* ----------------------------------------------------------------- разбор */

/** Что удалось вычитать из ответа модели — уже по настоящим ключам групп. */
export interface ParsedOracle {
  summary: string[]
  groupLabels: Record<string, string>
  drafts: Record<string, string>
  notable: { key: string; why: string }[]
}

/**
 * Разобрать ответ, чем бы он ни оказался.
 *
 * Хорошая модель отдаёт JSON; средняя — JSON в ```json-ограде с абзацем
 * «вот ваш ответ» перед ним; плохая — три абзаца прозы. Все три случая дают
 * сводку: из прозы — абзацами, до трёх. Имена и черновики — только из JSON:
 * угадывать их из текста значило бы приписать группе чужую строку.
 *
 * Ключи модели — G-номера, `keys[i]` говорит, чей это ключ. Номер, которого
 * в кадре не было, отбрасывается: модель их иногда досочиняет.
 */
export function parseOracleAnswer(text: string, keys: readonly string[]): ParsedOracle {
  const empty: ParsedOracle = { summary: [], groupLabels: {}, drafts: {}, notable: [] }
  const raw = extractJson(text)
  if (!raw || typeof raw !== 'object') {
    return { ...empty, summary: paragraphsOf(text) }
  }
  const obj = raw as Record<string, unknown>
  const summary = stringsOf(obj.summary)
  const groupLabels: Record<string, string> = {}
  for (const [no, label] of entriesOf(obj.groupLabels)) {
    const key = keyFor(no, keys)
    if (key !== null && label) groupLabels[key] = clipLine(label, MAX_LABEL)
  }
  const drafts: Record<string, string> = {}
  for (const [no, draft] of entriesOf(obj.drafts)) {
    const key = keyFor(no, keys)
    if (key !== null && draft) drafts[key] = draft.trim()
  }
  const notable: { key: string; why: string }[] = []
  if (Array.isArray(obj.notable)) {
    for (const item of obj.notable) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      const no =
        typeof entry.key === 'string'
          ? entry.key
          : typeof entry.group === 'string'
            ? entry.group
            : ''
      const key = keyFor(no, keys)
      const why = typeof entry.why === 'string' ? entry.why.trim() : ''
      if (key !== null && why && !notable.some((n) => n.key === key)) notable.push({ key, why })
      if (notable.length >= MAX_NOTABLE) break
    }
  }
  return {
    // JSON без сводки — редкость, но лучше проза целиком, чем пустые абзацы.
    summary: summary.length > 0 ? summary : paragraphsOf(text),
    groupLabels,
    drafts,
    notable,
  }
}

/** «G3», «g3», « G3 », «3» и сам ключ группы — всё это третья группа. */
function keyFor(no: string, keys: readonly string[]): string | null {
  const flat = no.trim()
  if (keys.includes(flat)) return flat
  const m = /^g?\s*(\d+)$/i.exec(flat)
  if (!m) return null
  const index = Number(m[1]) - 1
  return index >= 0 && index < keys.length ? keys[index] : null
}

function entriesOf(value: unknown): [string, string][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out.push([k, v])
  }
  return out
}

/** Массив строк — до трёх; одна строка — тоже сводка; что угодно ещё — ничего. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return paragraphsOf(value)
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 3)
}

/** Абзацы прозы — до трёх; без пустых строк делится по строкам. */
function paragraphsOf(text: string): string[] {
  const cleaned = text.replace(/```[a-z]*\n?|```/gi, '').trim()
  if (!cleaned) return []
  const byBlank = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const parts =
    byBlank.length > 1
      ? byBlank
      : cleaned
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean)
  return parts.slice(0, 3)
}

/**
 * Найти JSON в ответе: сначала внутри ```-ограды, потом от первой `{` до
 * последней `}`. Оба разбора могут не сойтись — тогда `null`, и сводка идёт
 * из текста.
 */
function extractJson(text: string): unknown {
  const candidates: string[] = []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced) candidates.push(fenced[1])
  const from = text.indexOf('{')
  const to = text.lastIndexOf('}')
  if (from >= 0 && to > from) candidates.push(text.slice(from, to + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* следующий кандидат */
    }
  }
  return null
}

/* -------------------------------------------------------------- состояние */

export function idleOracle(): CouncilOracle {
  return {
    state: 'idle',
    askedAt: null,
    basedOn: 0,
    staleBy: 0,
    summary: [],
    groupLabels: {},
    drafts: {},
    notable: [],
    error: null,
  }
}

type OracleListener = (sessionId: string, cellId: string, oracle: CouncilOracle) => void

let listener: OracleListener | null = null

/**
 * Кому сказать, что оракул сменил состояние. Регистрирует control.ts — у него
 * сокеты преподавателей; импорт control.ts отсюда замкнул бы модули друг на
 * друга, ровно как onRefusal в collab/index.ts.
 */
export function onCouncilOracle(next: OracleListener): void {
  listener = next
}

function announce(sessionId: string, cellId: string, oracle: CouncilOracle): void {
  listener?.(sessionId, cellId, oracle)
}

/** Ключ — `${sessionId}:${cellId}`; запись есть только пока модель читает. */
const reading = new Map<string, AbortController>()

export function isOracleReading(sessionId: string, cellId: string): boolean {
  return reading.has(`${sessionId}:${cellId}`)
}

export interface AskCouncilOracle {
  sessionId: string
  cellId: string
  task: OracleTask
  attempts: readonly OracleAttempt[]
  store: OracleStore
  /** Строка расхода, заведённая маршрутом при приёме: токены лягут на неё. */
  usageId?: number
}

/**
 * Спросить. Возвращает состояние «читает» сразу — 202 отдаётся им; ответ
 * приезжает потом через `onCouncilOracle`. Пока читает, прежние имена и
 * черновики остаются: чипы на пульте не должны моргать на время вопроса.
 */
export function askCouncilOracle(input: AskCouncilOracle): CouncilOracle {
  const { sessionId, cellId, store } = input
  const key = `${sessionId}:${cellId}`
  const previous = store.oracleOf(sessionId, cellId) ?? idleOracle()
  const groups = groupsOf(input.attempts)
  const now = Date.now()
  const started: CouncilOracle = {
    ...previous,
    state: 'reading',
    askedAt: now,
    basedOn: groups.reduce((n, g) => n + g.count, 0),
    staleBy: 0,
    error: null,
  }
  store.setOracle(sessionId, cellId, started)
  announce(sessionId, cellId, started)

  const controller = new AbortController()
  reading.set(key, controller)
  void read(input, groups, previous, controller).finally(() => {
    if (reading.get(key) === controller) reading.delete(key)
  })
  return started
}

async function read(
  input: AskCouncilOracle,
  groups: CouncilGroup[],
  previous: CouncilOracle,
  controller: AbortController,
): Promise<void> {
  const { sessionId, cellId, store } = input
  const settle = (oracle: CouncilOracle) => {
    store.setOracle(sessionId, cellId, oracle)
    announce(sessionId, cellId, oracle)
  }
  /*
   * Не вышло — вернуть то, что было: прежняя сводка (если была) с причиной
   * рядом, а не пустота. Преподаватель, нажавший «Обновить» и получивший
   * ошибку сети, не должен потерять три абзаца, которые читал минуту назад.
   */
  const giveBack = (error: string | null) =>
    settle(
      previous.state === 'ready' || previous.state === 'stale'
        ? { ...previous, state: 'ready', error }
        : { ...idleOracle(), error },
    )

  try {
    const { turns, keys } = oraclePrompt(input.task, groups, input.attempts)
    const text = await streamChat(
      turns,
      () => {},
      controller.signal,
      (tokens) => {
        if (input.usageId !== undefined) noteTokens(input.usageId, tokens)
      },
    )
    if (controller.signal.aborted) {
      giveBack(null)
      return
    }
    if (!text.trim()) {
      giveBack('Модель ответила пустым — попробуйте ещё раз.')
      return
    }
    const parsed = parseOracleAnswer(text, keys)
    const representative = new Map(groups.map((g) => [g.key, g.representative] as const))
    settle({
      state: 'ready',
      askedAt: Date.now(),
      basedOn: groups.reduce((n, g) => n + g.count, 0),
      staleBy: 0,
      summary: parsed.summary,
      groupLabels: parsed.groupLabels,
      // Черновик группе, которую преподаватель уже отметил верной, — лишний.
      drafts: Object.fromEntries(
        Object.entries(parsed.drafts).filter(
          ([key]) => groups.find((g) => g.key === key)?.status !== 'correct',
        ),
      ),
      notable: parsed.notable
        .map(({ key, why }) => ({ participantId: representative.get(key) ?? '', why }))
        .filter((n) => n.participantId),
      error: null,
    })
  } catch (err) {
    if (controller.signal.aborted) {
      giveBack(null)
      return
    }
    const reason = err instanceof Error ? err.message.trim() : String(err)
    console.error(`[session ${sessionId}] council oracle failed:`, reason)
    giveBack(reason || 'Оракул не ответил — смотрите журнал сервера.')
  }
}

/** «Стоп»: оборвать чтение. `false` — читать было нечего. */
export function stopCouncilOracle(sessionId: string, cellId: string): boolean {
  const controller = reading.get(`${sessionId}:${cellId}`)
  if (!controller) return false
  controller.abort()
  return true
}

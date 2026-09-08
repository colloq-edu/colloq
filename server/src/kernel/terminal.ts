import { createHash } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import {
  createTerminalLine,
  getMeta,
  getTerminal,
  terminalText,
  type YTerminalLine,
} from '@shared/notebook'
import { plural } from '@shared/plural'
import { getSessionDoc } from '../collab/index.js'
import { sessionEnvironment } from '../db.js'
import { kernelCwd, sessionDir } from '../workspace.js'
import { defaultEndpoint, type KernelEndpoint } from './jupyter.js'
import { endpointForSession, forgetSessionKernel } from './pool.js'

/**
 * One shared terminal per seminar, in the same container as the kernel.
 *
 * The terminal is shared for the same reason the kernel is: `pip install pandas`
 * changes what every cell in the room can import, so showing it to one person
 * would be a lie. The transcript therefore lives in the session document — each
 * command carries the name of whoever typed it, and the room watches the output
 * arrive through the same CRDT that already carries cell outputs.
 *
 * One shell also means one command at a time. A command typed while another is
 * running waits its turn here rather than being pushed at a shell that would
 * buffer it and echo it back later — that produced a transcript where one
 * person's output printed under another person's command line.
 *
 * Deliberate scope: this is a line-oriented transcript, not a VT emulator. It
 * understands the escapes that ordinary command output actually uses — colours
 * (dropped), carriage-return redraws (collapsed to the line's final state),
 * erase-in-line, horizontal cursor moves — and refuses the rest. A program that
 * paints a whole screen (vim, top) gets one honest sentence instead of a page of
 * garbage, because nothing sensible can be shown in an append-only transcript
 * that ten people are reading at their own pace.
 */

export type TerminalPhase = 'closed' | 'starting' | 'idle' | 'busy' | 'dead'

/** Marks every write this module makes to a session document. */
const ORIGIN = 'terminal'

const ESC = '\u001b'
const BEL = '\u0007'
const DEL = '\u007f'
/** Ctrl-C: the only control code this module ever sends. */
const ETX = '\u0003'

/** Coalescing window: one CRDT update per window, never one per pty chunk. */
const FLUSH_MS = 60
/** Silence this long is the first half of "the command finished". */
const QUIET_MS = 400
/** After connecting, the shell's banner stops arriving this long after it starts. */
const PRIME_QUIET_MS = 350
const PRIME_MAX_MS = 4000
const CONNECT_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 15_000
/** Six, on the same backoff: ~20s. A shell is cheaper to reopen than a kernel. */
const MAX_RECONNECT_ATTEMPTS = 6

/** A document everyone syncs cannot grow without bound. */
const MAX_TRANSCRIPT_LINES = 800
const MAX_TRANSCRIPT_CHARS = 200 * 1024
/** Rolling over to a new entry is what lets the front-trim actually free anything. */
const MAX_ENTRY_CHARS = 32 * 1024
/** An unbroken line has to end somewhere; minified JSON is the usual culprit. */
const MAX_PARTIAL_CHARS = 4096
/**
 * Сколько вывода уезжает в документ за одно окно склейки.
 *
 * У ячейки ядра потолок на выполнение есть, у терминала не было ничего: `cat`
 * стомегабайтного файла вливал в CRDT по мегабайту-другому каждые 60 мс, и это
 * рассылалось всем тридцати вкладкам — вместе с тетрадью, которая живёт в том
 * же документе. Оставляем хвост окна: транскрипт и так хвост, а нужное почти
 * всегда в последних строках — «successfully installed» приходит после
 * километра прогресса.
 */
const MAX_FLUSH_CHARS = 64 * 1024
/*
 * Строки расшифровки — на языке комнаты.
 *
 * Их печатает сервер, а читают их в том же ящике, где вкладки «Терминал /
 * Журнал ядра / История», приглашение «оболочка запускается…» и кнопки
 * «Очистить» и «Завести оболочку заново». Английская половина стояла вплотную к
 * русской, в одной строке с ней, и звала кнопки чужими именами — «Press Stop»,
 * «with Clear». Кнопку называем так, как она подписана в ящике; там, где кнопки
 * нет (остановить команду можно только Ctrl+C), называем клавишу, а не
 * выдуманную кнопку.
 *
 * Имя человека ставится отдельным подлежащим — «Мария — команда снята», а не
 * «Мария сняла»: имена приходят любые, в том числе «оракул» (ai/agent.ts ·
 * runInRoom), рода их мы не знаем, а «нажал(а)» в общей расшифровке читается
 * как черновик.
 */
const FLOOD_NOTICE =
  '[colloq] Превышена скорость обновления вывода. В общей расшифровке ' +
  'остаются только последние строки. Для полного вывода перенаправьте его в файл.'
/** Never trim away the command that is producing output right now. */
const MIN_KEPT_ENTRIES = 2
const MAX_COMMAND_BYTES = 4096
/** An escape split across chunks is normal; one this long is not an escape. */
const MAX_PENDING_ESC = 128

/*
 * The shell's own idea of its size, which everyone in the room then reads.
 *
 * A pty has one geometry and the transcript has many readers, so this cannot
 * follow anybody's window. 120 columns is wide enough that `pip` and `ls -l`
 * do not wrap into nonsense, and narrow enough to still fit the drawer on a
 * laptop; 40 rows is what `less` and friends page against.
 */
const TERM_ROWS = 40
const TERM_COLS = 120

const SCREEN_NOTICE =
  '[colloq] Полноэкранные программы (vim, top и другие) отображаются некорректно: терминал поддерживает только построчный вывод. Попробуйте прервать команду через Ctrl+C.'
const CLEAR_NOTICE =
  '[colloq] очистка экрана здесь ничего не меняет: расшифровка общая. Стереть её может преподаватель — кнопкой «Очистить».'

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
}

/** Mirrors the CRDT array entry-for-entry, so trimming needs no full walk. */
interface LedgerEntry {
  id: string
  chars: number
  lines: number
}

/** Who typed a command; the transcript puts a face and a name against it. */
interface Sender {
  name: string
  color: string
  participantId: string
}

interface Term {
  sessionId: string
  /**
   * Which Jupyter this room's shell lives in.
   *
   * A property of the room, not of the process — the same rule the kernel
   * follows, and for the same reason. A seminar on its own environment runs in
   * its own container, and a terminal that went to the instance-wide address
   * instead put `pip install` into a container the room's Python never sees:
   * the command succeeded, said so, and changed nothing that any cell could
   * import.
   *
   * Resolved when the terminal opens and kept for its life, so a reconnect
   * returns to the same pty rather than hunting for it in a second container.
   */
  endpoint: KernelEndpoint
  /** Jupyter's terminal name ("1"); null when nothing is allocated. */
  name: string | null
  socket: WebSocket | null
  phase: TerminalPhase
  opening: Promise<void> | null
  /** Set while we tear down on purpose, so the socket does not reconnect. */
  closing: boolean
  /** False until the shell's banner and terminado's replayed scrollback are behind us. */
  primed: boolean
  primeDeadline: number
  waiters: Waiter[]
  queued: string[]
  /**
   * Commands typed while the shell was busy, in the order they were typed.
   *
   * `queued` above is bytes on their way to the pty; this is whole commands
   * that have not been sent at all yet. They are held rather than pushed
   * because a shell buffers what it cannot run and echoes it later, in its own
   * time: two people typing in one shell produced a transcript where somebody's
   * output landed under somebody else's command line, and the second command
   * appeared twice — once as we wrote it, once as the shell echoed it back.
   */
  pending: Array<{ text: string; by: Sender; done?: Done }>
  /**
   * Кому сказать, что команда кончилась, — если её ждут.
   *
   * Ждёт её сейчас ровно один: оракул в режиме «сделать». Человек за клавиатурой
   * видит вывод и так, а агенту надо на него посмотреть, чтобы решить, что
   * делать дальше, — иначе он «запускает» вслепую и рассказывает про результат,
   * которого не видел.
   */
  runningDone: Done | null
  /**
   * Who typed the command the shell is running now, or null between commands.
   *
   * Ctrl+C throws away everything queued, including other people's, so the
   * same rule the kernel's interrupt uses applies here: the host, or whoever's
   * command is actually running.
   */
  runningBy: string | null
  reconnectAttempts: number
  flushTimer: NodeJS.Timeout | null
  quietTimer: NodeJS.Timeout | null
  primeTimer: NodeJS.Timeout | null
  reconnectTimer: NodeJS.Timeout | null
  /** Raw pty text not yet parsed (may end mid-escape). */
  raw: string
  /** The line being drawn: \r and cursor moves rewrite it in place. */
  partial: string
  col: number
  /** How much of `partial` is currently written at the end of the output entry. */
  tailLen: number
  skipEcho: string | null
  screenApp: boolean
  clearNoticed: boolean
  /** Сказали ли уже про потоп в этой команде; см. MAX_FLUSH_CHARS. */
  flooded: boolean
  /** id строки, которая в документе помечена «идёт», а живой у нас нет; см. resumeCommand. */
  resumable: string | null
  /**
   * Спросить оболочку, свободна ли она, как только кончится прайм.
   *
   * Ставится ровно в одном случае: мы вернулись к pty, пережившему перезапуск
   * сервера, и подняли из транскрипта команду, помеченную «идёт». Идёт она или
   * кончилась, пока сервера не было, знает только сама оболочка — и отвечает
   * единственным доступным ей способом: свободная печатает приглашение, занятая
   * молчит. См. `probeShell`.
   */
  probe: boolean
  commandLine: YTerminalLine | null
  commandLineId: string | null
  outputLine: YTerminalLine | null
  outputLineId: string | null
  outChars: number
  outLines: number
  ledger: LedgerEntry[]
  chars: number
  lines: number
}

const terms = new Map<string, Term>()
const phaseListeners: Array<(sessionId: string, phase: TerminalPhase) => void> = []

function getTerm(sessionId: string): Term {
  let term = terms.get(sessionId)
  if (!term) {
    term = {
      sessionId,
      runningBy: null,
      // Заглушка до открытия: настоящий адрес спрашивается у окружения комнаты
      // в openTerminal, где уже можно ждать поднятия контейнера.
      endpoint: defaultEndpoint(),
      name: null,
      socket: null,
      phase: 'closed',
      opening: null,
      closing: false,
      primed: false,
      primeDeadline: 0,
      waiters: [],
      queued: [],
      pending: [],
      runningDone: null,
      reconnectAttempts: 0,
      flushTimer: null,
      quietTimer: null,
      primeTimer: null,
      reconnectTimer: null,
      raw: '',
      partial: '',
      col: 0,
      tailLen: 0,
      skipEcho: null,
      screenApp: false,
      clearNoticed: false,
      flooded: false,
      resumable: null,
      probe: false,
      commandLine: null,
      commandLineId: null,
      outputLine: null,
      outputLineId: null,
      outChars: 0,
      outLines: 0,
      ledger: [],
      chars: 0,
      lines: 0,
    }
    terms.set(sessionId, term)
  }
  return term
}

const docOf = (term: Term) => getSessionDoc(term.sessionId).doc

/**
 * Имя pty, пережившее перезапуск сервера, — в документе комнаты.
 *
 * `shutdownKernels` намеренно отпускает ядро, чтобы `make run` после правки не
 * стоил семинару состояния; терминал в том же сценарии удалял pty, и
 * трёхчасовое обучение, запущенное в оболочке, погибало вместе с ним — без
 * единой строки в транскрипте. Контейнер теперь на комнату и живёт дальше, так
 * что pty переживает нас так же, как ядро, — нужно только помнить, как его
 * звали. Адрес рядом с именем не для красоты: pty с именем «1» есть в каждом
 * контейнере, и вернуться по нему не в тот — значит привести комнату в чужую
 * оболочку.
 */
const PTY_KEY = 'terminalPty'

/**
 * Адрес — отпечатком, а не строкой: документ читает вся комната, а внутренний
 * адрес контейнера ей знать незачем. Сравнивать отпечатки для «тот же ли это
 * контейнер» достаточно.
 */
const ptyHome = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 12)

function rememberPty(term: Term): void {
  const doc = docOf(term)
  const value = term.name ? `${ptyHome(term.endpoint.url)}\n${term.name}` : null
  const meta = getMeta(doc)
  if ((meta.get(PTY_KEY) ?? null) === value) return
  doc.transact(() => meta.set(PTY_KEY, value), ORIGIN)
}

/** Имя pty, если оно от того же адреса, к которому мы идём сейчас. */
function rememberedPty(term: Term, url: string): string | null {
  const saved = getMeta(docOf(term)).get(PTY_KEY)
  if (typeof saved !== 'string') return null
  const at = saved.indexOf('\n')
  if (at < 0) return null
  return saved.slice(0, at) === ptyHome(url) ? saved.slice(at + 1) || null : null
}

/* ------------------------------------------------------------------ phase */

function setPhase(term: Term, phase: TerminalPhase): void {
  if (term.phase === phase) return
  term.phase = phase
  for (const cb of [...phaseListeners]) {
    try {
      cb(term.sessionId, phase)
    } catch (err) {
      console.error(`[terminal] phase listener failed for ${term.sessionId}:`, errText(err))
    }
  }
}

export function onTerminalPhase(cb: (sessionId: string, phase: TerminalPhase) => void): void {
  phaseListeners.push(cb)
}

export function terminalPhase(sessionId: string): TerminalPhase {
  return terms.get(sessionId)?.phase ?? 'closed'
}

/* ------------------------------------------------------------- transcript */

function countLines(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++
  return n
}

function lineId(line: YTerminalLine): string {
  return (line.get('id') as string) ?? ''
}

/**
 * Adopt whatever the persisted document already holds. A server restart brings
 * back the transcript but not the shell, so a command still marked `running` is
 * a claim we can no longer stand behind.
 *
 * Своя живая команда — исключение, и это не мелочь.
 *
 * Пересчёт запускает не только открытие терминала: в тот же массив пишет
 * заметки ядра (kernel/index.ts), и любая из них сбивает выравнивание, после
 * чего `ensureAligned` зовёт нас посреди работающей команды. Обнуляя здесь
 * `commandLine`, мы объявляли `python train.py` законченным — точка и счётчик
 * гасли, охрана «одна команда за раз» переставала держать, и следующая команда
 * уходила прямо в занятую оболочку. Тем же путём ломалась первая команда в
 * ещё не открытый терминал: `openTerminal` усыновлял транскрипт сразу после
 * того, как строка команды в него легла.
 *
 * Поэтому живые строки ищутся по id и остаются собой: их учёт (`tailLen`,
 * `outChars`) продолжает описывать те же самые записи в документе.
 */
function adoptTranscript(term: Term): void {
  const doc = docOf(term)
  const array = getTerminal(doc)
  const liveCommandId = term.commandLineId
  const liveOutputId = term.outputLineId
  term.ledger = []
  term.chars = 0
  term.lines = 0
  let command: YTerminalLine | null = null
  let output: YTerminalLine | null = null
  let outputChars = 0
  let outputLines = 0
  // Массив, а не переменная: присваивание идёт из замыкания транзакции, и
  // сузить тип обратно компилятор оттуда уже не может.
  const resumable: Array<{ id: string; kind: string }> = []
  doc.transact(() => {
    for (const line of array.toArray()) {
      const text = terminalText(line).toString()
      const entry: LedgerEntry = {
        id: lineId(line),
        chars: text.length,
        lines: countLines(text) + 1,
      }
      term.ledger.push(entry)
      term.chars += entry.chars
      term.lines += entry.lines
      if (liveCommandId !== null && entry.id === liveCommandId) {
        command = line
        continue
      }
      if (liveOutputId !== null && entry.id === liveOutputId) {
        output = line
        outputChars = entry.chars
        outputLines = entry.lines
        continue
      }
      if (line.get('running') === true) {
        /*
         * Кто ПОСЛЕДНИМ утверждал, что он идёт, — на случай, что это правда.
         *
         * Флаг мы гасим: без оболочки за ним стоять некому. Но если через
         * секунду выяснится, что pty пережил перезапуск сервера, эта строка —
         * единственный след команды, которая всё ещё работает внутри, и
         * `resumeCommand` поднимет её обратно. Живой она станет только тогда.
         */
        resumable.push({ id: entry.id, kind: String(line.get('kind') ?? '') })
        line.set('running', false)
      }
    }
  }, ORIGIN)
  term.commandLine = command
  term.commandLineId = command === null ? null : liveCommandId
  term.outputLine = output
  term.outputLineId = output === null ? null : liveOutputId
  term.outChars = output === null ? 0 : outputChars
  term.outLines = output === null ? 0 : outputLines
  if (output === null) term.tailLen = 0
  /*
   * Найденное запоминается, ненайденное — не стирает найденного раньше.
   *
   * Усыновление бывает не одно: любая заметка ядра сбивает выравнивание, и
   * `ensureAligned` зовёт нас снова — уже по транскрипту, где флаги «идёт» мы
   * сами и погасили. Обнуляя здесь, мы теряли бы след живой команды из-за
   * одной системной строки между открытием терминала и подключением к нему.
   */
  const last = resumable[resumable.length - 1]
  if (command !== null) term.resumable = null
  else if (last?.kind === 'command') term.resumable = last.id
}

/**
 * Поднять обратно команду, которая, судя по транскрипту, всё ещё идёт.
 *
 * Зовётся ровно в одном месте — когда мы вернулись к pty, пережившему
 * перезапуск сервера. Без этого охрана «одна команда за раз» после перезапуска
 * не держит вовсе: `commandLine` пуст, фаза `idle`, и первый же набравший `ls`
 * отправляет его в оболочку, где идёт чужое обучение.
 */
function resumeCommand(term: Term): boolean {
  const id = term.resumable
  term.resumable = null
  if (!id) return false
  const doc = docOf(term)
  const line = getTerminal(doc)
    .toArray()
    .find((entry) => lineId(entry) === id)
  if (!line) return false
  doc.transact(() => line.set('running', true), ORIGIN)
  term.commandLine = line
  term.commandLineId = id
  term.runningBy = (line.get('participantId') as string | null) ?? null
  return true
}

function syncLedger(term: Term, id: string, chars: number, lines: number): void {
  for (let i = term.ledger.length - 1; i >= 0; i--) {
    const entry = term.ledger[i]
    if (entry.id !== id) continue
    term.chars += chars - entry.chars
    term.lines += lines - entry.lines
    entry.chars = chars
    entry.lines = lines
    return
  }
}

/** The ledger is index-aligned with the array; if that ever slips, rebuild it. */
function ensureAligned(term: Term): void {
  if (getTerminal(docOf(term)).length !== term.ledger.length) adoptTranscript(term)
}

function forgetEntry(term: Term, id: string): void {
  if (term.outputLineId === id) {
    term.outputLine = null
    term.outputLineId = null
    term.tailLen = 0
    term.outChars = 0
    term.outLines = 0
  }
  if (term.commandLineId === id) {
    term.commandLine = null
    term.commandLineId = null
  }
}

/**
 * Oldest-first eviction: a seminar terminal is a tail, not an archive.
 *
 * Строка ИДУЩЕЙ команды не выбрасывается никогда — и это не украшение
 * транскрипта, а вся охрана «одна команда за раз».
 *
 * Она самая старая запись из живых, потому что вывод перекатывается в новые
 * записи каждые 32 КБ, — и вылетала первой. `forgetEntry` обнулял вместе с ней
 * `commandLine`, а именно по нему `runCommand` меряет занятость: следующий
 * набравший `ls` отправлял его прямо в stdin занятой оболочки — его байты
 * доставались `train.py`, чужой вывод печатался под его строкой, эхо двоилось,
 * и никакого «X's command is waiting for the shell» никто не видел. Хватало
 * восьмисот строк вывода, то есть одной `find /`. `MIN_KEPT_ENTRIES` обещал
 * ровно это и не выполнял: он считает записи, а не смотрит, что это за запись.
 *
 * Поэтому теперь выбрасывается не «первые N», а первые N, КРОМЕ этой одной, —
 * ценой удаления по индексам вместо одного среза с головы.
 */
function trim(term: Term): void {
  if (term.chars <= MAX_TRANSCRIPT_CHARS && term.lines <= MAX_TRANSCRIPT_LINES) return
  ensureAligned(term)
  const drop: number[] = []
  let kept = term.ledger.length
  for (let i = 0; i < term.ledger.length; i++) {
    if (kept <= MIN_KEPT_ENTRIES) break
    if (term.chars <= MAX_TRANSCRIPT_CHARS && term.lines <= MAX_TRANSCRIPT_LINES) break
    const entry = term.ledger[i]
    if (entry.id === term.commandLineId) continue
    term.chars -= entry.chars
    term.lines -= entry.lines
    drop.push(i)
    kept--
  }
  if (drop.length === 0) return
  const removed = drop.map((index) => term.ledger[index])
  const doc = docOf(term)
  const array = getTerminal(doc)
  // С конца — иначе каждое удаление сдвигало бы индексы следующих.
  doc.transact(() => {
    for (let i = drop.length - 1; i >= 0; i--) array.delete(drop[i], 1)
  }, ORIGIN)
  for (let i = drop.length - 1; i >= 0; i--) term.ledger.splice(drop[i], 1)
  for (const entry of removed) forgetEntry(term, entry.id)
}

function appendEntry(term: Term, line: YTerminalLine, chars: number, lines: number): void {
  const doc = docOf(term)
  ensureAligned(term)
  doc.transact(() => getTerminal(doc).push([line]), ORIGIN)
  term.ledger.push({ id: lineId(line), chars, lines })
  term.chars += chars
  term.lines += lines
  trim(term)
}

function removeEntry(term: Term, id: string): void {
  ensureAligned(term)
  const index = term.ledger.findIndex((entry) => entry.id === id)
  if (index < 0) return
  const entry = term.ledger[index]
  term.chars -= entry.chars
  term.lines -= entry.lines
  term.ledger.splice(index, 1)
  const doc = docOf(term)
  doc.transact(() => getTerminal(doc).delete(index, 1), ORIGIN)
  forgetEntry(term, id)
}

function systemLine(term: Term, text: string): void {
  appendEntry(term, createTerminalLine({ kind: 'system', text }), text.length, countLines(text) + 1)
}

/** «снято 2 команды», «снято 5 команд» — числительное общее, из shared. */
const commandWord = (n: number) => plural(n, 'команда', 'команды', 'команд')

/**
 * Stop appending to the current output entry, taking the in-progress tail back
 * out of the document first. Whatever is still in `partial` gets re-rendered
 * into the next entry, so nothing is duplicated and nothing is lost.
 */
function detachOutput(term: Term): void {
  const line = term.outputLine
  const id = term.outputLineId
  const tail = term.tailLen
  term.outputLine = null
  term.outputLineId = null
  term.tailLen = 0
  const lines = term.outLines
  term.outChars = 0
  term.outLines = 0
  if (!line || !id) return

  const doc = docOf(term)
  const text = terminalText(line)
  if (tail > 0 && text.length >= tail) {
    doc.transact(() => text.delete(text.length - tail, tail), ORIGIN)
  }
  // `cd ..` leaves an entry holding nothing but the prompt we just removed.
  if (text.length === 0) removeEntry(term, id)
  else syncLedger(term, id, text.length, lines)
}

function ensureOutputLine(term: Term): YTerminalLine {
  if (term.outputLine && term.outChars <= MAX_ENTRY_CHARS) return term.outputLine
  if (term.outputLine) detachOutput(term)
  const line = createTerminalLine({ kind: 'output' })
  appendEntry(term, line, 0, 1)
  term.outputLine = line
  term.outputLineId = lineId(line)
  term.outChars = 0
  term.outLines = 1
  term.tailLen = 0
  return line
}

/**
 * One CRDT edit per flush window: completed lines are appended, and the tail —
 * the line still being drawn — is replaced. That replacement is what makes a
 * progress bar readable: the room sees its latest state, not every redraw.
 */
function writeOut(term: Term, committed: string): void {
  if (committed.length === 0 && term.partial.length === 0 && term.tailLen === 0) return
  const line = ensureOutputLine(term)
  const id = term.outputLineId
  if (!id) return
  const tail = term.tailLen
  const add = committed + term.partial
  const doc = docOf(term)
  const text = terminalText(line)
  doc.transact(() => {
    if (tail > 0 && text.length >= tail) text.delete(text.length - tail, tail)
    if (add.length > 0) text.insert(text.length, add)
  }, ORIGIN)
  term.tailLen = term.partial.length
  term.outChars = text.length
  term.outLines += countLines(committed)
  syncLedger(term, id, term.outChars, term.outLines)
  trim(term)
}

/* ------------------------------------------------------------ ansi policy */

interface Esc {
  end: number
  csi: boolean
  priv: boolean
  params: number[]
  final: string
}

type CsiEffect = 'none' | 'screen' | 'cleared'

const PARAM_CHARS = /[0-9;:]/
const PRIVATE_CHARS = /[<=>?]/

/** Returns null when the sequence is cut off by the end of the chunk. */
function parseEscape(input: string, start: number): Esc | null {
  const next = input[start + 1]
  if (next === undefined) return null

  if (next === '[') {
    let i = start + 2
    let priv = false
    let raw = ''
    while (i < input.length && (PARAM_CHARS.test(input[i]) || PRIVATE_CHARS.test(input[i]))) {
      if (PRIVATE_CHARS.test(input[i])) priv = true
      else raw += input[i]
      i++
    }
    while (i < input.length && input[i] >= ' ' && input[i] <= '/') i++
    if (i >= input.length) return null
    const params = raw.length === 0 ? [] : raw.split(/[;:]/).map((p) => Number.parseInt(p, 10) || 0)
    return { end: i + 1, csi: true, priv, params, final: input[i] }
  }

  // OSC/DCS/PM/APC: a string terminated by BEL or ESC \ — window titles, mostly.
  if (next === ']' || next === 'P' || next === '^' || next === '_') {
    let i = start + 2
    while (i < input.length) {
      if (input[i] === BEL) return { end: i + 1, csi: false, priv: false, params: [], final: next }
      if (input[i] === ESC) {
        if (i + 1 >= input.length) return null
        if (input[i + 1] === '\\') {
          return { end: i + 2, csi: false, priv: false, params: [], final: next }
        }
      }
      i++
    }
    return null
  }

  if (next === '(' || next === ')' || next === '*' || next === '+' || next === '#' || next === '%') {
    if (start + 2 >= input.length) return null
    return { end: start + 3, csi: false, priv: false, params: [], final: next }
  }

  return { end: start + 2, csi: false, priv: false, params: [], final: next }
}

function put(term: Term, ch: string): void {
  if (term.col < term.partial.length) {
    term.partial = term.partial.slice(0, term.col) + ch + term.partial.slice(term.col + 1)
  } else {
    if (term.col > term.partial.length) term.partial = term.partial.padEnd(term.col, ' ')
    term.partial += ch
  }
  term.col++
}

function applyCsi(term: Term, esc: Esc): CsiEffect {
  const p0 = esc.params.length > 0 ? esc.params[0] : 0
  switch (esc.final) {
    // Colours, styles, cursor visibility, device queries: the transcript styles itself.
    case 'm':
    case 'n':
    case 's':
    case 'u':
      return 'none'
    case 'h':
    case 'l':
      // The alternate screen buffer is a full-screen program announcing itself.
      return esc.priv && esc.params.some((p) => p === 47 || p === 1047 || p === 1049)
        ? 'screen'
        : 'none'
    case 'C':
      term.col += Math.max(1, p0)
      return 'none'
    case 'D':
      term.col = Math.max(0, term.col - Math.max(1, p0))
      return 'none'
    case 'G':
    case '`':
      term.col = Math.max(0, (p0 || 1) - 1)
      return 'none'
    case 'K':
      if (p0 === 2) term.partial = ''
      else if (p0 === 1) {
        term.partial =
          ' '.repeat(Math.min(term.col, term.partial.length)) + term.partial.slice(term.col)
      } else term.partial = term.partial.slice(0, term.col)
      return 'none'
    case 'J':
      if (p0 !== 2 && p0 !== 3) return 'none'
      // The screen is blank afterwards, so the line being drawn is gone too —
      // carrying it forward would paste pre-`clear` text into the next entry.
      term.partial = ''
      term.col = 0
      return 'cleared'
    case 'H':
    case 'f': {
      const row = esc.params.length > 0 ? esc.params[0] : 1
      const column = esc.params.length > 1 ? esc.params[1] : 1
      // Home on its own is what `clear` sends; anywhere else is a program painting.
      if (row > 1 || column > 1) return 'screen'
      term.partial = ''
      term.col = 0
      return 'cleared'
    }
    case 'A':
    case 'B':
    case 'S':
    case 'T':
    case 'L':
    case 'M':
    case 'd':
    case 'r':
      return 'screen'
    default:
      return 'none'
  }
}

function commitLine(term: Term, out: string[]): void {
  const line = term.partial
  term.partial = ''
  term.col = 0
  if (term.skipEcho !== null && line.trim().length > 0) {
    const echo = term.skipEcho.trim()
    term.skipEcho = null
    // The pty echoes what we typed; the command already has its own attributed line.
    if (echo.length > 0 && (line.trim() === echo || line.trimEnd().endsWith(echo))) return
  }
  out.push(line + '\n')
}

interface ScanResult {
  committed: string
  rest: string
  screen: boolean
  cleared: boolean
}

function scan(term: Term, input: string): ScanResult {
  const out: string[] = []
  let screen = false
  let cleared = false
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === ESC) {
      const esc = parseEscape(input, i)
      if (!esc) return { committed: out.join(''), rest: input.slice(i), screen, cleared }
      i = esc.end
      if (!esc.csi) continue
      const effect = applyCsi(term, esc)
      if (effect === 'screen') screen = true
      else if (effect === 'cleared') cleared = true
      continue
    }
    i++
    if (ch === '\n') {
      commitLine(term, out)
      continue
    }
    if (ch === '\r') {
      // The whole point of the line buffer: a redraw overwrites, it does not stack.
      term.col = 0
      continue
    }
    if (ch === '\b') {
      if (term.col > 0) term.col--
      continue
    }
    if (ch === '\t') {
      const stop = term.col + (8 - (term.col % 8))
      while (term.col < stop) put(term, ' ')
      continue
    }
    if (ch < ' ' || ch === DEL) continue
    put(term, ch)
    if (term.partial.length >= MAX_PARTIAL_CHARS) commitLine(term, out)
  }
  return { committed: out.join(''), rest: '', screen, cleared }
}

/* --------------------------------------------------------------- pipeline */

function frameText(data: RawData): string | null {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  try {
    return Buffer.from(data as ArrayBuffer).toString('utf8')
  } catch {
    return null
  }
}

function flush(term: Term): void {
  if (term.flushTimer) {
    clearTimeout(term.flushTimer)
    term.flushTimer = null
  }
  if (term.raw.length === 0) return
  const input = term.raw
  term.raw = ''
  // Priming: the login banner and terminado's replayed scrollback are not this
  // command's output, and the transcript already holds anything worth keeping.
  if (!term.primed) return

  const res = scan(term, input)
  // A held-back "escape" this long is really just text with a stray ESC in it.
  term.raw = res.rest.length > MAX_PENDING_ESC ? res.rest.slice(1) : res.rest

  if (res.screen && !term.screenApp) {
    term.screenApp = true
    detachOutput(term)
    systemLine(term, SCREEN_NOTICE)
  }
  if (term.screenApp) return

  if (res.cleared && !term.clearNoticed) {
    term.clearNoticed = true
    detachOutput(term)
    systemLine(term, CLEAR_NOTICE)
  }
  writeOut(term, budgeted(term, res.committed))
}

/** Оставить от окна только его хвост, сказав об этом один раз за команду. */
function budgeted(term: Term, committed: string): string {
  if (committed.length <= MAX_FLUSH_CHARS) return committed
  // По границе строки, если она рядом: обрубок посреди строки читается как
  // испорченный вывод, а не как срезанный.
  const cut = committed.indexOf('\n', committed.length - MAX_FLUSH_CHARS)
  const from = cut < 0 || cut + 1 >= committed.length ? committed.length - MAX_FLUSH_CHARS : cut + 1
  const tail = committed.slice(from)
  if (!term.flooded) {
    term.flooded = true
    detachOutput(term)
    systemLine(term, FLOOD_NOTICE)
  }
  return tail
}

/**
 * A shell prompt is the only signal a pty gives that a command is over, and it
 * is a guess: the prompt is just text. So both halves have to hold — output has
 * stopped for QUIET_MS *and* what is left on the line looks like a prompt. When
 * they do not, the command stays marked running, which is the honest answer for
 * `sleep 60` and anything else waiting on input.
 *
 * `>` в наборе — не просмотр, а решение.
 *
 * Комментарий выше говорил про `python` как про случай, который тут держится
 * «running», и это было неправдой: `>>> ` кончается на `>`, и REPL, запущенный
 * в общем шеле, считается закончившимся сразу. Считается — и хорошо: пока
 * команда «running», её вывод не отдают, а сидящий в python рассчитывает
 * увидеть свои строки. Без `>` REPL в общей оболочке был бы немым.
 *
 * Плата известная: строка, которая случайно кончилась на `>` посреди работы,
 * будет принята за приглашение. Она должна для этого ещё и провисеть QUIET_MS
 * молча, так что на практике это `>>> ` и `... `.
 *
 * `%` в конце строки — из-под zsh (его приглашение) и из индикаторов
 * выполнения, которые печатают проценты. Второе решается тем же молчанием:
 * индикатор, который двигается, не молчит.
 */
function promptLike(tail: string): boolean {
  if (tail.length === 0 || tail.length > 200) return false
  return /[$#%>❯]\s{0,2}$/.test(tail)
}

function onQuiet(term: Term): void {
  term.quietTimer = null
  flush(term)
  if (!promptLike(term.partial)) return
  finishCommand(term)
}

function armQuiet(term: Term): void {
  if (term.quietTimer) clearTimeout(term.quietTimer)
  term.quietTimer = setTimeout(() => onQuiet(term), QUIET_MS)
}

function finishCommand(term: Term): void {
  flush(term)
  /*
   * Вывод забирается ДО `detachOutput`: она отвязывает запись, и после неё
   * читать уже нечего. Тот, кто ждёт, получает ровно то, что увидела комната.
   */
  settleRun(term, true)
  // The prompt is the shell talking to itself; the transcript has its own frame.
  detachOutput(term)
  term.partial = ''
  term.col = 0
  term.skipEcho = null
  term.screenApp = false
  term.clearNoticed = false
  term.flooded = false
  clearRunning(term)
  setPhase(term, 'idle')
  startNextPending(term)
}

/**
 * Сказать ожидающему, чем кончилось, и забыть его.
 *
 * `finished: false` — команда не доработала: оболочка умерла, терминал закрыли,
 * процесс останавливают. Это не то же самое, что «команда кончилась с ошибкой»,
 * и агенту важно различать: во втором случае есть на что смотреть, в первом
 * смотреть не на что.
 */
function settleRun(term: Term, finished: boolean): void {
  const done = term.runningDone
  if (!done) return
  term.runningDone = null
  const line = term.outputLine
  let output = ''
  try {
    if (line) output = terminalText(line).toString()
  } catch {
    /* запись уже отвязали — вывода просто нет */
  }
  try {
    done({ output, finished })
  } catch (err) {
    console.error('[terminal] ожидающий команды упал:', errText(err))
  }
}

/**
 * Ожидающие команды, которые уже не побегут.
 *
 * Три места роняли очередь молча: смерть оболочки, отказ терминала и его
 * закрытие. `onShellExit` и `fail` при этом чистили только байты в полёте, а
 * `pending` оставляли — и первая же команда в заново открытом терминале
 * вытаскивала за собой `pip install`, поставленный в очередь десять минут и
 * одну оболочку назад. Здесь очередь и гаснет: тому, кто её ждал, отвечают
 * сразу, а комната узнаёт, чьи команды пропали.
 */
function dropPending(term: Term, why: string): void {
  if (term.pending.length === 0) return
  const dropped = term.pending.splice(0, term.pending.length)
  settlePending(dropped)
  systemLine(
    term,
    dropped.length === 1
      ? `[colloq] ${dropped[0].by.name} — команда снята из очереди: ${why}.`
      : `[colloq] из очереди снято ${dropped.length} ${commandWord(dropped.length)}: ${why}.`,
  )
}

/** Сказать тем, кто ждал снятые команды, что они не побегут. */
function settlePending(items: Array<{ done?: Done }>): void {
  for (const item of items) {
    if (!item.done) continue
    try {
      item.done({ output: '', finished: false })
    } catch (err) {
      console.error('[terminal] ожидающий команды упал:', errText(err))
    }
  }
}

function clearRunning(term: Term): void {
  const line = term.commandLine
  term.commandLine = null
  term.commandLineId = null
  if (!line) return
  const doc = docOf(term)
  if (line.get('running') === true) doc.transact(() => line.set('running', false), ORIGIN)
}

function onChunk(term: Term, chunk: string): void {
  if (!term.primed) {
    if (Date.now() >= term.primeDeadline) finishPrime(term)
    else armPrime(term)
    return
  }
  term.raw += chunk
  if (!term.flushTimer) {
    term.flushTimer = setTimeout(() => {
      term.flushTimer = null
      flush(term)
    }, FLUSH_MS)
  }
  armQuiet(term)
}

/* ----------------------------------------------------------------- socket */

function jupyterRequest(endpoint: KernelEndpoint, path: string, method: string) {
  return fetch(`${endpoint.url}${path}`, {
    method,
    headers: {
      Authorization: `token ${endpoint.token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

async function createJupyterTerminal(endpoint: KernelEndpoint): Promise<string> {
  const res = await jupyterRequest(endpoint, '/api/terminals', 'POST')
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Jupyter отверг учётные данные сервера (HTTP ${res.status}). JUPYTER_TOKEN должен совпадать с токеном, с которым поднят контейнер ядра.`,
      )
    }
    throw new Error(`Jupyter не завёл оболочку (HTTP ${res.status}).`)
  }
  const parsed = (await res.json()) as { name?: unknown }
  const name = parsed?.name
  if (typeof name !== 'string' && typeof name !== 'number') {
    throw new Error('Jupyter завёл оболочку без имени.')
  }
  return String(name)
}

async function deleteJupyterTerminal(endpoint: KernelEndpoint, name: string): Promise<void> {
  const res = await jupyterRequest(endpoint, `/api/terminals/${encodeURIComponent(name)}`, 'DELETE')
  // 404 means somebody beat us to it, which is the outcome we wanted anyway.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Jupyter не закрыл оболочку (HTTP ${res.status}).`)
  }
}

function socketUrl(endpoint: KernelEndpoint, name: string): string {
  const base = new URL(endpoint.url)
  const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:'
  const prefix = base.pathname.replace(/\/+$/, '')
  const query = new URLSearchParams({ token: endpoint.token })
  return `${scheme}//${base.host}${prefix}/terminals/websocket/${encodeURIComponent(name)}?${query.toString()}`
}

function sendFrame(term: Term, frame: unknown[]): boolean {
  const socket = term.socket
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

const sendStdin = (term: Term, data: string) => sendFrame(term, ['stdin', data])

const sendSize = (term: Term) =>
  sendFrame(term, ['set_size', TERM_ROWS, TERM_COLS, TERM_ROWS * 16, TERM_COLS * 8])

function connect(term: Term): Promise<void> {
  const name = term.name
  if (!name) return Promise.reject(new Error('подключаться не к чему — у оболочки нет имени'))

  return new Promise<void>((resolve, reject) => {
    let socket: WebSocket
    try {
      // The token rides in the query string for terminado and in the header for
      // reverse proxies that strip query strings.
      socket = new WebSocket(socketUrl(term.endpoint, name), {
        headers: { Authorization: `token ${term.endpoint.token}` },
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        socket.terminate()
      } catch {
        /* nothing to terminate */
      }
      reject(
        new Error(`канал оболочки не открылся за ${Math.round(CONNECT_TIMEOUT_MS / 1000)} с`),
      )
    }, CONNECT_TIMEOUT_MS)

    socket.on('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      /*
       * Прежний сокет к тому же pty закрывается здесь, а не «когда-нибудь».
       *
       * Раньше `term.socket = socket` просто затирал предыдущий, а тот оставался
       * с живым обработчиком: терминадо шлёт вывод в оба, и каждая строка
       * работающей команды писалась в общий транскрипт дважды — до конца пары.
       */
      const previous = term.socket
      if (previous && previous !== socket) {
        try {
          previous.close()
        } catch {
          /* already gone */
        }
      }
      term.socket = socket
      resolve()
    })

    socket.on('message', (data: RawData) => {
      // Кадры осиротевшего сокета — не наш вывод: его команда давно у другого.
      if (term.socket !== socket) return
      const text = frameText(data)
      if (text === null) return
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      // terminado frames are JSON arrays: ["stdout", text], ["setup", {}], ["disconnect", n].
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return
      if (parsed[0] === 'stdout' || parsed[0] === 'stderr') {
        const chunk = typeof parsed[1] === 'string' ? parsed[1] : ''
        if (chunk.length > 0) onChunk(term, chunk)
      } else if (parsed[0] === 'disconnect') {
        onShellExit(term)
      }
    })

    socket.on('error', (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    socket.on('close', () => {
      clearTimeout(timer)
      const ours = term.socket === socket
      if (ours) term.socket = null
      if (!settled) {
        settled = true
        reject(new Error('канал оболочки закрылся, не открывшись'))
        return
      }
      // Закрылся не тот сокет, которым терминал пользуется сейчас: это уборка
      // за собой, а не обрыв. Переподключаться на неё — плодить третий.
      if (!ours) return
      if (term.closing || term.phase === 'closed' || term.phase === 'dead') return
      term.primed = false
      scheduleReconnect(term)
    })
  })
}

function closeSocket(term: Term): void {
  const socket = term.socket
  term.socket = null
  if (!socket) return
  try {
    socket.close()
  } catch {
    /* already gone */
  }
}

/** Somebody typed `exit` (or Ctrl-D): the pty is gone, not broken. */
function onShellExit(term: Term): void {
  term.closing = true
  clearTimers(term)
  clearRunning(term)
  detachOutput(term)
  term.partial = ''
  term.col = 0
  term.raw = ''
  term.queued = []
  term.primed = false
  term.name = null
  closeSocket(term)
  settleRun(term, false)
  rejectWaiters(term, new Error('оболочка вышла'))
  setPhase(term, 'closed')
  systemLine(term, '[colloq] Оболочка завершила работу. Нажмите «Перезапустить оболочку», чтобы создать новую.')
  dropPending(term, 'оболочка вышла')
}

/* -------------------------------------------------------------- lifecycle */

function clearTimers(term: Term): void {
  for (const key of ['flushTimer', 'quietTimer', 'primeTimer', 'reconnectTimer'] as const) {
    const timer = term[key]
    if (timer) clearTimeout(timer)
    term[key] = null
  }
}

function resolveWaiters(term: Term): void {
  for (const waiter of term.waiters.splice(0, term.waiters.length)) waiter.resolve()
}

function rejectWaiters(term: Term, err: Error): void {
  for (const waiter of term.waiters.splice(0, term.waiters.length)) waiter.reject(err)
}

/** Gone for good: say so in the transcript the room is reading, not just in a log. */
function fail(term: Term, message: string): void {
  clearTimers(term)
  term.queued = []
  term.raw = ''
  term.primed = false
  clearRunning(term)
  closeSocket(term)
  setPhase(term, 'dead')
  systemLine(term, `[colloq] ${message}`)
  dropPending(term, 'терминала больше нет')
  rejectWaiters(term, new Error(message))
}

function armPrime(term: Term): void {
  if (term.primeTimer) clearTimeout(term.primeTimer)
  term.primeTimer = setTimeout(() => finishPrime(term), PRIME_QUIET_MS)
}

function startPrime(term: Term, greet: boolean): void {
  term.primed = false
  term.raw = ''
  term.primeDeadline = Date.now() + PRIME_MAX_MS
  // The prompt belongs where the notebook's files are, so `ls` in the terminal
  // and `open('data.csv')` in a cell agree about what "here" means.
  if (greet) sendStdin(term, `cd ${kernelCwd(term.sessionId)} && clear\n`)
  armPrime(term)
}

function finishPrime(term: Term): void {
  if (term.primeTimer) {
    clearTimeout(term.primeTimer)
    term.primeTimer = null
  }
  if (term.primed) return
  term.primed = true
  term.raw = ''
  /*
   * Незакрытая строка закрывается здесь, а не забывается.
   *
   * Раньше стояло `term.tailLen = 0` — то есть учёт хвоста обнулялся, а сам
   * хвост (кадр tqdm, половина строки) оставался лежать в конце записи в
   * документе. Следующий `writeOut` видел `tail === 0`, ничего не стирал и
   * дописывал новый кадр за старым: в транскрипте два кадра одной строки
   * подряд. `detachOutput` снимает хвост из документа и закрывает запись —
   * дальше пишем с чистого места.
   */
  detachOutput(term)
  term.partial = ''
  term.col = 0
  term.reconnectAttempts = 0
  setPhase(term, term.commandLine ? 'busy' : 'idle')
  resolveWaiters(term)
  drainQueued(term)
  probeShell(term)
}

/**
 * Спросить оболочку, свободна ли она, — пустой строкой.
 *
 * После перезапуска сервера транскрипт говорит, что команда идёт, а правду
 * знает только pty. Свободная оболочка на `\n` печатает новое приглашение —
 * `onQuiet` увидит его и закроет строку по обычному пути (`finishCommand`),
 * вместе с ней снимется и охрана. Занятая молчит, и строка остаётся «идёт»,
 * что и есть правда. Перевод строки в stdin работающей программы — та же
 * цена, что у приветственного `cd … && clear`, который мы и так шлём при
 * каждом открытии.
 */
function probeShell(term: Term): void {
  if (!term.probe) return
  term.probe = false
  sendStdin(term, '\n')
}

function scheduleReconnect(term: Term): void {
  if (term.reconnectTimer || term.closing) return
  if (term.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    fail(term, 'Связь с общей оболочкой потеряна. Нажмите «Перезапустить оболочку», чтобы создать новую.')
    return
  }
  const wait = Math.min(500 * 2 ** term.reconnectAttempts, 5000)
  term.reconnectAttempts++
  setPhase(term, 'starting')
  term.reconnectTimer = setTimeout(() => {
    term.reconnectTimer = null
    void reconnect(term)
  }, wait)
}

/**
 * A dropped websocket is a network hiccup, not a dead shell: the pty keeps
 * running inside the container, so re-attaching resumes the same session with
 * the same cwd. Terminado replays its scrollback on attach, which the transcript
 * already has — hence the prime, which throws that replay away.
 */
function reconnect(term: Term): Promise<void> {
  if (term.closing || term.phase === 'closed' || !term.name) return Promise.resolve()
  if (term.opening) return term.opening
  /*
   * Переподключение держится тем же полем, что и открытие, и это чинит окно.
   *
   * Пока `connect` в полёте, `term.socket` уже null, таймер переподключения уже
   * снят, а `opening` до сих пор не выставлялся — то есть все три сторожа
   * `openTerminal` были пустыми, и второй вход (руки оракула, команда,
   * прилетевшая в это мгновение) открывал ВТОРОЙ сокет к той же оболочке:
   * `cd … && clear` в stdin работающего `pip`, вывод в транскрипте дважды,
   * фаза `idle` при живой команде.
   */
  const run = (async () => {
    try {
      await connect(term)
      sendSize(term)
      startPrime(term, false)
    } catch (err) {
      console.error(`[terminal] reconnect failed for ${term.sessionId}:`, errText(err))
      scheduleReconnect(term)
    } finally {
      term.opening = null
    }
  })()
  term.opening = run
  return run
}

/**
 * Idempotent and concurrency-safe: two people opening the terminal at the same
 * moment share one pty, the same way they share one kernel.
 */
export function openTerminal(sessionId: string): Promise<void> {
  const term = getTerm(sessionId)
  if (term.opening) return term.opening
  if (term.socket && term.socket.readyState === WebSocket.OPEN) return Promise.resolve()
  if (term.reconnectTimer) return waitFor(term)

  term.opening = (async () => {
    term.closing = false
    term.reconnectAttempts = 0
    setPhase(term, 'starting')
    // A transcript restored from disk is somebody else's bookkeeping until now.
    adoptTranscript(term)
    sessionDir(sessionId)
    try {
      /*
       * Оболочка идёт в контейнер этой же комнаты — тот самый, в котором
       * считаются её ячейки. Это может занять минуту: если контейнер ещё не
       * поднят, здесь он и поднимется — ровно та же пауза, что при первом
       * запуске ячейки, и по той же причине.
       */
      const endpoint = await endpointForSession(sessionId, sessionEnvironment(sessionId))
      /*
       * Смена адреса обесценивает запомненное имя: pty с этим именем живёт в
       * другом контейнере, и попытка к нему подключиться в лучшем случае
       * промахнётся, а в худшем приведёт нас в чужую оболочку.
       */
      if (endpoint.url !== term.endpoint.url) term.name = null
      term.endpoint = endpoint

      /*
       * Имя pty ищется и за пределами этого процесса.
       *
       * Оболочка живёт в контейнере комнаты и переживает перезапуск сервера —
       * ровно как ядро. Карта `terms` его не переживает, поэтому имя лежит в
       * документе комнаты (см. PTY_KEY): без него `make run` после правки
       * заводил новую оболочку, а `python train.py`, запущенный в старой,
       * оставался считать в никуда.
       */
      const restored = term.name === null ? rememberedPty(term, endpoint.url) : null
      if (restored) term.name = restored

      const remembered = term.name !== null
      if (!term.name) term.name = await createJupyterTerminal(endpoint)
      let fresh = !remembered
      try {
        await connect(term)
      } catch (err) {
        // A remembered pty that will not take a connection is gone (container
        // restarted, terminal reaped). Allocate a fresh one rather than making
        // someone click Open twice to find that out.
        if (!remembered) throw err
        term.name = await createJupyterTerminal(endpoint)
        fresh = true
        await connect(term)
      }
      rememberPty(term)
      // Вернулись в ту же оболочку — значит, команда, помеченная «идёт», может
      // и правда идти. Поднимаем её и спрашиваем оболочку (см. probeShell).
      const resumed = !fresh && restored !== null && resumeCommand(term)
      if (resumed) term.probe = true
      sendSize(term)
      /*
       * Приветствие — только в свободную оболочку.
       *
       * `cd … && clear` в оболочку, где идёт `python train.py`, — это строка
       * текста в stdin чужой программы. Пока мы не знаем, свободна ли она,
       * спрашиваем самым тихим, что есть: пустой строкой (см. probeShell). Её
       * же цена и её же ответ, но без команды, которая может выполниться.
       */
      startPrime(term, !resumed)
    } catch (err) {
      term.name = null
      // Порт контейнера комнаты случайный и запоминается пулом; после
      // `docker restart` он другой. Забыть — иначе следующая попытка пойдёт по
      // тому же мёртвому адресу, и так до перезапуска всего сервера.
      forgetSessionKernel(sessionId)
      const message = `не удалось открыть общую оболочку — ${errText(err)}`
      fail(term, message)
      throw new Error(message)
    } finally {
      term.opening = null
    }
  })()

  return term.opening
}

function waitFor(term: Term): Promise<void> {
  if (term.primed && term.socket && term.socket.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => term.waiters.push({ resolve, reject }))
}

function whenReady(term: Term): Promise<void> {
  if (term.primed && term.socket && term.socket.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }
  const waiting = waitFor(term)
  // The open may already be in flight; either way its failure reaches the waiter.
  void openTerminal(term.sessionId).catch(() => {})
  return waiting
}

/** Typed-before-it-was-ready commands run in the order they were typed. */
function drainQueued(term: Term): void {
  if (term.queued.length === 0) return
  const pending = term.queued.splice(0, term.queued.length)
  for (const payload of pending) {
    if (!sendStdin(term, payload)) {
      fail(term, 'Не удалось подключиться к общей оболочке. Создайте новую оболочку.')
      return
    }
  }
}

/* --------------------------------------------------------------- commands */

export function runCommand(
  sessionId: string,
  command: string,
  by: { name: string; color: string; participantId: string },
  done?: Done,
): void {
  const term = getTerm(sessionId)
  const text = command.replace(/\r/g, '').replace(/\n+$/, '')
  if (text.trim().length === 0) {
    done?.({ output: '', finished: false })
    return
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND_BYTES) {
    systemLine(term, '[colloq] команда слишком длинная — положите её в файл и запустите файл.')
    done?.({ output: '', finished: false })
    return
  }

  /*
   * One shell, so one command at a time. A command typed while another is
   * running waits its turn instead of being pushed at a shell that will buffer
   * it and echo it back later: that produced a transcript nobody could read —
   * the first person's last line of output printed underneath the second
   * person's command, and the second command written twice.
   *
   * The line is not written here either. It goes in when the command actually
   * starts, so the order in the transcript is the order things ran.
   *
   * Занятость меряется живой строкой команды, а не фазой. Фаза врёт в двух
   * обычных случаях: обрыв сокета к Jupyter ставит `starting`, хотя pty внутри
   * контейнера продолжает считать, — и `Clear` посреди чужой команды. В обоих
   * условие с `phase === 'busy'` переставало держать, и команда уходила в stdin
   * работающей: её байты доставались `train.py`, а остаток чужого вывода
   * печатался под строкой того, кто просто набрал `ls`. Строка команды живёт
   * ровно столько, сколько команда: её гасят `clearRunning` в конце, при смерти
   * оболочки и при закрытии терминала.
   */
  if (term.commandLine) {
    if (term.pending.length >= MAX_PENDING_COMMANDS) {
      systemLine(term, '[colloq] в очереди уже слишком много команд — повторите, когда оболочка освободится.')
      // Тот, кто ждёт ответа (оракул), должен узнать об отказе сейчас, а не
      // через полторы минуты по таймауту.
      done?.({ output: '', finished: false })
      return
    }
    term.pending.push({ text, by, done })
    systemLine(term, `[colloq] ${by.name} — команда ждёт свободной оболочки.`)
    return
  }

  dispatch(term, text, by, done)
}

/** Hard stop on how many commands may be stacked up behind a busy shell. */
const MAX_PENDING_COMMANDS = 8

/** Чем кончилась команда: весь её вывод и то, дождались ли конца вообще. */
export type Done = (result: { output: string; finished: boolean }) => void

function dispatch(term: Term, text: string, by: Sender, done?: Done): void {
  // Whatever ran before is no longer the thing producing output, whether or not
  // we ever recognised its prompt.
  // И тот, кто ждал предыдущую, ждёт зря: её вывод уже не соберётся.
  settleRun(term, false)
  term.runningDone = done ?? null
  term.runningBy = by.participantId
  clearRunning(term)
  detachOutput(term)
  term.partial = ''
  term.col = 0
  term.screenApp = false
  term.clearNoticed = false
  term.flooded = false
  term.skipEcho = text.split('\n')[0]

  const line = createTerminalLine({
    kind: 'command',
    text,
    name: by.name,
    color: by.color,
    participantId: by.participantId,
  })
  appendEntry(term, line, text.length, countLines(text) + 1)
  term.commandLine = line
  term.commandLineId = lineId(line)
  setPhase(term, 'busy')

  term.queued.push(`${text}\n`)
  void whenReady(term)
    .then(() => drainQueued(term))
    .catch(() => {
      // fail() already put the reason in the transcript; do not keep claiming
      // this command is running.
      clearRunning(term)
      startNextPending(term)
    })
}

/** The shell is free again: give it whatever has been waiting longest. */
function startNextPending(term: Term): void {
  const next = term.pending.shift()
  if (!next) return
  dispatch(term, next.text, next.by, next.done)
}

/** Whoever typed the command the shell is running now, or null between commands. */
export function typedRunningCommand(sessionId: string, participantId: string): boolean {
  return terms.get(sessionId)?.runningBy === participantId
}

/**
 * Занята ли оболочка прямо сейчас — тем же мерилом, что и `runCommand`.
 *
 * Живой строкой команды, а не фазой. Фаза врёт в двух обычных случаях,
 * перечисленных над `runCommand`: обрыв сокета к Jupyter ставит `starting`,
 * хотя pty внутри контейнера продолжает считать, и `Clear` посреди чужой
 * команды. Спрашивающему (оракул в режиме «сделать») цена ошибки высока: он по
 * этому ответу решает, ставить ли свой запуск в общую очередь, — а команда,
 * начавшаяся уже после конца хода, идёт в комнате сама по себе.
 */
export function terminalBusy(sessionId: string): boolean {
  return terms.get(sessionId)?.commandLine != null
}

/**
 * Снять из очереди команды этого человека, не трогая идущую.
 *
 * `interruptTerminal` делает то же самое, но вместе с Ctrl+C; здесь нужен
 * только первый шаг: ход оракула кончился, а его команда, поставленная в
 * очередь за чужой, начнётся через минуту — без зрителей, без ожидающего и
 * посреди совсем другого занятия. Возвращает, сколько сняли.
 */
export function dropPendingOf(sessionId: string, participantId: string): number {
  const term = terms.get(sessionId)
  if (!term || term.pending.length === 0) return 0
  const mine = term.pending.filter((item) => item.by.participantId === participantId)
  if (mine.length === 0) return 0
  term.pending = term.pending.filter((item) => item.by.participantId !== participantId)
  // Ждущему отвечают сразу: его команда снята, а не «идёт».
  settlePending(mine)
  systemLine(
    term,
    mine.length === 1
      ? `[colloq] ${mine[0].by.name} — команда снята из очереди.`
      : `[colloq] из очереди снято ${mine.length} ${commandWord(mine.length)}.`,
  )
  return mine.length
}

/**
 * Ctrl+C в общую оболочку: снять своё из очереди и остановить свою команду.
 *
 * @param by       Кто нажал — для строки в транскрипте.
 * @param byId     Его participantId. Хост не передаёт: он останавливает всё.
 */
export function interruptTerminal(sessionId: string, by?: string, byId?: string): void {
  const term = terms.get(sessionId)
  if (!term) return
  /*
   * Ctrl+C — в свою команду, а не в ту, что подвернулась.
   *
   * Хост приходит без `byId`: у него кнопка означает «прекратить в этой
   * комнате всё», и это тоже осмысленно. У остальных прерывать нечего, если
   * идёт чужое, — а приходят они сюда не только кнопкой: срок ожидания у
   * оракула (`ai/agent.ts` · stopRun) наступал ровно тогда, когда его
   * собственный запуск ещё стоял в очереди, и девяностая секунда чужого
   * `pip install` заканчивалась Ctrl+C в него. `term:interrupt` из пульта то
   * же самое уже проверяет своим `typedRunningCommand`; здесь — второй замок,
   * потому что сюда ведёт не одна дверь.
   */
  const mayStop = !byId || term.runningBy === byId
  // Commands still waiting to be sent would run *after* the interrupt, which is
  // the opposite of what the button means. That goes for both queues: the bytes
  // on their way to the pty, and whole commands still waiting their turn.
  // Байты в полёте — байты ИДУЩЕЙ команды: чужую строку на полпути в pty рвать
  // нельзя, оболочка выполнит её обрубок.
  if (mayStop) term.queued = []
  if (term.pending.length > 0) {
    /*
     * Из очереди выпадает своё, а не всё подряд.
     *
     * Ctrl+C останавливает команду, которая идёт. Очередь за ней — это чужие
     * команды, поставленные другими людьми, и раньше студент, прервавший свой
     * зависший `pip install`, молча уносил вместе с ним всё, что успел
     * поставить в очередь преподаватель. То же правило, что у ячеек: свой
     * батч, а не чужой.
     *
     * Хост приходит сюда без byId и по-прежнему сбрасывает всё: у него кнопка
     * означает «прекратить в этой комнате всё», и это тоже осмысленно.
     */
    const mine = byId ? term.pending.filter((item) => item.by.participantId === byId) : term.pending
    const keep = byId ? term.pending.filter((item) => item.by.participantId !== byId) : []
    const dropped = mine.length
    term.pending = keep
    // Ждущему (оракулу) отвечаем сразу: его команда снята, а не «идёт».
    settlePending(mine)
    if (dropped > 0) {
      systemLine(
        term,
        dropped === 1
          ? `[colloq] ${mine[0].by.name} — команда снята из очереди.`
          : `[colloq] из очереди снято ${dropped} ${commandWord(dropped)}.`,
      )
    }
  }
  /*
   * Прерывать нечего — и говорить нечего.
   *
   * Строка «X pressed Ctrl+C» над чужой командой, которая продолжает идти, —
   * это ложь в общем транскрипте: комната читает её как «команду остановили».
   * Своё из очереди при этом снято, и об этом сказано выше своими словами.
   */
  if (!mayStop) return
  // Named, because a shared shell that goes quiet without saying who did it is
  // a room where everybody assumes it was somebody else.
  if (by) systemLine(term, `[colloq] Ctrl+C — команду останавливает ${by}.`)
  /*
   * Результат отправки читается, и это не мелочь.
   *
   * `sendStdin` возвращает false, когда открытого сокета нет — обрыв канала к
   * Jupyter, переподключение. Строку «X pressed Ctrl+C» комната при этом видела,
   * а команда в pty продолжала работать: очередь уже сброшена, объяснения нет,
   * и человек жмёт «стоп» второй и третий раз в пустоту. ETX встаёт в `queued`
   * первым и уйдёт, как только канал вернётся, — тем же путём, что и команды,
   * набранные до готовности оболочки.
   */
  if (!sendStdin(term, ETX)) {
    // Закрытому терминалу прерывать нечего, а ETX, оставленный в его очереди,
    // достался бы следующей — уже другой — оболочке.
    if (term.phase === 'closed') return
    term.queued.unshift(ETX)
    systemLine(
      term,
      '[colloq] связи с оболочкой сейчас нет, и Ctrl+C до неё ещё не дошёл — ' +
        'он уйдёт, как только терминал переподключится.',
    )
  }
}

export function clearTerminal(sessionId: string): void {
  const term = getTerm(sessionId)
  const doc = docOf(term)
  const array = getTerminal(doc)
  /*
   * Идущая команда переживает уборку — новой строкой.
   *
   * Стереть транскрипт можно, а команду из оболочки — нет: `pip install` внутри
   * продолжает работать. Раньше вместе с записями терялась и строка команды, а с
   * ней и вся охрана «одна команда за раз»: следующий набравший `ls` отправлял
   * его в занятый шелл, и его вывод печатался под чужой строкой. Заводим для
   * идущей команды свежую строку — комната видит, что именно всё ещё работает.
   */
  const running = term.commandLine
  const carried = running
    ? {
        text: terminalText(running).toString(),
        name: (running.get('name') as string | null) ?? null,
        color: (running.get('color') as string | null) ?? null,
        participantId: (running.get('participantId') as string | null) ?? null,
      }
    : null
  if (array.length > 0) doc.transact(() => array.delete(0, array.length), ORIGIN)
  term.ledger = []
  term.chars = 0
  term.lines = 0
  term.outputLine = null
  term.outputLineId = null
  term.outChars = 0
  term.outLines = 0
  term.tailLen = 0
  term.commandLine = null
  term.commandLineId = null
  // The tail is gone from the document; keeping it here would duplicate it into
  // the next entry a moment later.
  term.partial = ''
  term.col = 0
  if (!carried) return
  const line = createTerminalLine({
    kind: 'command',
    text: carried.text,
    name: carried.name,
    color: carried.color,
    participantId: carried.participantId,
  })
  appendEntry(term, line, carried.text.length, countLines(carried.text) + 1)
  term.commandLine = line
  term.commandLineId = lineId(line)
}

export async function closeTerminal(sessionId: string): Promise<void> {
  const term = terms.get(sessionId)
  if (!term) return
  term.closing = true
  clearTimers(term)
  clearRunning(term)
  detachOutput(term)
  term.partial = ''
  term.col = 0
  term.raw = ''
  term.queued = []
  term.primed = false
  closeSocket(term)
  const name = term.name
  term.name = null
  // Эту оболочку мы сейчас удалим — возвращаться будет некуда.
  rememberPty(term)
  settleRun(term, false)
  rejectWaiters(term, new Error('терминал закрыли'))
  setPhase(term, 'closed')
  systemLine(term, '[colloq] терминал закрыт.')
  dropPending(term, 'терминал закрыли')
  if (!name) return
  try {
    await deleteJupyterTerminal(term.endpoint, name)
  } catch (err) {
    // The pty may outlive us, but the room's view of it is already correct.
    console.error(`[terminal] could not delete terminal for ${sessionId}:`, errText(err))
  }
}

/**
 * Останавливается сервер, а не семинары, — то же правило, что у `shutdownKernels`.
 *
 * Раньше здесь стоял `DELETE /api/terminals/<name>`, и оболочка умирала вместе
 * с `python train.py` внутри: `make run` — то, что Makefile советует делать
 * после любой правки, — стоил семинару трёхчасового обучения, а транскрипт об
 * этом не говорил ни слова. Обоснование («иначе pty переживёт процесс и займёт
 * память контейнера») перестало держаться, когда контейнер стал одним на
 * комнату: он живёт дальше в любом случае, а уберёт его уборка простоя вместе
 * со всем остальным. Имя pty лежит в документе комнаты, так что следующий
 * запуск вернётся в ту же оболочку — см. PTY_KEY и `resumeCommand`.
 */
export async function shutdownTerminals(): Promise<void> {
  const all = [...terms.values()]
  terms.clear()
  for (const term of all) {
    term.closing = true
    clearTimers(term)
    closeSocket(term)
    rejectWaiters(term, new Error('сервер останавливается'))
  }
}

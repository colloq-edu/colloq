import { tr } from '@shared/i18n'
/**
 * Вывод попытки консилиума — в память, а не в общую ячейку.
 *
 * OutputWriter (outputs.ts) пишет в Y.Array ячейки, потому что вывод ячейки
 * смотрит вся комната. Вывод попытки смотрят двое — преподаватель и автор, — и
 * класть его в общий документ значило бы показать залу то, что преподаватель
 * ещё не решил показывать. Поэтому у попытки свой приёмник: те же обработчики
 * ядра, тот же порядок записей, но результат — обычный массив `CellOutput`,
 * который control.ts кладёт к попытке (council.ts · recordRun) и рассылает по
 * управляющему сокету.
 *
 * Потолки ниже, чем у ячейки, и это намеренно: карточка попытки рисуется в
 * стопке из сотен, и каждый её кадр едет хосту целиком вместе со всей стопкой.
 * Прогресс-бар на четыреста килобайт там не поместится и не нужен.
 *
 * Чистый модуль без Yjs и без сети — ради теста.
 */
import type { CellOutput, StreamName } from '@shared/notebook'
import type { CouncilRun } from '@shared/protocol'
import {
  figureChars,
  figureTooBigNotice,
  withoutDeadPlotlyHtml,
  withoutFigure,
} from './figures.js'

/** Столько текста в попытке ещё читается на карточке; дальше — совет писать в файл. */
export const MAX_ATTEMPT_OUTPUT_CHARS = 64 * 1024
/** Одна картинка matplotlib помещается; галерея — нет. */
export const MAX_ATTEMPT_DATA_CHARS = 2 * 1024 * 1024
const MAX_TRACEBACK_LINES = 60
const MAX_ERROR_LINE_CHARS = 2 * 1024

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return tr("server.colloqMoreCharactersCutHere.cfc854", { p0: text.slice(0, max), p1: text.length - max })
}

/** Что ядру надо, чтобы посчитать попытку, и кому сказать, что вышло. */
export interface CouncilJob {
  /** Ячейка консилиума — та, к которой относится попытка (не синтетический id очереди). */
  cellId: string
  participantId: string
  source: string
  by: CouncilRun['by']
  /**
   * Предел одного запуска в секундах; `null` — без предела.
   *
   * Едет с заданием, а не читается ядром с ячейки: ручки лежат в документе, а
   * до документа отсюда добираются только через control.ts — тот самый модуль,
   * который зовёт ядро. Импорт назад замкнул бы их друг на друга, и ради одного
   * числа. Число снимается в секунду нажатия; регламент, поменянный посреди
   * запуска, доезжает отдельно (kernel/index.ts · retimeCouncilRun).
   */
  limitSec: number | null
  /**
   * Каждая смена состояния и каждый кадр вывода. `null` — попытку сняли с
   * очереди, не запуская (перезапуск ядра, «стоп» по комнате): запуска не было,
   * и записи о нём быть не должно.
   */
  onChange: (run: CouncilRun | null) => void
}

export class CouncilOutputBuffer {
  private outputs: CellOutput[] = []
  private used = 0
  private usedData = 0
  private truncated = false
  private dataTruncated = false
  /** Обещание `clear_output(wait=True)`: следующая запись заменяет, а не дописывает. */
  private superseded = false

  stream(name: StreamName, text: string): void {
    if (!text) return
    this.settle()
    if (this.truncated) return
    const room = MAX_ATTEMPT_OUTPUT_CHARS - this.used
    let body = text
    // Строго больше: текст, ровно уложившийся в бюджет, не срезан ни на символ,
    // и объявлять его обрезанным — значит соврать и выбросить всё, что придёт
    // следом. Ровно заполненный бюджет упрётся в потолок на следующем куске,
    // где обрезка и правда случится.
    if (text.length > room) {
      body = text.slice(0, Math.max(0, room))
      this.truncated = true
    }
    this.used += body.length
    if (body) this.append(name, body)
    if (this.truncated) {
      this.outputs.push({
        kind: 'stream',
        name: 'stderr',
        text: tr("server.colloqAttemptOutputStoppedAfterCharactersSave.97282a", { p0: MAX_ATTEMPT_OUTPUT_CHARS }),
      })
    }
  }

  data(mimebundle: Record<string, string>, execCount: number | null): void {
    this.settle()
    /*
     * График plotly в попытке — целиком или строкой, третьего нет.
     *
     * Полки записей у попытки нет и быть не может: её вывод живёт в памяти и
     * уезжает хосту по управляющему сокету вместе со всей стопкой (см. шапку
     * файла). Значит, фигура либо укладывается в потолок карточки и едет как
     * есть, либо не едет вовсе — и тогда вместо неё та же честная строка, что
     * в комнате. Обрезать JSON нельзя: это не «часть графика», а битый кадр.
     *
     * Мёртвая разметка plotly снимается тем же правилом, что и в комнате, и до
     * взвешивания: иначе бюджет карточки съедал бы скрипт, который никто
     * никогда не исполнит.
     */
    let bundle = withoutDeadPlotlyHtml(mimebundle)
    const figure = figureChars(bundle)
    if (figure > 0 && figure > MAX_ATTEMPT_DATA_CHARS) {
      bundle = withoutFigure(bundle)
      this.outputs.push({ kind: 'stream', name: 'stderr', text: figureTooBigNotice(figure) })
      if (Object.keys(bundle).length === 0) return
    }
    const size = JSON.stringify(bundle).length
    if (this.dataTruncated || this.usedData + size > MAX_ATTEMPT_DATA_CHARS) {
      if (!this.dataTruncated) {
        this.outputs.push({
          kind: 'stream',
          name: 'stderr',
          text: tr("server.colloqTheAttemptImageLimitWasReached.3d579d"),
        })
      }
      this.dataTruncated = true
      return
    }
    this.usedData += size
    this.outputs.push({ kind: 'data', data: bundle, execCount })
  }

  error(ename: string, evalue: string, traceback: string[]): void {
    this.settle()
    const lines = traceback.map((line) => clip(line, MAX_ERROR_LINE_CHARS))
    const clipped =
      lines.length > MAX_TRACEBACK_LINES
        ? [...lines.slice(0, 20), tr("server.moreFrames.6caf4c", { p0: lines.length - 50 }), ...lines.slice(-30)]
        : lines
    this.outputs.push({
      kind: 'error',
      ename: clip(ename, MAX_ERROR_LINE_CHARS),
      evalue: clip(evalue, MAX_ERROR_LINE_CHARS),
      traceback: clipped,
    })
  }

  /**
   * Запуск остановил регламент — и сказать об этом должен не трейсбек.
   *
   * SIGINT приходит в Python как `KeyboardInterrupt`, и по умолчанию на
   * карточке оставался бы его трейсбек: десяток кадров чужой библиотеки и
   * строка про клавиатуру, которой никто не нажимал. Студент читает это как
   * «преподаватель нажал стоп» или как свою ошибку, а правда — «предел
   * запуска». Поэтому исключение прерывания снимается, а на его место встаёт
   * своё, одной строкой и без трейсбека.
   *
   * Снимается ТОЛЬКО прерывание: всё, что попытка успела напечатать до
   * остановки, — её настоящий вывод, и в нём же обычно ответ на вопрос «где
   * оно зациклилось». `settle()` здесь нарочно не зовётся: обещание
   * `clear_output(wait=True)` от прогресс-бара исполнять нечем, а стереть
   * напечатанное ради строки об остановке — потеря без выгоды.
   */
  stopped(evalue: string): void {
    this.outputs = this.outputs.filter(
      (o) => !(o.kind === 'error' && (o.ename === 'KeyboardInterrupt' || o.ename === 'Interrupted')),
    )
    /*
     * Имя исключения пустое нарочно: карточка рисует «имя: текст», и студент
     * читал «TimeLimit: Остановлено: …» — английское слово перед русской
     * фразой, которое ничего не добавляет. Машинная отметка остановки —
     * `CouncilRun.timedOut`, по имени ошибки её никто не ищет.
     */
    this.outputs.push({ kind: 'error', ename: '', evalue, traceback: [] })
  }

  /** `clear_output(wait=False)` — стереть сейчас. */
  clear(): void {
    this.outputs = []
    this.used = 0
    this.usedData = 0
    this.truncated = false
    this.dataTruncated = false
    this.superseded = false
  }

  /** `clear_output(wait=True)` — стереть, когда будет чем заменить. */
  supersede(): void {
    this.superseded = true
  }

  /** Было ли уже исключение — чтобы не дописывать второе про прерывание. */
  get hasError(): boolean {
    return this.outputs.some((o) => o.kind === 'error')
  }

  /** Копия наружу: массив уезжает в JSON и в базу, буфер живёт дальше. */
  snapshot(): CellOutput[] {
    return this.outputs.map((o) => ({ ...o }))
  }

  private settle(): void {
    if (!this.superseded) return
    this.clear()
  }

  /** Соседние куски одного потока — одной записью, как в документе. */
  private append(name: StreamName, text: string): void {
    const last = this.outputs[this.outputs.length - 1]
    if (last && last.kind === 'stream' && last.name === name) {
      last.text += text
      return
    }
    this.outputs.push({ kind: 'stream', name, text })
  }
}

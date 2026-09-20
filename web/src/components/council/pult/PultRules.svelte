<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Регламент консилиума — все правила ячейки на одном листе.
   *
   * Раньше они жили там, где случайно оказались: «кто запускает» подвалом
   * очереди, «имена на проекторе» переключателем в строке состояния. Обе ручки
   * меняют не вид пульта, а то, что можно КЛАССУ, и искать их по вкладкам —
   * значит каждый раз вспоминать, куда их положили. Здесь они рядом, и рядом
   * же видно последствие каждой: сколько просьб снимется при смене режима,
   * сколько на самом деле считают запуски, чем подписано решение на стене.
   *
   * Лист падает из-под шапки и накрывает вкладки: он про ячейку целиком, и
   * уводить ради него с открытой работы нечестно — читали её, к ней и
   * вернутся. Кнопки применяются сразу, «Сохранить» нет: правило — это не
   * форма, а положение рубильника, и лишний шаг между «поставил 1 мин» и
   * «стало 1 мин» означал бы, что на экране написано не то, что действует.
   */
  import { COUNCIL_SHARED_KERNEL_NOTE, type CouncilSettings } from '@shared/notebook'
  import {
    PULT_RULES,
    limitOptions,
    pauseOptions,
    pultDuration,
    type PultRule,
    type RunStats,
  } from '@/lib/council-pult'
  import { elapsed } from '@/lib/utils'

  interface Props {
    settings: CouncilSettings
    /** Правило, ради которого лист открыли: его строка подсвечена, на ней фокус. */
    rule: PultRule
    /** Сколько просьб о запуске снимет смена режима (сервер · clearRunRequests). */
    pending: number
    /** Как долго считают запуски этой ячейки; null — законченных ещё не было. */
    stats: RunStats | null
    /**
     * Предел ОБЫЧНОЙ ячейки этой комнаты в секундах; `null` — без предела.
     *
     * Правило комнаты, а не ячейки, и отсюда его не меняют — оно лежит в
     * правилах занятия. Но сказать о нём надо именно здесь: очередь у тетради
     * одна, и предел запуска, выставленный в этом листе, не спасает ни от чего,
     * пока в той же тетради может идти обычная ячейка без предела. Это ровно та
     * дыра, из-за которой «предел не работает» было правдой.
     */
    cellLimit: number | null
    /** Нет связи или пульт не ведёт занятие: смотреть можно, менять нечего. */
    disabled: boolean
    /** Низ шапки: отсюда лист начинается, ниже него — затемнение. */
    top: number
    onchange: (patch: Partial<CouncilSettings>) => void
    onclose: () => void
  }

  let { settings, rule, pending, stats, cellLimit, disabled, top, onchange, onclose }: Props = $props()

  let sheet = $state<HTMLElement | null>(null)

  interface Segment { label: string; on: boolean; off: boolean; pick: () => void }
  interface Row { rule: PultRule; title: string; why: string; note: string; segments: Segment[] }

  const runs = $derived<Segment[]>(
    ([
      [false, 'room.pult.v2.rules.whoTeacher'],
      [true, 'room.pult.v2.rules.whoEveryone'],
      ['request', 'room.pult.v2.rules.whoRequest'],
    ] as [CouncilSettings['studentRun'], string][]).map(([value, key]) => ({
      label: tr(key),
      on: settings.studentRun === value,
      off: disabled,
      pick: () => onchange({ studentRun: value }),
    })),
  )

  const whoWhy = $derived(
    tr(
      settings.studentRun === false
        ? 'room.pult.v2.rules.whyTeacher'
        : settings.studentRun === true
          ? 'room.pult.v2.rules.whyEveryone'
          : 'room.pult.v2.rules.whyRequest',
    ),
  )

  /*
   * Статистика — живой цифрой, а не `spell()`.
   *
   * Попытка консилиума — несколько строк, и обычный запуск идёт доли секунды:
   * законченная длительность округляет их до «0 с», и строка, ради которой
   * предел и выбирают, сообщала бы «обычно 0 с · самый долгий 3 с». Десятая
   * доля здесь — единственное, что отличает 0,4 с от 4 с.
   */
  const statLine = $derived(
    stats === null
      ? ''
      : tr('room.pult.v2.rules.limitStats', { median: elapsed(0, stats.median), max: elapsed(0, stats.max) }),
  )

  const rows = $derived<Row[]>(
    PULT_RULES.map((each) => {
      switch (each) {
        case 'studentRun':
          return {
            rule: each,
            title: tr('room.pult.v2.rules.whoTitle'),
            why: whoWhy,
            // Последствие, о котором узнают только после нажатия: сервер
            // снимает все просьбы, как только режим сменился.
            note: pending > 0 ? tr('room.pult.v2.rules.whoPending', { count: pending }) : '',
            segments: runs,
          }
        case 'runLimit':
          return {
            rule: each,
            title: tr('room.pult.v2.rules.limitTitle'),
            why: tr('room.pult.v2.rules.limitWhy'),
            note: statLine,
            segments: limitOptions(settings.runLimitSec).map((value) => ({
              label: value === null ? tr('room.pult.v2.rules.limitNoneOption') : pultDuration(value),
              on: settings.runLimitSec === value,
              off: disabled,
              pick: () => onchange({ runLimitSec: value }),
            })),
          }
        case 'rerunPause':
          return {
            rule: each,
            title: tr('room.pult.v2.rules.pauseTitle'),
            /*
             * Строка остаётся на месте и при выключенных запусках: исчезнув,
             * она унесла бы с собой и то, что пауза настроена, — а вернуть
             * запуски студентам можно одним нажатием соседней кнопки.
             *
             * При «все по очереди» подпись другая, и это не украшение. Пауза по
             * умолчанию ноль, а «все по очереди» преподаватель включает за
             * минуту до дела и про паузу не вспоминает — очередь общего ядра
             * тут же набивается повторными нажатиями после каждой правки.
             * Единственное место, где об этом можно сказать вовремя, — здесь,
             * в соседней строке того же листа.
             */
            why: settings.studentRun === false
              ? tr('room.pult.v2.rules.pauseOff')
              : settings.studentRun === true
                ? tr('room.pult.v2.rules.pauseWhyEveryone')
                : tr('room.pult.v2.rules.pauseWhy'),
            note: '',
            /*
             * Кнопки живые всегда, когда студентам запуск разрешён. Раньше они
             * гасли по `studentRun === false`, то есть пауза настраивалась
             * только после того, как запуск уже открыли, — а порядок «сперва
             * поставить паузу, потом открыть запуск» и есть тот, при котором
             * очередь не успевает набиться.
             */
            segments: pauseOptions(settings.rerunPauseSec).map((value) => ({
              label: value === 0 ? tr('room.pult.v2.rules.pauseNowOption') : pultDuration(value),
              on: settings.rerunPauseSec === value,
              off: disabled,
              pick: () => onchange({ rerunPauseSec: value }),
            })),
          }
        default:
          return {
            rule: each,
            title: tr('room.pult.v2.rules.screenTitle'),
            why: tr('room.pult.v2.rules.screenWhy'),
            note: '',
            segments: [true, false].map((value) => ({
              label: tr(value ? 'room.pult.v2.rules.screenNamesOption' : 'room.pult.v2.rules.screenAnonOption'),
              on: settings.namesOnProjector === value,
              off: disabled,
              pick: () => onchange({ namesOnProjector: value }),
            })),
          }
      }
    }),
  )

  /**
   * Фокус въезжает на ту кнопку, ради которой лист открыли.
   *
   * Не на заголовок и не на «Готово»: пришли менять правило, и первое же
   * нажатие стрелки или пробела должно попасть в его ряд. Кнопки нет (ряд
   * выключен или пульт не ведёт) — остаётся «Готово», чтобы Esc был не
   * единственным выходом с клавиатуры.
   */
  $effect(() => {
    const where = sheet
    if (!where) return
    const target =
      where.querySelector<HTMLButtonElement>(`[data-pult-rules-row="${rule}"] button:not(:disabled)[aria-pressed="true"]`) ??
      where.querySelector<HTMLButtonElement>('[data-pult-rules-done]')
    target?.focus({ preventScroll: true })
  })

  /** Tab по кругу внутри листа: за ним лежит то, чем сейчас не управляют. */
  function keys(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !sheet) return
    const items = [...sheet.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey ? at - 1 : at + 1
    if (at >= 0 && next >= 0 && next < items.length) return
    event.preventDefault()
    items[event.shiftKey ? items.length - 1 : 0].focus()
  }
</script>

<div class="rules-layer" style:--rules-top={`${top}px`}>
  <!-- Затемнение начинается под листом: шапка с предложением остаётся живой,
       и закрыть лист можно тем же нажатием, что его открыло. -->
  <div class="rules-scrim" role="presentation" onclick={onclose}></div>
  <div
    class="rules-sheet"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="pult-rules-title"
    data-pult-rules
    bind:this={sheet}
    onkeydown={keys}
  >
    <header class="rules-head">
      <div class="rules-head-copy">
        <h2 id="pult-rules-title">{tr('room.pult.v2.rules.title')}</h2>
        <p>{tr('room.pult.v2.rules.subtitle')}</p>
      </div>
      <button type="button" class="pult-button" data-pult-rules-done onclick={onclose}>
        {tr('room.pult.v2.rules.done')} <span class="rules-esc" aria-hidden="true">Esc</span>
      </button>
    </header>

    {#each rows as row (row.rule)}
      <div class="rules-row" class:here={row.rule === rule} data-pult-rules-row={row.rule}>
        <span class="rules-label">{row.title}</span>
        <div class="rules-options">
          {#each row.segments as segment, at (at)}
            <button
              type="button"
              class="pult-button"
              class:pult-button--selected={segment.on}
              aria-pressed={segment.on}
              disabled={segment.off}
              onclick={segment.pick}
            >{segment.label}{segment.on ? ' ✓' : ''}</button>
          {/each}
        </div>
        <p class="rules-why">
          {row.why}
          {#if row.note}<span class="rules-note">{row.note}</span>{/if}
        </p>
      </div>
    {/each}

    <!--
      Предел ОБЫЧНОЙ ячейки — рядом с подписью про общее ядро, и это одно и то
      же знание, досказанное до конца: ядро общее, а значит общая и очередь, и
      предел запуска в этом листе сторожит только попытки. Строка стоит под
      правилами, а не строкой среди них: менять её отсюда нельзя, она живёт в
      правилах занятия.
    -->
    <p class="rules-kernel" class:rules-warn={cellLimit === null} data-pult-cell-limit>
      {cellLimit === null
        ? tr('room.pult.v3.rules.cellLimitOff')
        : tr('room.pult.v3.rules.cellLimitOn', { duration: pultDuration(cellLimit) })}
    </p>
    <p class="rules-kernel">{tr(COUNCIL_SHARED_KERNEL_NOTE)}</p>
  </div>
</div>

<style>
  .rules-layer { position:absolute; inset:0; z-index:40; pointer-events:none; }
  .rules-scrim { position:absolute; left:0; right:0; top:var(--rules-top); bottom:0; background:rgba(16,26,51,.32); pointer-events:auto; }
  .rules-sheet {
    /* На пиксель выше низа шапки: своей чертой лист ложится ровно на её
       границу, иначе на стыке получается двойная линия. */
    position:absolute; left:0; right:0; top:calc(var(--rules-top) - 1px);
    /* Ниже окна лист не растёт: на 700 px высоты четыре ряда и подпись про
       ядро не помещаются, и последнее правило иначе просто не достать. */
    max-height:calc(100dvh - var(--rules-top));
    overflow-y:auto; overscroll-behavior:contain;
    background:rgb(var(--canvas)); border-top:1px solid rgb(var(--line)); border-bottom:1px solid rgb(var(--line));
    pointer-events:auto;
  }
  .rules-head { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding:22px var(--pult-pad) 18px; }
  .rules-head-copy { min-width:0; }
  h2 { margin:0; font-size:20px; line-height:26px; font-weight:700; }
  .rules-head-copy p { margin:4px 0 0; color:rgb(var(--muted)); font-size:14px; line-height:18px; }
  .rules-esc { color:rgb(var(--faint)); font-size:12px; font-weight:600; }
  /* Полоса слева — четыре пикселя, на которые текст НЕ съезжает: заголовок
     листа и подписи рядов должны начинаться на одной вертикали. */
  .rules-row { display:flex; align-items:center; gap:24px; padding:16px var(--pult-pad); border-top:1px solid rgb(var(--line)); border-left:4px solid transparent; }
  .rules-row.here { border-left-color:rgb(var(--primary)); background:rgb(var(--surface)); }
  .rules-label { width:168px; flex-shrink:0; font-size:15px; line-height:20px; font-weight:700; }
  .rules-options { display:flex; flex-wrap:wrap; gap:8px; width:452px; flex-shrink:0; }
  .rules-options .pult-button { min-height:38px; padding:10px 12px; font-size:14px; line-height:18px; }
  .rules-options .pult-button[aria-pressed='true'] { color:rgb(var(--primary)); font-weight:700; }
  .rules-why { flex:1; min-width:0; margin:0; color:rgb(var(--muted)); font-size:13px; line-height:18px; }
  .rules-note { display:block; margin-top:4px; color:rgb(var(--accent-text)); font-weight:600; }
  .rules-warn { color:rgb(var(--warning)); font-weight:600; }
  .rules-kernel { margin:0; padding:14px var(--pult-pad) 18px; border-top:1px solid rgb(var(--line)); color:rgb(var(--faint)); font-size:13px; line-height:18px; }
  @media (max-width:1000px) {
    .rules-row { flex-wrap:wrap; gap:10px 16px; }
    .rules-label { width:auto; flex-basis:100%; }
    .rules-options { width:auto; flex-shrink:1; }
    .rules-why { flex-basis:100%; }
  }
</style>

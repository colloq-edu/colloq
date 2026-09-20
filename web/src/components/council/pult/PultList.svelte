<script lang="ts">
  import { tr } from '@shared/i18n'
    /**
   * Левая колонка пульта: люди сверху вниз, свежие первыми.
   *
   * Два вида строк: человек (PultRow) и заголовок половины ленты («Сдали · 12»,
   * «Пишут · 5»). Выбирается курсором только первый — Enter на заголовке
   * означал бы «показать классу» неизвестно чью работу.
   *
   * Строк было четыре: сюда же входили свёрнутый хвост группы и шапка
   * раскрытой. Группировки в пульте больше нет (20.09), и людей под чужим
   * хвостом тоже: одна сдача — одна строка.
   *
   * Полоса «↑ ещё N сдали — показать» появляется, когда список прокручен или
   * курсор не на первой строке: строка, вставшая сверху под читающим глазом,
   * уводит вниз всё, что он читает. Отпускают её рукой — и только тогда список
   * двигается.
   */
  import type { CouncilAttempt } from '@shared/protocol'
  import { pultPresence, rowMeaning, type PultRow as Row } from '@/lib/council-pult'
  import { cn } from '@/lib/utils'
  import PultRow from './PultRow.svelte'

  interface Props {
    rows: readonly Row[]
    people: ReadonlyMap<string, unknown>
    connected: boolean
    filtered?: boolean
    /** Выбранная работа — она же открыта справа. */
    cursor: string | null
    /** Пришли с клавиатуры: только тогда рисуется кольцо. */
    keyboard: boolean
    names: boolean
    /** Кто сейчас на экране у зала. */
    shown: string | null
    /** Сколько сдач придержано за полосой; 0 — полосы нет. */
    held: number
    /** Часы окна: живой счётчик «Считает 3 с» в строке того, кто считается. */
    now: number
    /** Решать просьбы о запуске нельзя (нет связи, ручка не та). */
    decisionsOff: boolean
    onopen: (participantId: string) => void
    onlet: (attempt: CouncilAttempt) => void
    onrelease: () => void
    /** Насколько список прокручен: от этого зависит, держать ли новые сдачи. */
    onscroll: (top: number) => void
  }

  let {
    rows,
    people,
    connected,
    filtered = false,
    cursor,
    keyboard,
    names,
    shown,
    held,
    now,
    decisionsOff,
    onopen,
    onlet,
    onrelease,
    onscroll,
  }: Props = $props()

  const CAPS = 'text-[13px] font-semibold'
</script>

<!--
  308 — это ровно то, во что встаёт «Александра Верещагина» целиком. Шире 1100
  список растёт до 360: место появилось, и отдать его стоит именно ему —
  работа справа от лишних 52 px читается не лучше, а список читается.
-->
<div
  class="flex min-h-0 flex-1 flex-col"
  data-pult-list
>
  {#if held > 0}
    <!--
      Прибита к верху списка, а не вставлена первой строкой: она про то, чего в
      списке ещё нет, и уехать вместе с прокруткой ей нельзя.
    -->
    <button
      type="button"
      class={cn(CAPS, 'flex min-h-10 shrink-0 items-center justify-center border-b border-line bg-accent text-accent-ink')}
      onclick={onrelease}
    >{tr('room.ui.1320', { count: held })}</button>
  {/if}
  <div
    class="pult-scroll min-h-0 flex-1 overflow-y-auto"
    data-pult-scroll
    onscroll={(event) => onscroll(event.currentTarget.scrollTop)}
  >
    {#each rows as row (row.id)}
      {#if row.kind === 'attempt'}
        <PultRow
          attempt={row.attempt}
          presence={pultPresence(connected, people, row.attempt.participantId)}
          unread={row.unread}
          variant={row.variant}
          {names}
          {now}
          selected={cursor === row.id}
          focused={keyboard && cursor === row.id}
          meaning={rowMeaning(row.attempt, cursor, shown)}
          onlet={row.attempt.runRequest?.status === 'pending' && !decisionsOff
            ? () => onlet(row.attempt)
            : null}
          onopen={() => onopen(row.id)}
        />
      {:else}
        <!--
          Граница ленты: «Сдали · 12» и «Пишут · 5».
          Липкая внутри прокрутки — уехав, она перестала бы отвечать на
          единственный вопрос, ради которого её завели: та строка, что сейчас
          под глазом, из сдавших или из пишущих? Курсору она не даётся, j и k
          её перепрыгивают: это место в ленте, а не человек.
        -->
        <div class="pult-section" data-pult-section={row.section}>
          {tr(
            row.section === 'submitted'
              ? 'room.pult.v3.sections.submitted'
              : 'room.pult.v3.sections.writing',
            { count: row.count },
          )}
        </div>
      {/if}
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <p class="text-ui-lg font-bold text-muted">{tr(filtered ? 'room.pult.v2.noMatches' : 'room.pult.v2.noAttempts')}</p>
        <p class="text-[14px] leading-relaxed text-muted">{tr(filtered ? 'room.pult.v2.changeFilter' : 'room.pult.v2.noAttemptsHint')}</p>
      </div>
    {/each}
  </div>
</div>

<style>
  /*
   * Палец, а не колесо.
   *
   * `overscroll-behavior: contain` держит рывок в конце списка внутри списка:
   * без него доскролленный до низа список на телефоне утягивает за собой всю
   * страницу, и док общения уезжает из-под большого пальца. Инерция Safari
   * включается своим префиксом — без неё список листается «по-бумажному»,
   * рывками по высоте экрана.
   */
  .pult-scroll { overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
  .pult-section {
    position: sticky; top: 0; z-index: 2;
    display: flex; align-items: center; min-height: 28px;
    padding: 5px 12px;
    border-bottom: 1px solid rgb(var(--line));
    background: rgb(var(--surface));
    color: rgb(var(--faint));
    font-size: 12px; font-weight: 700; line-height: 16px; letter-spacing: .08em; text-transform: uppercase;
  }
  .pult-section[data-pult-section='submitted'] { color: rgb(var(--accent-text)); }
</style>

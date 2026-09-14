<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Левая колонка пульта: люди сверху вниз, свежие первыми.
   *
   * Три вида строк: человек (PultRow), свёрнутый хвост группы и шапка
   * раскрытой. Выбирается курсором только первый — Enter на хвосте означал бы
   * «показать классу» неизвестно чью работу.
   *
   * Полоса «↑ ещё N сдали — показать» появляется, когда список прокручен или
   * курсор не на первой строке: строка, вставшая сверху под читающим глазом,
   * уводит вниз всё, что он читает. Отпускают её рукой — и только тогда список
   * двигается.
   */
  import type { CouncilAttempt } from '@shared/protocol'
  import { rowMeaning, type PultRow as Row } from '@/lib/council-pult'
  import { cn } from '@/lib/utils'
  import PultRow from './PultRow.svelte'

  interface Props {
    rows: readonly Row[]
    /** Выбранная работа — она же открыта справа. */
    cursor: string | null
    /** Пришли с клавиатуры: только тогда рисуется кольцо. */
    keyboard: boolean
    names: boolean
    /** Кто сейчас на экране у зала. */
    shown: string | null
    /** Размеры групп по ключу — для «так же ещё N». */
    sizes: ReadonlyMap<string, number>
    /** Сколько сдач придержано за полосой; 0 — полосы нет. */
    held: number
    /** Решать просьбы о запуске нельзя (нет связи, ручка не та). */
    decisionsOff: boolean
    onopen: (participantId: string) => void
    onlet: (attempt: CouncilAttempt) => void
    ontoggle: (groupKey: string) => void
    onrelease: () => void
    /** Насколько список прокручен: от этого зависит, держать ли новые сдачи. */
    onscroll: (top: number) => void
  }

  let {
    rows,
    cursor,
    keyboard,
    names,
    shown,
    sizes,
    held,
    decisionsOff,
    onopen,
    onlet,
    ontoggle,
    onrelease,
    onscroll,
  }: Props = $props()

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
</script>

<!--
  308 — это ровно то, во что встаёт «Александра Верещагина» целиком. Шире 1100
  список растёт до 360: место появилось, и отдать его стоит именно ему —
  работа справа от лишних 52 px читается не лучше, а список читается.
-->
<div
  class="flex min-h-0 w-[308px] shrink-0 flex-col border-r border-line min-[1100px]:w-[360px]"
  data-pult-list
>
  {#if held > 0}
    <!--
      Прибита к верху списка, а не вставлена первой строкой: она про то, чего в
      списке ещё нет, и уехать вместе с прокруткой ей нельзя.
    -->
    <button
      type="button"
      class={cn(CAPS, 'flex h-7 shrink-0 items-center justify-center border-b border-line bg-accent text-accent-ink')}
      onclick={onrelease}
    >{tr('room.ui.1320', { count: held })}</button>
  {/if}
  <div
    class="min-h-0 flex-1 overflow-y-auto"
    data-pult-scroll
    onscroll={(event) => onscroll(event.currentTarget.scrollTop)}
  >
    {#each rows as row (row.id)}
      {#if row.kind === 'attempt'}
        <PultRow
          attempt={row.attempt}
          unread={row.unread}
          inGroup={row.inGroup}
          variant={row.variant}
          {names}
          selected={cursor === row.id}
          focused={keyboard && cursor === row.id}
          meaning={rowMeaning(row.attempt, cursor, shown)}
          same={Math.max((sizes.get(row.attempt.groupKey) ?? 1) - 1, 0)}
          onlet={row.attempt.runRequest?.status === 'pending' && !decisionsOff
            ? () => onlet(row.attempt)
            : null}
          onopen={() => onopen(row.id)}
        />
      {:else if row.kind === 'collapsed'}
        <!--
          Свёрнутая группа стоит ПОД первым из совпавших и ниже обычной строки:
          её нельзя выбрать, j и k её перепрыгивают.
        -->
        <button
          type="button"
          class="flex h-10 w-full shrink-0 items-center gap-[9px] border-b border-line px-3 text-left"
          onclick={() => ontoggle(row.groupKey)}
        >
          <span class="flex shrink-0" aria-hidden="true">
            {#each row.faces as face, at (face.participantId)}
              <span
                class="h-5 w-5 shrink-0 rounded-full"
                style:background-color={names ? face.color : 'rgb(var(--line))'}
                style:margin-left={at === 0 ? '0' : '-7px'}
              ></span>
            {/each}
          </span>
          <span class="min-w-0 flex-1 truncate text-2xs text-muted">
            {tr('room.ui.1317', { count: row.rest })}
          </span>
          <span class={cn(CAPS, 'shrink-0 text-accent')}>{tr('room.ui.1315')}</span>
        </button>
      {:else}
        <div class="flex h-7 shrink-0 items-center gap-[9px] border-b border-line bg-surface px-3">
          <span class={cn(CAPS, 'shrink-0 text-faint')}>
            {tr('room.ui.1318', { p0: row.index, p1: row.count })}
          </span>
          <!-- Имя группы — от оракула, а до него первая строка кода: шапка
               обязана сказать, ЧТО написали эти люди, а не только сколько их. -->
          <span class="min-w-0 flex-1 truncate text-2xs text-faint" title={row.label}>{row.label}</span>
          <button type="button" class={cn(CAPS, 'shrink-0 text-accent')} onclick={() => ontoggle(row.groupKey)}>
            {tr('room.ui.1316')}
          </button>
        </div>
      {/if}
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <p class="text-ui-lg font-bold text-muted">{tr('room.ui.1361')}</p>
        <p class="text-2xs text-faint">{tr('room.ui.1362')}</p>
      </div>
    {/each}
  </div>
</div>

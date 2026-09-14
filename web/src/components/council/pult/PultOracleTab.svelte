<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Вкладка «Оракул о классе» — вторая вкладка правой колонки, не третья.
   *
   * Карточка поверх списка закрыла бы ровно те строки, о которых говорит, а
   * третьей колонки на 900 px нет. Вкладка сохраняет главное правило пульта:
   * слева люди, справа слова.
   *
   * Обновляется ТОЛЬКО рукой. Сводка, переписывающаяся сама при каждой сдаче, —
   * это текст, который меняется под глазами читающего вслух; вместо этого она
   * честно устаревает: «с тех пор сдали ещё N» и кнопка.
   *
   * До десяти сдавших кнопка не заливается: оракул не запрещает спросить, но
   * говорит, что смысла мало.
   */
  import type { CouncilAttempt, CouncilOracle } from '@shared/protocol'
  import { oracleState, staleBy } from '@/lib/council-board'
  import { classBar } from '@/lib/council-pult'
  import { clock } from '@/lib/history'
  import { plural } from '@/lib/plural'
  import { cn } from '@/lib/utils'

  interface Props {
    oracle: CouncilOracle | null
    attempts: readonly CouncilAttempt[]
    submitted: number
    names: boolean
    /** Почему спросить нельзя; `null` — можно. */
    askWhy: string | null
    onask: () => void
    onstop: () => void
  }

  let { oracle, attempts, submitted, names, askWhy, onask, onstop }: Props = $props()

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
  const BTN = 'flex h-8 shrink-0 items-center px-3.5 text-2xs font-bold uppercase tracking-label'
  /** Ниже этого оракул скажет то же, что видно глазом. */
  const ENOUGH = 10

  const view = $derived(oracleState(oracle, submitted))
  const behind = $derived(oracle ? staleBy(oracle, submitted) : 0)
  const bar = $derived(classBar(attempts))
  const HEADS = $derived([tr('room.ui.23'), tr('room.ui.24'), tr('room.ui.25')])
</script>

<div class="flex min-h-0 flex-1 flex-col" data-pult-oracle={view}>
  {#if view === 'idle'}
    <div
      class={cn(
        'flex flex-1 flex-col items-center justify-center gap-3.5 px-16 text-center',
        oracle?.error && 'border-l-[3px] border-danger',
      )}
    >
      {#if oracle?.error}
        <p class={cn(CAPS, 'text-danger')}>{oracle.error}</p>
      {/if}
      <p class="text-title font-bold text-muted">
        {submitted < ENOUGH ? tr('room.ui.1368') : tr('room.ui.19')}
      </p>
      <p class="text-ui text-faint">{askWhy ?? tr('room.ui.21')}</p>
      <button
        type="button"
        class={cn(
          BTN,
          submitted < ENOUGH ? 'border border-line text-faint' : 'bg-accent text-accent-ink',
          'disabled:opacity-50',
        )}
        disabled={askWhy !== null}
        onclick={onask}
      >{submitted < ENOUGH ? tr('room.ui.1369') : tr('room.ui.19')}</button>
    </div>
  {:else if view === 'reading'}
    <!-- Четыре полосы-заготовки вместо крутилки: место под ответ уже занято,
         поэтому появление текста ничего не сдвинет. Пульт при этом не заперт. -->
    <div class="flex flex-1 flex-col gap-3 p-4">
      <div class="flex items-center gap-2">
        <span class="h-2 w-2 shrink-0 bg-accent" aria-hidden="true"></span>
        <span class={cn(CAPS, 'text-accent')}>{tr('room.ui.1370', { p0: submitted })}</span>
        <button type="button" class="ml-auto font-mono text-micro text-faint hover:text-ink" onclick={onstop}>
          {tr('room.ui.13')}
        </button>
      </div>
      {#each [100, 80, 92, 46] as width, at (at)}
        <div class="h-2.5 shrink-0 bg-surface" style:width={`${width}%`} aria-hidden="true"></div>
      {/each}
      <div class="flex-1"></div>
      <p class="text-ui text-faint">{tr('room.ui.1373')}</p>
    </div>
  {:else if oracle}
    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <!-- Время и охват первой строкой: ответ всегда о конкретном числе работ. -->
      <p class="shrink-0 font-mono text-micro text-faint">
        {oracle.askedAt === null ? '' : `${clock(oracle.askedAt)} · `}{tr('room.ui.11')} {oracle.basedOn}{names
          ? ''
          : ` · ${tr('room.ui.1354')}`}
      </p>
      {#if oracle.error}
        <p class="shrink-0 text-2xs text-danger">{oracle.error}</p>
      {/if}
      {#each oracle.summary as paragraph, at (at)}
        <div class="flex shrink-0 flex-col gap-0.5">
          {#if HEADS[at]}
            <span class={cn(CAPS, 'text-faint')}>{HEADS[at]}</span>
          {/if}
          <p class="text-ui leading-relaxed text-muted">{paragraph}</p>
        </div>
      {/each}
      <div class="flex shrink-0 flex-col gap-2 pt-1">
        <span class={cn(CAPS, 'text-faint')}>{tr('room.ui.1372')}</span>
        <div class="flex h-[22px] shrink-0 gap-0.5" aria-hidden="true">
          <div class="bg-positive" style:flex-grow={bar.correct}></div>
          <div class="bg-warning" style:flex-grow={bar.wrong}></div>
          <div class="bg-danger" style:flex-grow={bar.failed}></div>
          <div class="bg-faint" style:flex-grow={bar.ran + bar.unrun}></div>
          <div class="bg-line" style:flex-grow={bar.writing}></div>
        </div>
        <p class="font-mono text-micro text-faint">
          {bar.correct} · {bar.wrong} · {bar.failed} · {bar.writing} — {tr('room.ui.1384')}
        </p>
      </div>
    </div>
    <div class="flex h-14 shrink-0 items-center gap-2.5 border-t border-line bg-surface px-4">
      <button
        type="button"
        class={cn(BTN, 'border border-line text-ink disabled:text-faint')}
        disabled={askWhy !== null}
        onclick={onask}
      >{tr('room.ui.1371')}</button>
      <span class={cn('min-w-0 flex-1 truncate text-2xs', behind > 0 ? 'text-warning' : 'text-faint')}>
        {#if behind > 0}
          {tr('room.ui.14')}
          {plural(behind, tr('room.ui.15'), tr('room.ui.16'), tr('room.ui.16'))}
          {tr('room.ui.17')}
          {behind}
        {:else}{askWhy ?? ''}{/if}
      </span>
    </div>
  {/if}
</div>

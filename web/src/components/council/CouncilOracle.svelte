<script lang="ts">
  /**
   * «Оракул о N решениях» — блок над сводкой, четыре состояния.
   *
   * Обновляется ТОЛЬКО рукой. Сводка, которая переписывается сама при каждой
   * сдаче, — это текст, который меняется под глазами читающего вслух; вместо
   * этого блок честно устаревает: «с тех пор сдали ещё 12» и кнопка. Каждый
   * вопрос — один из лимита комнаты, и кнопка это говорит.
   *
   * Компонент чистый: состояние приезжает пропсом, нажатия уходят наверх.
   */
  import type { CouncilOracle } from '@shared/protocol'
  import Icon from '@/components/ui/Icon.svelte'
  import { clock } from '@/lib/history'
  import { oracleState, staleBy } from '@/lib/council-board'
  import { plural } from '@/lib/plural'
  import { cn } from '@/lib/utils'

  interface Props {
    oracle: CouncilOracle | null
    /** Сколько сдали сейчас — для «о N решениях» и для устаревания. */
    submitted: number
    /** Почему спросить нельзя (оракул выключен, лимит исчерпан); `null` — можно. */
    askWhy?: string | null
    onask: () => void
    onstop: () => void
  }

  let { oracle, submitted, askWhy = null, onask, onstop }: Props = $props()

  const view = $derived(oracleState(oracle, submitted))
  const behind = $derived(oracle ? staleBy(oracle, submitted) : 0)
  const canAsk = $derived(askWhy === null && submitted > 0)

  /** Три абзаца сводки под своими подписями: что верно, типичная ошибка, что показать. */
  const HEADS = ['Что верно', 'Типичная ошибка', 'Что показать']
</script>

<section
  class={cn(
    'flex flex-col gap-2.5 px-3 py-2.5',
    view === 'idle' ? 'border border-dashed border-line' : 'border border-line bg-surface',
  )}
  aria-label="Оракул о решениях"
>
  <div class="flex flex-wrap items-center gap-2">
    <Icon name="sparkles" size={13} class="shrink-0 text-accent-text" />
    <span class="text-2xs font-bold uppercase tracking-label text-ink">
      Оракул о {submitted} {plural(submitted, 'решении', 'решениях', 'решениях')}
    </span>
    {#if oracle?.askedAt && view !== 'reading'}
      <span class="font-mono text-2xs text-muted">{clock(oracle.askedAt)} · читал {oracle.basedOn}</span>
    {/if}
    <span class="ml-auto flex items-center gap-2">
      {#if view === 'reading'}
        <Icon name="spinner" size={13} class="animate-spin text-accent-text/70" />
        <span class="text-2xs text-muted">читает…</span>
        <button type="button" class="btn-ghost h-7 px-2 text-2xs" onclick={onstop}>
          <Icon name="stop" size={12} />
          Стоп
        </button>
      {:else if view === 'stale'}
        <span class="text-2xs text-warning">
          с тех пор {plural(behind, 'сдал', 'сдали', 'сдали')} ещё {behind}
        </span>
        <button
          type="button"
          class="btn-outline h-7 px-2 text-2xs"
          disabled={!canAsk}
          title={askWhy ?? undefined}
          onclick={onask}
        >
          <Icon name="restart" size={12} />
          Обновить · 1 вопрос
        </button>
      {:else if view === 'idle'}
        <button
          type="button"
          class="btn-outline h-7 px-2 text-2xs"
          disabled={!canAsk}
          title={askWhy ?? undefined}
          onclick={onask}
        >
          <Icon name="sparkles" size={12} />
          Спросить · 1 вопрос
        </button>
      {/if}
    </span>
  </div>

  {#if view === 'reading'}
    <!-- Бегущая полоса без процентов: сколько читать, не знает никто. -->
    <div class="relative h-0.5 overflow-hidden bg-line" aria-hidden="true">
      <div class="council-run absolute inset-y-0 w-1/3 bg-accent"></div>
    </div>
  {:else if view === 'idle'}
    <p class="text-2xs text-muted">
      {#if oracle?.error}
        <span class="text-danger">{oracle.error}</span>
      {:else if askWhy}
        {askWhy}
      {:else if submitted === 0}
        спрашивать пока не о чём — никто не сдал
      {:else}
        сложит сданное по группам, назовёт типичную ошибку и предложит, что показать · читает
        тексты, без имён
      {/if}
    </p>
  {:else if oracle}
    <!--
      «Обновить» не вышло — прежняя сводка вернулась, и причина стоит над ней.
      Без строки преподаватель видел ровно то, что было до нажатия, а вопрос из
      лимита уже списан: пять нажатий — пять вопросов без единого слова о том,
      почему ответа нет.
    -->
    {#if oracle.error}
      <p class="text-2xs text-danger">{oracle.error}</p>
    {/if}
    <div class="flex flex-col gap-2">
      {#each oracle.summary as paragraph, index (index)}
        <div class="flex flex-col gap-0.5">
          {#if HEADS[index]}
            <span class="text-2xs font-bold uppercase tracking-label text-muted">{HEADS[index]}</span>
          {/if}
          <p class="text-ui leading-relaxed text-ink">{paragraph}</p>
        </div>
      {/each}
    </div>
    <p class="text-2xs text-muted">читал тексты, без имён</p>
  {/if}
</section>

<style>
  /*
   * Полоса и правда бежит. `animate-pulse` двигал одну opacity — кусок стоял
   * слева и мигал, а комментарий рядом обещал бегущую; остановившийся указатель
   * читается как зависший (index.css). Только transform, ровный шаг и петля:
   * ожидание без процентов не ускоряется и не замедляется.
   */
  .council-run {
    animation: council-run 1.4s linear infinite;
  }

  @keyframes council-run {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }
</style>

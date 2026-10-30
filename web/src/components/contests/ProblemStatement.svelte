<!--
  A problem's statement (K1, K5): the letter and the title, the limits line,
  the teacher's markdown with $…$ formulas, and the examples with «копировать».

  The statement is someone else's markup: it goes through the one sanitizer
  of the product (lib/render.svelte.ts) before {@html}, as a note in a room
  does, and until the renderer's chunk lands it is shown as plain text — the
  problem can be read before it is pretty.

  The examples are tests marked as such (shared/contests.ts · ContestTest),
  not text in the statement: they are the same bytes the judge runs, so what
  «копировать» puts in the clipboard is exactly the first test's input.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { EntrantProblem } from '@shared/contests-entrant'
  import { copyText } from '@/lib/clipboard'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { checkerWords, limitMemory, limitsLine, limitTime, samplesNote } from '@/lib/contest-words'

  interface Props {
    problem: EntrantProblem
    phone?: boolean
  }

  const { problem, phone = false }: Props = $props()

  void loadRenderers().catch(() => undefined)
  const render = $derived(renderers())
  const html = $derived(render && problem.statement.trim() ? render.markdown(problem.statement) : null)

  /** Which copy button last worked or failed: `<ordinal>:in` / `<ordinal>:out`. */
  let copied = $state<string | null>(null)
  let failed = $state<string | null>(null)

  async function copy(key: string, text: string): Promise<void> {
    failed = null
    try {
      await copyText(text)
      copied = key
      setTimeout(() => {
        if (copied === key) copied = null
      }, 1500)
    } catch {
      failed = key
    }
  }

  function copyWord(key: string, truncated: boolean): string {
    if (copied === key) return tr('contests.p.copied')
    if (failed === key) return tr('contests.p.copyFailed')
    return tr(truncated ? 'contests.p.copyPart' : 'contests.p.copy')
  }
</script>

{#snippet copyButton(key: string, text: string, truncated: boolean, label: string)}
  <button
    class="text-micro leading-4 text-accent-text hover:underline {failed === key ? 'text-danger' : ''}"
    type="button"
    aria-label={label}
    onclick={() => void copy(key, text)}
  >
    {copyWord(key, truncated)}
  </button>
{/snippet}

<article class="flex min-w-0 flex-col {phone ? 'gap-3' : 'gap-[22px]'}">
  <header class="flex flex-col gap-3 {phone ? '' : 'border-b border-line pb-[18px]'}">
    <h2 class="flex items-baseline {phone ? 'gap-2.5' : 'gap-3.5'}">
      <span class="font-mono font-bold text-faint {phone ? 'text-[20px] leading-6' : 'text-[26px] leading-8'}">{problem.letter}</span>
      <span class="font-black tracking-[-0.02em] text-ink {phone ? 'text-[24px] leading-7' : 'text-[30px] leading-[34px]'}">{problem.title}</span>
    </h2>
    {#if phone}
      <p class="text-2xs text-muted">{limitsLine(problem)}</p>
    {:else}
      <dl class="flex flex-wrap gap-x-[22px] gap-y-1 text-2xs text-muted">
        <div class="flex gap-1">
          <dt>{tr('contests.p.limitTime')}</dt>
          <dd class="font-mono font-semibold text-ink">{limitTime(problem.timeLimitMs)}</dd>
        </div>
        <div class="flex gap-1">
          <dt>{tr('contests.p.limitMemory')}</dt>
          <dd class="font-mono font-semibold text-ink">{limitMemory(problem.memoryMb)}</dd>
        </div>
        <div class="flex gap-1">
          <dt>{tr('contests.p.limitIo')}</dt>
          <dd class="font-mono font-semibold text-ink">{tr('contests.p.ioStandard')}</dd>
        </div>
        <div class="flex gap-1">
          <dt>{tr('contests.p.limitChecker')}</dt>
          <dd class="font-mono font-semibold text-ink">{checkerWords(problem.checker, problem.checkerEpsilon)}</dd>
        </div>
      </dl>
    {/if}
  </header>

  {#if !problem.statement.trim()}
    <p class="text-ui text-muted">{tr('contests.p.noStatement')}</p>
  {:else if html}
    <div class="prose-note prose-cell max-w-[760px] {phone ? '!text-[15px] !leading-[23px]' : ''}">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      {@html html}
    </div>
  {:else}
    <pre class="max-w-[760px] whitespace-pre-wrap font-sans text-[16px] leading-[25px] text-ink">{problem.statement}</pre>
  {/if}

  {#if problem.samples.length > 0}
    <section class="flex flex-col gap-2.5" aria-labelledby="contest-samples-{problem.id}">
      {#if !phone}
        <h3 id="contest-samples-{problem.id}" class="text-[17px] font-bold leading-[22px] text-ink">{tr('contests.p.examples')}</h3>
      {:else}
        <h3 id="contest-samples-{problem.id}" class="sr-only">{tr('contests.p.examples')}</h3>
      {/if}
      {#each problem.samples as sample, index (sample.ordinal)}
        {@const n = index + 1}
        {#if phone}
          <!-- K5: the input over the output, one column. -->
          <div class="flex flex-col border border-line">
            <div class="flex items-center justify-between gap-3 border-b border-line bg-surface px-2.5 py-[7px]">
              <span class="text-micro font-black uppercase leading-[14px] tracking-label text-muted">
                {tr('contests.p.exampleInput', { n })}
              </span>
              {@render copyButton(`${sample.ordinal}:in`, sample.input, sample.truncated, tr('contests.p.copyInput', { n }))}
            </div>
            <pre class="overflow-x-auto px-2.5 py-2 font-mono text-[13px] leading-[19px] text-ink">{sample.input}</pre>
            <div class="flex items-center justify-between gap-3 border-y border-line bg-surface px-2.5 py-[7px]">
              <span class="text-micro font-black uppercase leading-[14px] tracking-label text-muted">{tr('contests.p.output')}</span>
              {@render copyButton(`${sample.ordinal}:out`, sample.answer, sample.truncated, tr('contests.p.copyOutput', { n }))}
            </div>
            <pre class="overflow-x-auto px-2.5 py-2 font-mono text-[13px] leading-[19px] text-ink">{sample.answer}</pre>
          </div>
        {:else}
          <div class="flex border border-line">
            <div class="flex min-w-0 flex-1 flex-col border-r border-line">
              <div class="flex items-center justify-between gap-3 border-b border-line bg-surface px-3 py-2">
                <span class="text-micro font-black uppercase leading-[14px] tracking-label text-muted">{tr('contests.p.input')}</span>
                {@render copyButton(`${sample.ordinal}:in`, sample.input, sample.truncated, tr('contests.p.copyInput', { n }))}
              </div>
              <pre class="overflow-x-auto px-3 py-2.5 font-mono text-[13px] leading-5 text-ink">{sample.input}</pre>
            </div>
            <div class="flex w-[180px] shrink-0 flex-col">
              <div class="flex items-center justify-between gap-3 border-b border-line bg-surface px-3 py-2">
                <span class="text-micro font-black uppercase leading-[14px] tracking-label text-muted">{tr('contests.p.output')}</span>
                {@render copyButton(`${sample.ordinal}:out`, sample.answer, sample.truncated, tr('contests.p.copyOutput', { n }))}
              </div>
              <pre class="overflow-x-auto px-3 py-2.5 font-mono text-[13px] leading-5 text-ink">{sample.answer}</pre>
            </div>
          </div>
        {/if}
        {#if sample.truncated}
          <p class="text-micro leading-[18px] text-warning">{tr('contests.p.truncated')}</p>
        {/if}
      {/each}
      {#if !phone}
        <p class="text-2xs leading-[19px] text-muted">{samplesNote(problem.samples)}</p>
      {/if}
    </section>
  {/if}
</article>

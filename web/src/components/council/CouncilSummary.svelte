<script lang="ts">
  /**
   * Сводка консилиума — взгляд сверху: группы одинаковых решений списком.
   *
   * Строка группы отвечает на один вопрос преподавателя — «сколько человек
   * написали ЭТО и что с ними делать»: число, чип состояния, имя группы (от
   * оракула или первая строка кода), код представителя и три действия. Редкие
   * группы свёрнуты одной строкой, чтобы двадцать одиночных ответов не
   * выглядели как двадцать решений.
   *
   * Компонент чистый: стопка и группы приходят пропсами, действия уходят наверх.
   */
  import type { CouncilBoard, CouncilGroup } from '@shared/protocol'
  import Code from '@/components/ui/Code.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { groupTitle, splitRare, statusLabel, toneOf, type StripTone } from '@/lib/council-board'
  import { plural } from '@/lib/plural'
  import { cn } from '@/lib/utils'
  import CouncilOracle from './CouncilOracle.svelte'
  import CouncilReplyDraft from './CouncilReplyDraft.svelte'

  interface Props {
    board: CouncilBoard
    /** Группы, уже посчитанные стопкой (council-board.ts · groupAttempts) — один расчёт на оба вида. */
    groups: CouncilGroup[]
    askWhy?: string | null
    onshow: (participantId: string) => void
    onreply: (to: { participantId: string } | { groupKey: string }, text: string) => void
    onposition: (participantId: string) => void
    ontoggle: (view: 'stack' | 'summary') => void
    onask: () => void
    onstop: () => void
  }

  let { board, groups, askWhy = null, onshow, onreply, onposition, ontoggle, onask, onstop }: Props =
    $props()

  const split = $derived(splitRare(groups, board.counts.submitted))
  let rareOpen = $state(false)
  /** Ключ группы, которой сейчас пишут ответ; одна за раз. */
  let replying = $state<string | null>(null)

  const CHIP: Record<StripTone, string> = {
    ok: 'text-positive',
    error: 'text-warning',
    fail: 'text-danger',
    none: 'text-muted',
  }

  function draftOf(group: CouncilGroup): string {
    return board.oracle?.drafts[group.key] ?? ''
  }

  function toStack(group: CouncilGroup): void {
    onposition(group.representative)
    ontoggle('stack')
  }
</script>

<div class="flex flex-col gap-3">
  <CouncilOracle
    oracle={board.oracle}
    submitted={board.counts.submitted}
    {askWhy}
    {onask}
    {onstop}
  />

  {#if groups.length === 0}
    <p class="border border-dashed border-line px-3 py-4 text-center text-2xs text-muted">
      {#if board.counts.writing > 0}
        ещё никто не сдал — {board.counts.writing}
        {plural(board.counts.writing, 'пишет', 'пишут', 'пишут')}
      {:else}
        попыток пока нет
      {/if}
    </p>
  {:else}
    <ol class="flex flex-col gap-2" aria-label="Группы решений">
      {#snippet row(group: CouncilGroup)}
        <li class="flex flex-col border border-line bg-surface">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2">
            <span class="font-mono text-title tabular-nums text-ink">{group.count}</span>
            <span class="text-2xs text-muted">{plural(group.count, 'так же', 'так же', 'так же')}</span>
            <span
              class={cn(
                'inline-flex h-5 items-center bg-raised px-1.5 font-mono text-2xs',
                CHIP[toneOf(group.status)],
              )}
            >
              {statusLabel({ status: group.status, run: null })}
            </span>
            <span class="min-w-0 flex-1 truncate text-ui font-semibold text-ink" title={groupTitle(group)}>
              {groupTitle(group)}
            </span>
          </div>
          <div class="max-h-48 overflow-auto px-3 py-2">
            <Code code={group.sample} />
          </div>
          <div class="flex flex-wrap items-center gap-2 border-t border-line-soft px-3 py-2">
            <!-- «На экране» — если показывали любого из группы: текст у них один. -->
            {#if group.shown}
              <button type="button" class="btn-outline h-8" onclick={() => onshow(group.representative)}>
                <Icon name="check" size={13} class="text-positive" />
                На экране · показать снова
              </button>
            {:else}
              <button type="button" class="btn-primary h-8" onclick={() => onshow(group.representative)}>
                Показать классу
              </button>
            {/if}
            <button type="button" class="btn-ghost h-8" onclick={() => toStack(group)}>
              Открыть попытку
              <Icon name="chevron-right" size={13} />
            </button>
            <button
              type="button"
              class="btn-ghost h-8"
              aria-expanded={replying === group.key}
              onclick={() => (replying = replying === group.key ? null : group.key)}
            >
              Ответить {group.count}
              {#if draftOf(group)}
                <span class="text-2xs text-accent-text">· черновик</span>
              {/if}
            </button>
          </div>
          {#if replying === group.key}
            <CouncilReplyDraft
              to="всем {group.count}"
              initial={draftOf(group)}
              fromOracle={draftOf(group) !== ''}
              onsend={(text) => {
                onreply({ groupKey: group.key }, text)
                replying = null
              }}
              oncancel={() => (replying = null)}
            />
          {/if}
        </li>
      {/snippet}

      {#each split.main as group (group.key)}
        {@render row(group)}
      {/each}

      {#if split.rare.length > 0}
        <li class="flex flex-col gap-2">
          <button
            type="button"
            class="flex h-8 w-full items-center gap-2 border border-dashed border-line px-3 text-left
                   text-2xs text-muted transition-colors duration-[var(--speed-quick)] hover:border-faint
                   hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-expanded={rareOpen}
            onclick={() => (rareOpen = !rareOpen)}
          >
            <Icon name={rareOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            <span class="font-bold uppercase tracking-label">Малые группы</span>
            <span class="font-mono tabular-nums">{split.rare.map((g) => g.count).join(' · ')}</span>
            <span class="ml-auto">
              {split.rare.length}
              {plural(split.rare.length, 'группа', 'группы', 'групп')}
            </span>
          </button>
          {#if rareOpen}
            <ol class="flex flex-col gap-2 pl-3">
              {#each split.rare as group (group.key)}
                {@render row(group)}
              {/each}
            </ol>
          {/if}
        </li>
      {/if}
    </ol>
  {/if}
</div>

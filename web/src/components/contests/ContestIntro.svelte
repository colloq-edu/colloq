<!--
  The contest's first page (`/a/<slug>` without a letter), when there is
  something to say before the problems: the countdown to a start that has
  not come (the door sends no problems before it), and the teacher's
  description — the rules of the class, what may be used.

  Without either, the first page is simply problem A (ContestScreen), and
  nobody is made to click past an empty one.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { tr } from '@shared/i18n'
  import { contestPhase } from '@shared/contests'
  import type { EntrantContestView } from '@shared/contests-entrant'
  import { dateOf, clockOf, remainingClock } from '@/lib/competition-words'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import { contestRoutePath } from '@/lib/routes'

  interface Props {
    view: EntrantContestView
    serverNow: number
    phone: boolean
    onnavigate: (path: string) => void
    /** The join step, for someone not in the contest yet. */
    join?: Snippet
  }

  const { view, serverNow, phone, onnavigate, join }: Props = $props()

  const phase = $derived(contestPhase(view.contest, serverNow))
  const soon = $derived(phase === 'soon' && view.contest.startsAt !== null)
  const first = $derived(view.problems[0] ?? null)

  void loadRenderers().catch(() => undefined)
  const render = $derived(renderers())
  const description = $derived(view.contest.description.trim())
  const html = $derived(render && description ? render.markdown(description) : null)

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    onnavigate(path)
  }
</script>

<div class="flex min-w-0 flex-col gap-7 {phone ? 'px-4 py-5' : ''}">
  {#if soon && view.contest.startsAt !== null}
    <div class="flex flex-col gap-1 border-t-2 border-ink pt-5">
      <span class="text-micro font-black uppercase leading-5 tracking-label text-muted">{tr('contests.p.startsIn')}</span>
      <span class="font-mono font-bold text-ink {phone ? 'text-[34px] leading-10' : 'text-[48px] leading-[52px]'}">
        {remainingClock(view.contest.startsAt - serverNow)}
      </span>
      <span class="text-2xs text-muted">
        {tr('contests.p.startsAt', { date: `${dateOf(view.contest.startsAt)}, ${clockOf(view.contest.startsAt)}` })}
      </span>
      <p class="pt-3 text-ui text-muted">{tr('contests.p.problemsHidden')}</p>
    </div>
  {/if}

  {#if description}
    {#if html}
      <div class="prose-note prose-cell max-w-[760px]">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html html}
      </div>
    {:else}
      <pre class="max-w-[760px] whitespace-pre-wrap font-sans text-[16px] leading-[26px] text-ink">{description}</pre>
    {/if}
  {/if}

  {#if first}
    {@const path = contestRoutePath({ slug: view.contest.slug, view: 'problems', letter: first.letter })}
    <a
      class="self-start bg-primary px-6 py-3 text-micro font-black uppercase leading-4 tracking-label text-primary-ink no-underline hover:brightness-110"
      href={path}
      onclick={(event) => go(event, path)}
    >
      {tr('contests.p.toProblem', { letter: first.letter })}
    </a>
  {:else if !soon}
    <p class="text-ui text-muted">{tr('contests.p.noProblems')}</p>
  {/if}

  {#if join}
    <div class="max-w-[900px]">{@render join()}</div>
  {/if}
</div>

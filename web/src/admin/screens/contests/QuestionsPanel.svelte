<!--
  The console's «Вопросы» tab: the questions waiting for an answer first —
  oldest first, since whoever asked first has waited longest — then what is
  answered and every announcement. On top, the composer for an announcement:
  a fix to a statement in the middle of the test is said to the whole class
  at once, about a problem or about the contest.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import EmptyState from '@/admin/ui/EmptyState.svelte'
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import QuestionCard from './QuestionCard.svelte'
  import { CONTEST_LIMITS } from '@shared/contests'
  import type { AdminQuestion, AdminQuestions, ContestView } from '@shared/contests-api'
  import { sortQuestions, waitsForAnswer } from '@/admin/contests'

  interface Props {
    questions: AdminQuestions | null
    view: ContestView
    zone: string | null
    now: number
    busy?: boolean
    onanswer: (question: AdminQuestion, answer: string, toEveryone: boolean) => void
    ondelete: (question: AdminQuestion) => void
    /** Resolves true when the announcement went out: the composer is emptied then, not before. */
    onannounce: (text: string, problemId: string | null) => Promise<boolean>
  }

  let { questions, view, zone, now, busy = false, onanswer, ondelete, onannounce }: Props = $props()

  let text = $state('')
  let problemId = $state('')

  const sorted = $derived(sortQuestions(questions?.questions ?? []))
  const waiting = $derived(sorted.filter((one) => waitsForAnswer(one)))
  const done = $derived(sorted.filter((one) => !waitsForAnswer(one)))
  const problems = $derived([...view.problems].sort((a, b) => a.position - b.position))

  async function announce(): Promise<void> {
    const body = text.trim()
    if (!body || busy) return
    if (await onannounce(body, problemId || null)) {
      text = ''
      problemId = ''
    }
  }
</script>

<div class="flex flex-col gap-6 py-5">
  <form
    class="flex flex-col gap-2.5 border border-line bg-surface px-4 py-3.5"
    onsubmit={(event) => {
      event.preventDefault()
      void announce()
    }}
  >
    <span class="admin-label text-primary">{tr('admin.contests.announce.head')}</span>
    <textarea
      class="field min-h-[72px] resize-y py-2"
      aria-label={tr('admin.contests.announce.head')}
      placeholder={tr('admin.contests.announce.placeholder')}
      maxlength={CONTEST_LIMITS.answer}
      bind:value={text}
    ></textarea>
    <div class="flex flex-wrap items-center gap-2.5">
      <select class="field w-auto min-w-0" aria-label={tr('admin.contests.announce.problem')} bind:value={problemId}>
        <option value="">{tr('admin.contests.announce.general')}</option>
        {#each problems as problem (problem.id)}
          <option value={problem.id}>{problem.letter}. {problem.title}</option>
        {/each}
      </select>
      <span class="min-w-0 flex-1 basis-[200px] text-micro text-muted">{tr('admin.contests.announce.hint')}</span>
      <button type="submit" class="btn-primary" disabled={busy || !text.trim()}>{tr('admin.contests.announce.send')}</button>
    </div>
  </form>

  {#if questions === null}
    <RowsSkeleton label={tr('admin.contests.questions.loading')} />
  {:else if sorted.length === 0}
    <EmptyState title={tr('admin.contests.questions.none')} hint={tr('admin.contests.questions.noneHint')} />
  {:else}
    {#if waiting.length > 0}
      <div class="flex flex-col gap-3">
        <p class="admin-section">
          <span class="admin-section-title">{tr('admin.contests.questions.waiting')}</span>
          <span class="font-mono text-micro text-danger">{waiting.length}</span>
        </p>
        {#each waiting as question (question.id)}
          <QuestionCard
            {question}
            {zone}
            {now}
            {busy}
            highlight
            onanswer={(answer, toEveryone) => onanswer(question, answer, toEveryone)}
            ondelete={() => ondelete(question)}
          />
        {/each}
      </div>
    {/if}
    {#if done.length > 0}
      <div class="flex flex-col gap-3">
        <p class="admin-section">
          <span class="admin-section-title">{tr('admin.contests.questions.done')}</span>
          <span class="font-mono text-micro text-muted">{done.length}</span>
        </p>
        {#each done as question (question.id)}
          <QuestionCard
            {question}
            {zone}
            {now}
            {busy}
            onanswer={(answer, toEveryone) => onanswer(question, answer, toEveryone)}
            ondelete={() => ondelete(question)}
          />
        {/each}
      </div>
    {/if}
  {/if}
</div>

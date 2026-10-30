<!--
  A participant's question with the teacher's answer (Paper 19 · A4): asked
  about a problem or the contest, by whom, when; answered to the asker alone
  («Ответить лично») or to everyone («Ответить всем», when the answer is news
  for the whole class — then the question and the answer become an
  announcement). An announcement made from the composer has no question and
  is drawn as one.

  The asker's name is the teacher's to see: the class reads a public answer
  without it (shared/contests-entrant.ts · ContestQuestion has no name).
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { cn } from '@/lib/utils'
  import { CONTEST_LIMITS } from '@shared/contests'
  import type { AdminQuestion } from '@shared/contests-api'
  import { momentOf, waitsForAnswer } from '@/admin/contests'

  interface Props {
    question: AdminQuestion
    zone: string | null
    now: number
    busy?: boolean
    /** The card of the console's first tab: framed in the live accent, as A4 draws the one waiting. */
    highlight?: boolean
    onanswer: (answer: string, toEveryone: boolean) => void
    ondelete?: () => void
  }

  let { question, zone, now, busy = false, highlight = false, onanswer, ondelete }: Props = $props()

  const announcement = $derived(question.question.trim() === '')
  const waiting = $derived(waitsForAnswer(question))
  let editing = $state(false)
  let draft = $state('')
  let draftFor: string | null = null

  $effect(() => {
    if (draftFor === question.id) return
    draftFor = question.id
    draft = question.answer ?? ''
    editing = false
  })

  const open = $derived(!announcement && (waiting || editing))

  function send(toEveryone: boolean): void {
    const text = draft.trim()
    if (!text || busy) return
    onanswer(text, toEveryone)
    editing = false
  }
</script>

<div class={cn('flex flex-col gap-2.5 border bg-canvas p-3.5', highlight ? 'border-accent' : 'border-line')}>
  <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
    <span class={cn('admin-label', waiting ? 'text-accent-text' : announcement || question.public ? 'text-primary' : 'text-muted')}>
      {#if announcement}
        {tr('admin.contests.question.announcement')}
      {:else}
        {tr('admin.contests.question.head')}
      {/if}
      {#if question.letter}· {tr('admin.contests.question.problem', { letter: question.letter })}{/if}
      · {momentOf(announcement ? (question.answeredAt ?? question.askedAt) : question.askedAt, now, zone)}
    </span>
    {#if question.entrant}
      <span class="text-micro text-muted">{question.entrant.name}</span>
    {/if}
  </div>

  {#if !announcement}
    <p class="whitespace-pre-wrap break-words text-ui text-ink">{question.question}</p>
  {/if}

  {#if open}
    <textarea
      class="field min-h-[72px] resize-y py-2"
      aria-label={tr('admin.contests.question.answerLabel')}
      placeholder={tr('admin.contests.question.answerPlaceholder')}
      maxlength={CONTEST_LIMITS.answer}
      bind:value={draft}
    ></textarea>
    <div class="flex flex-wrap items-center justify-end gap-2">
      {#if editing}
        <button type="button" class="btn-ghost mr-auto" onclick={() => ((editing = false), (draft = question.answer ?? ''))}>
          {tr('admin.cancel')}
        </button>
      {/if}
      <button type="button" class="btn-outline" disabled={busy || !draft.trim()} onclick={() => send(false)}>
        {tr('admin.contests.question.private')}
      </button>
      <button type="button" class="btn-primary" disabled={busy || !draft.trim()} onclick={() => send(true)}>
        {tr('admin.contests.question.public')}
      </button>
    </div>
  {:else}
    <p class={cn('whitespace-pre-wrap break-words border-l-[3px] px-3 py-1 text-ui text-ink', question.public ? 'border-primary' : 'border-line')}>
      {question.answer}
    </p>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
      {#if !announcement}
        <span class="text-micro text-muted">
          {question.public ? tr('admin.contests.question.answeredPublic') : tr('admin.contests.question.answeredPrivate')}
        </span>
        <button type="button" class="admin-link" disabled={busy} onclick={() => (editing = true)}>
          {tr('admin.contests.question.edit')}
        </button>
      {/if}
      {#if ondelete}
        <button type="button" class="ml-auto text-2xs text-muted hover:text-danger disabled:text-faint" disabled={busy} onclick={ondelete}>
          {tr('admin.contests.question.delete')}
        </button>
      {/if}
    </div>
  {/if}
</div>

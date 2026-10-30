<!--
  The questions tab: the teacher's announcements and the person's own
  questions with their answers, newest event first, and the form to ask.

  No mockup draws it; it speaks the board's language — the uppercase label
  over each entry, the accent for what the teacher said to everyone, plain
  text for what people typed (never markup: a question is someone's words,
  and «<b>» in it is two letters and a bracket).

  The tab being open is the person reading it: the screen tells the door
  («…/questions/seen») and the dot beside «Вопросы» goes out.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { tr } from '@shared/i18n'
  import { CONTEST_LIMITS } from '@shared/contests'
  import type { ContestQuestion, EntrantProblem } from '@shared/contests-entrant'
  import { whenWords } from '@/lib/competition-words'
  import { questionsOrder } from '@/lib/contest-words'

  interface Props {
    questions: ContestQuestion[]
    problems: EntrantProblem[]
    joined: boolean
    busy: boolean
    refusal: string | null
    now: number
    phone: boolean
    /** Resolves true once the door took the question: the form empties then, not before. */
    onask: (problemId: string | null, question: string) => Promise<boolean>
    /** The join step, in place of the form, for someone not in the contest. */
    join?: Snippet
  }

  const { questions, problems, joined, busy, refusal, now, phone, onask, join }: Props = $props()

  const ordered = $derived(questionsOrder(questions))
  let about = $state('')
  let text = $state('')

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const question = text.trim()
    if (!question || busy) return
    if (await onask(about === '' ? null : about, question)) text = ''
  }

  function label(question: ContestQuestion): string {
    if (!question.question) return tr('contests.p.announcement')
    return tr(question.mine ? 'contests.p.yourQuestion' : 'contests.p.question')
  }
</script>

<div class="flex flex-col gap-8 {phone ? '' : 'xl:flex-row xl:items-start xl:gap-12'}">
  <section class="flex min-w-0 grow flex-col" aria-labelledby="contest-questions-title">
    <h2 id="contest-questions-title" class="border-b-2 border-ink pb-2.5 text-micro font-black uppercase leading-5 tracking-label text-muted">
      {tr('contests.p.questionsTitle')}
    </h2>
    {#if ordered.length === 0}
      <p class="py-6 text-ui text-muted">{tr('contests.p.noQuestions')}</p>
    {/if}
    <ul class="flex flex-col">
      {#each ordered as question (question.id)}
        {@const announcement = !question.question}
        <li class="flex flex-col gap-2 border-b border-line py-4 {announcement ? 'border-l-[3px] border-l-accent pl-4' : ''}">
          <p class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="text-micro font-black uppercase leading-5 tracking-label {announcement ? 'text-accent-text' : 'text-muted'}">
              {label(question)}
            </span>
            {#if question.letter}
              <span class="font-mono text-[12px] font-bold text-faint">{tr('contests.p.aboutProblem', { letter: question.letter })}</span>
            {/if}
            <span class="text-micro text-muted">{whenWords(question.answeredAt ?? question.askedAt, now)}</span>
          </p>
          {#if announcement}
            <p class="whitespace-pre-wrap text-ui leading-6 text-ink">{question.answer ?? ''}</p>
          {:else}
            <p class="whitespace-pre-wrap text-ui leading-6 text-ink">{question.question}</p>
            {#if question.answer}
              <div class="flex flex-col gap-1 border-l-2 border-positive pl-3.5">
                <span class="text-micro font-bold leading-5 text-positive">
                  {tr('contests.p.answer')}{#if question.public && question.mine}{' · '}{tr('contests.p.answerToAll')}{/if}
                </span>
                <p class="whitespace-pre-wrap text-ui leading-6 text-ink">{question.answer}</p>
              </div>
            {:else}
              <span class="text-micro text-muted">{tr('contests.p.waiting')}</span>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <aside class="flex w-full shrink-0 flex-col gap-3 {phone ? '' : 'xl:w-[400px]'}" aria-labelledby="contest-ask-title">
    <h2 id="contest-ask-title" class="border-b-2 border-ink pb-2.5 text-micro font-black uppercase leading-5 tracking-label text-muted">
      {tr('contests.p.askTitle')}
    </h2>
    {#if !joined}
      <p class="text-2xs leading-5 text-muted">{tr('contests.p.askJoin')}</p>
      {#if join}{@render join()}{/if}
    {:else}
      <p class="text-2xs leading-5 text-muted">{tr('contests.p.askHint')}</p>
      <form class="flex flex-col gap-3" onsubmit={submit}>
        <label class="flex flex-col gap-1.5">
          <span class="text-2xs font-bold text-ink">{tr('contests.p.askAbout')}</span>
          <select class="h-10 border border-line bg-canvas px-2.5 text-ui text-ink" bind:value={about}>
            <option value="">{tr('contests.p.askGeneral')}</option>
            {#each problems as problem (problem.id)}
              <option value={problem.id}>{problem.letter} · {problem.title}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-2xs font-bold text-ink">{tr('contests.p.askText')}</span>
          <textarea
            class="min-h-[120px] resize-y border border-line bg-canvas px-3 py-2 text-ui leading-6 text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            placeholder={tr('contests.p.askPlaceholder')}
            maxlength={CONTEST_LIMITS.question}
            bind:value={text}
          ></textarea>
        </label>
        {#if refusal}
          <p class="text-micro leading-[18px] text-danger" role="alert">{refusal}</p>
        {/if}
        <button
          class="self-start bg-primary px-6 py-3 text-micro font-black uppercase leading-4 tracking-label text-primary-ink hover:brightness-110 disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted disabled:hover:brightness-100"
          type="submit"
          disabled={busy || !text.trim()}
        >
          {busy ? tr('contests.p.asking') : tr('contests.p.ask')}
        </button>
      </form>
    {/if}
  </aside>
</div>

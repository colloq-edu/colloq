<script lang="ts">
  import { tr } from '@shared/i18n'
  import Avatar from '@/components/ui/Avatar.svelte'
  import { councilLetters, type CouncilAttempt, type CouncilGroup } from '@shared/protocol'
  import CellOutputs from '@/components/notebook/CellOutputs.svelte'
  import Code from '@/components/ui/Code.svelte'
  import { attemptReview, attemptExecution, pultDuration, timedOutLimit, type PultPresence, type PultRule } from '@/lib/council-pult'
  import { clock } from '@/lib/history'
  import { spell } from '@/lib/utils'
  import PultActions from './PultActions.svelte'
  import PultLetters from './PultLetters.svelte'
  import PultReply from './PultReply.svelte'

  interface Props {
    attempt: CouncilAttempt | null
    presence: PultPresence
    group: CouncilGroup | undefined
    /** Номер группы с единицы и сколько групп всего. */
    groupIndex: number
    groups: number
    /** Место работы в ленте: «12 / 487». */
    index: number
    total: number
    variant: number
    names: boolean
    now: number
    onScreen: boolean
    shownAt: number | null
    disabled: boolean
    hasNeighbour: boolean
    /** Предел запуска из регламента ячейки; `null` — без предела. */
    limit: number | null
    onrules: (rule: PultRule, from: HTMLElement) => void
    reply: string
    replyToGroup: boolean
    /** У группы есть черновик оракула. */
    replyDraft: boolean
    /** В поле ответа стоит черновик оракула. */
    replyFromOracle: boolean
    onshow: () => void
    onclear: () => void
    onrun: () => void
    oninterrupt: () => void
    onneighbour: () => void
    onmark: (correct: boolean) => void
    onreplychange: (text: string) => void
    onreplytoggle: () => void
    onreplysend: () => void
    onreplyfocus: () => void
    onreplyblur: () => void
    /** Удалить автора с занятия — подтверждает общее меню бана. */
    onremove: (attempt: CouncilAttempt, event: MouseEvent) => void
  }

  let {
    attempt,
    presence,
    group,
    groupIndex,
    groups,
    index,
    total,
    variant,
    names,
    now,
    onScreen,
    shownAt,
    disabled,
    hasNeighbour,
    limit,
    onrules,
    reply,
    replyToGroup,
    replyDraft,
    replyFromOracle,
    onshow,
    onclear,
    onrun,
    oninterrupt,
    onneighbour,
    onmark,
    onreplychange,
    onreplytoggle,
    onreplysend,
    onreplyfocus,
    onreplyblur,
    onremove,
  }: Props = $props()

  const writing = $derived(attempt !== null && attempt.submittedAt === null)
  const run = $derived(attempt?.run ?? null)
  const letters = $derived(councilLetters(attempt))
  const lines = $derived(attempt ? attempt.text.split('\n').length : 0)
  const same = $derived(group ? group.count - 1 : 0)
  const review = $derived(attempt ? attemptReview(attempt) : null)
  const execution = $derived(attempt ? attemptExecution(attempt) : null)
  /** Предел, оборвавший ИМЕННО этот запуск: регламент с тех пор могли поменять. */
  const stoppedAt = $derived(attempt ? timedOutLimit(attempt) : null)

  const place = $derived.by(() => {
    if (!attempt) return ''
    const parts = [attempt.submittedAt !== null
      ? tr('room.ui.1322', { p0: clock(attempt.submittedAt) })
      : tr('room.pult.v2.workSavedDraft', { time: clock(attempt.updatedAt) })]
    parts.push(tr(presence === 'unknown'
      ? 'room.pult.v2.workPresenceUnknown'
      : presence === 'online' ? 'room.pult.online' : 'room.pult.offline'))
    return parts.join(' · ')
  })
</script>

{#if !attempt}
  <div class="work-empty"><p>{tr('room.ui.1363')}</p></div>
{:else}
  <div class="work" data-pult-work={attempt.participantId}>
    <header class="work-header">
      <span class="work-avatar" style:background-color={names ? attempt.color : 'rgb(var(--line))'} aria-hidden="true">
        {#if names}
          <Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="xs" emojiPx={28} class="!h-full !w-full" />
        {/if}
      </span>
      <div class="work-author">
        <h2>{names ? attempt.name : tr('room.ui.1255', { p0: variant })}</h2>
        <p class="pult-meta">{place}</p>
      </div>
      <div class="work-review">
        <span class="pult-meta">{tr('room.pult.v2.workReview')}</span>
        <span class="pult-badge" data-tone={review?.tone} data-pult-review>{review?.label}</span>
      </div>
      <button type="button" class="pult-button pult-button--danger work-remove" disabled={disabled}
        data-pult-remove onclick={(event) => onremove(attempt, event)}>{tr('room.ui.78')}</button>
    </header>

    <div class="work-content" data-pult-work-scroll>
      <section class="work-code" aria-label={tr('room.pult.v2.workCode')}>
        <div class="work-section-meta pult-meta">
          <span>{tr('room.pult.v2.workCode')}</span>
          {#if same > 0}<span>{tr('room.pult.v2.workSame', { count: same })}</span>{/if}
        </div>
        <div class="work-code-surface">
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable code needs keyboard access.) -->
          <div class="work-code-scroll" tabindex="0" role="region" aria-label={tr('room.pult.v2.workCode')}>
            <Code code={attempt.text} class="pult-solution-code" />
          </div>
          {#if lines > 10}<p class="pult-meta work-lines">{tr('room.pult.codeLines', { count: lines })}</p>{/if}
        </div>
      </section>

      <section class="work-execution" data-tone={execution?.tone} aria-label={tr('room.pult.v2.workExecution')}>
        <!--
          Остановленный пределом объясняется здесь целиком, а не словом «ошибка».
          Рядом — действующий предел: его меняют ровно в эту секунду, глядя на
          чужой код, который не досчитал, и уходить за ним во вкладку значит
          потерять работу из виду.
        -->
        <div class="work-execution-head">
          <span class="work-execution-title" role="status">
            {#if stoppedAt !== null}
              {tr('room.pult.v2.rules.workTimedOut', { duration: pultDuration(stoppedAt) })}
            {:else}
              {tr('room.pult.v2.workExecution')}: {execution?.label}
              {#if run?.ranMs !== null && run?.ranMs !== undefined} · {spell(run.ranMs)}{/if}
            {/if}
          </span>
          {#if stoppedAt !== null && limit !== null}
            <button type="button" class="pult-value" onclick={(event) => onrules('runLimit', event.currentTarget)}>
              {tr('room.pult.v2.rules.limitLink', { duration: pultDuration(limit) })}
            </button>
          {/if}
        </div>
        {#if run}
          {#if run.outputs.length > 0}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable output needs keyboard access.) -->
            <div class="work-output" tabindex="0" role="region" aria-label={tr('room.pult.v2.workOutput')}>
              <CellOutputs outputs={run.outputs} />
            </div>
          {:else if run.outputsOmitted}
            <p class="pult-meta">{tr('room.pult.v2.workLoadingOutput')}</p>
          {/if}
          <!-- У автора «запускали вы», а здесь смотрит преподаватель: «вы» в его
               пульте называло бы запускавшим его самого. -->
          <p class="pult-meta">{run.by === 'host' ? tr('room.ui.61') : tr('room.pult.v2.ranByAuthor')}</p>
        {/if}
      </section>

      <PultLetters {letters} groupSize={group?.count ?? 1} />
      <p class="work-position pult-meta">
        {tr('room.pult.v2.workPosition', { index, total })}
        {#if groupIndex > 0} · {tr('room.ui.1323', { p0: groupIndex, p1: groups })}{/if}
      </p>
    </div>

    <div class="work-reply">
      <PultReply text={reply} toGroup={replyToGroup} groupSize={group?.count ?? 1}
        hasDraft={replyDraft} fromOracle={replyFromOracle} {disabled}
        onchange={onreplychange} ontoggle={onreplytoggle} onsend={onreplysend}
        onfocus={onreplyfocus} onblur={onreplyblur} />
    </div>
    <PultActions {onScreen} running={run?.state === 'running'} queued={run?.state === 'queued'}
      elapsed={run ? Math.max(now - run.startedAt, 0) : 0}
      inFrame={shownAt === null ? 0 : Math.max(now - shownAt, 0)} ran={run !== null}
      correct={attempt.correct} {writing} {disabled} {hasNeighbour}
      {onshow} {onclear} {onrun} {oninterrupt} {onneighbour} {onmark} />
  </div>
{/if}

<style>
  .work { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; background: rgb(var(--canvas)); }
  .work-empty { display: grid; flex: 1; place-items: center; padding: 32px; text-align: center; font-size: 16px; color: rgb(var(--muted)); }
  .work-header { display: flex; align-items: center; flex-shrink: 0; gap: 14px; padding: 16px 24px; border-bottom: 1px solid rgb(var(--line)); }
  .work-avatar { flex-shrink: 0; width: 44px; height: 44px; overflow: hidden; border-radius: 50%; }
  .work-author { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 6px; }
  .work-author h2 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 700; overflow-wrap: anywhere; }
  .work-author p { margin: 0; }
  .work-review { display: flex; flex-shrink: 0; flex-direction: column; align-items: flex-end; gap: 6px; }
  .work-review :global(.pult-badge) { font-size: 14px; line-height: 20px; padding: 5px 10px; }
  .work-remove { flex-shrink: 0; }
  .work-remove:focus-visible { outline: 2px solid rgb(var(--accent)); outline-offset: 2px; }
  .work-content { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px 24px; display: flex; flex-direction: column; gap: 16px; }
  .work-content > * { flex-shrink: 0; }
  .work-section-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px; margin-bottom: 10px; }
  .work-code-surface { padding: 12px 16px; background: rgb(var(--surface)); }
  .work-code-scroll { max-height: 240px; overflow: auto; }
  .work-code-scroll:focus-visible, .work-output:focus-visible { outline: 2px solid rgb(var(--accent)); outline-offset: 3px; }
  .work-code-scroll :global(.pult-solution-code) { font-size: 14px; line-height: 22px; }
  .work-code-scroll :global(.pult-solution-code > span) { min-height: 22px; }
  .work-lines { margin: 8px 0 0; }
  .work-execution { --run-tone: var(--muted); border-left: 4px solid rgb(var(--run-tone)); padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; background: rgb(var(--run-tone) / 0.08); }
  .work-execution[data-tone='positive'] { --run-tone: var(--positive); }
  .work-execution[data-tone='warning'] { --run-tone: var(--warning); }
  .work-execution[data-tone='danger'] { --run-tone: var(--danger); }
  .work-execution[data-tone='accent'] { --run-tone: var(--accent-text); }
  .work-execution-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  .work-execution-title { min-width: 0; color: rgb(var(--run-tone)); font-size: 14px; line-height: 20px; font-weight: 600; }
  .work-output { max-height: 320px; overflow: auto; }
  .work-output :global(.output-stream), .work-output :global(.text-code) { font-size: 14px; line-height: 22px; }
  .work-output :global(button) { min-height: 40px; font-size: 14px; }
  .work-position { margin: 0; }
  .work-reply { flex-shrink: 0; margin: 0 24px 12px; }
  @media (max-height: 700px) {
    .work { min-height: 650px; flex-shrink: 0; }
    .work-content { min-height: 180px; }
  }
  @media (max-width: 1000px) {
    .work-header { gap: 10px; padding: 14px 16px; flex-wrap: wrap; }
    .work-review { align-items: flex-start; flex-direction: row; align-items: center; order: 1; flex-basis: 100%; }
    .work-content { padding: 16px; }
    .work-reply { margin-inline: 16px; }
  }
</style>

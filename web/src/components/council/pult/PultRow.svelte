<script lang="ts">
  import { tr } from '@shared/i18n'
  import type { CouncilAttempt } from '@shared/protocol'
  import Avatar from '@/components/ui/Avatar.svelte'
  import { attemptReview, attemptRunLine, pultClock, type PultPresence, type RowMeaning } from '@/lib/council-pult'
  interface Props {
    attempt: CouncilAttempt; presence: PultPresence; unread: boolean; inGroup: boolean; variant: number;
    names: boolean; selected: boolean; focused: boolean; meaning: RowMeaning; same: number;
    /** Часы окна: по ним идёт «Считает 3 с» у того, кто считается прямо сейчас. */
    now: number;
    onlet: (() => void) | null; onopen: () => void
  }
  let { attempt, presence, unread, inGroup, variant, names, selected, focused, meaning, same, now, onlet, onopen }: Props = $props()
  const review = $derived(attemptReview(attempt))
  // Строка запуска целиком: что случилось, сколько считалось и когда. Час
  // запуска — просьба с пары 19.09: по нему сопоставляют запуск с тем, что
  // происходило в аудитории минуту назад.
  const execution = $derived(attemptRunLine(attempt, now))
  const title = $derived(names ? attempt.name : tr('room.ui.1255',{p0:variant}))
  const draft = $derived(attempt.submittedAt === null)
  const runText = $derived(draft && !attempt.run && attempt.runRequest?.status !== 'pending' && presence !== 'unknown'
    ? tr(presence === 'online' ? 'room.pult.online' : 'room.pult.offline') : execution.label)
  // Знак от самого состояния, если оно его прислало: у остановленного пределом
  // тон общий с упавшим (красный), а часы говорят, что ошибки в коде не было.
  const runIcon = $derived(execution.icon ?? (execution.tone === 'danger' ? '×' : execution.tone === 'accent' ? '▶' : execution.tone === 'warning' ? '◷' : ''))
</script>
<div class="pult-row" class:selected class:focused class:in-group={inGroup} class:asking={meaning==='asking'} class:on-screen={meaning==='screen'} data-pult-row={attempt.participantId} data-selected={selected?'yes':'no'} data-presence={presence} data-draft={draft?'yes':'no'}>
  <button type="button" class="pult-row-select" data-pult-select tabindex={selected?0:-1} aria-pressed={selected} title={title} onclick={onopen}>
    <span class="pult-unread" class:unread aria-hidden="true"></span>
    <span class="pult-avatar" aria-hidden="true">
      {#if names}<Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="md" emojiPx={18} />{:else}<span class="pult-anonymous"></span>{/if}
    </span>
    <span class="pult-row-main">
      <span class="pult-row-name">{title}</span>
      <span class="pult-row-tags">
        <!-- Залитая плашка «Сдано · ждёт оценки», контурный «Черновик», и у
             оценённых прежние тона: различие читается словом и формой, а не
             только цветом. -->
        <span class="pult-badge" data-tone={review.tone} data-shape={review.shape}>{#if review.tone==='positive'}<span aria-hidden="true">✓</span>{:else if review.tone==='warning'}<span aria-hidden="true">↺</span>{/if}{review.label}</span>
        {#if meaning==='screen'}<span class="pult-badge" data-tone="positive" data-shape="fill">{tr('room.ui.1313')}</span>{/if}
      </span>
      <span class="pult-run-state" data-tone={execution.tone} title={runText}>{#if runIcon}<span aria-hidden="true">{runIcon} </span>{/if}{runText}</span>
    </span>
  </button>
  <div class="pult-row-tail">
    {#if onlet}
      <button type="button" class="pult-allow" aria-label={`${tr('room.ui.1296')} · ${title}`} onclick={onlet}>{tr('room.ui.1296')}</button>
    {:else}
      <time class="pult-meta" datetime={new Date(attempt.submittedAt ?? attempt.updatedAt).toISOString()}>{pultClock(attempt.submittedAt ?? attempt.updatedAt)}</time>
    {/if}
    {#if presence==='offline' && !draft}<span class="pult-meta">{tr('room.pult.offline')}</span>{/if}
    {#if same>0 && !onlet}<span class="pult-same pult-meta" title={tr('room.ui.1314',{count:same})}>+{same}</span>{/if}
  </div>
</div>
<style>
  /*
   * 72 px на строку вместо 86: в окне 900×650 их было видно две с половиной, и
   * список переставал быть списком. Три строчки текста (имя, плашка, запуск)
   * ложатся в 72 без тесноты, а палец на телефоне получает свои 64 — ниже
   * собственной высоты строки цель нажатия не опускается.
   */
  .pult-row { display:flex; align-items:center; gap:8px; min-height:70px; border-bottom:1px solid rgb(var(--line)); border-left:3px solid transparent; padding:6px 10px 6px 7px; background:rgb(var(--canvas)); }
  .pult-row:hover { background:rgb(var(--surface)); }
  .pult-row.selected { background:rgb(var(--raised)); border-left-color:rgb(var(--primary)); }
  .pult-row.asking:not(.selected) { border-left-color:rgb(var(--warning)); }
  .pult-row.on-screen:not(.selected) { border-left-color:rgb(var(--positive)); }
  .pult-row.focused { outline:2px solid rgb(var(--accent-text)); outline-offset:-2px; }
  .pult-row.in-group { padding-left:18px; }
  /* Черновик приглушён: он в списке ради полноты класса, а смотрят на сдавших. */
  .pult-row[data-draft='yes'] .pult-avatar, .pult-row[data-draft='yes'] .pult-row-name { opacity:.65; }
  .pult-row-select { display:flex; align-items:center; gap:9px; min-width:0; flex:1; text-align:left; cursor:pointer; }
  .pult-unread { width:6px; height:6px; flex-shrink:0; border-radius:50%; background:transparent; }
  .pult-unread.unread { background:rgb(var(--accent)); }
  .pult-avatar,.pult-anonymous { display:block; width:30px; height:30px; flex-shrink:0; }
  .pult-anonymous { background:rgb(var(--line)); border-radius:50%; }
  .pult-row-main { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
  .pult-row-name { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:15px; font-weight:700; line-height:18px; }
  .pult-row-tags { display:flex; gap:4px; flex-wrap:wrap; }
  /* Плашка в строке — мельче общей: три строчки должны уложиться в 70 px. */
  .pult-row-tags :global(.pult-badge) { padding:1px 6px; font-size:12px; line-height:16px; }
  .pult-run-state { font-size:12px; line-height:16px; color:rgb(var(--muted)); overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .pult-run-state[data-tone="danger"] { color:rgb(var(--danger)); }
  .pult-run-state[data-tone="warning"] { color:rgb(var(--warning)); }
  .pult-run-state[data-tone="accent"] { color:rgb(var(--accent-text)); }
  .pult-row-tail { display:flex; flex-direction:column; gap:3px; align-items:flex-end; width:58px; flex-shrink:0; text-align:right; }
  .pult-allow { min-height:34px; padding:5px 8px; background:rgb(var(--warning)/.12); border:1px solid rgb(var(--warning)/.45); color:rgb(var(--warning)); font-size:13px; font-weight:600; cursor:pointer; }
  .pult-same { padding:1px 5px; border:1px solid rgb(var(--line)); }
  @media(max-width:800px) { .pult-row { padding-right:8px; }.pult-row-tail { width:54px; } }
  /* Телефон: строка ведёт на весь экран работы, и нажимают по ней пальцем. */
  @media(max-width:650px) { .pult-row { min-height:64px; }.pult-row-name { font-size:16px; line-height:20px; } }
</style>

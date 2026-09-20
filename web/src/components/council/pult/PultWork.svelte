<script lang="ts">
  import { tr } from '@shared/i18n'
  import Avatar from '@/components/ui/Avatar.svelte'
  import { councilLetters, type CouncilAttempt } from '@shared/protocol'
  import CellOutputs from '@/components/notebook/CellOutputs.svelte'
  import Code from '@/components/ui/Code.svelte'
  import { attemptReview, attemptExecution, pultClock, pultDuration, pultIdle, pultRanFor, timedOutLimit, type PultPresence, type PultRule } from '@/lib/council-pult'
  import PultActions from './PultActions.svelte'
  import PultLetters from './PultLetters.svelte'
  import PultReply from './PultReply.svelte'

  /**
   * Открытая работа — три зоны, и прокручивается ровно одна.
   *
   * [шапка автора] · [код и вывод] · [док общения]
   *
   * Так она устроена после пары 19.09. Раньше панель была одной колонкой с
   * прокруткой кода внутри прокрутки панели, и в окне 900×650 всё, чем
   * пользуются, — письма, поле ответа, четыре действия — лежало под сгибом:
   * «типа надо листать куда-то что-то, нет фиксированной области общения».
   *
   * Док прибит к низу и виден всегда: переписка с автором, строка письма и ряд
   * действий. Прокручивается только середина — код и вывод, — и внутри неё нет
   * вложенных прокруток: длинный код показывается первыми сорока строками с
   * кнопкой «показать весь», а не окошком на 240 px, в котором ищут, за что
   * тянуть.
   */
  interface Props {
    attempt: CouncilAttempt | null
    presence: PultPresence
    /** Место работы в видимом списке: «1 из 13». Считается по текущей вкладке и отбору. */
    index: number
    total: number
    /** Листалка шапки: тот же ход, что у j / k и стрелок. */
    onstep: (delta: 1 | -1) => void
    variant: number
    names: boolean
    now: number
    onScreen: boolean
    shownAt: number | null
    disabled: boolean
    /** Предел запуска из регламента ячейки; `null` — без предела. */
    limit: number | null
    /** Узкое окно: имя автора стоит в верхней планке экрана работы. */
    phone: boolean
    onrules: (rule: PultRule, from: HTMLElement) => void
    reply: string
    /** В поле ответа стоит черновик оракула. */
    replyFromOracle: boolean
    onshow: () => void
    onclear: () => void
    onrun: () => void
    oninterrupt: () => void
    onmark: (correct: boolean) => void
    onreplychange: (text: string) => void
    onreplysend: () => void
    onreplyfocus: () => void
    onreplyblur: () => void
    /** Удалить автора с занятия — подтверждает общее меню бана. */
    onremove: (attempt: CouncilAttempt, event: MouseEvent) => void
  }

  let {
    attempt,
    presence,
    index,
    total,
    onstep,
    variant,
    names,
    now,
    onScreen,
    shownAt,
    disabled,
    limit,
    phone,
    onrules,
    reply,
    replyFromOracle,
    onshow,
    onclear,
    onrun,
    oninterrupt,
    onmark,
    onreplychange,
    onreplysend,
    onreplyfocus,
    onreplyblur,
    onremove,
  }: Props = $props()

  const writing = $derived(attempt !== null && attempt.submittedAt === null)
  const run = $derived(attempt?.run ?? null)
  const letters = $derived(councilLetters(attempt))
  const lines = $derived(attempt ? attempt.text.split('\n').length : 0)
  const review = $derived(attempt ? attemptReview(attempt) : null)
  const execution = $derived(attempt ? attemptExecution(attempt) : null)
  /** Предел, оборвавший ИМЕННО этот запуск: регламент с тех пор могли поменять. */
  const stoppedAt = $derived(attempt ? timedOutLimit(attempt) : null)

  /**
   * Длинный код — первыми сорока строками.
   *
   * Плита с собственной прокруткой на 240 px была вложенной прокруткой внутри
   * прокрутки панели: колесо над кодом двигало код, над выводом — панель, и
   * попасть в нужную было делом наугад. Сорок строк — это весь код почти любой
   * попытки; остальным нужна одна кнопка, и по ней код раскрывается целиком в
   * ту же ленту, без второй полосы прокрутки.
   */
  const CODE_LINES = 40
  let openCode = $state<string | null>(null)
  const allCode = $derived(attempt !== null && openCode === attempt.participantId)
  const long = $derived(lines > CODE_LINES)
  const shownCode = $derived(
    attempt === null || allCode || !long
      ? (attempt?.text ?? '')
      : attempt.text.split('\n').slice(0, CODE_LINES).join('\n'),
  )

  /** Кто запускал: у автора в тетради «запускали вы», здесь смотрит преподаватель. */
  const ranBy = $derived(run === null ? '' : run.by === 'host' ? tr('room.ui.61') : tr('room.pult.v2.ranByAuthor'))

  /**
   * Строка запуска: что случилось, сколько считалось, когда и с чьей руки.
   *
   * Секунды в моменте запуска — по просьбе с пары: когда за минуту запусков
   * три, «17:24» у всех трёх не отличает их друг от друга, а по ним
   * сопоставляют вывод на экране с тем, что нажимали.
   */
  const runLine = $derived.by(() => {
    if (!execution) return ''
    if (run === null) return execution.label
    const parts = [execution.label]
    if (run.ranMs !== null) parts.push(pultRanFor(run.ranMs))
    parts.push(tr('room.pult.v3.ranAt', { time: pultClock(run.startedAt, true) }))
    parts.push(ranBy)
    return parts.join(' · ')
  })

  /**
   * Одна тихая строка под именем вместо трёх разнородных кусков в ряд.
   *
   * В ряд стояли: залитая плашка «СДАНО 15:19», голый текст «не в сети», плашка
   * оценки и «2 / 13» — четыре разных веса, четыре разных смысла и слово
   * «сдано», сказанное дважды (в плашке и в оценке «Сдано · ждёт оценки»).
   * Теперь ролей три: КТО (аватар с точкой, имя, эта строка), ЧТО С РАБОТОЙ
   * (одна плашка, четыре значения) и ГДЕ Я В СТОПКЕ (листалка).
   *
   * Пол по имени не выводится нигде в продукте, поэтому здесь «сдано в 15:19»,
   * а не «сдал(а)»: безличная форма верна для всех и не требует знать о
   * человеке того, чего он не говорил.
   *
   * «не в сети С 15:24» здесь НЕТ и быть не может. Присутствие приезжает
   * пульту живым набором Yjs (session.peersById) — это снимок «кто сейчас», без
   * единого времени ухода. `participants.last_seen` живёт в базе сервера и
   * клиенту не едет, `presence.left` — запись журнала активности, тоже
   * серверная. Выдумать час ухода нечем, а выдуманный час в строке, по которой
   * решают «ждать ли ответа», хуже пустого места.
   */
  const headLine = $derived.by(() => {
    if (!attempt) return ''
    const parts: string[] = []
    if (attempt.submittedAt !== null) {
      parts.push(tr('room.pult.v3.head.submitted', { time: pultClock(attempt.submittedAt) }))
    } else {
      const idle = Math.max(now - attempt.updatedAt, 0)
      parts.push(
        idle < 60_000
          ? tr('room.pult.v3.head.editedNow')
          : tr('room.pult.v3.head.edited', { duration: pultIdle(idle / 1000) }),
      )
    }
    if (presence !== 'unknown') {
      parts.push(tr(presence === 'online' ? 'room.pult.online' : 'room.pult.offline'))
    }
    return parts.join(' · ')
  })

  /**
   * «Удалить с занятия» — в меню «⋯», а не кнопкой на самом видном месте.
   *
   * Красная рамка стояла рядом с именем и была крупнее всего остального в
   * шапке: самое разрушительное действие в окне занимало место, которым
   * пользуются раз в семестр, и соседствовало с «Верно», которое нажимают
   * двести раз за пару. Подтверждение (общее меню бана) осталось прежним.
   */
  let menuOpen = $state(false)
  let menu = $state<HTMLElement | null>(null)
  $effect(() => {
    if (!menuOpen) return
    const away = (event: MouseEvent): void => {
      if (menu && !menu.contains(event.target as Node)) menuOpen = false
    }
    // capture: меню закрывается раньше, чем нажатие дойдёт до того, что под ним.
    window.addEventListener('mousedown', away, true)
    return () => window.removeEventListener('mousedown', away, true)
  })
</script>

{#if !attempt}
  <div class="work-empty"><p>{tr('room.ui.1363')}</p></div>
{:else}
  <div class="work" data-pult-work={attempt.participantId}>
    <header class="work-header">
      <!-- Кто: аватар с точкой присутствия, имя и одна тихая строка под ним. -->
      <span class="pult-face work-avatar" data-presence={presence} aria-hidden="true">
        <span class="work-avatar-face" style:background-color={names ? attempt.color : 'rgb(var(--line))'}>
          {#if names}
            <Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="xs" emojiPx={20} class="!h-full !w-full" />
          {/if}
        </span>
        <span class="pult-face-dot"></span>
      </span>
      <div class="work-id">
        {#if !phone}
          <h2 class="work-name">{names ? attempt.name : tr('room.ui.1255', { p0: variant })}</h2>
        {/if}
        <p class="work-sub" data-pult-headline>{headLine}</p>
      </div>
      <!--
        Что с работой — ОДНА плашка и ровно четыре значения: «Ждёт оценки»
        (залитая акцентом — единственное, что требует руки), «Верно», «На
        доработку», «Черновик». Прежние две («СДАНО 15:19» и оценка) сливаются
        в неё: они говорили об одном и том же, и «сдано» звучало дважды.
      -->
      <span class="pult-badge work-state" data-tone={review?.tone} data-shape={review?.shape} data-pult-state
        title={tr('room.pult.v3.head.state')}><span class="pult-badge-dot" aria-hidden="true"></span>{review?.label}</span>
      <!--
        Где я в стопке. Было «2 / 13» подписью, по которой нельзя нажать, — при
        том что переход к соседней работе это самое частое движение в окне.
        Кнопки ходят тем же `step`, что клавиши j / k и стрелки, то есть по
        текущей вкладке и текущему отбору; на краях гаснут.
      -->
      {#if !phone}
        <div class="work-pager" role="group" aria-label={tr('room.pult.v3.head.place')}>
          <button type="button" class="work-page" data-pult-prev aria-label={tr('room.pult.v3.prevWork')}
            disabled={index <= 1} onclick={() => onstep(-1)}><span aria-hidden="true">‹</span></button>
          <span class="work-page-count">{tr('room.pult.v3.head.pager', { index, total })}</span>
          <button type="button" class="work-page" data-pult-next aria-label={tr('room.pult.v3.nextWork')}
            disabled={index >= total} onclick={() => onstep(1)}><span aria-hidden="true">›</span></button>
        </div>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions (Escape closes the menu; the trigger and the item are buttons.) -->
      <div class="work-menu" bind:this={menu} onkeydown={(event) => {
        if (event.key !== 'Escape' || !menuOpen) return
        // Клавиша не доходит до окна: открытое меню забирает Escape себе, иначе
        // он закрывал бы заодно поиск, а меню осталось бы висеть.
        event.stopPropagation()
        menuOpen = false
        menu?.querySelector<HTMLButtonElement>('.work-more')?.focus()
      }}>
        <button type="button" class="work-more" aria-haspopup="menu" aria-expanded={menuOpen}
          aria-label={tr('room.pult.v3.more')} onclick={() => (menuOpen = !menuOpen)}><span aria-hidden="true">⋯</span></button>
        {#if menuOpen}
          <div class="work-menu-sheet" role="menu">
            <button type="button" role="menuitem" class="work-remove" disabled={disabled}
              data-pult-remove onclick={(event) => { menuOpen = false; onremove(attempt, event) }}>{tr('room.ui.78')}</button>
          </div>
        {/if}
      </div>
    </header>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex (The only scrollable zone needs keyboard access.) -->
    <div class="work-content" data-pult-work-scroll tabindex="0" role="region" aria-label={tr('room.pult.v2.workCode')}>
      <section class="work-code" aria-label={tr('room.pult.v2.workCode')}>
        <div class="work-section-meta pult-meta">
          <span>{tr('room.pult.v2.workCode')}</span>
        </div>
        <div class="work-code-surface">
          <div class="work-code-scroll">
            <Code code={shownCode} class="pult-solution-code" />
          </div>
          {#if long && !allCode}
            <button type="button" class="pult-button work-code-all" data-pult-code-all
              onclick={() => (openCode = attempt.participantId)}>{tr('room.pult.v3.codeAll', { count: lines })}</button>
          {/if}
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
              {#if run}{' · '}{tr('room.pult.v3.ranAt', { time: pultClock(run.startedAt, true) })}{' · '}{ranBy}{/if}
            {:else}
              {runLine}
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
            <!--
              Вывод стоит сразу под кодом и своей прокрутки не имеет: вертикально
              он едет вместе с кодом в единственной прокрутке панели. Вбок
              остаётся — широкую таблицу иначе не прочитать вовсе.
            -->
            <div class="work-output">
              <CellOutputs outputs={run.outputs} />
            </div>
          {:else if run.outputsOmitted}
            <p class="pult-meta">{tr('room.pult.v2.workLoadingOutput')}</p>
          {/if}
        {/if}
      </section>
    </div>

    <!--
      Док общения: то, ради чего окно открыто рядом с тетрадью. Письма, строка
      ответа и четыре действия — всегда на экране, что бы ни творилось выше.
    -->
    <div class="work-dock" data-pult-dock>
      <PultLetters {letters} />
      <PultReply text={reply} fromOracle={replyFromOracle} {disabled}
        onchange={onreplychange} onsend={onreplysend}
        onfocus={onreplyfocus} onblur={onreplyblur} />
      <PultActions {onScreen} running={run?.state === 'running'} queued={run?.state === 'queued'}
        elapsed={run ? Math.max(now - run.startedAt, 0) : 0}
        inFrame={shownAt === null ? 0 : Math.max(now - shownAt, 0)} ran={run !== null}
        correct={attempt.correct} {writing} {disabled}
        {onshow} {onclear} {onrun} {oninterrupt} {onmark} />
    </div>
  </div>
{/if}

<style>
  .work { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; background: rgb(var(--canvas)); }
  .work-empty { display: grid; flex: 1; place-items: center; padding: 32px; text-align: center; font-size: 16px; color: rgb(var(--muted)); }
  /*
   * Шапка автора — три роли в одну строку: кто · что с работой · где я в стопке.
   *
   * Пропорции взяты у макета (Paper 05d, артборд 11: аватар 44, имя 20/26,
   * подпись 13/18, плашка и листалка по 30, зазор 14) и уменьшены на шаг:
   * окно 900×650 — законный размер пульта, и в нём каждая лишняя строчка
   * шапки — это строчка кода, ушедшая под сгиб. На большом окне размеры
   * макета возвращаются целиком, ниже.
   */
  .work-header { display: flex; align-items: center; flex-shrink: 0; flex-wrap: nowrap; gap: 12px; min-height: 62px; padding: 9px 16px; border-bottom: 1px solid rgb(var(--line)); }
  .work-avatar { --face-dot: 12px; width: 38px; height: 38px; }
  .work-avatar-face { display: block; width: 100%; height: 100%; overflow: hidden; border-radius: 50%; }
  /* Имя и подпись — одна колонка: они про одного человека и двигаются вместе. */
  .work-id { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
  .work-name { min-width: 0; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 18px; line-height: 23px; font-weight: 700; }
  .work-sub { min-width: 0; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: rgb(var(--muted)); font-size: 13px; line-height: 17px; }
  .work-state { flex-shrink: 0; min-height: 28px; padding: 4px 10px; white-space: nowrap; font-size: 13px; }
  /* Листалка одной коробкой: три цели в общей рамке читаются как один прибор. */
  .work-pager { display: flex; align-items: center; flex-shrink: 0; height: 28px; border: 1px solid rgb(var(--line)); }
  .work-page { display: flex; align-items: center; justify-content: center; width: 28px; align-self: stretch; color: rgb(var(--ink)); font-size: 15px; line-height: 1; cursor: pointer; }
  .work-page:first-child { border-right: 1px solid rgb(var(--line)); }
  .work-page:last-child { border-left: 1px solid rgb(var(--line)); }
  .work-page:hover:not(:disabled) { background: rgb(var(--raised)); }
  .work-page:disabled { color: rgb(var(--faint)); opacity: .5; cursor: default; }
  .work-page-count { padding: 0 9px; color: rgb(var(--ink)); font-size: 13px; line-height: 18px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .work-menu { position: relative; flex-shrink: 0; }
  .work-more { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid transparent; color: rgb(var(--muted)); font-size: 18px; line-height: 1; cursor: pointer; }
  .work-more:hover { border-color: rgb(var(--line)); color: rgb(var(--ink)); }
  .work-menu-sheet { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 200px; padding: 4px; border: 1px solid rgb(var(--line)); background: rgb(var(--canvas)); box-shadow: 0 12px 32px rgb(0 0 0 / .28); }
  .work-remove { display: block; width: 100%; padding: 10px 12px; text-align: left; color: rgb(var(--danger)); font-size: 14px; line-height: 20px; cursor: pointer; }
  .work-remove:hover:not(:disabled) { background: rgb(var(--danger) / .1); }
  .work-remove:disabled { opacity: .48; cursor: default; }
  /* Единственная прокрутка панели. Ни над кодом, ни над выводом второй нет. */
  .work-content { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 10px 16px 14px; display: flex; flex-direction: column; gap: 12px; }
  .work-content > * { flex-shrink: 0; }
  .work-content:focus-visible { outline: 2px solid rgb(var(--accent-text)); outline-offset: -2px; }
  .work-section-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; margin-bottom: 6px; }
  .work-code-surface { padding: 10px 12px; background: rgb(var(--surface)); }
  .work-code-scroll { overflow-x: auto; }
  .work-code-scroll :global(.pult-solution-code) { font-size: 13px; line-height: 20px; }
  .work-code-scroll :global(.pult-solution-code > span) { min-height: 20px; }
  .work-code-all { margin-top: 8px; }
  .work-execution { --run-tone: var(--muted); border-left: 3px solid rgb(var(--run-tone)); padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; background: rgb(var(--run-tone) / 0.08); }
  .work-execution[data-tone='positive'] { --run-tone: var(--positive); }
  .work-execution[data-tone='warning'] { --run-tone: var(--warning); }
  .work-execution[data-tone='danger'] { --run-tone: var(--danger); }
  .work-execution[data-tone='accent'] { --run-tone: var(--accent-text); }
  .work-execution-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  .work-execution-title { min-width: 0; color: rgb(var(--run-tone)); font-size: 13px; line-height: 19px; font-weight: 600; }
  .work-output { overflow-x: auto; }
  .work-output :global(.output-stream), .work-output :global(.text-code) { font-size: 13px; line-height: 20px; }
  .work-output :global(button) { min-height: 36px; font-size: 13px; }
  .work-dock { display: flex; flex-shrink: 0; flex-direction: column; gap: 8px; padding: 8px 16px 10px; border-top: 1px solid rgb(var(--line)); background: rgb(var(--surface)); }
  /* Большое окно: те же три зоны, только просторнее. */
  @media (min-width: 1200px) and (min-height: 800px) {
    /* Размеры макета целиком: там, где места хватает, тесно быть не обязано. */
    .work-header { min-height: 72px; padding: 12px 20px; gap: 14px; }
    .work-avatar { --face-dot: 14px; width: 44px; height: 44px; }
    .work-name { font-size: 20px; line-height: 26px; }
    .work-state, .work-pager { height: 30px; min-height: 30px; }
    .work-page { width: 30px; }
    .work-content { padding: 14px 20px 18px; gap: 14px; }
    .work-dock { gap: 10px; padding: 10px 20px 12px; }
  }
  @media (max-width: 900px) {
    .work-header { gap: 10px; padding-inline: 12px; }
    .work-content { padding-inline: 12px; }
    .work-dock { padding-inline: 12px; }
  }
  /* Пара с окном ниже 480 px (PultWindow · .pult-work-pane): панель там снова
     страница, и работа получает высоту, при которой док не раздавлен. */
  @media (max-height: 479px) {
    .work { min-height: 420px; flex-shrink: 0; }
    .work-content { min-height: 120px; }
  }
  /*
   * Телефон: аватар с точкой, строка состояния, плашка — и всё.
   *
   * Имя стоит в планке экрана работы (PultWindow · .phone-bar), и второе имя
   * подряд на 390 px — это строка, отнятая у кода. Листалки здесь тоже нет:
   * по ленте ходят стрелками той же планки, а возврат к списку — жестом.
   */
  @media (max-width: 650px) {
    .work-header { min-height: 48px; gap: 10px; padding: 6px 12px; }
    .work-avatar { --face-dot: 11px; width: 32px; height: 32px; }
    .work-dock { padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
    .work-more { width: 40px; height: 40px; }
  }
</style>

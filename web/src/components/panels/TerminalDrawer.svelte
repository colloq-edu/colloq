<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  /*
   * The drawer is the room's second surface, and everything that belongs over
   * the notebook rather than beside it lives here as a tab: the shell, what the
   * kernel said, and what the room did to the notebook. The oracle keeps the
   * right-hand column because it is read alongside the notebook, not over it.
   */
  type Tab = 'terminal' | 'kernel' | 'history'

  import type * as Y from 'yjs'
  import { untrack } from 'svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { controlDisabled, controlTitle } from '@/lib/controls'
  import { permitsIn } from '@/lib/may'
  import { loadRenderers, renderers, stripAnsi } from '@/lib/render.svelte'
  import HistoryTab from '@/components/panels/HistoryTab.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { watchNotebookMeta } from '@/lib/yreactive.svelte'
  import {
    getTerminal,
    readTerminalLine,
    rereadRows,
    type TerminalLineSnapshot,
  } from '@shared/notebook'
  import { KERNEL_WORD, SHELL_WORD } from '@shared/machine'
  import { actsAfterClass } from '@shared/rules'
  import { terminalDraft } from '@/lib/drafts.svelte'
  import { collapseCarriage, elapsed } from '@/lib/utils'

  interface Props {
    /** Hides this drawer. It never sends term:close — the shell belongs to the room. */
    onclose: () => void
    /**
     * Which surface is showing. Bound rather than internal because the drawer is
     * unmounted when it closes: kept here, the tab would reset every time, and
     * somebody reading the history would be dropped back into the terminal
     * every time they closed the panel to look at a cell.
     */
    tab?: Tab
  }

  let { onclose, tab = $bindable('terminal' as Tab) }: Props = $props()

  const session = getSessionState()
  const notebook = watchNotebookMeta(session.doc)
  /*
   * $derived, not a plain const: the control socket reports the role the server
   * will actually act on as soon as it opens, and a teacher whose token was
   * minted before they signed in arrives here as a participant and is corrected
   * a moment later. A value captured at init would never hear about it.
   */
  const isHost = $derived(session.me.role === 'host')
  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))
  /*
   * Ящик может открыться на вкладке, которой в этой комнате нет: вкладка —
   * состояние родителя и переживает и смену правила, и переоткрытие. Тогда
   * показывается терминал — он есть всегда, даже когда в него нельзя писать.
   */
  const shownTab = $derived<Tab>(
    tab === 'history' && !may.history ? 'terminal' : tab,
  )
  const cwd = `/workspace/${session.session.id}`

  /* ------------------------------------------------------------- transcript */

  const terminal = getTerminal(session.doc)
  /*
   * Raw: массив снимков заменяется целиком, и оборачивать каждую строку в
   * прокси значило бы платить за то, что через кадр будет выброшено.
   */
  let lines = $state.raw<TerminalLineSnapshot[]>(terminal.map(readTerminalLine))

  $effect(() => {
    /*
     * Перечитывается ТОЛЬКО та строка, в которую пишут.
     *
     * Вывод дописывается в Y.Text внутри одной строки, а прежний код на каждый
     * кусочек собирал всю расшифровку заново: до восьмисот строк и двухсот
     * килобайт текста на каждый кадр `pip install torch`, в каждой из вкладок
     * комнаты. Вдобавок объекты были новыми, поэтому `transcriptText` в
     * разметке пересчитывался для КАЖДОЙ строки, а не для той, что выросла.
     * Неизменившиеся снимки теперь те же самые — и {@const}, и разбор ANSI
     * достаются из прошлого кадра.
     */
    const read = (events: Y.YEvent<any>[] | null) => {
      // Прежний снимок берётся `untrack`: эффект, прочитавший то, что сам же
      // пишет, зависел бы от собственной записи — один такой виток однажды
      // встретил комнату `effect_update_depth_exceeded` вместо тетради.
      const previous = untrack(() => lines)
      const fresh = rereadRows(previous, terminal, readTerminalLine, events)
      if (fresh !== previous) lines = fresh
    }
    read(null)
    // Deep: output streams into the Y.Text *inside* a line, which a shallow
    // observer on the array never hears about.
    const onFrame = (events: Y.YEvent<any>[]) => read(events)
    terminal.observeDeep(onFrame)
    return () => terminal.unobserveDeep(onFrame)
  })



  const shown = $derived(shownTab === 'terminal' ? lines : lines.filter((l) => l.kind === 'system'))
  const running = $derived(lines.some((l) => l.kind === 'command' && l.running))

  /**
   * pip and friends redraw one line in place with \r; keeping every frame would
   * print a hundred copies of the same progress bar.
   *
   * Свёртка — общая с тетрадью (`utils.ts`, и она же под тестом). Своё здесь
   * одно: хвостовые переводы строк срезаются, потому что в журнале пустая
   * строка под командой — это дырка между командой и следующей строкой, а в
   * выводе ячейки — часть текста.
   */
  function transcriptText(raw: string): string {
    return collapseCarriage(raw.replace(/\n+$/, ''))
  }

  /* The ANSI parser and the sanitizer are fetched with the notebook's renderers
     rather than at app start. Until they land the transcript still reads — the
     escape codes are dropped and the text goes out as text, which is what a
     student watching pip install actually needs. */
  loadRenderers()

  const render = $derived(renderers())

  const clock = (ts: number) =>
    new Date(ts).toLocaleTimeString(getLocale(), {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

  /* --------------------------------------------------------------- elapsed */

  let now = $state(Date.now())

  $effect(() => {
    if (!running) return
    const id = window.setInterval(() => (now = Date.now()), 200)
    return () => window.clearInterval(id)
  })

  /* -------------------------------------------------------------- scrolling */

  let scroller: HTMLDivElement | null = $state(null)
  let pinned = $state(true)

  function onScroll(): void {
    if (!scroller) return
    // Reading back is how a terminal earns trust: never yank someone to the end.
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 28
  }

  /** Changes whenever a line is added *or* text streams into an existing one. */
  const transcriptSize = $derived(lines.reduce((n, line) => n + line.text.length, lines.length))

  $effect(() => {
    void transcriptSize
    void tab
    if (!scroller || !pinned) return
    scroller.scrollTop = scroller.scrollHeight
  })

  /* ---------------------------------------------------------------- height */

  const HEIGHT_KEY = 'colloq.terminal.height.v1'
  /*
   * The drawer is a drawer, not a second window: below 140px it holds fewer
   * lines than a prompt plus its answer, and above 460px it starts taking the
   * notebook's half of a laptop screen. The remembered height is clamped into
   * this on the way in, so an old value from a big monitor cannot swallow a
   * small one.
   */
  const MIN_H = 140
  const MAX_H = 460

  const clamp = (px: number) =>
    Number.isFinite(px) ? Math.min(MAX_H, Math.max(MIN_H, Math.round(px))) : 260

  function loadHeight(): number {
    try {
      const raw = localStorage.getItem(HEIGHT_KEY)
      if (raw) return clamp(Number(raw))
    } catch {
      /* private browsing; the default height is fine */
    }
    return 260
  }

  let height = $state(loadHeight())

  function persistHeight(): void {
    try {
      localStorage.setItem(HEIGHT_KEY, String(height))
    } catch {
      /* ignore */
    }
  }

  function startResize(event: PointerEvent): void {
    const grip = event.currentTarget as HTMLElement
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    grip.setPointerCapture(event.pointerId)

    // Dragging upwards grows the drawer, hence the inverted delta.
    const move = (e: PointerEvent) => (height = clamp(startHeight - (e.clientY - startY)))
    const stop = () => {
      grip.releasePointerCapture(event.pointerId)
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', stop)
      grip.removeEventListener('pointercancel', stop)
      persistHeight()
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop)
    grip.addEventListener('pointercancel', stop)
  }

  function gripKeys(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    height = clamp(height + (event.key === 'ArrowUp' ? 24 : -24))
    persistHeight()
  }

  /* ---------------------------------------------------------------- prompt */

  let input: HTMLInputElement | null = $state(null)
  /*
   * Черновик и история живут вне ящика.
   *
   * Ящик размонтируется, когда его закрывают, и раньше вместе с ним пропадала
   * половина набранной команды и весь список для стрелки вверх: закрыл, чтобы
   * посмотреть на ячейку, открыл — пусто. Теперь это состояние вкладки, а не
   * компонента.
   */
  const term = terminalDraft

  const status = $derived(session.terminalStatus)
  /*
   * Те же состояния — словами комнаты, одними на продукт (shared/machine.ts).
   * Русская строка с `idle` посреди неё — это половина панели на машинном
   * языке; `$derived` ленив, и слово ядра считается только на его вкладке.
   */
  const kernelWord = $derived(KERNEL_WORD[notebook.current.kernelStatus])
  const shellWord = $derived(SHELL_WORD[status])
  /*
   * A command has to reach the server to be a command. Disconnected, the status
   * in hand is the last one the server sent, which says nothing about now.
   *
   * И правило `run`: `python train.py` в оболочке — тот же контейнер и то же
   * процессорное время, что и Run на ячейке, и сервер отказывает здесь тем же
   * правилом. Без гашения человек набирает команду целиком и упирается в отказ
   * на Enter — правило, которое узнают после работы, читается как поломка.
   * Читать чужой вывод при этом может вся комната: оболочка общая.
   */
  const canType = $derived(session.connected && may.run && (status === 'idle' || status === 'busy'))

  const placeholder = $derived(
    !session.connected
      ? tr('room.ui.702')
      : !may.run
        ? may.runWhy
        : status === 'starting'
          ? tr('room.ui.703')
          : status === 'dead'
            ? tr('room.ui.704')
            : status === 'closed'
              ? tr('room.ui.705')
              : 'pip install seaborn',
  )

  /**
   * Оболочку можно завести заново, пока есть кому её просить.
   *
   * Не в 'starting': там уже идёт запуск. Не без связи: сообщение никуда не
   * уйдёт, а кнопка сделает вид, что ушло. И не после конца занятия: ящик
   * сервер открывает всем — расшифровка общая, за ней сюда и приходят, — но
   * оболочку и контейнер участнику не будит и отказа при этом не шлёт.
   * Кнопка без этой проверки была бы худшим из всего: нажал, и не случилось
   * ничего, даже слова. Правила про `term:open` нет, поэтому здесь та же
   * `actsAfterClass`, по которой сервер и решает.
   */
  const acts = $derived(actsAfterClass(may.finished, session.me.role))
  const canRevive = $derived(
    session.connected && (status === 'dead' || status === 'closed') && acts,
  )

  function revive(): void {
    if (!canRevive) return
    session.send({ t: 'term:open' })
    queueMicrotask(() => input?.focus())
  }

  function submit(): void {
    const value = term.command.trim()
    if (!value || !canType) return
    session.send({ t: 'term:run', command: value })
    term.history = [value, ...term.history.filter((entry) => entry !== value)].slice(0, 100)
    term.at = -1
    term.stashed = ''
    term.command = ''
    pinned = true
  }

  function recall(step: 1 | -1): void {
    if (term.history.length === 0) return
    if (term.at === -1 && step === 1) term.stashed = term.command
    const next = term.at + step
    if (next < -1) return
    term.at = Math.min(next, term.history.length - 1)
    term.command = term.at === -1 ? term.stashed : term.history[term.at]
    // Land the caret at the end of the recalled line, the way a shell does.
    queueMicrotask(() => input?.setSelectionRange(term.command.length, term.command.length))
  }

  function onPromptKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // In a prompt, Escape belongs to the shell: it clears the line you are
      // typing. Closing the drawer out from under someone mid-command would be
      // the wrong reading of the same key — that is what the handler below is
      // for, and it deliberately ignores the prompt.
      const target = event.currentTarget as HTMLInputElement
      if (target.value) {
        event.preventDefault()
        event.stopPropagation()
        term.command = ''
        // Back to the live line, so the next ArrowUp starts from the top of the
        // history rather than the middle of the recall you just abandoned.
        term.at = -1
        term.stashed = ''
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
      return
    }
    // По коду клавиши: на русской раскладке event.key здесь «с», и Ctrl+C —
    // единственный путь остановить зависший pip в общем шелле — не работал.
    if (event.code === 'KeyC' && event.ctrlKey) {
      // Copying a selection wins; an empty selection means "stop that command".
      const target = event.currentTarget as HTMLInputElement
      if (target.selectionStart !== target.selectionEnd) return
      event.preventDefault()
      session.send({ t: 'term:interrupt' })
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      recall(1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      recall(-1)
    }
  }

  // Presence must not stay stuck on "in the terminal" when the drawer unmounts.
  $effect(() => () => session.setInTerminal(false))
</script>

<!--
  Escape closes the drawer, unless the prompt has something in it — that case is
  handled above, where the key means "clear this line".
-->
<svelte:window
  onkeydown={(event) => {
    if (event.key !== 'Escape') return
    if (event.defaultPrevented) return
    onclose()
  }}
/>

<!--
  The drawer paints from its own variables instead of the global tokens on
  purpose: the shell has to read as "the machine" in either theme, and a
  terminal that turns pale in light mode stops looking like one.
-->
<section class="term" style="height: {height}px" aria-label={tr('room.ui.676')}>
  <div
    class="term-grip"
    role="separator"
    aria-orientation="horizontal"
    aria-label={tr('room.ui.677')}
    aria-valuenow={height}
    aria-valuemin={MIN_H}
    aria-valuemax={MAX_H}
    tabindex="0"
    title={tr('room.ui.678')}
    onpointerdown={startResize}
    onkeydown={gripKeys}
  >
    <span class="term-grip-bar"></span>
  </div>

  <div class="term-tabs">
    <button
      type="button"
      class="term-tab"
      class:on={shownTab === 'terminal'}
      aria-pressed={shownTab === 'terminal'}
      onclick={() => (tab = 'terminal')}
    > {tr('room.ui.679')} {#if running}<span class="term-live-dot"></span>{/if}
    </button>
    <button
      type="button"
      class="term-tab"
      class:on={shownTab === 'kernel'}
      aria-pressed={shownTab === 'kernel'}
      onclick={() => (tab = 'kernel')}
    > {tr('room.ui.680')} </button>
    {#if may.history}
      <button
        type="button"
        class="term-tab"
        class:on={shownTab === 'history'}
        aria-pressed={shownTab === 'history'}
        onclick={() => (tab = 'history')}
      > {tr('room.ui.681')} </button>
    {/if}

    <span class="term-badge" title={tr('room.ui.682')}> {tr('room.ui.683')} </span>

    <span class="term-cwd" title={cwd}>{cwd}</span>

    {#if may.wipe}
      <button
        type="button"
        class="term-act"
        disabled={controlDisabled(session.connected)}
        title={controlTitle(session.connected, tr('room.extra.288'))}
        onclick={() => session.send({ t: 'term:clear' })}
      >
        <Icon name="eraser" size={12} /> {tr('room.ui.684')} </button>
    {/if}

    <button
      type="button"
      class="term-act"
      aria-label={tr('room.ui.685')}
      title={tr('room.ui.686')}
      onclick={onclose}
    >
      <Icon name="x" size={14} />
    </button>
  </div>

  {#if shownTab === 'history'}
    <!-- История занимает всё тело ящика и приносит свою нижнюю полосу: у неё
         две колонки и свои действия, а строка ввода команды к ней отношения не
         имеет. -->
    <HistoryTab />
  {:else}
  <div class="term-body" bind:this={scroller} onscroll={onScroll} role="log" aria-live="polite">
    {#if shownTab === 'kernel'}
      <!-- Состояния — словами, а не именами протокола: 'starting' и 'idle'
           посреди русской строки читаются как отладочный вывод. -->
      <div class="term-sys"> {tr('room.ui.687')} {kernelWord} {tr('room.ui.688')} {shellWord}
      </div>
    {/if}

    {#if shown.length === 0}
      <p class="term-empty">
        {#if shownTab === 'terminal'} {tr('room.ui.689')} <code>pip install pandas</code> {tr('room.ui.691')} <code>!pip install pandas</code> {tr('room.ui.693')} {:else} {tr('room.ui.694')} {/if}
      </p>
    {/if}

    {#each shown as line (line.id)}
      {#if line.kind === 'command'}
        <div class="term-row">
          <span class="term-av">
            <Avatar
              name={line.name ?? tr('room.extra.291')}
              color={line.color ?? 'var(--tm-muted)'}
              size="xs"
              class="!h-[14px] !w-[14px] !text-micro"
              title={tr('room.terminal.author', { name: line.name ?? tr('room.ui.561') })}
            />
          </span>
          <span class="term-sigil">$</span>
          <span class="term-cmd">{line.text}</span>
          {#if line.running}
            <span class="term-live">
              <span class="term-live-dot"></span>
              {elapsed(line.createdAt, now - session.clockSkewMs)}
            </span>
          {/if}
        </div>
      {:else if line.kind === 'output'}
        {@const text = transcriptText(line.text)}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized in lib/render -->
        <pre class="term-out">{#if render}{@html render.ansi(text)}{:else}{stripAnsi(text)}{/if}</pre>
      {:else}
        <div class="term-sys">
          {#if shownTab === 'kernel'}<span class="term-time">{clock(line.createdAt)}</span>{/if}
          {line.text}
        </div>
      {/if}
    {/each}
  </div>

  <!-- У журнала ядра строки ввода нет: пустое приглашение $ под ним обещает
       то, чего там не бывает. -->
  {#if shownTab === 'terminal'}
  <div class="term-prompt" class:off={!canType}>
    <span class="term-av">
      <Avatar
        name={session.me.name}
        color={session.me.color}
        avatar={session.me.avatar}
        size="xs"
        class="!h-[14px] !w-[14px] !text-micro"
        title={tr('room.person.you', { name: session.me.name })}
      />
    </span>
    <span class="term-sigil">$</span>
    <input
      bind:this={input}
      bind:value={term.command}
      class="term-input"
      type="text"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      aria-label={tr('room.ui.695')}
      {placeholder}
      disabled={!canType}
      onkeydown={onPromptKey}
      onfocus={() => session.setInTerminal(true)}
      onblur={() => session.setInTerminal(false)}
    />
    <!-- A block cursor only while the line is empty, so it never fights the real caret. -->
    {#if canType && term.command.length === 0}
      <span class="term-caret"></span>
    {/if}
    <span class="term-hint">
      {#if status === 'busy'}
        <span class="term-live-dot"></span> {tr('room.ui.696')} {:else if canType} {tr('room.ui.697')} {:else if canRevive}
        <!--
          `exit` в общей оболочке — тупик.

          Оболочку заказывали при открытии ящика, а мёртвая оболочка ящик не
          закрывает: строка гасла, надпись говорила «the shell stopped», и
          выхода из этого не было — надо было догадаться закрыть терминал и
          открыть заново. Один и тот же term:open, только теперь его видно.
        -->
        <button type="button" class="term-revive" onclick={revive}> {tr('room.ui.698')} </button>
      {:else if !acts && (status === 'dead' || status === 'closed')}
        <!--
          На месте кнопки — причина, а не слово `dead`.

          Оболочку после звонка заводит преподаватель, и без этой строки в ящик
          приходят читать ленту, а встречают английский диагноз мёртвой машины.
          Про сам звонок сказано рядом — в приглашении строки; здесь только то,
          чего не хватает на месте кнопки.
        --> {tr('room.ui.699')} {:else if session.connected && !may.run}
        <!--
          Здесь приглашение занято правилом («запускает преподаватель»), и место
          под состояние машины свободно — значит, оно говорит словом, а не
          именем протокола: `idle` под русской строкой был последним английским
          диагнозом в ящике.

          Остальные случаи молчат намеренно. Про `starting`, `dead` и `closed`
          приглашение слева уже сказало теми же словами, и повторить их в той же
          строке — не сведения, а эхо; а без связи состояние на руках вообще
          ничего не говорит о «сейчас» (см. `canType` выше), и называть его —
          выдавать последнее известное за настоящее.
        --> {tr('room.ui.700')} {shellWord}
      {/if}
    </span>
  </div>
  {/if}
  {/if}
</section>

<style>
  .term {
    /*
     * A local palette instead of the global tokens: the brand navy pushed down
     * to a near-black blue, so the slab stays dark in the light theme too. A
     * terminal that follows the app's ground stops reading as "the machine".
     */
    --tm-bg: #050b1c;
    --tm-raised: #0b1531;
    --tm-edge: #17244a;
    --tm-ink: #e4e8f2;
    --tm-muted: #99a5be;
    /*
     * Raised from #5f6b85, which measured 3.37:1 on the tab bar and 3.67:1 on
     * the transcript — under AA, and unnoticed for as long as it was, because
     * the drawer is shut by default and no contrast pass had ever opened it.
     * This clears 4.8:1 on both grounds and still sits 3.15:1 below --tm-ink,
     * so it reads as the quiet tier rather than as body text.
     */
    --tm-faint: #78849f;
    --tm-accent: #2eb4e8;
    --tm-live: #3ec9a7;
    /* Стек кода — один на продукт (web/src/index.css · --font-mono). В своей
       копии не было подменных семейств с правками метрик, и весь ящик до
       прихода woff2 набирался неисправленным ui-monospace, а на swap терял 2px
       на строке при 16px. Имя оставлено алиасом: по нему сюда ходит и вкладка
       истории. */
    --tm-mono: var(--font-mono);
    /* Гарнитура продукта, а не Inter: ни одного @font-face для Inter в
       index.html нет — а вкладки ящика молча падали в системный шрифт рядом с
       той же надписью в панели. */
    --tm-sans: 'HSE Sans', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    /* Output aligns under the command text, not under the avatar. */
    --tm-indent: 38px;

    position: relative;
    z-index: 20;
    display: flex;
    min-height: 0;
    /* A remembered height must never squeeze the notebook off a short screen. */
    max-height: 62%;
    flex: none;
    flex-direction: column;
    background: var(--tm-bg);
    color: var(--tm-ink);
    border-top: 1px solid var(--tm-edge);
    box-shadow: 0 -20px 40px -30px rgb(0 0 0 / 0.85);
  }

  /* Полоска остаётся двухпиксельной, а хватают за двенадцать: отрицательные
     поля растят зону захвата, не сдвигая ни вкладки, ни расшифровку. Тонкую
     черту ловили промахом — и попадали по вкладке под ней. */
  .term-grip {
    display: flex;
    height: 12px;
    margin: -3px 0 -2px;
    flex: none;
    align-items: center;
    justify-content: center;
    cursor: row-resize;
    touch-action: none;
    background: var(--tm-bg);
  }
  .term-grip-bar {
    height: 2px;
    width: 42px;
    border-radius: 999px;
    background: var(--tm-edge);
    transition: background-color 100ms ease;
  }
  .term-grip:hover .term-grip-bar,
  .term-grip:focus-visible .term-grip-bar {
    background: var(--tm-accent);
  }
  .term-grip:focus-visible {
    outline: none;
  }

  .term-tabs {
    display: flex;
    height: 30px;
    flex: none;
    align-items: center;
    gap: 8px;
    padding: 0 6px 0 10px;
    border-bottom: 1px solid var(--tm-edge);
    background: var(--tm-raised);
  }

  .term-tab {
    display: inline-flex;
    height: 100%;
    flex: none;
    align-items: center;
    gap: 5px;
    padding: 0 2px;
    font-family: var(--tm-sans);
    /* 11px, а не 10: десять — для того, что читают один раз и не нажимают
       (tailwind.config.js), а это вкладки, по которым щёлкают всю пару. */
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--tm-faint);
    border-bottom: 1.5px solid transparent;
    transition: color var(--speed-quick, 0.1s) ease;
  }
  .term-tab:hover {
    color: var(--tm-muted);
  }
  .term-tab.on {
    color: var(--tm-ink);
    border-bottom-color: var(--tm-accent);
  }

  .term-badge {
    flex: none;
    border-radius: 4px;
    padding: 2px 6px;
    font-family: var(--tm-sans);
    /* Читают один раз и не нажимают — 10px здесь на своём месте, а 9.5
       было ниже собственного пола продукта. */
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--tm-accent);
    background: rgb(46 180 232 / 0.14);
  }

  .term-cwd {
    margin-left: auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--tm-mono);
    font-size: 10.5px;
    color: var(--tm-faint);
  }

  /* Narrow drawers drop the path before they drop the badge: the shared warning
     matters more than knowing the working directory. */
  @media (max-width: 720px) {
    .term-cwd {
      display: none;
    }
    .term-badge {
      margin-left: auto;
    }
  }

  /* 24 px по высоте — тот же пол, что у кнопок тетради, и 11px вместо 10:
     «Clear» и крестик нажимают пальцем и пером. */
  .term-act {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 24px;
    border-radius: 6px;
    padding: 0 6px;
    font-family: var(--tm-sans);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--tm-faint);
    transition:
      color var(--speed-quick, 0.1s) ease,
      background-color var(--speed-quick, 0.1s) ease,
      transform var(--speed-press, 0.12s) var(--ease-out, ease-out);
  }
  /* Отклик на нажатие — тот же, что у .btn и .press на светлой стороне. */
  .term-act:active:not(:disabled) {
    transform: scale(0.97);
  }
  .term-act:hover:not(:disabled) {
    color: var(--tm-ink);
    background: rgb(255 255 255 / 0.06);
  }
  .term-act:disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .term-act:focus-visible,
  .term-tab:focus-visible {
    outline: 2px solid var(--tm-accent);
    outline-offset: -2px;
  }

  .term-body {
    min-height: 0;
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px 12px 10px;
    font-family: var(--tm-mono);
    font-size: 12.5px;
    line-height: 1.55;
  }

  .term-empty {
    max-width: 68ch;
    padding: 4px 0 0 var(--tm-indent);
    font-family: var(--tm-sans);
    font-size: 12px;
    line-height: 1.65;
    color: var(--tm-faint);
  }
  .term-empty code {
    font-family: var(--tm-mono);
    font-size: 11.5px;
    color: var(--tm-muted);
  }

  .term-row {
    display: flex;
    align-items: flex-start;
    padding-top: 2px;
  }

  /* Fixed columns in both the transcript and the prompt row, so every command
     starts at exactly --tm-indent. */
  .term-av {
    display: flex;
    height: 19px;
    width: 14px;
    flex: none;
    align-items: center;
    margin-right: 8px;
  }
  .term-sigil {
    width: 10px;
    flex: none;
    margin-right: 6px;
    font-family: var(--tm-mono);
    color: var(--tm-accent);
  }
  .term-cmd {
    min-width: 0;
    flex: 1 1 auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--tm-ink);
  }

  .term-live {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 5px;
    padding-left: 10px;
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    color: var(--tm-live);
  }
  .term-live-dot {
    height: 5px;
    width: 5px;
    flex: none;
    border-radius: 999px;
    background: var(--tm-live);
    animation: tmblink 1.1s ease-in-out infinite;
  }

  .term-out {
    margin: 0;
    padding-left: var(--tm-indent);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--tm-mono);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--tm-muted);
  }

  .term-sys {
    padding-left: var(--tm-indent);
    font-style: italic;
    color: var(--tm-faint);
  }
  .term-time {
    margin-right: 8px;
    font-style: normal;
    color: rgb(255 255 255 / 0.22);
  }

  .term-prompt {
    display: flex;
    flex: none;
    align-items: center;
    border-top: 1px solid var(--tm-edge);
    padding: 7px 12px;
    background: var(--tm-bg);
    font-family: var(--tm-mono);
    font-size: 12.5px;
    transition: background-color 100ms ease;
  }
  .term-prompt.off {
    opacity: 0.55;
  }
  .term-prompt:focus-within {
    background: var(--tm-raised);
  }

  .term-input {
    min-width: 0;
    flex: 1 1 auto;
    border: 0;
    background: transparent;
    color: var(--tm-ink);
    caret-color: var(--tm-accent);
    font-family: var(--tm-mono);
    font-size: 12.5px;
  }
  .term-input::placeholder {
    color: var(--tm-faint);
  }
  .term-input:focus {
    outline: none;
  }
  .term-input:disabled {
    cursor: not-allowed;
  }

  .term-caret {
    height: 14px;
    width: 7px;
    flex: none;
    margin-left: -2px;
    background: var(--tm-accent);
    opacity: 0.75;
    animation: tmblink 1.1s ease-in-out infinite;
  }

  /* Единственная кнопка в этой строке — и она же была самой мелкой подписью
     ящика: 11px и 24 px высоты, как у всего, что нажимают. */
  .term-revive {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 2px;
    font-family: var(--tm-sans);
    font-size: 11px;
    color: var(--tm-accent);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    transition: transform var(--speed-press, 0.12s) var(--ease-out, ease-out);
  }
  .term-revive:active {
    transform: scale(0.97);
  }

  .term-revive:hover {
    color: var(--tm-ink);
  }

  .term-hint {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 5px;
    padding-left: 10px;
    font-family: var(--tm-sans);
    font-size: 10px;
    color: var(--tm-faint);
  }

  @keyframes tmblink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.25;
    }
  }

  /*
   * Телефон: в полосе 565 px содержимого на 360 экрана, и уезжает за кромку
   * крестик — то есть ящик нечем закрыть. Уходит то, что ЧИТАЮТ (метка про
   * общий контейнер и путь), остаётся то, что НАЖИМАЮТ.
   */
  @media (max-width: 560px) {
    .term-badge,
    .term-cwd {
      display: none;
    }

    .term-tabs {
      gap: 4px;
      padding: 0 4px 0 6px;
    }

    /* Три вкладки делят остаток и усыхают многоточием, а не выталкивают. */
    .term-tab {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
</style>

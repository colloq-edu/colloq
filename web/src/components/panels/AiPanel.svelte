<script lang="ts">
  /**
   * The room's oracle thread.
   *
   * Nothing here holds an answer: the server publishes both the question and
   * the streaming reply into the session document, and this panel is a reader
   * of that array like every other browser in the seminar. Which is the point —
   * a question asked in a private tab helps one student and teaches the teacher
   * nothing, so every question is attributed and lands on all screens at once.
   */
  import type * as Y from 'yjs'
  import { allCellArrays, getChat, readChatEntry, type ChatSnapshot } from '@shared/notebook'
  import { actionAllowedIn, type AiAction, type AiAskRequest, type AwarenessUser } from '@shared/protocol'
  import { oracleModeIn, readRules } from '@shared/rules'
  import { kindOf } from '@shared/paths'
  import type { OracleMode } from '@shared/admin'
  import { api } from '@/lib/api'
  import { oracleDraft } from '@/lib/drafts.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { permitsIn } from '@/lib/may'
  import { plural } from '@/lib/plural'
  import { watchBooks, watchCellNumbers } from '@/lib/yreactive.svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import ChatTurn from './ChatTurn.svelte'

  const session = getSessionState()
  const cellNumbers = watchCellNumbers(session.doc)
  const chat = getChat(session.doc)
  const isHost = $derived(session.me.role === 'host')

  // Raw: the whole array is rebuilt on every observer fire, so deep-proxying
  // each snapshot would be work spent on objects that are replaced next frame.
  let entries = $state.raw<ChatSnapshot[]>(chat.map(readChatEntry))
  let status = $state<{ enabled: boolean; model: string; mode: OracleMode } | null>(null)
  /*
   * Вопрос переживает закрытие панели.
   *
   * Панель размонтируется вместе со своей кнопкой, а спрашивают обычно про
   * ячейку, на которую в этот момент и хочется посмотреть: свернул, глянул,
   * развернул — вопроса нет. Черновик живёт во вкладке, а не в компоненте.
   */
  const composing = oracleDraft
  let sendError = $state<string | null>(null)
  let armed = $state(false)
  let pinned = $state(true)
  /** Does any cell in the notebook currently hold a traceback? See the effect. */
  let errored = $state(false)

  let scroller = $state<HTMLDivElement | null>(null)
  /** Содержимое треда: за его ростом следит наблюдатель размера, см. ниже. */
  let thread = $state<HTMLDivElement | null>(null)
  let composer = $state<HTMLTextAreaElement | null>(null)
  /**
   * Where the thread was when the reader stopped following it.
   *
   * Needed to tell "you scrolled up" from "you scrolled up and then something
   * arrived": a button that says there is a new answer when there is not is a
   * button people stop believing, and one that stays silent when there is loses
   * the answer entirely. Null while the thread is being followed.
   */
  let mark = $state<{ id: string; length: number } | null>(null)

  let composeTimer: number | undefined
  let armTimer: number | undefined
  /** What the room currently believes about us, so we only announce changes. */
  let composingSent = false

  /*
   * Hints mode is a real state of the room, not an error to discover by
   * pressing a button. The chips it refuses are not drawn at all — the rule
   * comes from actionAllowedIn, the same function the route refuses with, so
   * the two cannot drift.
   */
  /*
   * The instance's answer, narrowed by this room's own rule.
   *
   * /api/ai/status knows nothing about a seminar, so on its own it said "full"
   * for a room the server runs in hints — and the panel drew Explain, Fix and
   * Debug, each of which came back 403 when pressed. oracleModeIn is the same
   * function the route enforces with, so the two cannot drift.
   */
  const mode = $derived<OracleMode>(
    oracleModeIn(readRules(session.session.rules), status?.mode ?? 'full'),
  )
  const hintsOnly = $derived(mode === 'hints')
  /*
   * Спрашивать негде — по любой из двух причин.
   *
   * Optimistic until proven otherwise: a null status means "still checking",
   * and a dead input while a fetch is in flight reads as a broken oracle.
   *
   * Режим комнаты входит сюда наравне с инстансом. Правило «оракул выключен»
   * ставят на контрольную, и живое поле, отвечающее на каждый вопрос красной
   * строкой 403, читается классом как поломка, а не как решение
   * преподавателя. Правило комнаты известно этой вкладке сразу, ждать статуса
   * ему незачем.
   */
  const offline = $derived(mode === 'off' || (status !== null && !status.enabled))

  $effect(() => {
    const read = () => (entries = chat.map(readChatEntry))
    read()
    // Deep: an answer streams into a Y.Text *inside* an entry. The array itself
    // only changes when somebody asks something new.
    chat.observeDeep(read)
    return () => chat.unobserveDeep(read)
  })

  $effect(() => {
    let alive = true
    api
      .aiStatus()
      .then((res) => {
        if (alive) status = res
      })
      .catch(() => {
        if (alive) status = { enabled: false, model: '', mode: 'off' }
      })
    return () => {
      alive = false
    }
  })

  /**
   * Whether a traceback would travel with the next question.
   *
   * ai/context.ts pins the newest error cell into the prompt whether or not it
   * is the one the student has selected, so this has to look at the whole
   * notebook. It reads `state`, which the runner sets to 'error' exactly when a
   * cell produces an error output, and subscribes per cell rather than
   * observeDeep-ing the array: a Y.Text edit never reaches its parent map, so
   * typing cannot wake this, and a run writes `state` two or three times.
   */
  $effect(() => {
    // Named so the dependency on the cell sequence is deliberate: a cell added
    // or removed means a different set of maps to listen to.
    void cellNumbers.current
    // Все тетради комнаты: красная точка «где-то упало» — про комнату, а не
    // про тот лист, который сейчас открыт.
    const cells = allCellArrays(session.doc).flatMap((array) => array.toArray())
    const read = () => (errored = cells.some((cell) => cell.get('state') === 'error'))
    const detach = cells.map((cell) => {
      const onKeys = (event: Y.YMapEvent<any>) => {
        if (event.keysChanged.has('state')) read()
      }
      cell.observe(onKeys)
      return () => cell.unobserve(onKeys)
    })
    read()
    return () => {
      for (const off of detach) off()
    }
  })

  // The notebook asks on the student's behalf from "Ask AI" and "Fix with AI".
  $effect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<{ cellId?: string; action?: AiAction }>).detail
      if (!detail) return
      void ask({
        message: '',
        action: detail.action ?? 'explain',
        cellId: detail.cellId ?? session.selectedCellId,
      })
    }
    window.addEventListener('colloq:ask-ai', onAsk)
    return () => window.removeEventListener('colloq:ask-ai', onAsk)
  })

  $effect(() => () => {
    window.clearTimeout(armTimer)
    // Leaving with text in the box must not leave a ghost typing line behind.
    stopComposing()
  })

  /* -------------------------------------------------------------- reading */

  const avatars = $derived.by(() => {
    const map = new Map<string, string | null>()
    for (const peer of session.peers) {
      if (peer.user.avatar) map.set(peer.user.id, peer.user.avatar)
    }
    return map
  })

  /** One line per person, not per tab — two tabs are still one student. */
  const typing = $derived.by(() => {
    const seen = new Map<string, AwarenessUser>()
    for (const peer of session.peers) {
      if (peer.user.id === session.me.id || !peer.user.composing) continue
      if (!seen.has(peer.user.id)) seen.set(peer.user.id, peer.user)
    }
    return [...seen.values()]
  })

  const typingLine = $derived.by(() => {
    const names = typing.map((user) => user.name)
    if (names.length === 0) return null
    if (names.length === 1) return `${names[0]} is typing a question…`
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing questions…`
    return `${names.length} people are typing questions…`
  })

  /**
   * Что оракул видит — и на что смотрит особенно.
   *
   * Две строки вместо ряда чипов, и это не косметика. Чипы перечисляли выбранную
   * ячейку, трейсбек и несколько имён файлов — то есть КУСКИ того, что и так
   * едет целиком, — а про тетрадь и остальные файлы молчали, потому что «чип,
   * который горит всегда, ничего не говорит». Получалось ровно наоборот: список
   * из трёх имён читался как «вот это он и видит», и человек не понимал, почему
   * ответ знает про соседнюю ячейку.
   *
   * Теперь сказано прямо: базово видно всё, что есть в комнате. А выделение и
   * открытый файл ДОБАВЛЯЮТСЯ к этому — как то, на чём просят сосредоточиться.
   */
  const books = watchBooks(session.doc)

  /*
   * Файлы, КРОМЕ тетрадей: тетради названы отдельно, и складывать их дважды
   * значит обещать больше, чем в комнате есть.
   */
  const fileCount = $derived(
    session.files.filter((file) => !file.dir && kindOf(file.path) !== 'notebook').length,
  )

  const seesAll = $derived.by(() => {
    const nb = books.current.length
    return (
      `всю комнату: ${nb} ${plural(nb, 'тетрадь', 'тетради', 'тетрадей')}` +
      `, ${fileCount} ${plural(fileCount, 'файл', 'файла', 'файлов')}`
    )
  })

  /** Открытый текстовый файл едет целиком; тетрадь — нет: она и так в ячейках. */
  const openFile = $derived(
    session.editingPath && kindOf(session.editingPath) === 'text' ? session.editingPath : null,
  )

  const focusNumbers = $derived(
    session.selection
      .map((id) => cellNumbers.current.get(id))
      .filter((n): n is number => n !== undefined)
      .sort((a, b) => a - b)
      .map(pad),
  )

  /**
   * То же самое двумя падежами.
   *
   * Строка «Особенно» перечисляет — там именительный; подсказка в поле стоит
   * после предлога — там винительный. «Спросить про ячейка 02» бросается в
   * глаза сильнее, чем стоит эта пара строк.
   */
  const focus = $derived.by(() => {
    const parts: string[] = []
    if (focusNumbers.length === 1) parts.push(`ячейка ${focusNumbers[0]}`)
    else if (focusNumbers.length > 1) parts.push(`ячейки ${focusNumbers.join(', ')}`)
    if (openFile) parts.push(openFile)
    return parts
  })

  const focusAsked = $derived.by(() => {
    if (focusNumbers.length === 1) return `ячейку ${focusNumbers[0]}`
    if (focusNumbers.length > 1) return `ячейки ${focusNumbers.join(', ')}`
    return openFile
  })

  function cellNumber(id: string | null | undefined): number | null {
    if (!id) return null
    return cellNumbers.current.get(id) ?? null
  }

  /** Cells are named 01…04 in the gutter; the thread has to agree with it. */
  function pad(n: number): string {
    return String(n).padStart(2, '0')
  }

  function askedLabel(id: string | null): string {
    const n = cellNumber(id)
    return n === null ? 'asked' : `asked about cell ${pad(n)}`
  }

  function clock(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  /* ------------------------------------------------------------- scrolling */

  function toBottom(): void {
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  $effect(() => {
    const tail = entries[entries.length - 1]
    // Depend on the tail's length too, or a streaming answer scrolls out of view.
    void entries.length
    void tail?.answer.length
    if (!pinned || !scroller) return
    // After the DOM has the new text, not before.
    requestAnimationFrame(() => {
      if (pinned) toBottom()
    })
  })

  /*
   * СЛЕДОВАТЬ ЗА РАСТУЩИМ, А НЕ ТОЛЬКО ЗА НОВЫМ.
   *
   * Прежний эффект просыпался на приход записи. Но высота треда меняется и без
   * новых записей: ответ дописывается в уже стоящий пузырь, под последним
   * поворотом появляется строка «Нина печатает», поле вопроса растёт до ста
   * шестидесяти пикселей и отъедает их у треда. Ни одно из этого не двигает
   * прокрутку само, и низ тихо уезжает под нижний край: на мерке тред уползал
   * на 37 пикселей за один вопрос и оставался там до следующего.
   *
   * Наблюдатель размера смотрит и за содержимым, и за самим окном треда —
   * второе как раз про выросшее поле ввода.
   */
  $effect(() => {
    const box = scroller
    const inner = thread
    if (!box || !inner) return
    const watch = new ResizeObserver(() => {
      if (pinned) toBottom()
    })
    watch.observe(inner)
    watch.observe(box)
    return () => watch.disconnect()
  })

  /**
   * Где тред стоял в прошлый раз, чтобы отличить «читатель ушёл вверх» от
   * «содержимое выросло». Не руна: её никто не рисует.
   */
  let lastTop = 0

  function onScroll() {
    if (!scroller) return
    const el = scroller
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    /*
     * ОТЦЕПИТЬСЯ ОТ НИЗА МОЖЕТ ТОЛЬКО ЧЕЛОВЕК.
     *
     * Событие прокрутки приходит и от нашей собственной строки
     * `scrollTop = scrollHeight`, и раньше оно же тред и отцепляло: пока
     * событие шло до обработчика, ответ дописывался, `scrollHeight` успевал
     * подрасти, и мы честно вычисляли «до низа далеко» — то есть сами себе
     * ставили «читатель ушёл вверх». Дальше тред стоял мёртво, а вопросы
     * аудитории уходили под край. Ровно на это и пожаловались.
     *
     * Признак человека один и надёжный: прокрутка ВВЕРХ. Ни рост содержимого,
     * ни наша собственная строка `scrollTop` не уменьшают. Пиксель допуска —
     * на дробную прокрутку при масштабе, отличном от ста процентов.
     */
    const wentUp = el.scrollTop < lastTop - 1
    lastTop = el.scrollTop
    if (gap < 40) {
      pinned = true
      mark = null
      return
    }
    if (!wentUp || !pinned) return
    pinned = false
    const tail = entries[entries.length - 1]
    mark = tail ? { id: tail.id, length: tail.answer.length } : { id: '', length: 0 }
  }

  /**
   * Whether something arrived below while the reader was looking elsewhere.
   *
   * Both halves count: a whole new question from somebody else, and more of an
   * answer that was already there. The second is the common one — a student
   * scrolls up to re-read cell 03's explanation and the answer they are waiting
   * for finishes underneath them.
   */
  const news = $derived.by(() => {
    if (pinned || !mark) return null
    const tail = entries[entries.length - 1]
    if (!tail) return null
    if (tail.id === mark.id && tail.answer.length <= mark.length) return null
    return tail
  })

  function follow() {
    pinned = true
    mark = null
    toBottom()
  }

  /* ------------------------------------------------------------- composing */

  /**
   * Debounced in both directions: one keystroke should not broadcast, and a
   * pause to think should not yank the line out of everyone else's panel.
   */
  function announceComposing(active: boolean) {
    window.clearTimeout(composeTimer)
    if (active === composingSent) return
    composeTimer = window.setTimeout(
      () => {
        composingSent = active
        session.setComposing(active)
      },
      active ? 220 : 600,
    )
  }

  function stopComposing() {
    window.clearTimeout(composeTimer)
    if (!composingSent) return
    composingSent = false
    session.setComposing(false)
  }

  /* ---------------------------------------------------------------- asking */

  async function ask(body: AiAskRequest) {
    if (offline) return
    stopComposing()
    sendError = null
    pinned = true
    try {
      await api.aiAsk(session.session.id, session.token, body)
    } catch (err) {
      // Verbatim: a 403 ("hints mode…", "switched off…") and a 429 with the
      // minutes until the next question are the server explaining an
      // instance's rules, and paraphrasing them would leave the student
      // guessing at a limit only the server knows.
      sendError = err instanceof Error ? err.message : 'Could not reach the oracle.'
    }
  }

  /**
   * Спросить или сделать.
   *
   * Переключатель, а не догадка по формулировке: «перепиши train.py» — это и
   * вопрос, и поручение, в зависимости от того, чего человек хочет, и угадывать
   * тут значит иногда молча трогать чужие файлы. Стоит рядом с полем, помнится
   * между вопросами и гаснет там, где режим запрещён правилом комнаты.
   */
  let doing = $state(false)
  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))
  const mayDo = $derived(may.agent)
  /*
   * И режим оракула, а не только правило `agent`.
   *
   * В режиме подсказок сервер отказывает поручению безусловно: оракул, который
   * не пишет ответ за студента, тем более не пишет его в файл. Переключателю
   * там нечего предлагать — «нет вовсе» вместо «есть и отказывает».
   */
  const canDo = $derived(mayDo && !hintsOnly)
  /*
   * Правило меняют посреди пары — переключатель уходит вместе со своим
   * положением. Иначе комната, вернувшаяся из подсказок, встречает человека
   * взведённым «Сделать», которого он не выбирал.
   */
  $effect(() => {
    if (!canDo) doing = false
    /*
     * И «Иван печатает вопрос…» — тем же движением.
     *
     * Строка живёт в присутствии, а не в этом компоненте: поле после звонка
     * исчезает целиком, ни `blur`, ни ввода больше не будет, и снять флаг
     * некому — он висит у всей комнаты до перезагрузки вкладки. Иван при этом
     * уже ничего не печатает: спрашивать ему нечем.
     */
    if (!may.ask) stopComposing()
  })

  function submit() {
    const message = composing.question.trim()
    if (!message) return
    composing.question = ''
    if (composer) {
      composer.style.height = 'auto'
      composer.focus()
    }
    if (doing && canDo) {
      void ask({ message, mode: 'agent' })
      return
    }
    void ask({ message, action: 'ask', cellIds: [...session.selection] })
  }

  /** Отменить ход целиком: файлы возвращаются к тому, что было до него. */
  function undo(entryId: string) {
    session.send({ t: 'ai:undo', entryId })
  }

  function retry(entry: ChatSnapshot) {
    /*
     * Повтор поручения — поручение.
     *
     * Без `mode` «почини train.py и запусти» уходило обычным вопросом: модель
     * объясняла, что сделала бы, и не делала ничего, — а нажимали Retry ровно
     * под ходом «сделать». Действие и ячейка агенту не передаются: у него их
     * не было и в первый раз.
     */
    if (entry.mode === 'agent') {
      void ask({ message: entry.question, mode: 'agent' })
      return
    }
    void ask({
      message: entry.question,
      action: (entry.action as AiAction | null) ?? undefined,
      cellId: entry.cellId,
    })
  }

  async function stop(entryId: string) {
    try {
      await api.aiCancel(session.session.id, session.token, entryId)
    } catch (err) {
      sendError = err instanceof Error ? err.message : 'Could not stop the answer.'
    }
  }

  async function clearThread() {
    // Two-step: this wipes what the whole class asked, and the button sits one
    // pixel from the model name.
    if (!armed) {
      armed = true
      armTimer = window.setTimeout(() => (armed = false), 3000)
      return
    }
    window.clearTimeout(armTimer)
    armed = false
    try {
      await api.aiClearThread(session.session.id, session.token)
    } catch (err) {
      sendError = err instanceof Error ? err.message : 'Could not clear the thread.'
    }
  }

  function onInput(event: Event) {
    const el = event.currentTarget as HTMLTextAreaElement
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    announceComposing(el.value.trim().length > 0)
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    submit()
  }
</script>

<div class="panel h-full">
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
    <Icon name="sparkles" size={14} class="shrink-0 text-accent-text" />
    <span class="shrink-0 text-2xs font-bold uppercase tracking-section text-ink">Oracle</span>
    <span
      class="inline-flex h-5 shrink-0 items-center bg-raised px-1.5 text-2xs font-bold uppercase
             tracking-caps text-ink"
      title="Everyone in this session reads the same thread"
    >
      shared · {entries.length} Q
    </span>

    <span class="ml-auto min-w-0 truncate font-mono text-2xs text-muted">
      <!--
        Only when there is something to name. A header reading "gpt-4o-mini"
        above a panel saying "no model is set up on this Colloq yet" is the
        screen contradicting itself: the model is what the server WOULD use, and
        until it can, saying it is a claim the room cannot act on.
      -->
      {offline ? '' : (status?.model ?? '')}
    </span>

    {#if isHost}
      <button
        type="button"
        class="btn-ghost h-7 shrink-0 gap-1 px-1.5 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 {armed
          ? 'text-danger hover:text-danger'
          : ''}"
        title="Clear the room's thread"
        aria-label="Clear the room's thread"
        disabled={entries.length === 0}
        onclick={clearThread}
      >
        <Icon name="eraser" size={14} />
        {#if armed}<span>Clear?</span>{/if}
      </button>
    {/if}
  </div>

  <div class="relative flex min-h-0 flex-1 flex-col">
    <div bind:this={scroller} onscroll={onScroll} class="min-h-0 flex-1 overflow-y-auto">
      <!-- Обёртка нужна наблюдателю размера: он смотрит за высотой СОДЕРЖИМОГО,
           а у самого окна прокрутки она не меняется, сколько бы туда ни дописали. -->
      <div bind:this={thread}>
      {#if entries.length === 0}
        <!--
          The first thing a student reads on this panel, so it is not "nothing
          here yet" — it is the one rule about this thread worth knowing before
          you use it.
        -->
        <div class="flex flex-col items-start gap-2.5 px-4 pb-4 pt-4">
          <p class="text-answer text-ink">No questions yet.</p>
          <p class="text-ui text-muted">
            Whatever you ask goes into the room's thread with your name on it, and the answer
            arrives on everyone's screen at once.
          </p>
          <!--
            «Выделите ячейку, чтобы спросить о ней» было неправдой ровно
            наоборот: вопрос и без выделения уезжал вместе со всей тетрадью, а
            строка советовала сделать обязательным то, что всего лишь наводит
            фокус.
          -->
          <p class="text-ui text-muted">
            Оракул видит комнату целиком. Выделите ячейки, если хотите, чтобы он смотрел
            прежде всего на них.
          </p>
        </div>
      {/if}

      {#each entries as entry (entry.id)}
        <ChatTurn
          {entry}
          avatar={avatars.get(entry.participantId) ?? null}
          cellNumber={cellNumber(entry.cellId)}
          askedAbout={(entry.cellIds.length > 0 ? entry.cellIds : entry.cellId ? [entry.cellId] : [])
            .map((id) => cellNumber(id))
            .filter((n): n is number => n !== null)
            .sort((a, b) => a - b)}
          {canDo}
          onretry={() => retry(entry)}
          onstop={() => void stop(entry.id)}
          onundo={() => undo(entry.id)}
        />
      {/each}

      {#if typingLine}
        <!-- Under the last turn rather than inside the thread: this is an
             intention, and the thread holds finished facts. -->
        <div class="flex items-center gap-2 px-4 pb-4 pt-2 text-2xs italic text-muted">
          <span class="flex shrink-0 -space-x-1.5">
            {#each typing.slice(0, 3) as user (user.id)}
              <Avatar size="xs" ring name={user.name} color={user.color} avatar={user.avatar} />
            {/each}
          </span>
          <span class="min-w-0 truncate">{typingLine}</span>
        </div>
      {/if}
      </div>
    </div>

    {#if news}
      <!--
        The thread stops chasing the newest answer the moment somebody scrolls
        back, because reading beats following. Doing that silently, though, is
        how an answer gets lost, so it says whose it is.
      -->
      <div class="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
        <button
          type="button"
          class="pointer-events-auto inline-flex h-[26px] animate-fade-up items-center gap-1.5
                 border border-line bg-canvas pl-1.5 pr-2.5 shadow-pop
                 transition-colors duration-[var(--speed-quick)] hover:border-faint
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onclick={follow}
        >
          <Avatar
            size="xs"
            name={news.name}
            color={news.color}
            avatar={avatars.get(news.participantId) ?? null}
          />
          <span class="text-2xs font-semibold text-ink">
            {news.participantId === session.me.id ? 'your answer' : `${news.name}'s answer`}
          </span>
          <Icon name="chevron-down" size={11} class="text-accent-text" />
        </button>
      </div>
    {/if}
  </div>

  <div class="flex shrink-0 flex-col gap-2.5 border-t border-line px-4 pb-4 pt-3">
    {#if sendError}
      <div
        class="flex items-start gap-2 border-l-2 border-danger bg-danger/[0.05] px-3 py-2 text-2xs text-danger"
      >
        <span class="min-w-0 flex-1 break-words">{sendError}</span>
        <button
          type="button"
          class="shrink-0 p-0.5 transition-colors duration-100 hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          aria-label="Dismiss"
          onclick={() => (sendError = null)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    {/if}

    {#if hintsOnly}
      <!--
        «Просят подсказку», а не «решения не будет».

        Режим подсказок держится на формулировке запроса к модели: мы просим не
        давать решение, повторяем эту просьбу после слов студента — и на этом
        всё, потому что больше сделать нечего. Обещать классу, что решение не
        появится, значит обещать за модель.

        Строка осталась там, где стояли кнопки: она про комнату, а не про
        кнопку, и исчезнуть вместе с ними не должна была.
      -->
      <p class="text-2xs text-muted">
        режим подсказок — оракула просят подтолкнуть, а не решить за вас
      </p>
    {/if}

    {#if offline}
      <!--
        Two different facts wore the same sentence, and it was addressed to
        whoever runs the server while being read by a student who cannot act on
        it. An oracle switched off by the teacher is a decision, not a fault;
        an unconfigured one is a fault, and only staff can do anything about it —
        so only staff are told where.

        Выключен — кем: сервер различает решение админа и решение
        преподавателя (routes/ai.ts), и панель обязана называть то же самое,
        иначе решение админа приходит классу как решение преподавателя.

        А вот «ключа нет» и «лимит ноль» /api/ai/status одинаково отдаёт как
        `enabled: false`, и различить их отсюда нечем — поэтому подсказка хосту
        называет оба места сразу, а не то, которое у него уже настроено.
      -->
      <p class="border border-line bg-raised px-3 py-2 text-2xs text-muted">
        {#if mode === 'off'}
          {#if status?.mode === 'off'}
            The oracle is switched off for this instance.
          {:else}
            The oracle is switched off for this seminar.
          {/if}
        {:else if isHost}
          The oracle is not answering here — check
          <span class="font-semibold text-ink">Oracle</span> in the teaching panel: either no model
          is set up, or the hourly limit is set to zero.
        {:else}
          The oracle is not answering on this Colloq, so there is nobody to ask here.
        {/if}
      </p>
    {:else if !may.ask}
      <!--
        Занятие кончилось — поля нет вовсе, а не есть и отказывает.
        Тред при этом остаётся открытым и прокручивается: за разбором,
        который оракул написал на паре, сюда как раз и возвращаются.
      -->
      <p class="border border-line bg-raised px-3 py-2 text-2xs text-muted">{may.askWhy}</p>
    {:else}
      <div
        class="flex flex-col items-stretch border border-line bg-surface transition-colors
               duration-[var(--speed-quick)] focus-within:border-accent focus-within:ring-4
               focus-within:ring-accent/15"
      >
        <!--
          What this question will carry, attached to the box it will leave from.
          It used to sit above the whole thread, which read as a fact about the
          room; it is not one. Every chip here comes off THIS browser's
          selection, so two people looking at the same panel see two different
          rows — and the only place that is honest is against the field where
          the person who owns that selection is typing.

          Named piece by piece, and nothing is claimed that this browser cannot
          verify: ai/context.ts also sends the whole notebook, the kernel status
          and the file list, which have no chip because they are unconditional
          and a chip that is always lit says nothing.
        -->
        <!--
          Что уедет с этим вопросом — над самим полем, а не над лентой: это
          факт про ЭТУ вкладку, а не про комнату. Выделение у каждого своё, и
          двое, глядящие на одну панель, видят здесь разное.
        -->
        <div class="flex flex-col gap-0.5 border-b border-line px-2 py-1.5">
          <div class="flex items-baseline gap-1.5">
            <span
              class="shrink-0 text-2xs font-bold uppercase tracking-institution text-faint"
              title="Тетради целиком, список файлов, состояние ядра и лента вопросов"
            >
              Видит
            </span>
            <span class="min-w-0 truncate text-2xs text-muted">{seesAll}</span>
          </div>
          {#if focus.length > 0}
            <!-- Появляется только когда есть на чём сосредоточиться: строка,
                 которая горит всегда, ничего не говорит. -->
            <div class="flex items-baseline gap-1.5">
              <span
                class="shrink-0 text-2xs font-bold uppercase tracking-institution text-accent-text"
                title="Это уедет отдельно и с просьбой смотреть в первую очередь сюда"
              >
                Особенно
              </span>
              <span class="min-w-0 truncate font-mono text-2xs text-ink">
                {focus.join(' · ')}
              </span>
            </div>
          {/if}
        </div>

        <!--
          Спросить или сделать — переключателем, а не догадкой по формулировке.
          «Перепиши train.py» — это и вопрос, и поручение; угадывать значит
          иногда молча трогать чужие файлы. Там, где режим закрыт — правилом
          комнаты или режимом подсказок, — переключателя нет вовсе, а не есть и
          отказывает.
        -->
        {#if canDo}
          <div class="flex items-center gap-1 px-2 pb-0.5 pt-1.5">
            <div class="flex items-stretch border border-line bg-canvas">
              <button
                type="button"
                class="px-2 py-0.5 text-2xs font-semibold transition-colors duration-100
                       {doing ? 'text-muted hover:text-ink' : 'bg-primary text-primary-ink'}"
                onclick={() => (doing = false)}
              >
                Спросить
              </button>
              <button
                type="button"
                class="px-2 py-0.5 text-2xs font-semibold transition-colors duration-100
                       {doing ? 'bg-primary text-primary-ink' : 'text-muted hover:text-ink'}"
                onclick={() => (doing = true)}
              >
                Сделать
              </button>
            </div>
          </div>
        {/if}

        <div class="flex items-end gap-2 py-1 pl-2 pr-1.5">
        <!-- Your face before you type, so it is obvious the room will see this. -->
        <Avatar
          class="mb-1"
          size="xs"
          name={session.me.name}
          color={session.me.color}
          avatar={session.me.avatar}
          title="asking as {session.me.name}"
        />
        <textarea
          bind:this={composer}
          bind:value={composing.question}
          rows="1"
          placeholder={doing && canDo
            ? 'Что сделать с файлами семинара…'
            : focusAsked
              ? `Спросить про ${focusAsked}…`
              : 'Спросить оракула комнаты…'}
          title="Enter sends, Shift+Enter for a new line"
          class="max-h-40 flex-1 resize-none bg-transparent py-1 text-ui text-ink placeholder:text-muted focus:outline-none"
          oninput={onInput}
          onkeydown={onKeydown}
          onblur={() => {
            if (!composing.question.trim()) stopComposing()
          }}
        ></textarea>
        <button
          type="button"
          class="btn-primary h-7 w-7 shrink-0 px-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Send"
          disabled={!composing.question.trim()}
          onclick={submit}
        >
          <Icon name="send" size={14} />
        </button>
        </div>
      </div>
    {/if}

    <p class="flex items-center gap-1.5 text-2xs text-muted">
      <Icon name="users" size={13} class="shrink-0" />
      <span class="min-w-0">
        {doing && canDo
          ? 'Правит файлы семинара сам. Тетрадь не трогает — там по-прежнему предлагает.'
          : 'The whole room sees your question and the answer.'}
      </span>
    </p>
  </div>
</div>

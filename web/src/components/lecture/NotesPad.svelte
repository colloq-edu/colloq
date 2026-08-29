<!--
  ЗАМЕТКИ СПИКЕРА — что сказать на этой странице.

  Одна страница — одна заметка. Их пишут накануне, идя по колоде, и правят
  прямо на паре, между двумя фразами; поэтому здесь нет ни кнопки «Сохранить»,
  ни режима правки: поле всегда живое, а запись уходит сама.

  Три решения, без которых эта штука вредна, а не полезна.

  ПЕРВОЕ. Черновик уходит на сервер не только по таймеру, но и ОБЯЗАТЕЛЬНО
  перед сменой страницы и при размонтировании. Самая частая последовательность
  в аудитории — дописал полфразы и тут же перелистнул; таймер в этот момент ещё
  тикает, и без выгрузки в cleanup эта полфразы пропадала бы каждый раз, причём
  молча. Номер страницы для записи берётся тот, что был у ПОЛЯ, а не текущий:
  иначе фраза уезжает на чужой слайд.

  ВТОРОЕ. Приходящее с сервера не двигает текст под курсором. Ноутбук и планшет
  — один и тот же человек с одним participantId, эхо собственной правки
  возвращается на оба экрана, и если принимать его как есть, курсор будет
  прыгать в конец на каждом четвёртом символе. Пока в поле фокус, пока не ушёл
  черновик и пока не истекло окно собственного эха — входящее для этой страницы
  игнорируется. Для всех остальных страниц оно принимается сразу.

  ТРЕТЬЕ. «Заметок нет» и «заметки ещё не приехали» — разные экраны.
  Преподаватель, увидевший пустоту там, где вчера написал двадцать строк,
  решит посреди пары, что потерял их. Отличаем по `session.notesFile`.

  Компонент один на два дома: лента под листом на планшетном пульте и узкая
  колонка под «дальше» на ноутбуке (`compact`). Разойдясь, они показали бы
  ведущему в двух местах разный текст — а заметил бы он это в аудитории.

  Чего здесь нет: markdown (речь пишут строчками, а не документом), эскиза
  следующей страницы (это работа листа, а не текста) и показа кому-либо, кроме
  хоста, — ни залу, ни проекции, ни при каких условиях.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { getSessionState } from '@/lib/session.svelte'

  interface Props {
    /** Документ лекции: заметки привязаны к файлу, а не к лекции. */
    file: string
    /** Текущая страница. Смена коммитит черновик предыдущей. */
    page: number
    /**
     * Узкий дом: колонка ведущего на ноутбуке под «дальше».
     *
     * Не «поменьше шрифт», а другая мера места: в колонке в 300 px третья
     * ступень размера даёт одиннадцать знаков в строке, то есть столбик
     * обрывков вместо абзаца.
     */
    compact?: boolean
    /** Свёрнута ли лента. Состоянием владеет родитель — он же его и помнит. */
    folded?: boolean
    /** Свернуть или развернуть. Не передан — шеврона в шапке нет вовсе. */
    onfold?: (folded: boolean) => void
    /** В поле фокус: родитель по этому флагу гасит перо на листе лекции. */
    onedit?: (editing: boolean) => void
  }

  let { file, page, compact = false, folded = false, onfold, onedit }: Props = $props()

  const session = getSessionState()

  /*
   * Потолок кадра управляющего сокета — 8192 байта, и кадр длиннее сервер
   * выбрасывает МОЛЧА: ни ошибки, ни строки в журнале. Кириллица в UTF-8 —
   * два байта на букву, так что 3000 знаков это ещё 6 КБ плюс путь к файлу.
   * Страница речи, исчезнувшая без единого слова, — худшее, что этот пульт
   * может сделать, поэтому режем здесь, а не надеемся на сервер.
   */
  const MAX = 3000
  /** С этого места считаем вслух: до потолка осталось три строки. */
  const WARN = 2700
  /*
   * 400 мс после последнего нажатия — пауза между словами, а не между
   * фразами. Меньше — и каждое слово едет отдельным кадром на два экрана;
   * больше — и пауза «подумать» успевает стать потерянной работой, если в этот
   * момент сядет батарея или моргнёт вайфай. Правку это всё равно не теряет:
   * черновик уходит и на blur, и перед сменой страницы, и при уходе вкладки в
   * фон — таймер только избавляет от кадра на каждую букву.
   */
  const SAVE_AFTER_MS = 400
  /*
   * Полторы секунды на возвращение собственного эха. Всё это время входящее
   * для правленой страницы не трогает поле: наш текст новее любого, что мог
   * успеть прийти. Окно временное, а не флаг «я тут главный», — если эхо не
   * вернётся вовсе (обрыв), поле само примет чужое при следующем изменении.
   */
  const ECHO_MS = 1500

  /*
   * Ступени размера. Единственное место в продукте, где растут БУКВЫ, а не
   * коробки, и это сознательно: весь остальной текст читают, уткнувшись в
   * экран, а заметку — подняв голову, урывками между взглядами в зал.
   */
  const SIZES = ['text-answer', 'text-head', 'text-display'] as const
  const SIZE_KEY = 'colloq.pult.notesSize'

  const host = $derived(session.me.role === 'host')
  /** Заметки этого документа уже приехали. `false` — не «их нет», а «их ещё нет». */
  const arrived = $derived(session.notesFile === file)
  const stored = $derived(arrived ? (session.notes[page] ?? '') : '')

  let draft = $state('')
  let typing = $state(false)
  let field = $state<HTMLTextAreaElement | null>(null)
  let step = $state(readStep())
  /** Растёт, когда поле перезарядили не с клавиатуры: повод пересчитать высоту. */
  let reloads = $state(0)

  /*
   * Плоские зеркала черновика, а не руны: их читает выгрузка, которая
   * случается ВНЕ реактивного контекста — в cleanup эффекта, в обработчике
   * ухода вкладки в фон. И держат они ту страницу, которой принадлежит текст,
   * а не ту, что открыта сейчас.
   */
  let held = ''
  // Начальное значение и есть то, что нужно: дальше эти два зеркала ведёт
  // эффект перезарядки, и ведёт с отставанием на одну страницу — в этом вся
  // их работа.
  // svelte-ignore state_referenced_locally
  let heldFile = file
  // svelte-ignore state_referenced_locally
  let heldPage = page
  let pending = false
  /*
   * Минус бесконечность, а не ноль: `performance.now()` считает от загрузки
   * страницы, и с нулём первые полторы секунды жизни вкладки выглядели бы как
   * «мы только что писали» — приехавшие в это окно заметки лента отвергла бы и
   * осталась пустой до следующего изменения.
   */
  let sentAt = Number.NEGATIVE_INFINITY
  let timer: number | undefined

  const ladder = $derived(compact ? SIZES.slice(0, 2) : SIZES)
  const size = $derived(ladder[Math.min(step, ladder.length - 1)])
  const left = $derived(MAX - draft.length)

  /*
   * Счётчик перезарядок читается ВНЕ отслеживания. Написать `reloads += 1`
   * прямо в эффекте нельзя: составное присваивание сначала читает, эффект
   * подписывается на то, что сам же и пишет, и Svelte уходит в круг до
   * effect_update_depth_exceeded.
   */
  function refit(): void {
    reloads = untrack(() => reloads) + 1
  }

  function readStep(): number {
    try {
      const raw = localStorage.getItem(SIZE_KEY)
      const value = raw === null ? 0 : Number.parseInt(raw, 10)
      return Number.isFinite(value) && value >= 0 && value < SIZES.length ? value : 0
    } catch {
      /* приватный режим — просто начнём с обычного размера */
      return 0
    }
  }

  function bigger(): void {
    step = (Math.min(step, ladder.length - 1) + 1) % ladder.length
    try {
      localStorage.setItem(SIZE_KEY, String(step))
    } catch {
      /* размер переживёт пару и без записи */
    }
  }

  /** Отправить черновик той страницы, которой он принадлежит. */
  function commit(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!pending) return
    pending = false
    sentAt = performance.now()
    /*
     * Шлём ВЕСЬ текст, а не разницу. Очередь клиента при обрыве держит
     * шестнадцать сообщений и выбрасывает старые: при полном тексте
     * единственное уцелевшее сообщение и есть верное, при разнице уцелел бы
     * бессмысленный хвост.
     */
    session.send({ t: 'notes:set', file: heldFile, page: heldPage, text: held })
  }

  function onInput(event: Event): void {
    const el = event.currentTarget as HTMLTextAreaElement
    /*
     * Потолок держит `maxlength` — и при наборе, и при вставке. Эта строка на
     * случай, когда он не сработал (сборка иероглифа, вставка через системное
     * меню в Safari): отправить больше, чем видно в поле, нельзя, кадр всё
     * равно выбросят молча.
     */
    if (el.value.length > MAX) el.value = el.value.slice(0, MAX)
    draft = el.value
    held = el.value
    pending = true
    // Высоту правим тут же, синхронно: через эффект она приедет кадром позже,
    // и строка, перетёкшая на следующую, успеет мигнуть под курсором.
    fit(el)
    if (timer !== undefined) clearTimeout(timer)
    timer = window.setTimeout(commit, SAVE_AFTER_MS)
  }

  /*
   * Высоту считает сам браузер: сначала «сколько нужно», потом упираемся в
   * max-height коробки и дальше поле прокручивается. Так поле растёт по
   * тексту в колонке, где место есть, и не вылезает из ленты, где его нет.
   */
  function fit(el: HTMLTextAreaElement | null): void {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  /* Заметки спрашиваем сами: родитель про них знать не обязан. */
  $effect(() => {
    if (host) session.openNotes(file)
  })

  /*
   * Смена страницы или документа. Черновик предыдущей уходит в cleanup —
   * Svelte зовёт его ДО тела эффекта, когда зеркала ещё держат старую
   * страницу, — а потом поле перезаряжается заметкой новой. Тот же cleanup
   * отрабатывает при размонтировании, и это единственная защита от «закрыл
   * пульт, не отпустив клавишу».
   */
  $effect(() => {
    const nextFile = file
    const nextPage = page
    heldFile = nextFile
    heldPage = nextPage
    held = untrack(() => stored)
    draft = held
    refit()
    return () => commit()
  })

  /*
   * Входящее с сервера. Принимаем, только когда в поле не печатают, свой
   * черновик уже уехал и окно собственного эха истекло: всё остальное время
   * текст под курсором не двигается ни при каких обстоятельствах.
   */
  $effect(() => {
    const fresh = stored
    if (typing || pending) return
    if (performance.now() - sentAt < ECHO_MS) return
    if (fresh === untrack(() => held)) return
    held = fresh
    draft = fresh
    refit()
  })

  /* Пересчёт высоты после того, как поле перезарядили или сменили размер. */
  $effect(() => {
    void reloads
    void folded
    void size
    fit(field)
  })

  /*
   * Вкладка ушла в фон — на планшете это переключение приложения, блокировка
   * экрана или свайп в Split View, и вернуться она может уже с мёртвым
   * сокетом. Дописанное отправляем прямо здесь, не дожидаясь таймера.
   */
  $effect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') commit()
    }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', commit)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', commit)
    }
  })

  /* Уходя с открытым полем, вернуть перо родителю: гасил его — этот флаг. */
  $effect(() => () => {
    if (typing) onedit?.(false)
  })

  /*
   * Поле исчезло, а фокус из него не ушёл.
   *
   * `typing` снимается только по `onblur`, а поле удаляется из разметки само —
   * лентой, которую свернули, и раскладкой, которая уехала в узкую, когда
   * планшет открыли в Split View. Браузер не обязан слать `blur` элементу,
   * удалённому из документа, и в этом случае пульт остаётся с поднятым флагом
   * «правят заметку»: перо перестаёт рисовать совсем, а на экране ни строки
   * объяснения. Лечится только повторным входом в поле — которого больше нет.
   */
  $effect(() => {
    const gone = folded || !arrived
    untrack(() => {
      if (!gone || !typing) return
      commit()
      typing = false
      onedit?.(false)
    })
  })

  /*
   * Нажатие собрано руками: утилита `transition-colors` переписывает
   * transition-property целиком и выбрасывает из неё transform, то есть
   * молча отменяет то самое нажатие. В этом продукте на этом уже обжигались.
   */
  const TAP =
    'transition-[color,background-color,transform] duration-press ease-out ' +
    'active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'
</script>

{#if host}
  <section
    class="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas {compact
      ? ''
      : 'border-t border-line'}"
  >
    <!--
      Шапка домашней формы: имя, волосяная линия до самого края, действия
      справа. Точка рядом с именем — единственный признак того, что у ЭТОЙ
      страницы заметка есть: в свёрнутом виде другого способа узнать нет.
    -->
    <header class="flex h-7 shrink-0 items-center gap-2 {compact ? 'px-2' : 'px-4'}">
      <span class="text-2xs font-bold uppercase tracking-section text-muted">заметки</span>
      {#if arrived && draft.trim()}
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          title="У этой страницы есть заметка"
        ></span>
      {/if}
      <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
      {#if arrived && left <= MAX - WARN}
        <span class="font-mono text-2xs tabular-nums text-muted">осталось {left}</span>
      {/if}
      {#if arrived}
        <button
          type="button"
          class="{TAP} h-7 px-2 text-2xs font-bold uppercase tracking-caps text-muted hover:text-ink"
          title="Размер текста заметки — по кругу"
          onclick={bigger}
        >
          крупнее
        </button>
      {/if}
      {#if onfold}
        <button
          type="button"
          class="{TAP} flex h-7 w-7 items-center justify-center text-muted hover:text-ink"
          aria-label={folded ? 'Развернуть заметки' : 'Свернуть заметки'}
          aria-pressed={folded}
          title={folded ? 'Развернуть заметки' : 'Свернуть заметки'}
          onclick={() => onfold?.(!folded)}
        >
          <Icon name={folded ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
      {/if}
    </header>

    {#if !folded}
      <div class="min-h-0 flex-1 overflow-hidden">
        {#if !arrived}
          <!--
            Не «пусто», а «ещё не приехало». Разница в одну строку здесь стоит
            дороже всего остального файла: пустое поле вместо вчерашних
            двадцати строк читается как потерянная работа.
          -->
          <p
            class="flex items-center gap-2 {compact ? 'px-2' : 'px-4'} py-2 text-2xs text-muted"
            aria-live="polite"
          >
            <Icon name="spinner" size={14} class="shrink-0 animate-spin" />
            Заметки загружаются
          </p>
        {:else}
          <!--
            Поле всегда открыто, а не «двойным щелчком в правку»: на планшете
            двойное касание — системный зум, а на паре лишнее движение это
            лишняя секунда молчания в аудитории. Плейсхолдер — muted, а не
            faint: в пустой заметке приглашение и есть всё содержимое, а faint
            в этом коде не носит информацию никогда.
          -->
          <textarea
            bind:this={field}
            bind:value={draft}
            rows="1"
            maxlength={MAX}
            aria-label="Заметки к странице {page}"
            placeholder="Что сказать на этой странице…"
            class="{size} block max-h-full w-full resize-none overscroll-contain bg-transparent
                   pb-3 text-ink placeholder:text-muted focus-visible:outline-offset-0
                   {compact ? 'min-h-[3rem] px-2' : 'min-h-[4rem] px-4'}"
            oninput={onInput}
            onfocus={() => {
              typing = true
              onedit?.(true)
            }}
            onblur={() => {
              typing = false
              onedit?.(false)
              // Ушли из поля — фраза уходит немедленно, не досиживая таймер.
              commit()
            }}
          ></textarea>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<!--
  Строка вкладок центра: тетрадь и всё, что в комнате открыли.

  Появляется только когда есть что переключать: в семинаре, где никто не открыл
  ни файла, этой строки нет вовсе, и она не стоит ни пикселя высоты. Это и есть
  ответ на «чтобы не отняла место» — платит за неё та комната, которая ею
  пользуется.

  Здесь же — и где преподаватель в документе. Отдельная плашка внизу читалки
  говорила то же самое вторым голосом; одно место надёжнее двух.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { tick } from 'svelte'
  import { quintOut } from 'svelte/easing'
  import { fly } from 'svelte/transition'
  import Icon from '@/components/ui/Icon.svelte'
  import type { Lead } from '@/lib/follow'
  import type { TabKey } from '@/lib/tabs.svelte'
  import { baseOf, kindOf } from '@shared/paths'
  import { iconFor } from '@/lib/file-icons'
  import { accessOptions, bookMark, type BookTab } from '@/lib/book-access'
  import { prefersReducedMotion } from '@/lib/utils'
  import type { BookAccess } from '@shared/rules'

  interface Props {
    /** Весь ряд — пути открытых файлов. Тетрадь среди них такой же файл. */
    tabs: string[]
    active: TabKey
    /** Документ на общем экране комнаты: его вкладка помечена и закрывается иначе. */
    board: string | null
    /** Можно ли убрать общий документ у всей комнаты. */
    mayBoard: boolean
    /** За кем идём по документу, если есть за кем. */
    lead: Lead | null
    /** Ведущий был и пропал — не то же самое, что «ведущего нет». */
    orphaned: boolean
    /**
     * Идёт ли смотрящий за ведущим прямо сейчас.
     *
     * Считает читалка: следование снимает любой свой жест, в том числе
     * прокрутка в пределах той же страницы. Пока этого признака здесь не было,
     * строка писала «Идём за Анной» тому, кто уже отстал по своей воле, — а
     * читалка строкой ниже честно говорила «смотрите сами».
     */
    following?: boolean
    page: number
    pages: number
    /**
     * Вкладки, приколотые комнатой: общий экран и лекция.
     *
     * Их не двигают. Порядок приколотых задаёт комната, а не тот, кто на них
     * смотрит, — и перетащить чужую вкладку значило бы переставить её себе,
     * а увидеть это как «встало у всех».
     */
    pinned?: string[]
    /**
     * Тетради комнаты вместе с их доступом — по одной записи на открытую.
     *
     * Здесь, а не внутри самой тетради, потому что метка нужна ИЗВНЕ: доступ
     * объясняет, почему у вкладки, на которую человек ещё не переключился,
     * кнопки будут серыми, а у соседней нет.
     */
    books?: BookTab[]
    /** Меню «Доступ» — преподавательское: раздаёт права тот, чья комната. */
    mayAccess?: boolean
    /** Свой participantId: про собственную тетрадь метка говорит «моя». */
    meId?: string | null
    /** Сменить доступ тетради. Уезжает тем же маршрутом, что и правила комнаты. */
    onaccess?: (root: string, access: BookAccess) => void
    onshow: (key: TabKey) => void
    onclose: (path: string) => void
    /** Переставить свою вкладку: `onto === null` — в конец ряда. */
    onreorder?: (dragged: string, onto: string | null) => void
    /** Догнать преподавателя: читалка слушает это как счётчик. */
    oncatchup: () => void
  }

  let {
    tabs,
    active,
    board,
    mayBoard,
    lead,
    orphaned,
    following = true,
    page,
    pages,
    pinned = [],
    books = [],
    mayAccess = false,
    meId = null,
    onaccess,
    onshow,
    onclose,
    onreorder,
    oncatchup,
  }: Props = $props()

  /* ----------------------------------------------------- доступ к тетради */

  /** Что комната помнит про эту вкладку. `null` — вкладка не тетрадь. */
  const bookOf = (key: string): BookTab | null =>
    books.find((book) => book.path === key) ?? null

  /** Метка доступа этой вкладки — или `null`, когда доступ комнатный. */
  const markOf = (key: string) => bookMark(bookOf(key)?.rule ?? null, meId)

  /** Ядро этой тетради считает прямо сейчас. Не тетрадь — молчит. */
  const busyOf = (key: string): boolean => bookOf(key)?.busy === true

  /**
   * Меню открыто на этой тетради — и вот где оно стоит.
   *
   * `position: fixed` и вычисленная точка, а не `absolute` внутри вкладки:
   * строка вкладок прокручивается по горизонтали (`overflow-x-auto`), а это по
   * спецификации включает и вертикальное обрезание — выпадающий список внутри
   * неё срезало бы по нижней кромке в 38 пикселей. Тот же приём, что у меню
   * бана (panels/BanMenu.svelte), и по той же причине.
   */
  let menuAt = $state<{ root: string; x: number; y: number } | null>(null)
  let opener: HTMLElement | null = null
  let menuBox = $state<HTMLElement | null>(null)

  const MENU_W = 268
  /*
   * Высота меню — измеренная, а не вычисленная: четыре строки с подписями дают
   * на узком экране около трёхсот пикселей. Число нужно ровно затем, чтобы
   * прижать меню к нижней кромке окна, а не для раскладки; ошибка в большую
   * сторону безобидна, в меньшую — режет последнюю строку на телефоне.
   */
  const MENU_H = 360

  function openMenu(event: MouseEvent, book: BookTab): void {
    const button = event.currentTarget as HTMLElement
    if (menuAt?.root === book.root) {
      closeMenu()
      return
    }
    opener = button
    const box = button.getBoundingClientRect()
    /*
     * Не вылезать за окно — по обеим осям. Вкладок бывает десяток, и последняя
     * стоит у правого края; на телефоне в 390 пикселей за край уезжает уже
     * вторая. Меню, ушедшее под кромку, выглядит как не сработавшее нажатие.
     */
    menuAt = {
      root: book.root,
      x: Math.max(8, Math.min(box.left, window.innerWidth - MENU_W - 8)),
      y: Math.max(8, Math.min(box.bottom + 2, window.innerHeight - MENU_H - 8)),
    }
    /*
     * Открытый слой сразу забирает клавиатуру — и первой берёт строку, которую
     * МОЖНО выбрать: «Личная» у преподавательской тетради стоит погашенной, и
     * фокус на ней означал бы меню, из которого с клавиатуры не выйти вперёд.
     */
    void tick().then(() =>
      menuBox?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),
    )
  }

  /** Закрыть и вернуть фокус туда, откуда открыли: меню обходится клавиатурой. */
  function closeMenu(): void {
    if (!menuAt) return
    const back = opener
    menuAt = null
    opener = null
    void tick().then(() => {
      if (back?.isConnected) back.focus()
    })
  }

  function pick(root: string, access: BookAccess): void {
    closeMenu()
    onaccess?.(root, access)
  }

  /*
   * Меню закрывается снаружи: щелчок мимо, Escape, исчезнувшая тетрадь.
   *
   * Слушатели ставятся только пока меню открыто — по образцу замка на ячейке
   * (notebook/CellView.svelte), чтобы на строке вкладок не висело двух
   * оконных обработчиков всю пару.
   */
  $effect(() => {
    if (!menuAt) return
    const away = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-access-menu]')) return
      if (target?.closest('[data-access-button]')) return
      closeMenu()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeMenu()
      }
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', escape, true)
    }
  })

  /* Тетрадь убрали из комнаты, пока меню было открыто, — закрывать нечего. */
  $effect(() => {
    if (menuAt && !books.some((book) => book.root === menuAt?.root)) closeMenu()
  })

  /*
   * Перетаскивание вкладок — и почему оно живёт здесь, а не в общем месте.
   *
   * Решение «куда встала» считает чистая функция (lib/tabs.svelte · reordered),
   * ровно как у дерева файлов (lib/tree-move.ts): там же оно и проверяется.
   * Здесь остаётся мышь — и одна вещь, которую мышью не заменишь: `dragging`
   * нужен, чтобы знать СТОРОНУ, с которой тянут, и чтобы не рисовать черту
   * под самой перетаскиваемой вкладкой.
   */
  let dragging = $state<string | null>(null)
  /** Куда встанет: путь вкладки, перед/после которой ляжет черта, или конец. */
  let over = $state<string | null>(null)
  let atEnd = $state(false)

  const movable = (key: string): boolean => onreorder !== undefined && !pinned.includes(key)

  function startDrag(event: DragEvent, key: string): void {
    if (!movable(key)) return
    dragging = key
    /*
     * `move`, а не `copy`: курсор обязан говорить правду о том, что случится.
     * И текст в обмен — чтобы перетаскивание не выглядело сломанным там, куда
     * вкладку бросать нельзя (в редактор, в панель файлов): туда уедет путь.
     */
    event.dataTransfer?.setData('text/plain', key)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function aim(event: DragEvent, key: string | null): void {
    if (dragging === null) return
    // Без preventDefault браузер не считает это местом, куда можно бросить.
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    over = key
    atEnd = key === null
  }

  function drop(event: DragEvent, key: string | null): void {
    if (dragging === null) return
    event.preventDefault()
    if (key !== dragging) onreorder?.(dragging, key)
    stopDrag()
  }

  function stopDrag(): void {
    dragging = null
    over = null
    atEnd = false
  }

  /**
   * И то же самое с клавиатуры.
   *
   * Перетаскивание мышью — единственный способ переставить вкладку, а строка
   * вкладок обходится Tab'ом и живёт под фокусом: жест, которого нет у
   * клавиатуры, здесь означал бы «этой возможности у вас нет».
   */
  function nudge(event: KeyboardEvent, key: string): void {
    if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    if (!movable(key)) return
    const own = tabs.filter((path) => !pinned.includes(path))
    const at = own.indexOf(key)
    const to = event.key === 'ArrowLeft' ? at - 1 : at + 1
    if (to < 0) return
    event.preventDefault()
    onreorder?.(key, to >= own.length ? null : own[to])
  }

  /*
   * Отстал ли смотрящий — то есть предлагать ли «догнать».
   *
   * Не только по номеру страницы: перестать идти можно и не сменив её, одной
   * прокруткой в пределах листа, и тогда «догнать» — единственная дорога
   * обратно. Порога по доле высоты здесь нет намеренно (см. follow.ts): не
   * читалка решает, разъехались ли, а сам человек — следование снимает его
   * жест.
   */
  const behind = $derived(lead !== null && (!following || lead.page !== page))
  /** Показывают ли сейчас документ — тогда справа стоит счётчик страниц. */
  const reading = $derived(typeof active === 'string' && kindOf(active) === 'pdf')

  const TAB =
    'group flex items-center gap-2 pl-4 text-ui transition-colors duration-100 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40'
  const ON = 'bg-canvas font-semibold text-ink shadow-[inset_0_-2px_0_currentColor]'
  const OFF = 'text-muted hover:text-ink'

  function closeTitle(path: string): string {
    if (path !== board) return tr('room.ui.141')
    return mayBoard
      ? tr('room.ui.745')
      : tr('room.ui.746')
  }
</script>

<!--
  Отступа слева у строки нет: он был только у первой вкладки, и она стояла на
  двадцать пикселей правее всех остальных. Каждая вкладка платит за себя сама и
  ровно столько же, сколько соседняя.
-->
<div class="flex h-[38px] shrink-0 items-stretch overflow-x-auto border-b border-line bg-surface">
  {#each tabs as key (key)}
      <!--
        Ширина вкладки ужимается до предела и не дальше: десять открытых файлов
        не должны превращать имена в одну букву. Дальше строка прокручивается —
        это честнее, чем прятать вкладки в меню, которого не видно.
      -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!--
        Вкладка с меткой доступа шире обычной, и это не украшение: «личная ·
        Аким Студентов» рядом с именем файла не помещалась в 220 пикселей, и
        первым в ноль ужималось ИМЯ ФАЙЛА — вкладка оставалась подписанной
        одной меткой. Двести восемьдесят — это имя плюс метка в обычных
        случаях; дальше и то и другое режется многоточием, а строка вкладок
        по-прежнему прокручивается.
      -->
      <div
        class={`relative flex min-w-0 shrink items-stretch ${markOf(key) ? 'max-w-[280px]' : 'max-w-[220px]'} ${active === key ? 'bg-canvas' : ''} ${dragging === key ? 'opacity-40' : ''}`}
        role="presentation"
        ondragover={(event) => aim(event, key)}
        ondrop={(event) => drop(event, key)}
      >
        <!--
          Черта показывает, КУДА встанет вкладка, а не над чем висит указатель:
          тянут влево — слева, вправо — справа. Без неё бросок вслепую, и
          промахнуться на одну позицию можно, ничего об этом не узнав.
        -->
        {#if over === key && dragging !== null && dragging !== key}
          {@const back = tabs.indexOf(dragging) > tabs.indexOf(key)}
          <span
            aria-hidden="true"
            class="pointer-events-none absolute inset-y-0 w-0.5 bg-accent {back ? 'left-0' : 'right-0'}"
          ></span>
        {/if}
        <button
          type="button"
          class={`${TAB} min-w-0 pr-1 ${active === key ? ON : OFF}`}
          title={key}
          draggable={movable(key)}
          ondragstart={(event) => startDrag(event, key)}
          ondragend={stopDrag}
          onkeydown={(event) => nudge(event, key)}
          onclick={() => onshow(key)}
        >
          <Icon name={iconFor(key)} size={13} class="shrink-0" />
          <!--
            Ядро этой тетради считает.

            У каждой тетради свой Python и своя очередь, и считать они могут
            одновременно: без точки соседняя вкладка, в которой идёт обучение,
            выглядит ровно как пустая, и узнать, кончилось ли, можно только
            переключившись. Точка, а не слово: место на вкладке уже делят имя
            файла и метка доступа, а «считает» здесь — факт, а не подпись.
            Титул вкладки остаётся путём (`title={key}`), поэтому у точки свой.
          -->
          {#if busyOf(key)}
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent {prefersReducedMotion() ? '' : 'animate-pulse'}"
              title={tr('room.book.busy')}
              aria-label={tr('room.book.busy')}
            ></span>
          {/if}
          <!-- Имени оставлен пол в три с четвертью строки: метка длинная
               («личная · Аким Студентов»), и без пола вкладка подписывалась
               одним многоточием вместо имени файла. -->
          <span class="min-w-[3.25rem] flex-1 truncate font-mono text-code">{baseOf(key)}</span>
          <!--
            Метка доступа — только там, где он НЕ «как в комнате».

            Подпись у каждой тетради была бы шумом: у большинства правила
            комнатные, и «как в комнате» на каждой вкладке не говорит ничего.
            Она появляется ровно тогда, когда внутри что-то серое, и объясняет
            это ДО переключения — иначе про чужую личную тетрадь узнаёшь, только
            открыв её и потыкав в погасшие кнопки.
          -->
          {#if markOf(key)}
            {@const mark = markOf(key)!}
            <!-- Метка ужимается раньше имени файла: у вкладки спрашивают «что
                 это за файл», а метка отвечает на второй вопрос. -->
            <span
              class={`min-w-0 max-w-[8.5rem] shrink truncate px-1.5 py-0.5 text-2xs font-semibold ${
                mark.tone === 'mine' ? 'bg-accent/15 text-accent-text' : 'bg-raised text-muted'
              }`}
              title={mark.text}
            >{mark.text}</span>
          {/if}
          {#if key === board && active !== key && lead}
            <!-- Где преподаватель — видно и из тетради: иначе о том, что лекция
                 уехала на другую страницу, узнаёшь, только переключившись. -->
            <span class="flex shrink-0 items-center gap-1.5 bg-raised px-1.5 py-0.5">
              <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
              <span class="text-2xs font-semibold text-muted">{lead.name} {tr('room.ui.737')} {lead.page}</span>
            </span>
          {/if}
        </button>
        <!--
          «Доступ» — преподавательское меню и только у тетрадей.

          Рядом с закрытием, а не в панели правил: доступ — свойство ОДНОЙ
          тетради, и решают про него, глядя на неё. В панели правил живёт
          соседний вопрос — что получит тетрадь, которую студент заведёт себе
          сам (`ownBooks`).
        -->
        {#if mayAccess && bookOf(key)}
          {@const book = bookOf(key)!}
          <button
            type="button"
            data-access-button
            class="flex w-6 shrink-0 items-center justify-center text-faint transition-colors
                   duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2
                   focus-visible:ring-inset focus-visible:ring-accent/40"
            aria-haspopup="menu"
            aria-expanded={menuAt?.root === book.root}
            aria-label={`${tr('room.book.access.title')}: ${baseOf(key)}`}
            title={tr('room.book.access.title')}
            onclick={(event) => openMenu(event, book)}
          >
            <Icon name="lock" size={12} />
          </button>
        {/if}
        <!--
          Закрыть. У того, кто ставил документ комнате, — убирает у всех; у
          открывшего себе — только у себя; у студента, которому общий документ
          убирать нельзя, — уводит в тетрадь, а комнате документ остаётся.
          Кнопка живёт на вкладке, а не в панели файлов: закрывают то, что
          смотрят, там же, где смотрят.
        -->
        <button
          type="button"
          class="flex w-7 shrink-0 items-center justify-center text-faint transition-colors
                 duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2
                 focus-visible:ring-inset focus-visible:ring-accent/40"
          title={closeTitle(key)}
          aria-label={`${closeTitle(key)}: ${baseOf(key)}`}
          onclick={() => onclose(key)}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
  {/each}

  <!--
    Пустое место справа — тоже цель: бросок сюда ставит вкладку последней.
    Иначе последнюю позицию нечем занять, кроме как попасть в правую половину
    крайней вкладки, а это мишень шириной в несколько пикселей.
  -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span
    class="relative flex-1"
    role="presentation"
    ondragover={(event) => aim(event, null)}
    ondrop={(event) => drop(event, null)}
  >
    {#if atEnd && dragging !== null}
      <span aria-hidden="true" class="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-accent"></span>
    {/if}
  </span>

  {#if reading}
    <div class="flex shrink-0 items-center gap-2.5 px-5">
      {#if behind && lead}
        <button
          type="button"
          class="flex items-center gap-1.5 border border-accent bg-canvas px-2 py-0.5
                 text-2xs font-semibold text-accent-text transition-colors duration-100 hover:bg-accent/5"
          onclick={oncatchup}
        >
          <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span> {tr('room.ui.738')} {lead.name} {tr('room.ui.739')} {lead.page}
        </button>
      {:else if lead}
        <span class="flex items-center gap-1.5">
          <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
          <span class="text-2xs font-semibold text-muted">{tr('room.ui.740')} {lead.name}</span>
        </span>
      {:else if orphaned}
        <!--
          Только тому, кто ЗА КЕМ-ТО ШЁЛ и потерял. У самого преподавателя
          ведущего нет никогда — за собой не идут, — и говорить ему «вы вышли»
          значит сообщать о событии, которого не было.
        -->
        <span class="text-2xs text-muted">{tr('room.ui.741')}</span>
      {/if}
      {#if pages > 0}
        <span class="h-3.5 w-px bg-line" aria-hidden="true"></span>
        <span class="font-mono text-2xs text-muted">{page} / {pages}</span>
      {/if}
    </div>
  {/if}
</div>

<!--
  Меню доступа стоит ВНЕ прокручиваемой строки и позиционируется от окна: см.
  `menuAt`. Только вход по кривой продукта — уход не анимируется, потому что
  меню убирают клавишей, а анимировать действие с клавиатуры нельзя (то же
  решение у BanMenu и у пульта правил).
-->
{#if menuAt}
  {@const open = books.find((book) => book.root === menuAt?.root)}
  {#if open}
    <div
      bind:this={menuBox}
      role="menu"
      tabindex="-1"
      data-access-menu
      aria-label={`${tr('room.book.access.title')}: ${baseOf(open.path)}`}
      class="fixed z-[60] border border-line bg-canvas p-1 shadow-pop"
      style={`left:${menuAt.x}px; top:${menuAt.y}px; width:${MENU_W}px`}
      in:fly={{ y: prefersReducedMotion() ? 0 : -4, duration: 120, easing: quintOut }}
    >
      <!--
        Шапка с именем тетради — как в меню бана (panels/BanMenu.svelte).

        Меню стоит поверх строки вкладок и открывается от маленькой кнопки на
        ЛЮБОЙ из них, а горит при этом активная: без имени внутри легко решить,
        что настраиваешь ту тетрадь, на которую смотришь, — и раздать права не
        той.
      -->
      <p class="truncate px-2.5 pb-1 pt-0.5 text-2xs font-bold uppercase tracking-label text-muted">
        {baseOf(open.path)}
      </p>
      {#each accessOptions(open.rule) as option (option.access)}
        {@const current = (open.rule?.access ?? 'room') === option.access}
        <button
          role="menuitemradio"
          type="button"
          aria-checked={current}
          disabled={option.disabled}
          class={`flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-ui transition-colors
                  duration-100 focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-inset focus-visible:ring-accent/40
                  disabled:pointer-events-none disabled:opacity-45
                  ${current ? 'bg-raised text-ink' : 'text-ink hover:bg-raised'}`}
          onclick={() => pick(open.root, option.access)}
        >
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate">{option.label}</span>
            <span class="text-2xs leading-snug text-muted">{option.hint}</span>
          </span>
          {#if current}
            <Icon name="check" size={12} class="mt-1 shrink-0 text-accent-text" />
          {/if}
        </button>
      {/each}
    </div>
  {/if}
{/if}

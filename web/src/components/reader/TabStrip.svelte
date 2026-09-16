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
  import Icon from '@/components/ui/Icon.svelte'
  import type { Lead } from '@/lib/follow'
  import type { TabKey } from '@/lib/tabs.svelte'
  import { baseOf, kindOf } from '@shared/paths'
  import { iconFor } from '@/lib/file-icons'

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
    onshow,
    onclose,
    onreorder,
    oncatchup,
  }: Props = $props()

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
      <div
        class={`relative flex min-w-0 max-w-[220px] shrink items-stretch ${active === key ? 'bg-canvas' : ''} ${dragging === key ? 'opacity-40' : ''}`}
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
          <span class="truncate font-mono text-code">{baseOf(key)}</span>
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

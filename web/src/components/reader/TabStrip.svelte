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
    onshow: (key: TabKey) => void
    onclose: (path: string) => void
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
    onshow,
    onclose,
    oncatchup,
  }: Props = $props()

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
    if (path !== board) return 'Закрыть'
    return mayBoard
      ? 'Убрать документ с общего экрана'
      : 'Вернуться в тетрадь. Общий экран не изменится.'
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
      <div
        class={`flex min-w-0 max-w-[220px] shrink items-stretch ${active === key ? 'bg-canvas' : ''}`}
      >
        <button
          type="button"
          class={`${TAB} min-w-0 pr-1 ${active === key ? ON : OFF}`}
          title={key}
          onclick={() => onshow(key)}
        >
          <Icon name={iconFor(key)} size={13} class="shrink-0" />
          <span class="truncate font-mono text-code">{baseOf(key)}</span>
          {#if key === board && active !== key && lead}
            <!-- Где преподаватель — видно и из тетради: иначе о том, что лекция
                 уехала на другую страницу, узнаёшь, только переключившись. -->
            <span class="flex shrink-0 items-center gap-1.5 bg-raised px-1.5 py-0.5">
              <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
              <span class="text-2xs font-semibold text-muted">{lead.name} на стр. {lead.page}</span>
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

  <span class="flex-1"></span>

  {#if reading}
    <div class="flex shrink-0 items-center gap-2.5 px-5">
      {#if behind && lead}
        <button
          type="button"
          class="flex items-center gap-1.5 border border-accent bg-canvas px-2 py-0.5
                 text-2xs font-semibold text-accent-text transition-colors duration-100 hover:bg-accent/5"
          onclick={oncatchup}
        >
          <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
          Перейти к {lead.name} · стр. {lead.page}
        </button>
      {:else if lead}
        <span class="flex items-center gap-1.5">
          <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
          <span class="text-2xs font-semibold text-muted">Ведущий: {lead.name}</span>
        </span>
      {:else if orphaned}
        <!--
          Только тому, кто ЗА КЕМ-ТО ШЁЛ и потерял. У самого преподавателя
          ведущего нет никогда — за собой не идут, — и говорить ему «вы вышли»
          значит сообщать о событии, которого не было.
        -->
        <span class="text-2xs text-muted">Ведущий отключился. Листайте документ самостоятельно.</span>
      {/if}
      {#if pages > 0}
        <span class="h-3.5 w-px bg-line" aria-hidden="true"></span>
        <span class="font-mono text-2xs text-muted">{page} / {pages}</span>
      {/if}
    </div>
  {/if}
</div>

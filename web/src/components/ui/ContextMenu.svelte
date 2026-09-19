<script lang="ts" module>
  import type { IconName } from '@/components/ui/Icon.svelte'

  /**
   * Один пункт меню.
   *
   * `gap` — разделитель ПЕРЕД пунктом, а не отдельная запись в списке: список
   * с двумя видами элементов пришлось бы разбирать на каждой отрисовке, и
   * первый же «уберите этот пункт по правам» оставлял бы висеть черту, за
   * которой ничего нет.
   *
   * `why` — не украшение. Погашенный пункт без причины читается как поломка, и
   * это то самое место, где комната обязана сказать, что остановило правило, а
   * не кнопка (см. lib/may.ts). Причина при этом не прячется в `title`: под
   * указателем её видно, а с пальца — никогда, и на телефоне погашенный пункт
   * оставался бы немым. Поэтому причины собираются в строку под меню.
   */
  export interface ContextMenuItem {
    /** Черта перед пунктом: начало новой группы. */
    gap?: boolean
    label: string
    icon?: IconName
    /** Сочетание клавиш справа — тихо, как подпись, а не как кнопка. */
    keys?: string
    danger?: boolean
    disabled?: boolean
    /** Почему нельзя. Выносится строкой под меню; там же и в `title`. */
    why?: string
    run: () => void
  }
</script>

<script lang="ts">
  /**
   * Меню, всплывающее у точки, — общее на всю комнату.
   *
   * `position: fixed` и вычисленная точка, а не `absolute` внутри строки. Все
   * места, откуда такое меню зовут, лежат в прокручиваемых полосах, а
   * `overflow` по спецификации обрезает и по вертикали: меню, открытое у нижней
   * строки панели шириной 240 пикселей, срезало бы ровно там, где на него
   * смотрят. Тот же приём и по той же причине, что у меню бана
   * (panels/BanMenu.svelte) и у меню доступа на вкладке (reader/TabStrip.svelte).
   *
   * Размер не задаётся константой, как у тех двоих: состав пунктов здесь
   * зависит от того, по чему нажали, и «примерная высота» разошлась бы с
   * правдой на первом же пункте, который спрятали по правам. Меряется настоящая
   * коробка — один раз, сразу после того как меню появилось, до того как его
   * успеют увидеть: въезд идёт от прозрачности, и поправка на кромку окна
   * укладывается в первый же кадр.
   *
   * НА ПАЛЬЦЕ меню — не поповер, а нижний лист. Поповер у пальца закрывается
   * самим пальцем, ставится там, где человек держал руку, и требует цели в 28
   * пикселей; лист приходит снизу, занимает всю ширину и даёт строки по 44.
   * Признак — `(hover: none) and (pointer: coarse)`, тот же, которым
   * `hoverOnlyWhenSupported` в tailwind.config.js отключает `hover:` утилиты.
   *
   * Анимация — только на вход. Меню убирают клавишей (Escape) и нажатием мимо,
   * а анимировать ответ на клавишу нельзя: то же решение принято для ящиков,
   * пульта правил и обоих соседних меню.
   */
  import { tr } from '@shared/i18n'
  import { tick } from 'svelte'
  import { quintOut } from 'svelte/easing'
  import { fly } from 'svelte/transition'
  import Icon from '@/components/ui/Icon.svelte'
  import { prefersReducedMotion } from '@/lib/utils'

  interface Props {
    /** Где нажали — в координатах окна. `null` — меню закрыто. */
    at: { x: number; y: number } | null
    /** Чем это меню подписано для экранного диктора. */
    label: string
    /** Строка-заголовок: по чему нажали. Имя файла, например. */
    title?: string | null
    items: ContextMenuItem[]
    /**
     * Куда вернуть фокус. Меню обходится клавиатурой целиком, и выход из него
     * обязан возвращать туда, откуда вошли, — иначе Escape роняет фокус в
     * начало страницы, а список файлов приходится обходить Tab'ом заново.
     */
    opener?: HTMLElement | null
    onclose: () => void
  }

  let { at, label, title = null, items, opener = null, onclose }: Props = $props()

  let box = $state<HTMLElement | null>(null)
  /**
   * Место, куда меню встало на самом деле.
   *
   * Сначала — просто точка нажатия, потом — она же, прижатая к кромкам окна по
   * измеренной коробке. Правая кнопка по нижней строке — обычное дело, а меню,
   * ушедшее под кромку, выглядит как не сработавшее нажатие.
   */
  let place = $state({ x: 0, y: 0 })

  /**
   * Это палец, а не указатель.
   *
   * Вопрос задаётся про УСТРОЙСТВО ввода, а не про ширину окна: узкое окно на
   * ноутбуке — по-прежнему мышь, и нижний лист там был бы капризом. Ответ
   * читается заново на каждое открытие и слушает смену (планшет с подключённой
   * мышью отвечает по-разному в разные минуты).
   */
  let coarse = $state(false)

  $effect(() => {
    const media = window.matchMedia('(hover: none) and (pointer: coarse)')
    coarse = media.matches
    const again = (): void => {
      coarse = media.matches
    }
    media.addEventListener('change', again)
    return () => media.removeEventListener('change', again)
  })

  $effect(() => {
    const point = at
    const element = box
    if (!point || !element || coarse) return
    const rect = element.getBoundingClientRect()
    place = {
      x: Math.max(8, Math.min(point.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(point.y, window.innerHeight - rect.height - 8)),
    }
  })

  /* Открытое меню сразу забирает клавиатуру — и первым берёт пункт, который
     МОЖНО выбрать: фокус на погашенном означал бы меню, из которого с
     клавиатуры не выйти вперёд. Тот же приём, что у меню доступа. */
  $effect(() => {
    if (!at) return
    void tick().then(() => live()[0]?.focus())
  })

  /**
   * Почему часть пунктов погашена — словами и под самим меню.
   *
   * Не в `title` у каждого: под указателем подсказку ждут секунду, а с пальца
   * её не видно никогда. Причина обычно одна на всё меню («переименовывает и
   * удаляет преподаватель»), так что повторять её у каждого пункта значило бы
   * написать одно и то же трижды в списке из восьми строк. Две — потолок:
   * дальше это уже не подпись, а абзац.
   */
  const reasons = $derived.by(() => {
    const out: string[] = []
    for (const item of items) {
      if (!item.disabled || !item.why || out.includes(item.why)) continue
      out.push(item.why)
      if (out.length === 2) break
    }
    return out
  })

  /**
   * Закрыть — и вернуть фокус. Одна дверь на все выходы: Escape, нажатие мимо,
   * прокрутка, выбранный пункт.
   */
  function close(): void {
    const back = opener
    onclose()
    void tick().then(() => {
      if (back?.isConnected) back.focus()
    })
  }

  function choose(item: ContextMenuItem): void {
    if (item.disabled) return
    // Сначала закрыть, потом сделать: половина пунктов открывает строку ввода
    // или подтверждение в той же панели, и меню поверх них — лишний слой между
    // человеком и тем, что он только что заказал. Фокус при этом возвращается
    // на строку, а действие уводит его дальше само.
    close()
    item.run()
  }

  /** Пункты, которые можно выбрать, — в порядке отрисовки. */
  function live(): HTMLButtonElement[] {
    if (!box) return []
    return [...box.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')]
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Съеденный ключ помечается: тем же Escape комната закрывает ящик
      // терминала, и «убрал меню» — как раз тот случай, когда он понадобился.
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Tab') {
      // Круга Tab внутри меню нет намеренно: меню — не окно, уходить из него
      // Tab'ом естественно, а ловушка фокуса в списке из восьми строк только
      // запирает того, кто промахнулся клавишей.
      event.preventDefault()
      close()
      return
    }
    const list = live()
    if (list.length === 0) return
    const now = list.indexOf(document.activeElement as HTMLButtonElement)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = now < 0 ? 0 : (now + 1) % list.length
    else if (event.key === 'ArrowUp') {
      next = now < 0 ? list.length - 1 : (now - 1 + list.length) % list.length
    } else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = list.length - 1
    if (next === null) return
    event.preventDefault()
    list[next].focus()
  }

  /*
   * Меню закрывается снаружи: нажатие мимо, прокрутка, смена размера окна,
   * уход со вкладки. Слушатели живут ровно столько, сколько открыто меню, —
   * по образцу меню доступа, чтобы на окне не висело лишних обработчиков всю
   * пару.
   *
   * Прокрутка ловится в фазе захвата: полоса, в которой лежит позвавшая
   * строка, прокручивается сама, а меню прибито к окну — оно осталось бы
   * висеть над файлом, которого под ним уже нет. Нижний лист прокрутку
   * переживает: он не привязан ни к какой точке, а под ним всё равно подложка.
   */
  $effect(() => {
    if (!at) return
    const away = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-context-menu]')) return
      // Кнопка, открывшая меню, закрывает его сама вторым нажатием: без этого
      // подложка успевала закрыть меню раньше, и кнопка тут же открывала его
      // заново.
      if (target?.closest('[data-menu-button]')) return
      close()
    }
    const scrolled = (): void => {
      if (!coarse) close()
    }
    const resized = (): void => close()
    const hidden = (): void => {
      if (document.visibilityState === 'hidden') close()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', resized)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('scroll', scrolled, true)
      window.removeEventListener('resize', resized)
      document.removeEventListener('visibilitychange', hidden)
    }
  })
</script>

{#snippet rows(sheet: boolean)}
  {#each items as item, index (item.label)}
    {#if item.gap && index > 0}
      <span class="my-1 block h-px bg-line" aria-hidden="true"></span>
    {/if}
    <button
      role="menuitem"
      type="button"
      disabled={item.disabled}
      title={item.disabled ? (item.why ?? undefined) : undefined}
      class="flex w-full items-center text-left transition-colors duration-100
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
             disabled:pointer-events-none disabled:opacity-45
             {sheet ? 'h-11 gap-3 px-4 text-ui-lg' : 'h-7 gap-2 px-2.5 text-ui'}
             {item.danger
        ? 'text-danger hover:bg-danger/[0.08] focus-visible:ring-danger/40'
        : 'text-ink hover:bg-raised focus-visible:ring-accent/40'}"
      onclick={() => choose(item)}
    >
      {#if item.icon}
        <!-- Значок в слоте постоянной ширины: без него подписи разъезжались бы
             по строкам, у которых значка нет. -->
        <span class="flex shrink-0 items-center justify-center {sheet ? 'w-4' : 'w-[13px]'}">
          <Icon name={item.icon} size={sheet ? 16 : 13} />
        </span>
      {/if}
      <span class="min-w-0 flex-1 truncate">{item.label}</span>
      {#if item.keys && !sheet}
        <span class="shrink-0 font-mono text-micro text-faint">{item.keys}</span>
      {/if}
    </button>
  {/each}
{/snippet}

{#snippet why()}
  {#if reasons.length > 0}
    <!-- Причина одна на всё меню и стоит под ним: см. `reasons`. Полоса
         отделена чертой и залита surface, чтобы не читаться как ещё один
         пункт, по которому можно нажать. -->
    <div data-menu-why class="mt-1 border-t border-line bg-surface px-2.5 py-2">
      {#each reasons as reason (reason)}
        <p class="text-2xs leading-snug text-muted">{reason}</p>
      {/each}
    </div>
  {/if}
{/snippet}

{#if at && coarse}
  <!--
    Палец: нижний лист во всю ширину. Ярус тот же, что у поповера ниже.
  -->
  <div class="fixed inset-0 z-[60]" role="presentation">
    <!--
      Подложка ничего не слушает сама, и это не упущение. Лист открывается
      ДОЛГИМ нажатием: палец к этой секунде уже лежит на экране, и его подъём
      браузер отдаёт как `click` — по тому, что оказалось под пальцем, то есть
      по подложке. Кнопка на ней закрывала бы лист ровно в тот миг, когда его
      открыли. Нажатие мимо ловит общий слушатель `pointerdown` (см. эффект
      выше): он срабатывает на НОВОЕ касание, а не на конец прежнего.
    -->
    <div class="absolute inset-0 bg-canvas/70" aria-hidden="true"></div>
    <div
      bind:this={box}
      data-context-menu
      role="menu"
      tabindex="-1"
      aria-label={label}
      class="absolute inset-x-0 bottom-0 flex flex-col border-t border-line bg-canvas
             pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-pop"
      {onkeydown}
      in:fly={{ y: prefersReducedMotion() ? 0 : 20, duration: 160, easing: quintOut }}
    >
      {#if title}
        <div class="flex h-11 items-center gap-2 border-b border-line pl-4 pr-1">
          <p class="min-w-0 flex-1 truncate text-2xs font-bold uppercase tracking-label text-muted">
            {title}
          </p>
          <!-- Выход, который видно. Подложка закрывает лист и так, но на
               телефоне «нажмите мимо» — знание, а не подсказка. -->
          <button
            type="button"
            class="flex h-11 w-11 shrink-0 items-center justify-center text-muted
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
                   focus-visible:ring-accent/40"
            aria-label={tr('room.files.menu.close')}
            onclick={close}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      {/if}
      <div class="flex flex-col py-1">{@render rows(true)}</div>
      {@render why()}
    </div>
  </div>
{:else if at}
  <!--
    Ярус — тот же, что у меню доступа на вкладке тетради (z-[60]): выше ящиков
    комнаты (z-40) и пульта правил (z-50), ниже меню бана (z-[96]), окна отказа
    (z-[97]) и плашек «вас удалили» (z-[100]). Порядок важен в обе стороны:
    под ящиком меню было бы нарисованным, кликабельным и невидимым, а поверх
    окна отказа — перекрывало бы единственное, что в ту минуту важно.
  -->
  <div
    bind:this={box}
    data-context-menu
    role="menu"
    tabindex="-1"
    aria-label={label}
    class="fixed z-[60] w-60 border border-line bg-canvas pt-1 shadow-pop
           {reasons.length > 0 ? '' : 'pb-1'}"
    style={`left:${place.x}px; top:${place.y}px`}
    {onkeydown}
    in:fly={{ y: prefersReducedMotion() ? 0 : -4, duration: 120, easing: quintOut }}
  >
    <div class="px-1">
      {#if title}
        <!-- Имя того, по чему нажали, — как в меню бана и меню доступа. Меню
             встаёт поверх списка и закрывает собой соседние строки: без имени
             внутри легко решить, что удаляешь не то, во что целился. -->
        <p
          class="truncate px-2.5 pb-1 pt-0.5 text-2xs font-bold uppercase tracking-label text-muted"
        >
          {title}
        </p>
      {/if}
      <div class="flex flex-col">{@render rows(false)}</div>
    </div>
    {@render why()}
  </div>
{/if}

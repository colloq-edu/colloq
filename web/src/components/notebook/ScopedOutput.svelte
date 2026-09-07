<script lang="ts" module>
  /**
   * Богатый вывод ядра — в теневом корне, а не в странице.
   *
   * DOMPurify по умолчанию оставляет тег style, и это правильно ровно для того,
   * ради чего его оставили: `df.style` — настоящая возможность pandas, а
   * matplotlib в режиме svg кладёт свои правила прямо в `defs`. Но тег style
   * внутри страницы — это таблица стилей ВСЕЙ страницы, и одна строка
   * `display(HTML(...))` со скрывающим всё правилом гасила экран у всей комнаты
   * и на проекторе: вывод лежит в документе, перезагрузка возвращала то же
   * самое, кнопка Clear оказывалась спрятана вместе со всем остальным.
   * Безобидная версия той же дыры — `stroke-linecap` из matplotlib, после
   * которого у всех менялись значки интерфейса.
   *
   * Довод «кто заставит ядро выдать HTML, тот и так может всё» — про контейнер
   * ядра, а не про браузеры соседей: код в контейнере чужие экраны гасить не
   * умеет, HTML-вывод умел. И он прямо спорил с тем, что тот же тег для
   * заметок запрещён — в комнате с `run: room` любой студент выдаёт HTML одной
   * строкой.
   *
   * Теневой корень закрывает это устройством, а не запретом: правила внутри
   * него действуют только внутри него, и `df.style` продолжает работать ровно
   * как работал. Оформление таблиц едет туда же — снаружи оно бы уже не
   * доставало.
   *
   * `contain: paint` на хозяине закрывает вторую половину: он делает элемент
   * содержащим блоком для `position: fixed` потомков и подрезает рисование его
   * же рамкой. Атрибут `style="position:fixed;inset:0"` — та самая дыра,
   * которую для заметок закрыли запретом атрибута, — больше не накрывает экран.
   */

  /** Общее обоим видам: хозяин теневого корня — обычный блок. */
  const BASE = `
    :host { display: block; }
    :host([hidden]) { display: none; }
  `

  /**
   * Оформление таблицы pandas. Раньше жило в стилях самого CellOutputs через
   * `:global`; в теневой корень оно обязано переехать целиком, иначе таблица
   * приедет со своими светлыми рамками поверх тёмной темы.
   *
   * `!important` остаётся: ядро присылает свои правила, и ложатся они в тот же
   * корень ПОСЛЕ этих.
   */
  const HTML_CSS = `${BASE}
    table { border-collapse: collapse; margin: 2px 0; }
    th, td {
      border: 1px solid rgb(var(--line)) !important;
      padding: 3px 8px !important;
      color: rgb(var(--ink)) !important;
      text-align: right;
      white-space: nowrap;
    }
    thead th {
      background: rgb(var(--raised)) !important;
      color: rgb(var(--muted)) !important;
      font-weight: 600;
    }
    tbody th { color: rgb(var(--muted)) !important; text-align: left; }
    tbody tr:hover td { background: rgb(var(--raised) / 0.55) !important; }
    a { color: rgb(var(--accent)); text-decoration: underline; }
    pre {
      font-family: var(--font-mono);
      white-space: pre-wrap;
    }
  `

  const SVG_CSS = `${BASE}
    svg { max-width: 100%; height: auto; }
  `

  export const SCOPE_CSS: Record<'html' | 'svg', string> = { html: HTML_CSS, svg: SVG_CSS }
</script>

<script lang="ts">
  interface Props {
    /** Уже прошедшая через lib/render разметка. Сюда сырое не попадает. */
    markup: string
    /** Какой набор правил положить в корень рядом с ней. */
    kind: 'html' | 'svg'
    class?: string
  }

  let { markup, kind, class: className = '' }: Props = $props()

  let host = $state<HTMLDivElement | null>(null)

  $effect(() => {
    const node = host
    const body = markup
    const css = SCOPE_CSS[kind]
    if (!node) return
    // Второй attachShadow на том же узле бросает исключение, а узел переживает
    // смену вывода: корень заводится один раз и дальше только переписывается.
    const shadow = node.shadowRoot ?? node.attachShadow({ mode: 'open' })

    /*
     * Разметка собирается в `template`, а не пишется в корень напрямую.
     *
     * Содержимое `template` инертно: браузер его не применяет и ничего по нему
     * не загружает, пока узлы не перенесли в документ. Это и есть окно, в
     * котором можно убрать `@import` — вторую половину той же дыры, что и
     * глобальные правила. Скоуп его обезвреживает лишь наполовину: правила
     * действуют только внутри корня, но АДРЕС всё равно был бы запрошен из
     * браузера каждого в комнате. Пиши мы прямо в корень, запрос ушёл бы в тот
     * же миг, и вычищать было бы уже поздно.
     */
    const template = document.createElement('template')
    template.innerHTML = body
    for (const sheet of template.content.querySelectorAll('style')) {
      const text = sheet.textContent ?? ''
      if (text.includes('@import')) sheet.textContent = text.replace(/@import\s[^;]*;?/gi, '')
    }

    // Элементом, а не строкой в разметке: строка с тегом style внутри .svelte
    // разрывает разбор самого компонента.
    const rules = document.createElement('style')
    rules.textContent = css
    shadow.replaceChildren(rules, template.content)
  })
</script>

<!-- Хозяин теневого корня. `contain: paint` — не про скорость, а про то, что
     `position: fixed` изнутри больше не доезжает до окна. -->
<div bind:this={host} class={className} style="contain: paint"></div>

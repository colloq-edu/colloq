/**
 * marked, DOMPurify and ansi_up exist to render text other people wrote, so
 * nothing needs them until a notebook is on screen. They used to be imported
 * directly by three components, which put 25 KB gzip of markdown and ANSI
 * machinery on the join screen — the one screen thirty students hit at the same
 * moment, on the same wifi, at the start of a seminar.
 *
 * They now arrive as one chunk on first render, and until it lands every caller
 * shows readable plain text instead of nothing.
 *
 * The sanitising policy lives here and only here. Each of the three consumers
 * used to carry its own copy of it; a second copy of a security policy is how a
 * hole gets opened, not how one gets closed.
 */

import { foldAnsiColours, pendingEscape } from './ansi'
import { safeStyle } from '@shared/note-css'
import { MARKDOWN_FORBIDDEN_ATTRS, MARKDOWN_FORBIDDEN_TAGS } from './sanitize'

export { ansi256ToBasic, foldAnsiColours, stripAnsi } from './ansi'

/** What the module exposes once the chunk has landed. */
export interface Renderers {
  /** Untrusted markdown -> sanitized HTML, external links defused. */
  markdown: (source: string) => string
  /** Terminal/stdout text -> sanitized HTML with the ANSI colours kept. */
  ansi: (text: string) => string
  /** Untrusted HTML (a DataFrame repr, a rich output) -> sanitized HTML. */
  html: (markup: string) => string
  /** Untrusted SVG (a matplotlib figure) -> sanitized SVG. */
  svg: (markup: string) => string
}

/*
 * Narrowing happens in the .then PARAMETER on purpose. Hand Rollup a whole
 * module namespace — `.then((m) => m.marked)` counts as whole — and it has to
 * assume every export of the package is live, which measured 28 KB of dead
 * CodeMirror when the editor was split the same way.
 */
/*
 * Математика в заметках — как в Jupyter: `$…$` внутри строки, `$$…$$` блоком.
 *
 * Свои два расширения marked вместо готового marked-katex-extension: тому
 * нужно рисовать формулу сразу, а здесь она должна пережить санитайзер (см.
 * ниже в `markdown`). Разметка получает пустой узел с TeX в атрибуте —
 * закодированным, чтобы ни кавычка, ни `<` из формулы не стали разметкой.
 *
 * `$5 и $10` — не формула: после открывающего доллара и перед закрывающим не
 * бывает пробела, а за закрывающим — цифры. Это правило Pandoc, и оно же
 * спасает цены в тексте задачи.
 */
const mathSlot = (tex: string, display: boolean): string =>
  `<${display ? 'div' : 'span'} data-math="${encodeURIComponent(tex)}"${display ? ' data-display=""' : ''}></${display ? 'div' : 'span'}>`

const blockMath = {
  name: 'blockMath',
  level: 'block' as const,
  start: (src: string) => src.indexOf('$$'),
  tokenizer(src: string) {
    const match = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src)
    return match ? { type: 'blockMath', raw: match[0], text: match[1].trim() } : undefined
  },
  renderer: (token: { text: string }) => mathSlot(token.text, true),
}

const inlineMath = {
  name: 'inlineMath',
  level: 'inline' as const,
  start: (src: string) => src.indexOf('$'),
  tokenizer(src: string) {
    const match = /^\$\$([^$]+?)\$\$/.exec(src) ?? /^\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$(?!\d)/.exec(src)
    if (!match) return undefined
    const display = match[0].startsWith('$$')
    return { type: display ? 'blockMath' : 'inlineMath', raw: match[0], text: match[1].trim() }
  },
  renderer: (token: { text: string }) => mathSlot(token.text, false),
}

async function importRenderers(): Promise<Renderers> {
  const [{ marked }, { DOMPurify }, { AnsiUp }, { katex }] = await Promise.all([
    import('marked').then(({ marked }) => ({ marked })),
    import('dompurify').then(({ default: DOMPurify }) => ({ DOMPurify })),
    import('ansi_up').then(({ AnsiUp }) => ({ AnsiUp })),
    import('katex').then(({ default: katex }) => ({ katex })),
    // Стили KaTeX вместе с его шрифтами — отдельным куском, только когда на
    // экране тетрадь: остальным страницам формулы не нужны.
    // @ts-expect-error — у css нет типов, а нужен только побочный эффект
    import('katex/dist/katex.min.css'),
  ])
  marked.use({ extensions: [blockMath, inlineMath] })

  const newConverter = () => {
    const converter = new AnsiUp()
    converter.escape_html = true
    /*
     * Classes, not inline colours. ansi_up's own palette puts an error name at
     * 2.79:1 on the dark ground — the least readable thing on screen at the
     * moment it matters most, because a traceback is what you read when
     * something has just broken. The .ansi-* rules in index.css carry a
     * palette measured against both grounds instead.
     */
    converter.use_classes = true
    return converter
  }

  /** Уже отрисованный кусок вывода и конвертер, которым его рисовали. */
  interface Trail {
    text: string
    html: string
    converter: ReturnType<typeof newConverter>
  }

  /*
   * Записей несколько: на экране бывает несколько выводов сразу, и одна запись
   * означала бы, что они по очереди выбивают друг друга и каждый платит полную
   * цену. Восьми хватает на видимую часть тетради, а держат они то, что и так
   * лежит в документе.
   */
  const trails: Trail[] = []

  function trailFor(body: string): Trail {
    let best: Trail | null = null
    for (const trail of trails) {
      if (!body.startsWith(trail.text)) continue
      if (!best || trail.text.length > best.text.length) best = trail
    }
    if (best) return best
    const fresh: Trail = { text: '', html: '', converter: newConverter() }
    trails.unshift(fresh)
    trails.length = Math.min(trails.length, 8)
    return fresh
  }

  return {
    markdown(source) {
      const raw = marked.parse(source, { async: false, gfm: true, breaks: true })
      const holder = document.createElement('div')
      holder.appendChild(
        DOMPurify.sanitize(raw, {
          RETURN_DOM_FRAGMENT: true,
          FORBID_TAGS: MARKDOWN_FORBIDDEN_TAGS,
          FORBID_ATTR: MARKDOWN_FORBIDDEN_ATTRS,
        }),
      )
      /*
       * Оформление заметки — по белому списку свойств, и считается оно ЗДЕСЬ:
       * после санитайзера, но ДО того, как формулы станут разметкой.
       *
       * Порядок не косметический. KaTeX раскладывает формулу теми самыми
       * свойствами, которые заметке запрещены, — `position: absolute`, `top`,
       * отрицательными сдвигами в `em`, — и, попади его собственный вывод под
       * этот же фильтр, дроби и радикалы сложились бы в кашу. Отделить своё от
       * чужого по классу `.katex` нельзя: сырой HTML в markdown проходит как
       * есть, и `<span class="katex">` напишет кто угодно. Поэтому чужое
       * чистится, пока своего ещё нет.
       *
       * Работа идёт по отцепленному `holder`: узел вне документа ничего не
       * применяет и ничего по себе не загружает, так что `position: fixed` из
       * чужой заметки не успевает накрыть экран, а `background: url(…)` — уйти
       * запросом из браузера каждого в комнате. В страницу уезжает уже строка,
       * в которой от `style` осталось только разрешённое (shared/note-css.ts).
       *
       * Пустой результат снимает атрибут целиком: `style=""` в разметке ничем
       * не лучше его отсутствия, а в сравнении версий читается как правка.
       */
      for (const styled of holder.querySelectorAll('[style]')) {
        const kept = safeStyle(styled.getAttribute('style') ?? '')
        if (kept) styled.setAttribute('style', kept)
        else styled.removeAttribute('style')
      }
      /*
       * Формулы рисуются ПОСЛЕ санитайзера, и это не случайный порядок.
       *
       * KaTeX раскладывает формулу инлайновыми `style` — высота, сдвиг,
       * отбивка, `position: absolute` в дробях, — то есть ровно тем, чего
       * заметке нельзя (shared/note-css.ts) и правильно нельзя. Поэтому
       * разметка несёт не готовую формулу, а её TeX в атрибуте: санитайзер
       * проходит по нему как по тексту, фильтр оформления выше — тоже, и лишь
       * потом KaTeX строит своё дерево из TeX, уже за их спиной. А в TeX ни
       * стиля, ни тега не пронести: `trust` выключен, ошибка разбора
       * выводится текстом.
       */
      for (const slot of holder.querySelectorAll('[data-math]')) {
        const tex = decodeURIComponent(slot.getAttribute('data-math') ?? '')
        slot.removeAttribute('data-math')
        const display = slot.hasAttribute('data-display')
        slot.removeAttribute('data-display')
        slot.innerHTML = katex.renderToString(tex, {
          throwOnError: false,
          displayMode: display,
          output: 'htmlAndMathml',
          trust: false,
          strict: 'ignore',
        })
      }
      /*
       * Широкая таблица едет внутри своей обёртки, а не распирает колонку.
       *
       * Двенадцать колонок не помещаются ни в ячейку тетради, ни тем более в
       * панель оракула на 380 px, а переносить в них текст «где угодно» —
       * значит получить двенадцать столбиков по букве. Обёртка с
       * `overflow-x: auto` (.table-scroll в index.css) — единственное место,
       * где такой прокрутке место: сама лента вбок не ездит.
       *
       * Здесь, а не в правиле CSS у `table`, потому что markdown обёртки не
       * даёт, а `display: block` на самой таблице ломает её же раскладку. И
       * после санитайзера: узел строится нами, а не приезжает из чужого текста.
       */
      for (const table of holder.querySelectorAll('table')) {
        const box = document.createElement('div')
        box.className = 'table-scroll'
        table.replaceWith(box)
        box.appendChild(table)
      }
      // A note is written by a classmate; a link in it must not be able to
      // navigate the seminar tab away from the seminar.
      for (const anchor of holder.querySelectorAll('a[href]')) {
        anchor.setAttribute('target', '_blank')
        anchor.setAttribute('rel', 'noopener noreferrer nofollow')
      }
      return holder.innerHTML
    },

    /*
     * Растущий вывод дорисовывается ХВОСТОМ, а не пересобирается целиком.
     *
     * Сюда всегда приходит весь накопленный текст ячейки, а сервер дописывает
     * его каждые 50 мс: обучение, печатающее по строке лога, к концу доходит до
     * сотен килобайт, и полный ansi_to_html плюс DOMPurify на каждый флеш — это
     * цена, растущая квадратично от объёма вывода, у КАЖДОГО в комнате, у кого
     * ячейка на экране. Поэтому конвертер и уже готовый HTML держатся рядом с
     * текстом, из которого получены: пришло продолжение — разбирается только
     * продолжение.
     *
     * Цвет от этого не теряется, а наоборот, только так и работает: AnsiUp несёт
     * состояние от куска к куску сам — ровно поэтому конвертер живёт вместе со
     * своим текстом, а не создаётся заново. Начатый, но не дописанный escape
     * остаётся ждать следующего флеша: разрезанный пополам, он покрасил бы
     * остаток лога наугад.
     *
     * Текст, который не продолжает ничего (другая ячейка, `clear_output`),
     * заводит свою запись и рисуется с нуля — то есть как раньше.
     */
    ansi(text) {
      const body = text.slice(0, text.length - pendingEscape(text))
      const trail = trailFor(body)
      if (body.length > trail.text.length) {
        const tail = foldAnsiColours(body.slice(trail.text.length))
        trail.html += DOMPurify.sanitize(trail.converter.ansi_to_html(tail))
        trail.text = body
      }
      return trail.html
    },

    html: (markup) => DOMPurify.sanitize(markup),

    svg: (markup) =>
      DOMPurify.sanitize(markup, { USE_PROFILES: { svg: true, svgFilters: true, html: true } }),
  }
}

let loaded = $state<Renderers | null>(null)
let inFlight: Promise<Renderers> | null = null

/**
 * Idempotent: a notebook with forty output blocks fetches the chunk once.
 * Safe to call from component init purely to warm it.
 *
 * Отказ не кешируется. Один оборванный запрос — семинарский вайфай, редеплой
 * под открытой вкладкой — оставлял бы вкладку без markdown, цветов и графиков
 * НАВСЕГДА: обещание уже отклонено, а нового никто не создаст. Следующий, кому
 * рендереры понадобятся (соседняя ячейка, переход в тетрадь), пробует снова.
 */
export function loadRenderers(): Promise<Renderers> {
  return (inFlight ??= importRenderers()
    .then((ready) => {
      loaded = ready
      return ready
    })
    .catch((err: unknown) => {
      inFlight = null
      throw err
    }))
}

/**
 * The renderers if they are here, null if the chunk is still in flight. Reading
 * this inside a $derived is what re-runs a render once it lands.
 */
export function renderers(): Renderers | null {
  return loaded
}

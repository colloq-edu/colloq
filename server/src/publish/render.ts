import { tr, getLocale, formatNumber } from '@shared/i18n'
/**
 * Опубликованный семинар как набор обычных файлов.
 *
 * Страница, ради которой всё это делалось, должна работать в среду вечером,
 * когда ноутбук преподавателя закрыт. Пока её отдаёт тот же процесс, который
 * ведёт занятия, «всегда доступно» означает «пока он включён» — то есть не
 * означает ничего.
 *
 * Поэтому публикация выгружается в статику: каталог на курс, каталог на шаг,
 * в каждом обычный `index.html` со всем содержимым внутри. Ни запросов к API,
 * ни маршрутизации на стороне клиента, ни JavaScript вообще — такой файл
 * откроется и через десять лет, и из архива, и с флешки.
 *
 * Цена честная и её надо назвать: это ВТОРОЙ отрисовщик тетради, рядом со
 * Svelte-компонентами комнаты. Разойтись они могут, и однажды разойдутся.
 * Держать один было бы можно только серверным рендерингом Svelte, а это
 * сборочная машинерия ради страницы, которая после выгрузки не меняется
 * никогда. Для замороженного предмета отдельный простой отрисовщик — верный
 * размен; за ним следит `tests/render.test.mts`.
 */
import { BLOB_PREFIX, ROBOTS_TAG, type PublicCell, type PublicCourseView } from '@shared/publish'
import { PLOTLY_MIME } from '@shared/plotly'
import { plural } from '@shared/plural'
import { safeStyle } from '@shared/note-css'
import type { CellOutput } from '@shared/notebook'

/**
 * Текст без управляющих последовательностей.
 *
 * Ядро печатает цвет как есть, и в комнате его красит ansi_up. Здесь скриптов
 * нет вовсе, так что выбор простой: либо снять escape-последовательности, либо
 * оставить студенту `[0;31m` посреди трейсбека — а трейсбеки IPython красит
 * всегда. Тот же набор, что в комнате (web/src/lib/ansi.ts).
 */
// eslint-disable-next-line no-control-regex -- escape-коды здесь и есть предмет
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

const plain = (value: string): string => value.replace(ANSI, '')

/** Экранирование текста, попадающего в HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Разметка ячейки-заметки.
 *
 * Нарочно крошечное подмножество markdown: заголовки, огороженный код, списки
 * обоих видов, курсив, жирный, код в строке, ссылки, абзацы. Тащить сюда
 * полноценный markdown с санитайзером — это тот же вес, что и в приложении,
 * ради страницы без единого скрипта. Всё, что подмножество не знает, остаётся
 * текстом: непонятый синтаксис виден, но безвреден.
 *
 * А вот HTML — не «то, чего подмножество не знает», и текстом оставаться не
 * должен. Вся заметка уходила в `esc()`, поэтому врезка `<div style="…">` из
 * учебного ноутбука доезжала до студента тегами напечатанными, тогда как в
 * комнате та же ячейка рисовалась. Теперь разметка идёт через тот же белый
 * список тегов, что и вывод ядра (`htmlSubset`), только шире — и через тот же
 * белый список свойств, что и в комнате (shared/note-css.ts).
 *
 * Огороженный код разбирается первым и не по желанию оформления: внутри
 * учебного примера строка `# считаем среднее` — комментарий, а не заголовок, а
 * `- x` — вычитание, а не пункт списка. Пока фенса здесь не было, самая частая
 * конструкция учебной тетради читалась на странице как каша: крупный заголовок
 * посреди примера и код, разорванный на абзацы по пустым строкам.
 */
function markdown(source: string, depth = 1): string {
  /** Путь до корня публикации: картинка заметки лежит рядом со страницей шага. */
  const up = '../'.repeat(Math.max(0, depth - 1))
  const inline = (text: string): string =>
    esc(text)
      /*
       * Картинка ЗАМЕТКИ — из записи публикации, а не строкой base64.
       *
       * В комнате она лежит на полке (shared/images.ts), при сборке страницы
       * копируется в записи публикации (publish/build.ts · projectNote) и
       * получает адрес `blob:<хэш>.<ext>`. Правило стоит ДО остальных: без
       * него `![схема](blob:…)` уходил в `esc` и печатался на странице текстом.
       */
      .replace(
        /!\[([^\]]*)\]\(blob:([0-9a-f]{8,64})\.([a-z0-9]+)\)/gi,
        (_all, alt: string, hash: string, ext: string) =>
          `<img class="note-img" src="${up}blob/${hash}.${ext}" alt="${alt.trim()}">`,
      )
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      /*
       * Картинка — ссылкой, а не `<img src="https://…">`: страница обязана
       * открываться из архива и с флешки, а внешний адрес однажды не доедет и
       * оставит на её месте битую рамку. Без этого правила `![схема](url)`
       * доезжал до студента как «!» со ссылкой.
       */
      .replace(
        /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
        (_all, alt: string, href: string) =>
          `<a href="${href}" rel="noreferrer">${alt.trim() || tr("server.image.49cd3c")}</a>`,
      )
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')

  const policy = noteHtml(up)
  /*
   * Стопка незакрытых тегов — одна на всю заметку, а не на кусок разметки.
   *
   * `<div align="center">`, пустая строка, `# Заголовок`, пустая строка,
   * `</div>` — самый частый способ отцентрировать заголовок в ноутбуке, и
   * пустые строки режут его на ТРИ куска. Закрывай каждый кусок по себе — див
   * схлопнулся бы пустым, а заголовок встал бы рядом с ним, а не внутри.
   */
  const open: string[] = []
  /** Разметка блока: теги копятся в общей стопке и переживают пустую строку. */
  const blockHtml = (markup: string): string => htmlSubset(markup, policy, esc, open)
  /*
   * Разметка ВНУТРИ строки — со своей стопкой, и это не мелочь: у абзаца есть
   * `</p>`, и незакрытый `<b>` обязан закрыться раньше него, а не дожить до
   * конца заметки. Иначе `<p><b>текст</p>…</b>` — и жирным становится всё
   * остальное.
   */
  const lineHtml = (markup: string): string => htmlSubset(markup, policy, inline)

  const out: string[] = []
  let bullets: string[] = []
  let numbers: string[] = []
  /** Строки внутри ```-ограды. `null` — ограды сейчас нет. */
  let fenced: string[] | null = null
  /** Строки блока разметки. `null` — блока сейчас нет; конец блока — пустая строка. */
  let block: string[] | null = null

  const flush = (): void => {
    if (bullets.length > 0) {
      out.push(`<ul>${bullets.map((li) => `<li>${lineHtml(li)}</li>`).join('')}</ul>`)
      bullets = []
    }
    if (numbers.length > 0) {
      out.push(`<ol>${numbers.map((li) => `<li>${lineHtml(li)}</li>`).join('')}</ol>`)
      numbers = []
    }
  }
  const closeFence = (): void => {
    if (fenced === null) return
    out.push(`<pre class="code">${esc(fenced.join('\n'))}</pre>`)
    fenced = null
  }
  /*
   * Внутри блока разметки инлайнового markdown нет — так же, как в комнате у
   * marked и как в CommonMark. `**жирный**` внутри `<div>` остаётся звёздочками,
   * и это не упущение: автор, написавший тег, верстает сам.
   */
  const closeBlock = (): void => {
    if (block === null) return
    out.push(blockHtml(block.join('\n')))
    block = null
  }

  for (const line of source.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (fenced === null) {
        flush()
        // Язык после ограды («```python») — подсказка подсветке, которой здесь
        // нет; текстом на странице ей делать нечего.
        fenced = []
      } else {
        closeFence()
      }
      continue
    }
    if (fenced !== null) {
      fenced.push(line)
      continue
    }
    if (block === null) {
      const opens = /^\s{0,3}<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(line)
      if (opens && NOTE_BLOCKS.has(opens[1].toLowerCase())) {
        flush()
        block = []
      }
    }
    if (block !== null) {
      if (line.trim() === '') closeBlock()
      else block.push(line)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const number = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = Math.min(heading[1].length + 1, 5)
      out.push(`<h${level}>${lineHtml(heading[2])}</h${level}>`)
    } else if (bullet) {
      if (numbers.length > 0) flush()
      bullets.push(bullet[1])
    } else if (number) {
      if (bullets.length > 0) flush()
      numbers.push(number[1])
    } else if (line.trim() === '') {
      flush()
    } else {
      flush()
      out.push(`<p>${lineHtml(line)}</p>`)
    }
  }
  flush()
  // Ограда, которую забыли закрыть: остаток заметки — всё равно код, и
  // потерять его молча хуже, чем показать лишний блок.
  closeFence()
  closeBlock()
  // Незакрытый `<div>` из заметки закрывается здесь и дальше `.note` не идёт:
  // иначе он утащил бы за собой вёрстку всей страницы.
  while (open.length > 0) out.push(`</${open.pop()!}>`)
  return out.join('\n')
}

/** Адрес крупного куска вывода внутри выгруженного каталога. */
function blobHref(value: string, mime: string): string {
  const hash = value.slice(BLOB_PREFIX.length)
  const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
  return `blob/${hash}.${ext}`
}

/**
 * Трейсбек без того, что уже написано над ним.
 *
 * IPython открывает его строкой «Ename Traceback (most recent call last)» и
 * закрывает «Ename: evalue» — обе стоят заголовком выше. Комната снимает это
 * же (web/src/lib/traceback.ts); без этого страница читает одну ошибку трижды.
 * Снимается только точный повтор: угадывать, что здесь лишнее, — способ убрать
 * единственную полезную строку.
 */
const BANNER = /Traceback \(most recent call last\)/
function tracebackBody(lines: string[], ename: string, evalue: string): string {
  const kept = lines.map(plain)
  const bare = (line: string): string => line.trim()
  const rule = /^[-─—]{3,}$/
  if (kept.length > 1 && rule.test(bare(kept[0])) && BANNER.test(bare(kept[1]))) kept.shift()
  if (kept.length > 0 && bare(kept[0]).startsWith(ename) && BANNER.test(bare(kept[0]))) kept.shift()
  const dropBlanks = (): void => {
    while (kept.length > 0 && bare(kept[kept.length - 1]) === '') kept.pop()
  }
  dropBlanks()
  // `KeyboardInterrupt: ` — ошибка без значения всё равно закрывается двоеточием.
  const echoes = evalue ? [`${ename}: ${evalue}`] : [ename, `${ename}:`]
  if (kept.length > 0 && echoes.includes(bare(kept[kept.length - 1]))) kept.pop()
  dropBlanks()
  return kept.join('\n')
}

/**
 * Вывод, у которого есть только text/html: таблица pandas, `display(HTML(...))`.
 *
 * Такой вывод раньше исчезал со страницы без следа — под кодом пусто, а в
 * подвале «Out [7]», и студент читал это как «код ничего не напечатал».
 * `df.style`, `IPython.display.HTML`, plotly, ipywidgets — всё это отдаёт
 * text/html, и в комнате оно показывается.
 *
 * Показывается ПОДМНОЖЕСТВО, собранное белым списком, а не чужая разметка как
 * есть. Здесь она из вывода ячейки, то есть от кого угодно, кто в комнате
 * запускал код, и лежит она в файле, который откроют без всякого сервера:
 * `<script>` и `<style>` выбрасываются вместе с содержимым (стиль из вывода
 * перекрасил бы страницу целиком), остальные незнакомые теги снимаются, а текст
 * внутри них остаётся. Незакрытые теги закрываются здесь же — иначе один
 * `<div>` из вывода утащил бы за собой вёрстку всей страницы.
 */
const HTML_TAGS: ReadonlySet<string> = new Set(
  `table thead tbody tfoot tr td th caption colgroup col
   p div span br hr blockquote pre code
   b strong i em u s sub sup small
   ul ol li dl dt dd h1 h2 h3 h4 h5 h6 a`
    .trim()
    .split(/\s+/),
)

/** Теги без содержимого: закрывать их нечем и не надо. */
const HTML_VOID: ReadonlySet<string> = new Set(['br', 'hr', 'col', 'img'])

/** Что разрешено при теге в ВЫВОДЕ ядра. Всё остальное — включая style и class. */
const HTML_ATTRS: Record<string, ReadonlySet<string>> = {
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  a: new Set(['href']),
}

/**
 * Набор тегов и правило для атрибутов — одним предметом.
 *
 * Разборщик ниже один, а наборов два, и различаются они не капризом: вывод
 * ячейки — это репр `df.style` и таблица pandas, где оформление приходит
 * отдельным `<style>` и потому снимается целиком; заметка — это текст, который
 * человек написал руками, и `style` в нём и есть предмет разговора.
 */
interface HtmlPolicy {
  tags: ReadonlySet<string>
  /** Значение атрибута, каким его писать, или `null` — «не писать». */
  attr: (tag: string, name: string, value: string) => string | null
}

const OUTPUT_HTML: HtmlPolicy = {
  tags: HTML_TAGS,
  attr(tag, name, value) {
    if (!HTML_ATTRS[tag]?.has(name)) return null
    // Адрес — только http(s): `javascript:` в ссылке из вывода ячейки
    // исполнился бы у того, кто открыл страницу.
    if (name === 'href') return /^https?:\/\//i.test(value) ? value : null
    return /^\d{1,3}$|^(row|col|rowgroup|colgroup)$/.test(value) ? value : null
  },
}

/**
 * Теги, которые может принести ЗАМЕТКА.
 *
 * Шире, чем у вывода, и ровно настолько, насколько шире сам предмет: заметку
 * пишут разметкой, а не получают репром. `img`, `details`, `figure`, `font`,
 * `center` — то, из чего состоит обычная текстовая ячейка учебного ноутбука, и
 * без чего «HTML не работает» было бы правдой наполовину.
 *
 * `style`, `script`, `iframe`, `form`, `audio`, `video` сюда не входят и не
 * войдут: тот же список, что и в комнате (web/src/lib/sanitize.ts), — обещание
 * «те же ячейки» держится одинаковыми запретами, а не похожими.
 */
const NOTE_TAGS: ReadonlySet<string> = new Set([
  ...HTML_TAGS,
  ...`img figure figcaption details summary mark kbd abbr samp var q cite time
      ins del big tt center font
      section article aside header footer nav main`
    .trim()
    .split(/\s+/),
])

/**
 * Блочные теги заметки: со строки, начатой таким, идёт разметка, а не абзац.
 *
 * Без этого списка многострочный `<div>` разрезался бы на строки и каждая
 * оборачивалась в `<p>`: `<p><div …></p>` браузер чинит по-своему, и врезка
 * разъезжается. Правило конца блока — пустая строка, как в CommonMark и как у
 * marked в комнате; оно же и делает работающим `<div align="center">`, пустая
 * строка, `# Заголовок`, пустая строка, `</div>`.
 */
const NOTE_BLOCKS: ReadonlySet<string> = new Set(
  `div p table thead tbody tfoot tr td th caption colgroup col
   ul ol li dl dt dd blockquote pre hr
   h1 h2 h3 h4 h5 h6
   figure figcaption details summary center
   section article aside header footer nav main`
    .trim()
    .split(/\s+/),
)

/**
 * Адрес картинки заметки на выгруженной странице.
 *
 * `blob:<хэш>.<ext>` — запись публикации рядом со страницей шага (build.ts ·
 * projectNote), тот же путь, что у `![схема](blob:…)` в `inline`. Внешний
 * `https://` остаётся как написан: в markdown-картинке отрисовщик волен выбрать
 * представление и делает из неё ссылку, а сырой `<img>` человек поставил сам и
 * рассчитывал на него в вёрстке — подменять его ссылкой значит ломать чужой
 * макет молча.
 */
function noteImageSrc(value: string, up: string): string | null {
  const blob = /^blob:([0-9a-f]{8,64})\.([a-z0-9]+)$/i.exec(value)
  if (blob) return `${up}blob/${blob[1]}.${blob[2]}`
  if (/^https?:\/\//i.test(value)) return value
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(value)) return value
  return null
}

function noteHtml(up: string): HtmlPolicy {
  return {
    tags: NOTE_TAGS,
    attr(tag, name, value) {
      // Оформление — тем же белым списком свойств, что и в комнате.
      if (name === 'style') return safeStyle(value) || null
      if (name === 'title' || name === 'alt') return value
      if (name === 'align') return /^(left|right|center|justify)$/i.test(value) ? value : null
      if (name === 'width' || name === 'height') return /^\d{1,4}$/.test(value) ? value : null
      if (name === 'colspan' || name === 'rowspan' || name === 'span')
        return /^\d{1,3}$/.test(value) ? value : null
      if (name === 'scope') return /^(row|col|rowgroup|colgroup)$/i.test(value) ? value : null
      if (name === 'start' && (tag === 'ol' || tag === 'li'))
        return /^\d{1,4}$/.test(value) ? value : null
      if (tag === 'details' && name === 'open') return ''
      if (tag === 'time' && name === 'datetime') return value
      if (tag === 'font' && name === 'color') return /^[#\w(),.%\s-]{1,40}$/.test(value) ? value : null
      if (tag === 'font' && name === 'size') return /^[+-]?\d{1,2}$/.test(value) ? value : null
      if (tag === 'font' && name === 'face') return /^[\w ,'"-]{1,80}$/.test(value) ? value : null
      // Ссылка: http(s), почта и якорь. `javascript:` исполнился бы у того, кто
      // открыл страницу, — тот же довод, что и у вывода выше.
      if (tag === 'a' && name === 'href')
        return /^(https?:\/\/|mailto:|#)/i.test(value) ? value : null
      if (tag === 'img' && name === 'src') return noteImageSrc(value, up)
      /*
       * `class` не проходит намеренно. На статической странице свои правила —
       * `.code`, `.out`, `.err`, `.quiet`, — и заметка с `class="err"` читалась
       * бы как ошибка выполнения. В комнате класс безвреден, потому что там
       * оформление заметки задаёт `.prose-note`, а не имена из ячейки.
       */
      return null
    },
  }
}

function keepAttrs(policy: HtmlPolicy, tag: string, raw: string): string {
  let out = ''
  const pairs = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))|([a-zA-Z-]+)/g
  let found: RegExpExecArray | null
  while ((found = pairs.exec(raw)) !== null) {
    const name = (found[1] ?? found[5] ?? '').toLowerCase()
    if (!name) continue
    const value = found[2] ?? found[3] ?? found[4] ?? ''
    const kept = policy.attr(tag, name, value)
    if (kept === null) continue
    out += kept ? ` ${name}="${esc(kept)}"` : ` ${name}`
  }
  return out
}

/** Тег с его атрибутами: кавычки могут прятать внутри себя и «<», и «>». */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/y

/**
 * Разметка, приведённая к подмножеству политики.
 *
 * `text` — что делать с текстом ВНЕ тегов. У вывода он идёт как есть (репр уже
 * экранирован ядром, второй проход дал бы `&amp;amp;`), у заметки через него
 * проходит инлайновый markdown — и только через него: подставлять `**жирный**`
 * во всю строку значило бы дописывать теги внутрь чужого атрибута.
 *
 * `open` — стопка незакрытых тегов. Своя на вызов, если её не дали: одинокий
 * `<div>` из вывода утащил бы за собой вёрстку всей страницы. Заметка передаёт
 * сюда общую на все свои куски — тогда `<div align="center">` перед пустой
 * строкой и `</div>` после заголовка остаются одним блоком, как в комнате.
 */
function htmlSubset(
  source: string,
  policy: HtmlPolicy = OUTPUT_HTML,
  text: (value: string) => string = (value) => value,
  open?: string[],
): string {
  const stripped = source
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
  const out: string[] = []
  const stack = open ?? []
  let i = 0
  while (i < stripped.length) {
    const lt = stripped.indexOf('<', i)
    if (lt === -1) {
      out.push(text(stripped.slice(i)))
      break
    }
    out.push(text(stripped.slice(i, lt)))
    // Липкий разбор с позиции, а не по куску строки: `slice` на каждый тег
    // превращал бы таблицу на мегабайт в квадрат от её длины.
    TAG.lastIndex = lt
    const tag = TAG.exec(stripped)
    if (!tag) {
      // Одинокая «<» — это текст, а не начало тега.
      out.push('&lt;')
      i = lt + 1
      continue
    }
    i = TAG.lastIndex
    const name = tag[2].toLowerCase()
    if (!policy.tags.has(name)) continue
    if (tag[1]) {
      const at = stack.lastIndexOf(name)
      if (at === -1) continue
      while (stack.length > at) out.push(`</${stack.pop()!}>`)
      continue
    }
    out.push(`<${name}${keepAttrs(policy, name, tag[3])}>`)
    if (!HTML_VOID.has(name) && !/\/\s*$/.test(tag[3])) stack.push(name)
  }
  if (!open) while (stack.length > 0) out.push(`</${stack.pop()!}>`)
  return out.join('')
}

/**
 * Есть ли в разметке что показывать.
 *
 * Длина строки об этом не говорит, и это не мелочь: plotly, bokeh и ipywidgets
 * кладут в text/html пустой `<div id=…>` рядом со `<script>`, который рисует
 * его уже в браузере. Скрипт из чужого вывода в страницу не уезжает (см.
 * `htmlSubset`), и остаётся `<div></div>` — разметка непустая, а под ячейкой
 * пусто. Поверить непустой строке значит вернуть ровно то, ради чего всё это
 * писалось: пустое место с подписью «Out [1]» вместо честной пометки о
 * формате, которого страница не знает.
 *
 * Видимое — это текст вне тегов (`&nbsp;` за него не считается) и линейка,
 * которую видно саму по себе. Пустая таблица за содержимое не идёт: сетка
 * рамок без единой цифры читается как сломанная страница, а пометка — нет.
 */
function hasVisible(html: string): boolean {
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, ' ')
  return /\S/.test(text) || /<hr\b/i.test(html)
}

function outputHtml(output: CellOutput, depth: number): string {
  /*
   * Картинки лежат в корне публикации, рядом с первым шагом. Первый шаг — сам
   * этот корень (глубина 1), остальные на уровень глубже, так что подниматься
   * надо на `depth - 1`, а не на `depth`: лишний `../` уводил бы к соседней
   * публикации, и картинка не находилась бы именно на той странице, которую
   * открывают первой.
   */
  const up = '../'.repeat(depth - 1)
  if (output.kind === 'stream') {
    return `<pre class="out ${output.name === 'stderr' ? 'err' : ''}">${esc(plain(output.text))}</pre>`
  }
  if (output.kind === 'error') {
    const head = output.ename + (output.evalue ? ': ' + output.evalue : '')
    const body = tracebackBody(output.traceback, output.ename, output.evalue)
    return `<pre class="out err">${esc([plain(head), body].filter(Boolean).join('\n\n'))}</pre>`
  }
  /*
   * Интерактивный график — и честная строка вместо него.
   *
   * Выгруженный каталог живёт на статическом хостинге: сервера за ним нет, а
   * рамка, в которой рисуется plotly, — это ответ с особым заголовком
   * (`server/src/plotly-frame.ts`), и отдать его там некому. Рисовать фигуру
   * прямо в странице нельзя тем более: это чужие данные и пять мегабайт чужого
   * кода на origin, где лежат и другие занятия.
   *
   * Поэтому строка, а не пустое место: «Out [7]» без ничего под ним читается
   * как «код ничего не напечатал», и это враньё. Живая читалка инстанса тот же
   * график показывает целиком — про неё в строке и сказано.
   */
  if (output.data[PLOTLY_MIME] !== undefined) {
    return `<p class="quiet">${esc(tr('server.ssr.plotlyFigure'))}</p>`
  }
  const image = Object.entries(output.data).find(([mime]) => mime.startsWith('image/'))
  if (image) {
    const [mime, value] = image
    /*
     * SVG приходит от ядра XML-текстом, а не base64, и в отдельную запись не
     * уезжает (см. BLOB_MIMES): `data:image/svg+xml;base64,<xml>` давал пустую
     * рамку. Картинкой, а не разметкой прямо в странице: внутри `<img>` скрипт
     * из чужого вывода не исполняется.
     */
    const src = value.startsWith(BLOB_PREFIX)
      ? up + blobHref(value, mime)
      : mime === 'image/svg+xml'
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`
        : `data:${mime};base64,${value.replace(/\s/g, '')}`
    return `<p class="img"><img src="${esc(src)}" alt="${esc(tr('server.ssr.cellOutput'))}"></p>`
  }
  /*
   * text/html — раньше, чем text/plain, и это не вкус: у `df.style` в
   * text/plain лежит «<pandas.io.formats.style.Styler object at 0x…>», то есть
   * ровно то, вместо чего студент должен видеть таблицу.
   */
  const rich = output.data['text/html']
  if (rich) {
    const safe = htmlSubset(rich).trim()
    if (hasVisible(safe)) return `<div class="rich">${safe}</div>`
  }
  /*
   * `display(Markdown(...))` — подпись к выводу словами, и на странице она
   * обязана быть словами.
   *
   * Ядро присылает два представления: саму разметку и `text/plain` с репром
   * `<IPython.core.display.Markdown object>`. Пока этой ветки не было,
   * страница печатала имя класса — ровно то же, что делала комната до
   * `text/markdown` в `MIME_ORDER` (web/src/components/notebook/output-mimes.ts).
   *
   * Разбирается тем же подмножеством, что и заметка: `markdown` выше уже умеет
   * и белый список тегов, и белый список свойств, — то есть вывод ядра и текст
   * человека проходят здесь одну и ту же проверку.
   */
  const note = output.data['text/markdown']
  if (note) {
    const body = markdown(plain(note), depth).trim()
    if (hasVisible(body)) return `<div class="note">${body}</div>`
  }
  const text = output.data['text/plain']
  if (text) return `<pre class="out">${esc(plain(text))}</pre>`
  /*
   * Показать нечем — но сказать об этом надо. Пустое место под ячейкой с
   * подписью «Out [7]» читается как «код ничего не напечатал», и это враньё:
   * вывод был, просто он в формате, которого статическая страница не знает.
   */
  const kinds = Object.keys(output.data)
  return kinds.length > 0
    ? `<p class="quiet">${esc(tr('server.ssr.unsupportedOutput', { format: kinds.join(', ') }))}</p>`
    : ''
}

function cellHtml(cell: PublicCell, depth: number): string {
  if (cell.type === 'markdown') return `<div class="note">${markdown(cell.source, depth)}</div>`
  const outputs = cell.outputs.map((o) => outputHtml(o, depth)).join('\n')
  /*
   * `Out [—]` — вывод есть, а выполнения за ним уже нет: перезапускали ядро
   * или возвращали версию. Промолчать честнее, чем подставить номер.
   */
  const stamp =
    cell.execCount === null
      ? cell.outputs.length > 0
        ? '<span class="warn">Out [—]</span>'
        : `<span class="quiet">${esc(tr('server.ssr.notRun'))}</span>`
      : `Out [${cell.execCount}]${cell.ranMs !== null ? ` · ${formatNumber(cell.ranMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}s` : ''}`
  return [
    '<div class="cell">',
    `<pre class="code">${esc(cell.source)}</pre>`,
    outputs ? `<div class="outs">${outputs}</div>` : '',
    `<div class="foot">${stamp}</div>`,
    '</div>',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Оформление.
 *
 * Одним куском внутри файла: страница обязана открываться сама по себе, а
 * отдельный .css — это второй запрос, который однажды не доедет, и текст
 * поедет. Цвета и шрифты — те же, что в комнате.
 */
const STYLE = `
:root{--ink:#101A33;--muted:#5D6B8A;--faint:#9BA6BE;--line:#DCE3EF;--surface:#F3F6FB;--accent:#0B7FAB;--warn:#8E6B00;--err:#8E2334;--bg:#fff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent)}
.wrap{max-width:820px;margin:0 auto;padding:56px 20px 80px}
h1{font-size:38px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px}
.blurb{font-size:16px;color:var(--muted);margin:0 0 14px;max-width:36em}
.addr{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);margin:0 0 40px}
.rows{border-top:1px solid var(--line);margin:0;padding:0;list-style:none}
.row{display:flex;align-items:baseline;gap:20px;border-bottom:1px solid var(--line);padding:18px 0}
.row .n{width:34px;flex:0 0 auto;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint)}
.row .t{flex:1 1 auto;font-size:17px;font-weight:600;min-width:0}
.row .s{flex:0 0 auto;color:var(--muted);font-size:14px;white-space:nowrap}
.row.off .t{font-weight:400;color:var(--muted)}
.row.off .s{white-space:normal;max-width:45%;overflow-wrap:break-word;text-align:right}
.row a{text-decoration:none;color:inherit;display:flex;align-items:baseline;gap:20px;width:100%}
.row a:hover .t{color:var(--accent)}
.foot-note{color:var(--muted);font-size:14px;margin-top:34px}
header.top{border-bottom:1px solid var(--line);padding:36px 20px 22px}
header.top .in{max-width:1180px;margin:0 auto}
header.top h1{font-size:32px;margin:0 0 8px}
.meta{color:var(--muted);font-size:14px;margin:0}
.body{max-width:1180px;margin:0 auto;padding:0 20px;display:flex;gap:36px;align-items:flex-start}
.rail{width:250px;flex:0 0 auto;padding:26px 0;border-right:1px solid var(--line);position:sticky;top:0}
.rail h2{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.rail a{display:block;text-decoration:none;color:var(--muted);border-left:3px solid transparent;padding:7px 12px 7px 11px;margin-right:18px}
.rail a.on{border-left-color:var(--accent);background:var(--surface);color:var(--ink);font-weight:600}
.rail .w{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);display:block;margin-top:2px;font-weight:400}
.main{flex:1 1 auto;min-width:0;padding:26px 0 70px;max-width:820px}
.intro{background:var(--surface);border-left:3px solid var(--accent);padding:13px 16px;margin:0 0 30px}
.intro p{margin:0 0 5px;color:var(--muted);font-size:14px}
.intro p:last-child{margin:0}
.note{margin:0 0 22px}
.note h2{font-size:22px;margin:0 0 8px}.note h3{font-size:18px;margin:0 0 6px}
.note p{margin:0 0 8px}
.note:after{content:'';display:table;clear:both}
.note ul,.note ol{margin:0 0 8px;padding-left:22px}
.note blockquote{margin:0 0 8px;padding-left:12px;border-left:2px solid var(--line);color:var(--muted)}
.note img{max-width:100%;height:auto}
.note table{border-collapse:collapse;margin:0 0 10px}
.note th,.note td{border:1px solid var(--line);padding:4px 9px;text-align:left}
.note details{margin:0 0 8px}.note summary{cursor:pointer;color:var(--muted)}
.note code{background:var(--surface);padding:1px 4px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.note [style]{max-width:100%}
.note [style*="background"]{color:#1B2233}
.cell{border:1px solid var(--line);margin:0 0 22px}
.code{margin:0;padding:13px 15px;background:#FBFCFE;overflow-x:auto;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
.outs{border-top:1px solid var(--line);padding:11px 15px}
.out{margin:0;overflow-x:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.out.err{color:var(--err)}
.rich{overflow-x:auto;font-size:14px}
.rich table{border-collapse:collapse;font-size:13px;margin:0}
.rich th,.rich td{border:1px solid var(--line);padding:5px 9px;text-align:right;white-space:nowrap}
.rich th{color:var(--muted);font-weight:600}
.rich p{margin:0 0 6px}.rich p:last-child{margin:0}
.quiet{color:var(--faint);margin:0}
.img{margin:0}.img img{max-width:100%;height:auto;display:block}
.note-img{max-width:100%;height:auto;display:block;margin:10px 0}
.foot{border-top:1px solid var(--line);background:#FBFCFE;padding:6px 15px;text-align:right;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.foot .warn{color:var(--warn)}.foot .quiet{color:var(--faint)}
.take{border-top:1px solid var(--line);margin-top:34px;padding-top:18px;font-size:14px}
.take p{margin:0}
.take .why{color:var(--muted);margin-top:5px}
@media(max-width:860px){.body{display:block}.rail{width:auto;border-right:0;border-bottom:1px solid var(--line);position:static;padding:20px 0}.rail a{margin-right:0}}
@media(prefers-color-scheme:dark){:root{--ink:#E8EDF7;--muted:#9AA7C0;--faint:#6B7897;--line:#26304A;--surface:#161E33;--accent:#4FC3F0;--warn:#E0B44A;--err:#F0868E;--bg:#0D1526}.code,.foot{background:#111A2E}}
`

/**
 * Голова документа.
 *
 * `robots` — из общего решения (shared/publish.ts), а не из своего мнения:
 * инстанс отдаёт те же страницы по своим адресам, и пока правило стояло
 * комментарием по обе стороны, стороны успели разойтись.
 */
function head(title: string): string {
  return [
    `<!doctype html><html lang="${getLocale()}"><head>`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="robots" content="${ROBOTS_TAG}">`,
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
  ].join('')
}

const FOOT = '</body></html>'

export interface RenderedStep {
  seq: number
  label: string
  at: number
  cells: PublicCell[]
}

/*
 * Часовой пояс страницы задаётся явно, а не берётся у процесса.
 *
 * Выгрузку запускают на сервере, а не в аудитории: в контейнере и на обычном
 * VPS пояс не задан вовсе, то есть UTC, — и занятие, которое шло в Москве в
 * 15:04, страница подписывала «12:04». По такой подписи не найти, о какой паре
 * речь, а проверить её на статике нечем: в комнате время рисует браузер, здесь
 * рисовать некому.
 *
 * Пояс инстанса — `TZ`, и спрашивается она при каждом форматировании, а не
 * один раз при загрузке модуля: приезжает она из `.env` через dotenv в
 * config.ts, а этот модуль грузится раньше него. По той же причине пояс
 * передаётся опцией — переменная, прочитанная после старта, поясом процесса
 * может уже не стать.
 */
const HOME_ZONE = 'Europe/Moscow'
const DATE_FORM: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }
const TIME_FORM: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

function formatter(form: Intl.DateTimeFormatOptions, zone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(getLocale(), { ...form, timeZone: zone })
  } catch {
    // `TZ=МСК` и прочие имена, которых нет в базе поясов: опечатка в .env не
    // должна ронять выгрузку целиком.
    return new Intl.DateTimeFormat(getLocale(), { ...form, timeZone: HOME_ZONE })
  }
}

let clocks: { locale: string; zone: string; date: Intl.DateTimeFormat; time: Intl.DateTimeFormat } | null = null

function forms(): { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat } {
  const zone = process.env.TZ?.trim() || HOME_ZONE
  if (!clocks || clocks.zone !== zone || clocks.locale !== getLocale()) {
    clocks = { locale: getLocale(), zone, date: formatter(DATE_FORM, zone), time: formatter(TIME_FORM, zone) }
  }
  return clocks
}

const when = (at: number): string => forms().date.format(at)
const clock = (at: number): string => forms().time.format(at)

/** Страница курса. */
export function renderCourse(course: PublicCourseView, base: string): string {
  const rows = course.items
    .map((item, index) => {
      const n = String(index + 1).padStart(2, '0')
      if (item.kind === 'gone') {
        /*
         * Комнаты нет, а чтение осталось — это умолчание при удалении семинара,
         * и без ссылки строка была бы тупиком: страница жива, а с курса —
         * единственного адреса, который дают классу, — до неё не дойти.
         */
        if (!item.publication) {
          return `<li class="row off"><span class="n">${n}</span><span class="t">${esc(item.name)}</span><span class="s">${esc(tr('server.ssr.seminarDeleted'))}</span></li>`
        }
        const gone = `${base}/p/${item.publication.slug ?? item.publication.id}/`
        return [
          '<li class="row">',
          `<a href="${esc(gone)}">`,
          `<span class="n">${n}</span>`,
          `<span class="t">${esc(item.name)}</span>`,
          `<span class="s">${esc(tr('server.ssr.deletedReadable'))}</span>`,
          '</a></li>',
        ].join('')
      }
      if (item.kind === 'planned') {
        // Неделю набирают руками в панели, до сорока знаков: с `nowrap` на
        // телефоне она забирала всю строку и ложилась поверх темы. Отсюда
        // `.row.off .s` в STYLE — перенос и не больше 45% ширины.
        return `<li class="row off"><span class="n">${n}</span><span class="t">${esc(item.name)}</span><span class="s">${esc(item.when)}</span></li>`
      }
      if (!item.publication) {
        return `<li class="row off"><span class="n">${n}</span><span class="t">${esc(item.name)}</span><span class="s">${esc(tr('server.ssr.unpublished'))}</span></li>`
      }
      const href = `${base}/p/${item.publication.slug ?? item.publication.id}/`
      const steps =
        item.publication.steps === 1
          ? tr("server.onePage.d5f549")
          : tr('server.steps', { count: item.publication.steps })
      return [
        '<li class="row">',
        `<a href="${esc(href)}">`,
        `<span class="n">${n}</span>`,
        `<span class="t">${esc(item.name)}</span>`,
        `<span class="s">${esc(when(item.publication.publishedAt))} · ${steps}</span>`,
        '</a></li>',
      ].join('')
    })
    .join('\n')

  return [
    head(course.name),
    '<div class="wrap">',
    `<h1>${esc(course.name)}</h1>`,
    course.blurb ? `<p class="blurb">${esc(course.blurb)}</p>` : '',
    `<p class="addr">${esc(base.replace(/^https?:\/\//, ''))}/c/${esc(course.slug ?? course.id)}</p>`,
    `<ul class="rows">${rows}</ul>`,
    `<p class="foot-note">${esc(tr('server.ssr.courseAbout'))}</p>`,
    '</div>',
    FOOT,
  ].join('\n')
}

/**
 * Страница-указатель со старого адреса на нынешний.
 *
 * Курсу или публикации дали имя, и каталог теперь лежит под ним — а ссылка,
 * розданная классу с восьмисимвольным идентификатором, обязана работать и
 * после. На живом сервере это делает `WHERE id = ? OR slug = ?`; на Pages
 * маршрутизации нет вовсе, поэтому старый адрес остаётся файлом, который
 * перекладывает на новый. Ссылка внизу — на случай, если `refresh` выключен.
 */
export function renderRedirect(to: string, title: string): string {
  return [
    `<!doctype html><html lang="${getLocale()}"><head>`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="robots" content="${ROBOTS_TAG}">`,
    `<meta http-equiv="refresh" content="0; url=${esc(to)}">`,
    `<link rel="canonical" href="${esc(to)}">`,
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
    '<div class="wrap">',
    `<p class="blurb">${esc(tr('server.ssr.moved'))} <a href="${esc(to)}">${esc(to)}</a></p>`,
    '</div>',
    FOOT,
  ].join('\n')
}

/**
 * Надгробие снятой страницы.
 *
 * Обещание записано в store.ts буквами: «снятие страницы адрес не отменяет:
 * ссылка обязана сказать „её сняли“, а не „такой страницы здесь нет“». На живом
 * сервере так и было, а на Pages — том самом носителе «на среду вечером» —
 * каталог просто стирался, и ссылка из чата группы отвечала стандартным 404
 * GitHub. Студент по нему не отличает снятую страницу от опечатки в адресе и
 * идёт спрашивать, «а точно та ссылка?».
 *
 * Ни шагов, ни картинок здесь нет: снятая страница не должна читаться в обход
 * решения преподавателя — она должна о себе сказать.
 */
export function renderWithdrawn(
  title: string,
  course: { name: string; handle: string } | null,
  base: string,
): string {
  return [
    head(title),
    '<div class="wrap">',
    `<h1>${esc(title)}</h1>`,
    `<p class="blurb">${esc(tr('server.ssr.withdrawn'))}</p>`,
    course
      ? `<p class="foot-note">${esc(tr('server.ssr.otherClasses'))} <a href="${esc(base)}/c/${esc(course.handle)}/">${esc(course.name)}</a></p>`
      : '',
    '</div>',
    FOOT,
  ]
    .filter(Boolean)
    .join('\n')
}

export interface SeminarPage {
  title: string
  publishedAt: number
  course: { name: string; handle: string } | null
  steps: { seq: number; label: string; at: number; cellCount: number }[]
  step: RenderedStep
  /** Глубина относительно корня публикации: 1 у первого шага, 2 у остальных. */
  depth: number
  base: string
}

/** Страница одного шага. */
export function renderStep(page: SeminarPage): string {
  const many = page.steps.length > 1
  const up = page.depth === 1 ? '' : '../'
  /*
   * Тетрадь — своя у каждого шага, и лежит она в каталоге шага (export.ts).
   * Ссылка была одна на все шаги и отдавала последний: читатель, сравнивающий
   * «до» и «после» на шаге 2 из 5 — ровно тот, ради кого шаг живёт в адресе, —
   * уносил состояние шага 5 и узнавал об этом, только открыв файл. В комнате
   * это уже исправлено (`?step=`), а статика оставалась на прежнем обещании.
   *
   * `p/<handle>/notebook.ipynb` при этом остаётся тетрадью последнего шага: на
   * неё скопированы ссылки, розданные раньше, и менять то, что по ним
   * скачивается, нельзя. Поэтому и первый шаг, чья страница поднята в корень
   * публикации, ссылается вниз — в свой каталог.
   */
  const notebook = page.depth === 1 ? `${page.step.seq}/notebook.ipynb` : 'notebook.ipynb'
  /*
   * Подпись — слово в слово та же, что в читалке (ReaderScreen.svelte): файл
   * задуман как «код, чтобы запустить у себя», и то, чего в нём нет, сказано
   * рядом со ссылкой, а не выясняется после скачивания.
   */
  const about = !many
    ? tr("server.codeWithoutOutputs.e86524")
    : page.steps.at(-1)?.seq === page.step.seq
      ? tr("server.codeFromTheLastStepWithoutOutputs.84324c")
      : tr("server.codeFromThisStepWithoutOutputs.e310ab")
  const rail = many
    ? [
        `<nav class="rail"><h2>${esc(tr('server.ssr.stepsHeading'))}</h2>`,
        ...page.steps.map((s, i) => {
          const on = s.seq === page.step.seq
          // `./`, а не пустая строка: пустой href — это «текущий URL целиком»,
          // включая querystring, и в архиве такая ссылка ведёт себя странно.
          const href = i === 0 ? `${up || './'}` : `${up}${s.seq}/`
          return `<a class="${on ? 'on' : ''}" href="${esc(href)}">${esc(s.label)}<span class="w">${clock(s.at)} · ${s.cellCount}</span></a>`
        }),
        '</nav>',
      ].join('\n')
    : ''

  return [
    head(page.title),
    '<header class="top"><div class="in">',
    `<h1>${esc(page.title)}</h1>`,
    '<p class="meta">',
    page.course
      ? `<a href="${esc(page.base)}/c/${esc(page.course.handle)}/">${esc(page.course.name)}</a> · `
      : '',
    tr("server.published.e49f01", { p0: esc(when(page.publishedAt)) }),
    many ? ` · ${tr('server.steps', { count: page.steps.length })}` : '',
    '</p></div></header>',
    '<div class="body">',
    rail,
    '<main class="main">',
    '<div class="intro">',
    `<p>${esc(tr('server.ssr.publishedNotebook'))}</p>`,
    many
      ? `<p>${esc(tr('server.ssr.stepOutputs'))}</p>`
      : '',
    `<p>${esc(tr('server.ssr.privacy'))}</p>`,
    '</div>',
    page.step.cells.map((cell) => cellHtml(cell, page.depth)).join('\n'),
    '<div class="take">',
    `<p><a href="${esc(notebook)}" download>${esc(tr('server.ssr.download'))}</a></p>`,
    `<p class="why">${esc(tr('server.ssr.runLocally', { about }))}</p>`,
    '</div>',
    '</main></div>',
    FOOT,
  ]
    .filter(Boolean)
    .join('\n')
}

export { blobHref }

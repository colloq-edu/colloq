/**
 * Публичная страница: что на ней видно и чего на ней не бывает.
 *
 * Второй отрисовщик тетради (`server/src/publish/render.ts`) собирает файл,
 * который студент открывает в среду вечером без всякого сервера. Всё, что он
 * потерял или переврал, теряется навсегда: править эту страницу некому и
 * пожаловаться некуда — она просто читается как недоделанная.
 *
 * Здесь про три вещи, каждая из которых доезжала до класса сломанной: код в
 * заметке, вывод в text/html и русское числительное.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { renderCourse, renderStep, renderWithdrawn } from '../server/src/publish/render.js'
import { notebookFrom } from '../server/src/publish/notebook.js'
import { appendVersion, createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mark } from '../server/src/collab/history.js'
import { createCell, getCells } from '../shared/notebook.js'
import { candidatesFor, candidatesForAsync } from '../server/src/publish/candidates.js'
import { buildPageAt, newBlobBag, pageAt, pageOfDoc } from '../server/src/publish/build.js'
import {
  addressHolder,
  createCourse,
  findCourse,
  formerSlugs,
  releaseFormerSlug,
  setCourseSlug,
  stepHeadings,
  writePublication,
} from '../server/src/publish/store.js'
import type { PublicCell, PublicCourseView } from '../shared/publish.js'

after(() => shutdownCollab())

const cell = (over: Partial<PublicCell> = {}): PublicCell => ({
  id: 'c1',
  type: 'code',
  source: 'df.head()',
  outputs: [],
  execCount: 1,
  ranMs: null,
  ...over,
})

function page(cells: PublicCell[], steps = 1): string {
  return renderStep({
    title: 'Деревья и леса',
    publishedAt: 1,
    course: null,
    steps: Array.from({ length: steps }, (_, i) => ({
      seq: i + 1,
      label: `шаг ${i + 1}`,
      at: 1,
      cellCount: 1,
    })),
    step: { seq: 1, label: 'шаг', at: 1, cells },
    depth: 1,
    base: 'https://colloq.ru',
  })
}

/* ------------------------------------------------------------- заметка */

test('код в ``` остаётся кодом: решётка в нём — комментарий, а не заголовок', () => {
  // Самая частая конструкция учебной тетради: строка «# load data» внутри
  // примера превращалась в крупный заголовок посреди страницы, а пустая строка
  // рвала пример на абзацы.
  const note = ['Разбор:', '', '```python', '# load data', '', 'x = 1', '- y', '```'].join('\n')
  const html = page([cell({ type: 'markdown', source: note })])
  assert.ok(!/<h[1-5]>load data/.test(html), 'комментарий в коде стал заголовком')
  assert.ok(!/<li>y/.test(html), 'вычитание в коде стало пунктом списка')
  assert.match(html, /<pre class="code"># load data\n\nx = 1\n- y<\/pre>/)
})

test('нумерованный список — список, а картинка — ссылка, а не «!»', () => {
  const note = ['1. первый', '2. второй', '', '![схема](https://example.com/a.png)'].join('\n')
  const html = page([cell({ type: 'markdown', source: note })])
  assert.match(html, /<ol><li>первый<\/li><li>второй<\/li><\/ol>/)
  // Внешняя картинка на странице, которую открывают из архива, — битая рамка.
  assert.ok(!/<img[^>]+example\.com/.test(html), 'внешняя картинка вставлена в страницу')
  assert.match(html, /<a href="https:\/\/example\.com\/a\.png" rel="noreferrer">схема<\/a>/)
})

/* --------------------------------------------------------------- вывод */

test('таблица pandas доезжает до страницы, а её стиль и скрипты — нет', () => {
  /*
   * `df.style` отдаёт text/html со своим `<style>`, а в text/plain у него
   * «<pandas.io.formats.style.Styler object at 0x…>». Раньше на странице был
   * либо этот repr, либо пустое место с подписью «Out [1]».
   */
  const html = page([
    cell({
      outputs: [
        {
          kind: 'data',
          data: {
            'text/html':
              '<style>body{display:none}</style><table><tr><th scope="col" class="lvl">a</th>' +
              '<td colspan="2" onclick="steal()">1</td></tr></table>' +
              '<script>fetch("/api/admin")</script><div>хвост',
            'text/plain': '<pandas.io.formats.style.Styler object at 0x10>',
          },
          execCount: 1,
        },
      ],
    }),
  ])
  assert.match(html, /<table><tr><th scope="col">a<\/th><td colspan="2">1<\/td><\/tr><\/table>/)
  assert.ok(
    !/<style/i.test(html.split('<div class="rich">')[1] ?? ''),
    'стиль вывода уехал в страницу',
  )
  assert.ok(!/steal\(\)|fetch\("\/api/.test(html), 'скрипт из вывода уехал в страницу')
  assert.ok(!/Styler object/.test(html), 'вместо таблицы напечатан repr')
  // Незакрытый тег закрывается здесь же — иначе он утащил бы вёрстку страницы.
  assert.match(html, /<div>хвост<\/div>/)
})

test('ссылка из вывода — только http(s)', () => {
  const html = page([
    cell({
      outputs: [
        {
          kind: 'data',
          data: { 'text/html': '<a href="javascript:alert(1)">тык</a>' },
          execCount: 2,
        },
      ],
    }),
  ])
  assert.ok(!/javascript:/.test(html), 'javascript-ссылка доехала до страницы')
  assert.match(html, /<a>тык<\/a>/)
})

test('вывод, который показать нечем, называет себя, а не исчезает', () => {
  // Пустое место под ячейкой с подписью «Out [7]» читается как «код ничего не
  // напечатал» — а вывод был.
  const html = page([
    cell({
      outputs: [{ kind: 'data', data: { 'application/vnd.plotly.v1+json': '{}' }, execCount: 7 }],
    }),
  ])
  assert.match(html, /application\/vnd\.plotly\.v1\+json/)
  assert.match(html, /не показывается/)
})

test('пустой каркас plotly, bokeh и ipywidgets — это не содержимое', () => {
  /*
   * Три из четырёх производителей text/html рисуют не разметкой, а скриптом:
   * в выводе лежит `<script>` и пустой `<div id=…>`, который он наполняет уже
   * в браузере. Скрипт на страницу не уезжает, и остаётся `<div></div>` —
   * строка непустая. Пока ветку выбирали по её длине, пометка о формате не
   * печаталась ни разу, и под ячейкой было ровно то пустое место с подписью
   * «Out [1]», ради которого всё это писалось.
   */
  const empty: Record<string, string> = {
    plotly:
      '<div>                        <script type="text/javascript">window.PlotlyConfig = {MathJaxConfig: \'local\'};</script>' +
      '<script charset="utf-8" src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>' +
      '<div id="e0c5a0f7-1" class="plotly-graph-div" style="height:525px; width:100%;"></div>' +
      '<script type="text/javascript">Plotly.newPlot("e0c5a0f7-1", [{"x":[1,2]}], {})</script></div>',
    bokeh:
      '<div id="p1001" data-root-id="1001" style="display: contents;"></div>\n' +
      '<script type="application/json" id="p1002">{"a":1}</script>\n' +
      '<script type="text/javascript">(function(){ Bokeh.embed(); })();</script>',
    ipywidgets: '<div id="a3f2" style="height:0">&nbsp;</div>',
  }
  for (const [maker, rich] of Object.entries(empty)) {
    const html = page([
      cell({
        outputs: [
          { kind: 'data', data: { 'application/x-thing+json': '{}', 'text/html': rich }, execCount: 1 },
        ],
      }),
    ])
    assert.ok(!/<div class="rich">/.test(html), `${maker}: пустой каркас выдан за вывод`)
    assert.match(html, /не показывается/, `${maker}: вывод исчез без пометки`)
  }
})

test('видимое из text/html показывается, а не подменяется пометкой', () => {
  // Обратная сторона той же проверки: таблица, строчка текста и линейка —
  // содержимое, и заменять их пометкой «не показывается» нельзя.
  const seen: Record<string, string> = {
    таблица: '<table><tr><td>1</td></tr></table>',
    строка: '<div><span>ответ: 42</span></div>',
    линейка: '<div><hr></div>',
  }
  for (const [what, rich] of Object.entries(seen)) {
    const html = page([cell({ outputs: [{ kind: 'data', data: { 'text/html': rich }, execCount: 1 }] })])
    assert.match(html, /<div class="rich">/, `${what}: видимый вывод пропал`)
    assert.ok(!/не показывается/.test(html), `${what}: видимый вывод подменён пометкой`)
  }
})

test('пустой каркас уступает text/plain, а не глотает его', () => {
  // У ipywidgets рядом с каркасом лежит text/plain («IntSlider(value=0)») —
  // это хоть что-то, и оно честнее пометки о формате.
  const html = page([
    cell({
      outputs: [
        {
          kind: 'data',
          data: { 'text/html': '<div id="w1"></div>', 'text/plain': 'IntSlider(value=0)' },
          execCount: 3,
        },
      ],
    }),
  ])
  assert.match(html, /IntSlider\(value=0\)/)
  assert.ok(!/не показывается/.test(html), 'text/plain подменён пометкой о формате')
})

/* --------------------------------------------------------- числительное */

test('числительное считается правилом, а не тернарником', () => {
  // «5 шага» в шапке и «21 шагов» в курсе — то, из-за чего страница читается
  // как недоделанная. Правило одно на всех и лежит в shared/plural.ts.
  assert.match(page([cell()], 5), /· 5 шагов/)
  assert.match(page([cell()], 2), /· 2 шага/)
  assert.match(page([cell()], 21), /· 21 шаг/)

  const course = (steps: number): string => {
    const view: PublicCourseView = {
      id: 'c-1',
      slug: 'ml',
      name: 'Курс',
      blurb: null,
      items: [
        {
          kind: 'seminar',
          sessionId: '',
          name: 'Неделя 1',
          publication: { id: 'p1', slug: 'p1', publishedAt: 1, steps },
        },
      ],
    }
    return renderCourse(view, 'https://colloq.ru')
  }
  assert.match(course(21), /21 шаг</)
  assert.match(course(5), /5 шагов</)
  assert.match(course(1), /одна страница/)
})

/* ------------------------------------------------------------ надгробие */

test('снятая страница говорит, что её сняли, и уводит в курс', () => {
  const html = renderWithdrawn(
    'Неделя 4',
    { name: 'Прикладной ML', handle: 'ml-strong' },
    'https://colloq.ru',
  )
  assert.match(html, /снял эту страницу/)
  assert.match(html, /https:\/\/colloq\.ru\/c\/ml-strong\//)
  assert.ok(!/<script/i.test(html), 'на надгробии появился скрипт')
})

/* --------------------------------------------------------------- .ipynb */

test('в .ipynb у каждой ячейки есть id — схема 4.5 его требует', () => {
  const notebook = JSON.parse(
    notebookFrom([cell({ id: 'c_ok' }), cell({ id: 'плохой id', type: 'markdown' })]),
  ) as { nbformat_minor: number; cells: { id: string }[] }
  assert.equal(notebook.nbformat_minor, 5)
  assert.deepEqual(
    notebook.cells.map((c) => c.id),
    ['c_ok', 'cell-2'],
  )
  for (const c of notebook.cells) assert.match(c.id, /^[a-zA-Z0-9-_]{1,64}$/)
})

/* ------------------------------------------------------ моменты и шаги */

/** Комната, в которой состав тетради менялся между названными моментами. */
function taught(id: string): Y.Doc {
  createSession(id, 'Счёт ячеек', null)
  const { doc } = getSessionDoc(id, 'Счёт ячеек')
  const cells = getCells(doc)
  mark(id, doc, 'checkpoint' as never, null, 'один', 'moment marked')
  doc.transact(() => cells.push([createCell('code', 'x = 1')]), 'server')
  mark(id, doc, 'checkpoint' as never, null, 'два', 'moment marked')
  // Снимок целого документа посреди истории: с него начинается разворот, и
  // ровно на нём счёт «одним документом вперёд» обязан пересобраться заново.
  appendVersion({
    sessionId: id,
    update: Y.encodeStateAsUpdate(doc),
    kind: 'keyframe',
    authorId: null,
    createdAt: Date.now(),
    label: null,
    summary: '',
    added: 0,
    removed: 0,
    cells: [],
  })
  doc.transact(
    () => cells.push([createCell('code', 'y = 2'), createCell('code', 'z = 3')]),
    'server',
  )
  mark(id, doc, 'checkpoint' as never, null, 'три', 'moment marked')
  doc.transact(() => cells.delete(0, 1), 'server')
  mark(id, doc, 'checkpoint' as never, null, 'четыре', 'moment marked')
  return doc
}

test('счёт ячеек одним документом вперёд даёт то же, что разворот с нуля', () => {
  /*
   * Панель публикации разворачивала документ ЗАНОВО на каждую названную строку:
   * снимок целиком плюс дельты, до четырёхсот раз, синхронно, в процессе,
   * который держит сокеты комнаты. Теперь снимок и каждая дельта применяются по
   * разу на весь проход — и это законно ровно до тех пор, пока счёт совпадает с
   * честным разворотом каждой строки по отдельности (`pageAt`).
   */
  const id = 'cand-walk'
  const doc = taught(id)
  const named = candidatesFor(id).filter((c) => c.label)
  assert.deepEqual(
    named.map((c) => c.label),
    ['один', 'два', 'три', 'четыре'],
  )
  const bag = newBlobBag()
  for (const candidate of candidatesFor(id)) {
    const honest = pageAt(id, candidate.seq, bag)
    assert.equal(
      candidate.cellCount,
      honest?.length ?? 0,
      `строка ${candidate.seq}: счёт разошёлся`,
    )
  }
  // Состав менялся между моментами — иначе проверка выше сошлась бы на пустом.
  const counts = named.map((c) => c.cellCount)
  assert.deepEqual(counts, [counts[0], counts[0] + 1, counts[0] + 3, counts[0] + 2])
  doc.destroy()
})

test('второй заход за моментами отвечает то же — и не считает заново', async () => {
  const id = 'cand-memo'
  const doc = taught(id)
  const first = candidatesFor(id)
  const again = await candidatesForAsync(id)
  assert.deepEqual(again, first, 'асинхронный проход разошёлся с синхронным')
  doc.destroy()
})

test('шаг, который не собрался, называет причину, а не молчит', () => {
  /*
   * Раньше и пустая тетрадь, и нечитаемая строка истории давали `null`, маршрут
   * молча пропускал шаг, и преподаватель, отметивший семь моментов, получал
   * страницу с шестью — без слова о том, какой пропал и почему.
   */
  const id = 'build-broken'
  createSession(id, 'Испорченная', null)
  const empty = buildPageAt(id, 1, newBlobBag())
  assert.equal(empty.ok, false)
  assert.equal(empty.ok === false && empty.reason, 'empty')

  const seq = appendVersion({
    sessionId: id,
    update: new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]),
    kind: 'checkpoint',
    authorId: null,
    createdAt: Date.now(),
    label: 'мусор',
    summary: '',
    added: 0,
    removed: 0,
    cells: [],
  })
  const broken = buildPageAt(id, seq, newBlobBag())
  assert.equal(broken.ok, false)
  assert.equal(
    broken.ok === false && broken.reason,
    'broken',
    'поломка неотличима от пустой тетради',
  )
})

/* --------------------------------------------------------------- адреса */

test('два шага с одним номером не роняют публикацию пятисоткой', () => {
  /*
   * `publication_steps` ключуется парой (pub, seq): дубль внутри транзакции
   * давал SQLITE_CONSTRAINT, то есть 500 без единого слова о причине. Побеждает
   * последний — `seq: 0` дописывает маршрут в конец.
   */
  const id = 'pub-dup-seq'
  createSession(id, 'Дубли', null)
  const { doc } = getSessionDoc(id, 'Дубли')
  const bag = newBlobBag()
  const cells = pageOfDoc(doc, bag)
  const pub = writePublication({
    sessionId: id,
    title: 'Дубли',
    by: null,
    steps: [
      { seq: 5, label: 'первый', at: 1, cells },
      { seq: 5, label: 'второй', at: 2, cells },
      { seq: 0, label: 'сейчас', at: 3, cells },
    ],
    blobs: bag.all(),
  })
  assert.deepEqual(
    stepHeadings(pub.id).map((h) => [h.seq, h.label]),
    [
      [5, 'второй'],
      [0, 'сейчас'],
    ],
  )
})

test('прежнее имя называет держателя и отпускается им же', () => {
  /*
   * «Адрес «ml-2025» уже занят» — тупик: курса с таким адресом в списке нет, он
   * переименован. Держателя надо назвать, а прежнее имя — уметь отпустить,
   * иначе курс следующего года не получит его никогда.
   */
  const a = createCourse('Курс года', null, 'Ада')
  const b = createCourse('Курс следующего года', null, 'Ада')
  assert.equal(setCourseSlug(a.id, 'ml-2025'), 'ok')
  assert.equal(setCourseSlug(a.id, 'ml-2025-fall'), 'ok')
  assert.equal(setCourseSlug(b.id, 'ml-2025'), 'taken')

  const holder = addressHolder('course', 'ml-2025')
  assert.deepEqual(holder, { kind: 'course', id: a.id, name: 'Курс года', former: true })
  assert.equal(addressHolder('course', 'ml-2025-fall')?.former, false)

  // Отпускает только владелец и только прежнее имя.
  assert.equal(releaseFormerSlug('course', b.id, 'ml-2025'), false, 'чужой адрес отдался')
  assert.equal(releaseFormerSlug('course', a.id, 'ml-2025'), true)
  assert.deepEqual(formerSlugs('course', a.id), [])
  assert.equal(findCourse('ml-2025'), null)
  assert.equal(setCourseSlug(b.id, 'ml-2025'), 'ok')
})

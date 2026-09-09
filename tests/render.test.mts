/**
 * Статическая страница: пути внутри неё.
 *
 * Второй отрисовщик тетради, рядом со Svelte-компонентами комнаты, — и он
 * работает без сервера, без API и без единого скрипта. Ломается это тихо:
 * страница откроется, а картинка не найдётся, потому что путь поднялся на один
 * каталог выше, чем надо. Тут проверяется ровно это — относительные адреса на
 * обеих глубинах.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderCourse, renderRedirect, renderStep } from '../server/src/publish/render.js'
import { BLOB_PREFIX, type PublicCell, type PublicCourseView } from '../shared/publish.js'

const cellWithImage: PublicCell = {
  id: 'c1',
  type: 'code',
  source: 'plt.plot(xs)',
  outputs: [
    { kind: 'data', data: { 'image/png': `${BLOB_PREFIX}deadbeef` }, execCount: 7 },
  ],
  execCount: 7,
  ranMs: 1400,
}

const steps = [
  { seq: 3, label: 'перед упражнением', at: 1, cellCount: 2 },
  { seq: 5, label: 'решение', at: 2, cellCount: 2 },
]

function page(depth: 1 | 2, seq: number): string {
  return renderStep({
    title: 'Деревья и леса',
    publishedAt: 1,
    course: { name: 'Прикладной ML', handle: 'ml-strong' },
    steps,
    step: { seq, label: 'шаг', at: 1, cells: [cellWithImage] },
    depth,
    base: 'https://colloq.ru',
  })
}

test('картинка находится с первой страницы публикации', () => {
  // Первый шаг — сам корень публикации: подниматься некуда, и лишний «../»
  // увёл бы к соседней публикации.
  assert.match(page(1, 3), /src="blob\/deadbeef\.png"/)
})

test('и с любой другой страницы шага', () => {
  assert.match(page(2, 5), /src="\.\.\/blob\/deadbeef\.png"/)
})

test('первый шаг в рельсе — «./», а не пустая ссылка', () => {
  // Пустой href значит «текущий адрес целиком», вместе с querystring: в архиве
  // и при открытии файла с диска такая ссылка ведёт себя непредсказуемо.
  assert.ok(!page(1, 3).includes('href=""'))
  assert.match(page(1, 3), /href="\.\/"/)
})

test('тетрадь на странице шага — своя, а не одна на публикацию', () => {
  /*
   * Ссылка была одна на все шаги, а файл под ней собирался из ПОСЛЕДНЕГО шага:
   * читатель, сравнивающий «до» и «после» на шаге 2 из 5, уносил состояние шага
   * 5 и узнавал об этом, только открыв файл. Теперь тетрадь лежит рядом со
   * страницей своего шага (export.ts), а `p/<handle>/notebook.ipynb` остаётся
   * последним шагом — на него скопированы розданные раньше ссылки.
   */
  // Первый шаг стоит в корне публикации, где тетрадь уже занята последним
  // шагом, — значит, ссылка спускается в каталог шага.
  assert.match(page(1, 3), /href="3\/notebook\.ipynb"/)
  assert.match(page(2, 5), /href="notebook\.ipynb"/)
  assert.ok(
    !page(2, 5).includes('href="../notebook.ipynb"'),
    'страница шага снова отдаёт тетрадь всей публикации',
  )
  // Подписи разобраны в tests/publish-step-notebook.test.mts — здесь пути.
})

test('страница не тянет ни одного внешнего файла', () => {
  /*
   * Ни скриптов, ни отдельного CSS: страница обязана открываться сама по себе
   * — из архива, с флешки, через десять лет. Отдельный .css — это второй
   * запрос, который однажды не доедет, и текст поедет.
   */
  const html = page(1, 3)
  assert.ok(!/<script/i.test(html), 'на странице появился скрипт')
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'на странице появился внешний стиль')
  assert.match(html, /<style>/)
})

test('страницу не отдают поисковику', () => {
  // Ссылку дают классу, а не индексу: страница открыта тому, кто её получил.
  assert.match(page(1, 3), /name="robots" content="noindex"/)
})

test('в курсе ссылка на семинар идёт по имени, если имя дали', () => {
  const course: PublicCourseView = {
    id: 'abcd1234',
    slug: 'ml-strong',
    name: 'Прикладной ML',
    blurb: null,
    items: [
      {
        kind: 'seminar',
        sessionId: '',
        name: 'Деревья и леса',
        publication: { id: 'zzzz1111', slug: 'derevya', publishedAt: 1, steps: 3 },
      },
      { kind: 'planned', name: 'Кросс-валидация', when: '1–7 мар' },
      { kind: 'gone', name: 'Регуляризация', at: 1 },
    ],
  }
  const html = renderCourse(course, 'https://colloq.ru')
  assert.match(html, /href="https:\/\/colloq\.ru\/p\/derevya\/"/)
  assert.ok(!html.includes('zzzz1111'), 'в ссылку попал идентификатор вместо имени')
  // Три состояния строки: ссылка, план и надгробие — все на странице.
  assert.match(html, /1–7 мар/)
  assert.match(html, /занятие удалено/)
})

test('на публичной странице не появляется идентификатор комнаты', () => {
  // Восемь символов комнаты — это всё право писать в неё.
  const course: PublicCourseView = {
    id: 'abcd1234',
    slug: null,
    name: 'Курс',
    blurb: null,
    items: [
      {
        kind: 'seminar',
        sessionId: 'k7m2xq4b',
        name: 'Семинар',
        publication: { id: 'p1', slug: null, publishedAt: 1, steps: 1 },
      },
    ],
  }
  assert.ok(!renderCourse(course, 'https://colloq.ru').includes('k7m2xq4b'))
})

test('разметка заметки не пропускает чужой HTML', () => {
  // Текст ячейки пишет кто угодно из комнаты, а страница уходит классу.
  const html = renderStep({
    title: 'x',
    publishedAt: 1,
    course: null,
    steps: [{ seq: 0, label: 'один', at: 1, cellCount: 1 }],
    step: {
      seq: 0,
      label: 'один',
      at: 1,
      cells: [
        { id: 'm', type: 'markdown', source: '# Заголовок\n<img src=x onerror=alert(1)>', outputs: [], execCount: null, ranMs: null },
      ],
    },
    depth: 1,
    base: 'https://colloq.ru',
  })
  /*
   * Проверяется тег, а не слово: в безопасном «&lt;img … onerror=…&gt;»
   * подстрока `onerror=` остаётся — и это ровно то, чего мы хотели, потому что
   * браузер видит текст, а не атрибут.
   */
  assert.ok(!/<img/i.test(html), 'сырой тег доехал до страницы')
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /<h2>Заголовок<\/h2>/)
})

test('цвет ядра не доезжает до страницы мусором', () => {
  /*
   * Ядро печатает escape-последовательности как есть, комната красит их на
   * лету, а здесь скриптов нет вовсе: сам escape невидим, и студент читает
   * «[0;31m» посреди трейсбека. Трейсбеки IPython красит всегда.
   */
  const html = renderStep({
    title: 'x',
    publishedAt: 1,
    course: null,
    steps: [{ seq: 0, label: 'один', at: 1, cellCount: 1 }],
    step: {
      seq: 0,
      label: 'один',
      at: 1,
      cells: [
        {
          id: 'c',
          type: 'code',
          source: '1 / 0',
          outputs: [
            { kind: 'stream', name: 'stdout', text: '\x1b[1;32mсобрано\x1b[0m\n' },
            {
              kind: 'error',
              ename: 'ZeroDivisionError',
              evalue: 'division by zero',
              traceback: [
                '\x1b[0;31m---------------------------------\x1b[0m',
                '\x1b[0;31mZeroDivisionError\x1b[0m       Traceback (most recent call last)',
                '\x1b[0;32mCell In[1]\x1b[0m, line 1',
                '\x1b[0;31mZeroDivisionError\x1b[0m: division by zero',
              ],
            },
          ],
          execCount: 1,
          ranMs: null,
        },
      ],
    },
    depth: 1,
    base: 'https://colloq.ru',
  })
  assert.ok(!html.includes('[0;31m'), 'escape-коды доехали до страницы')
  assert.ok(!html.includes('\x1b'), 'сам escape остался в тексте')
  assert.match(html, /собрано/)
  assert.match(html, /Cell In\[1\], line 1/)
  // Заголовок ошибки стоит один раз, а не трижды: рамку, баннер и эхо снимает
  // и комната (web/src/lib/traceback.ts).
  assert.equal(html.split('ZeroDivisionError').length - 1, 1)
})

test('SVG-вывод рисуется, а не превращается в пустую рамку', () => {
  // Ядро отдаёт SVG XML-текстом: `data:…;base64,<xml>` — битая картинка.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>'
  const html = renderStep({
    title: 'x',
    publishedAt: 1,
    course: null,
    steps: [{ seq: 0, label: 'один', at: 1, cellCount: 1 }],
    step: {
      seq: 0,
      label: 'один',
      at: 1,
      cells: [
        {
          id: 'g',
          type: 'code',
          source: 'graph',
          outputs: [{ kind: 'data', data: { 'image/svg+xml': svg }, execCount: 1 }],
          execCount: 1,
          ranMs: null,
        },
      ],
    },
    depth: 1,
    base: 'https://colloq.ru',
  })
  assert.match(html, /src="data:image\/svg\+xml;charset=utf-8,/)
  assert.ok(!html.includes(';base64,'), 'XML отдали как base64')
  // Картинкой, а не разметкой: скрипт из чужого вывода в `<img>` не исполнится.
  assert.ok(!/<svg/i.test(html), 'разметка вывода попала в страницу')
})

test('надгробие с оставшимся чтением — ссылка, а не тупик', () => {
  /*
   * «Удалить семинар, чтение оставить» — умолчание. Страница жива, а курс —
   * единственный адрес, который дают классу.
   */
  const course: PublicCourseView = {
    id: 'abcd1234',
    slug: null,
    name: 'Курс',
    blurb: null,
    items: [
      { kind: 'gone', name: 'Четвёртая неделя', at: 1, publication: { id: 'p7', slug: 'nedelya' } },
      { kind: 'gone', name: 'Пятая неделя', at: 2 },
    ],
  }
  const html = renderCourse(course, 'https://colloq.ru')
  assert.match(html, /href="https:\/\/colloq\.ru\/p\/nedelya\/"/)
  assert.match(html, /занятие удалено, материалы доступны/)
  // А там, где страницы не осталось, строка остаётся строкой.
  assert.match(html, /занятие удалено/)
})

test('время на странице — в поясе инстанса, а не в поясе процесса', () => {
  /*
   * Выгрузку запускают на сервере, где пояс обычно UTC, а занятие шло в
   * аудитории: без явного пояса страница подписывала пару на три часа назад, и
   * проверить подпись на статике нечем — браузера, который считает время сам,
   * здесь нет.
   */
  const noon = Date.UTC(2026, 8, 2, 12, 0)
  const at = (zone: string): string => {
    process.env.TZ = zone
    return renderStep({
      title: 'Деревья и леса',
      publishedAt: noon,
      course: null,
      steps: [
        { seq: 3, label: 'перед упражнением', at: noon, cellCount: 1 },
        { seq: 5, label: 'решение', at: noon, cellCount: 1 },
      ],
      step: { seq: 3, label: 'шаг', at: noon, cells: [cellWithImage] },
      depth: 1,
      base: 'https://colloq.ru',
    })
  }
  const was = process.env.TZ
  try {
    assert.match(at('UTC'), /12:00/)
    assert.match(at('Europe/Moscow'), /15:00/)
    // Опечатка в TZ не роняет выгрузку целиком — страница собирается по Москве.
    assert.match(at('МСК'), /15:00/)
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
})

test('старый адрес перекладывает на нынешний', () => {
  // На живом сервере это `WHERE id = ? OR slug = ?`; на Pages маршрутизации нет.
  const html = renderRedirect('https://colloq.ru/c/ml-strong/', 'Прикладной ML')
  assert.match(html, /http-equiv="refresh" content="0; url=https:\/\/colloq\.ru\/c\/ml-strong\/"/)
  assert.match(html, /href="https:\/\/colloq\.ru\/c\/ml-strong\/"/)
  assert.ok(!/<script/i.test(html), 'на странице появился скрипт')
})

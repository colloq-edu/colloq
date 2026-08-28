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
import { renderCourse, renderStep } from '../server/src/publish/render.js'
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

test('тетрадь скачивается с обеих глубин', () => {
  assert.match(page(1, 3), /href="notebook\.ipynb"/)
  assert.match(page(2, 5), /href="\.\.\/notebook\.ipynb"/)
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
  assert.match(html, /семинар удалён/)
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

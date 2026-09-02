/**
 * Публикация: что уходит наружу и что не уходит.
 *
 * Два обещания, и оба держатся перечислением, а не вычитанием. У документа
 * четыре корня, и тетрадь только один из них: в `chat` имена всех, кто
 * спрашивал оракула, в `terminal` — всё, что кто-нибудь напечатал в оболочку.
 * Внутри ячейки то же: `runBy` и `runById` стоят на каждой запущенной. Поэтому
 * здесь проверяется не «нет ли имён в этом примере», а точный набор ключей:
 * поле, добавленное в тетрадь завтра, не должно оказаться на публичной
 * странице само собой.
 *
 * И второе: шагом может стать только версия, которая разворачивается хотя бы в
 * одну ячейку. Пустая страница у студента невозможна не потому, что о ней
 * позаботились, а потому, что такой шаг не собирается.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { appendVersion, createSession } from '../server/src/db.js'
import { getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'
import { mark } from '../server/src/collab/history.js'
import { addBook, createCell, getCells, removeBook } from '../shared/notebook.js'
import { candidatesFor } from '../server/src/publish/candidates.js'
import { newBlobBag, pageAt, pageOfDoc } from '../server/src/publish/build.js'
import { exportSite } from '../server/src/publish/export.js'
import { notebookOf } from '../server/src/publish/notebook.js'
import { courseRoutes } from '../server/src/routes/courses.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { STAFF_COOKIE } from '../shared/admin.js'
import type { Response } from 'express'
import {
  createCourse,
  deleteCourse,
  deletePublication,
  entombSeminar,
  findCourse,
  findPublication,
  formerSlugs,
  getCourse,
  getPublication,
  orphanPublication,
  publicationOf,
  readStep,
  setCourseItems,
  setCourseSlug,
  setPublicationSlug,
  setPublicationState,
  stepHeadings,
  writePublication,
} from '../server/src/publish/store.js'
import { BLOB_PREFIX } from '../shared/publish.js'

after(() => shutdownCollab())

/** Комната с двумя названными моментами и одним выводом от ядра. */
function taught(id: string): Y.Doc {
  createSession(id, 'Деревья и леса', null)
  const { doc } = getSessionDoc(id, 'Деревья и леса')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  doc.transact(() => (cells.get(0).get('source') as Y.Text).insert(0, 'import pandas as pd'))
  mark(id, doc, 'checkpoint' as never, null, 'перед упражнением', 'moment marked')
  doc.transact(() => {
    const cell = cells.get(1)
    ;(cell.get('source') as Y.Text).insert(0, 'df.head()')
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'text/plain': 'таблица' }, execCount: 3 }))
    ;(cell.get('outputs') as Y.Array<unknown>).push([out])
    cell.set('execCount', 3)
    cell.set('ranMs', 1400)
    // То, чего наружу быть не должно ни при каких обстоятельствах.
    cell.set('runBy', 'Нина')
    cell.set('runById', 'p_nina')
    cell.set('state', 'ok')
  }, 'server')
  mark(id, doc, 'checkpoint' as never, null, 'решение', 'moment marked')
  return doc
}

test('на публичной странице ровно шесть полей ячейки, и среди них нет имён', () => {
  const doc = taught('pub-fields')
  const page = pageOfDoc(doc, newBlobBag())
  const withOutput = page.find((c) => c.outputs.length > 0)
  assert.ok(withOutput, 'ячейка с выводом не нашлась')
  assert.deepEqual(
    Object.keys(withOutput).sort(),
    ['execCount', 'id', 'outputs', 'ranMs', 'source', 'type'],
    'состав полей публичной ячейки изменился — проверьте, что новое поле правда можно показывать',
  )
  // И на всякий случай сама подстрока: набор ключей мог бы совпасть, а имя
  // приехать внутри вывода.
  assert.ok(!JSON.stringify(page).includes('Нина'))
  assert.ok(!JSON.stringify(page).includes('p_nina'))
})

test('кандидатами становятся только названные моменты, и только с тетрадью', () => {
  const id = 'pub-cands'
  taught(id)
  const candidates = candidatesFor(id)
  assert.ok(candidates.length >= 3, 'моменты не нашлись')
  assert.ok(
    candidates.every((c) => c.cellCount > 0),
    'в кандидатах есть версия, разворачивающаяся в пустую тетрадь',
  )
  // Всплески правок моментами не бывают: их десятки за пару и их никто не называл.
  assert.ok(!candidates.some((c) => c.kind === 'edit' || c.kind === 'quiet'))
  const named = candidates.filter((c) => c.label)
  assert.deepEqual(named.map((c) => c.label), ['перед упражнением', 'решение'])
  // Служебному снимку имя не выдумывается: «Снимок №14» в рельсе у студента —
  // не название момента, а признание, что назвать его забыли.
  assert.ok(candidates.some((c) => c.kind === 'opened' && c.label === ''))
})

test('шаг несёт тетрадь на свой момент, а не сегодняшнюю', () => {
  const id = 'pub-moments'
  const doc = taught(id)
  const [before, solution] = candidatesFor(id).filter((c) => c.label)
  const bag = newBlobBag()
  const early = pageAt(id, before.seq, bag)
  const later = pageAt(id, solution.seq, bag)
  assert.ok(early && later)
  assert.equal(early.find((c) => c.outputs.length > 0), undefined, 'ранний шаг уже несёт вывод')
  assert.ok(later.some((c) => c.outputs.length > 0), 'поздний шаг вывод потерял')
  doc.destroy()
})

test('крупная картинка лежит один раз, а в странице стоит ссылка', () => {
  // График matplotlib одинаков во всех шагах, где его ячейка не менялась:
  // шесть шагов давали бы шесть копий одной картинки.
  const id = 'pub-blobs'
  createSession(id, 'С графиком', null)
  const { doc } = getSessionDoc(id, 'С графиком')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  const png = 'A'.repeat(40_000)
  doc.transact(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'image/png': png }, execCount: 1 }))
    ;(cells.get(0).get('outputs') as Y.Array<unknown>).push([out])
  }, 'server')

  const bag = newBlobBag()
  const first = pageOfDoc(doc, bag)
  const again = pageOfDoc(doc, bag)
  const ref = (page: typeof first) =>
    page.flatMap((c) => c.outputs).find((o) => o.kind === 'data')?.data['image/png']
  assert.ok(ref(first)?.startsWith(BLOB_PREFIX), 'картинка осталась в странице целиком')
  assert.equal(ref(first), ref(again), 'та же картинка получила два адреса')
  assert.equal(bag.all().length, 1, 'одна картинка легла дважды')
})

test('удалённый семинар оставляет в курсе надгробие, а не дыру', () => {
  /*
   * Курс, из которого молча пропала четвёртая неделя, сломан для того, кто на
   * ней сидел, а нумерация остальных уезжает и перестаёт совпадать с
   * расписанием.
   */
  const id = 'pub-gone'
  createSession(id, 'Регуляризация', null)
  const course = createCourse('Прикладной ML', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Регуляризация', publication: null },
  ])
  entombSeminar(id, 'Регуляризация')
  const after = getCourse(course.id)!
  assert.equal(after.items.length, 1, 'строка исчезла вместе с семинаром')
  assert.equal(after.items[0].kind, 'gone')
  assert.equal(after.items[0].kind === 'gone' && after.items[0].name, 'Регуляризация')
})

test('повторная публикация сохраняет адрес и заменяет шаги', () => {
  // Ссылку у студентов не отозвать: адрес обязан пережить любую перепубликацию.
  const id = 'pub-again'
  const doc = taught(id)
  const bag = newBlobBag()
  const one = writePublication({
    sessionId: id,
    title: 'Деревья и леса',
    by: 'Ада',
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  const two = writePublication({
    sessionId: id,
    title: 'Деревья и леса',
    by: 'Ада',
    steps: [
      { seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) },
      { seq: 99, label: 'и ещё один', at: Date.now(), cells: pageOfDoc(doc, bag) },
    ],
    blobs: bag.all(),
  })
  assert.equal(one.id, two.id, 'повторная публикация выдала новый адрес')
  assert.equal(two.revision, 2)
  assert.equal(stepHeadings(two.id).length, 2)
  assert.equal(publicationOf(id)?.id, one.id)
  assert.ok(readStep(two.id, null), 'первый шаг не читается')
})

test('двое, переставляющие курс в одну минуту, не теряют порядок молча', () => {
  /*
   * Права преподавателей на инстансе общие, экран семинаров перечитывается сам,
   * а состав курса пишется целиком одним значением. Без сравнения версии второй
   * записавший стирал бы работу первого и никто бы этого не заметил.
   */
  const course = createCourse('Курс', null, 'Ада')
  const one = { kind: 'gone' as const, name: 'Первый', at: 1 }
  const two = { kind: 'gone' as const, name: 'Второй', at: 2 }

  const first = setCourseItems(course.id, course.rev, [one, two])
  assert.ok(first, 'первая запись не прошла')
  // Второй экран держит курс таким, каким прочитал его до этого.
  assert.equal(setCourseItems(course.id, course.rev, [two, one]), null, 'устаревшая запись прошла')
  assert.deepEqual(getCourse(course.id)!.items.map((i) => i.kind === 'gone' && i.name), [
    'Первый',
    'Второй',
  ])
})

test('снятая страница остаётся адресом, а не превращается в 404', () => {
  // Ссылку у студентов не отозвать: страница обязана ответить, что её сняли.
  const id = 'pub-withdrawn'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Снятая',
    by: null,
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  setPublicationState(pub.id, 'withdrawn')
  const back = publicationOf(id)
  assert.equal(back?.state, 'withdrawn')
  assert.equal(back?.id, pub.id, 'снятие поменяло адрес')
  // Шаги остаются на месте: вернуть страницу — это одно нажатие, а не публикация заново.
  assert.equal(stepHeadings(pub.id).length, 1)
})

test('SVG остаётся в странице текстом, а в отдельную запись уезжает только растр', () => {
  /*
   * Ядро кладёт мимебандл как есть: `image/png` — base64, `image/svg+xml` —
   * XML. Вынос в запись предполагает base64 (`Buffer.from(value, 'base64')`),
   * так что SVG в ней превращался в мусорные байты, а на странице — в пустую
   * рамку. Восстановить его оттуда было уже нечем.
   */
  const id = 'pub-svg'
  createSession(id, 'Граф', null)
  const { doc } = getSessionDoc(id, 'Граф')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect/>'.repeat(1000)}</svg>`
  doc.transact(() => {
    const out = new Y.Map<unknown>()
    out.set('kind', 'data')
    out.set('json', JSON.stringify({ data: { 'image/svg+xml': svg }, execCount: 1 }))
    ;(cells.get(0).get('outputs') as Y.Array<unknown>).push([out])
  }, 'server')

  const bag = newBlobBag()
  const page = pageOfDoc(doc, bag)
  const value = page.flatMap((c) => c.outputs).find((o) => o.kind === 'data')?.data['image/svg+xml']
  assert.equal(value, svg, 'SVG уехал в запись и потерял себя')
  assert.equal(bag.all().length, 0, 'в записи лежит не base64')
})

test('чекпоинт с начала пары остаётся кандидатом, сколько бы ни печатали после', () => {
  /*
   * Всплеск закрывается каждые четыре килобайта, на любую смену состава тетради
   * и по двенадцати секундам тишины: комната на тридцать человек выдаёт их
   * сотнями за пару. Окно на четыреста свежайших строк ЛЮБОГО вида выбрасывало
   * из списка ровно тот момент, ради которого его открыли.
   */
  const id = 'pub-window'
  taught(id)
  const noop = Y.encodeStateAsUpdate(new Y.Doc())
  for (let i = 0; i < 500; i++) {
    appendVersion({
      sessionId: id,
      update: noop,
      kind: 'edit',
      authorId: null,
      createdAt: Date.now(),
      label: null,
      summary: 'печатали',
      added: 1,
      removed: 0,
      cells: [],
    })
  }
  const labels = candidatesFor(id).map((c) => c.label)
  assert.ok(labels.includes('перед упражнением'), 'чекпоинт вытеснили всплески правок')
  assert.ok(labels.includes('решение'))
})

test('чекпоинты живут и после того, как первую тетрадь комнаты удалили', () => {
  /*
   * Хост может удалить любой файл, включая «Тетрадь.ipynb»: её корень при этом
   * стирается, а занятие идёт во второй тетради. Счёт ячеек по корню `cells`
   * давал ноль, и все последующие чекпоинты молча переставали быть кандидатами
   * — при том что страница шага собралась бы.
   */
  const id = 'pub-books'
  createSession(id, 'Две тетради', null)
  const { doc } = getSessionDoc(id, 'Две тетради')
  const lecture = addBook(doc, 'Лекция.ipynb')
  doc.transact(() => {
    doc.getArray(lecture.root).push([createCell('code', 'plt.plot(xs)')])
    removeBook(doc, 'Тетрадь.ipynb')
  }, 'server')
  assert.equal(getCells(doc).length, 1, 'вторая тетрадь не стала первой')
  mark(id, doc, 'checkpoint' as never, null, 'перед упражнением', 'moment marked')

  const checkpoint = candidatesFor(id).find((c) => c.label === 'перед упражнением')
  assert.ok(checkpoint, 'чекпоинт второй тетради выпал из кандидатов')
  assert.equal(checkpoint.cellCount, 1)
})

test('надгробие несёт ссылку на оставшееся чтение', () => {
  /*
   * «Удалить семинар, чтение оставить» — умолчание, и без этой ссылки строка
   * курса становится тупиком: страница жива и открывается по прямому адресу, а
   * курс — единственный адрес, который классу вообще дают.
   */
  const id = 'pub-tomb'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Деревья и леса',
    by: 'Ада',
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  const course = createCourse('Курс с надгробием', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Деревья и леса', publication: null },
  ])
  // Ровно тот порядок, в котором это делает удаление семинара.
  orphanPublication(id)
  entombSeminar(id, 'Деревья и леса')

  const row = getCourse(course.id)!.items[0]
  assert.equal(row.kind, 'gone')
  assert.equal(row.kind === 'gone' && row.publication?.id, pub.id)
  // Страница при этом жива: снять её теперь есть чем — по её собственному адресу.
  assert.equal(getPublication(pub.id)?.sessionId, null)
})

/* --------------------------------------------------------------- выгрузка */

test('выгрузка кладёт страницу под обоими адресами и убирает снятую', () => {
  /*
   * Путь, которым страницы доходят до студента, целиком: каталоги, картинки,
   * тетрадь файлом — и адрес по идентификатору, розданный до того, как курсу
   * дали имя. На живом сервере его держит `WHERE id = ? OR slug = ?`, на Pages
   * маршрутизации нет вовсе.
   */
  const id = 'pub-export'
  createSession(id, 'Выгрузка', null)
  const { doc } = getSessionDoc(id, 'Выгрузка')
  const cells = doc.getArray<Y.Map<unknown>>('cells')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect/>'.repeat(1000)}</svg>`
  doc.transact(() => {
    const png = new Y.Map<unknown>()
    png.set('kind', 'data')
    png.set('json', JSON.stringify({ data: { 'image/png': 'A'.repeat(40_000) }, execCount: 1 }))
    ;(cells.get(0).get('outputs') as Y.Array<unknown>).push([png])
    const graph = new Y.Map<unknown>()
    graph.set('kind', 'data')
    graph.set('json', JSON.stringify({ data: { 'image/svg+xml': svg }, execCount: 2 }))
    ;(cells.get(1).get('outputs') as Y.Array<unknown>).push([graph])
  }, 'server')

  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Выгрузка',
    by: 'Ада',
    steps: [
      { seq: 7, label: 'перед упражнением', at: Date.now(), cells: pageOfDoc(doc, bag) },
      { seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) },
    ],
    blobs: bag.all(),
  })
  // Число ячеек шага считает SQLite: разбирать ради него страницу целиком —
  // это сотни килобайт JSON на каждый публичный запрос курса.
  assert.deepEqual(
    stepHeadings(pub.id).map((h) => h.cellCount),
    [2, 2],
  )
  assert.equal(setPublicationSlug(pub.id, 'vygruzka'), 'ok')
  const course = createCourse('Курс выгрузки', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Выгрузка', publication: null },
  ])
  assert.equal(setCourseSlug(course.id, 'kurs-vygruzki'), 'ok')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-site-'))
  exportSite(root, 'https://colloq.ru')
  const at = (...parts: string[]): string => path.join(root, ...parts)
  const read = (...parts: string[]): string => fs.readFileSync(at(...parts), 'utf8')

  assert.ok(fs.existsSync(at('c', 'kurs-vygruzki', 'index.html')))
  assert.match(read('c', course.id, 'index.html'), /https:\/\/colloq\.ru\/c\/kurs-vygruzki\//)
  assert.ok(fs.existsSync(at('p', 'vygruzka', 'index.html')))
  // Первый шаг — сам корень публикации, остальные лежат на шаг глубже.
  assert.ok(fs.existsSync(at('p', 'vygruzka', '0', 'index.html')))
  assert.match(read('p', pub.id, 'index.html'), /https:\/\/colloq\.ru\/p\/vygruzka\//)
  assert.match(read('p', pub.id, '0', 'index.html'), /https:\/\/colloq\.ru\/p\/vygruzka\/0\//)

  // Картинка — файлом рядом, а SVG остаётся в самой странице.
  const blobs = fs.readdirSync(at('p', 'vygruzka', 'blob'))
  assert.equal(blobs.length, 1)
  assert.ok(blobs[0].endsWith('.png'), `картинка легла как ${blobs[0]}`)
  assert.match(read('p', 'vygruzka', 'index.html'), /src="data:image\/svg\+xml;charset=utf-8,/)

  // Тетрадь файлом — единственный способ унести код с собой.
  const notebook = JSON.parse(read('p', 'vygruzka', 'notebook.ipynb')) as {
    cells: { outputs?: unknown[] }[]
  }
  assert.ok(notebook.cells.length > 0)
  assert.ok(notebook.cells.every((c) => (c.outputs ?? []).length === 0), 'в файл уехали выводы')
  assert.equal(notebookOf(pub.id).length > 0, true)

  // Снятую страницу выгрузка обязана убрать — иначе она открывается по ссылке.
  setPublicationState(pub.id, 'withdrawn')
  exportSite(root, 'https://colloq.ru')
  assert.equal(fs.existsSync(at('p', 'vygruzka')), false, 'снятая страница осталась на сайте')
  assert.equal(fs.existsSync(at('p', pub.id)), false, 'остался старый адрес снятой страницы')
  fs.rmSync(root, { recursive: true, force: true })
})

test('прежнее имя в адресе ведёт туда же, куда вело', () => {
  /*
   * Имя курсу дают вслух и пишут на доске, а потом меняют — и ссылка, которую
   * класс уже сохранил, обязана работать. На живом сервере это запрос, на
   * Pages маршрутизации нет вовсе: там прежний адрес остаётся файлом-указателем.
   */
  const id = 'pub-renamed'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Переименование',
    by: 'Ада',
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  assert.equal(setPublicationSlug(pub.id, 'nedelya-tri'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'nedelya-04'), 'ok')

  const course = createCourse('Курс с именем', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Переименование', publication: null },
  ])
  assert.equal(setCourseSlug(course.id, 'ml-osen'), 'ok')
  assert.equal(setCourseSlug(course.id, 'ml-strong'), 'ok')

  assert.deepEqual(formerSlugs('course', course.id), ['ml-osen'])
  assert.equal(findCourse('ml-osen')?.id, course.id)
  assert.equal(findCourse(course.id)?.id, course.id)
  assert.equal(findPublication('nedelya-tri')?.id, pub.id)
  // Прежний адрес не отдаётся соседу: ссылка увела бы класс в чужой курс.
  const other = createCourse('Соседний курс', null, 'Ада')
  assert.equal(setCourseSlug(other.id, 'ml-osen'), 'taken')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-site-'))
  exportSite(root, 'https://colloq.ru')
  const at = (...parts: string[]): string => path.join(root, ...parts)
  const read = (...parts: string[]): string => fs.readFileSync(at(...parts), 'utf8')
  assert.ok(fs.existsSync(at('c', 'ml-strong', 'index.html')))
  assert.match(read('c', 'ml-osen', 'index.html'), /https:\/\/colloq\.ru\/c\/ml-strong\//)
  assert.match(read('c', course.id, 'index.html'), /https:\/\/colloq\.ru\/c\/ml-strong\//)
  assert.match(read('p', 'nedelya-tri', 'index.html'), /https:\/\/colloq\.ru\/p\/nedelya-04\//)
  assert.match(read('p', pub.id, 'index.html'), /https:\/\/colloq\.ru\/p\/nedelya-04\//)

  // Своё прежнее имя можно вернуть — тогда указателя по нему больше нет.
  assert.equal(setCourseSlug(course.id, 'ml-osen'), 'ok')
  assert.deepEqual(formerSlugs('course', course.id), ['ml-strong'])
  doc.destroy()
  fs.rmSync(root, { recursive: true, force: true })
})

/* --------------------------------------------------------------- маршруты */

test('блоб отдаётся картинкой только с известным типом', async () => {
  /*
   * Mime вывода приходит из документа комнаты, то есть от кого угодно, а
   * `content-type` решает, чем ответ будет при переходе по прямой ссылке.
   * `image/svg+xml` — это документ, и скрипт внутри него исполнился бы на
   * origin инстанса, с печеньем того, кто ссылку открыл.
   */
  const id = 'pub-blob-mime'
  createSession(id, 'Блобы', null)
  const pub = writePublication({
    sessionId: id,
    title: 'Блобы',
    by: null,
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: [] }],
    blobs: [
      { hash: 'a'.repeat(32), mime: 'image/png', body: Buffer.from([137, 80, 78, 71]) },
      { hash: 'b'.repeat(32), mime: 'image/svg+xml', body: Buffer.from('<svg><script/></svg>') },
    ],
  })

  const app = express()
  app.use(courseRoutes())
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const at = (hash: string): string => `http://127.0.0.1:${port}/api/p/${pub.id}/blob/${hash}`

  const png = await fetch(at('a'.repeat(32)))
  assert.equal(png.headers.get('content-type'), 'image/png')
  assert.equal(png.headers.get('content-disposition'), 'inline')

  const svg = await fetch(at('b'.repeat(32)))
  assert.equal(svg.headers.get('content-type'), 'application/octet-stream')
  assert.match(svg.headers.get('content-disposition') ?? '', /^attachment/)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('страницу без комнаты можно снять по её собственному адресу', async () => {
  /*
   * Удаление семинара оставляет чтение и обнуляет `session_id` — и маршруты,
   * ключуемые идентификатором комнаты, отвечают 404 навсегда. Страница при этом
   * жива и выкладывается каждым `make site`: снять её было нечем, а на ней мог
   * остаться чужой персональный вывод.
   */
  const id = 'pub-orphan-route'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Осиротевшая',
    by: null,
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  orphanPublication(id)

  const teacher = createTeacher({
    name: 'Ада',
    email: 'ada@publish.test',
    role: 'owner',
  })
  assert.ok(teacher)
  let cookie = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (cookie = v) } as unknown as Response, teacher)

  const app = express()
  app.use(express.json())
  app.use(courseRoutes())
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const head = { cookie: `${STAFF_COOKIE}=${cookie}` }

  const listed = (await (
    await fetch(`http://127.0.0.1:${port}/api/admin/publications`, { headers: head })
  ).json()) as { publications: { id: string; orphaned: boolean }[] }
  assert.ok(
    listed.publications.some((p) => p.id === pub.id && p.orphaned),
    'осиротевшая страница не показывается нигде',
  )

  const withdraw = await fetch(`http://127.0.0.1:${port}/api/admin/publications/${pub.id}`, {
    method: 'DELETE',
    headers: head,
  })
  assert.equal(withdraw.status, 200)
  assert.equal(getPublication(pub.id)?.state, 'withdrawn')

  const back = await fetch(
    `http://127.0.0.1:${port}/api/admin/publications/${pub.id}/restore`,
    { method: 'POST', headers: head },
  )
  assert.equal(back.status, 200)
  assert.equal(getPublication(pub.id)?.state, 'published')

  const forever = await fetch(
    `http://127.0.0.1:${port}/api/admin/publications/${pub.id}/forever`,
    { method: 'DELETE', headers: head },
  )
  assert.equal(forever.status, 200)
  assert.equal(getPublication(pub.id), null)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('прежний адрес живёт на сервере и забывается вместе со страницей', async () => {
  /*
   * Ссылку, розданную под прежним именем, отозвать нельзя: она в чате группы и
   * на доске. На Pages по ней лежит файл-указатель, здесь — тот же ответ, что
   * и по нынешнему адресу, с каноническим адресом внутри: читалка строит
   * ссылки дальше по нему. Снятие страницы адрес не отменяет — ссылка обязана
   * сказать «её сняли», — а полное удаление отменяет: указывать некуда.
   */
  const id = 'pub-former-route'
  const doc = taught(id)
  const bag = newBlobBag()
  const pub = writePublication({
    sessionId: id,
    title: 'Прежний адрес',
    by: null,
    steps: [{ seq: 0, label: 'сейчас', at: Date.now(), cells: pageOfDoc(doc, bag) }],
    blobs: bag.all(),
  })
  assert.equal(setPublicationSlug(pub.id, 'lekciya-01'), 'ok')
  assert.equal(setPublicationSlug(pub.id, 'lekciya-01-final'), 'ok')

  const course = createCourse('Статистика', null, 'Ада')
  setCourseItems(course.id, course.rev, [
    { kind: 'seminar', sessionId: id, name: 'Прежний адрес', publication: null },
  ])
  assert.equal(setCourseSlug(course.id, 'stat-vesna'), 'ok')
  assert.equal(setCourseSlug(course.id, 'stat-osen'), 'ok')

  const app = express()
  app.use(courseRoutes())
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`)

  const asked = await get('/api/c/stat-vesna')
  assert.equal(asked.status, 200, 'курс по прежнему имени не открылся')
  const seen = (await asked.json()) as { course: { id: string; slug: string } }
  assert.equal(seen.course.id, course.id)
  assert.equal(seen.course.slug, 'stat-osen', 'в ответе не канонический адрес')

  const page = await get('/api/p/lekciya-01')
  assert.equal(page.status, 200, 'страница по прежнему имени не открылась')
  const seminar = (await page.json()) as { seminar: { id: string; slug: string; state: string } }
  assert.equal(seminar.seminar.id, pub.id)
  assert.equal(seminar.seminar.slug, 'lekciya-01-final')
  // И вглубь: шаг и тетрадь файлом — тем же прежним адресом.
  assert.equal((await get('/api/p/lekciya-01/step/first')).status, 200)
  assert.equal((await get('/api/p/lekciya-01/notebook.ipynb')).status, 200)

  setPublicationState(pub.id, 'withdrawn')
  const withdrawn = await get('/api/p/lekciya-01')
  assert.equal(withdrawn.status, 200, 'снятая страница по прежнему адресу отвечает «нет такой»')
  const state = (await withdrawn.json()) as { seminar: { state: string } }
  assert.equal(state.seminar.state, 'withdrawn')

  deletePublication(pub.id)
  assert.equal((await get('/api/p/lekciya-01')).status, 404, 'адрес стёртой страницы не забыт')
  deleteCourse(course.id)
  assert.equal((await get('/api/c/stat-vesna')).status, 404, 'адрес удалённого курса не забыт')
  doc.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

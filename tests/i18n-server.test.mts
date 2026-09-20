import './_env.mts'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { setLocaleResolver, tr } from '../shared/i18n.js'
import { KERNEL_WORD, SHELL_WORD } from '../shared/machine.js'
import { SKIP_REASON_TEXT } from '../shared/publish.js'
import { CLASS_IS_OVER } from '../shared/rules.js'
import { bookList, cellSource, getCells, getMeta, createCell, ensureInitialNotebook, COUNCIL_SHARED_KERNEL_NOTE } from '../shared/notebook.js'
import { whySegmentRefused } from '../shared/paths.js'
import { seconds, people, groupsWord, cellsWord } from '../server/src/ai/text.js'
import { renderCourse, renderStep, renderRedirect, renderWithdrawn } from '../server/src/publish/render.js'
import { oraclePrompt } from '../server/src/ai/council.js'

let locale: 'ru' | 'en' = 'ru'
const use = (value: 'ru' | 'en') => { locale = value; setLocaleResolver(() => locale) }
afterEach(() => use('ru'))

test('shared labels and refusal constants resolve after an in-process language change', () => {
  use('ru')
  assert.equal(KERNEL_WORD.busy, 'считает')
  assert.match(tr(CLASS_IS_OVER), /Занятие закончено/)
  use('en')
  assert.equal(KERNEL_WORD.busy, 'running')
  assert.equal(SHELL_WORD.closed, 'not started')
  assert.equal(SKIP_REASON_TEXT.broken, 'this version cannot be read')
  assert.match(tr(CLASS_IS_OVER), /class is over/)
  // Ядро у КАЖДОЙ тетради своё, и попытки делят ядро своей — не «общее ядро».
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /this notebook's kernel/)
  assert.match(whySegmentRefused(' данные '), /данные/)
  assert.match(whySegmentRefused(' данные '), /space/)
  use('ru')
  assert.equal(SHELL_WORD.closed, 'не запущена')
})

test('server counters follow the selected locale including Russian 21 and English 21', () => {
  use('ru')
  assert.equal(seconds(21), '21 секунду')
  assert.equal(seconds(22), '22 секунды')
  assert.equal(people(5), '5 человек')
  use('en')
  assert.equal(seconds(1), '1 second')
  assert.equal(seconds(21), '21 seconds')
  assert.equal(people(1), '1 person')
  assert.equal(people(21), '21 people')
  assert.equal(groupsWord(21), 'groups')
  assert.equal(cellsWord(1), 'cell')
  assert.equal(tr('server.askAgain', { spent: 'Limit reached', count: 21 }), 'Limit reached. You can ask again in 21 minutes.')
})

test('new notebooks use the instance language without renaming existing notebooks or changing code', () => {
  use('en')
  const doc = new Y.Doc()
  ensureInitialNotebook(doc, 'Пользовательское имя')
  assert.equal(bookList(doc)[0].path, 'Notebook.ipynb')
  assert.match(cellSource(getCells(doc).get(0)).toString(), /# Welcome/)
  const initialCode = cellSource(getCells(doc).get(1)).toString()
  use('ru')
  ensureInitialNotebook(doc, 'Other title')
  assert.equal(bookList(doc)[0].path, 'Notebook.ipynb')
  assert.equal(getMeta(doc).get('title'), 'Пользовательское имя')
  assert.equal(cellSource(getCells(doc).get(1)).toString(), initialCode)
  const fresh = new Y.Doc()
  ensureInitialNotebook(fresh)
  assert.equal(bookList(fresh)[0].path, 'Тетрадь.ipynb')
  assert.match(cellSource(getCells(fresh).get(0)).toString(), /Добро пожаловать/)
  const legacy = new Y.Doc()
  getCells(legacy).push([createCell('code', 'имя = "не переводить"')])
  use('en')
  ensureInitialNotebook(legacy)
  assert.equal(bookList(legacy)[0].path, 'Тетрадь.ipynb')
  assert.equal(cellSource(getCells(legacy).get(0)).toString(), 'имя = "не переводить"')
  doc.destroy(); fresh.destroy(); legacy.destroy()
})

test('publication HTML translates chrome and dates while preserving user names, code and raw output', () => {
  const course = { id: 'course', slug: null, name: 'Курс пользователя <b>', blurb: null, items: [{kind: 'seminar' as const, sessionId: 'room', name: 'Семинар пользователя', publication: {id:'pub',slug:null,publishedAt:Date.UTC(2026,8,9),steps:21}}] }
  use('ru')
  const ru = renderCourse(course, 'https://school.example')
  assert.match(ru, /lang="ru"/)
  assert.match(ru, /21 шаг/)
  assert.match(ru, /сентябр/)
  use('en')
  const en = renderCourse(course, 'https://school.example')
  assert.match(en, /lang="en"/)
  assert.match(en, /21 steps/)
  assert.match(en, /September/)
  assert.match(en, /Курс пользователя &lt;b&gt;/)
  assert.match(en, /Семинар пользователя/)
  assert.doesNotMatch(en, /сентябр/)
  assert.match(renderRedirect('https://school.example/new', 'Название'), /This page has moved/)
  assert.match(renderWithdrawn('Название', null, ''), /teacher withdrew/)
  const rendered = renderStep({title:'Название',publishedAt:Date.UTC(2026,8,9),course:null,steps:[{seq:1,label:'Мой шаг',at:0,cellCount:1}],step:{seq:1,label:'Мой шаг',at:0,cells:[{id:'c1',type:'code',source:'print("русский текст <tag>")',outputs:[{kind:'stream',name:'stdout',text:'Не переводить этот вывод'}],execCount:1,ranMs:1200}]},depth:1,base:''})
  assert.match(rendered, /Download notebook/)
  assert.match(rendered, /русский текст &lt;tag&gt;/)
  assert.match(rendered, /Не переводить этот вывод/)
})

test('Council picks the default answer language at request time', () => {
  use('en')
  const en = oraclePrompt({source:'Задание пользователя', before:'', reference:''}, [], 'How is it going?', {budget: 10_000}).turns
  assert.match(en[0].content, /Answer in English by default/)
  assert.match(en[0].content, /explicitly requests another language/)
  // JSON-договора у оракула больше нет: сводка по группам снята целиком, и
  // ответ теперь одна проза в ленту (server/src/ai/council.ts).
  assert.doesNotMatch(en[0].content, /"summary"|"groupLabels"|"drafts"/)
  assert.match(en[1].content, /Задание пользователя/)
  use('ru')
  const ru = oraclePrompt({source:'User task', before:'', reference:''}, [], 'Как дела?', {budget: 10_000}).turns
  assert.match(ru[0].content, /По умолчанию отвечайте по-русски/)
  assert.match(ru[1].content, /User task/)
})

test('a control refusal resolves the current language on each dispatch', async () => {
  const { WebSocket } = await import('ws')
  const { createSession, setRules } = await import('../server/src/db.js')
  const { OPEN_ROOM } = await import('../shared/rules.js')
  const { dispatch } = await import('../server/src/control.js')
  const id = 'i18n-server-control'
  createSession(id, 'Название пользователя', null)
  setRules(id, { ...OPEN_ROOM, restart: 'host' })
  const received: {t:string;message?:string}[] = []
  const ws = {readyState:WebSocket.OPEN,send:(data:string)=>received.push(JSON.parse(data))} as unknown as import('ws').WebSocket
  const payload = {sessionId:id,participantId:'student',role:'participant' as const}
  use('ru'); dispatch(ws,id,payload,{t:'restart'})
  assert.match(received.at(-1)!.message!, /преподаватель/)
  use('en'); dispatch(ws,id,payload,{t:'restart'})
  assert.match(received.at(-1)!.message!, /Only the host can restart/)
  assert.equal(received.at(-1)!.t, 'error')
})

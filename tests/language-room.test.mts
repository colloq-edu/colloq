import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { parse } from 'svelte/compiler'
import ts from 'typescript'
import { runInNewContext } from 'node:vm'
import { setLocaleResolver, translate, tr } from '../shared/i18n.js'
import { roomMessages } from '../shared/locales/room.js'
import { MARKS, markName } from '../web/src/lib/marks.js'
import { INKS } from '../web/src/components/lecture/pult.js'
import { controlTitle, OFFLINE_REASON } from '../web/src/lib/controls.js'
import { plural } from '../web/src/lib/plural.js'
import { formatBytes, elapsed, relativeTime, builtAgo } from '../web/src/lib/utils.js'
import { faceOf, namesLine } from '../web/src/screens/roster.js'

afterEach(() => setLocaleResolver(() => 'ru'))

test('already-created mark, pen, and participant labels follow live language without changing identity', () => {
 let locale = 'ru'
 setLocaleResolver(() => locale)
 const fox = MARKS.find(entry => entry.mark === '🦊')!
 const pen = INKS[0]
 const person = faceOf({ user: { id: 'student', name: 'Лиса Fox', avatar: '🦊', color: '#000000' }, isSelf: true })
 assert.equal(fox.name, 'лиса')
 assert.equal(pen.name, 'Перо, чёрное')
 assert.equal(person.title, 'Лиса Fox (вы)')
 locale = 'en'
 assert.equal(fox.name, 'fox')
 assert.equal(markName('🦊'), 'fox')
 assert.equal(pen.name, 'Pen, black')
 assert.equal(person.title, 'Лиса Fox (you)')
 assert.equal(person.name, 'Лиса Fox')
 assert.equal(person.id, 'student')
 assert.equal(fox.mark, '🦊')
 assert.equal(namesLine([person, person], 1), 'Лиса Fox (you) and 1 more')
 locale = 'ru'
 assert.equal(fox.name, 'лиса')
 assert.equal(person.title, 'Лиса Fox (вы)')
})

test('room counts handle Russian 1/2/5/21 and English singular/plural', () => {
 for (const [count,ru,en] of [[1,'1 попытка','1 attempt'],[2,'2 попытки','2 attempts'],[5,'5 попыток','5 attempts'],[21,'21 попытка','21 attempts']] as const) {
  assert.equal(translate('ru','room.ui.1054',{count}),ru)
  assert.equal(translate('en','room.ui.1054',{count}),en)
 }
 for (const [count,ru,en] of [[1,'1 ячейка','1 cell'],[2,'2 ячейки','2 cells'],[5,'5 ячеек','5 cells'],[21,'21 ячейка','21 cells']] as const) {
  assert.equal(translate('ru','room.notebook.cellCount',{count}),ru)
  assert.equal(translate('en','room.notebook.cellCount',{count}),en)
 }
 assert.equal(translate('ru','room.ui.1058',{count:21,total:25}),'21 сдал из 25')
 assert.equal(translate('en','room.ui.1058',{count:21,total:25}),'21 submitted out of 25')
 setLocaleResolver(() => 'en')
 assert.equal(plural(21,'step','steps','steps'),'steps')
 assert.equal(plural(1,'person','people','person'),'person')
 assert.equal(plural(21,'person','people','person'),'people')
})

test('offline explanations and numerical helpers use the active instance locale', () => {
 setLocaleResolver(() => 'ru')
 assert.match(controlTitle(false, ''), /Нет связи/)
 assert.equal(controlTitle(false, ''), tr(OFFLINE_REASON))
 assert.equal(formatBytes(1536),'1,5 КБ')
 assert.equal(elapsed(0,1250),'1,3 с')
 assert.equal(builtAgo(null),'ещё не собрано')
 setLocaleResolver(() => 'en')
 assert.match(controlTitle(false, ''), /No connection/)
 assert.equal(formatBytes(1536),'1.5 KB')
 assert.equal(elapsed(0,1250),'1.3s')
 assert.equal(relativeTime(Date.now()),'just now')
 assert.equal(builtAgo(null),'never built')
})

test('room catalogs preserve literal user values in confirmations and labels', () => {
 const name = 'Русское имя <script>{count}</script>'
 assert.equal(translate('en','room.mark.owned',{name}),`The ${name} is yours`)
 assert.ok(translate('en','room.confirm.showNamed',{name}).includes(name))
 for (const [key, pair] of Object.entries(roomMessages)) {
  assert.ok(pair.ru && pair.en, key)
  if (/^room\./.test(key)) {
   for (const text of typeof pair.en === 'string' ? [pair.en] : Object.values(pair.en)) assert.ok(!/[А-Яа-яЁё]/.test(text ?? ''), `${key}: ${text}`)
  }
 }
})

test('entry, room, lecture, and public-reader templates have no hardcoded Russian display text', () => {
 const files: string[] = []
 function visit(dir: string): void {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
   const path = `${dir}/${entry.name}`
   if (entry.isDirectory()) visit(path)
   else if (path.endsWith('.svelte')) files.push(path)
  }
 }
 visit('web/src/components'); visit('web/src/screens'); files.push('web/src/App.svelte')
 function walk(node: any, file: string): void {
  if (!node || typeof node !== 'object' || node.type === 'Comment') return
  if (node.type === 'Text') assert.ok(!/[А-Яа-яЁё]/.test(node.data), `${file}: ${node.data}`)
  for (const [key,value] of Object.entries(node)) {
   if (['css','instance','module','comments','loc'].includes(key)) continue
   if (Array.isArray(value)) value.forEach(child => walk(child,file))
   else if (value && typeof value === 'object') walk(value,file)
  }
 }
 for (const file of files) walk(parse(readFileSync(file,'utf8'),{modern:true}).fragment,file)
})


test('external file drag detection keeps the native Files token in both languages', () => {
 const source = readFileSync('web/src/components/panels/FilesPanel.svelte', 'utf8')
 const ast = parse(source, { modern: true })
 const declaration = ast.instance!.content.body.find((node: any) => node.type === 'FunctionDeclaration' && node.id?.name === 'carriedKind')!
 const body = source.slice(declaration.start!, declaration.end!)
 const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
 const carriedKind = runInNewContext(`const PATH_TYPE = 'application/x-colloq-path'; ${compiled}; carriedKind`, { tr }) as (event: { dataTransfer: { types: string[] } | null }) => string | null
 for (const language of ['ru', 'en'] as const) {
  setLocaleResolver(() => language)
  assert.equal(carriedKind({ dataTransfer: { types: ['Files'] } }), 'files')
  assert.equal(carriedKind({ dataTransfer: { types: ['application/x-colloq-path', 'Files'] } }), 'row')
  assert.equal(carriedKind({ dataTransfer: { types: ['text/plain'] } }), null)
  assert.equal(carriedKind({ dataTransfer: null }), null)
 }
})

test('canonical missing-resource errors are translated only for display', () => {
 assert.equal(translate('ru', 'session not found'), 'Занятие не найдено')
 assert.equal(translate('en', 'session not found'), 'Seminar not found')
 assert.equal(translate('ru', 'publication not found'), 'Публикация не найдена')
 assert.equal(translate('ru', 'step not found'), 'Шаг не найден')
})

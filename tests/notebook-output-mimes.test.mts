/**
 * Чем тетрадь показывает запись вывода — и почему список типов ровно один.
 *
 * Набор растровых типов был переписан от руки рядом с комментарием, который
 * обещал, что он совпадает с `BLOB_MIMES` публикации, «и это не совпадение».
 * Связаны они не были ничем: добавленный в `BLOB_MIMES` тип на опубликованной
 * странице приезжает адресом и рисуется, а в живой комнате приезжает base64 и
 * не рисуется вовсе — `pickMime` его не выбирает. Ровно те два места, которые
 * обязаны совпадать, и расходились бы молча.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BLOB_MIMES } from '../shared/publish.js'
import {
  asImage,
  IMG_MIMES,
  imageSrc,
  isAddress,
  isPicture,
  pickMime,
} from '../web/src/components/notebook/output-mimes.js'

test('набор картинок — тот же, что выносит публикация', () => {
  assert.deepEqual([...IMG_MIMES].sort(), [...BLOB_MIMES].sort())
  // И он не пуст: пустой список молча увёл бы каждый график в ветку текста.
  assert.ok(IMG_MIMES.length >= 4)
})

test('всё, что публикация выносит в блоб, тетрадь показывает картинкой', () => {
  for (const mime of BLOB_MIMES) {
    assert.equal(pickMime({ [mime]: 'AAAA', 'text/plain': '<Figure>' }, true), mime)
    assert.equal(asImage(mime, 'AAAA'), true)
  }
})

test('картинка выигрывает у текста, а разметка — только у текста', () => {
  assert.equal(pickMime({ 'text/html': '<b>x</b>', 'text/plain': 'x' }, true), 'text/html')
  // Пока санитайзер не приехал, разметку не показываем вовсе — только текст.
  assert.equal(pickMime({ 'text/html': '<b>x</b>', 'text/plain': 'x' }, false), 'text/plain')
  assert.equal(pickMime({ 'image/png': 'AAAA', 'text/html': '<b>x</b>' }, false), 'image/png')
})

test('незнакомый текстовый тип всё же показывается', () => {
  assert.equal(pickMime({ 'text/markdown': '# hi' }, true), 'text/markdown')
  assert.equal(pickMime({ 'application/vnd.unknown': '{}' }, true), null)
})

test('адрес блоба узнаётся по /api/, а не по косой черте', () => {
  assert.equal(isAddress('/api/p/pub1/blob/abc'), true)
  // base64 любого JPEG начинается с «/9j/» — по косой черте фотография уезжала
  // в src сырым payload'ом, то есть битым значком у всей комнаты.
  assert.equal(isAddress('/9j/4AAQSkZJRg=='), false)
  assert.equal(asImage('text/html', '/api/p/pub1/blob/abc'), true, 'адрес рисуют картинкой из любой ветки')
})

test('src собирается только там, где его нет', () => {
  assert.equal(imageSrc('image/png', '/api/p/pub1/blob/abc'), '/api/p/pub1/blob/abc')
  assert.equal(imageSrc('image/png', 'data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA')
  assert.equal(imageSrc('image/png', 'AA\nAA'), 'data:image/png;base64,AAAA')
})

test('картинку не режем, таблицу режем', () => {
  const png = { kind: 'data', data: { 'image/png': 'AAAA' }, execCount: null } as const
  const html = { kind: 'data', data: { 'text/html': '<table></table>' }, execCount: null } as const
  const svg = { kind: 'data', data: { 'image/svg+xml': '<svg></svg>' }, execCount: null } as const
  assert.equal(isPicture(png, true), true)
  assert.equal(isPicture(svg, true), true)
  assert.equal(isPicture(html, true), false)
  assert.equal(isPicture({ kind: 'stream', name: 'stdout', text: 'x' } as const, true), false)
})

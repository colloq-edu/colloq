/**
 * Кто публикует своё место в документе — и сколько это стоит комнате.
 *
 * Присутствие — самый болтливый провод в продукте: сервер ретранслирует каждый
 * кадр всем соединениям без склейки. Пока место публиковали все, один шаг
 * преподавателя на лекции разворачивался в N кадров от N слушателей (у них
 * читалка прокручивается программно, вслед за ведущим) и N×N доставок: на
 * пятистах — четверть миллиона сообщений на шаг и миллионы на прокрученную
 * страницу.
 *
 * Читает это место ровно одна функция — `leaderFor`, и берёт она только
 * преподавателя. Значит, правило одно, а сторон у него две: кого выбирают
 * ведущим и кто вообще публикует место. Здесь проверяется, что они не
 * разъехались, — потому что разъехаться они могут молча и в любую сторону:
 * ослабишь `leaderFor` — и за студентом станет некому пойти.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mayBeFollowed } from '../shared/rules.js'
import { leaderFor } from '../web/src/lib/follow.js'
import type { Peer } from '../web/src/lib/session.svelte.js'

const FILE = 'lecture.pdf'

function peer(role: 'host' | 'participant', id: number): Peer {
  return {
    clientId: id,
    isSelf: false,
    user: {
      id: `p${id}`,
      name: 'Кто-то',
      avatar: null,
      color: '#000',
      role,
      viewing: { file: FILE, page: 3, y: 0.1 },
    },
  }
}

test('за кем идут — тот и публикует: одно правило, две стороны', () => {
  for (const role of ['host', 'participant'] as const) {
    const followed = leaderFor([peer(role, 7)], FILE, null) !== null
    assert.equal(
      followed,
      mayBeFollowed(role),
      role === 'host'
        ? 'за преподавателем идти можно, а место он не публикует — комната видит доску и идти не за кем'
        : 'место студента публикуется, но за ним никто не идёт — чистый расход кадра на всю комнату',
    )
  }
})

/* --------------------------------------------------- сторона публикации */

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка и код без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const READER = code(read('web/src/components/reader/PdfReader.svelte'))

test('читалка публикует место только через общее правило', () => {
  assert.match(
    READER,
    /mayBeFollowed\(session\.me\.role\)/,
    'читалка снова решает сама, кому публиковать место, — своей копией правила',
  )
  /*
   * Каждая публикация места — под проверкой, и проверка видна в той же строке.
   * Снять место (`setViewing(null)`) можно и без неё: это не кадр на комнату, а
   * уборка за тем, кому больше нельзя.
   */
  const lines = READER.split('\n').filter((line) => /session\.setViewing\(\s*\{/.test(line))
  assert.ok(lines.length > 0, 'читалка вообще перестала сообщать место — за преподавателем не пойти')
  for (const line of lines) {
    assert.match(
      line,
      /\bleads\b/,
      `безусловный setViewing в читалке: ${line.trim()} — кадр присутствия уходит ` +
        'всей комнате на каждый шаг прокрутки у каждого слушателя',
    )
  }
})

test('прокрутка не публикует место у того, за кем идти нельзя', () => {
  const at = READER.indexOf('function onScroll')
  assert.ok(at > 0, 'onScroll в читалке не найден — тест смотрит не туда')
  const body = READER.slice(at, at + 500)
  assert.match(
    body,
    /if \(leads\) session\.setViewing/,
    'onScroll снова шлёт кадр присутствия без проверки, за кем комната может пойти',
  )
})

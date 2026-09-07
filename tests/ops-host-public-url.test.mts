/**
 * `make host` меняет адрес комнаты, не роняя комнату.
 *
 * Служба читает PUBLIC_URL из .env заново не реже раза в две секунды
 * (server/src/config.ts · readPublicUrl), поэтому новый адрес доезжает сам.
 * Перезапуск ради него рвал сокеты всей аудитории — заметнее всего когда
 * `make host` повторяют посреди пары, потому что упал туннель: зал уходил в
 * переподключение без причины. А без перезапуска нужно чем-то дождаться, что
 * адрес доехал, — и `/api/health` называет тот адрес, который сервер сейчас
 * пишет в ссылки, так что ждать можно ответа, а не времени.
 *
 * Оба свойства легко потерять обратной правкой «на всякий случай»: сначала
 * возвращается `systemctl restart`, потом «просто поспим подольше». Здесь они
 * закреплены.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = fs.readFileSync(path.join(repo, 'scripts/host.sh'), 'utf8')

/** Строки скрипта без комментариев: про эту ошибку они как раз рассказывают. */
const code = script
  .split('\n')
  .map((line) => (/^\s*#/.test(line) ? '' : line))
  .join('\n')

test('адрес доезжает без перезапуска службы', () => {
  const restarts = code
    .split('\n')
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => /systemctl\s+(restart|reload-or-restart)\s+colloq/.test(line))
  assert.deepEqual(
    restarts,
    [],
    `scripts/host.sh перезапускает службу ради .env, который она и так перечитывает: ${restarts
      .map(([n, line]) => `${n}: ${line.trim()}`)
      .join('; ')}`,
  )
})

test('скрипт спрашивает у службы адрес, а не пережидает срок', () => {
  const branch = code.slice(code.indexOf('\n  service)'), code.indexOf('\n  container)'))
  assert.ok(branch.length > 0, 'ветка service в host.sh не нашлась — проверять нечего')
  assert.match(
    branch,
    /api\/health/,
    'ожидание нового адреса не спрашивает /api/health — значит оно ждёт вслепую',
  )
  assert.match(
    branch,
    /publicUrl/,
    'ответ здоровья не сверяется с только что записанным адресом (поле publicUrl)',
  )
})

test('здоровье и правда называет адрес — иначе ждать нечего', async () => {
  // Поле на серверной стороне: без него сверка выше ждала бы совпадения,
  // которого никогда не будет. Проверяется по коду маршрута, а не по живому
  // ответу: поднимать приложение ради одной строки дороже, чем оно стоит.
  const app = fs.readFileSync(path.join(repo, 'server/src/app.ts'), 'utf8')
  assert.match(app, /publicUrl:\s*config\.publicUrl/)
})

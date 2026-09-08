/**
 * README и .env.example — тоже контракт, и здесь он сверяется с кодом.
 *
 * Две вещи, о которых преподавателю не говорили нигде, а стоили они пары.
 *
 * BIND_ADDR знали только код (server/src/index.ts) и юнит systemd. Ни таблица
 * настроек README, ни .env.example про него не говорили, поэтому `make run` на
 * ноутбуке в аудитории раздавал комнату ещё и по http://<ip-ноутбука>:3000 —
 * мимо выданной ссылки и мимо туннеля. Под `make up` та же дверь была открыта
 * публикацией порта без адреса, хотя docker-compose.dev.yml ровно это для 8888
 * закрывает и объясняет.
 *
 * Консилиум считает попытки в ОДНОМ ядре комнаты: попытка видит `df`, который
 * преподаватель приготовил в общей ячейке, и это нарочно, — но имена самой
 * попытки после неё снимаются, а изменения существующих объектов остаются
 * общими. Об этом сказано в комнате (COUNCIL_SHARED_KERNEL_NOTE), и README про
 * режимы обязан говорить то же самое: преподаватель ставит «верно» по выводу.
 *
 * Проверяется здесь только «слово», потому что «дело» проверено соседями:
 * ban/gate/kernel — своими сюитами, а эти два файла не собирает и не
 * типизирует никто.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

const readme = read('README.md')
const example = read('.env.example')
const compose = read('docker-compose.yml')

test('BIND_ADDR назван и в .env.example, и в таблице настроек README', () => {
  // Explain the host bind address and keep the shipped example on loopback.
  const at = example.indexOf('BIND_ADDR')
  assert.notEqual(at, -1, 'BIND_ADDR не назван в .env.example')
  const about = example.slice(Math.max(0, at - 900), at + 200)
  assert.match(about, /127\.0\.0\.1/)
  assert.match(about, /make up/)
  assert.match(about, /make host/, 'не сказано, чем комната выходит наружу вместо открытого порта')

  const row = readme.split('\n').find((l) => l.startsWith('| `BIND_ADDR`'))
  assert.ok(row, 'в таблице настроек README нет строки BIND_ADDR')
  assert.match(row, /every interface/i)
  assert.match(row, /127\.0\.0\.1/)

  assert.match(example, /^BIND_ADDR=127\.0\.0\.1$/m)
})

test('переменная сервера и адрес публикации порта — одно слово, а не два', () => {
  // Внутрь контейнера BIND_ADDR передавать нельзя: там сервер обязан слушать
  // все интерфейсы, иначе не достучаться и до опубликованного порта. Поэтому
  // compose ограничивает ею ХОЗЯЙСКУЮ сторону порта — и только её.
  const app = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  kernel:'))
  assert.match(app, /- "\$\{BIND_ADDR:-0\.0\.0\.0\}:\$\{PORT:-3000\}:3000"/)
  assert.ok(
    !/\n {6}BIND_ADDR: /.test(app),
    'BIND_ADDR уехал в environment контейнера — сервер внутри будет слушать петлю контейнера, то есть никого',
  )

  // Production ingress is a loopback NodePort, with no root systemd web process.
  assert.match(read('scripts/cluster.sh'), /nodeport-addresses=127\.0\.0\.0\/8/)
  assert.doesNotMatch(read('deploy/colloq.service'), /^User=root$/m)

  // Умолчание кода — пусто, то есть все интерфейсы: таблица README описывает
  // именно его, и переименование переменной в сервере уронит эту строку.
  assert.match(read('server/src/index.ts'), /process\.env\.BIND_ADDR/)
})

test('deployment documentation describes mandatory broker isolation and explicit development limits', () => {
  for (const file of ['runtime/README.md', 'deploy/k3s/README.md', 'docs/deployment-vast.md']) {
    assert.ok(readme.includes(file), `missing operational documentation link: ${file}`)
  }
  for (const variable of ['KERNEL_BACKEND', 'KERNEL_RUNTIME_URL', 'KERNEL_RUNTIME_TOKEN_FILE', 'KERNEL_CATALOG_FILE', 'COLLOQ_UNSAFE_DEV_FILES']) {
    assert.ok(example.includes(variable), `missing configuration contract: ${variable}`)
  }
  assert.doesNotMatch(example, /^KERNEL_ISOLATION=auto$|KERNEL_ISOLATION=off/m)
  assert.doesNotMatch(example, /^JUPYTER_TOKEN=.+$/m)
  assert.match(readme, /\.restore-in-progress/)
  assert.match(readme, /MODE=consistent/)
  assert.match(readme, /live.*not an atomic snapshot/is)
  assert.match(readme, /sourceCommit/)
  assert.match(readme, /COLLOQ_UNSAFE_DEV_FILES=1/)
})

test('README про консилиум говорит то же, что комната: ядро одно', () => {
  const bullet = readme.slice(readme.indexOf('* **council** —'))
  const said = bullet.slice(0, bullet.indexOf('\n\n'))
  assert.match(said, /one kernel/i, 'README не говорит, что попытки считаются в общем ядре комнаты')
  assert.match(said, /one after another|in turn|queue/i, 'не сказано, что по очереди')
  // Обе половины правды: имена снимаются, изменённое остаётся общим.
  assert.match(said, /takes away|removes/i)
  assert.match(said, /stays shared/i)
})

/**
 * Два файла, которые никто не собирает и не типизирует, а стоят они пары.
 *
 * `deploy/colloq.service` — то, чем сервер живёт на выделенной машине.
 * `Restart=always` в нём обещает «упал — поднять», но у systemd поверх этого
 * стоит собственный предел: пять запусков за десять секунд, и шестого не будет
 * — юнит уходит в failed до `systemctl reset-failed` руками. При RestartSec=2
 * пять падений подряд — это десять секунд, то есть ровно тот случай, ради
 * которого Restart и написан.
 *
 * `docker-compose.yml` — про изоляцию. У общего ядра примонтирован ./workspace
 * ЦЕЛИКОМ, то есть файлы всех семинаров машины, и стояло оно в той же сети,
 * куда сервер ставит контейнеры комнат: из любой ячейки до него дотягивались
 * по имени `kernel`, и единственным замком был JUPYTER_TOKEN — у копии
 * .env.example общеизвестный. Сеть у общего ядра теперь своя.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const unit = readFileSync(path.join(root, 'deploy/colloq.service'), 'utf8')
const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')

/** Строки одной секции ini-файла, без комментариев и пустых. */
function section(text: string, name: string): string[] {
  const lines = text.split('\n')
  const from = lines.findIndex((l) => l.trim() === `[${name}]`)
  assert.notEqual(from, -1, `в юните нет секции [${name}]`)
  const rest = lines.slice(from + 1)
  const to = rest.findIndex((l) => /^\[[A-Za-z]+\]$/.test(l.trim()))
  return (to === -1 ? rest : rest.slice(0, to))
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
}

test('служба поднимается после пятого падения так же, как после первого', () => {
  const wanted = section(unit, 'Unit')
  const limit = wanted.find((l) => l.startsWith('StartLimitIntervalSec='))
  assert.ok(limit, 'без StartLimitIntervalSec systemd бросает поднимать службу на шестом запуске')
  assert.equal(limit, 'StartLimitIntervalSec=0')
  // И это именно [Unit]: в [Service] systemd про эту строку не знает.
  assert.ok(!section(unit, 'Service').some((l) => l.startsWith('StartLimitIntervalSec=')))
  assert.ok(section(unit, 'Service').includes('Restart=always'))
})

test('общее ядро compose стоит не в той сети, куда сервер ставит комнаты', () => {
  // Сеть комнат — та, что сервер получает строкой KERNEL_NETWORK и в которой
  // ищет ядро комнаты по имени контейнера.
  const rooms = /KERNEL_NETWORK: \$\{KERNEL_NETWORK:-([a-z0-9-]+)\}/.exec(compose)?.[1]
  assert.equal(rooms, 'colloq', 'имя сети комнат в compose изменилось — проверка ниже смотрит не туда')
  assert.match(compose, /\n {2}default:\n {4}name: colloq\n/)

  const app = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  kernel:'))
  const kernel = compose.slice(compose.indexOf('\n  kernel:'))

  /** Сети, названные в блоке `networks:` одной службы. */
  const joined = (block: string): string[] => {
    const at = block.indexOf('\n    networks:')
    assert.notEqual(at, -1, 'у службы не названы сети — она попадёт в default, то есть к комнатам')
    const out: string[] = []
    for (const line of block.slice(at + 1).split('\n').slice(1)) {
      const m = /^ {6}- ([a-z0-9-]+)$/.exec(line)
      if (!m) break
      out.push(m[1])
    }
    return out
  }

  assert.deepEqual(joined(kernel), ['shared-kernel'], 'общее ядро снова видно из сети комнат')
  assert.deepEqual(joined(app).sort(), ['default', 'shared-kernel'], 'серверу нужны обе сети')
  assert.match(compose, /\n {2}shared-kernel:\n {4}name: colloq-kernel\n/)
})

test('.env.example не обещает, что общеизвестный токен ядра — это нормально', () => {
  const example = readFileSync(path.join(root, '.env.example'), 'utf8')
  const at = example.indexOf('\nJUPYTER_TOKEN=')
  assert.notEqual(at, -1)
  // Значение осталось прежним нарочно — чтобы `make up` его заменил, — но
  // рядом должно быть сказано, что копия примера руками оставляет его как есть.
  const said = example.slice(Math.max(0, at - 800), at)
  assert.match(said, /make up/)
  assert.match(said, /cp \.env\.example \.env/)
})

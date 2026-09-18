/**
 * Образ colloq-vast (deploy/vast/): что обязано сходиться с остальным кодом.
 *
 * Сам образ собирается и проверяется настоящим docker в `make vast-image-run`
 * (deploy/vast/smoke.sh: dind вместо VM, комната, ячейка, копия), и в сюите его
 * нет — docker здесь есть не у всех. Но пять вещей ломаются молча — первые
 * четыре при правке СОСЕДНЕГО файла, — а узнают о них только на арендованной
 * машине. Их и держит этот файл:
 *
 *   1. то, что Dockerfile копирует из репозитория, существует: переименовали
 *      скрипт — сборка образа упадёт уже в CI, а не у владельца перед арендой;
 *   2. сервер действительно пустит докер-бэкенд с тем окружением, которое ему
 *      даёт точка входа (NODE_ENV=development, KERNEL_BACKEND=docker): запрети
 *      кто-нибудь docker вне тестов — образ поднимется и откажет на первом Run;
 *   3. имя образа ядра то же, что ждёт pool.ts: точка входа собирает и тянет
 *      `colloq-kernel:<окружение>`, и другое имя значит «окружение не собрано»
 *      на каждой комнате при собранном образе;
 *   4. frpc в образе той же версии, что ставят ретранслятору и прежнему пути
 *      на VM: протокол frp между версиями ломался;
 *   5. повторный on-start (перезагрузка VM) не трогает живой инстанс: не
 *      пересоздаёт контейнер из-за порядка строк в colloq.env и не откатывает
 *      образ, выбранный `colloq-host update`, к тому, что стоял в шаблоне.
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { selectKernelBackend } from '../server/src/kernel/runtime-client.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const DOCKERFILE = read('deploy/vast/Dockerfile')
const ENTRYPOINT = read('deploy/vast/entrypoint.sh')

test('every path the vast Dockerfile copies from the repository exists', () => {
  // Строки продолжения (`\`) склеиваются: COPY бывает многострочным.
  const lines = DOCKERFILE.replace(/\\\n/g, ' ').split('\n')
  const sources: string[] = []
  for (const line of lines) {
    const match = /^\s*COPY\s+(.*)$/.exec(line)
    if (!match || /--from=/.test(match[1])) continue
    const parts = match[1].trim().split(/\s+/).filter((part) => !part.startsWith('--'))
    sources.push(...parts.slice(0, -1))
  }
  assert.ok(sources.length >= 8, `expected the Dockerfile to copy repository files, got ${sources.join(', ')}`)
  for (const source of sources) {
    assert.ok(fs.existsSync(path.join(ROOT, source)), `deploy/vast/Dockerfile copies ${source}, which does not exist`)
  }
})

test('the server accepts the kernel backend the entrypoint starts it with', () => {
  const block = /exec env \\\n([\s\S]*?)node server\/dist\/server\.js/.exec(ENTRYPOINT)
  assert.ok(block, 'the entrypoint should start the server with an explicit `exec env` block')
  const env: Record<string, string> = {}
  for (const line of block[1].split('\n')) {
    const pair = /^\s*([A-Z_]+)=("?)([^"\s\\]*)\2/.exec(line)
    if (pair) env[pair[1]] = pair[3]
  }
  assert.equal(env.NODE_ENV, 'development')
  assert.equal(env.KERNEL_BACKEND, 'docker')
  assert.equal(env.KERNEL_ISOLATION, 'required')
  assert.equal(selectKernelBackend({ NODE_ENV: env.NODE_ENV, KERNEL_BACKEND: env.KERNEL_BACKEND }), 'docker')
})

test('the entrypoint prepares kernel images under the name the Docker pool runs', () => {
  const pool = read('server/src/kernel/pool.ts')
  const prefix = /const IMAGE_PREFIX = '([^']+)'/.exec(pool)?.[1]
  assert.equal(prefix, 'colloq-kernel')
  assert.match(ENTRYPOINT, /-t "colloq-kernel:\$link"/)
  assert.match(ENTRYPOINT, /docker tag "\$\{KERNEL_IMAGE_REPO\}:\$\{tag\}" "colloq-kernel:\$link"/)
})

test('the image pins the same frp version as the relay and the VM path', () => {
  const image = /ARG FRP_VERSION=(\S+)/.exec(DOCKERFILE)?.[1]
  assert.ok(image, 'deploy/vast/Dockerfile should pin FRP_VERSION')
  for (const file of ['scripts/relay-setup.sh', 'scripts/vast-legacy.sh']) {
    // С кавычками и без: `FRP_VERSION="${FRP_VERSION:-0.71.0}"` и `FRP_VERSION=${FRP_VERSION:-0.71.0}`.
    const pinned = /^FRP_VERSION="?\$\{FRP_VERSION:-([0-9.]+)\}"?/m.exec(read(file))?.[1]
    assert.equal(pinned, image, `${file} pins frp ${pinned}, the image ${image}`)
  }
  for (const arch of ['AMD64', 'ARM64']) {
    assert.match(DOCKERFILE, new RegExp(`ARG FRP_SHA256_${arch}=[0-9a-f]{64}\\b`))
    assert.match(DOCKERFILE, new RegExp(`ARG CLOUDFLARED_SHA256_${arch}=[0-9a-f]{64}\\b`))
  }
})

test('the vast shell scripts parse', () => {
  for (const file of ['entrypoint.sh', 'colloq-host', 'onstart.sh', 'smoke.sh']) {
    const result = spawnSync('bash', ['-n', path.join(ROOT, 'deploy/vast', file)], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${file}: ${result.stderr}`)
  }
})

test('a repeated on-start leaves a running instance and its image alone', () => {
  const host = read('deploy/vast/colloq-host')
  // Отпечаток настроек решает, пересоздавать ли контейнер. write_env переносит
  // каждый переписанный ключ в конец файла, ensure_gpu дописывает KERNEL_GPUS
  // последним — те же значения приходят в другом порядке, и без sort вторая
  // загрузка GPU-машины снимала живой сервер (проверено заглушкой docker).
  const sum = /\nconfig_sum\(\) \{\n([^\n]*)/.exec(host)?.[1] ?? ''
  assert.match(sum, /sort "\$ENV_FILE"/, 'config_sum should hash colloq.env sorted, not in file order')
  // COLLOQ_IMAGE из on-start только заводит /etc/colloq/image; после update
  // файлом владеет update, иначе перезагрузка откатывала бы версию.
  const image = /\nimage\(\) \{\n([\s\S]*?)\n\}/.exec(host)?.[1] ?? ''
  assert.match(image, /elif \[ ! -s "\$IMAGE_FILE" \] && \[ -n "\$\{COLLOQ_IMAGE:-\}" \]/,
    'COLLOQ_IMAGE should only seed /etc/colloq/image, never overwrite it')
})

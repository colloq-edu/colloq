/**
 * .env, который заводит make, годится для `make dev`.
 *
 * Поймано так: `make up` (или run, host, activity — любая цель с
 * пререквизитом `.env`) на свежем клоне делала `cp .env.example .env`, а
 * .env.example — шаблон прода с KERNEL_BACKEND=broker. Следующий `make dev`
 * (супервизор cli/src/launch.ts) отказывал: «This is a runtime broker
 * installation». Цель теперь пишет тот же файл, что и сам colloq
 * (scripts/local-env.sh ↔ launch-config.ts · localClassEnv), и тесты ниже
 * держат три вещи: копии текста не расходятся; порядок «make-цель, потом
 * make dev» и обратный оба работают; отказ на настоящем проде остался.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'dotenv'
import { launchConfig, localClassEnv, parseLaunchArgs } from '../cli/src/launch-config.js'

const repo = path.resolve(import.meta.dirname, '..')

/** Клон в миниатюре: ровно то, что трогают цели `.env` и `up` (без docker). */
function checkout(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'colloq-local-env-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  for (const file of ['Makefile', '.env.example', 'docker-compose.yml', 'scripts/local-env.sh'])
    fs.copyFileSync(path.join(repo, file), path.join(dir, file))
  return dir
}

function make(dir: string, ...args: string[]): { code: number | null; out: string } {
  return makeIn(dir, process.env, args)
}

function makeIn(dir: string, env: NodeJS.ProcessEnv, args: string[]): { code: number | null; out: string } {
  const result = spawnSync('make', ['--no-print-directory', ...args], { cwd: dir, env, encoding: 'utf8' })
  // Цвета Makefile (\033[…m) из вывода вон: проверяем текст, а не оформление.
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') }
}

/** docker-заглушка первой в PATH: цели, которые его зовут, проходят без демона. */
function stubDocker(dir: string): NodeJS.ProcessEnv {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }
}

/** Токен у каждой записи свой — сравниваем всё, кроме его значения. */
const tokenless = (text: string) => text.replace(/^JUPYTER_TOKEN=.*$/m, 'JUPYTER_TOKEN=<token>')

test('make .env пишет .env локального занятия — тот же, что colloq, а не шаблон прода', () => {
  const dir = checkout()
  try {
    const result = make(dir, '.env')
    assert.equal(result.code, 0, result.out)
    const written = fs.readFileSync(path.join(dir, '.env'), 'utf8')
    // Копии текста — шелл для make и TS для colloq — одна и та же строка в строку.
    assert.equal(tokenless(written), tokenless(localClassEnv(false)))
    assert.match(written, /^KERNEL_BACKEND=docker$/m)
    assert.doesNotMatch(written, /broker|colloq-runtime|\/etc\/colloq/)
    // Свой токен ядра, той же длины, что randomBytes(24) у colloq, и не повторяется.
    const token = written.match(/^JUPYTER_TOKEN=(.*)$/m)?.[1] ?? ''
    assert.match(token, /^[0-9a-f]{48}$/)
    fs.rmSync(path.join(dir, '.env'))
    assert.equal(make(dir, '.env').code, 0)
    assert.notEqual(parse(fs.readFileSync(path.join(dir, '.env'))).JUPYTER_TOKEN, token)
    // Внутри будут ключи входа — 0600, как у файла супервизора.
    if (process.platform !== 'win32')
      assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('после make-цели супервизор принимает .env: и dev, и run', () => {
  const dir = checkout()
  try {
    assert.equal(make(dir, '.env').code, 0)
    const source = parse(fs.readFileSync(path.join(dir, '.env')))
    for (const action of ['dev', 'run']) {
      const config = launchConfig(dir, parseLaunchArgs([action]), source, dir)
      assert.equal(config.env.KERNEL_BACKEND, 'docker', action)
      assert.equal(config.port, 3000, action)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('копия шаблона из старого клона: отказ называет строку и файл, а не «идите в cluster»', () => {
  // Такой .env лежит у всех, кто звал make up с 09.09: цель копировала шаблон.
  const source = parse(fs.readFileSync(path.join(repo, '.env.example')))
  assert.equal(source.KERNEL_BACKEND, 'broker', 'шаблон прода по-прежнему про broker')
  assert.throws(
    () => launchConfig('/clone', parseLaunchArgs(['dev']), source, '/clone'),
    (error: Error) =>
      /KERNEL_BACKEND=docker/.test(error.message) &&
      error.message.includes(path.join('/clone', '.env')) &&
      /\.env\.example/.test(error.message),
  )
})

test('настоящая установка по-прежнему не запускается как занятие на ноутбуке', () => {
  // COLLOQ_CLUSTER=1 пишет только развёртывание (scripts/vast.sh) — прежний отказ.
  assert.throws(
    () => launchConfig('/vm', parseLaunchArgs(['run']), { ...localEnv(), COLLOQ_CLUSTER: '1' }),
    /runtime broker installation: use the service or cluster commands/,
  )
  // broker из оболочки (переменная сильнее файла) — тоже отказ, файл его не отменит.
  assert.throws(
    () => launchConfig('/vm', parseLaunchArgs(['dev']), { ...localEnv(), KERNEL_BACKEND: 'broker' }),
    /service or cluster commands/,
  )
})

function localEnv(): Record<string, string> {
  return parse(localClassEnv(false))
}

test('обратный порядок: .env супервизора make up не трогает и отдаёт compose целиком', () => {
  const dir = checkout()
  try {
    // Так пишет его launch.ts при первом make dev.
    const own = localClassEnv(false)
    fs.writeFileSync(path.join(dir, '.env'), own, { mode: 0o600 })
    assert.equal(make(dir, '.env').code, 0)
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), own, 'существующий .env не переписан')
    // make up без docker: -n печатает, что сделал бы. Писателя .env среди этого нет.
    const plan = make(dir, '-n', 'up')
    assert.equal(plan.code, 0, plan.out)
    assert.doesNotMatch(plan.out, /local-env\.sh/)
    assert.match(plan.out, /docker compose up -d --build app/)
    // Каждую строку, которую человек правит в этом .env, compose и читает, —
    // кроме KERNEL_BACKEND: compose ставит docker сам. Иначе правка PORT или
    // ключа оракула под make up молча ничего бы не меняла.
    const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8')
    const read = new Set([...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]))
    assert.match(compose, /KERNEL_BACKEND: docker/)
    for (const key of Object.keys(parse(own)).filter((k) => k !== 'KERNEL_BACKEND'))
      assert.ok(read.has(key), `${key} из .env занятия не доезжает до make up`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Ровно путь человека: make-цель завела .env, затем настоящий супервизор.
 *
 * Порт сервера заранее занят нашим же слушателем, поэтому супервизор, приняв
 * настройки, останавливается на проверке порта — ничего не собирая и не
 * запуская. До починки он падал раньше, на broker.
 */
test('make .env, затем launch.ts dev: доходит до проверки порта, а не до отказа про broker', async () => {
  const dir = checkout()
  const blocker = net.createServer()
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busy = (blocker.address() as net.AddressInfo).port
  try {
    assert.equal(make(dir, '.env').code, 0)
    const env: NodeJS.ProcessEnv = { ...process.env, COLLOQ_HOME: dir, PORT: String(busy) }
    for (const key of ['KERNEL_BACKEND', 'COLLOQ_CLUSTER', 'COLLOQ_APP_DIR', 'DATA_DIR', 'WORKSPACE_DIR'])
      delete env[key]
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'cli/src/launch.ts', 'dev', '--no-open', '--port', String(busy === 65535 ? busy - 1 : busy + 1)],
      { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    assert.equal(code, 1, out)
    assert.match(out, new RegExp(`Port ${busy} .*already taken`), out)
    assert.doesNotMatch(out, /broker/, out)
    // Отказ ничего не оставил: ни расписки, ни pid-файла.
    assert.equal(fs.existsSync(path.join(dir, '.colloq/local-session.json')), false)
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Занятый порт по умолчанию — не отказ: берётся ближайший свободный, как у
 * Jupyter. Названный явно (--port) — отказ, как и был. Docker здесь нарочно не
 * найти (PATH только с node): запуск останавливается на «Docker is not
 * responding», ничего не собрав, — строка про порт к этому времени уже сказана.
 */
test('run: a busy default port moves to the nearest free one, a busy --port is refused', async () => {
  const dir = checkout()
  const blocker = net.createServer()
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busy = (blocker.address() as net.AddressInfo).port
  const launch = async (args: string[]): Promise<{ code: number | null; out: string }> => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COLLOQ_HOME: dir,
      PORT: String(busy),
      PATH: path.dirname(process.execPath),
    }
    for (const key of ['KERNEL_BACKEND', 'COLLOQ_CLUSTER', 'COLLOQ_APP_DIR', 'DATA_DIR', 'WORKSPACE_DIR'])
      delete env[key]
    const child = spawn(process.execPath, ['--import', 'tsx', 'cli/src/launch.ts', 'run', '--no-open', ...args], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    return { code, out }
  }
  try {
    assert.equal(make(dir, '.env').code, 0)
    const moved = await launch([])
    assert.match(moved.out, new RegExp(`Port ${busy} is taken; using ${busy + 1}\\.`), moved.out)
    assert.doesNotMatch(moved.out, /already taken/, moved.out)
    assert.match(moved.out, /Docker is not responding/, moved.out)

    const named = await launch(['--port', String(busy)])
    assert.equal(named.code, 1, named.out)
    assert.match(named.out, new RegExp(`Port ${busy} is already taken`), named.out)
    assert.doesNotMatch(named.out, /using/, named.out)
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/*
 * env-use на свежем клоне. Цель переливала .env через grep -v и дописывала
 * KERNEL_ENV — а когда файла ещё не было, получался .env из одной этой строки.
 * Дальше ни make up, ни make dev своего не писали (файл же есть), и занятие
 * шло с умолчаниями и общеизвестным токеном ядра. Та же ошибка была у
 * `colloq env use` (cli/src/commands/env.ts); у make её закрыл пререквизит .env.
 */
test('make env-use на свежем клоне: полный .env занятия, а не одна строка KERNEL_ENV', () => {
  const dir = checkout()
  try {
    fs.mkdirSync(path.join(dir, 'kernel/environments'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'kernel/environments/cv.txt'), 'numpy\n')
    const result = makeIn(dir, stubDocker(dir), ['env-use', 'NAME=cv'])
    assert.equal(result.code, 0, result.out)
    const text = fs.readFileSync(path.join(dir, '.env'), 'utf8')
    const env = parse(text)
    assert.equal(text.match(/^KERNEL_ENV=/gm)?.length, 1, text)
    assert.equal(env.KERNEL_ENV, 'cv')
    assert.match(env.JUPYTER_TOKEN ?? '', /^[0-9a-f]{48}$/)
    // Кроме окружения и токена — ровно файл занятия: env-use меняет одну строку.
    const own = parse(localClassEnv(false))
    assert.deepEqual({ ...env, KERNEL_ENV: own.KERNEL_ENV, JUPYTER_TOKEN: '' }, { ...own, JUPYTER_TOKEN: '' })
    if (process.platform !== 'win32')
      assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600)
    assert.equal(launchConfig(dir, parseLaunchArgs(['dev']), env, dir).kernelEnv, 'cv')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/*
 * PUBLIC_URL в файле занятия нет (его не было и у colloq), а make run и
 * make status печатали строку из .env как есть: готовый сервер объявлялся
 * пустым «colloq на». Сервер без строки берёт localhost:PORT (config.ts ·
 * readPublicUrl) — это и должно быть напечатано.
 */
test('make status и make run без PUBLIC_URL печатают localhost:PORT, а не пустую ссылку', () => {
  const dir = checkout()
  try {
    assert.equal(make(dir, '.env').code, 0)
    const env = stubDocker(dir)
    const shown = () => {
      const result = makeIn(dir, env, ['status'])
      assert.equal(result.code, 0, result.out)
      return result.out.match(/^PUBLIC_URL: (.*)$/m)?.[1]
    }
    assert.equal(shown(), 'http://localhost:3000')
    const file = path.join(dir, '.env')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^PORT=3000$/m, 'PORT=4000'))
    assert.equal(shown(), 'http://localhost:4000')
    fs.appendFileSync(file, 'PUBLIC_URL=https://demo.example.org\n')
    assert.equal(shown(), 'https://demo.example.org')
    // run поднимает настоящий сервер, поэтому здесь только его план: та же подстановка.
    const plan = make(dir, '-n', 'run')
    assert.equal(plan.code, 0, plan.out)
    assert.match(plan.out, /"\$\{url:-http:\/\/localhost:4000\}"/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

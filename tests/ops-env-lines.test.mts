/**
 * .env как файл настроек, а не как программа для оболочки.
 *
 * Две ошибки, обе стоившие пары. Первая: `set -a; . ./.env` перед запуском
 * сервера. Это не чтение файла, а его исполнение, и строка вида
 * `INSTITUTION=Высшая школа экономики` — ровно та форма, которую просят
 * .env.example и README, — для bash есть команда `школа` с префиксным
 * присваиванием: rc=127. В `scripts/host.sh` под `set -euo pipefail` это
 * убивало подоболочку уже ПОСЛЕ того, как строкой выше убит старый сервер:
 * преподаватель перед парой оставался без сервера вовсе.
 *
 * Вторая: `read_env`, списанный в трёх скриптах, вырезал `tr -d ' \r'` каждый
 * пробел, где бы тот ни стоял. Имена карт в API vast пишутся с пробелом, и
 * `VAST_GPU=RTX 4090` превращался в «RTX4090», под который предложений нет, —
 * а скрипт советовал вписать в .env то, что уже вписано.
 *
 * Здесь проверяется и то, и другое: что запуск сервера ничего не сорсит, что
 * dotenv (тот путь, которым сервер и читает .env) значение с пробелами берёт
 * целиком, и что общий read_env трогает только края.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Значение, на котором всё и ломалось: пробелы внутри, кириллица. */
const INSTITUTION = 'Высшая школа экономики'

/** Каталоги этого файла — и уборка за ними: без неё /tmp растёт с каждым прогоном. */
const made: string[] = []
after(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-env-'))
  made.push(dir)
  return dir
}

/** Одна строка из .env глазами общего read_env (scripts/lib.sh). */
function readEnv(dir: string, name: string): string {
  return execFileSync(
    'bash',
    ['-c', `. "${path.join(repo, 'scripts/lib.sh')}"; read_env ${name}`],
    { cwd: dir, encoding: 'utf8' },
  )
}

test('запуск сервера не сорсит .env: ни Makefile, ни host.sh', () => {
  /*
   * Стереги именно форму, а не строку целиком: `. ./.env`, `source .env`,
   * `set -a` рядом с запуском — всё это возвращает тот же отказ.
   */
  const suspects = [
    'Makefile',
    'scripts/host.sh',
    'scripts/service.sh',
    'scripts/vast.sh',
    'scripts/restore.sh',
  ]
  for (const file of suspects) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8')
    const lines = text.split('\n')
    for (const [i, line] of lines.entries()) {
      // Комментарии рассказывают об этой ошибке — их не ловим.
      const code = line.replace(/^\s*@?#.*/, '').replace(/^\s*@?:\s+'.*/, '')
      assert.ok(
        !/(^|[;&(\s])(\.|source)\s+\.?\/?\.env(\s|$|;|\))/.test(code),
        `${file}:${i + 1} сорсит .env оболочкой: ${line.trim()}`,
      )
    }
  }
})

test('значение с пробелами доезжает до сервера через dotenv, а не через оболочку', () => {
  const dir = tmpdir()
  fs.writeFileSync(
    path.join(dir, '.env'),
    `PORT=3000\nINSTITUTION=${INSTITUTION}\nVAST_GPU=RTX 4090\n`,
  )
  /*
   * Ровно тот путь, которым читает сервер: `import 'dotenv/config'` первой
   * строкой server/src/config.ts, файл берётся из рабочего каталога процесса.
   * Пакет назван полным путём только потому, что процесс запускается вне
   * репозитория — читает он всё равно .env из своего cwd.
   */
  const dotenvConfig = path.join(repo, 'node_modules/dotenv/config.js')
  const env = { ...process.env }
  delete env.INSTITUTION
  const out = execFileSync(
    process.execPath,
    ['-e', `require(${JSON.stringify(dotenvConfig)}); console.log(process.env.INSTITUTION)`],
    { cwd: dir, encoding: 'utf8', env },
  )
  assert.equal(out.trim(), INSTITUTION)
})

test('а прежний способ — исполнение файла оболочкой — на этой же строке падает', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, '.env'), `INSTITUTION=${INSTITUTION}\n`)
  const r = spawnSync('bash', ['-c', 'set -euo pipefail; ( set -a; . ./.env; set +a; true )'], {
    cwd: dir,
    encoding: 'utf8',
  })
  assert.notEqual(r.status, 0, 'source .env со значением-с-пробелом обязан падать — ради этого он и убран')
  assert.match(r.stderr, /command not found|не найдена/i)
})

test('read_env оставляет пробелы внутри значения и снимает только края', () => {
  const dir = tmpdir()
  fs.writeFileSync(
    path.join(dir, '.env'),
    [
      'VAST_GPU=RTX 4090',
      `INSTITUTION=${INSTITUTION}`,
      'PORT=  3001  ',
      'QUOTED="two words"',
      "APOS=it's",
      '',
    ].join('\n'),
  )
  assert.equal(readEnv(dir, 'VAST_GPU'), 'RTX 4090')
  assert.equal(readEnv(dir, 'INSTITUTION'), INSTITUTION)
  assert.equal(readEnv(dir, 'PORT'), '3001')
  assert.equal(readEnv(dir, 'QUOTED'), 'two words')
  assert.equal(readEnv(dir, 'APOS'), "it's")
  assert.equal(readEnv(dir, 'MISSING'), '')
})

test('read_env: возврат каретки из Windows не уезжает внутрь значения', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, '.env'), 'RELAY_ADDR=1.2.3.4\r\nPORT=3000\r\n')
  assert.equal(readEnv(dir, 'RELAY_ADDR'), '1.2.3.4')
})

test('read_env берёт последнюю строку: дописанное в конец главнее', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, '.env'), 'KERNEL_ENV=base\nKERNEL_ENV=gpu\n')
  assert.equal(readEnv(dir, 'KERNEL_ENV'), 'gpu')
})

test('копия read_env осталась одна — в scripts/lib.sh', () => {
  const others = ['scripts/host.sh', 'scripts/service.sh', 'scripts/vast.sh', 'scripts/restore.sh', 'scripts/dns.sh']
  for (const file of others) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8')
    assert.ok(
      !/^\s*read_env\(\)/m.test(text),
      `${file} завёл свою копию read_env — правка в одной из них разъедется с остальными`,
    )
    assert.ok(/lib\.sh/.test(text), `${file} должен сорсить scripts/lib.sh`)
  }
})

test('dns.sh спрашивает адрес ретранслятора у .env и без него зону не трогает', () => {
  const dir = tmpdir()
  fs.mkdirSync(path.join(dir, 'scripts'))
  for (const f of ['dns.sh', 'lib.sh']) {
    fs.copyFileSync(path.join(repo, 'scripts', f), path.join(dir, 'scripts', f))
  }
  fs.chmodSync(path.join(dir, 'scripts/dns.sh'), 0o755)
  // Токен есть, адреса ретранслятора нет: до сети дело дойти не должно.
  fs.writeFileSync(path.join(dir, '.env'), 'CF_TOKEN=not-a-real-token\nCF_ZONE=zzz\n')
  // Переменная оболочки сильнее файла — у того, кто гоняет тесты, она может
  // быть выставлена, и тогда проверялся бы не файл.
  const env = { ...process.env }
  delete env.RELAY_ADDR
  const r = spawnSync('bash', [path.join(dir, 'scripts/dns.sh')], {
    encoding: 'utf8',
    timeout: 20_000,
    env,
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /RELAY_ADDR/)

  // И прибитого адреса в скрипте больше нет — именно он молча возвращал
  // `*.colloq.ru` на прежнюю машину после переезда ретранслятора.
  const text = fs.readFileSync(path.join(repo, 'scripts/dns.sh'), 'utf8')
  assert.ok(
    !/RELAY=\$\{RELAY_ADDR:-[0-9]/.test(text),
    'умолчание-адрес вернулось в dns.sh',
  )
})

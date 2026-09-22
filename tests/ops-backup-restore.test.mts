/**
 * Дорога назад: `make backup` → `scripts/restore.sh`.
 *
 * Единственный путь, по которому семестр возвращается на новую машину, и до
 * сих пор он проверялся только на живой машине — то есть ровно там, где цена
 * ошибки максимальна. Здесь он гоняется целиком во временном каталоге:
 * рецепт `backup` берётся из настоящего Makefile, разворачивает настоящий
 * scripts/restore.sh.
 *
 * Что закрепляется:
 *
 *  - в копию едут списки пакетов (их заводят из панели прямо на машине, и
 *    больше их взять неоткуда), файлы семинаров и оба ключа;
 *  - журнал WAL уезжает вместе с той базой, которую он описывает, а не
 *    остаётся рядом с новой: иначе sqlite накатит на неё чужие страницы;
 *  - разворачивание поверх непустой машины требует явного REPLACE=1. Это
 *    защита от того самого случая, когда «пустой» машину объявлял молчащий
 *    /api/health: остановленная служба — не пустая машина, и повторный
 *    vast-up откатывал занятие на вчерашнюю копию;
 *  - права 0600 на ключе подписи переживают распаковку.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Порт, на котором заведомо никого нет: restore.sh спрашивает про живой сервер. */
const DEAD_PORT = 39997

interface Machine {
  dir: string
  /** Прогнать рецепт из настоящего Makefile. */
  make(target: string): string
  /** Прогнать настоящий restore.sh. Возвращает код и оба потока. */
  restore(args: string[], env?: Record<string, string>): { status: number | null; out: string }
}

/**
 * Машина в миниатюре: настоящие Makefile и scripts/, свои data/ и workspace/.
 *
 * Скрипт делает `cd "$(dirname "$0")/.."`, поэтому копия в <tmp>/scripts/
 * работает во временном каталоге и до настоящих data/ и workspace/ не
 * дотягивается — один такой прогон однажды съел бы рабочий инстанс.
 */
/** Машины этого файла — и уборка за ними: каждая несёт свои data/ и workspace/. */
const built: string[] = []
after(() => {
  for (const dir of built.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function machine(): Machine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-restore-'))
  built.push(dir)
  fs.mkdirSync(path.join(dir, 'scripts'))
  // backup-local.sh — тот самый рецепт копии: он уехал из Makefile в scripts/,
  // потому что в колесо pip едут скрипты, а Makefile нет. Цель backup-legacy
  // теперь обёртка над ним, и без файла машина в миниатюре снимать копию
  // нечем.
  for (const f of ['backup-local.sh', 'restore.sh', 'lib.sh']) {
    fs.copyFileSync(path.join(repo, 'scripts', f), path.join(dir, 'scripts', f))
  }
  fs.copyFileSync(path.join(repo, 'Makefile'), path.join(dir, 'Makefile'))
  fs.writeFileSync(path.join(dir, '.env'), `PORT=${DEAD_PORT}\nKERNEL_ENV=base\n`)

  fs.mkdirSync(path.join(dir, 'data'))
  fs.mkdirSync(path.join(dir, 'workspace/s-one'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'kernel/environments'), { recursive: true })
  return {
    dir,
    make: (target) =>
      execFileSync('make', ['--no-print-directory', '-C', dir, target === 'backup' ? 'backup-legacy' : target], {
        encoding: 'utf8',
        env: { ...process.env, COLLOQ_HOME: '', ENV_FILE: path.join(dir, '.env') },
      }),
    restore: (args, env = {}) => {
      const r = spawnSync('bash', [path.join(dir, 'scripts/restore.sh'), ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, COLLOQ_HOME: '', ENV_FILE: path.join(dir, '.env'), ...env },
      })
      return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    },
  }
}

/** База с одной таблицей и незакрытым журналом WAL — как на живой машине. */
function seedDb(dir: string, mark: string): void {
  execFileSync('sqlite3', [
    path.join(dir, 'data/colloq.db'),
    'pragma journal_mode=wal;',
    'create table if not exists seminars (id text primary key, name text);',
    `insert into seminars values ('s-one', '${mark}');`,
  ])
}

/** Что записано в базе — по нему видно, какая именно уцелела. */
function markOf(file: string): string {
  return execFileSync('sqlite3', [file, 'select name from seminars']).toString().trim()
}

const wheelBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x0a])
const wheelHash = createHash('sha256').update(wheelBytes).digest('hex')
const lockText = `demo==1.0 --hash=sha256:${wheelHash}\n`
const bundlePath = 'data/dependencies/bundles/bundle-one'

function seedFiles(dir: string): void {
  fs.writeFileSync(path.join(dir, 'workspace/s-one/notes.csv'), 'a,b\n1,2\n')
  fs.writeFileSync(path.join(dir, 'data/session-secret'), 'signing-key\n', { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'data/setup-token'), 'setup\n', { mode: 0o600 })
  // Competition inputs and immutable bundle files live outside workspace/.
  for (const folder of ['data/competitions/c-one/open', 'data/competitions/c-one/secret', `${bundlePath}/wheels`, 'data/dependencies/artifacts']) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true, mode: 0o700 })
  }
  fs.writeFileSync(path.join(dir, 'data/competitions/c-one/open/train.csv'), 'feature\n42\n')
  fs.writeFileSync(path.join(dir, 'data/competitions/c-one/secret/solution.csv'), 'target\n1\n', { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'data/dependencies/artifacts', wheelHash), wheelBytes, { mode: 0o444 })
  fs.linkSync(path.join(dir, 'data/dependencies/artifacts', wheelHash), path.join(dir, bundlePath, 'wheels/demo-1.0-py3-none-any.whl'))
  fs.writeFileSync(path.join(dir, bundlePath, 'requirements.lock'), lockText, { mode: 0o444 })
  fs.writeFileSync(path.join(dir, bundlePath, 'manifest.json'), JSON.stringify({ packages: [{ sha256: wheelHash }] }), { mode: 0o444 })
  // Список пакетов, заведённый на этой машине из панели: в репозитории его нет.
  fs.writeFileSync(path.join(dir, 'kernel/environments/nlp.txt'), '# из панели\nspacy\n')
}

/** Пара «база + архив» из backups/, как её оставляет `make backup`. */
function backupPair(dir: string): { db: string; files: string } {
  const names = fs.readdirSync(path.join(dir, 'backups'))
  const db = names.find((n) => n.endsWith('.db'))
  const files = names.find((n) => n.endsWith('-files.tar.gz'))
  assert.ok(db, 'копия базы не появилась')
  assert.ok(files, 'архив файлов не появился')
  return { db: `backups/${db}`, files: `backups/${files}` }
}

test('make backup сохраняет файлы занятий и соревнований, ключи и готовые wheel-наборы', () => {
  const m = machine()
  seedDb(m.dir, 'первая пара')
  seedFiles(m.dir)

  m.make('backup')
  const { files } = backupPair(m.dir)

  const listed = execFileSync('tar', ['-tzf', path.join(m.dir, files)], { encoding: 'utf8' })
  assert.match(listed, /workspace\/s-one\/notes\.csv/)
  assert.match(listed, /data\/session-secret/)
  assert.match(listed, /data\/setup-token/)
  assert.match(listed, /data\/competitions\/c-one\/secret\/solution\.csv/)
  assert.ok(listed.includes(`data/dependencies/artifacts/${wheelHash}`))
  assert.ok(listed.includes(`${bundlePath}/requirements.lock`))
  assert.ok(listed.includes(`${bundlePath}/manifest.json`))
  assert.ok(listed.includes(`${bundlePath}/wheels/demo-1.0-py3-none-any.whl`))
  // Ради этой строки правка и делалась: окружение, заведённое из панели на
  // арендованной машине, живёт только в этом файле.
  assert.match(listed, /kernel\/environments\/nlp\.txt/)

  // Копия базы такая же секретная, как сама база.
  const { db } = backupPair(m.dir)
  assert.equal(fs.statSync(path.join(m.dir, db)).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(m.dir, files)).mode & 0o777, 0o600)
})

test('на пустой машине копия разворачивается целиком, ключ подписи остаётся 0600', () => {
  const m = machine()
  seedDb(m.dir, 'первая пара')
  seedFiles(m.dir)
  m.make('backup')
  const pair = backupPair(m.dir)

  // Пустая машина: базы нет, файлов нет, списков нет.
  fs.rmSync(path.join(m.dir, 'data/colloq.db'))
  fs.rmSync(path.join(m.dir, 'data/session-secret'))
  fs.rmSync(path.join(m.dir, 'workspace/s-one'), { recursive: true })
  fs.rmSync(path.join(m.dir, 'kernel/environments/nlp.txt'))
  fs.rmSync(path.join(m.dir, 'data/competitions'), { recursive: true })
  fs.rmSync(path.join(m.dir, 'data/dependencies'), { recursive: true })

  const r = m.restore([pair.db, pair.files])
  assert.equal(r.status, 0, r.out)

  assert.equal(markOf(path.join(m.dir, 'data/colloq.db')), 'первая пара')
  assert.equal(fs.readFileSync(path.join(m.dir, 'data/competitions/c-one/open/train.csv'), 'utf8'), 'feature\n42\n')
  assert.equal(fs.readFileSync(path.join(m.dir, 'data/competitions/c-one/secret/solution.csv'), 'utf8'), 'target\n1\n')
  assert.equal(fs.statSync(path.join(m.dir, 'data/competitions/c-one/secret/solution.csv')).mode & 0o777, 0o600)
  assert.deepEqual(fs.readFileSync(path.join(m.dir, 'data/dependencies/artifacts', wheelHash)), wheelBytes)
  assert.deepEqual(fs.readFileSync(path.join(m.dir, bundlePath, 'wheels/demo-1.0-py3-none-any.whl')), wheelBytes)
  assert.equal(fs.readFileSync(path.join(m.dir, bundlePath, 'requirements.lock'), 'utf8'), lockText)
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.dir, bundlePath, 'manifest.json'), 'utf8')).packages[0].sha256, wheelHash)
  assert.equal(fs.statSync(path.join(m.dir, bundlePath, 'requirements.lock')).mode & 0o777, 0o444)
  assert.equal(fs.readFileSync(path.join(m.dir, 'workspace/s-one/notes.csv'), 'utf8'), 'a,b\n1,2\n')
  assert.equal(fs.readFileSync(path.join(m.dir, 'kernel/environments/nlp.txt'), 'utf8'), '# из панели\nspacy\n')
  assert.equal(fs.statSync(path.join(m.dir, 'data/session-secret')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(m.dir, 'data/colloq.db')).mode & 0o777, 0o600)
})

test('поверх непустой машины и без терминала — отказ, а не молчаливая подмена', () => {
  const m = machine()
  seedDb(m.dir, 'вчерашняя копия')
  seedFiles(m.dir)
  m.make('backup')
  const pair = backupPair(m.dir)

  // На машине с тех пор прошло занятие.
  execFileSync('sqlite3', [path.join(m.dir, 'data/colloq.db'), "update seminars set name='сегодняшняя пара'"])
  fs.writeFileSync(path.join(m.dir, 'workspace/s-one/notes.csv'), 'сегодняшнее\n')

  const r = m.restore([pair.db, pair.files])
  assert.notEqual(r.status, 0, 'разворачивание поверх занятия должно требовать слова')
  assert.match(r.out, /REPLACE=1/)
  // И ничего не тронуто: ни база, ни файлы, ни отложенных копий рядом.
  assert.equal(markOf(path.join(m.dir, 'data/colloq.db')), 'сегодняшняя пара')
  assert.equal(fs.readFileSync(path.join(m.dir, 'workspace/s-one/notes.csv'), 'utf8'), 'сегодняшнее\n')
  assert.equal(
    fs.readdirSync(path.join(m.dir, 'data')).filter((n) => n.includes('replaced')).length,
    0,
  )
})

test('REPLACE=1 разворачивает поверх и уносит прежний журнал вместе с прежней базой', () => {
  const m = machine()
  seedDb(m.dir, 'вчерашняя копия')
  seedFiles(m.dir)
  m.make('backup')
  const pair = backupPair(m.dir)

  execFileSync('sqlite3', [path.join(m.dir, 'data/colloq.db'), "update seminars set name='сегодняшняя пара'"])
  // Журнал рядом с базой — то, ради чего скрипт вообще существует.
  fs.writeFileSync(path.join(m.dir, 'data/colloq.db-wal'), 'страницы прежней базы')
  fs.writeFileSync(path.join(m.dir, 'data/colloq.db-shm'), 'общая память')

  const r = m.restore([pair.db, pair.files], { REPLACE: '1' })
  assert.equal(r.status, 0, r.out)

  assert.equal(markOf(path.join(m.dir, 'data/colloq.db')), 'вчерашняя копия')
  const left = fs.readdirSync(path.join(m.dir, 'data'))
  assert.ok(
    !left.includes('colloq.db-wal') && !left.includes('colloq.db-shm'),
    `чужой журнал остался рядом с новой базой: ${left.join(', ')}`,
  )
  const replaced = left.filter((n) => n.startsWith('colloq.db.replaced-'))
  assert.equal(replaced.length, 3, `прежние база и журнал отложены целиком: ${replaced.join(', ')}`)
  assert.equal(
    markOf(path.join(m.dir, 'data', replaced.find((n) => !n.endsWith('-wal') && !n.endsWith('-shm'))!)),
    'сегодняшняя пара',
  )
})

test('файл, который не база sqlite, не разворачивается вовсе', () => {
  const m = machine()
  seedDb(m.dir, 'первая пара')
  seedFiles(m.dir)
  fs.mkdirSync(path.join(m.dir, 'backups'), { recursive: true })
  fs.writeFileSync(path.join(m.dir, 'backups/colloq-20260101-000000.db'), '<html>не докачалось</html>')
  fs.rmSync(path.join(m.dir, 'data/colloq.db'))

  const r = m.restore(['backups/colloq-20260101-000000.db'])
  assert.notEqual(r.status, 0)
  assert.match(r.out, /sqlite/i)
  assert.ok(!fs.existsSync(path.join(m.dir, 'data/colloq.db')), 'битую копию на место не кладут')
})

test('SQLite quick_check output must be ok even when sqlite3 exits successfully', () => {
  const m = machine(); seedDb(m.dir, 'keep')
  fs.mkdirSync(path.join(m.dir, 'backups'))
  fs.renameSync(path.join(m.dir, 'data/colloq.db'), path.join(m.dir, 'backups/check.db'))
  fs.mkdirSync(path.join(m.dir, 'bin'))
  fs.writeFileSync(path.join(m.dir, 'bin/sqlite3'), '#!/bin/sh\necho "database integrity error"\nexit 0\n', { mode: 0o755 })
  const r = m.restore(['backups/check.db'], { PATH: path.join(m.dir, 'bin') + ':' + process.env.PATH })
  assert.notEqual(r.status, 0, r.out)
  assert.ok(!fs.existsSync(path.join(m.dir, 'data/colloq.db')), 'non-ok database must not be installed')
})

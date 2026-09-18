/**
 * Зеркало статики на ретрансляторе: что оно принимает и во что это кладёт.
 *
 * Сервис (scripts/relay-assets.py) стоит между общим секретом ретранслятора и
 * каталогом, из которого caddy отдаёт файлы ВСЕМ студентам любого семинара.
 * Значит проверять надо не «работает ли», а ровно четыре обещания, каждое из
 * которых нарушается молча:
 *
 *   без секрета не пишет; чужое имя не переписывает; путь из архива не
 *   выводит наружу каталога; подмена набора — целиком, а куски прежней сборки
 *   живут ещё месяц, иначе вкладка, открытая до выкладки, теряет свои чанки
 *   посреди пары.
 *
 * Проверяется настоящий сервис на своём порту с временным каталогом: правила
 * живут в нём, а не в копии на TypeScript. Архивы собираются python'ом —
 * злонамеренный tar (символьная ссылка, путь наружу) иначе и не сделать.
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0
const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/relay-assets.py')
const TOKEN = 'seminar-relay-secret-0123456789'
const HOST = 'hse.colloq.ru'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

let service: ChildProcess | null = null
let base = ''
let root = ''
let env: NodeJS.ProcessEnv = {}

/** tar.gz с произвольными членами — в том числе теми, которых не бывает у сборки. */
function tarball(entries: Array<{ name: string; data?: string; link?: string; dir?: boolean }>): Buffer {
  const made = spawnSync('python3', ['-c', `
import io, json, sys, tarfile
entries = json.loads(sys.argv[1])
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
    for entry in entries:
        info = tarfile.TarInfo(entry["name"])
        if entry.get("dir"):
            info.type = tarfile.DIRTYPE
            tar.addfile(info)
        elif entry.get("link") is not None:
            info.type = tarfile.SYMTYPE
            info.linkname = entry["link"]
            tar.addfile(info)
        else:
            payload = entry.get("data", "").encode()
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
sys.stdout.buffer.write(buffer.getvalue())
`, JSON.stringify(entries)], { maxBuffer: 1 << 28 })
  assert.equal(made.status, 0, made.stderr?.toString())
  return made.stdout
}

/** Так же, как это делает caddy: имя в пути и имя, по которому пришли, — одно. */
async function put(
  body: Buffer,
  { host = HOST, target = host, token = TOKEN }: { host?: string; target?: string; token?: string } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${base}/.relay/assets/${target}`, {
    method: 'PUT',
    headers: {
      'X-Forwarded-Host': host,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/gzip',
    },
    body,
  })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

const mirror = (...parts: string[]) => path.join(root, HOST, ...parts)
const read = (...parts: string[]) => fs.readFileSync(mirror(...parts), 'utf8')
const there = (...parts: string[]) => fs.existsSync(mirror(...parts))

/** Сборка: хэшированный чанк со сжатыми соседями, шрифт и воркер pdf. */
const build = (chunk: string, extra: Array<{ name: string; data?: string }> = []) =>
  tarball([
    { name: 'assets', dir: true },
    { name: `assets/${chunk}`, data: `export const answer = ${JSON.stringify(chunk)}\n` },
    { name: `assets/${chunk}.br`, data: 'сжатое braille' },
    { name: `assets/${chunk}.gz`, data: 'сжатое gzip' },
    { name: 'fonts/hse-sans-400.woff2', data: 'шрифт' },
    { name: 'pdf/pdf.worker.min.mjs', data: 'воркер' },
    ...extra,
  ])

async function up(): Promise<void> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-mirror-'))
  const tokenFile = path.join(root, 'token')
  fs.writeFileSync(tokenFile, `${TOKEN}\n`)
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  env = {
    ...process.env,
    ASSETS_ROOT: path.join(root, 'store'),
    ASSETS_PORT: String(port),
    ASSETS_DOMAIN: 'colloq.ru',
    ASSETS_TOKEN_FILE: tokenFile,
    ASSETS_MAX_BYTES: '65536',
  }
  service = spawn('python3', [SCRIPT], { env, stdio: 'ignore' })
  root = path.join(root, 'store')
  for (let i = 0; i < 100; i += 1) {
    try {
      const probe = await fetch(`${base}/.relay/assets/${HOST}`, {
        headers: { 'X-Forwarded-Host': HOST, authorization: `Bearer ${TOKEN}` },
      })
      if (probe.status === 404) return
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('зеркало не поднялось')
}

function down(): void {
  service?.kill('SIGKILL')
  if (root) fs.rmSync(path.dirname(root), { recursive: true, force: true })
}

const suite = test.suite ?? test.describe

suite('зеркало статики ретранслятора', { skip: HAVE_PYTHON ? false : 'нет python3' }, () => {
  test.before(up)
  test.after(down)

  test('без секрета и с чужим секретом не пишется ничего', async () => {
    for (const token of ['', 'not-the-secret', `${TOKEN} `.repeat(2)]) {
      const { status, body } = await put(build('app-aaaa1111.js'), { token })
      assert.equal(status, 401, `секрет ${JSON.stringify(token)} приняли`)
      assert.equal(body.error, 'token')
    }
    assert.equal(fs.existsSync(path.join(root, HOST)), false)
  })

  test('своё зеркало и только своё: имя в пути — то, по которому пришли', async () => {
    const other = await put(build('app-aaaa1111.js'), { host: HOST, target: 'other.colloq.ru' })
    assert.equal(other.status, 403, 'один семинар переписал зеркало другого')
    const alien = await put(build('app-aaaa1111.js'), { host: 'hse.example.com', target: 'hse.example.com' })
    assert.equal(alien.status, 400)
    assert.equal(alien.body.error, 'host')
  })

  test('выкладка кладёт три каталога и переключает набор целиком', async () => {
    const { status, body } = await put(build('app-aaaa1111.js'))
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.files, 5)
    assert.equal(body.kept, 0)
    // Имя — символьная ссылка на набор: подмена это переименование, а не
    // копирование поверх живого каталога.
    assert.ok(fs.lstatSync(path.join(root, HOST)).isSymbolicLink())
    /*
     * Читает набор не этот сервис, а caddy — от другого пользователя и по
     * группе. mkdtemp делает каталог 0700, и без явного chmod зеркало вставало
     * бы молча и целиком: файлы на месте, у всех 403, и в журнале ни строки.
     */
    for (const where of [mirror(), mirror('assets'), mirror('assets', 'app-aaaa1111.js')]) {
      const info = fs.statSync(where)
      // В каталог надо ещё и зайти, файл — только прочитать.
      const need = info.isDirectory() ? 0o050 : 0o040
      assert.equal(
        info.mode & need, need,
        `${where} не прочитать группе: ${(info.mode & 0o777).toString(8)}`,
      )
    }
    assert.match(read('assets', 'app-aaaa1111.js'), /app-aaaa1111/)
    assert.equal(read('assets', 'app-aaaa1111.js.br'), 'сжатое braille')
    assert.equal(read('fonts', 'hse-sans-400.woff2'), 'шрифт')
    assert.equal(read('pdf', 'pdf.worker.min.mjs'), 'воркер')
  })

  test('состояние зеркала можно спросить', async () => {
    const response = await fetch(`${base}/.relay/assets/${HOST}`, {
      headers: { 'X-Forwarded-Host': HOST, authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(response.status, 200)
    const said = (await response.json()) as { files: number; bytes: number; updated: number }
    assert.equal(said.files, 5)
    assert.ok(said.bytes > 0 && said.updated > 0)
    const closed = await fetch(`${base}/.relay/assets/${HOST}`, { headers: { 'X-Forwarded-Host': HOST } })
    assert.equal(closed.status, 401)
  })

  test('путь наружу каталога не выводит ни в каком виде', async () => {
    const было = read('assets', 'app-aaaa1111.js')
    for (const name of [
      '../evil.js',
      'assets/../../evil.js',
      '/etc/passwd',
      'assets/sub/../../../evil.js',
      'etc/passwd',
      'index.html',
      'assets/./../evil.js',
    ]) {
      const { status } = await put(tarball([{ name, data: 'зло' }]))
      assert.equal(status, 400, `приняли ${name}`)
    }
    assert.equal(fs.existsSync(path.join(root, '..', 'evil.js')), false)
    assert.equal(fs.existsSync(path.join(root, 'evil.js')), false)
    // И живое зеркало от таких попыток не пострадало.
    assert.equal(read('assets', 'app-aaaa1111.js'), было)
  })

  test('символьная ссылка в архиве — отказ, а не чужой файл под видом чанка', async () => {
    const { status, body } = await put(tarball([
      { name: 'assets/app-bbbb2222.js', data: 'настоящий' },
      { name: 'assets/secret.js', link: '/etc/passwd' },
    ]))
    assert.equal(status, 400)
    assert.equal(body.error, 'kind')
    assert.equal(there('assets', 'secret.js'), false)
    assert.equal(there('assets', 'app-bbbb2222.js'), false, 'полуразобранный архив доехал до зеркала')
  })

  test('архив больше потолка не распаковывается', async () => {
    const { status, body } = await put(tarball([
      { name: 'assets/huge-cccc3333.js', data: 'x'.repeat(70_000) },
    ]))
    assert.equal(status, 413)
    assert.ok(['bytes', 'files'].includes(body.error), body.error)
    assert.equal(there('assets', 'huge-cccc3333.js'), false)
  })

  test('куски прежней сборки живут ещё месяц, а шрифты заменяются', async () => {
    // Вкладка, открытая до выкладки, догружает свой чанк по старому хэшу.
    const { status, body } = await put(build('app-dddd4444.js'))
    assert.equal(status, 200)
    assert.equal(body.kept, 3, 'прежние чанки не перенесены')
    assert.ok(there('assets', 'app-aaaa1111.js'), 'старый чанк пропал в день выкладки')
    assert.ok(there('assets', 'app-dddd4444.js'))
    // Не-версионное переезжает как есть: имя то же, содержимое новое.
    assert.equal(read('fonts', 'hse-sans-400.woff2'), 'шрифт')
    assert.equal(fs.readdirSync(path.join(root, 'sets', HOST)).length, 1, 'прежние наборы не убраны')
  })

  test('кусок старше срока в новую сборку не переезжает', async () => {
    const месяц = Date.now() / 1000 - 31 * 86400
    for (const name of ['app-aaaa1111.js', 'app-aaaa1111.js.br', 'app-aaaa1111.js.gz']) {
      fs.utimesSync(mirror('assets', name), месяц, месяц)
    }
    const { body } = await put(build('app-eeee5555.js'))
    assert.equal(there('assets', 'app-aaaa1111.js'), false, 'месячный кусок остался навсегда')
    assert.ok(there('assets', 'app-dddd4444.js'), 'свежий кусок унесли вместе со старым')
    assert.equal(body.kept, 3)
  })

  test('скрытое с ноутбука пропускается, а сборка выкладывается', async () => {
    const { status, body } = await put(build('app-ffff6666.js', [
      { name: 'assets/.DS_Store', data: 'мусор macOS' },
    ]))
    assert.equal(status, 200, 'из-за .DS_Store не выложилась вся сборка')
    assert.equal(body.skipped, 1)
    assert.equal(there('assets', '.DS_Store'), false)
  })

  test('архив, который собирает make host, зеркало принимает как есть', async () => {
    /*
     * Обе половины одного дела стоят в разных файлах и на разных языках:
     * архив собирает bash (scripts/host.sh · assets_tar), разбирает python.
     * Разойтись им проще всего молча — «выложилось 0 файлов» никто не читает.
     * Поэтому берётся ТА САМАЯ функция из скрипта, а не её пересказ.
     */
    const script = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'scripts/host.sh'), 'utf8')
    const dirs = /^DIST_DIRS=.*$/m.exec(script)
    const made = /^assets_tar\(\) \{$[\s\S]*?^\}$/m.exec(script)
    assert.ok(dirs && made, 'assets_tar больше не найти в scripts/host.sh')
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-dist-'))
    for (const dir of ['assets', 'fonts', 'pdf']) {
      fs.mkdirSync(path.join(fake, 'web/dist', dir), { recursive: true })
    }
    fs.writeFileSync(path.join(fake, 'web/dist/assets/app-9999zzzz.js'), 'export default 1\n')
    fs.writeFileSync(path.join(fake, 'web/dist/assets/app-9999zzzz.js.br'), 'сжато')
    fs.writeFileSync(path.join(fake, 'web/dist/fonts/hse-sans-400.woff2'), 'шрифт')
    fs.writeFileSync(path.join(fake, 'web/dist/pdf/pdf.worker.min.mjs'), 'воркер')
    // То, что кладёт рядом macOS и не должно уехать на ретранслятор.
    fs.writeFileSync(path.join(fake, 'web/dist/assets/.DS_Store'), 'мусор')
    fs.writeFileSync(path.join(fake, 'web/dist/index.html'), '<!doctype html>')
    const archive = path.join(fake, 'dist.tgz')
    const built = spawnSync('bash', ['-c', `set -euo pipefail\n${dirs[0]}\n${made[0]}\nassets_tar "$1"`, 'sh', archive], {
      cwd: fake, encoding: 'utf8',
    })
    assert.equal(built.status, 0, built.stderr)
    const { status, body } = await put(fs.readFileSync(archive))
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.files, 4, 'в архив уехало не то, что зеркалится')
    assert.equal(body.skipped, 0, 'скрытое всё-таки попало в архив')
    assert.ok(there('assets', 'app-9999zzzz.js.br'))
    assert.equal(read('fonts', 'hse-sans-400.woff2'), 'шрифт')
    // Страница — живая, её отдаёт инстанс, и в зеркале ей делать нечего.
    assert.equal(there('index.html'), false)
    fs.rmSync(fake, { recursive: true, force: true })
  })

  test('уборка убирает брошенное имя и обрывки распаковки', async () => {
    const leftover = path.join(root, '.tmp', 'hse.colloq.ru-оборванная')
    fs.mkdirSync(leftover, { recursive: true })
    const давно = Date.now() / 1000 - 3 * 86400
    fs.utimesSync(leftover, давно, давно)
    let pruned = spawnSync('python3', [SCRIPT, '--prune'], { env, encoding: 'utf8' })
    assert.equal(pruned.status, 0, pruned.stderr)
    assert.equal(fs.existsSync(leftover), false)
    assert.ok(there('assets', 'app-ffff6666.js'), 'уборка снесла живое зеркало')

    // Имя, которое перестали выставлять наружу: ссылка не обновлялась два срока.
    const stale = Date.now() / 1000 - 61 * 86400
    fs.lutimesSync(path.join(root, HOST), stale, stale)
    pruned = spawnSync('python3', [SCRIPT, '--prune'], { env, encoding: 'utf8' })
    assert.equal(pruned.status, 0, pruned.stderr)
    assert.equal(fs.existsSync(path.join(root, 'sets', HOST)), false)
    assert.equal(fs.existsSync(path.join(root, HOST)), false)
  })
})

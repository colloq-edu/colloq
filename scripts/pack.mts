/**
 * Дистрибутив Colloq — то, что уезжает в колесо pip.
 *
 *   npx tsx scripts/pack.mts          собрать заново и положить в python/colloq/_app
 *   npx tsx scripts/pack.mts --skip-build   упаковать то, что уже собрано
 *   make pack · make wheel
 *
 * Зачем это вообще. На машине преподавателя нет ни репозитория, ни make, ни
 * tsx: `pip install colloq` и `colloq`. Значит, всё, что сегодня считается от
 * исходников — сборка фронтенда, отпечаток дерева, вызовы npm run, — должно
 * быть посчитано ЗДЕСЬ, один раз, и приехать готовым. Признак «приехало
 * готовым» — файл .colloq-dist.json в корне приложения: увидев его, запуск не
 * собирает ничего и npm не зовёт вовсе.
 *
 * Раскладка внутри app/ повторяет репозиторий, и это не украшение. Три места
 * в коде ищут свои файлы относительно себя, и все три работают только при
 * такой раскладке:
 *
 *   · server/src/config.ts:26 — repoRoot это `../..` от собранного
 *     server/dist/server.js, то есть корень приложения. Положи сервер в
 *     app/server.js — и data/ с workspace/ уедут этажом выше;
 *   · server/src/environments.ts:23 — ищет kernel/environments, шагая вверх от
 *     себя. Поэтому kernel/ лежит рядом с server/, а не где попало;
 *   · cli/src/launch-config.ts:104 — STATIC_DIR это <корень>/web/dist.
 *
 * Скрипты эксплуатации (scripts/) едут вместе со всем остальным, и это не
 * «на всякий случай». `colloq host <имя>` — единственная команда, которой класс
 * получает ссылку, — это `make host`, а тот зовёт scripts/host.sh. Пока их в
 * пакете не было, у поставленного colloq публикация умирала: make нет, скрипта
 * нет, `colloq start --host` отваливался кодом 127, в расписку ложилось
 * hosting: 'failed', а человек читал «локальная работа продолжается» и шёл на
 * пару с занятием, которого снаружи не видно. Едет ровно то, что зовут:
 * host.sh с тем, что он сорсит и запускает, и пара backup/restore со своими
 * помощниками — список и причины у SCRIPTS ниже.
 *
 * Чего в колесе НЕТ намеренно: node_modules. Две зависимости сервера нативные
 * (better-sqlite3 и @resvg/resvg-js), и колесо с ними стало бы платформенным —
 * своё на macOS arm64, своё на Linux x86_64, своё на каждую версию Node ABI.
 * Вместо этого рядом с приложением лежит package.json с production-зависимостями
 * сервера, и `colloq` ставит их сам при первом запуске (python/colloq/__main__.py).
 *
 * node_modules нет и у самого CLI: бандлы собраны с --packages=external, и
 * единственное, что им нужно снаружи, — dotenv, а он и так в зависимостях
 * сервера. Проверять это глазами не надо: сборка сама сверяет список внешних
 * имён с тем, что встанет по package.json, и падает, если кто-то добавил в CLI
 * новую библиотеку.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { build, type Metafile } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'skip-build': { type: 'boolean', default: false },
    'no-python': { type: 'boolean', default: false },
    date: { type: 'string' },
  },
})

const outDir = path.resolve(root, values.out ?? 'dist-pkg')
const appDir = path.join(outDir, 'app')
const pythonApp = path.join(root, 'python/colloq/_app')

/**
 * Дата сборки приходит снаружи, а не из Date.now().
 *
 * Штамп лежит в файле, который попадает в колесо, — значит, два прогона подряд
 * давали бы два разных колеса при одинаковых исходниках. Кто собирает
 * воспроизводимо, передаёт SOURCE_DATE_EPOCH (так это называется везде — от
 * Debian до pypa) или --date; кто собирает для себя, получает текущее время, и
 * это ровно то, что он хочет видеть в `colloq --version`.
 */
const builtAt = values.date
  ? new Date(values.date).toISOString()
  : process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString()
if (Number.isNaN(Date.parse(builtAt))) throw new Error('Некорректная дата сборки: --date <ISO>')

type Json = Record<string, unknown>
function readJson(file: string): Json {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Json
}
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} — код ${result.status ?? 'сигнал'}`)
}

/**
 * Копия каталога — с двумя отсевами, и оба не косметические.
 *
 * .DS_Store на macOS заводится в каждом каталоге, который открывали в Finder, и
 * уезжал бы в колесо как часть дистрибутива.
 *
 * kernel/environments/.<имя>.built — это штамп «какой список пакетов запечён в
 * образ ядра на ЭТОЙ машине» (см. .gitignore). Состояние машины, а не исходник:
 * приехав к преподавателю, он рассказывал бы про образ, которого у того нет, и
 * запуск считал бы окружение готовым, не собрав ничего.
 */
const JUNK = new Set(['.DS_Store', '.vite'])
function junk(source: string): boolean {
  const name = path.basename(source)
  return JUNK.has(name) || name.endsWith('.built')
}
function copyInto(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, dereference: true, filter: (source) => !junk(source) })
}
function weigh(target: string): { files: number; bytes: number } {
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) return { files: 1, bytes: stat.size }
  let files = 0,
    bytes = 0
  for (const name of fs.readdirSync(target)) {
    const inner = weigh(path.join(target, name))
    files += inner.files
    bytes += inner.bytes
  }
  return { files, bytes }
}
function human(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' МБ'
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' КБ'
  return bytes + ' Б'
}

const rootPkg = readJson(path.join(root, 'package.json'))
const serverPkg = readJson(path.join(root, 'server/package.json'))
const version = String(rootPkg.version ?? '0.0.0')
const dependencies = (serverPkg.dependencies ?? {}) as Record<string, string>

// ---------------------------------------------------------------- сборка

if (!values['skip-build']) {
  // Тот же конвейер, что зовёт сегодня colloq run: web/dist со сжатием и
  // server/dist. Разница в том, что здесь он проходит ОДИН раз — у себя, а не у
  // преподавателя на паре.
  run('npm', ['run', 'build:optimized'])
}
for (const required of ['web/dist/index.html', 'server/dist/server.js']) {
  if (!fs.existsSync(path.join(root, required)))
    throw new Error(
      `Нечего паковать: нет ${required}. Уберите --skip-build или соберите: npm run build:optimized`,
    )
}
if (values['skip-build'])
  console.log('— беру уже собранные web/dist и server/dist как есть (--skip-build)')

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(appDir, { recursive: true })
/*
 * dist-pkg игнорирует сам себя: в корневом .gitignore этого каталога нет, а
 * шесть мегабайт собранного фронтенда в `git status` — верный способ однажды
 * закоммитить их целиком.
 */
fs.writeFileSync(path.join(outDir, '.gitignore'), '*\n')

// ---------------------------------------------------------------- CLI

/**
 * Точка входа бандла.
 *
 * main.ts запускает себя сам, только если argv[1] кончается на cli/src/main.ts
 * или .js (main.ts:788) — бандл под именем colloq.mjs эту проверку не проходит
 * и молча выходит с нулём. Поэтому у дистрибутива своя точка входа, cli/src/bin.ts,
 * которая просто зовёт cli(). Пока её нет в дереве, собираем такую же на лету
 * из stdin: пакет от этого не зависит, а проверить упаковку можно уже сегодня.
 */
const binFile = path.join(root, 'cli/src/bin.ts')
const hasBin = fs.existsSync(binFile)
const external = new Set<string>()
function collectExternal(meta: Metafile | undefined): void {
  for (const input of Object.values(meta?.outputs ?? {})) {
    for (const item of input.imports ?? []) {
      if (item.external && !item.path.startsWith('node:')) external.add(item.path)
    }
  }
}

const cliBundle = await build({
  ...(hasBin
    ? { entryPoints: [binFile] }
    : {
        stdin: {
          contents:
            "import { cli } from './cli/src/main.js'\n" +
            'process.exitCode = await cli(process.argv.slice(2))\n',
          resolveDir: root,
          sourcefile: 'bin.ts',
          loader: 'ts' as const,
        },
      }),
  outfile: path.join(appDir, 'cli/colloq.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  metafile: true,
})
collectExternal(cliBundle.metafile)

/*
 * launch.ts собирается отдельно, потому что и живёт отдельно: CLI запускает его
 * как самостоятельный процесс (cli/src/commands/local.ts:147), и именно этот
 * процесс остаётся супервизором занятия — он держит расписку, pid-файл и ядра.
 * Одним бандлом их не склеить: у launch.ts свой main() на верхнем уровне.
 */
const launchBundle = await build({
  entryPoints: [path.join(root, 'cli/src/launch.ts')],
  outfile: path.join(appDir, 'cli/launch.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  metafile: true,
})
collectExternal(launchBundle.metafile)

/*
 * Расписка внешнего адреса — третий отдельный бандл, и ровно по той же
 * причине, что и launch.mjs: её запускают процессом, а не импортируют.
 * Запускает её scripts/host.sh, и до сих пор — командой
 * `node --import tsx scripts/public-url-lease.mts`. В дистрибутиве tsx нет
 * вовсе: у локальной сессии первый же вызов (discover) умирал на «Cannot find
 * package 'tsx'», и вместе с ним умирала публикация. Бандл ложится рядом с
 * launch.mjs, а host.sh сам выбирает: есть файл — голый node, нет — прежний
 * tsx рядом с репозиторием.
 */
const leaseBundle = await build({
  entryPoints: [path.join(root, 'scripts/public-url-lease.mts')],
  outfile: path.join(appDir, 'cli/public-url-lease.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  metafile: true,
})
collectExternal(leaseBundle.metafile)

/*
 * Внешние имена бандлов обязаны найтись в node_modules, которые встанут по
 * app/package.json. Сегодня там ровно dotenv; завтра кто-нибудь добавит в CLI
 * ещё одну библиотеку — и на машине преподавателя первый же запуск умрёт на
 * ERR_MODULE_NOT_FOUND, а не здесь. Пусть умирает здесь.
 */
const missing = [...external].filter((name) => {
  const owner = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
  return !(owner in dependencies)
})
if (missing.length)
  throw new Error(
    `CLI просит снаружи то, чего нет в зависимостях сервера: ${missing.join(', ')}. ` +
      'Добавьте их в server/package.json или уберите из CLI.',
  )

// ---------------------------------------------------------------- куски

copyInto(path.join(root, 'server/dist'), path.join(appDir, 'server/dist'))
copyInto(path.join(root, 'web/dist'), path.join(appDir, 'web/dist'))
// Ядро приезжает исходником, а не образом: образ Python собирается на месте, из
// этого Dockerfile и этих списков пакетов, и у каждого преподавателя он свой.
for (const item of ['Dockerfile', 'requirements.txt', 'environments']) {
  copyInto(path.join(root, 'kernel', item), path.join(appDir, 'kernel', item))
}
// Шрифты для карточек ссылок (satori + resvg). Их читает сервер, и без них
// превью комнаты молча выходит без текста.
if (fs.existsSync(path.join(root, 'server/assets')))
  copyInto(path.join(root, 'server/assets'), path.join(appDir, 'server/assets'))

/**
 * Скрипты эксплуатации — ровно те, которые зовут, и ровно те, которые зовут
 * они. Список составлен чтением, а не на глаз: каждая строка отвечает на
 * вопрос «кто его запускает».
 *
 * Лишнего здесь нет намеренно. vast.sh, relay-setup.sh, release.py и прочее
 * ставят и обслуживают ЧУЖИЕ машины — это работа мастерской, у неё есть
 * репозиторий. В колесо едет то, без чего не живёт машина преподавателя.
 */
const SCRIPTS: Record<string, string> = {
  // Единственная команда, которой класс получает ссылку: colloq host и
  // colloq start --host — это он.
  'host.sh': 'публикация занятия наружу',
  // Его сорсят host.sh, dns.sh и restore.sh: чтение .env и корень состояния.
  'lib.sh': 'общее чтение .env и каталог состояния',
  // Прямой режим пишет им A-запись; им же работают colloq dns sync/point.
  'dns.sh': 'записи в зоне Cloudflare',
  // host.sh отдаёт ему адрес на установке с k3s; из него же стоят и
  // останавливаются службы, которых ждут backup и restore.
  'cluster.sh': 'установка k3s: адрес, службы, состояние',
  // Пара к colloq backup/restore целиком: сами команды и их помощники.
  //
  // Локальная копия — единственная, что нужна преподавателю: переносимая
  // копия k3s есть чем снять только там, где стоит кластер. Рецепт жил в
  // Makefile, и `colloq backup` из колеса умирал на «make: command not
  // found»; теперь это скрипт, и он едет сюда.
  'backup-local.sh': 'копия занятия на этой машине: база и файлы',
  'backup.sh': 'переносимая копия',
  'restore.sh': 'разворачивание копии',
  'runtime-backup.py': 'формат архива: сборка, проверка, разворачивание',
  'state-lock.py': 'замок состояния: две копии разом не делаются',
}
for (const [name, why] of Object.entries(SCRIPTS)) {
  const from = path.join(root, 'scripts', name)
  // Переименованный или удалённый скрипт — это отказ сборки, а не колесо без
  // него: пропажу всё равно нашли бы, но на паре и кодом 127.
  if (!fs.existsSync(from)) throw new Error(`Нечего паковать: нет scripts/${name} — ${why}`)
  copyInto(from, path.join(appDir, 'scripts', name))
}

// ------------------------------------------------------- package.json рядом

/*
 * Три package.json, и каждый нужен.
 *
 * app/package.json — по нему `npm install --omit=dev` ставит node_modules
 * сервера. Зависимости берутся из server/package.json как есть.
 *
 * app/cli/package.json и app/server/package.json — про "type": "module".
 * Формально хватило бы верхнего (Node ищет ближайший package.json вверх по
 * дереву), но оба каталога — это чужой код в чужих руках: стоит кому-нибудь
 * скопировать app/server отдельно, и .js-файл без "type" читается как CommonJS,
 * а он ESM. Заодно в app/cli лежит version: `colloq --version` читает её
 * из cli/package.json относительно корня приложения (cli/src/main.ts:229).
 */
writeJson(path.join(appDir, 'package.json'), {
  name: 'colloq',
  version,
  private: true,
  type: 'module',
  description: 'Colloq — собранное приложение. Зависимости ставит colloq при первом запуске.',
  dependencies,
})
writeJson(path.join(appDir, 'cli/package.json'), { name: 'colloq', version, type: 'module' })
writeJson(path.join(appDir, 'server/package.json'), {
  name: '@colloq/server',
  version,
  private: true,
  type: 'module',
})

// ---------------------------------------------------------------- штамп

const parts = [
  'cli/colloq.mjs',
  'cli/launch.mjs',
  'cli/public-url-lease.mjs',
  'server/dist',
  'server/assets',
  'web/dist',
  'kernel',
  'scripts',
]
  .filter((item) => fs.existsSync(path.join(appDir, item)))
  .map((item) => ({ path: item, ...weigh(path.join(appDir, item)) }))

writeJson(path.join(appDir, '.colloq-dist.json'), {
  name: 'colloq',
  version,
  builtAt,
  builtBy: 'scripts/pack.mts',
  node: process.version,
  /* Куда смотреть тому, кто читает этот файл вместо того, чтобы гадать. */
  layout: {
    cli: 'cli/colloq.mjs',
    launch: 'cli/launch.mjs',
    lease: 'cli/public-url-lease.mjs',
    server: 'server/dist/server.js',
    web: 'web/dist',
    kernel: 'kernel',
    scripts: 'scripts',
  },
  /* node_modules ставятся на месте: см. шапку этого файла и python/colloq/__main__.py. */
  install: { manager: 'npm', args: ['install', '--omit=dev'], cwd: '.' },
  parts,
})

// ---------------------------------------------------------- бандл говорит

/*
 * Собранный CLI обязан ответить на --help — и это не формальность.
 *
 * main.ts запускает себя, только узнав своё имя в argv[1] (main.ts:788):
 * бандл под другим именем проходил эту проверку мимо и завершался кодом 0, не
 * напечатав ни строки. Молчание с нулём — худший из отказов: сборка зелёная,
 * колесо собрано, а команда «работает», ничего не делая. Поэтому бандл здесь
 * зовут по-настоящему и требуют слов.
 *
 * COLLOQ_HOME уводится во временный каталог: без него проверка завела бы у
 * сборщика настоящий ~/.colloq — состояние занятия там, где его не просили.
 */
const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-pack-'))
try {
  const probe = spawnSync(process.execPath, [path.join(appDir, 'cli/colloq.mjs'), '--help'], {
    cwd: appDir,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      COLLOQ_APP_DIR: appDir,
      COLLOQ_HOME: probeHome,
      COLLOQ_SURFACE: 'teacher',
      NO_COLOR: '1',
    },
  })
  if (probe.status !== 0 || !(probe.stdout ?? '').trim())
    throw new Error(
      'Собранный CLI не ответил на --help ' +
        `(код ${probe.status ?? 'сигнал'}). ${(probe.stderr ?? '').trim().slice(0, 400)}\n` +
        'Похоже, точка входа не зовёт cli(): см. cli/src/bin.ts и хвост cli/src/main.ts.',
    )
} finally {
  fs.rmSync(probeHome, { recursive: true, force: true })
}

// ---------------------------------------------------------------- в питон

if (!values['no-python']) {
  /*
   * Колесо собирается из python/, и приложение обязано лежать ВНУТРИ пакета:
   * hatchling кладёт в колесо то, что лежит под colloq/, а _app там и лежит.
   * Каталог сносится целиком, а не докладывается поверх: иначе от прошлой
   * сборки остались бы чужие assets-хеши, и колесо тащило бы оба набора.
   */
  fs.rmSync(pythonApp, { recursive: true, force: true })
  copyInto(appDir, pythonApp)
  // Версия пакета Python — из корневого package.json, одним числом на весь
  // проект. pyproject.toml читает её отсюда (tool.hatch.version), поэтому
  // разъехаться им негде.
  fs.writeFileSync(
    path.join(root, 'python/colloq/_version.py'),
    '# Версия проекта. Файл пишет scripts/pack.mts из корневого package.json —\n' +
      '# руками не править: pyproject.toml берёт версию колеса отсюда.\n' +
      `__version__ = "${version}"\n`,
  )
}

// ---------------------------------------------------------------- отчёт

const total = weigh(appDir)
console.log(`\nColloq ${version} — дистрибутив собран: ${appDir}`)
for (const part of parts)
  console.log(
    `  ${part.path.padEnd(24)} ${String(part.files).padStart(5)} ф.  ${human(part.bytes)}`,
  )
console.log(`  ${'всего'.padEnd(24)} ${String(total.files).padStart(5)} ф.  ${human(total.bytes)}`)
if (!values['no-python']) console.log(`\nВ пакете Python: ${pythonApp}\nКолесо: make wheel`)

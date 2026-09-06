/**
 * Environments: the packages a seminar's Python has.
 *
 * One environment is one file in `kernel/environments/`, installed on top of
 * the base every kernel carries, and built into the image `colloq-kernel:<name>`.
 * The panel and the `make env-*` targets are two faces of the same directory
 * and the same `KERNEL_ENV` line, which is why the parsing rules live in one
 * place and are pinned here.
 */
import './_env.mts'
import http from 'node:http'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { Response } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_INHERITANCE,
  abilities,
  buildChain,
  buildCommand,
  declaresGpu,
  declaresParent,
  listChanged,
  needsGpu,
  parsePackages,
  pickActiveName,
  readSource,
} from '../server/src/environments.js'
import { adminEnvironmentRoutes } from '../server/src/routes/admin-environments.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { ENVIRONMENT_NAME, STAFF_COOKIE } from '../shared/admin.js'

/* ------------------------------------------------ what counts as a package */

test('a package per line, as a person would count them', () => {
  assert.deepEqual(parsePackages('torch>=2.4\ntimm>=1.0\n'), ['torch>=2.4', 'timm>=1.0'])
})

test('comments and blank lines are not packages', () => {
  const source = '# computer vision\n\ntorch>=2.4\n\n#  another note\ntimm>=1.0\n'
  assert.deepEqual(parsePackages(source), ['torch>=2.4', 'timm>=1.0'])
})

test('a pip directive is not a package', () => {
  // Counting these told a room "6 packages" for a file that listed five, which
  // is the sort of small lie that makes the rest of a number untrustworthy.
  const source = '--extra-index-url https://download.pytorch.org/whl/cpu\ntorch>=2.4\n'
  assert.deepEqual(parsePackages(source), ['torch>=2.4'])
})

test('surrounding whitespace does not make two packages out of one', () => {
  assert.deepEqual(parsePackages('  torch>=2.4  \n\t timm \n'), ['torch>=2.4', 'timm'])
})

test('an empty file asks for nothing, and says so without crashing', () => {
  assert.deepEqual(parsePackages(''), [])
  assert.deepEqual(parsePackages('\n\n#только комментарий\n'), [])
})

test('a package with a marker or an extra survives whole', () => {
  const source = "uvicorn[standard]>=0.30\nnumpy>=1.26; python_version < '3.13'\n"
  assert.deepEqual(parsePackages(source), [
    'uvicorn[standard]>=0.30',
    "numpy>=1.26; python_version < '3.13'",
  ])
})

/* ------------------------------------------- окружению нужен срез GPU */

/*
 * GPU — свойство окружения, а не комнаты: колёса torch собраны под CUDA, и «то
 * же самое, только на процессоре» здесь не существует. Объявляется строкой в
 * шапке файла, потому что список пакетов и есть окружение, а отдельный реестр
 * рядом с ним разъезжается на первой же правке руками.
 */
test('директива в шапке объявляет GPU, а pip её не видит', () => {
  const source = '# нейросети\n# colloq: gpu\ntorch>=2.4\n'
  assert.equal(declaresGpu(source), true)
  // Для pip это комментарий: ни лишнего пакета в счёте, ни «Needs rebuild» на
  // собранном образе из-за одной строки.
  assert.deepEqual(parsePackages(source), ['torch>=2.4'])
  assert.equal(listChanged('torch>=2.4\n', source), false)
})

test('пробелы и регистр директиву не ломают', () => {
  assert.equal(declaresGpu('  #   colloq:  gpu  \n'), true)
  assert.equal(declaresGpu('# Colloq: GPU\n'), true)
})

test('обычное окружение среза не просит', () => {
  assert.equal(declaresGpu(''), false)
  assert.equal(declaresGpu('# зрение на процессоре\ntorch>=2.4\n'), false)
  // Слово в предложении — не директива: иначе фраза про GPU внутри пояснения
  // забирала бы срез у семинара, которому он действительно нужен.
  assert.equal(declaresGpu('# colloq: gpu тут не нужен\n'), false)
})

test('образцовое окружение gpu действительно объявляет срез, а базовое — нет', () => {
  // Единственные два примера этой директивы в репозитории: base-gpu объявляет
  // её сам, gpu получает по наследству. Выпадет она — комната поедет на
  // процессоре и упадёт на первом `.cuda()`.
  assert.equal(needsGpu('base-gpu'), true)
  assert.equal(needsGpu('gpu'), true)
  assert.equal(needsGpu('base'), false)
  assert.equal(needsGpu('cv'), false)
  // Несуществующее имя — это пустой файл, а не исключение: спрашивают об этом
  // на подъёме ядра, и падать там незачем.
  assert.equal(needsGpu('нет-такого'), false)
})

/* ------------------------------------------- поверх чего это собирается */

/*
 * Слой окружения один, и любая правка списка ставит его целиком заново: для
 * окружения с torch это три гигабайта колёс и девять минут за добавленный timm.
 * `# colloq: from base-gpu` переносит тяжёлое в общий слой — родитель
 * собирается один раз, дети за секунды. Пишется в том же виде, что и
 * `# colloq: gpu`, и так же остаётся для pip комментарием.
 */
test('директива в шапке называет родителя, а pip её не видит', () => {
  const source = '# нейросети\n# colloq: from base-gpu\ntransformers>=4.44\n'
  assert.equal(declaresParent(source), 'base-gpu')
  assert.deepEqual(parsePackages(source), ['transformers>=4.44'])
  // Ни лишнего пакета в счёте, ни «Needs rebuild» на собранном образе.
  assert.equal(listChanged('transformers>=4.44\n', source), false)
})

test('пробелы и регистр директиву не ломают, а фраза о ней — не директива', () => {
  assert.equal(declaresParent('  #   colloq:  from   base-gpu  \n'), 'base-gpu')
  assert.equal(declaresParent('# Colloq: FROM base-gpu\n'), 'base-gpu')
  assert.equal(declaresParent('# colloq: from base-gpu и дальше своё\n'), null)
  assert.equal(declaresParent('# строится from base-gpu\n'), null)
})

test('родитель не назван — строимся поверх обычной базы, как раньше', () => {
  assert.equal(declaresParent(''), null)
  assert.equal(declaresParent('# зрение\ntorch>=2.4\n'), null)
  assert.equal(declaresParent(readSource('cv')), null)
})

test('образцовые окружения репозитория сцеплены именно так', () => {
  // Выпадет строка из gpu.txt — и «правка списка» снова станет девятью
  // минутами, молча.
  assert.equal(declaresParent(readSource('gpu')), 'base-gpu')
  assert.deepEqual(buildChain('gpu'), ['base-gpu', 'gpu'])
  assert.deepEqual(buildChain('cv'), ['cv'])
})

/* --------------------------------------------------- порядок и отказы */

/** Окружения, каких на диске нет: разбор цепочки от диска не зависит. */
function reader(files: Record<string, string>) {
  return (name: string): string | null => files[name] ?? null
}

test('цепочка собирается от корня к листу', () => {
  const read = reader({
    'base-gpu': '# colloq: gpu\ntorch>=2.4\n',
    gpu: '# colloq: from base-gpu\ntransformers>=4.44\n',
    vlm: '# colloq: from gpu\nqwen-vl\n',
  })
  assert.deepEqual(buildChain('vlm', read), ['base-gpu', 'gpu', 'vlm'])
  assert.deepEqual(buildChain('base-gpu', read), ['base-gpu'])
})

test('петля — отказ, а не бесконечная сборка', () => {
  const read = reader({ a: '# colloq: from b\n', b: '# colloq: from a\n' })
  assert.throws(() => buildChain('a', read), /по кругу/)
  // И самый короткий круг тоже: файл, назвавший родителем себя.
  assert.throws(() => buildChain('s', reader({ s: '# colloq: from s\n' })), /по кругу/)
})

test('слишком длинная цепочка — отказ, а не сборка на девять слоёв', () => {
  const files: Record<string, string> = {}
  const last = MAX_INHERITANCE + 1
  for (let i = 0; i <= last; i += 1) files[`e${i}`] = i === 0 ? '' : `# colloq: from e${i - 1}\n`
  assert.equal(buildChain(`e${MAX_INHERITANCE - 1}`, reader(files)).length, MAX_INHERITANCE)
  assert.throws(() => buildChain(`e${last}`, reader(files)), /длиннее/)
})

test('неизвестный родитель назван вслух, и до docker', () => {
  const read = reader({ gpu: '# colloq: from base-gpu\n' })
  // Девять минут, чтобы упасть на `COPY environments/base-gpu.txt`, — та же
  // ошибка, только дороже.
  assert.throws(() => buildChain('gpu', read), /«base-gpu»/)
  assert.throws(() => buildChain('missing', read), /нет окружения/)
  // Имя уходит и в путь, и в тег образа: не имя — не родитель.
  assert.throws(() => buildChain('x', reader({ x: '# colloq: from ../etc\n' })), /не может быть/)
})

test('признак gpu наследуется вместе с колёсами под CUDA', () => {
  const read = reader({
    'base-gpu': '# colloq: gpu\ntorch>=2.4\n',
    gpu: '# colloq: from base-gpu\ntransformers>=4.44\n',
    vlm: '# colloq: from gpu\nqwen-vl\n',
    cpu: '# colloq: from base\npillow\n',
    base: '',
  })
  // Иначе комната получит образ с CUDA-колёсами и без устройства — то есть
  // упадёт на первом `.cuda()`, а панель будет молчать.
  assert.equal(needsGpu('gpu', read), true)
  assert.equal(needsGpu('vlm', read), true)
  assert.equal(needsGpu('cpu', read), false)
})

test('своя директива у ребёнка тоже считается', () => {
  const read = reader({ base: '', own: '# colloq: from base\n# colloq: gpu\n' })
  assert.equal(needsGpu('own', read), true)
})

test('сломанная цепочка не отнимает срез у того, кто его просит', () => {
  // Об этом скажет сборка. Промолчать здесь — значит поднять комнату без
  // устройства и узнать об этом посреди пары.
  assert.equal(needsGpu('gpu', reader({ gpu: '# colloq: gpu\n# colloq: from нет\n' })), true)
})

/* --------------------------------------------------- чем это собирается */

/*
 * Настоящего docker в сюите нет (см. `_env.mts`), поэтому проверяется то, что
 * от него не зависит: команда, которую мы для него собираем, — как в gpu.test.
 *
 * Путей два, и это не украшение. На машине с репозиторием собирает compose: он
 * подхватывает dev-override, без которого пересобранное общее ядро возвращается
 * без проброшенного 8888. В контейнере app compose нет вовсе — есть каталог
 * kernel и сокет, и этого достаточно.
 */

/** Путь к каталогу kernel в этих проверках: сам он существовать не обязан. */
const KERNEL = '/srv/colloq/kernel'

test('прямая сборка обходится каталогом kernel — ни compose, ни репозитория', () => {
  const { args, env } = buildCommand({ via: 'direct' }, 'cv', null, KERNEL)
  assert.deepEqual(args, [
    'build',
    '-f',
    '/srv/colloq/kernel/Dockerfile',
    '--build-arg',
    'KERNEL_ENV=cv',
    '-t',
    'colloq-kernel:cv',
    '/srv/colloq/kernel',
  ])
  // Контекст читает клиент и отдаёт демону, поэтому демон на хосте — не помеха.
  // А `docker compose` отсюда падал бы «no configuration file provided», и
  // ровно из-за этого панель гасила Build под `make up`.
  assert.ok(!args.includes('compose'))
  assert.equal(env.KERNEL_ENV, undefined)
})

test('без родителя аргумент PARENT не передаётся вовсе', () => {
  // Умолчание — в самом Dockerfile: назови базовый образ ещё и здесь, и
  // однажды его поднимут там, а тут забудут.
  const { args } = buildCommand({ via: 'direct' }, 'base', null, KERNEL)
  assert.ok(!args.some((arg) => arg.startsWith('PARENT=')))
})

test('через compose переменные, а не флаги: аргументы подставляет он сам', () => {
  const files = ['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml']
  const { args, env } = buildCommand({ via: 'compose', files }, 'gpu', 'colloq-kernel:base-gpu')
  assert.deepEqual(args, ['compose', ...files, 'build', 'kernel'])
  assert.equal(env.KERNEL_ENV, 'gpu')
  assert.equal(env.KERNEL_PARENT, 'colloq-kernel:base-gpu')
})

test('в прямом пути каждый слой встаёт поверх образа предыдущего', () => {
  const read = reader({
    'base-gpu': '# colloq: gpu\ntorch>=2.4\n',
    gpu: '# colloq: from base-gpu\ntransformers>=4.44\n',
  })
  const chain = buildChain('gpu', read)
  const commands = chain.map((step, i) => {
    const before = chain[i - 1]
    return buildCommand(
      { via: 'direct' },
      step,
      before === undefined ? null : `colloq-kernel:${before}`,
      KERNEL,
    ).args.join(' ')
  })
  assert.ok(commands[0]?.includes('--build-arg KERNEL_ENV=base-gpu'))
  assert.ok(commands[0]?.includes('-t colloq-kernel:base-gpu'))
  assert.ok(!commands[0]?.includes('PARENT='))
  // Ради этого наследование и заведено: torch остаётся в родителе, и правка
  // листа стоит секунды, а не девять минут.
  assert.ok(commands[1]?.includes('--build-arg PARENT=colloq-kernel:base-gpu'))
  assert.ok(commands[1]?.includes('-t colloq-kernel:gpu'))
})

/* ----------------------------------------- что здесь вообще можно сделать */

/*
 * Собрать и назначить умолчанием — два разных вопроса, и одна причина на двоих
 * гасила обе кнопки: под `make up` окружение нельзя было собрать вовсе, только
 * зайти по ssh.
 */

test('репозиторий рядом — можно и собрать, и назначить умолчанием', () => {
  const can = abilities({ docker: true, context: true, repository: true })
  assert.deepEqual(
    [can.canBuild, can.cannotBuildReason, can.canSetDefault, can.cannotSetDefaultReason],
    [true, null, true, null],
  )
})

test('в контейнере только kernel: собрать можно, умолчание — на хосте', () => {
  // Ровно `make up`: примонтированы kernel и сокет, а docker-compose.yml и .env
  // остались снаружи. Писать .env внутрь контейнера — врать: правка доживёт до
  // первой пересборки, пока compose читает файл на хосте.
  const can = abilities({ docker: true, context: true, repository: false })
  assert.equal(can.canBuild, true)
  assert.equal(can.cannotBuildReason, null)
  assert.equal(can.canSetDefault, false)
  // Отказ называет выполнимое действие, а не «всё сломано».
  assert.match(can.cannotSetDefaultReason ?? '', /make env-use/)
})

test('нет и каталога kernel — отказ в сборке называет монт', () => {
  const can = abilities({ docker: true, context: false, repository: false })
  assert.equal(can.canBuild, false)
  assert.match(can.cannotBuildReason ?? '', /kernel/)
  // И умолчание не обещает сборку, которой здесь тоже нет.
  assert.ok(!/works from here/.test(can.cannotSetDefaultReason ?? ''))
})

test('docker не виден — нельзя ничего, и причина у обеих кнопок одна', () => {
  const can = abilities({ docker: false, context: true, repository: true })
  assert.equal(can.canBuild, false)
  assert.equal(can.canSetDefault, false)
  assert.equal(can.cannotBuildReason, can.cannotSetDefaultReason)
  assert.match(can.cannotBuildReason ?? '', /docker\.sock/)
})

/* ------------------------------------------------------------ the name */

test('a name is what a filename and a Docker tag can both be', () => {
  for (const ok of ['base', 'cv', 'cv-torch-2', 'a', 'nlp-hf']) {
    assert.ok(ENVIRONMENT_NAME.test(ok), ok)
  }
})

test('a name that would escape the directory or break a tag is refused', () => {
  // It becomes a path and an image tag, so this is not cosmetic.
  for (const bad of ['../etc', 'CV', 'cv torch', 'cv.torch', '-cv', 'cv-', '', 'cv/../x', 'cv:latest']) {
    assert.ok(!ENVIRONMENT_NAME.test(bad), bad)
  }
})

test('a name is short enough to read in a table row', () => {
  assert.ok(ENVIRONMENT_NAME.test('a'.repeat(32)))
  assert.ok(!ENVIRONMENT_NAME.test('a'.repeat(33)))
})

/* ------------------------------------------- собрана ли она на самом деле */

/*
 * «Собрана или нет» решалось сравнением времени правки файла со временем
 * сборки образа — то есть отвечало на другой вопрос: не изменился ли список, а
 * трогали ли файл. Открыть список и сохранить не меняя, или просто иметь файл
 * новее образа, собранного через docker compose, — этого хватало, чтобы на
 * рабочей среде повисло «Needs rebuild» рядом с «216 MB · built 5 days ago».
 */
test('сохранение без изменений — не изменение', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'torch>=2.4\ntimm>=1.0\n'), false)
})

test('комментарий и пустая строка не меняют того, что поставит pip', () => {
  assert.equal(
    listChanged('torch>=2.4\ntimm>=1.0\n', '# зрение\n\ntorch>=2.4\n\ntimm>=1.0\n'),
    false,
  )
})

test('тот же список в другом порядке — тот же список', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'timm>=1.0\ntorch>=2.4\n'), false)
})

test('новый пакет — изменение', () => {
  assert.equal(listChanged('torch>=2.4\n', 'torch>=2.4\nnumpy\n'), true)
})

test('другая версия того же пакета — изменение', () => {
  assert.equal(listChanged('torch>=2.4\n', 'torch>=2.5\n'), true)
})

test('убранный пакет — изменение', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'torch>=2.4\n'), true)
})

/* ------------------------------------------ какое окружение по умолчанию */

/*
 * `.env` — файл хоста, и в образе app его нет. Без запасного пути панель под
 * `make up` всегда отвечала «base», а новый семинар записывался на base при
 * собранном ядре cv: имя окружения у семинара решает, из какого образа
 * поднимется его контейнер, когда сервер увидит docker.
 */
test('строка .env решает, пока она есть', () => {
  assert.equal(pickActiveName('PORT=3000\nKERNEL_ENV=cv\n', 'base'), 'cv')
})

test('последняя строка — та, что дописал make env-use', () => {
  assert.equal(pickActiveName('KERNEL_ENV=base\nKERNEL_ENV=nlp\n', undefined), 'nlp')
})

test('без файла берётся то, что compose передал контейнеру', () => {
  assert.equal(pickActiveName(null, 'cv'), 'cv')
})

test('в файле нет строки — тоже переменная окружения', () => {
  assert.equal(pickActiveName('PORT=3000\n', 'cv'), 'cv')
})

test('нет ни файла, ни переменной — base', () => {
  assert.equal(pickActiveName(null, undefined), 'base')
  assert.equal(pickActiveName('KERNEL_ENV=\n', ''), 'base')
})

test('имя, которым не может быть ни файл, ни тег, не считается', () => {
  // Оно уходит в путь и в имя образа, поэтому проверяется здесь, а не там.
  assert.equal(pickActiveName('KERNEL_ENV=../etc\n', undefined), 'base')
  assert.equal(pickActiveName('KERNEL_ENV=CV\n', 'cv'), 'cv')
})

/* ------------------------------------------- создание против перезаписи */

/**
 * PUT одинаков для «завёл окружение» и «поправил список», а намерения разные.
 *
 * Форма «New environment» шлёт тот же запрос, и на занятом имени она молча
 * затирала чужой список пакетов целиком — истории у этих файлов нет, вернуть
 * нечем. `If-None-Match: *` — это «только если такого ещё нет».
 */
const app = express()
app.use(express.json())
app.use(adminEnvironmentRoutes())
let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

/**
 * issueStaffCookie пишет в express-овый Response; это самое малое, что им является.
 *
 * Преподаватель заводится один на всю сюиту: адрес уникален индексом, и второй
 * вызов с тем же вернул бы null, а не второе печенье.
 */
let cookie = ''
function staffCookie(): string {
  if (cookie) return cookie
  const teacher = createTeacher({ name: 'Ада', email: 'ada@test.local', role: 'owner' })
  assert.ok(teacher)
  let value = ''
  issueStaffCookie(
    { cookie: (_n: string, v: string) => (value = v) } as unknown as Response,
    teacher,
  )
  cookie = `${STAFF_COOKIE}=${value}`
  return cookie
}

test('создание по занятому имени отказывает, а не переписывает список', async () => {
  const before = readSource('base')
  const res = await fetch(`${base}/api/admin/environments/base`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'if-none-match': '*',
      cookie: staffCookie(),
    },
    body: JSON.stringify({ name: 'base', source: '# пусто\n' }),
  })
  assert.equal(res.status, 409)
  const body = (await res.json()) as { reason?: string }
  assert.equal(body.reason, 'exists')
  // Главное: файл не тронут — иначе отказ был бы вежливостью после потери.
  assert.equal(readSource('base'), before)
})

/* ------------------------------- своё ядро у комнаты или общее на всех */

/**
 * Признак едет вместе со списком, потому что показывают его там же.
 *
 * Панель обещала контейнер на семинар безусловно, а на установке без docker или
 * с KERNEL_ISOLATION=off это неправда сразу в двух местах: комнаты видят файлы
 * друг друга, и «Make default» действительно забирает переменные у открытых
 * семинаров. Знает об этом только сервер — значит, он и говорит.
 */
test('список окружений говорит, делят ли комнаты одно ядро', async () => {
  const res = await fetch(`${base}/api/admin/environments`, { headers: { cookie: staffCookie() } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { environments?: unknown; shared?: unknown }
  assert.ok(Array.isArray(body.environments))
  // Булево, а не «поля нет»: `undefined` панель читает как «всё в порядке».
  assert.equal(typeof body.shared, 'boolean')
  // Изоляция в сюите выключена (tests/_env.mts), так что ядро тут общее.
  assert.equal(body.shared, true)
})

/* ------------------------------------ .env.example против docker-compose */

/**
 * Каждая строка из .env.example доезжает до контейнера app.
 *
 * compose читает .env только для подстановки: переменная, не названная в
 * `environment:`, до сервера внутри контейнера не доходит вовсе. Так
 * `MAX_SESSION_MB=200` и `AI_REASONING=true` молча не работали под `make up`,
 * хотя и README, и .env.example их обещали, а `make run` те же строки
 * применял — два режима одного инстанса вели себя по-разному, и заметить это
 * можно было только по загруженному в комнату лишнему гигабайту.
 */
test('переменная, обещанная в .env.example, доезжает до контейнера', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const documented = readFileSync(path.join(root, '.env.example'), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf('=')))
  assert.ok(documented.length > 10, 'разбор .env.example ничего не нашёл')

  const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
  const app = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  kernel:'))
  // Единственное исключение: PORT — это порт НА ХОСТЕ, он уходит в ports, а
  // внутри контейнера сервер всегда слушает 3000.
  const hostOnly = new Set(['PORT'])
  for (const name of documented) {
    if (hostOnly.has(name)) continue
    assert.match(
      app,
      new RegExp(`\\n +${name}: `),
      `${name} обещан в .env.example, но в контейнер app не передаётся`,
    )
  }
})

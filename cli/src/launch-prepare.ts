import fs from 'node:fs'
import path from 'node:path'
import {
  buildIsCurrent,
  fingerprint,
  kernelInputs,
  type BuildStamp,
  type LaunchConfig,
  type LaunchOptions,
} from './launch-config.js'
import { capture, Processes } from './launch-process.js'
import { readJson, writeJson } from './launch-state.js'

/**
 * Одно звено цепочки окружений: один образ colloq-kernel:<имя>.
 *
 * Когда строим из самого каталога приложения и рядом есть Makefile (viaMake
 * ниже, причина — у вычисления в prepare), зовём `make env-build` — ту самую
 * цель, которой собирают окружения руками, чтобы сборка из CLI и сборка из
 * терминала не разъехались.
 *
 * Иначе собирает прямой docker. В дистрибутиве Makefile нет, и docker compose
 * тоже нет на что натравить:
 * docker-compose.yml — файл репозитория. Зато собирается там ровно одно и
 * то же, и это видно построчно: цель `kernel` в docker-compose.yml берёт
 * контекст ./kernel и передаёт два аргумента — KERNEL_ENV (какой лист
 * окружения копировать) и PARENT (поверх чего класть слой), — а тег ставит
 * colloq-kernel:<имя>. Здесь это сказано прямым вызовом docker.
 *
 * Родителя не передаём вовсе, когда его нет: умолчание живёт в самом
 * kernel/Dockerfile (ARG PARENT=python:3.11-slim-bookworm), и второй копии
 * имени базового образа заводить нельзя — разъедутся. Тот же выбор и по той
 * же причине сделан на стороне сервера: server/src/environments.ts ·
 * buildCommand, там этот же прямой вызов собран для панели.
 *
 * BUILDKIT_PROGRESS=plain — тоже оттуда: вывод уходит и в терминал, и в
 * .colloq.log построчно, а «красивый» прогресс перерисовывает себя каретками
 * и в журнале превращается в кашу.
 *
 * buildRoot — не корень приложения, а корень СБОРКИ: он же контекст docker.
 * Их разводит kernelRoot ниже, когда у человека есть свои окружения.
 */
async function buildKernelImage(
  processes: Processes,
  buildRoot: string,
  viaMake: boolean,
  name: string,
  parentImage: string,
  quiet: boolean,
): Promise<void> {
  if (viaMake) {
    const target = ['--no-print-directory', 'env-build', `NAME=${name}`]
    await processes.run('Python build', 'make', target)
    return
  }
  const kernel = path.join(buildRoot, 'kernel')
  const args = [
    'build',
    '-f',
    path.join(kernel, 'Dockerfile'),
    '--build-arg',
    `KERNEL_ENV=${name}`,
    ...(parentImage ? ['--build-arg', `PARENT=${parentImage}`] : []),
    '-t',
    `colloq-kernel:${name}`,
    kernel,
  ]
  const build = processes.start('Python build', 'docker', args, quiet, {
    DOCKER_BUILDKIT: '1',
    BUILDKIT_PROGRESS: 'plain',
  })
  const code = await build.done
  if (code !== 0) throw new Error(`Python build: the process exited with code ${code}.`)
}

/**
 * Корень сборки ядра: привезённое плюс своё, в одном каталоге.
 *
 * Окружения живут в двух местах. Привезённые (base, cv, gpu) лежат рядом с
 * приложением и только читаются — у поставленного пакета это site-packages,
 * куда писать нельзя вовсе. Свои человек заводит `colloq env new`, и они
 * ложатся в COLLOQ_HOME.
 *
 * Разводить эти два места по всему запуску — по отпечатку, по цепочке
 * наследования, по контексту `docker build` — значит протащить развилку в
 * четыре разных места и однажды забыть про одно. Поэтому развилка ровно здесь:
 * перед сборкой каталог ядра собирается заново в состоянии, а дальше всё
 * работает как раньше, с ОДНИМ корнем. Своё имя перебивает привезённое:
 * человек вправе переопределить `cv` под свой курс.
 *
 * В репозитории склеивать нечего (состояние и есть репозиторий) — там
 * возвращается сам корень, и не копируется ни байта.
 */
function kernelRoot(root: string, home: string): string {
  const own = path.join(home, 'environments')
  if (home === root || !fs.existsSync(own)) return root
  const staged = path.join(home, '.colloq/kernel-build')
  const to = path.join(staged, 'kernel')
  fs.rmSync(staged, { recursive: true, force: true })
  // preserveTimestamps: копия обязана сохранить время правки. По нему в первый
  // раз (когда отметки о сборке ещё нет) решается, свежий ли образ, — и без
  // этого каждая склейка выглядела бы как «исходники только что изменились» и
  // стоила бы преподавателю лишней пересборки перед парой.
  const keep = { recursive: true, preserveTimestamps: true } as const
  fs.cpSync(path.join(root, 'kernel'), to, keep)
  const into = path.join(to, 'environments')
  fs.mkdirSync(into, { recursive: true })
  for (const file of fs.readdirSync(own))
    if (file.endsWith('.txt')) fs.cpSync(path.join(own, file), path.join(into, file), keep)
  return staged
}

export async function prepare(
  config: LaunchConfig,
  options: LaunchOptions,
  processes: Processes,
  stopped: () => boolean,
): Promise<void> {
  const { root, home, env, kernelEnv, dist } = config
  /*
   * Всё, что касается ядра, считается от СКЛЕЕННОГО корня: там и привезённые
   * окружения, и заведённые человеком. См. kernelRoot — развилка только там.
   */
  const kernelFrom = kernelRoot(root, home)
  /*
   * Кому доверить сборку звена — make или прямому docker.
   *
   * Признак здесь тот же, по которому выше склеивались каталоги: совпал ли
   * корень СБОРКИ с каталогом приложения. Цель `env-build` никакого buildRoot не
   * знает вовсе: она читает $(ENV_DIR) рядом с самим Makefile и строит по
   * контексту ./kernel того же дерева, — значит доверять ей можно ровно тогда,
   * когда склеивать было нечего и kernelRoot вернул сам root.
   *
   * Стояло по dist — и в зазоре между двумя разными развилками ломалось:
   * рабочее дерево (то есть !dist), запущенное с COLLOQ_HOME=~/классА, склеивало
   * окружения в <home>/.colloq/kernel-build и тут же звало make, который склейки не
   * видит. Занятие падало на «Нет <имя>.txt», а если имя совпало с привезённым —
   * молча собирался ПРИВЕЗЁННЫЙ список вместо своего, то есть ровно то
   * «переопределить cv под свой курс», ради которого склейка и заведена.
   *
   * dist в условии остаётся вторым слагаемым по единственной причине: у
   * установленного colloq без своих окружений склеивать тоже нечего и kernelFrom
   * равен root, но Makefile в пакет не едет, и звать там нечего.
   */
  const viaMake = !dist && kernelFrom === root
  /*
   * Требования COLLOQ_UNSAFE_DEV_FILES здесь больше нет.
   *
   * Стояло: на всём, что не Linux, запуск отказывал, пока в .env не появится
   * строка со словом UNSAFE. Для преподавателя с макбуком это был тупик в два
   * шага — сначала отказ про файл, которого ещё нет, потом предложение самому
   * вписать в него «небезопасно». Чинится это в файловом слое (server ·
   * secure-files.ts), а не распиской в конфиге: путь без Linux-обхода
   * дескрипторов должен быть либо годным, либо отсутствовать.
   *
   * Проверка живости Docker остаётся: без него ядро занятия не поднимется
   * вовсе, и сказать об этом лучше сейчас, чем через полторы минуты сборки.
   */
  if ((await capture(root, env, 'docker', ['info', '--format', '{{.ServerVersion}}'])).code !== 0)
    throw new Error('Docker is not responding. Start Docker and run colloq run again.')
  if (stopped()) throw new Error('Launch cancelled.')
  const inputs = kernelInputs(kernelFrom, kernelEnv)
  const sourceHash = fingerprint(kernelFrom, inputs)
  const chain = inputs
    .slice(2)
    .reverse()
    .map((file) => {
      const name = path.basename(file, '.txt')
      const sources = kernelInputs(kernelFrom, name)
      return { name, sources, fingerprint: fingerprint(kernelFrom, sources) }
    })
  type KernelStamp = { fingerprint: string; id: string; parentId?: string }
  const stamps: Array<{ file: string; value: KernelStamp }> = []
  const inspect = async (name: string): Promise<{ Id: string; Created: string } | undefined> => {
    const result = await capture(root, env, 'docker', ['image', 'inspect', `colloq-kernel:${name}`])
    if (stopped()) throw new Error('Launch cancelled.')
    if (result.code !== 0) return undefined
    try {
      const image = JSON.parse(result.text)[0]
      return typeof image?.Id === 'string' && image.Id ? image : undefined
    } catch {
      return undefined
    }
  }
  let parentId = '',
    parentImage = '',
    parentCreated = 0,
    ancestorRebuilt = false
  // env-build deliberately reuses existing parents. Request each changed
  // ancestor explicitly before building its descendants against that image.
  for (const item of chain) {
    let image = await inspect(item.name)
    // Отметка про собранный образ — про эту МАШИНУ (образы живут в её docker),
    // а не про приложение, поэтому home. Каталог установленного приложения
    // вообще может быть закрыт на запись, и писать туда нам нечего.
    const marker = path.join(home, `.colloq/kernel-${item.name}.json`)
    const stamp = readJson<KernelStamp>(marker)
    const freshImage =
      image &&
      Date.parse(image.Created) >= parentCreated &&
      item.sources.every(
        (file) => fs.statSync(path.join(kernelFrom, file)).mtimeMs <= Date.parse(image!.Created),
      )
    const current = stamp
      ? stamp.fingerprint === item.fingerprint &&
        stamp.id === image?.Id &&
        (stamp.parentId ?? '') === parentId
      : freshImage
    if (!image || ancestorRebuilt || !current) {
      /*
       * Лог docker build — в журнал, на экран только начало и конец: сотня
       * строк «#7 CACHED» преподавателю ничего не говорит, а при сбое хвост
       * журнала покажет launch.ts. Под make dev лог остаётся на экране.
       */
      const quiet = options.action !== 'dev'
      const began = Date.now()
      console.log(
        `Preparing the Python environment "${item.name}"` +
          (quiet ? ' (the first start takes a few minutes)…' : ''),
      )
      await buildKernelImage(processes, kernelFrom, viaMake, item.name, parentImage, quiet)
      if (quiet) console.log(`  ready in ${Math.max(1, Math.round((Date.now() - began) / 1000))} s`)
      image = await inspect(item.name)
      if (!image) throw new Error('The build finished, but the kernel image is not there.')
      ancestorRebuilt = true
    }
    if (fingerprint(kernelFrom, inputs) !== sourceHash)
      throw new Error('The sources changed during the build. Start again, or use make dev.')
    stamps.push({ file: marker, value: { fingerprint: item.fingerprint, id: image.Id, parentId } })
    parentId = image.Id
    parentImage = `colloq-kernel:${item.name}`
    parentCreated = Date.parse(image.Created)
  }
  for (const stamp of stamps) writeJson(stamp.file, stamp.value)
  if (stopped()) throw new Error('Launch cancelled.')
  if (options.action === 'dev') return
  /*
   * Дистрибутив принимается как есть.
   *
   * Отпечаток исходников (launch-config.ts · fingerprint) отвечает на вопрос
   * «разошлась ли сборка с кодом» — вопрос разработчика. У установленного
   * приложения исходников нет вовсе: отпечаток считался бы по пустому месту,
   * совпал бы сам с собой и всё равно ничего бы не значил, а `npm run build`
   * звать нечем — ни npm, ни node_modules сборки, ни web/src в пакете нет.
   *
   * Поэтому единственное, что проверяется, — что приложение на месте. Скажем
   * об этом сразу, а не запустим node на отсутствующем файле.
   */
  if (dist) {
    for (const required of ['web/dist/index.html', 'server/dist/server.js'])
      if (!fs.existsSync(path.join(root, required)))
        throw new Error(
          `The installation is incomplete: no ${required} in ${root}. Reinstall colloq (pip install --force-reinstall colloq).`,
        )
    return
  }
  /*
   * Отметка про сборку — про ЭТО дерево исходников, поэтому она остаётся рядом
   * с ним, а не в каталоге занятия. Сюда доходят только из рабочего дерева
   * (у дистрибутива выше стоит return), и оно по определению пишется. Заодно
   * переезд COLLOQ_HOME на новый класс не выглядит как «сборка устарела» и не
   * стоит преподавателю лишних трёх минут перед парой.
   */
  const file = path.join(root, '.colloq/build.json')
  if (options.build || !buildIsCurrent(root, readJson<BuildStamp>(file), options.fast)) {
    const before = fingerprint(root)
    console.log('Building the application…')
    await processes.run('Application build', 'npm', [
      'run',
      options.fast ? 'build' : 'build:optimized',
    ])
    if (
      !fs.existsSync(path.join(root, 'web/dist/index.html')) ||
      !fs.existsSync(path.join(root, 'server/dist/server.js'))
    )
      throw new Error('The build produced no frontend and no server. Check the output above.')
    if (fingerprint(root) !== before)
      throw new Error('The sources changed during the build. Start again, or use make dev.')
    writeJson(file, { fingerprint: before, fast: options.fast })
  }
}

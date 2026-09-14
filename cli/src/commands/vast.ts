/**
 * Машины и версии — арендованное железо и то, что на нём стоит.
 *
 * Цели группы: vast up, vast status, vast sync, vast logs, vast down,
 * vast adopt, install, update, rollback, cluster start, cluster stop,
 * cluster status, cluster logs, service install, service restart,
 * service stop, service status, service logs, release validate.
 *
 * Здесь два мира, и разводит их одна переменная. С RELEASE=… работает k3s-путь
 * (scripts/vast.sh): git archive инструментов развёртывания из sourceCommit,
 * переносимые .tar.gz, образы по digest. Без RELEASE — прежний путь
 * (scripts/vast-legacy.sh): rsync рабочего дерева, фильтрованный .env и
 * systemd. Словари у путей разные (SINCE, MODE, RESUME), и CLI их не переводит:
 * переведённое окно журнала — это чужая команда на боевой машине.
 *
 * node:child_process и node:fs импортировать нельзя: только ctx.sh и ctx.io.
 */
import type { Command, Ctx } from '../registry.js'
import { envNameOk, joinPath } from '../env.js'
import { heading as head, PreconditionError, UsageError } from '../ui.js'

/** Адрес: то, что уезжает внутрь строки на арендованной машине. */
const HOST_OK = /^[A-Za-z0-9.-]+$/
/** Окно журнала в k3s-пути: kubectl понимает длительность, и только её. */
const SINCE_K3S = /^[0-9]+[smh]$/
/** Окно журнала в прежнем пути: словарь journalctl, белым списком знаков. */
const SINCE_LEGACY = /^[A-Za-z0-9:,+ -]{1,40}$/

const USAGE = {
  up: 'colloq vast up [среда] [--host <имя>] [--gpu <карта>] [--release <путь>] [--replace]',
  status: 'colloq vast status [среда] [--release <путь>]',
  sync: 'colloq vast sync [среда] [--mode <live|consistent>] [--resume] [--release <путь>]',
  logs: 'colloq vast logs [среда] [--since <окно>] [--release <путь>]',
  down: 'colloq vast down [среда] [--release <путь>]',
  adopt: 'colloq vast adopt <среда>',
  install: 'colloq install --release <путь>',
  update: 'colloq update --release <путь>',
  rollback: 'colloq rollback --release <путь>',
  serviceInstall: 'colloq service install --release <путь>',
  validate: 'colloq release validate --release <путь>',
}

/**
 * Значение, названное двумя способами. Пара ВИДА=ЗНАЧЕНИЕ снята каркасом из
 * argv и уйдёт make сама — второй раз её передавать не надо, иначе она
 * удвоится в строке --dry-run. Поэтому value (для проверок) и pass (для make)
 * разные поля.
 */
type Value = { value?: string; pass?: string }

/** Значение флага. Пустая строка и не-строка — как будто не задано. */
function str(ctx: Ctx, name: string): string | undefined {
  const raw = ctx.values[name]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

function yes(ctx: Ctx, name: string): boolean {
  return ctx.values[name] === true
}

/**
 * Флаг или пара ВИДА=ЗНАЧЕНИЕ. Пара главнее: её написали руками, и каркас
 * добавит её к вызову make сам — своё значение мы шлём только тогда, когда
 * пары нет, иначе в строке было бы `NAME=hse NAME=demo`.
 */
function either(ctx: Ctx, flag: string | undefined, key: string): Value {
  const pair = ctx.makeVars[key]
  if (pair !== undefined && pair !== '') return { value: pair }
  return flag !== undefined ? { value: flag, pass: flag } : {}
}

/** Своя пара для make: ту, что человек написал руками, каркас пришлёт без нас. */
function own(ctx: Ctx, key: string, value: string | undefined): string | undefined {
  return ctx.makeVars[key] === undefined ? value : undefined
}

/** Первая метка адреса: она же имя среды. */
function label(host: string): string {
  return host.split('.')[0] ?? ''
}

/** Имя среды. Оно же поддомен, метка на vast и подкаталог backups/. */
function checkName(name: string | undefined): void {
  if (name === undefined) return
  if (!envNameOk(name)) {
    throw new UsageError(
      'имя среды «' + name + '» не годится',
      'оно же поддомен, метка на vast и подкаталог backups/: буквы, цифры и дефис в середине — hse, hse-2026',
    )
  }
}

function checkHost(host: string | undefined): void {
  if (host === undefined) return
  if (!HOST_OK.test(host) || host.startsWith('.') || host.endsWith('.')) {
    throw new UsageError(
      'в адресе «' + host + '» есть посторонние знаки',
      'ожидаю имя вида hse.colloq.ru или поддомен: --host hse',
    )
  }
  checkName(label(host))
}

/** Среда и адрес — одно слово: разойтись им нельзя, и отказ дешевле до аренды. */
function checkPair(name: string | undefined, host: string | undefined): void {
  if (name === undefined || host === undefined) return
  if (label(host) !== name) {
    throw new UsageError(
      'среда «' + name + '» и адрес «' + host + '» — разные имена',
      'имя среды и первая часть адреса — одно слово: colloq vast up ' +
        label(host) +
        ' --host ' +
        host,
    )
  }
}

/**
 * Путь к релизу. Флаг разрешается от каталога человека, пара RELEASE=… — от
 * корня репозитория: оттуда её увидит make. Файла нет — отказ до аренды.
 */
function release(ctx: Ctx): Value {
  const pair = ctx.makeVars.RELEASE
  if (pair !== undefined && pair !== '') {
    checkFile(ctx, pair.startsWith('/') ? pair : ctx.env.path(pair))
    return { value: pair }
  }
  const flag = str(ctx, 'release')
  if (flag === undefined) return {}
  const path = ctx.env.userPath(flag)
  checkFile(ctx, path)
  return { value: path, pass: path }
}

function checkFile(ctx: Ctx, path: string): void {
  if (ctx.io.exists(path)) return
  throw new PreconditionError(
    'файла релиза нет: ' + path,
    'манифест проверяют до установки: colloq release validate --release <путь>',
  )
}

/** Релиз обязателен: k3s ставится только явной версией. */
function needRelease(ctx: Ctx, usage: string): Value {
  const found = release(ctx)
  if (found.value === undefined) {
    throw new UsageError('нет обязательного флага --release', 'Употребление: ' + usage)
  }
  return found
}

/** Прерванное восстановление доводят до конца — до него ничего не ставим. */
function checkRestore(ctx: Ctx): void {
  const marker = joinPath(ctx.env.paths.clusterState, '.restore-in-progress')
  if (!ctx.io.exists(marker)) return
  throw new PreconditionError(
    'на этой машине не доведено восстановление',
    'сначала закончите его: make restore ARCHIVE=копия.tar.gz RELEASE=/путь/release.json',
  )
}

function noExtra(ctx: Ctx, allowed: number, usage: string): void {
  if (ctx.positionals.length <= allowed) return
  throw new UsageError(
    'лишний аргумент: ' + (ctx.positionals[allowed] ?? ''),
    'Употребление: ' + usage,
  )
}

/** Пояснение вполголоса: ничего не запрещает, только предупреждает. */
function note(ctx: Ctx, text: string): void {
  if (!ctx.dryRun) ctx.ui.line(ctx.ui.dim(text))
}

/**
 * Что помним о среде после вызова: имя, карта, путь развёртывания, жива ли.
 * Адреса здесь нет: его печатает скрипт, а чужой поток CLI не разбирает.
 */
type Memory = { name?: string; gpu?: string; path?: string; alive?: boolean }

function remember(ctx: Ctx, patch: Memory): void {
  if (ctx.dryRun) return
  const next: Memory = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key as keyof Memory] = value as never
  }
  if (Object.keys(next).length > 0) ctx.env.writeState(next)
}

/** Имя среды для шапки: названное или взятое из адреса. */
function envLabel(name: Value, host: Value): string {
  if (name.value) return name.value
  return host.value ? label(host.value) : ''
}

export const commands: Command[] = [
  {
    name: 'vast up',
    group: 'vast',
    summary: 'Арендовать машину с GPU и развернуть на ней Colloq',
    usage: 'colloq vast up [среда] [--host <имя>] [--gpu <карта>] [--release <путь>] [--replace]',
    args: [
      {
        name: 'среда',
        summary: 'Имя среды: hse, demo. Без него — единственная среда',
        makeVar: 'NAME',
      },
    ],
    flags: [
      { name: 'host', arg: 'имя', summary: 'Адрес наружу: hse.colloq.ru или поддомен hse' },
      { name: 'gpu', short: 'g', arg: 'карта', summary: 'Какую карту искать: "RTX 5070"' },
      { name: 'release', arg: 'путь', summary: 'k3s-путь по манифесту; без него — прежний путь' },
      { name: 'replace', summary: 'Развернуть копию поверх непустой базы (REPLACE=1)' },
    ],
    destructive: true,
    // Про цену спрашивает сам скрипт: показывает ставку и стоимость пары часов.
    // Второй вопрос подряд перестают читать, поэтому своего здесь нет.
    confirm: 'script',
    delegates: 'make vast-up NAME=… HOST=… GPU=… [RELEASE=…] [REPLACE=1] [FORCE=1]',
    examples: [
      'colloq vast up hse --host {domain} --gpu "RTX 5070"',
      'colloq vast up hse --release /путь/release.json --dry-run',
    ],
    notes:
      'Имя среды — это и метка на vast, и подкаталог backups/, и поддомен: буквы, цифры и дефис в середине.\nБез --release идёт прежний путь: рабочее дерево, фильтрованный .env и systemd. Повторный vast up по живой машине — путь обновления, здоровый адрес он не трогает.\n--yes = FORCE=1, без вопроса о цене; без терминала и без FORCE=1 скрипт откажет, и это правильно.',
    async run(ctx) {
      noExtra(ctx, 1, USAGE.up)
      const name = either(ctx, ctx.positionals[0], 'NAME')
      const host = either(ctx, str(ctx, 'host'), 'HOST')
      const gpu = either(ctx, str(ctx, 'gpu'), 'GPU')
      checkName(name.value)
      checkHost(host.value)
      checkPair(name.value, host.value)
      const rel = release(ctx)
      const replace = yes(ctx, 'replace') || ctx.makeVars.REPLACE === '1'
      if (replace && rel.value) {
        note(ctx, 'REPLACE=1 живёт в прежнем пути; в k3s-пути копию разворачивает restore')
      }
      const where = envLabel(name, host)
      head(ctx, 'арендую машину и разворачиваю' + (where ? ' среду ' + where : ' Colloq'))
      const code = await ctx.sh.make('vast-up', {
        NAME: name.pass,
        HOST: host.pass,
        GPU: gpu.pass,
        RELEASE: rel.pass,
        REPLACE: own(ctx, 'REPLACE', yes(ctx, 'replace') ? '1' : undefined),
        FORCE: own(ctx, 'FORCE', ctx.yes ? '1' : undefined),
      })
      // Ни цены, ни токенов: их пришлось бы разбирать из чужого потока, а поток
      // подчинённого процесса мы не трогаем вовсе.
      remember(ctx, {
        name: where || undefined,
        gpu: gpu.value,
        path: rel.value ? 'k3s' : 'прежний',
        alive: code === 0 ? true : undefined,
      })
      return code
    },
  },
  {
    name: 'vast status',
    aliases: ['vast ls'],
    group: 'vast',
    summary: 'Что арендовано: все среды или подробности одной',
    usage: 'colloq vast status [среда] [--release <путь>]',
    args: [{ name: 'среда', summary: 'Имя среды. Без него — все сразу', makeVar: 'NAME' }],
    flags: [{ name: 'release', arg: 'путь', summary: 'Спрашивать k3s-путём (scripts/vast.sh)' }],
    destructive: false,
    delegates: 'make vast-status NAME=… [RELEASE=…]',
    examples: ['colloq vast status', 'colloq vast status hse'],
    notes:
      'В отличие от colloq status ходит в сеть: спрашивает vast API и пробует ssh. Читает tmux-сессию colloq-host и /opt/colloq/host.log — единственную улику того, опубликован ли семинар.\n--json здесь нет: скрипт печатает человеку, а своего JSON CLI не сочиняет.',
    async run(ctx) {
      noExtra(ctx, 1, USAGE.status)
      const name = either(ctx, ctx.positionals[0], 'NAME')
      checkName(name.value)
      const rel = release(ctx)
      const code = await ctx.sh.make('vast-status', { NAME: name.pass, RELEASE: rel.pass })
      remember(ctx, { name: name.value })
      return code
    },
  },
  {
    name: 'vast sync',
    group: 'vast',
    summary: 'Снять копию с арендованной машины в backups/<среда>/',
    usage: 'colloq vast sync [среда] [--mode <live|consistent>] [--resume] [--release <путь>]',
    args: [{ name: 'среда', summary: 'Имя среды: при двух средах обязательно', makeVar: 'NAME' }],
    flags: [
      {
        name: 'mode',
        arg: 'live|consistent',
        summary: 'consistent — остановить писателей на время копии',
      },
      { name: 'resume', summary: 'Поднять писателей обратно после consistent-копии' },
      { name: 'release', arg: 'путь', summary: 'k3s-путь: только там действуют MODE и RESUME' },
    ],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => modeOf(ctx) === 'consistent',
    confirmQuestion:
      'снять согласованную копию? писатели на той машине встанут, без --resume так и останутся',
    // Комнаты каркас считает на ЭТОЙ машине, а писатели встанут на арендованной:
    // число здесь только сбивало бы.
    rooms: false,
    delegates: 'make vast-sync NAME=… [MODE=…] [RESUME=1] [RELEASE=…]',
    examples: [
      'colloq vast sync hse',
      'colloq vast sync hse --mode consistent --resume --release /путь/release.json',
    ],
    notes:
      'MODE и RESUME действуют в k3s-пути; в прежнем их нет вовсе, и заданные без --release они ничего не меняют.\nПрежний путь тянет пару .db + -files.tar.gz и громко падает, если половины с файлами нет; k3s-путь проверяет архив и без проверки не считает дело сделанным.',
    async run(ctx) {
      noExtra(ctx, 1, USAGE.sync)
      const name = either(ctx, ctx.positionals[0], 'NAME')
      checkName(name.value)
      const rel = release(ctx)
      const mode = either(ctx, str(ctx, 'mode'), 'MODE')
      if (mode.value !== undefined && mode.value !== 'live' && mode.value !== 'consistent') {
        throw new UsageError(
          'копия бывает live или consistent, а не «' + mode.value + '»',
          'Употребление: ' + USAGE.sync,
        )
      }
      const resumePair = ctx.makeVars.RESUME
      if (resumePair !== undefined && resumePair !== '0' && resumePair !== '1') {
        throw new UsageError('RESUME=0 или RESUME=1', 'Употребление: ' + USAGE.sync)
      }
      const resume = yes(ctx, 'resume')
      if (!rel.value && (mode.value !== undefined || resume || resumePair !== undefined)) {
        note(ctx, 'в прежнем пути MODE и RESUME не действуют: копия снимается как есть')
      }
      head(ctx, 'снимаю копию' + (name.value ? ' среды ' + name.value : ''))
      const code = await ctx.sh.make('vast-sync', {
        NAME: name.pass,
        MODE: mode.pass,
        RESUME: own(ctx, 'RESUME', resume ? '1' : undefined),
        RELEASE: rel.pass,
      })
      remember(ctx, { name: name.value })
      return code
    },
  },
  {
    name: 'vast logs',
    group: 'vast',
    summary: 'Забрать журналы с арендованной машины в logs/<среда>/<дата>/',
    usage: 'colloq vast logs [среда] [--since <окно>] [--release <путь>]',
    args: [{ name: 'среда', summary: 'Имя среды: чей журнал забираем', makeVar: 'NAME' }],
    flags: [
      {
        name: 'since',
        arg: 'окно',
        summary: 'k3s-путь: 2h, 30m. Прежний: today, -2h, "2026-09-06 10:00"',
      },
      { name: 'release', arg: 'путь', summary: 'k3s-путь (scripts/vast.sh)' },
    ],
    destructive: false,
    delegates: 'make vast-logs NAME=… [SINCE=…] [RELEASE=…]',
    examples: [
      'colloq vast logs hse --since=-2h',
      'colloq vast logs hse --since 2h --release /путь/release.json',
    ],
    notes:
      'Словари окна у путей разные, и CLI их не переводит: k3s-путь требует длительность (умолчание 2h), прежний говорит словами journalctl (умолчание today).\nОкно, начинающееся с минуса, пишут через знак равенства: --since=-2h или парой SINCE=-2h — иначе разбор argv примет его за флаг.\nПрежний путь забирает и docker logs каждой комнаты, включая остановленные, — там и лежит причина остановки. Секреты режутся в трубе до записи на диск, но в logs/ всё равно лежит чужая пара: каталог в .gitignore, и CLI оттуда ничего не печатает.',
    async run(ctx) {
      noExtra(ctx, 1, USAGE.logs)
      const name = either(ctx, ctx.positionals[0], 'NAME')
      checkName(name.value)
      const rel = release(ctx)
      const since = either(ctx, str(ctx, 'since'), 'SINCE')
      if (since.value !== undefined) {
        if (rel.value && !SINCE_K3S.test(since.value)) {
          throw new UsageError(
            'окно «' + since.value + '» не годится: в k3s-пути это длительность',
            'например: --since 30m · --since 2h · --since 86400s',
          )
        }
        if (!rel.value && !SINCE_LEGACY.test(since.value)) {
          throw new UsageError(
            'окно «' +
              since.value +
              '» не годится: буквы, цифры, пробел, двоеточие, запятая и минус',
            'например: --since today · --since=-2h · --since "2026-09-06 10:00" · SINCE=-2h',
          )
        }
      }
      head(ctx, 'забираю журналы' + (name.value ? ' среды ' + name.value : ''))
      const code = await ctx.sh.make('vast-logs', {
        NAME: name.pass,
        SINCE: since.pass,
        RELEASE: rel.pass,
      })
      remember(ctx, { name: name.value })
      return code
    },
  },
  {
    name: 'vast down',
    group: 'vast',
    summary: 'Уничтожить арендованную машину вместе со всем, что на ней',
    usage: 'colloq vast down [среда] [--release <путь>]',
    args: [{ name: 'среда', summary: 'Имя среды: при двух средах обязательно', makeVar: 'NAME' }],
    flags: [{ name: 'release', arg: 'путь', summary: 'k3s-путь (scripts/vast.sh)' }],
    destructive: true,
    // Вопрос и есть защита: скрипт показывает возраст последней местной копии и
    // просит напечатать слово «уничтожить». Своего вопроса здесь нет.
    confirm: 'script',
    delegates: 'make vast-down NAME=… [RELEASE=…] [FORCE=1]',
    examples: ['colloq vast down hse', 'colloq vast down hse --dry-run'],
    notes:
      'Скрипт сначала показывает возраст последней копии в backups/, потом просит напечатать «уничтожить».\n--yes = FORCE=1 и снимает именно эту защиту. Снимков нет: после этого на машине не остаётся ничего.',
    async run(ctx) {
      noExtra(ctx, 1, USAGE.down)
      const name = either(ctx, ctx.positionals[0], 'NAME')
      checkName(name.value)
      const rel = release(ctx)
      head(ctx, 'уничтожаю машину' + (name.value ? ' среды ' + name.value : ''))
      const code = await ctx.sh.make('vast-down', {
        NAME: name.pass,
        RELEASE: rel.pass,
        FORCE: own(ctx, 'FORCE', ctx.yes ? '1' : undefined),
      })
      // Среда помечается мёртвой, чтобы colloq status не показывал её живой по памяти.
      if (code === 0) remember(ctx, { name: name.value, alive: false })
      return code
    },
  },
  {
    name: 'vast adopt',
    group: 'vast',
    summary: 'Назвать средой машину со старой меткой «colloq»',
    usage: 'colloq vast adopt <среда>',
    args: [
      { name: 'среда', summary: 'Новое имя среды: hse, demo', required: true, makeVar: 'NAME' },
    ],
    flags: [],
    destructive: true,
    // Спрашивает сам: показывает инстанс, карту, ставку и адрес, который он обслуживает.
    confirm: 'script',
    delegates: 'make vast-adopt NAME=… (всегда scripts/vast.sh, даже без RELEASE)',
    examples: ['colloq vast adopt hse', 'colloq vast adopt hse --dry-run'],
    notes:
      'Метка меняется у живого инстанса: семинар не прерывается, диск и туннель остаются как есть. Разовая миграция для машины, арендованной до того, как сред стало несколько.\nИмя обязательно: без него отказывает Makefile. --yes = FORCE=1.',
    async run(ctx) {
      noExtra(ctx, 1, USAGE.adopt)
      const name = either(ctx, ctx.positionals[0], 'NAME')
      // Обязательность аргумента объявлена каркасу (args.required + makeVar),
      // он же и откажет — здесь остаётся только сито имени.
      checkName(name.value)
      head(ctx, 'называю машину средой ' + name.value)
      const code = await ctx.sh.make('vast-adopt', {
        NAME: name.pass,
        FORCE: own(ctx, 'FORCE', ctx.yes ? '1' : undefined),
      })
      if (code === 0) remember(ctx, { name: name.value, alive: true })
      return code
    },
  },
  {
    name: 'install',
    group: 'vast',
    summary: 'Установить версию k3s на этой Linux-машине',
    usage: 'colloq install --release <путь>',
    flags: [{ name: 'release', arg: 'путь', summary: 'Манифест версии: release.json' }],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => {
      checkRestore(ctx)
      needRelease(ctx, USAGE.install)
      return true
    },
    confirmQuestion: 'поставить релиз и перезапустить всё?',
    delegates: 'make install RELEASE=… (scripts/cluster.sh install)',
    examples: [
      'colloq install --release /путь/release.json',
      'colloq install --release ./release.json --dry-run',
    ],
    notes:
      'Ставится k3s, правится firewall, тянутся образы, перезапускается всё. Относительный путь разрешается от каталога, где вы стоите.\nБлокируется маркером .restore-in-progress в /var/lib/colloq: прерванное восстановление сначала доводят до конца.',
    async run(ctx) {
      noExtra(ctx, 0, USAGE.install)
      checkRestore(ctx)
      const rel = needRelease(ctx, USAGE.install)
      head(ctx, 'ставлю релиз')
      const code = await ctx.sh.make('install', { RELEASE: rel.pass })
      remember(ctx, { path: rel.value })
      return code
    },
  },
  {
    name: 'update',
    group: 'vast',
    summary: 'Обновить до явной версии',
    usage: 'colloq update --release <путь>',
    flags: [{ name: 'release', arg: 'путь', summary: 'Манифест версии: release.json' }],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => {
      checkRestore(ctx)
      needRelease(ctx, USAGE.update)
      return true
    },
    confirmQuestion: 'обновить? живые комнаты будут убиты',
    delegates: 'make update RELEASE=… (scripts/cluster.sh update)',
    examples: [
      'colloq update --release /путь/release.json',
      'colloq update --release ./release.json --dry-run',
    ],
    notes:
      'Требует проверенной копии до себя — это правило живёт в cluster.sh, CLI его не повторяет и не подменяет.\nКаждый релиз прибивает digest образов, sourceCommit и хэши инструментов.',
    async run(ctx) {
      noExtra(ctx, 0, USAGE.update)
      checkRestore(ctx)
      const rel = needRelease(ctx, USAGE.update)
      head(ctx, 'обновляю до этой версии')
      const code = await ctx.sh.make('update', { RELEASE: rel.pass })
      remember(ctx, { path: rel.value })
      return code
    },
  },
  {
    name: 'rollback',
    group: 'vast',
    summary: 'Вернуть совместимую версию',
    usage: 'colloq rollback --release <путь>',
    flags: [{ name: 'release', arg: 'путь', summary: 'Манифест версии, к которой возвращаемся' }],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => {
      checkRestore(ctx)
      needRelease(ctx, USAGE.rollback)
      return true
    },
    confirmQuestion: 'вернуть эту версию? писатели перезапустятся, состояние ядер потеряется',
    delegates: 'make rollback RELEASE=… (scripts/cluster.sh rollback)',
    examples: [
      'colloq rollback --release /путь/release.json',
      'colloq rollback --release ./release.json --dry-run',
    ],
    notes: 'Цена та же, что у update: писатели перезапускаются, состояние ядер теряется.',
    async run(ctx) {
      noExtra(ctx, 0, USAGE.rollback)
      checkRestore(ctx)
      const rel = needRelease(ctx, USAGE.rollback)
      head(ctx, 'возвращаю эту версию')
      const code = await ctx.sh.make('rollback', { RELEASE: rel.pass })
      remember(ctx, { path: rel.value })
      return code
    },
  },
  {
    name: 'cluster start',
    group: 'vast',
    summary: 'Запустить установленное приложение k3s',
    usage: 'colloq cluster start',
    flags: [],
    destructive: false,
    delegates: 'make cluster-start (scripts/cluster.sh start)',
    examples: ['colloq cluster start', 'colloq cluster start --dry-run'],
    notes:
      'Именно это поднимает писателей после consistent-копии или неудачного восстановления. В make help этой цели нет, здесь есть.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq cluster start')
      head(ctx, 'поднимаю приложение')
      return await ctx.sh.make('cluster-start')
    },
  },
  {
    name: 'cluster stop',
    group: 'vast',
    summary: 'Остановить приложение k3s (все писатели)',
    usage: 'colloq cluster stop',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'остановить приложение? встанут app, брокер и каждая комната',
    delegates: 'make cluster-stop (scripts/cluster.sh stop)',
    examples: ['colloq cluster stop', 'colloq cluster stop --yes'],
    notes: 'Поднять обратно: colloq cluster start.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq cluster stop')
      head(ctx, 'останавливаю приложение')
      return await ctx.sh.make('cluster-stop')
    },
  },
  {
    name: 'cluster status',
    group: 'vast',
    summary: 'Что в кластере: развёртывания, поды, тома, здоровье',
    usage: 'colloq cluster status',
    flags: [],
    destructive: false,
    delegates: 'make cluster-status (scripts/cluster.sh status)',
    examples: ['colloq cluster status', 'colloq cluster status --dry-run'],
    notes:
      'k get deployments,pods,pvc плюс проверка 127.0.0.1:30080/api/health. Нужен установленный k3s; на маке просто откажет, и текст отказа — от скрипта.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq cluster status')
      return await ctx.sh.make('cluster-status')
    },
  },
  {
    name: 'cluster logs',
    group: 'vast',
    summary: 'Смотреть журнал приложения в кластере',
    usage: 'colloq cluster logs',
    flags: [],
    destructive: false,
    delegates: 'make cluster-logs (scripts/cluster.sh logs)',
    examples: ['colloq cluster logs', 'colloq cluster logs --dry-run'],
    notes: 'k logs -f deployment/colloq-app --tail=80. Ctrl+C уходит ребёнку.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq cluster logs')
      return await ctx.sh.make('cluster-logs')
    },
  },
  {
    name: 'service install',
    group: 'vast',
    summary: 'Поставить k3s по релизу — прежнее имя цели',
    usage: 'colloq service install --release <путь>',
    flags: [{ name: 'release', arg: 'путь', summary: 'Манифест версии: release.json' }],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => {
      checkRestore(ctx)
      needRelease(ctx, USAGE.serviceInstall)
      return true
    },
    confirmQuestion: 'поставить релиз и перезапустить всё?',
    delegates: 'make service-install RELEASE=… (scripts/service.sh → cluster.sh install)',
    examples: [
      'colloq service install --release /путь/release.json',
      'colloq service install --release ./release.json --dry-run',
    ],
    notes:
      'Имя говорит «служба», поведение теперь k3s — это шим совместимости. Настоящий установщик systemd (scripts/service-legacy.sh) не привязан ни к одной цели и зовётся по ssh из vast-legacy.sh; CLI его не зовёт вовсе.',
    async run(ctx) {
      noExtra(ctx, 0, USAGE.serviceInstall)
      checkRestore(ctx)
      const rel = needRelease(ctx, USAGE.serviceInstall)
      head(ctx, 'ставлю релиз')
      const code = await ctx.sh.make('service-install', { RELEASE: rel.pass })
      remember(ctx, { path: rel.value })
      return code
    },
  },
  {
    name: 'service restart',
    group: 'vast',
    summary: 'Перезапустить приложение и дождаться готовности',
    usage: 'colloq service restart',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'перезапустить? это стоп и старт всех писателей',
    delegates: 'make service-restart (service.sh: cluster.sh stop, затем start)',
    examples: ['colloq service restart', 'colloq service restart --yes'],
    notes:
      'Это не мягкий перезапуск: сначала останавливаются все писатели, потом поднимаются заново.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq service restart')
      head(ctx, 'перезапускаю приложение')
      return await ctx.sh.make('service-restart')
    },
  },
  {
    name: 'service stop',
    group: 'vast',
    summary: 'Остановить приложение (ядра комнат остаются жить)',
    usage: 'colloq service stop',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'остановить приложение?',
    delegates: 'make service-stop (cluster.sh stop)',
    examples: ['colloq service stop', 'colloq service stop --yes'],
    notes: 'Поднять обратно: colloq cluster start.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq service stop')
      head(ctx, 'останавливаю приложение')
      return await ctx.sh.make('service-stop')
    },
  },
  {
    name: 'service status',
    group: 'vast',
    summary: 'Жива ли служба и готова ли вести семинар',
    usage: 'colloq service status',
    flags: [],
    destructive: false,
    delegates: 'make service-status (cluster.sh status)',
    examples: ['colloq service status', 'colloq service status --dry-run'],
    notes: 'Местная проверка здоровья на 127.0.0.1:30080. В сеть не ходит.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq service status')
      return await ctx.sh.make('service-status')
    },
  },
  {
    name: 'service logs',
    group: 'vast',
    summary: 'Смотреть журнал службы',
    usage: 'colloq service logs',
    flags: [],
    destructive: false,
    delegates: 'make service-logs (cluster.sh logs)',
    examples: ['colloq service logs', 'colloq service logs --dry-run'],
    notes: 'То же, что cluster logs; оставлено, потому что так его зовут руками.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq service logs')
      return await ctx.sh.make('service-logs')
    },
  },
  {
    name: 'release validate',
    group: 'vast',
    summary: 'Проверить манифест релиза',
    usage: 'colloq release validate --release <путь>',
    flags: [{ name: 'release', arg: 'путь', summary: 'Манифест версии: release.json' }],
    destructive: false,
    delegates: 'make release-validate RELEASE=… (python3 scripts/release.py validate)',
    examples: [
      'colloq release validate --release /путь/release.json',
      'colloq release validate --release ./release.json --dry-run',
    ],
    notes:
      'Нужен python3. Цели нет в make help, а это единственный способ узнать про манифест до install.',
    async run(ctx) {
      noExtra(ctx, 0, USAGE.validate)
      const rel = needRelease(ctx, USAGE.validate)
      return await ctx.sh.make('release-validate', { RELEASE: rel.pass })
    },
  },
]

/** Какую копию просят: флагом или парой MODE=…. */
function modeOf(ctx: Ctx): string | undefined {
  return str(ctx, 'mode') ?? ctx.makeVars.MODE
}

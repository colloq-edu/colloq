/**
 * Машины и версии — арендованное железо и то, что на нём стоит.
 *
 * Цели группы: vast up, vast status, vast sync, vast logs, vast down,
 * vast adopt, install, update, rollback, cluster start, cluster stop,
 * cluster status, cluster logs, service install, service restart,
 * service stop, service status, service logs, release validate.
 *
 * В поверхности преподавателя (COLLOQ_SURFACE=teacher) не видно ни одной:
 * группа целиком мастерская. Аренда железа, установка релиза, откат, кластер и
 * служба — это работа с чужими машинами, и тому, кто ведёт занятие на своём
 * ноутбуке, показывать её незачем. Ничего не удалено: по точному имени
 * команда работает и там.
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
  up: 'colloq vast up [environment] [--host <name>] [--gpu <card>] [--release <path>] [--replace]',
  status: 'colloq vast status [environment] [--release <path>]',
  sync: 'colloq vast sync [environment] [--mode <live|consistent>] [--resume] [--release <path>]',
  logs: 'colloq vast logs [environment] [--since <window>] [--release <path>]',
  down: 'colloq vast down [environment] [--release <path>]',
  adopt: 'colloq vast adopt <environment>',
  install: 'colloq install --release <path>',
  update: 'colloq update --release <path>',
  rollback: 'colloq rollback --release <path>',
  serviceInstall: 'colloq service install --release <path>',
  validate: 'colloq release validate --release <path>',
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
      'environment name “' + name + '” will not do',
      'it is also the subdomain, the label on vast and the backups/ subdirectory: letters, digits and a hyphen in the middle — hse, hse-2026',
    )
  }
}

function checkHost(host: string | undefined): void {
  if (host === undefined) return
  if (!HOST_OK.test(host) || host.startsWith('.') || host.endsWith('.')) {
    throw new UsageError(
      'the address “' + host + '” has characters that do not belong',
      'expecting a name like hse.colloq.ru or a subdomain: --host hse',
    )
  }
  checkName(label(host))
}

/** Среда и адрес — одно слово: разойтись им нельзя, и отказ дешевле до аренды. */
function checkPair(name: string | undefined, host: string | undefined): void {
  if (name === undefined || host === undefined) return
  if (label(host) !== name) {
    throw new UsageError(
      'environment “' + name + '” and address “' + host + '” are different names',
      'the environment name and the first part of the address are one word: colloq vast up ' +
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
    'no release file: ' + path,
    'check the manifest before installing: colloq release validate --release <path>',
  )
}

/** Релиз обязателен: k3s ставится только явной версией. */
function needRelease(ctx: Ctx, usage: string): Value {
  const found = release(ctx)
  if (found.value === undefined) {
    throw new UsageError('missing required flag --release', 'Usage: ' + usage)
  }
  return found
}

/** Прерванное восстановление доводят до конца — до него ничего не ставим. */
function checkRestore(ctx: Ctx): void {
  const marker = joinPath(ctx.env.paths.clusterState, '.restore-in-progress')
  if (!ctx.io.exists(marker)) return
  throw new PreconditionError(
    'a restore was left unfinished on this machine',
    'finish it first: make restore ARCHIVE=backup.tar.gz RELEASE=/path/release.json',
  )
}

function noExtra(ctx: Ctx, allowed: number, usage: string): void {
  if (ctx.positionals.length <= allowed) return
  throw new UsageError('extra argument: ' + (ctx.positionals[allowed] ?? ''), 'Usage: ' + usage)
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
    summary: 'Rent a GPU machine and deploy Colloq on it',
    usage:
      'colloq vast up [environment] [--host <name>] [--gpu <card>] [--release <path>] [--replace]',
    args: [
      {
        name: 'environment',
        summary: 'Environment name: hse, demo. Without it, the only environment',
        makeVar: 'NAME',
      },
    ],
    flags: [
      { name: 'host', arg: 'name', summary: 'Public address: hse.colloq.ru or the subdomain hse' },
      { name: 'gpu', short: 'g', arg: 'card', summary: 'Which card to look for: "RTX 5070"' },
      {
        name: 'release',
        arg: 'path',
        summary: 'The k3s path, by manifest; without it, the legacy path',
      },
      { name: 'replace', summary: 'Restore a backup over a non-empty database (REPLACE=1)' },
    ],
    destructive: true,
    // Про цену спрашивает сам скрипт: показывает ставку и стоимость пары часов.
    // Второй вопрос подряд перестают читать, поэтому своего здесь нет.
    confirm: 'script',
    delegates: 'make vast-up NAME=… HOST=… GPU=… [RELEASE=…] [REPLACE=1] [FORCE=1]',
    examples: [
      'colloq vast up hse --host {domain} --gpu "RTX 5070"',
      'colloq vast up hse --release /path/release.json --dry-run',
    ],
    notes:
      'The environment name is at once the label on vast, the backups/ subdirectory and the subdomain: letters, digits and a hyphen in the middle.\nWithout --release the legacy path runs: the working tree, a filtered .env and systemd. A second vast up against a live machine is the update path, and it leaves a healthy address alone.\n--yes = FORCE=1, with no question about the price; with no terminal and no FORCE=1 the script refuses, and that is right.',
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
        note(
          ctx,
          'REPLACE=1 belongs to the legacy path; on the k3s path a backup is restored by restore',
        )
      }
      const where = envLabel(name, host)
      head(ctx, 'renting a machine and deploying' + (where ? ' environment ' + where : ' Colloq'))
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
        path: rel.value ? 'k3s' : 'legacy',
        alive: code === 0 ? true : undefined,
      })
      return code
    },
  },
  {
    name: 'vast status',
    aliases: ['vast ls'],
    group: 'vast',
    summary: 'What is rented: every environment, or one in detail',
    usage: 'colloq vast status [environment] [--release <path>]',
    args: [
      {
        name: 'environment',
        summary: 'Environment name. Without it, all at once',
        makeVar: 'NAME',
      },
    ],
    flags: [{ name: 'release', arg: 'path', summary: 'Ask along the k3s path (scripts/vast.sh)' }],
    destructive: false,
    delegates: 'make vast-status NAME=… [RELEASE=…]',
    examples: ['colloq vast status', 'colloq vast status hse'],
    notes:
      'Unlike colloq status it goes to the network: it asks the vast API and tries ssh. It reads the colloq-host tmux session and /opt/colloq/host.log — the only evidence of whether a class is published.\nThere is no --json here: the script prints for a human, and the CLI does not invent JSON of its own.',
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
    summary: 'Take a backup from the rented machine into backups/<environment>/',
    usage:
      'colloq vast sync [environment] [--mode <live|consistent>] [--resume] [--release <path>]',
    args: [
      {
        name: 'environment',
        summary: 'Environment name: required once there are two',
        makeVar: 'NAME',
      },
    ],
    flags: [
      {
        name: 'mode',
        arg: 'live|consistent',
        summary: 'consistent — stop the writers for the duration of the backup',
      },
      { name: 'resume', summary: 'Bring the writers back up after a consistent backup' },
      { name: 'release', arg: 'path', summary: 'The k3s path: MODE and RESUME work only there' },
    ],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => modeOf(ctx) === 'consistent',
    confirmQuestion:
      'take a consistent backup? the writers on that machine will stop, and without --resume they stay stopped',
    // Комнаты каркас считает на ЭТОЙ машине, а писатели встанут на арендованной:
    // число здесь только сбивало бы.
    rooms: false,
    delegates: 'make vast-sync NAME=… [MODE=…] [RESUME=1] [RELEASE=…]',
    examples: [
      'colloq vast sync hse',
      'colloq vast sync hse --mode consistent --resume --release /path/release.json',
    ],
    notes:
      'MODE and RESUME work on the k3s path; on the legacy one they do not exist at all, and set without --release they change nothing.\nThe legacy path pulls the .db + -files.tar.gz pair and falls over loudly when the half with the files is missing; the k3s path verifies the archive and does not count the job done without that check.',
    async run(ctx) {
      noExtra(ctx, 1, USAGE.sync)
      const name = either(ctx, ctx.positionals[0], 'NAME')
      checkName(name.value)
      const rel = release(ctx)
      const mode = either(ctx, str(ctx, 'mode'), 'MODE')
      if (mode.value !== undefined && mode.value !== 'live' && mode.value !== 'consistent') {
        throw new UsageError(
          'a backup is live or consistent, not “' + mode.value + '”',
          'Usage: ' + USAGE.sync,
        )
      }
      const resumePair = ctx.makeVars.RESUME
      if (resumePair !== undefined && resumePair !== '0' && resumePair !== '1') {
        throw new UsageError('RESUME=0 or RESUME=1', 'Usage: ' + USAGE.sync)
      }
      const resume = yes(ctx, 'resume')
      if (!rel.value && (mode.value !== undefined || resume || resumePair !== undefined)) {
        note(ctx, 'on the legacy path MODE and RESUME do nothing: the backup is taken as is')
      }
      head(ctx, 'taking a backup' + (name.value ? ' of environment ' + name.value : ''))
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
    summary: 'Fetch the logs from the rented machine into logs/<environment>/<date>/',
    usage: 'colloq vast logs [environment] [--since <window>] [--release <path>]',
    args: [
      { name: 'environment', summary: 'Environment name: whose log we fetch', makeVar: 'NAME' },
    ],
    flags: [
      {
        name: 'since',
        arg: 'window',
        summary: 'The k3s path: 2h, 30m. The legacy one: today, -2h, "2026-09-06 10:00"',
      },
      { name: 'release', arg: 'path', summary: 'The k3s path (scripts/vast.sh)' },
    ],
    destructive: false,
    delegates: 'make vast-logs NAME=… [SINCE=…] [RELEASE=…]',
    examples: [
      'colloq vast logs hse --since=-2h',
      'colloq vast logs hse --since 2h --release /path/release.json',
    ],
    notes:
      'The two paths speak different window dialects and the CLI does not translate between them: the k3s path wants a duration (default 2h), the legacy one speaks the words of journalctl (default today).\nA window that starts with a minus is written through an equals sign: --since=-2h, or as the pair SINCE=-2h — otherwise the argv parser takes it for a flag.\nThe legacy path also takes the docker logs of every room, stopped ones included: that is where the reason for a stop lies. Secrets are cut out in the pipe before anything reaches the disk, but logs/ still holds someone else’s class: the directory is in .gitignore, and the CLI prints nothing from there.',
    async run(ctx) {
      noExtra(ctx, 1, USAGE.logs)
      const name = either(ctx, ctx.positionals[0], 'NAME')
      checkName(name.value)
      const rel = release(ctx)
      const since = either(ctx, str(ctx, 'since'), 'SINCE')
      if (since.value !== undefined) {
        if (rel.value && !SINCE_K3S.test(since.value)) {
          throw new UsageError(
            'window “' + since.value + '” will not do: on the k3s path it is a duration',
            'for example: --since 30m · --since 2h · --since 86400s',
          )
        }
        if (!rel.value && !SINCE_LEGACY.test(since.value)) {
          throw new UsageError(
            'window “' +
              since.value +
              '” will not do: letters, digits, space, colon, comma and minus',
            'for example: --since today · --since=-2h · --since "2026-09-06 10:00" · SINCE=-2h',
          )
        }
      }
      head(ctx, 'fetching logs' + (name.value ? ' of environment ' + name.value : ''))
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
    summary: 'Destroy the rented machine along with everything on it',
    usage: 'colloq vast down [environment] [--release <path>]',
    args: [
      {
        name: 'environment',
        summary: 'Environment name: required once there are two',
        makeVar: 'NAME',
      },
    ],
    flags: [{ name: 'release', arg: 'path', summary: 'The k3s path (scripts/vast.sh)' }],
    destructive: true,
    // Вопрос и есть защита: скрипт показывает возраст последней местной копии и
    // просит напечатать слово «уничтожить». Своего вопроса здесь нет.
    confirm: 'script',
    delegates: 'make vast-down NAME=… [RELEASE=…] [FORCE=1]',
    examples: ['colloq vast down hse', 'colloq vast down hse --dry-run'],
    notes:
      'The script first shows the age of the last backup in backups/, then asks you to type the word it prints.\n--yes = FORCE=1 and takes off exactly that guard. There are no snapshots: after this nothing is left on the machine.',
    async run(ctx) {
      noExtra(ctx, 1, USAGE.down)
      const name = either(ctx, ctx.positionals[0], 'NAME')
      checkName(name.value)
      const rel = release(ctx)
      head(ctx, 'destroying the machine' + (name.value ? ' of environment ' + name.value : ''))
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
    summary: 'Name a machine with the old “colloq” label as an environment',
    usage: 'colloq vast adopt <environment>',
    args: [
      {
        name: 'environment',
        summary: 'New environment name: hse, demo',
        required: true,
        makeVar: 'NAME',
      },
    ],
    flags: [],
    destructive: true,
    // Спрашивает сам: показывает инстанс, карту, ставку и адрес, который он обслуживает.
    confirm: 'script',
    delegates: 'make vast-adopt NAME=… (always scripts/vast.sh, even without RELEASE)',
    examples: ['colloq vast adopt hse', 'colloq vast adopt hse --dry-run'],
    notes:
      'The label changes on a live instance: the class is not interrupted, the disk and the tunnel stay as they are. A one-off migration for a machine rented back when there was only one environment.\nThe name is required: without it the Makefile refuses. --yes = FORCE=1.',
    async run(ctx) {
      noExtra(ctx, 1, USAGE.adopt)
      const name = either(ctx, ctx.positionals[0], 'NAME')
      // Обязательность аргумента объявлена каркасу (args.required + makeVar),
      // он же и откажет — здесь остаётся только сито имени.
      checkName(name.value)
      head(ctx, 'naming the machine as environment ' + name.value)
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
    summary: 'Install a k3s version on this Linux machine',
    usage: 'colloq install --release <path>',
    flags: [{ name: 'release', arg: 'path', summary: 'Version manifest: release.json' }],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => {
      checkRestore(ctx)
      needRelease(ctx, USAGE.install)
      return true
    },
    confirmQuestion: 'install the release and restart everything?',
    delegates: 'make install RELEASE=… (scripts/cluster.sh install)',
    examples: [
      'colloq install --release /path/release.json',
      'colloq install --release ./release.json --dry-run',
    ],
    notes:
      'k3s is installed, the firewall is edited, images are pulled, everything is restarted. A relative path is resolved from the directory you are standing in.\nBlocked by the .restore-in-progress marker in /var/lib/colloq: an interrupted restore is finished first.',
    async run(ctx) {
      noExtra(ctx, 0, USAGE.install)
      checkRestore(ctx)
      const rel = needRelease(ctx, USAGE.install)
      head(ctx, 'installing the release')
      const code = await ctx.sh.make('install', { RELEASE: rel.pass })
      remember(ctx, { path: rel.value })
      return code
    },
  },
  {
    name: 'update',
    group: 'vast',
    summary: 'Update to an explicit version',
    usage: 'colloq update --release <path>',
    flags: [{ name: 'release', arg: 'path', summary: 'Version manifest: release.json' }],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => {
      checkRestore(ctx)
      needRelease(ctx, USAGE.update)
      return true
    },
    confirmQuestion: 'update? live rooms will be killed',
    delegates: 'make update RELEASE=… (scripts/cluster.sh update)',
    examples: [
      'colloq update --release /path/release.json',
      'colloq update --release ./release.json --dry-run',
    ],
    notes:
      'It requires a verified backup taken beforehand: that rule lives in cluster.sh, and the CLI neither repeats it nor stands in for it.\nEvery release nails down the image digests, the sourceCommit and the hashes of the deployment tools.',
    async run(ctx) {
      noExtra(ctx, 0, USAGE.update)
      checkRestore(ctx)
      const rel = needRelease(ctx, USAGE.update)
      head(ctx, 'updating to this version')
      const code = await ctx.sh.make('update', { RELEASE: rel.pass })
      remember(ctx, { path: rel.value })
      return code
    },
  },
  {
    name: 'rollback',
    group: 'vast',
    summary: 'Bring back a compatible version',
    usage: 'colloq rollback --release <path>',
    flags: [{ name: 'release', arg: 'path', summary: 'Manifest of the version we go back to' }],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => {
      checkRestore(ctx)
      needRelease(ctx, USAGE.rollback)
      return true
    },
    confirmQuestion: 'bring this version back? the writers restart and kernel state is lost',
    delegates: 'make rollback RELEASE=… (scripts/cluster.sh rollback)',
    examples: [
      'colloq rollback --release /path/release.json',
      'colloq rollback --release ./release.json --dry-run',
    ],
    notes: 'The price is the same as for update: the writers restart and kernel state is lost.',
    async run(ctx) {
      noExtra(ctx, 0, USAGE.rollback)
      checkRestore(ctx)
      const rel = needRelease(ctx, USAGE.rollback)
      head(ctx, 'bringing this version back')
      const code = await ctx.sh.make('rollback', { RELEASE: rel.pass })
      remember(ctx, { path: rel.value })
      return code
    },
  },
  {
    name: 'cluster start',
    group: 'vast',
    summary: 'Start the installed k3s application',
    usage: 'colloq cluster start',
    flags: [],
    destructive: false,
    delegates: 'make cluster-start (scripts/cluster.sh start)',
    examples: ['colloq cluster start', 'colloq cluster start --dry-run'],
    notes:
      'This is what brings the writers back after a consistent backup or a failed restore. The target is missing from make help; here it is present.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq cluster start')
      head(ctx, 'starting the application')
      return await ctx.sh.make('cluster-start')
    },
  },
  {
    name: 'cluster stop',
    group: 'vast',
    summary: 'Stop the k3s application (every writer)',
    usage: 'colloq cluster stop',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'stop the application? app, the broker and every room will stop',
    delegates: 'make cluster-stop (scripts/cluster.sh stop)',
    examples: ['colloq cluster stop', 'colloq cluster stop --yes'],
    notes: 'To bring it back: colloq cluster start.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq cluster stop')
      head(ctx, 'stopping the application')
      return await ctx.sh.make('cluster-stop')
    },
  },
  {
    name: 'cluster status',
    group: 'vast',
    summary: 'What is in the cluster: deployments, pods, volumes, health',
    usage: 'colloq cluster status',
    flags: [],
    destructive: false,
    delegates: 'make cluster-status (scripts/cluster.sh status)',
    examples: ['colloq cluster status', 'colloq cluster status --dry-run'],
    notes:
      'k get deployments,pods,pvc plus a check of 127.0.0.1:30080/api/health. It needs k3s installed; on a Mac it simply refuses, and the refusal text comes from the script.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq cluster status')
      return await ctx.sh.make('cluster-status')
    },
  },
  {
    name: 'cluster logs',
    group: 'vast',
    summary: 'Watch the application log in the cluster',
    usage: 'colloq cluster logs',
    flags: [],
    destructive: false,
    delegates: 'make cluster-logs (scripts/cluster.sh logs)',
    examples: ['colloq cluster logs', 'colloq cluster logs --dry-run'],
    notes: 'k logs -f deployment/colloq-app --tail=80. Ctrl+C goes to the child.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq cluster logs')
      return await ctx.sh.make('cluster-logs')
    },
  },
  {
    name: 'service install',
    group: 'vast',
    summary: 'Install k3s from a release — the old target name',
    usage: 'colloq service install --release <path>',
    flags: [{ name: 'release', arg: 'path', summary: 'Version manifest: release.json' }],
    destructive: true,
    confirm: 'cli',
    confirmWhen: async (ctx) => {
      checkRestore(ctx)
      needRelease(ctx, USAGE.serviceInstall)
      return true
    },
    confirmQuestion: 'install the release and restart everything?',
    delegates: 'make service-install RELEASE=… (scripts/service.sh → cluster.sh install)',
    examples: [
      'colloq service install --release /path/release.json',
      'colloq service install --release ./release.json --dry-run',
    ],
    notes:
      'The name says “service”, the behaviour is k3s now: this is a compatibility shim. The real systemd installer (scripts/service-legacy.sh) is not bound to any target and is called over ssh from vast-legacy.sh; the CLI never calls it at all.',
    async run(ctx) {
      noExtra(ctx, 0, USAGE.serviceInstall)
      checkRestore(ctx)
      const rel = needRelease(ctx, USAGE.serviceInstall)
      head(ctx, 'installing the release')
      const code = await ctx.sh.make('service-install', { RELEASE: rel.pass })
      remember(ctx, { path: rel.value })
      return code
    },
  },
  {
    name: 'service restart',
    group: 'vast',
    summary: 'Restart the application and wait until it is ready',
    usage: 'colloq service restart',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'restart? this is a stop and a start of every writer',
    delegates: 'make service-restart (service.sh: cluster.sh stop, then start)',
    examples: ['colloq service restart', 'colloq service restart --yes'],
    notes: 'This is not a graceful restart: every writer is stopped first, then started again.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq service restart')
      head(ctx, 'restarting the application')
      return await ctx.sh.make('service-restart')
    },
  },
  {
    name: 'service stop',
    group: 'vast',
    summary: 'Stop the application (room kernels stay alive)',
    usage: 'colloq service stop',
    flags: [],
    destructive: true,
    confirm: 'cli',
    confirmQuestion: 'stop the application?',
    delegates: 'make service-stop (cluster.sh stop)',
    examples: ['colloq service stop', 'colloq service stop --yes'],
    notes: 'To bring it back: colloq cluster start.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq service stop')
      head(ctx, 'stopping the application')
      return await ctx.sh.make('service-stop')
    },
  },
  {
    name: 'service status',
    group: 'vast',
    summary: 'Whether the service is alive and ready to run a class',
    usage: 'colloq service status',
    flags: [],
    destructive: false,
    delegates: 'make service-status (cluster.sh status)',
    examples: ['colloq service status', 'colloq service status --dry-run'],
    notes: 'A local health check on 127.0.0.1:30080. It does not go to the network.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq service status')
      return await ctx.sh.make('service-status')
    },
  },
  {
    name: 'service logs',
    group: 'vast',
    summary: 'Watch the service log',
    usage: 'colloq service logs',
    flags: [],
    destructive: false,
    delegates: 'make service-logs (cluster.sh logs)',
    examples: ['colloq service logs', 'colloq service logs --dry-run'],
    notes: 'The same as cluster logs; kept because that is how it gets called by hand.',
    async run(ctx) {
      noExtra(ctx, 0, 'colloq service logs')
      return await ctx.sh.make('service-logs')
    },
  },
  {
    name: 'release validate',
    group: 'vast',
    summary: 'Check the release manifest',
    usage: 'colloq release validate --release <path>',
    flags: [{ name: 'release', arg: 'path', summary: 'Version manifest: release.json' }],
    destructive: false,
    delegates: 'make release-validate RELEASE=… (python3 scripts/release.py validate)',
    examples: [
      'colloq release validate --release /path/release.json',
      'colloq release validate --release ./release.json --dry-run',
    ],
    notes:
      'It needs python3. The target is missing from make help, and this is the only way to learn anything about the manifest before install.',
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

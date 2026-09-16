/**
 * Занятие в сети — как аудитория попадает на эту машину.
 *
 * Цели группы: host, tunnel setup, relay setup, relay page, relay ping,
 * dns sync, dns point, sync (make host, make tunnel-setup, make relay-setup,
 * make relay-page, scripts/dns.sh, make sync).
 *
 * У поставленного пакета make звать нечем — Makefile в колесо не едет, — и host
 * идёт прямо в scripts/host.sh; разбор у publishCall ниже. Каталог состояния
 * скриптам называем сами: stateEnv.
 *
 * В поверхности преподавателя (COLLOQ_SURFACE=teacher) видна одна — host:
 * ею класс получает ссылку. host-direct, tunnel setup, relay * и dns * ставят
 * и правят чужие машины и зону, sync — стенд; это мастерская. Спрятанное
 * по-прежнему зовётся по точному имени.
 *
 * Три вещи, которые здесь не делаются намеренно.
 *
 * Инстанс не поднимается. host.sh публикует то, что уже работает: молчит
 * /api/health — он умирает с инструкцией. Второй инстанс — это вторая база,
 * и заводить её вместо человека нельзя.
 *
 * Короткое имя не достраивается. До RELAY_DOMAIN его доводит только
 * ретранслятор, и решает это host.sh: CLI, угадав зону, увёл бы пару в
 * Cloudflare, а он из России не открывается.
 *
 * Отказы скриптов не переписываются. Свои проверки — только до первого
 * действия и только о том, что видно отсюда: есть ли имя, похоже ли оно на
 * имя, есть ли .env, есть ли адрес ретранслятора.
 *
 * Порядок один у всех команд: проверить аргументы → --dry-run → предусловия →
 * вопрос → шапка в одну строку → цель Makefile или скрипт. Проверка идёт
 * первой и до вопроса: спрашивать «направить имя на этот адрес?», чтобы потом
 * сказать «это не адрес», — значит спросить зря. Поэтому у команд с вопросом
 * каркаса стоит confirmWhen: он и есть та самая проверка.
 *
 * node:child_process и node:fs импортировать нельзя: только ctx.sh и ctx.io.
 */
import type { Command, Ctx } from '../registry.js'
import { probeTcp } from '../sh.js'
import { cancelled, PreconditionError, SYMBOL, UsageError } from '../ui.js'

/**
 * Периметр локального занятия — вслух, теми же словами в двух местах.
 *
 * Решение автора: укреплений прода (cap-drop, seccomp, read-only, запрет
 * egress) на локальном пути НЕ добавляем; вместо них — честные слова. Значит,
 * сказать их надо там, где человек и решает, кого пускать: в `colloq host`
 * (сейчас он открывает занятие наружу) и в `colloq doctor` (перед парой).
 *
 * Что тут правда и почему именно так. Ядро комнаты — отдельный контейнер на
 * комнату, и чужую тетрадь студент не читает (изоляция ядер, дыра закрыта).
 * Но дальше контейнера ограничений нет: сеть наружу открыта, привилегии не
 * сняты, и всё это происходит на компьютере преподавателя и в его домашней
 * сети. Для своего класса это и есть договор — «мой класс на моём
 * компьютере»; для открытой аудитории, куда ссылку может открыть кто угодно,
 * нужна серверная установка на отдельной машине.
 *
 * Строк ровно две, и обе короткие: имя периметра — и цена вместе с выходом.
 * Одна длинная фраза не читается (у доктора она ещё и не влезает в строку
 * рядом с подписью), а третья превращает предупреждение в абзац, который
 * пролистывают. Слова одни и те же нарочно: doctor и host говорят об одном.
 *
 * Каталога shared/locales CLI не знает: tr() живёт в server и web и сюда не
 * дотягивается — строки CLI пишутся прямо там, где печатаются. Поэтому слова
 * про периметр лежат обычной константой здесь, а doctor импортирует её
 * отсюда: разойтись двум местам нельзя.
 */
export const PERIMETER = {
  what: '"my class, my computer": student code runs in a container per room, without production limits',
  fix: 'outbound network is open, privileges are not dropped; a room open to anyone needs a server install',
} as const

/** Имя в DNS: латиница, цифры, точки и дефисы — на него выпишут сертификат. */
const NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

export function hostNameOk(host: string): boolean {
  return NAME.test(host)
}

/** Адрес IPv4: A-запись другого не принимает. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Отказ в три строки: что случилось, чем вызвано, что сделать. */
type Problem = { what: string; why: string; fix: string }

/**
 * Бросить отказ об употреблении — код 2, как во всех группах. Печатает его
 * каркас, и тремя строками: что случилось, чем вызвано, что сделать.
 */
function say(problem: Problem): never {
  throw new UsageError(problem.what, problem.fix, problem.why)
}

/** Проверка до вопроса: каркас зовёт её раньше, чем спрашивает. */
function checker(find: (ctx: Ctx) => Problem | null): (ctx: Ctx) => void {
  return (ctx: Ctx) => {
    const problem = find(ctx)
    if (problem) say(problem)
  }
}

/** Значение аргумента: сначала позиционное, потом пара ВИДА=ЗНАЧЕНИЕ. */
function arg(ctx: Ctx, index: number, ...names: string[]): string {
  const typed = ctx.positionals[index]
  if (typed !== undefined && typed.trim() !== '') return typed.trim()
  for (const name of names) {
    const pair = ctx.makeVars[name]
    if (pair !== undefined && pair.trim() !== '') return pair.trim()
  }
  return ''
}

/**
 * Пара, написанная человеком, уже уедет к make сама — второй раз её не шлём,
 * иначе в строке было бы `HOST=hse HOST=hse`.
 */
function mine(ctx: Ctx, name: string, value: string): Record<string, string | undefined> {
  const pair = ctx.makeVars[name]
  if (pair !== undefined && pair.trim() !== '') return {}
  return { [name]: value || undefined }
}

/** «нет» на свой вопрос: DIM «отменено» и код 4, без красного. Слова одни на все группы. */
function stopped(ctx: Ctx): number {
  return cancelled(ctx.ui)
}

/**
 * Без .env не узнать ни порта, ни ретранслятора, ни токена зоны.
 *
 * Совет здесь стоял невыполнимый: «cp .env.example .env» — путь относительный,
 * то есть в том каталоге, где человек стоит, а .env.example у поставленного
 * пакета нет вовсе. Заводит .env первый `colloq start` и кладёт его в каталог
 * состояния, туда, где мы его и ищем (cli/src/launch-config.ts · localClassEnv);
 * туда и посылаем. В репозитории .env.example рядом, и он назван вторым.
 */
function needEnv(ctx: Ctx): void {
  if (ctx.io.exists(ctx.env.paths.envFile)) return
  throw new PreconditionError(
    'no ' + ctx.env.paths.envFile + ' — PORT, RELAY_* and CF_TOKEN are read from it',
    ctx.dist
      ? 'colloq start creates it on the first run'
      : 'colloq start creates it, or cp .env.example ' + ctx.env.paths.envFile,
  )
}

/**
 * Каталог состояния — ребёнку, явной переменной.
 *
 * Скрипты считали своим корнем каталог над scripts/ и искали там .env,
 * расписку занятия и .colloq.pid. У поставленного colloq там только
 * приложение: публикация «удавалась», PUBLIC_URL уезжал в файл, которого никто
 * не читает, а `colloq link` смотрел в <home>/.env и говорил, что наружу
 * ничего не выставлено. Теперь корень состояния скриптам называют вслух
 * (scripts/lib.sh · COLLOQ_STATE_ROOT).
 *
 * Называем всегда, а не только в пакете. В репозитории home и есть корень, и
 * переменная там ничего не меняет — зато нет развилки «когда совпадают, не
 * посылаем», которую надо не забыть повторить в следующей команде. Тем же
 * правилом живут copies и link — cli/src/commands/local.ts · stateEnv.
 */
function stateEnv(ctx: Ctx): Record<string, string> {
  return { COLLOQ_HOME: ctx.env.paths.home }
}

/* --------------------------------------------------------------- проверки */

/** Имя занятия: у прямого режима оно обязательно, у туннеля — нет. */
function hostProblem(ctx: Ctx, direct: boolean): Problem | null {
  const host = arg(ctx, 0, 'HOST')
  if (direct && !host) {
    return {
      what: 'direct mode needs a name',
      why: 'the certificate is issued for that name, and it cannot be made up for you',
      fix: 'colloq host hse.colloq.ru --direct',
    }
  }
  if (host && !hostNameOk(host)) {
    return {
      what: 'name ' + host + ' will not do',
      why: 'a name holds only latin letters, digits, dots and hyphens',
      fix: 'colloq host hse.colloq.ru',
    }
  }
  return null
}

/** Имя для постоянного адреса: только полное, в своей зоне. */
function tunnelProblem(ctx: Ctx): Problem | null {
  const host = arg(ctx, 0, 'HOST')
  if (!host) {
    return {
      what: 'no name given',
      why: 'a tunnel and a CNAME record are created for one specific name',
      fix: 'colloq tunnel setup class.example.ru',
    }
  }
  if (!NAME.test(host) || !host.includes('.')) {
    return {
      what: 'name ' + host + ' will not do',
      why: 'a full name in your own zone is needed: latin letters, digits, dots and hyphens',
      fix: 'colloq tunnel setup class.example.ru',
    }
  }
  return null
}

/** Куда ставить ретранслятор: root@адрес или имя из ~/.ssh/config. */
function whereProblem(ctx: Ctx, fix: string): Problem | null {
  const machine = arg(ctx, 0, 'WHERE')
  if (!machine) {
    return {
      what: 'no machine given',
      why: 'the relay lives on another machine, and that machine is named',
      fix,
    }
  }
  if (/\s/.test(machine) || machine.includes('://')) {
    return {
      what: 'address ' + machine + ' will not do',
      why: 'ssh expects root@address or a name from ~/.ssh/config',
      fix,
    }
  }
  return null
}

/** Зона: имя вида colloq.ru, и только если её назвали. */
function zoneProblem(ctx: Ctx): Problem | null {
  const zone = zoneOf(ctx)
  if (zone && (!NAME.test(zone) || !zone.includes('.'))) {
    return {
      what: 'zone ' + zone + ' will not do',
      why: 'a zone is a name like colloq.ru: latin letters, digits, dots and hyphens',
      fix: 'colloq dns sync --domain colloq.ru',
    }
  }
  return null
}

/** Имя и адрес для одной A-записи. */
function pointProblem(ctx: Ctx): Problem | null {
  const host = arg(ctx, 0, 'HOST', 'NAME')
  const ip = arg(ctx, 1, 'IP', 'ADDR')
  const example = 'colloq dns point hse.colloq.ru 203.0.113.10'
  if (!host) {
    return {
      what: 'no name given',
      why: 'an A record is written for one specific name, and it cannot be guessed',
      fix: example,
    }
  }
  if (!NAME.test(host) || !host.includes('.')) {
    return {
      what: 'name ' + host + ' will not do',
      why: 'a full name in the zone is needed: latin letters, digits, dots and hyphens',
      fix: example,
    }
  }
  if (!ip) {
    return {
      what: 'no address given',
      why: 'a name is pointed at a machine address, and the second argument is required',
      fix: 'colloq dns point ' + host + ' 203.0.113.10',
    }
  }
  if (!isIpv4(ip)) {
    return {
      what: 'address ' + ip + ' will not do',
      why: 'an A record takes only IPv4: four numbers from 0 to 255',
      fix: 'colloq dns point ' + host + ' 203.0.113.10',
    }
  }
  return null
}

/** Четыре числа от 0 до 255: «300.1.1.1» адресом не является. */
function isIpv4(value: string): boolean {
  const parts = IPV4.exec(value)
  if (!parts) return false
  return parts.slice(1).every((part) => {
    const number = Number(part)
    return String(number) === part && number >= 0 && number <= 255
  })
}

/** Зона из флага или из пары DOMAIN=…: скрипту она уходит окружением. */
function zoneOf(ctx: Ctx): string {
  const flag = ctx.values.domain
  if (typeof flag === 'string' && flag.trim() !== '') return flag.trim()
  return (ctx.makeVars.DOMAIN ?? '').trim()
}

/* ------------------------------------------------------------------ host */

/**
 * Чем публиковать: целью Makefile или самим скриптом.
 *
 * Цель host — две строки: `COLLOQ_HOSTNAME=<имя> ./scripts/host.sh`, у прямого
 * режима ещё и COLLOQ_DIRECT=1. В репозитории пусть так и остаётся: её же
 * зовут руками, и обходить её значило бы завести второе описание того же.
 *
 * У поставленного пакета make звать нечем — Makefile в колесо не едет, — и
 * `colloq host` умирал «make: command not found» на единственной команде,
 * которой класс получает ссылку. Сам скрипт при этом лежит рядом
 * (scripts/pack.mts довозит scripts/), поэтому в дистрибутиве зовём его
 * напрямую и теми же переменными, что подставила бы цель.
 *
 * Пары, написанные человеком (PORT=3001), уходят ребёнку окружением: make
 * экспортирует переменные командной строки в рецепт, и без этого прямой вызов
 * вёл бы себя иначе, чем цель.
 */
function publishCall(ctx: Ctx, host: string, direct: boolean): Promise<number> {
  if (!ctx.dist) {
    const target = direct ? 'host-direct' : 'host'
    return ctx.sh.make(target, mine(ctx, 'HOST', host), { env: stateEnv(ctx) })
  }
  const env: Record<string, string> = { ...stateEnv(ctx) }
  for (const [key, value] of Object.entries(ctx.makeVars)) if (key !== 'HOST') env[key] = value
  if (direct) env.COLLOQ_DIRECT = '1'
  if (host) env.COLLOQ_HOSTNAME = host
  return ctx.sh.script('./scripts/host.sh', [], { env })
}

/**
 * host и host-direct: одно действие, два транспорта.
 *
 * Вопрос задаёт каркас, но текст его разный: у прямого режима своя цена и
 * называть её надо вслух, а у туннеля вопрос уместен только посреди занятия.
 * Вопрос всё равно ровно один.
 */
async function publish(ctx: Ctx, direct: boolean): Promise<number> {
  const host = arg(ctx, 0, 'HOST')
  if (ctx.dryRun) return await publishCall(ctx, host, direct)

  needEnv(ctx)
  ctx.ui.header(headline(ctx, host, direct))
  // Сразу под шапкой, ДО того как побежит вывод скрипта: ссылку раздают
  // после этой команды, и цена у неё не только в туннеле.
  ctx.ui.hint(PERIMETER.what)
  ctx.ui.hint(PERIMETER.fix)
  return await publishCall(ctx, host, direct)
}

/** Спрашивать ли: прямой режим — всегда, туннель — только посреди занятия. */
function publishWhen(direct: boolean): (ctx: Ctx) => Promise<boolean> {
  return async (ctx: Ctx) => direct || (await ctx.rooms()) > 0
}

/** Вопрос называет цену, а она зависит от транспорта и от имени. */
function publishQuestion(direct: boolean): (ctx: Ctx) => string {
  return (ctx: Ctx) => {
    const host = arg(ctx, 0, 'HOST')
    return direct
      ? 'install caddy on 80 and 443 and rewrite the A record for ' + host + '?'
      : 'publish ' + (host || 'the class') + '?'
  }
}

/** Шапка в одну строку: куда пойдёт пара и чем за это платят. */
function headline(ctx: Ctx, host: string, direct: boolean): string {
  if (direct) return 'installing caddy on this machine: it holds 80 and 443 for ' + host
  const domain = ctx.env.relay().domain
  if (host && domain && (host === domain || host.endsWith('.' + domain))) {
    return 'publishing ' + host + ' through the relay: keep this window open'
  }
  if (host) return 'publishing ' + host + ' through Cloudflare, which does not open from Russia'
  return 'publishing through a quick Cloudflare tunnel: the name is random, and it does not open from Russia'
}

export const commands: Command[] = [
  {
    name: 'host',
    aliases: ['public'],
    group: 'host',
    audience: 'teacher',
    summary: 'Publish the running class and get a link',
    usage: 'colloq host [name] [--direct]',
    args: [
      {
        name: 'name',
        summary: 'Class address: hse.colloq.ru. Without a name: a quick tunnel',
        makeVar: 'HOST',
      },
    ],
    flags: [{ name: 'direct', summary: 'caddy on this machine itself, without the relay' }],
    destructive: true,
    confirm: 'cli',
    check: (ctx) => checker((inner) => hostProblem(inner, inner.values.direct === true))(ctx),
    confirmWhen: (ctx) => publishWhen(ctx.values.direct === true)(ctx),
    confirmQuestion: (ctx) => publishQuestion(ctx.values.direct === true)(ctx),
    delegates:
      'make host HOST=… (with --direct: make host-direct HOST=…); in the package there is no make to call: COLLOQ_HOSTNAME=… ./scripts/host.sh',
    examples: ['colloq host hse.colloq.ru', 'colloq host hse.colloq.ru --direct'],
    notes:
      'The class must already be running: host.sh publishes, it does not bring anything up — if /api/health is silent, it dies with an instruction. ' +
      'Keep this window open: the tunnel is this very process, and Ctrl+C closes only the tunnel. In a local session the temporary address is taken down without restarting the server and without changing .env. ' +
      'A name under RELAY_DOMAIN goes to the relay; any other name goes silently to Cloudflare, which does not open from Russia. ' +
      'Only the relay completes a short name to RELAY_DOMAIN, and host.sh decides that. ' +
      'Direct mode needs Linux, systemd, root and a public address: on macOS the script refuses by itself. ' +
      'Two lines about the perimeter are printed under the header: a class on your own computer runs without production limits, ' +
      'and a room open to anyone needs a server install. colloq doctor says the same.',
    async run(ctx) {
      return await publish(ctx, ctx.values.direct === true)
    },
  },
  {
    name: 'host-direct',
    group: 'host',
    summary: 'The same, but caddy on this machine: no relay and no middlemen',
    usage: 'colloq host-direct <name>',
    args: [
      {
        name: 'name',
        summary: 'The full name: the certificate is issued for it',
        required: true,
        makeVar: 'HOST',
      },
    ],
    flags: [],
    destructive: true,
    confirm: 'cli',
    check: checker((ctx) => hostProblem(ctx, true)),
    confirmWhen: publishWhen(true),
    confirmQuestion: publishQuestion(true),
    delegates:
      'make host-direct HOST=… (in the package: COLLOQ_DIRECT=1 COLLOQ_HOSTNAME=… ./scripts/host.sh)',
    examples: ['colloq host-direct hse.colloq.ru', 'colloq host-direct hse.colloq.ru --dry-run'],
    notes:
      'The same as colloq host <name> --direct, under a name of its own. The price: caddy is installed on 80 and 443, ' +
      '/etc/caddy/Caddyfile and the unit are rewritten, and an A record points the name at this machine address. It needs Linux, systemd, root ' +
      'and real 80 and 443 from outside: on macOS and on a rented vast.ai machine the script refuses by itself. ' +
      'After Ctrl+C the PUBLIC_URL stays a live name: there is no middleman, and the name points here.',
    async run(ctx) {
      return await publish(ctx, true)
    },
  },
  {
    name: 'tunnel setup',
    group: 'host',
    summary: 'Set up a permanent address through Cloudflare, once',
    usage: 'colloq tunnel setup <name>',
    args: [
      {
        name: 'name',
        summary: 'The full name in your own zone: class.example.ru',
        required: true,
        makeVar: 'HOST',
      },
    ],
    flags: [],
    destructive: true,
    confirm: 'cli',
    check: checker(tunnelProblem),
    confirmQuestion: 'create a named tunnel and a CNAME record? a browser will open',
    delegates: 'make tunnel-setup HOST=…',
    examples: [
      'colloq tunnel setup class.example.ru',
      'colloq tunnel setup class.example.ru --dry-run',
    ],
    notes:
      'A named tunnel and a DNS record are created; after that colloq host <name> always brings up this address. ' +
      'Signing in needs ~/.cloudflared/cert.pem, and that is NOT the CF_TOKEN from .env: that one is issued for records only. ' +
      'A route dns failure is a real failure; the one thing tolerated is "already exists". ' +
      'Cloudflare addresses do not open from Russia: colloq.ru has a relay of its own.',
    async run(ctx) {
      const host = arg(ctx, 0, 'HOST')
      const vars = mine(ctx, 'HOST', host)
      if (ctx.dryRun) return await ctx.sh.make('tunnel-setup', vars)
      ctx.ui.header('setting up the permanent address ' + host + ': a tunnel and a CNAME record')
      return await ctx.sh.make('tunnel-setup', vars)
    },
  },
  {
    name: 'relay setup',
    group: 'host',
    summary: 'Install the *.colloq.ru relay on a VPS',
    usage: 'colloq relay setup <root@address>',
    args: [
      {
        name: 'root@address',
        summary: 'The machine with a public address to install on',
        required: true,
        makeVar: 'WHERE',
      },
    ],
    flags: [],
    destructive: true,
    confirm: 'cli',
    check: checker((ctx) => whereProblem(ctx, 'colloq relay setup root@203.0.113.10')),
    confirmQuestion: 'install the relay? frps and caddy restart, and live tunnels break',
    delegates: 'make relay-setup WHERE=…',
    examples: [
      'colloq relay setup root@203.0.113.10',
      'colloq relay setup root@203.0.113.10 --dry-run',
    ],
    notes:
      'Over ssh it installs caddy, frps, colloq-capy, colloq-assets, the MTU unit and the /etc/caddy/names directory. ' +
      'Both services restart, which breaks every tunnel under this name: do not call it in the middle of a class. ' +
      'At the end the script prints RELAY_DOMAIN, RELAY_ADDR, RELAY_PORT and RELAY_TOKEN to be written into .env: ' +
      'the CLI does not capture that output and saves it nowhere, and the token never reaches .colloq/state.json.',
    async run(ctx) {
      const machine = arg(ctx, 0, 'WHERE')
      const vars = mine(ctx, 'WHERE', machine)
      if (ctx.dryRun) return await ctx.sh.make('relay-setup', vars)
      ctx.ui.header('installing the relay on ' + machine + ': caddy, frps, the waiting page')
      return await ctx.sh.make('relay-setup', vars)
    },
  },
  {
    name: 'relay page',
    group: 'host',
    summary: 'Update the "room is not open yet" page',
    usage: 'colloq relay page <root@address>',
    args: [
      {
        name: 'root@address',
        summary: 'The relay machine',
        required: true,
        makeVar: 'WHERE',
      },
    ],
    flags: [],
    destructive: false,
    check: checker((ctx) => whereProblem(ctx, 'colloq relay page root@203.0.113.10')),
    delegates: 'make relay-page WHERE=… (scripts/relay-setup.sh --page)',
    examples: [
      'colloq relay page root@203.0.113.10',
      'colloq relay page root@203.0.113.10 --dry-run',
    ],
    notes:
      'The cheap path: one file, scripts/relay-offline.html (with the capybara game), is copied over, and not a single ' +
      'service restarts. A full install must not be called for one paragraph: it would drop live addresses.',
    async run(ctx) {
      const machine = arg(ctx, 0, 'WHERE')
      const vars = mine(ctx, 'WHERE', machine)
      if (ctx.dryRun) return await ctx.sh.make('relay-page', vars)
      ctx.ui.header(
        'copying the waiting page to ' + machine + ': the file only, services are left alone',
      )
      return await ctx.sh.make('relay-page', vars)
    },
  },
  {
    name: 'relay ping',
    group: 'host',
    summary: 'Whether the relay answers',
    usage: 'colloq relay ping',
    flags: [],
    destructive: false,
    delegates: 'native: TCP to RELAY_ADDR:RELAY_PORT from .env, 2s timeout',
    examples: ['colloq relay ping', 'colloq relay ping --dry-run'],
    notes:
      'The only network check outside doctor: one TCP connection and two seconds for an answer. ' +
      'The address is printed, RELAY_TOKEN never is. If it is silent, look at the machine itself: from here no tunnel helps.',
    async run(ctx) {
      if (ctx.dryRun) {
        return ctx.sh.dry('native: relay ping (TCP RELAY_ADDR:RELAY_PORT from .env, 2s timeout)')
      }
      const relay = ctx.env.relay()
      if (!relay.addr) {
        throw new PreconditionError(
          'no RELAY_ADDR in .env — the relay address',
          'colloq relay setup root@<address>, then write RELAY_* into .env',
        )
      }
      const at = relay.addr + ':' + String(relay.port)
      if (await probeTcp(ctx.sh, relay.addr, relay.port)) {
        ctx.ui.line(SYMBOL.on + ' ' + at + ' answers')
        return 0
      }
      ctx.ui.line(SYMBOL.off + ' ' + at + ' is silent')
      ctx.ui.hint('check the machine: ssh root@' + relay.addr + ', systemctl status frps caddy')
      return 1
    },
  },
  {
    name: 'dns sync',
    aliases: ['dns'],
    group: 'host',
    summary: 'Put the colloq.ru zone in order',
    usage: 'colloq dns sync [--domain <zone>]',
    flags: [{ name: 'domain', arg: 'zone', summary: 'Which zone to put in order' }],
    destructive: true,
    confirm: 'cli',
    check: checker(zoneProblem),
    confirmQuestion:
      'put the zone in order? extra records of each (type, name) pair will be deleted',
    delegates: './scripts/dns.sh (with --domain: DOMAIN=<zone> ./scripts/dns.sh)',
    examples: ['colloq dns sync', 'colloq dns sync --domain {domain}'],
    notes:
      'It puts the landing page, www and *.colloq.ru → RELAY_ADDR in order; the cloud is grey everywhere, because an orange one ' +
      'is unreachable from Russia. For each (type, name) pair extra records are deleted, not piled up alongside. ' +
      'The script reads CF_TOKEN and CF_ZONE from .env itself, and they never reach argv. ' +
      'With a bare "colloq dns" the zone is named by a pair: colloq dns DOMAIN=colloq.ru.',
    async run(ctx) {
      const zone = zoneOf(ctx)
      // Зона — окружением, каталог состояния — рядом с ней: CF_TOKEN скрипт
      // читает из .env, а он лежит в состоянии, не в приложении.
      const opts = { env: { ...stateEnv(ctx), ...(zone ? { DOMAIN: zone } : {}) } }
      if (ctx.dryRun) return await ctx.sh.script('./scripts/dns.sh', [], opts)
      needEnv(ctx)
      ctx.ui.header('putting the ' + (zone || 'colloq.ru') + ' zone in order: extras are deleted')
      return await ctx.sh.script('./scripts/dns.sh', [], opts)
    },
  },
  {
    name: 'dns point',
    group: 'host',
    summary: 'Point one name at one address',
    usage: 'colloq dns point <name> <ip>',
    args: [
      { name: 'name', summary: 'The full name: hse.colloq.ru', required: true, makeVar: 'HOST' },
      { name: 'ip', summary: 'The machine IPv4 address', required: true, makeVar: 'IP' },
    ],
    flags: [],
    destructive: true,
    confirm: 'cli',
    check: checker(pointProblem),
    confirmQuestion: 'point the name at this address? an explicit A record beats *.colloq.ru',
    delegates: './scripts/dns.sh point <name> <ip>',
    examples: [
      'colloq dns point hse.colloq.ru 203.0.113.10',
      'colloq dns point hse.colloq.ru 203.0.113.10 --dry-run',
    ],
    notes:
      'One A record without proxying: the same thing direct mode does. An explicit record beats the wildcard ' +
      '*.colloq.ru until it is deleted: the name stops going through the relay silently, and colloq dns sync brings it back there. ' +
      'Pairs work too: colloq dns point HOST=hse.colloq.ru IP=203.0.113.10.',
    async run(ctx) {
      const host = arg(ctx, 0, 'HOST', 'NAME')
      const ip = arg(ctx, 1, 'IP', 'ADDR')
      const opts = { env: stateEnv(ctx) }
      if (ctx.dryRun) return await ctx.sh.script('./scripts/dns.sh', ['point', host, ip], opts)
      needEnv(ctx)
      ctx.ui.header('pointing ' + host + ' at ' + ip + ': the rest of the zone is left alone')
      return await ctx.sh.script('./scripts/dns.sh', ['point', host, ip], opts)
    },
  },
  {
    name: 'sync',
    group: 'host',
    summary: 'Check that the projector follows the console when pages are turned fast',
    usage: 'colloq sync [--headed]',
    flags: [{ name: 'headed', summary: 'With a visible browser window' }],
    destructive: false,
    confirm: 'self',
    delegates: 'make sync (with --headed: make sync HEADED=1)',
    examples: ['colloq sync', 'colloq sync --headed'],
    notes:
      'The load test rebuilds web/dist and brings up a server of its own on 3898 (Chrome over CDP 9338): it leaves the rooms of a real class alone. ' +
      'It measures a queue of key presses, not one press: waiting for an answer after each of them was exactly what hid the illness. ' +
      'While the server is running it asks first: rebuilding the panel changes files underneath it.',
    async run(ctx) {
      const vars = mine(ctx, 'HEADED', ctx.values.headed === true ? '1' : '')
      if (ctx.dryRun) return await ctx.sh.make('sync', vars)
      const busy = ctx.io.exists(ctx.env.paths.pidFile) || (await ctx.rooms()) > 0
      if (
        busy &&
        !(await ctx.confirm(
          'run the load test while the server is running? web/dist will be rebuilt',
        ))
      ) {
        return stopped(ctx)
      }
      ctx.ui.header('running the sync load test: a server of its own on 3898, Chrome over CDP 9338')
      return await ctx.sh.make('sync', vars)
    },
  },
]

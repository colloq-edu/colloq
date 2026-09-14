/**
 * Занятие в сети — как аудитория попадает на эту машину.
 *
 * Цели группы: host, tunnel setup, relay setup, relay page, relay ping,
 * dns sync, dns point, sync (make host, make tunnel-setup, make relay-setup,
 * make relay-page, scripts/dns.sh, make sync).
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

/** Без .env не узнать ни порта, ни ретранслятора, ни токена зоны. */
function needEnv(ctx: Ctx): void {
  if (ctx.io.exists(ctx.env.paths.envFile)) return
  throw new PreconditionError(
    'нет .env — из него берутся PORT, RELAY_* и CF_TOKEN',
    'cp .env.example .env и впишите своё',
  )
}

/* --------------------------------------------------------------- проверки */

/** Имя семинара: у прямого режима оно обязательно, у туннеля — нет. */
function hostProblem(ctx: Ctx, direct: boolean): Problem | null {
  const host = arg(ctx, 0, 'HOST')
  if (direct && !host) {
    return {
      what: 'прямому режиму нужно имя',
      why: 'на это имя выпишут сертификат, и придумать его за человека нельзя',
      fix: 'colloq host hse.colloq.ru --direct',
    }
  }
  if (host && !hostNameOk(host)) {
    return {
      what: 'имя ' + host + ' не годится',
      why: 'в имени бывают только латиница, цифры, точки и дефисы',
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
      what: 'не указано имя',
      why: 'туннель и запись CNAME заводятся конкретному имени',
      fix: 'colloq tunnel setup seminar.example.ru',
    }
  }
  if (!NAME.test(host) || !host.includes('.')) {
    return {
      what: 'имя ' + host + ' не годится',
      why: 'нужно полное имя в вашей зоне: латиница, цифры, точки и дефисы',
      fix: 'colloq tunnel setup seminar.example.ru',
    }
  }
  return null
}

/** Куда ставить ретранслятор: root@адрес или имя из ~/.ssh/config. */
function whereProblem(ctx: Ctx, fix: string): Problem | null {
  const machine = arg(ctx, 0, 'WHERE')
  if (!machine) {
    return {
      what: 'не указана машина',
      why: 'ретранслятор живёт на чужой машине, и её называют',
      fix,
    }
  }
  if (/\s/.test(machine) || machine.includes('://')) {
    return {
      what: 'адрес ' + machine + ' не годится',
      why: 'ssh ждёт root@адрес или имя из ~/.ssh/config',
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
      what: 'зона ' + zone + ' не годится',
      why: 'зона — это имя вида colloq.ru: латиница, цифры, точки и дефисы',
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
      what: 'не указано имя',
      why: 'A-запись пишется конкретному имени, и угадывать его нельзя',
      fix: example,
    }
  }
  if (!NAME.test(host) || !host.includes('.')) {
    return {
      what: 'имя ' + host + ' не годится',
      why: 'нужно полное имя в зоне: латиница, цифры, точки и дефисы',
      fix: example,
    }
  }
  if (!ip) {
    return {
      what: 'не указан адрес',
      why: 'имя направляют на адрес машины, второй аргумент обязателен',
      fix: 'colloq dns point ' + host + ' 203.0.113.10',
    }
  }
  if (!isIpv4(ip)) {
    return {
      what: 'адрес ' + ip + ' не годится',
      why: 'A-запись принимает только IPv4: четыре числа от 0 до 255',
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
 * host и host-direct: одно действие, два транспорта.
 *
 * Вопрос задаёт каркас, но текст его разный: у прямого режима своя цена и
 * называть её надо вслух, а у туннеля вопрос уместен только посреди занятия.
 * Вопрос всё равно ровно один.
 */
async function publish(ctx: Ctx, direct: boolean): Promise<number> {
  const host = arg(ctx, 0, 'HOST')
  const target = direct ? 'host-direct' : 'host'
  const vars = mine(ctx, 'HOST', host)
  if (ctx.dryRun) return await ctx.sh.make(target, vars)

  needEnv(ctx)
  ctx.ui.header(headline(ctx, host, direct))
  return await ctx.sh.make(target, vars)
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
      ? 'поставить caddy на 80 и 443 и переписать A-запись ' + host + '?'
      : 'выставить ' + (host || 'семинар') + ' наружу?'
  }
}

/** Шапка в одну строку: куда пойдёт пара и чем за это платят. */
function headline(ctx: Ctx, host: string, direct: boolean): string {
  if (direct) return 'ставлю caddy на этой машине: он держит 80 и 443 для ' + host
  const domain = ctx.env.relay().domain
  if (host && domain && (host === domain || host.endsWith('.' + domain))) {
    return 'выставляю ' + host + ' через ретранслятор — окно держать открытым'
  }
  if (host) return 'выставляю ' + host + ' через Cloudflare — из России он не открывается'
  return 'выставляю быстрым туннелем Cloudflare — имя случайное, из России не открывается'
}

export const commands: Command[] = [
  {
    name: 'host',
    aliases: ['public'],
    group: 'host',
    summary: 'Выставить работающий семинар наружу и получить ссылку',
    usage: 'colloq host [имя] [--direct]',
    args: [
      {
        name: 'имя',
        summary: 'Адрес семинара: hse.colloq.ru. Без имени — быстрый туннель',
        makeVar: 'HOST',
      },
    ],
    flags: [{ name: 'direct', summary: 'caddy прямо на этой машине, без ретранслятора' }],
    destructive: true,
    confirm: 'cli',
    check: (ctx) => checker((inner) => hostProblem(inner, inner.values.direct === true))(ctx),
    confirmWhen: (ctx) => publishWhen(ctx.values.direct === true)(ctx),
    confirmQuestion: (ctx) => publishQuestion(ctx.values.direct === true)(ctx),
    delegates: 'make host HOST=… (с --direct — make host-direct HOST=…)',
    examples: ['colloq host hse.colloq.ru', 'colloq host hse.colloq.ru --direct'],
    notes:
      'Семинар уже должен работать: host.sh публикует, но не разворачивает — молчит /api/health, и он умрёт с инструкцией. ' +
      'Окно держать открытым: туннель и есть этот процесс, Ctrl+C закрывает только туннель. У локальной сессии временный адрес снимается без перезапуска сервера и без изменения .env. ' +
      'Имя под RELAY_DOMAIN идёт на ретранслятор, любое другое — молча в Cloudflare, а он из России не открывается. ' +
      'Короткое имя достраивает до RELAY_DOMAIN только ретранслятор, и решает это host.sh. ' +
      'Прямому режиму нужны Linux, systemd, root и белый адрес — на macOS скрипт откажет сам.',
    async run(ctx) {
      return await publish(ctx, ctx.values.direct === true)
    },
  },
  {
    name: 'host-direct',
    group: 'host',
    summary: 'То же, но caddy на этой машине: без ретранслятора и посредников',
    usage: 'colloq host-direct <имя>',
    args: [
      {
        name: 'имя',
        summary: 'Полное имя: на него выпишут сертификат',
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
    delegates: 'make host-direct HOST=…',
    examples: ['colloq host-direct hse.colloq.ru', 'colloq host-direct hse.colloq.ru --dry-run'],
    notes:
      'То же, что colloq host <имя> --direct, отдельным именем. Цена: ставится caddy на 80 и 443, переписываются ' +
      '/etc/caddy/Caddyfile и юнит, пишется A-запись имени на адрес этой машины. Нужны Linux, systemd, root ' +
      'и настоящие 80 и 443 снаружи — на macOS и на арендованной машине vast.ai скрипт откажет сам. ' +
      'PUBLIC_URL после Ctrl+C остаётся живым именем: посредника нет, имя смотрит сюда.',
    async run(ctx) {
      return await publish(ctx, true)
    },
  },
  {
    name: 'tunnel setup',
    group: 'host',
    summary: 'Один раз завести постоянный адрес через Cloudflare',
    usage: 'colloq tunnel setup <имя>',
    args: [
      {
        name: 'имя',
        summary: 'Полное имя в вашей зоне: seminar.example.ru',
        required: true,
        makeVar: 'HOST',
      },
    ],
    flags: [],
    destructive: true,
    confirm: 'cli',
    check: checker(tunnelProblem),
    confirmQuestion: 'завести именованный туннель и запись CNAME? откроется браузер',
    delegates: 'make tunnel-setup HOST=…',
    examples: [
      'colloq tunnel setup seminar.example.ru',
      'colloq tunnel setup seminar.example.ru --dry-run',
    ],
    notes:
      'Заводится именованный туннель и запись DNS; после этого colloq host <имя> поднимает всегда этот адрес. ' +
      'Для входа нужен ~/.cloudflared/cert.pem, и это НЕ тот CF_TOKEN, что в .env: тот выдан только на записи. ' +
      'Отказ route dns — настоящий отказ, терпится одно «already exists». ' +
      'Адреса Cloudflare из России не открываются: для colloq.ru есть свой ретранслятор.',
    async run(ctx) {
      const host = arg(ctx, 0, 'HOST')
      const vars = mine(ctx, 'HOST', host)
      if (ctx.dryRun) return await ctx.sh.make('tunnel-setup', vars)
      ctx.ui.header('завожу постоянный адрес ' + host + ': туннель и запись CNAME')
      return await ctx.sh.make('tunnel-setup', vars)
    },
  },
  {
    name: 'relay setup',
    group: 'host',
    summary: 'Поставить ретранслятор *.colloq.ru на VPS',
    usage: 'colloq relay setup <root@адрес>',
    args: [
      {
        name: 'root@адрес',
        summary: 'Машина с белым адресом, куда ставить',
        required: true,
        makeVar: 'WHERE',
      },
    ],
    flags: [],
    destructive: true,
    confirm: 'cli',
    check: checker((ctx) => whereProblem(ctx, 'colloq relay setup root@203.0.113.10')),
    confirmQuestion: 'поставить ретранслятор? frps и caddy перезапустятся, живые туннели оборвутся',
    delegates: 'make relay-setup WHERE=…',
    examples: [
      'colloq relay setup root@203.0.113.10',
      'colloq relay setup root@203.0.113.10 --dry-run',
    ],
    notes:
      'По ssh ставятся caddy, frps, colloq-capy, colloq-assets, юнит MTU и каталог /etc/caddy/names. ' +
      'Обе службы перезапускаются, а значит рвутся все туннели под этим именем — посреди пары не звать. ' +
      'В конце скрипт печатает RELAY_DOMAIN, RELAY_ADDR, RELAY_PORT и RELAY_TOKEN, чтобы вписать их в .env: ' +
      'CLI этот вывод не перехватывает и никуда не сохраняет, в .colloq/state.json токен не попадает.',
    async run(ctx) {
      const machine = arg(ctx, 0, 'WHERE')
      const vars = mine(ctx, 'WHERE', machine)
      if (ctx.dryRun) return await ctx.sh.make('relay-setup', vars)
      ctx.ui.header('ставлю ретранслятор на ' + machine + ': caddy, frps, страница ожидания')
      return await ctx.sh.make('relay-setup', vars)
    },
  },
  {
    name: 'relay page',
    group: 'host',
    summary: 'Обновить страницу «комната ещё не открыта»',
    usage: 'colloq relay page <root@адрес>',
    args: [
      {
        name: 'root@адрес',
        summary: 'Машина ретранслятора',
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
      'Дешёвый путь: кладётся один файл scripts/relay-offline.html (вместе с игрой про капибару), ни одна ' +
      'служба не перезапускается. Ради одного абзаца полную установку звать нельзя — она уронит живые адреса.',
    async run(ctx) {
      const machine = arg(ctx, 0, 'WHERE')
      const vars = mine(ctx, 'WHERE', machine)
      if (ctx.dryRun) return await ctx.sh.make('relay-page', vars)
      ctx.ui.header('кладу страницу ожидания на ' + machine + ': только файл, службы не трогаются')
      return await ctx.sh.make('relay-page', vars)
    },
  },
  {
    name: 'relay ping',
    group: 'host',
    summary: 'Отвечает ли ретранслятор',
    usage: 'colloq relay ping',
    flags: [],
    destructive: false,
    delegates: 'native: TCP до RELAY_ADDR:RELAY_PORT из .env, таймаут 2 с',
    examples: ['colloq relay ping', 'colloq relay ping --dry-run'],
    notes:
      'Единственная сетевая проверка вне доктора: одно соединение TCP и две секунды на ответ. ' +
      'Адрес печатается, RELAY_TOKEN — никогда. Молчит — смотреть саму машину: отсюда туннелем не поможешь.',
    async run(ctx) {
      if (ctx.dryRun) {
        return ctx.sh.dry('native: relay ping (TCP RELAY_ADDR:RELAY_PORT из .env, таймаут 2 с)')
      }
      const relay = ctx.env.relay()
      if (!relay.addr) {
        throw new PreconditionError(
          'в .env нет RELAY_ADDR — адреса ретранслятора',
          'colloq relay setup root@<адрес>, а потом впишите RELAY_* в .env',
        )
      }
      const at = relay.addr + ':' + String(relay.port)
      if (await probeTcp(ctx.sh, relay.addr, relay.port)) {
        ctx.ui.line(SYMBOL.on + ' ' + at + ' отвечает')
        return 0
      }
      ctx.ui.line(SYMBOL.off + ' ' + at + ' молчит')
      ctx.ui.hint('проверить машину: ssh root@' + relay.addr + ', systemctl status frps caddy')
      return 1
    },
  },
  {
    name: 'dns sync',
    aliases: ['dns'],
    group: 'host',
    summary: 'Привести зону colloq.ru к нужному виду',
    usage: 'colloq dns sync [--domain <зона>]',
    flags: [{ name: 'domain', arg: 'зона', summary: 'Какую зону приводить в порядок' }],
    destructive: true,
    confirm: 'cli',
    check: checker(zoneProblem),
    confirmQuestion: 'привести зону в порядок? лишние записи каждой пары (тип, имя) будут удалены',
    delegates: './scripts/dns.sh (с --domain — DOMAIN=<зона> ./scripts/dns.sh)',
    examples: ['colloq dns sync', 'colloq dns sync --domain {domain}'],
    notes:
      'Приводит в порядок лендинг, www и *.colloq.ru → RELAY_ADDR; серое облако везде, потому что оранжевое ' +
      'из России недостижимо. Для каждой пары (тип, имя) лишние записи удаляются, а не досыпаются рядом. ' +
      'CF_TOKEN и CF_ZONE скрипт читает из .env сам, в argv они не попадают. ' +
      'У голого «colloq dns» зону называют парой: colloq dns DOMAIN=colloq.ru.',
    async run(ctx) {
      const zone = zoneOf(ctx)
      const opts = zone ? { env: { DOMAIN: zone } } : {}
      if (ctx.dryRun) return await ctx.sh.script('./scripts/dns.sh', [], opts)
      needEnv(ctx)
      ctx.ui.header('привожу зону ' + (zone || 'colloq.ru') + ' в порядок: лишнее удаляется')
      return await ctx.sh.script('./scripts/dns.sh', [], opts)
    },
  },
  {
    name: 'dns point',
    group: 'host',
    summary: 'Направить одно имя на один адрес',
    usage: 'colloq dns point <имя> <ip>',
    args: [
      { name: 'имя', summary: 'Полное имя: hse.colloq.ru', required: true, makeVar: 'HOST' },
      { name: 'ip', summary: 'Адрес IPv4 машины', required: true, makeVar: 'IP' },
    ],
    flags: [],
    destructive: true,
    confirm: 'cli',
    check: checker(pointProblem),
    confirmQuestion: 'направить имя на этот адрес? явная A-запись сильнее *.colloq.ru',
    delegates: './scripts/dns.sh point <имя> <ip>',
    examples: [
      'colloq dns point hse.colloq.ru 203.0.113.10',
      'colloq dns point hse.colloq.ru 203.0.113.10 --dry-run',
    ],
    notes:
      'Одна A-запись без проксирования — то же, что делает прямой режим. Явная запись сильнее подстановочной ' +
      '*.colloq.ru, пока её не удалят: имя перестанет ходить через ретранслятор молча, а вернёт его туда colloq dns sync. ' +
      'Пары тоже годятся: colloq dns point HOST=hse.colloq.ru IP=203.0.113.10.',
    async run(ctx) {
      const host = arg(ctx, 0, 'HOST', 'NAME')
      const ip = arg(ctx, 1, 'IP', 'ADDR')
      if (ctx.dryRun) return await ctx.sh.script('./scripts/dns.sh', ['point', host, ip])
      needEnv(ctx)
      ctx.ui.header('направляю ' + host + ' на ' + ip + ': остальная зона не трогается')
      return await ctx.sh.script('./scripts/dns.sh', ['point', host, ip])
    },
  },
  {
    name: 'sync',
    group: 'host',
    summary: 'Проверить, что проектор идёт за пультом при быстром листании',
    usage: 'colloq sync [--headed]',
    flags: [{ name: 'headed', summary: 'С видимым окном браузера' }],
    destructive: false,
    confirm: 'self',
    delegates: 'make sync (с --headed — make sync HEADED=1)',
    examples: ['colloq sync', 'colloq sync --headed'],
    notes:
      'Стенд пересобирает web/dist и поднимает свой сервер на 3898 (Chrome по CDP 9338) — чужую комнату не трогает. ' +
      'Меряет очередь нажатий, а не одно: именно ожидание ответа после каждого и прятало болезнь. ' +
      'Пока сервер работает, спрашивает: пересборка панели меняет файлы под ним.',
    async run(ctx) {
      const vars = mine(ctx, 'HEADED', ctx.values.headed === true ? '1' : '')
      if (ctx.dryRun) return await ctx.sh.make('sync', vars)
      const busy = ctx.io.exists(ctx.env.paths.pidFile) || (await ctx.rooms()) > 0
      if (
        busy &&
        !(await ctx.confirm('гнать стенд, пока сервер работает? web/dist пересоберётся'))
      ) {
        return stopped(ctx)
      }
      ctx.ui.header('гоняю стенд синхронизации: свой сервер на 3898, Chrome по CDP 9338')
      return await ctx.sh.make('sync', vars)
    },
  },
]

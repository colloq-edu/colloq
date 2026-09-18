/**
 * Занятие в сети — как аудитория попадает на эту машину.
 *
 * Команда одна — host: выставить уже идущее занятие наружу и получить ссылку.
 * Ретранслятор, зона DNS, именованный туннель Cloudflare и нагрузочный стенд
 * сюда не входят: они ставят и правят чужие машины и зону, это мастерская, и
 * живёт она в Makefile и scripts/. Преподавателю после `pip install colloq`
 * из всего этого нужна только ссылка.
 *
 * host идёт прямо в scripts/host.sh — одинаково из колеса и из исходников;
 * разбор у publishCall ниже. Каталог состояния скрипту называем сами: stateEnv.
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
 * Отказы скрипта не переписываются. Свои проверки — только до первого
 * действия и только о том, что видно отсюда: есть ли имя, похоже ли оно на
 * имя, есть ли .env.
 *
 * Порядок: проверить имя (check — каркас зовёт его раньше вопроса) → вопрос
 * каркаса → --dry-run → .env → шапка в одну строку → скрипт. Проверка стоит
 * до вопроса: спросить «поставить caddy для этого имени?», чтобы потом
 * сказать «это не имя», — значит спросить зря.
 *
 * node:child_process и node:fs импортировать нельзя: только ctx.sh и ctx.io.
 */
import type { Command, Ctx } from '../registry.js'
import { PreconditionError, UsageError } from '../ui.js'

/**
 * Периметр локального занятия — вслух, теми же словами в двух местах.
 *
 * Сказать их надо там, где человек и решает, кого пускать: в `colloq host`
 * (сейчас он открывает занятие наружу) и в `colloq doctor` (перед парой).
 *
 * Что тут правда и почему именно так. Прежде здесь стояло «без ограничений
 * прода: сеть наружу открыта, привилегии не сняты» — и это было правдой, пока
 * контейнер комнаты был голым. Теперь публикация наружу вообще возможна
 * только при изоляции ядер (решение автора: замок в host.sh и в супервизоре,
 * cli/src/launch-share.ts), а сами контейнеры комнат укреплены: привилегии
 * сняты, число процессов ограничено, до домашней сети и до самой машины из
 * комнаты не достучаться (server/src/kernel/perimeter.ts). Что остаётся правдой и
 * после этого: ссылка — это дверь. Кто её получил, тот запускает код в
 * песочнице на этом компьютере, — поэтому ссылка для своего класса, а Ctrl+C
 * её закрывает.
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
  what: 'student code runs in a hardened container per room, cut off from your home network',
  fix: 'the link is a door: anyone who has it runs code in a sandbox on this computer — keep it for your class; Ctrl+C closes it',
} as const

/** Имя в DNS: латиница, цифры, точки и дефисы — на него выпишут сертификат. */
const NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

export function hostNameOk(host: string): boolean {
  return NAME.test(host)
}

/** Имя занятия как его написали; пустое — быстрый туннель со случайным именем. */
function nameOf(ctx: Ctx): string {
  return (ctx.positionals[0] ?? '').trim()
}

function directOf(ctx: Ctx): boolean {
  return ctx.values.direct === true
}

/**
 * Проверка до вопроса: у прямого режима имя обязательно, и любое имя должно
 * годиться в DNS. Отказ об употреблении — код 2, как во всех группах; печатает
 * его каркас тремя строками: что случилось, чем вызвано, что сделать.
 */
function checkName(ctx: Ctx): void {
  const host = nameOf(ctx)
  if (directOf(ctx) && !host) {
    throw new UsageError(
      'direct mode needs a name',
      'colloq host class.example.org --direct',
      'the certificate is issued for that name, and it cannot be made up for you',
    )
  }
  if (host && !hostNameOk(host)) {
    throw new UsageError(
      'name ' + host + ' will not do',
      'colloq host class.example.org',
      'a name holds only latin letters, digits, dots and hyphens',
    )
  }
}

/**
 * Без .env не узнать ни порта, ни ретранслятора, ни токена зоны.
 *
 * Совет здесь стоял невыполнимый: «cp .env.example .env» — путь относительный,
 * то есть в том каталоге, где человек стоит, а .env.example у поставленного
 * пакета нет вовсе. Заводит .env первый `colloq start` и кладёт его в каталог
 * состояния, туда, где мы его и ищем (cli/src/launch-config.ts · localClassEnv),
 * — и из колеса, и из исходников одинаково; туда и посылаем, одним советом.
 */
function needEnv(ctx: Ctx): void {
  if (ctx.io.exists(ctx.env.paths.envFile)) return
  throw new PreconditionError(
    'no ' + ctx.env.paths.envFile + ' — PORT, RELAY_* and CF_TOKEN are read from it',
    'colloq start creates it on the first run',
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
 * Называем всегда, а не только в пакете. В исходниках home и есть корень, и
 * переменная там ничего не меняет — зато нет развилки «когда совпадают, не
 * посылаем», которую надо не забыть повторить в следующей команде. Тем же
 * правилом живут copies и link — cli/src/commands/local.ts · stateEnv.
 */
function stateEnv(ctx: Ctx): Record<string, string> {
  return { COLLOQ_HOME: ctx.env.paths.home }
}

/**
 * Вызов публикации: сам scripts/host.sh, всегда.
 *
 * Цели Makefile host и host-direct — это две строки над тем же скриптом, но
 * Makefile в колесо не едет, и `colloq host` умирал «make: command not found»
 * на единственной команде, которой класс получает ссылку. Скрипт при этом
 * лежит рядом (scripts/pack.mts довозит scripts/), поэтому зовём его прямо и
 * теми же переменными, что подставила бы цель. Из исходников — так же: CLI,
 * который ведёт себя по-разному в зависимости от того, откуда он приехал,
 * проверяется вдвое хуже, а Makefile мастерской и так зовут руками.
 *
 * Порядок переменных — как в цели host-direct: COLLOQ_DIRECT перед
 * COLLOQ_HOSTNAME. Строку --dry-run копируют, и она должна совпадать с той,
 * что описана в шапке host.sh.
 */
function publishCall(ctx: Ctx, host: string, direct: boolean): Promise<number> {
  const env: Record<string, string> = { ...stateEnv(ctx) }
  if (direct) env.COLLOQ_DIRECT = '1'
  if (host) env.COLLOQ_HOSTNAME = host
  return ctx.sh.script('./scripts/host.sh', [], { env })
}

/**
 * Вопрос каркаса: прямой режим — всегда, туннель — только посреди занятия.
 *
 * У прямого режима своя цена (caddy на 80 и 443, A-запись переписана), и её
 * называют вслух при каждом вызове. Туннель ничего на машине не меняет, и
 * спрашивать о нём стоит лишь тогда, когда ссылку ждут уже идущие комнаты.
 */
async function publishWhen(ctx: Ctx): Promise<boolean> {
  return directOf(ctx) || (await ctx.rooms()) > 0
}

/** Вопрос называет цену, а она зависит от транспорта и от имени. */
function publishQuestion(ctx: Ctx): string {
  const host = nameOf(ctx)
  return directOf(ctx)
    ? 'install caddy on 80 and 443 and rewrite the A record for ' + host + '?'
    : 'publish ' + (host || 'the class') + '?'
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
    summary: 'Publish the running class and get a link',
    usage: 'colloq host [name] [--direct]',
    args: [
      {
        name: 'name',
        summary: 'Class address, e.g. class.example.org. Without a name: a quick tunnel',
      },
    ],
    flags: [{ name: 'direct', summary: 'caddy on this machine itself, without the relay' }],
    destructive: true,
    confirm: 'cli',
    check: checkName,
    confirmWhen: publishWhen,
    confirmQuestion: publishQuestion,
    delegates:
      'COLLOQ_HOSTNAME=<name> ./scripts/host.sh (with --direct: COLLOQ_DIRECT=1 as well)',
    examples: ['colloq host class.example.org', 'colloq host class.example.org --direct'],
    notes:
      'The class must already be running: host.sh publishes, it does not bring anything up — if /api/health is silent, it dies with an instruction. ' +
      'Keep this window open: the tunnel is this very process, and Ctrl+C closes only the tunnel. In a local session the temporary address is taken down without restarting the server and without changing .env. ' +
      'A name under RELAY_DOMAIN goes to the relay; any other name goes silently to Cloudflare, which does not open from Russia. ' +
      'Only the relay completes a short name to RELAY_DOMAIN, and host.sh decides that. ' +
      'The price of --direct: caddy takes 80 and 443, /etc/caddy/Caddyfile and its unit are rewritten, and an A record points the name at this machine; ' +
      'after Ctrl+C the name stays live. It needs Linux, systemd, root and a public address: on macOS the script refuses by itself. ' +
      'host.sh publishes nothing unless the server confirms in /api/health that every room runs in a container of its own (Docker or the runtime broker). ' +
      'Without cloudflared on PATH, the Cloudflare transports get a pinned release downloaded once into <state>/bin and checked by sha256; COLLOQ_CLOUDFLARED=/path names your own file. ' +
      'For a class started here, colloq start --share does all of this in one step and prints the link for students. ' +
      'Two lines about the perimeter are printed under the header: every room is a hardened container cut off from your home network, ' +
      'and the link is still a door to code on this computer. colloq doctor says the same.',
    async run(ctx) {
      const host = nameOf(ctx)
      const direct = directOf(ctx)
      if (ctx.dryRun) return await publishCall(ctx, host, direct)

      needEnv(ctx)
      ctx.ui.header(headline(ctx, host, direct))
      // Сразу под шапкой, ДО того как побежит вывод скрипта: ссылку раздают
      // после этой команды, и цена у неё не только в туннеле.
      ctx.ui.hint(PERIMETER.what)
      ctx.ui.hint(PERIMETER.fix)
      return await publishCall(ctx, host, direct)
    },
  },
]

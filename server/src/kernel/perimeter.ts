/**
 * Периметр контейнера комнаты на docker-бэкенде: что у ядра отнято сверх
 * памяти и процессора — привилегии, число процессов и дорога в локальную сеть.
 *
 * Решение владельца (18.09.2026): укреплённый профиль ВСЕГДА, а не только когда
 * занятие открыто наружу. До него у локального пути (`colloq start`, `make dev`,
 * `make run`/`make up`, образ vast) было две дыры сверх самой изоляции ядер:
 *
 *   1. привилегии по умолчанию docker. Ядро и так идёт от runner (uid 1000), но
 *      ограничивающий набор capabilities оставался полным: любой setuid-файл в
 *      образе (или пакет, поставленный студентом) возвращал бы их себе;
 *   2. открытая сеть. Код студента доставал до роутера преподавателя, до всех
 *      машин его домашней или университетской сети, до самого компьютера (на
 *      colima `host.docker.internal:3000` — это живой сервер Colloq, проверено
 *      18.09) и до метаданных облака 169.254.169.254 на арендованной машине.
 *
 * Что стало.
 *
 * Привилегии — флагами `docker run` (`roomHardeningArgs`): cap-drop ALL,
 * no-new-privileges, явный uid 1000, pids-limit. Добавлять обратно нечего:
 * образ не делает ничего от root на старте — kernel/Dockerfile кончается
 * `USER runner`, и Jupyter стартует сразу от него (проверено: CapEff и CapBnd
 * внутри — нули, ядро, pip и терминал работают).
 *
 * Сеть — правилами iptables на машине docker-демона, в цепочках, которыми
 * владеем только мы (COLLOQ-ROOMS-*), с переходами из DOCKER-USER (всё, что
 * контейнер шлёт дальше хоста) и из INPUT (всё, что он шлёт самому хосту: его
 * адресам в LAN, шлюзу моста, соседним опубликованным портам). DOCKER-USER —
 * единственное место в FORWARD, которое docker обещает не трогать и ставит
 * ПЕРВЫМ: правило, вставленное в сам FORWARD, демон после перезапуска обогнал
 * бы своими ACCEPT. Интернет остаётся: запрещены только частные и служебные
 * диапазоны (BLOCKED_V4), остальное идёт как шло — pip, датасеты, API.
 *
 * Ставит правила короткоживущий контейнер-помощник через тот же сокет docker,
 * который у сервера уже есть (`--privileged --pid=host --net=host`). Внутри он
 * находит процесс dockerd и зовёт iptables В ЕГО пространстве имён файлов
 * (nsenter -m). Так вопрос «iptables-nft или iptables-legacy» решается сам:
 * это ровно тот бинарь, которым пользуется демон, — ошибиться бэкендом, как
 * ошибся бы свой iptables в своём образе, тут нельзя. И так же это работает на
 * всех трёх формах: colima и Docker Desktop (демон в своей Linux-VM — туда и
 * попадаем), обычный Linux (демон на хосте). Образ помощника — образ ядра:
 * он заведомо есть на машине, где собираются поднимать комнату, и в нём есть
 * nsenter (util-linux в Debian обязателен).
 *
 * Не вышло поставить — комната НЕ поднимается (RoomPerimeterError с
 * переведённым текстом: что случилось и как чинить). Молча открыть сеть было
 * бы хуже отказа: преподаватель думает, что защищён. Для доверенной машины,
 * где помощник запуститься не может (rootless docker, Docker Desktop с
 * Enhanced Container Isolation, podman), есть явный выход:
 * COLLOQ_ROOM_NETWORK=open — комнаты идут без запрета, сервер и `colloq doctor`
 * говорят об этом вслух.
 *
 * Три тонкости, из-за которых правила именно такие.
 *
 * DNS. Встроенный резолвер docker (127.0.0.11) пересылает запросы иногда из
 * пространства имён хоста (`ExtServers: [host(…)]` — так на colima и на Linux
 * с systemd-resolved), а иногда ИЗ СЕТИ КОНТЕЙНЕРА — и тогда адрес назначения
 * частный: 192.168.65.7 у Docker Desktop, роутер 192.168.1.1 на обычном
 * Linux, 169.254.169.254 на GCP. Поэтому порт 53 разрешён до любого адреса:
 * без этого на половине машин не работал бы ни один `pip install`. Цена —
 * студент может спросить DNS у роутера; соединиться с тем, что узнал, он всё
 * равно не может.
 *
 * Ответы. Сервер ходит к Jupyter комнаты сам (опубликованный порт на петле или
 * имя в общей сети), и ответ контейнера — это пакет ИЗ подсети комнат В
 * частный адрес. Первое правило каждой цепочки — ESTABLISHED,RELATED: всё, что
 * начал не контейнер, проходит.
 *
 * IPv6. Правил для него нет, потому что нет его самого: контейнер комнаты
 * поднимается с `disable_ipv6=1`. Сеть комнат заводится без IPv6, но и в сети
 * compose, и при `ipv6: true` в daemon.json ядро не получит ни одного
 * v6-адреса — ни глобального, ни fe80:: на мосту, — значит, и обойти запрет по
 * v6 нечем.
 */
import os from 'node:os'
import { tr } from '@shared/i18n'

/** Сеть комнат, которую сервер заводит сам, когда живёт на хосте. */
export const ROOM_NETWORK = 'colloq-rooms'

/**
 * Подсеть этой сети — нарочно вне пулов docker (172.17–31/16 и 192.168/16 по
 * /20): так её не займёт первая попавшаяся сеть compose, и `network create` не
 * упадёт на «Pool overlaps». /22 — тысяча адресов, контейнеров столько не
 * бывает даже на большой машине; адрес держит только ЖИВОЙ контейнер.
 * Перебивается KERNEL_ROOM_SUBNET — если эта подсеть у кого-то уже занята
 * LAN или VPN.
 */
export const DEFAULT_ROOM_SUBNET = '10.213.0.0/22'

/**
 * Версия профиля — метка `colloq.profile` на контейнере комнаты.
 *
 * Контейнер без неё поднят до укрепления: живой доживает до остановки (сносить
 * его посреди пары — это потерять все переменные), остановленный пересоздаётся
 * при следующем подъёме. Поменяется профиль — поднимем число, и то же правило
 * переведёт комнаты на новый сам.
 */
export const ROOM_PROFILE = '1'

/** Метка docker, по которой помощник отличают от комнат. */
export const PERIMETER_KIND = 'room-perimeter'

/** Комментарий на наших переходах: по нему (и только по нему) мы их находим. */
export const PERIMETER_TAG = 'colloq-rooms'

const CHAIN_FWD = 'COLLOQ-ROOMS-FWD'
const CHAIN_IN = 'COLLOQ-ROOMS-IN'
const CHAIN_DENY = 'COLLOQ-ROOMS-DENY'

/**
 * Куда комнате нельзя. Список владельца плюс то, что туда не ходят по
 * определению: «эта сеть» 0/8 и зарезервированное 240/4 с широковещанием.
 *
 * 198.18.0.0/15 здесь нет намеренно: на него отвечают fake-ip DNS у Clash и
 * sing-box, и на такой машине запрет увёл бы у комнаты весь интернет.
 */
export const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const

/* ------------------------------------------------------------- настройки */

export type RoomNetworkMode = 'blocked' | 'open'

let unknownModeWarned = false

/**
 * COLLOQ_ROOM_NETWORK: `open` — выход для доверенной машины, всё остальное —
 * запрет. Опечатка («opne») открытой сетью не становится: ошибиться в сторону
 * дыры нельзя, поэтому незнакомое слово — это запрет и строка в журнале.
 */
export function roomNetworkMode(env: NodeJS.ProcessEnv = process.env): RoomNetworkMode {
  const raw = (env.COLLOQ_ROOM_NETWORK ?? '').trim().toLowerCase()
  if (raw === 'open') return 'open'
  if (raw !== '' && raw !== 'blocked' && !unknownModeWarned) {
    unknownModeWarned = true
    console.warn(`[kernel] COLLOQ_ROOM_NETWORK=${raw}: unknown value, local addresses stay blocked (use "open" to lift the block)`)
  }
  return 'blocked'
}

/**
 * Потолок процессов комнаты: KERNEL_PIDS, по умолчанию 512.
 *
 * Fork-бомба в ячейке без потолка кладёт не комнату, а машину — и все соседние
 * занятия вместе с ней. 512 с запасом хватает Jupyter, ядру, терминалу и
 * `DataLoader(num_workers=8)`; прод держит 256 на Pod (deploy/k3s).
 */
export function pidsLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number((env.KERNEL_PIDS ?? '').trim())
  return Number.isInteger(value) && value >= 64 ? value : 512
}

/**
 * Потолок процессов КОНТЕЙНЕРА ЛИЧНЫХ ТЕТРАДЕЙ: KERNEL_OWN_PIDS, по умолчанию 2048.
 *
 * Отдельное число, потому что считает он другое. В контейнере комнаты живёт
 * одно ядро на тетрадь занятия плюс терминал; в контейнере личных тетрадей —
 * десятки ядер сразу, по одному на открытый черновик, и каждое ipykernel
 * держит полтора десятка потоков само по себе. Комнатных 512 не хватает уже на
 * тридцати ядрах, и кончается это не отказом, а `BlockingIOError` посреди
 * чужого запуска. 2048 — те же 512 «на комнату», умноженные на потолок живых
 * ядер (pool.ts · ownKernelMax): fork-бомба по-прежнему упирается в стенку, а
 * стенка эта — не у соседа.
 */
export function ownPidsLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number((env.KERNEL_OWN_PIDS ?? '').trim())
  return Number.isInteger(value) && value >= 64 ? value : 2048
}

/** KERNEL_ROOM_SUBNET, если он — настоящий IPv4 CIDR; иначе умолчание. */
export function roomSubnetSetting(env: NodeJS.ProcessEnv = process.env): { subnet: string; explicit: boolean } {
  const raw = (env.KERNEL_ROOM_SUBNET ?? '').trim()
  if (raw === '') return { subnet: DEFAULT_ROOM_SUBNET, explicit: false }
  if (parseCidr(raw) === null) {
    console.warn(`[kernel] KERNEL_ROOM_SUBNET=${raw} is not an IPv4 CIDR; using ${DEFAULT_ROOM_SUBNET}`)
    return { subnet: DEFAULT_ROOM_SUBNET, explicit: false }
  }
  return { subnet: raw, explicit: true }
}

/* ------------------------------------------------------- флаги docker run */

/**
 * Укрепление контейнера комнаты — то, что прод задаёт securityContext'ом Pod
 * (runtime/src/controller.ts), в словах docker.
 *
 * Чего здесь нет и почему. `--read-only`: студенты ставят пакеты `%pip
 * install` в слой контейнера, и прод ради этого монтирует /home/runner и /tmp
 * отдельно — здесь это сломало бы привычный путь без выигрыша. `--tmpfs /tmp`:
 * tmpfs считается в память комнаты, и датасет, скачанный в /tmp, убивал бы
 * ядро по OOM. seccomp не трогаем — остаётся профиль docker по умолчанию, тот
 * же RuntimeDefault, что в проде.
 */
export function roomHardeningArgs(
  env: NodeJS.ProcessEnv = process.env,
  /** Контейнер личных тетрадей считает процессы по своему потолку — `ownPidsLimit`. */
  role: 'room' | 'own' = 'room',
): string[] {
  return [
    // Тот же uid, что в образе и в проде (runAsUser/runAsGroup 1000): образ,
    // собранный кем-то с `USER root` в конце, не станет root-комнатой.
    '--user=1000:1000',
    '--cap-drop=ALL',
    // setuid-файлы и file capabilities больше ничего не дают — ни su, ни
    // бинарю, который студент поставил себе сам.
    '--security-opt=no-new-privileges',
    `--pids-limit=${role === 'own' ? ownPidsLimit(env) : pidsLimit(env)}`,
    // Без IPv6 вообще: правил для v6 нет, значит, не должно быть и адресов.
    '--sysctl=net.ipv6.conf.all.disable_ipv6=1',
    '--sysctl=net.ipv6.conf.default.disable_ipv6=1',
    '--label',
    `colloq.profile=${ROOM_PROFILE}`,
  ]
}

/**
 * Аргументы `docker network create` для сети комнат.
 *
 * ICC выключен: комнаты не видят друг друга даже тогда, когда наших правил нет
 * (COLLOQ_ROOM_NETWORK=open), — Jupyter соседа закрыт токеном, но стучаться в
 * него незачем. Сервер ходит к комнате не по этой сети, а через опубликованный
 * порт, поэтому ICC ему не нужен. IPv6 выключен явно — на случай
 * `default-network-opts` с ipv6 в daemon.json.
 */
export function networkCreateArgs(subnet: string | null): string[] {
  return [
    'network',
    'create',
    '--driver=bridge',
    ...(subnet ? [`--subnet=${subnet}`] : []),
    '--ipv6=false',
    '-o',
    'com.docker.network.bridge.enable_icc=false',
    '--label',
    'colloq.kind=room-network',
    ROOM_NETWORK,
  ]
}

/* ---------------------------------------------------------------- адреса */

export function parseIpv4(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

export function parseCidr(cidr: string): { base: number; bits: number } | null {
  const [ip, bitsText, extra] = cidr.trim().split('/')
  if (extra !== undefined || ip === undefined || bitsText === undefined) return null
  if (!/^\d{1,2}$/.test(bitsText)) return null
  const bits = Number(bitsText)
  const base = parseIpv4(ip)
  if (base === null || bits > 32) return null
  return { base, bits }
}

export function ipv4InCidr(ip: string, cidr: string): boolean {
  const addr = parseIpv4(ip)
  const net = parseCidr(cidr)
  if (addr === null || net === null) return false
  if (net.bits === 0) return true
  const size = 2 ** (32 - net.bits)
  return Math.floor(addr / size) === Math.floor(net.base / size)
}

/**
 * Свои адреса сервера внутри подсети комнат — только когда сервер сам в
 * контейнере и делит сеть с комнатами (`make up`, образ vast).
 *
 * Правила пишутся по подсети-источнику, а сервер в этой подсети тоже живёт:
 * без исключения он потерял бы и туннель (frpc, cloudflared ходят из того же
 * контейнера), и частный адрес модели Оракула, и дорогу к ядрам. Подделать
 * этот адрес из комнаты нечем: у ядра нет ни NET_RAW, ни NET_ADMIN.
 */
export function ownAddresses(
  subnets: readonly string[],
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const found = new Set<string>()
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      if (subnets.some((subnet) => ipv4InCidr(info.address, subnet))) found.add(info.address)
    }
  }
  return [...found].sort()
}

/** IPv4-подсети из вывода `docker network inspect` (IPv6 отбрасываем: его у комнат нет). */
export function ipv4Subnets(text: string): string[] {
  return text
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => parseCidr(item) !== null)
}

/* -------------------------------------------------------------- правила */

export interface PerimeterPlan {
  /** Подсети, из которых шлют контейнеры комнат. */
  subnets: string[]
  /** Адреса внутри них, которым можно всё (сервер в общей сети compose). */
  exempt: string[]
}

/**
 * Тело для `iptables-restore --noflush` — три наши цепочки целиком.
 *
 * Атомарно: либо ядро получает весь набор, либо ничего; объявление своей
 * цепочки строкой `:ИМЯ` при --noflush очищает именно её, и повторный вызов не
 * плодит копий (проверено на iptables-nft 1.8.10 colima). Чужих цепочек тело
 * не касается вовсе — переходы в DOCKER-USER и INPUT ставит скрипт отдельно,
 * с проверкой `-C`.
 *
 * `reject` — отказ сразу: TCP получает RST («Connection refused» за
 * миллисекунду), остальное — ICMP «administratively prohibited». Не DROP:
 * запрос, повисший на минуту, студент примет за «интернет тормозит». ICMP
 * ядро ограничивает по частоте, RST — нет; поэтому TCP отдельно. `drop` —
 * запасной путь для ядра без модуля REJECT.
 */
export function perimeterRules(plan: PerimeterPlan, deny: 'reject' | 'drop' = 'reject'): string {
  const lines = [
    '*filter',
    `:${CHAIN_FWD} - [0:0]`,
    `:${CHAIN_IN} - [0:0]`,
    `:${CHAIN_DENY} - [0:0]`,
  ]
  if (deny === 'reject') {
    lines.push(`-A ${CHAIN_DENY} -p tcp -j REJECT --reject-with tcp-reset`)
    lines.push(`-A ${CHAIN_DENY} -j REJECT --reject-with icmp-admin-prohibited`)
  } else {
    lines.push(`-A ${CHAIN_DENY} -j DROP`)
  }
  /*
   * Обе цепочки начинаются одинаково: ответы проходят, исключённые адреса
   * проходят, DNS проходит. Всё это — RETURN, а не ACCEPT: решение остаётся
   * за докером и за файрволом хоста, мы только вычёркиваем своё.
   */
  for (const chain of [CHAIN_FWD, CHAIN_IN]) {
    lines.push(`-A ${chain} -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN`)
    for (const address of plan.exempt) lines.push(`-A ${chain} -s ${address}/32 -j RETURN`)
    lines.push(`-A ${chain} -p udp -m udp --dport 53 -j RETURN`)
    lines.push(`-A ${chain} -p tcp -m tcp --dport 53 -j RETURN`)
  }
  for (const subnet of plan.subnets) {
    // Дальше хоста: частные и служебные адреса — нет, интернет — да.
    for (const range of BLOCKED_V4) lines.push(`-A ${CHAIN_FWD} -s ${subnet} -d ${range} -j ${CHAIN_DENY}`)
    // Самому хосту — ничего: ни его адресам в LAN, ни шлюзу моста, ни
    // опубликованным портам соседей, ни сервису на 0.0.0.0.
    lines.push(`-A ${CHAIN_IN} -s ${subnet} -j ${CHAIN_DENY}`)
  }
  lines.push('COMMIT')
  return lines.join('\n') + '\n'
}

/**
 * Найти dockerd и позвать его iptables — общая голова скриптов помощника.
 *
 * dockerd ищется не первым попавшимся по имени, а тот, чьё сетевое
 * пространство совпадает с нашим: `--net=host` по определению даёт сеть
 * самого демона, а вложенный dockerd (docker-in-docker соседа) живёт в своей.
 */
const FIND_DOCKERD = `set -u
say() { printf 'colloq-perimeter: %s\\n' "$*"; }
me=$(readlink /proc/self/ns/net)
pid=
for p in /proc/[0-9]*; do
  [ "$(cat "$p/comm" 2>/dev/null)" = dockerd ] || continue
  [ "$(readlink "$p/ns/net" 2>/dev/null)" = "$me" ] || continue
  pid=\${p#/proc/}
  break
done
fw() { nsenter -t "$pid" -m -- "$@"; }
`

/**
 * Скрипт помощника: поставить (или обновить) правила и переходы к ним.
 *
 * Коды выхода — чтобы отказ назвал причину: 20 — демона не видно (podman,
 * удалённый демон, rootless без pid хоста), 21 — нет DOCKER-USER (у демона
 * `iptables: false` или nftables-бэкенд docker 29), 22 — iptables не принял
 * правила, 23 — не встали переходы.
 */
export function perimeterScript(plan: PerimeterPlan): string {
  return `${FIND_DOCKERD}[ -n "$pid" ] || { say 'no dockerd process in the host namespaces'; exit 20; }
fw iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || { say 'no DOCKER-USER chain: Docker does not manage iptables on this host'; exit 21; }
if ! fw iptables-restore -w --noflush <<'COLLOQ_RULES'
${perimeterRules(plan, 'reject')}COLLOQ_RULES
then
  say 'REJECT is unavailable, falling back to DROP'
  fw iptables-restore -w --noflush <<'COLLOQ_RULES' || { say 'iptables-restore refused the rules'; exit 22; }
${perimeterRules(plan, 'drop')}COLLOQ_RULES
fi
fw iptables -w -C DOCKER-USER -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_FWD} 2>/dev/null \\
  || fw iptables -w -I DOCKER-USER 1 -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_FWD} \\
  || { say 'cannot hook DOCKER-USER'; exit 23; }
fw iptables -w -C INPUT -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_IN} 2>/dev/null \\
  || fw iptables -w -I INPUT 1 -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_IN} \\
  || { say 'cannot hook INPUT'; exit 23; }
say ok
`
}

/**
 * Снять всё своё: переходы по комментарию, потом свои цепочки. Чужие правила
 * не трогаются — удаление идёт ровно по той строке, которую мы вставляли.
 */
export function perimeterRemovalScript(): string {
  return `${FIND_DOCKERD}[ -n "$pid" ] || exit 0
while fw iptables -w -D DOCKER-USER -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_FWD} 2>/dev/null; do :; done
while fw iptables -w -D INPUT -m comment --comment ${PERIMETER_TAG} -j ${CHAIN_IN} 2>/dev/null; do :; done
for chain in ${CHAIN_FWD} ${CHAIN_IN} ${CHAIN_DENY}; do fw iptables -w -F "$chain" 2>/dev/null; done
for chain in ${CHAIN_FWD} ${CHAIN_IN} ${CHAIN_DENY}; do fw iptables -w -X "$chain" 2>/dev/null; done
say removed
`
}

/**
 * `docker run` помощника. Привилегии — его, а не комнаты: он живёт секунду,
 * исполняет только наш скрипт и удаляется сам (`--rm`). `--pull=never`: образ
 * ядра не лежит ни в одном реестре, и попытка скачать его только отняла бы
 * время перед тем же отказом.
 */
export function helperArgs(image: string, script: string): string[] {
  return [
    'run',
    '--rm',
    '--privileged',
    '--pid=host',
    '--network=host',
    '--user=0:0',
    '--pull=never',
    '--no-healthcheck',
    '--label',
    `colloq.kind=${PERIMETER_KIND}`,
    '--entrypoint=sh',
    image,
    '-c',
    script,
  ]
}

/* ------------------------------------------------------------ установка */

interface RunResult {
  code: number
  out: string
}
export type DockerRun = (args: string[], timeoutMs?: number) => Promise<RunResult>

/** Отказ поднять комнату без запрета — текст уже переведён и говорит, что делать. */
export class RoomPerimeterError extends Error {
  constructor(readonly reason: string) {
    super(tr('server.roomPerimeter.refused', { p0: reason }))
    this.name = 'RoomPerimeterError'
  }
}

/**
 * Где комнаты и как их узнать: имя сети и заводить ли её самим.
 *
 * На хосте (`make dev`, `colloq start`, `make run`) сеть наша — `colloq-rooms`.
 * В контейнере (`make up`, vast) комнаты живут в сети, которую сервер делит с
 * ними (KERNEL_NETWORK), — её заводит тот, кто нас запустил, а подсеть мы
 * читаем у docker.
 */
export interface RoomNetworkTarget {
  network: string
  create: boolean
}

/**
 * Успех помним минуту — не дольше.
 *
 * Правило может исчезнуть: перезагрузка VM colima или Docker Desktop, `iptables
 * -F` руками. Проверять на каждый подъём комнаты — лишний привилегированный
 * контейнер на каждого из тридцати студентов в первую минуту пары; не
 * проверять никогда — поверить в правило, которого уже нет. Минута — это один
 * помощник на волну подъёмов и свежий взгляд после любой перезагрузки демона
 * (она сама длится дольше).
 */
const FRESH_MS = 60_000

let applied: { key: string; at: number } | null = null
let inflight: Promise<void> | null = null
/** Последний отказ — чтобы сказать его и тем, кто спросит о состоянии. */
let lastProblem: string | null = null
let openAnnounced = false

export function perimeterProblem(): string | null {
  return lastProblem
}

/** Не верить запомненному успеху: следующий подъём комнаты спросит docker заново. */
export function perimeterStale(): void {
  applied = null
}

/** Забыть всё — тестам, чтобы один случай не наследовал память другого. */
export function forgetPerimeter(): void {
  applied = null
  inflight = null
  lastProblem = null
  openAnnounced = false
}

/** Подсети сети комнат; заводит её, если это наша сеть и её нет. */
async function roomSubnets(docker: DockerRun, target: RoomNetworkTarget): Promise<string[]> {
  const inspect = () =>
    docker(['network', 'inspect', target.network, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'], 10_000)
  let found = await inspect()
  if (found.code !== 0 && target.create) {
    const { subnet, explicit } = roomSubnetSetting()
    let made = await docker(networkCreateArgs(subnet), 30_000)
    /*
     * Подсеть уже чья-то (другая сеть docker на этой машине) — и её не
     * называли явно: пусть docker выберет сам. Правила всё равно пишутся по
     * той подсети, которую сеть получила на деле, а не по умолчанию.
     */
    if (made.code !== 0 && !explicit && /overlap/i.test(made.out)) {
      console.warn(`[kernel] ${subnet} is taken on this Docker; ${ROOM_NETWORK} gets a subnet from Docker's pool`)
      made = await docker(networkCreateArgs(null), 30_000)
    }
    // Два процесса завели сеть разом — второму достаточно того, что она есть.
    if (made.code !== 0 && !/already exists/i.test(made.out)) {
      throw new RoomPerimeterError(`docker network create ${ROOM_NETWORK}: ${made.out.slice(-200)}`)
    }
    if (made.code === 0) console.log(`[kernel] created docker network ${ROOM_NETWORK} for room kernels`)
    found = await inspect()
  }
  if (found.code !== 0) throw new RoomPerimeterError(`docker network inspect ${target.network}: ${found.out.slice(-200)}`)
  const subnets = ipv4Subnets(found.out)
  if (subnets.length === 0) throw new RoomPerimeterError(`network ${target.network} has no IPv4 subnet`)
  return subnets
}

/**
 * Образ для помощника: тот, что просили (образ поднимаемой комнаты), иначе
 * любой colloq-kernel на машине. Нет ни одного — значит, и комнату поднимать
 * не из чего; такой отказ скажет «окружение не собрано» раньше нас.
 */
async function helperImage(docker: DockerRun, preferred: string | null): Promise<string | null> {
  if (preferred) {
    const own = await docker(['image', 'inspect', preferred, '--format', '{{.Id}}'], 10_000)
    if (own.code === 0) return preferred
  }
  const any = await docker(['images', 'colloq-kernel', '--format', '{{.Repository}}:{{.Tag}}'], 10_000)
  if (any.code !== 0) return null
  return any.out.split('\n').map((line) => line.trim()).find((line) => line && !line.endsWith(':<none>')) ?? null
}

/**
 * Сеть комнат есть, и запрет на локальные адреса стоит — или отказ.
 *
 * Зовётся перед каждым `docker run` и `docker start` комнаты (успех помнится
 * минуту, одновременные вызовы делят один помощник) и один раз на старте
 * сервера. Бросает RoomPerimeterError — и тогда комната не поднимается.
 */
export async function ensureRoomPerimeter(
  docker: DockerRun,
  target: RoomNetworkTarget,
  image: string | null,
): Promise<void> {
  const subnets = await roomSubnets(docker, target)
  return applyPerimeter(docker, target, subnets, image)
}

/**
 * То же на старте сервера — заранее, чтобы первая комната не ждала помощника,
 * а оператор увидел отказ в журнале до пары, а не на первом Run.
 *
 * Образа ядра ещё нет (vast собирает его в фоне после старта) — не отказ:
 * комнату всё равно не из чего поднимать, а запрет поставит её первый подъём.
 */
export async function warmPerimeter(docker: DockerRun, target: RoomNetworkTarget, image: string): Promise<void> {
  if (roomNetworkMode() === 'blocked' && (await helperImage(docker, image)) === null) {
    console.log('[kernel] no kernel image yet; the room network block is installed with the first room')
    return
  }
  try {
    await ensureRoomPerimeter(docker, target, image)
  } catch (err) {
    console.error(`[kernel] ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function applyPerimeter(
  docker: DockerRun,
  target: RoomNetworkTarget,
  subnets: string[],
  image: string | null,
): Promise<void> {
  if (roomNetworkMode() === 'open') {
    lastProblem = null
    if (!openAnnounced) {
      openAnnounced = true
      console.warn(
        '[kernel] COLLOQ_ROOM_NETWORK=open: room kernels can reach this machine, its LAN and cloud metadata. Remove the line to block local addresses.',
      )
      // Открыто — значит открыто: запрет, поставленный прошлым запуском,
      // снимается. Не вышло (помощника тут и не пускают) — снимать нечего.
      const img = await helperImage(docker, image)
      if (img) {
        const res = await docker(helperArgs(img, perimeterRemovalScript()), 30_000)
        if (res.code === 0 && /removed/.test(res.out)) applied = null
      }
    }
    return
  }
  const plan: PerimeterPlan = { subnets, exempt: target.create ? [] : ownAddresses(subnets) }
  const key = JSON.stringify(plan)
  if (applied && applied.key === key && Date.now() - applied.at < FRESH_MS) return
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const img = await helperImage(docker, image)
      if (!img) throw new RoomPerimeterError('no colloq-kernel image to run the firewall helper from')
      const res = await docker(helperArgs(img, perimeterScript(plan)), 60_000)
      if (res.code !== 0 || !/colloq-perimeter: ok/.test(res.out)) {
        const said = res.out.split('\n').filter((line) => line.trim()).slice(-2).join(' · ')
        throw new RoomPerimeterError((said || `exit ${res.code}`).slice(0, 300))
      }
      if (!applied || applied.key !== key) {
        console.log(`[kernel] room network ${target.network}: local addresses blocked for ${subnets.join(', ')}`)
      }
      applied = { key, at: Date.now() }
      lastProblem = null
    } catch (err) {
      applied = null
      lastProblem = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      inflight = null
    }
  })()
  return inflight
}

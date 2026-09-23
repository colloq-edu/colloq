/**
 * `colloq start --share`: одна ссылка для класса — и что стоит за ней.
 *
 * Сам туннель открывает scripts/host.sh, как и у --host: он же держит
 * расписку временного адреса, проверяет адрес снаружи и убирает за собой.
 * Здесь три вещи, которых у скрипта нет.
 *
 * Замок (publishRefusal). Решение автора: занятие уходит в интернет только
 * тогда, когда ядро каждой комнаты сидит в своём контейнере. Ссылка — это
 * дверь: кто её получил, тот запускает код на этом компьютере, и общее ядро
 * на всех за такой дверью — это чужой код рядом с тетрадями всего класса.
 * Проверка стоит дважды — до запуска по настройкам и перед туннелем по
 * живому серверу, — а третья, та же по смыслу, стоит в host.sh: её проходят
 * и `colloq host`, и `make host`, которые супервизора не видят.
 *
 * Блок ссылки (renderShareBlock). Скрипт печатает адрес туннеля, но студенту
 * нужен не он, а /s/<id> занятия, — а про занятия знает только база. Блок
 * печатается один раз, когда host.sh сказал «адрес поднят и проверен»
 * строкой-меткой (parseShareMarker), и повторяет всё, что преподавателю надо
 * знать про эту ссылку, в одном месте.
 *
 * Список занятий (readClasses) — из базы, только чтение. Спрашивать сервер
 * нечем: список занятий отдают только вошедшему в панель, а открытый
 * маршрут со списком ушёл бы в туннель вместе со всем остальным — к серверу
 * cloudflared приходит с того же 127.0.0.1, что и мы.
 *
 * Имя начинается с launch: стенд tests/local-launch-process.test.mts
 * копирует cli/src/launch*.ts, и другое имя там бы не нашлось.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Как ядра комнат отделены друг от друга — словами /api/health · isolation. */
type Isolation = 'docker' | 'broker'

export interface PublishCheck {
  /** Действующее окружение сервера: .env плюс переменные, как их увидит сервер. */
  env: Record<string, string | undefined>
  /** Отвечает ли демон docker; не спрашивали — undefined. */
  dockerReachable?: boolean
  /** Ответ /api/health живого сервера; не спрашивали — undefined, не ответил — null. */
  health?: Record<string, unknown> | null
}

/**
 * Можно ли выставлять это занятие наружу: null — можно, строка — почему нет.
 *
 * Отказ — только словами о том, что видно отсюда. KERNEL_BACKEND по
 * умолчанию — docker: так его выбирает сервер без NODE_ENV=production
 * (server/src/kernel/runtime-client.ts · selectKernelBackend), и так его
 * ставит супервизор (launch-config.ts). test — бэкенд тестов без изоляции.
 * Последнее слово за сервером: он называет то, чем разделены комнаты на
 * самом деле, полем isolation — и ставит его, только когда ядро готово.
 */
export function publishRefusal(check: PublishCheck): string | null {
  const backend = (check.env.KERNEL_BACKEND ?? '').trim() || 'docker'
  if ((check.env.KERNEL_ISOLATION ?? '').trim().toLowerCase() === 'off')
    return 'KERNEL_ISOLATION=off is set, so the rooms would not be kept apart'
  if (backend !== 'docker' && backend !== 'broker')
    return `KERNEL_BACKEND=${backend} does not give every room a container of its own`
  if (backend === 'docker' && check.dockerReachable === false)
    return 'Docker is not responding, and without it nothing keeps the rooms apart'
  if (check.health !== undefined) {
    const said = check.health?.isolation
    if (said !== (backend as Isolation))
      return typeof said === 'string'
        ? `the server reports room isolation "${said}", not ${backend}`
        : 'the server does not confirm that every room runs in a container of its own'
  }
  return null
}

/** Отказ целиком: что случилось, почему это важно, где занятие теперь. */
export function refusalText(reason: string, local?: string): string {
  return [
    `Not published: ${reason}.`,
    'A public link lets anyone who has it run code on this computer, so colloq',
    'publishes a class only when every room runs in a Docker container of its own.',
    'Check Docker and KERNEL_BACKEND / KERNEL_ISOLATION in .env, then try again.',
    ...(local ? [`The class keeps running locally: ${local}`] : []),
  ].join('\n')
}

/** Строка-метка host.sh под COLLOQ_SHARE=1: адрес поднят, проверка снаружи прошла или нет. */
export const SHARE_MARKER = '@colloq-share'

export function parseShareMarker(line: string): { url: string; verified: boolean } | null {
  const match = /^@colloq-share (ok|unverified) (https:\/\/[A-Za-z0-9.-]+)\/?\s*$/.exec(line)
  return match ? { url: match[2]!, verified: match[1] === 'ok' } : null
}

export interface ShareClass {
  id: string
  name: string
}

/**
 * Имя занятия для терминала: без управляющих байтов и не длиннее строки.
 *
 * Имя пишет преподаватель (или импорт из таблицы), и печатаем мы его в
 * терминал: ESC внутри имени перекрасил бы экран или стёр строку со ссылкой.
 */
function printable(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return clean.length > 48 ? clean.slice(0, 47) + '…' : clean
}

export interface ShareBlock {
  /** Публичный адрес туннеля, без / в конце. */
  url: string
  /**
   * Вход преподавателя на публичном адресе — с токеном установки, как у
   * Jupyter (launch-banner.ts · teacherLink). Без токена на диске — /admin.
   */
  teacher: string
  /** Локальный адрес: панель на этом компьютере. */
  local: string
  /** Самые новые занятия, не больше трёх. */
  classes: ShareClass[]
  /** Сколько занятий всего (неархивных). */
  total: number
  /** Проверка снаружи прошла; null — не проверяли (фоновый запуск). */
  verified: boolean | null
  /** Занятие ушло в фон: закрывает его colloq stop, а не Ctrl+C. */
  detached: boolean
  /** RELAY_DOMAIN из .env — чтобы совет про Россию был готовой командой. */
  relayDomain: string
}

/**
 * Блок ссылки. Строки — без цвета: они же ложатся в .colloq.log.
 *
 * Порядок — порядок вопросов преподавателя: что дать студентам; чего не
 * давать никому; сколько живёт ссылка; почему в следующий раз она другая;
 * откроется ли она в России. Каждое — одной-двумя строками, иначе блок
 * пролистывают целиком.
 */
export function renderShareBlock(block: ShareBlock): string[] {
  const out: string[] = [
    '',
    `  ┌ Colloq is online at ${block.url}`,
    '  │',
    '  │ Your panel on this address (the link signs you in — keep it to yourself):',
    `  │   ${block.teacher}`,
    '  │',
  ]
  const link = (item: ShareClass): string =>
    `  │   ${block.url}/s/${encodeURIComponent(item.id)}   ${printable(item.name)}`
  if (block.classes.length === 1 && block.total === 1) {
    out.push('  │ Give your students this link:', link(block.classes[0]!))
  } else if (block.classes.length > 0) {
    out.push('  │ Give your students the link of the class you teach (newest first):')
    for (const item of block.classes) out.push(link(item))
    const more = block.total - block.classes.length
    if (more > 0) out.push(`  │   … and ${more} more: the panel lists every class with its link`)
  } else {
    out.push(
      '  │ There is no class yet. Create one in the panel above and copy its link',
      '  │ from the list — the list already gives links on this public address.',
    )
  }
  out.push(
    '  │',
    '  │ Never share a link with /admin/ in it (/admin/t/…, /admin/k/…): it is a',
    '  │ key to the panel. Students only ever get /s/… links.',
  )
  if (block.verified === false)
    out.push(
      '  │',
      '  │ The check from this computer did not get through — usually the DNS of',
      '  │ this network, not the class. Open the link on a phone on mobile data.',
    )
  out.push(
    '  │',
    block.detached
      ? '  │ The link lives until colloq stop, which closes it with the class.'
      : '  │ The link lives while this terminal is open: Ctrl+C closes it and the class.',
    '  │ A quick tunnel gets a new address on every start: send the new link each time.',
    '  │ Cloudflare addresses do not open from Russia. For students there, use a relay:',
    block.relayDomain
      ? `  │   colloq start --host <name>.${block.relayDomain}`
      : '  │   colloq start --host <name> with RELAY_* in .env (see the docs: networking)',
    '  └',
    '',
  )
  return out
}

/**
 * Занятия этой базы — самые новые, неархивные; ошибка чтения = «занятий нет».
 *
 * better-sqlite3 — тот же драйвер, что у сервера, и он уже лежит в
 * node_modules рядом (в пакете их ставит шим, в репозитории — npm ci);
 * импорт отложен, чтобы stop и restart не грузили нативный модуль зря.
 * База открыта только на чтение: сервер пишет её в WAL, и читатель ему не
 * мешает. Промах здесь не срывает публикацию — блок скажет «создайте занятие
 * в панели», и это будет правдой с точностью до уже созданного.
 */
export async function readClasses(
  dataDir: string,
  limit = 3,
): Promise<{ classes: ShareClass[]; total: number }> {
  const file = path.join(dataDir, 'colloq.db')
  if (!fs.existsSync(file)) return { classes: [], total: 0 }
  try {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(file, { readonly: true, fileMustExist: true })
    try {
      const rows = db
        .prepare(
          'SELECT id, name FROM sessions WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT ?',
        )
        .all(limit) as ShareClass[]
      const { total } = db
        .prepare('SELECT COUNT(*) AS total FROM sessions WHERE archived_at IS NULL')
        .get() as { total: number }
      return {
        classes: rows.filter(
          (row) => typeof row.id === 'string' && /^[A-Za-z0-9_-]+$/.test(row.id),
        ),
        total,
      }
    } finally {
      db.close()
    }
  } catch {
    return { classes: [], total: 0 }
  }
}

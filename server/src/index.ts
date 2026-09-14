import { tr } from '@shared/i18n'
/**
 * Process entry point: one HTTP server, two WebSocket paths, one static bundle.
 *
 * Colloq is deliberately a single process behind a single origin. A seminar is
 * hosted by whoever runs `docker compose up` twenty minutes before class, so
 * everything a student touches — the page, the REST API, the CRDT socket and
 * the run-control socket — must arrive on the one URL that was written on the
 * whiteboard, with no reverse-proxy rules to get wrong.
 *
 * That single origin is also the whole delivery story: there is no CDN in front
 * of it and no proxy to add compression or cache headers, so the server does
 * both itself — в app.ts, где собрано приложение целиком. Здесь остаётся то,
 * что относится к ПРОЦЕССУ: сокеты, порт, сигналы и остановка.
 */
// Первым: он правит console, а импорты поднимаются наверх — всё, что модули
// печатают при загрузке, должно застать уже исправленную. Имена из него берутся
// здесь же — это тот самый модуль, а не второй: журнал у процесса один.
import { startJournal, stopJournal } from './log.js'
import { retireDatabaseKernels, stopsLocalKernelsOnExit } from './local/kernel-cleanup.js'
import { dropLocalRoomKernel } from './kernel/pool.js'
import { kernelRetirementInProgress } from './kernel/retirement.js'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import type { Duplex } from 'node:stream'
import { isClaimed, readSetupToken, setupTokenPath } from './admin/auth.js'
import { verifyToken, type TokenPayload } from './auth.js'
import { banFor, banRefusal, type BanInForce } from './bans.js'
import { aiEnabled, config, DEV_JUPYTER_TOKEN } from './config.js'
import { handleCollabSocket, roomCensus, shutdownCollab } from './collab/index.js'
import { handleFileSocket } from './collab/files.js'
import { normalizePath } from '@shared/paths'

import { handleControlSocket } from './control.js'
import { db, closeDatabase, getSession, touchLastSeenAll } from './db.js'
import { kernelCensus, shutdownKernels } from './kernel/index.js'
import { sweepAllStaleUploads } from './workspace.js'
import { roleFor } from './routes/sessions.js'
import { app } from './app.js'

/** A whole notebook's state travels in one sync frame; images make it big. */
const MAX_WS_PAYLOAD = 16 * 1024 * 1024
const SHUTDOWN_GRACE_MS = stopsLocalKernelsOnExit() ? 70000 : 8000
const UPGRADE_PATH = /^\/(collab|control)\/([A-Za-z0-9_-]{1,64})\/?$/
/*
 * У файла в адресе два отрезка: комната и сам файл, путь в base64url.
 *
 * Путь ушёл из строки запроса в адрес не ради красоты: y-websocket заводит
 * BroadcastChannel по адресу без параметров, и два разных файла одной комнаты,
 * открытые в двух вкладках браузера, оказывались в одном канале — правки одного
 * приезжали в документ другого. Имя комнаты обязано быть разным.
 */
const FILE_PATH = /^\/file\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,2048})\/?$/

const server = http.createServer(app)

/* ------------------------------------------------------------ websockets */

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_WS_PAYLOAD,
  perMessageDeflate: {
    /*
     * Yjs deltas are a few dozen binary bytes; deflating those costs more CPU
     * and more latency than the bytes are worth. The frames that matter are the
     * initial sync steps, which are tens of kilobytes and compress well.
     *
     * Это НИЖНЯЯ граница: мельче — не сжимать. Верхняя нужна тоже (двухмегабайтная
     * картинка в base64 сжимается на четверть, а стоит пятисот заданий zlib —
     * сжатие здесь на сокет, а не на кадр), но выразить её этой настройкой
     * нельзя: она сняла бы сжатие как раз с тех первых шагов, ради которых
     * заведена. Поэтому потолок стоит на месте отправки, где виден размер
     * кадра, — `MAX_DEFLATE_BYTES` в collab/index.ts.
     */
    threshold: 8 * 1024,
    zlibDeflateOptions: { level: 4, memLevel: 8 },
    zlibInflateOptions: { chunkSize: 16 * 1024 },
    // No context takeover: a seminar holds thirty sockets open at once, and a
    // retained zlib window per socket is memory spent on frames that mostly
    // never get compressed anyway.
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 13,
    concurrencyLimit: 10,
  },
})

/**
 * «Был здесь» — не на каждое рукопожатие, а раз в несколько секунд пачкой.
 *
 * Отметка ставилась UPDATE'ом прямо здесь, а сокетов у одной вкладки два:
 * пятьсот вернувшихся вкладок — это тысяча отдельных транзакций в ту самую
 * секунду, когда все ждут возврата комнаты. Читает отметку список людей, и
 * несколько секунд опоздания в ней не значат ничего; момент времени берётся
 * тот, когда человек пришёл, а не тот, когда до него дошла запись.
 *
 * Ключ — множество: та же вкладка своими двумя сокетами (и своим повторным
 * подключением) отмечается один раз.
 */
const LAST_SEEN_EVERY_MS = 5_000
const lastSeenPending = new Set<string>()
let lastSeenTimer: NodeJS.Timeout | null = null

function flushLastSeen(): void {
  if (lastSeenTimer) {
    clearTimeout(lastSeenTimer)
    lastSeenTimer = null
  }
  if (lastSeenPending.size === 0) return
  const batch = [...lastSeenPending]
  lastSeenPending.clear()
  try {
    // Время — одно на всю пачку: точность «был здесь» ближе пяти секунд не
    // нужна никому, а своё время у каждого означало бы транзакцию на каждого,
    // то есть ровно то, от чего пачка и заводится.
    touchLastSeenAll(batch)
  } catch {
    /* presence bookkeeping must never cost anybody their connection */
  }
}

function noteLastSeen(participantId: string): void {
  lastSeenPending.add(participantId)
  if (lastSeenTimer) return
  lastSeenTimer = setTimeout(() => {
    lastSeenTimer = null
    flushLastSeen()
  }, LAST_SEEN_EVERY_MS)
  lastSeenTimer.unref?.()
}

function reject(socket: Duplex): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  socket.destroy()
}

/**
 * Забаненному — отказ до апгрейда, теми же словами, что и на входе.
 *
 * С телом, хотя браузер его и не покажет: WebSocket не отдаёт странице ни
 * кода, ни ответа — только «не открылось». Читать эти строки будет тот, кто
 * полезет разбираться (вкладка «Сеть», curl, журнал прокси), и «403 и почему»
 * там стоит ровно столько, сколько стоит вечер догадок.
 */
function refuseBanned(socket: Duplex, ban: BanInForce): void {
  const body = Buffer.from(JSON.stringify(banRefusal(ban)), 'utf8')
  socket.write(
    'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n' +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${body.length}\r\n\r\n`,
  )
  socket.write(body)
  socket.destroy()
}

/**
 * Роль этого соединения — решается сейчас, а не читается из токена.
 *
 * Роль, зашитая в токен при входе, — это роль, которую нельзя отобрать:
 * преподаватель, убранный из списка, сохранял Restart во всех комнатах,
 * которые когда-либо открывал. Сокет перепроверяется на каждом переподключении,
 * так что выход из панели снимает права за секунды. Считает `roleFor` —
 * та же самая, что и на HTTP-стороне, чтобы двум входам было негде разойтись.
 */
function effectiveRole(
  req: { headers: { cookie?: string } },
  payload: TokenPayload,
): TokenPayload['role'] {
  return roleFor(req.headers.cookie, payload)
}

/** Имя комнаты файла обратно в путь. Кривая строка — это просто не путь. */
function decodeRoom(room: string): string {
  try {
    return Buffer.from(room, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

server.on('upgrade', (req, socket, head) => {
  // Until handleUpgrade adopts it this socket has no error handler, and a client
  // that vanishes mid-handshake would otherwise throw out of the event loop.
  socket.on('error', () => socket.destroy())

  let url: URL
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    return reject(socket)
  }

  const asFile = FILE_PATH.exec(url.pathname)
  const match = asFile ?? UPGRADE_PATH.exec(url.pathname)
  if (!match) return reject(socket)
  const channel = asFile ? 'file' : match[1]
  const sessionId = asFile ? asFile[1] : match[2]

  // The token is the whole authorization story: it names the session it was
  // minted for, so a valid token for seminar A cannot open seminar B.
  const payload: TokenPayload | null = verifyToken(url.searchParams.get('token'))
  if (!payload || payload.sessionId !== sessionId) return reject(socket)
  // A token outlives the room it names. Without this check a browser left open
  // on a deleted seminar reconnects, gets a freshly seeded document and writes
  // a snapshot row for a seminar the owner already destroyed.
  if (!getSession(sessionId) || kernelRetirementInProgress(sessionId)) return reject(socket)
  /*
   * Бан закрывает все три двери сразу — тетрадь, пульт и файл.
   *
   * Здесь, до апгрейда: сокет, открытый забаненному «просто чтобы посмотреть»,
   * — это его курсор в чужой тетради и его строки в общем терминале, то есть
   * ровно то, ради чего банили. Проверка та же, что и на входе (bans.ts ·
   * banFor), поэтому разойтись двум ответам негде.
   */
  const ban = banFor(sessionId, payload.participantId, req.headers.cookie)
  if (ban) return refuseBanned(socket, ban)

  wss.handleUpgrade(req, socket, head, (ws) => {
    /*
     * Всё тело — под try, и это не перестраховка.
     *
     * ws зовёт этот колбэк без своего перехвата, так что синхронное исключение
     * отсюда уходит в `uncaughtException`, а тот завершает процесс: одна кривая
     * печенька в заголовке одного участника (её разбирает effectiveRole)
     * закрывала весь инстанс — все комнаты, все терминалы, все ядра. Цена
     * ошибки здесь обязана быть равна одному сокету: браузер переподключится
     * через секунду и придёт сюда снова.
     */
    try {
      noteLastSeen(payload.participantId)
      if (channel === 'collab')
        handleCollabSocket(ws, sessionId, effectiveRole(req, payload), payload.participantId)
      else if (channel === 'file') {
        /*
         * Путь приезжает вторым отрезком адреса, в base64url. Проверяет его тот
         * же `normalizePath`, что и всё остальное в продукте, — и до него сюда не
         * доходит ничего, кроме уже проверенного токена этой самой комнаты.
         */
        const wanted = normalizePath(decodeRoom(asFile?.[2] ?? ''))
        if (!wanted) {
          try {
            ws.close(4404, tr("server.fileNotFound.f1ab8a"))
          } catch {
            /* уже закрыт */
          }
          return
        }
        handleFileSocket(ws, sessionId, wanted, effectiveRole(req, payload), payload.participantId)
      } else {
        /*
         * A participant token carries the role it was minted with. A teacher who
         * joined before signing in — or who created the seminar in the admin
         * panel, which never handed out a host token at all — holds a
         * 'participant' token for a room that is theirs, and interrupt and
         * restart were dead for the whole seminar as a result. Staff on this
         * instance are exactly who those controls are for; the cookie is a
         * stronger credential than the token and it is re-checked here on every
         * reconnect rather than baked into anything.
         */
        handleControlSocket(ws, sessionId, { ...payload, role: effectiveRole(req, payload) })
      }
    } catch (err) {
      console.error(
        `[ws] ${channel} ${sessionId}: соединение не открылось —`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      )
      try {
        ws.close(1011, 'соединение не открылось')
      } catch {
        ws.terminate()
      }
    }
  })
})

/* --------------------------------------------------------------- lifecycle */

/*
 * Кого слушаем. Умолчание прежнее — все интерфейсы: под `make up` порт
 * публикует compose, и до сервера в контейнере иначе не достучаться.
 *
 * На выделенной машине это не нужно и вредно: наружу Colloq выходит исходящим
 * туннелем, а открытый порт на публичном адресе — это вторая, никем не
 * названная дверь в ту же комнату. Служба systemd ставит здесь 127.0.0.1.
 */
const bindAddr = (process.env.BIND_ADDR ?? '').trim()

server.listen(config.port, ...(bindAddr ? ([bindAddr] as const) : ([] as const)), () => {
  const ai = aiEnabled() ? `on (${config.ai.model})` : 'off'
  console.log(`colloq ready — open ${config.publicUrl} · ai ${ai} · jupyter ${config.jupyter.url}`)
  announceSetupToken()
  announceBind()
  announceJupyterToken()
  /*
   * Хвосты от падения — на запуске, а не «когда-нибудь при следующей загрузке».
   *
   * Недописанный файл переживает ровно то падение, после которого мы и
   * стартуем; в комнате, где ничего не загружают, убрать его было больше
   * некому (см. sweepAllStaleUploads).
   */
  sweepAllStaleUploads()
  /*
   * Перепись собирается здесь, а не внутри `log.ts`: тот модуль грузится первым
   * в процессе — раньше collab и kernel, — и импорт их оттуда переставил бы
   * правку console за всё, что модули печатают при загрузке.
   */
  startJournal(() => ({ ...roomCensus(), kernels: kernelCensus() }))
})

/**
 * Кому открыта дверь — вслух, потому что .env на машине переживает семестры.
 *
 * Про BIND_ADDR теперь сказано и в таблице настроек README, и в .env.example, и
 * compose ограничивает ею публикацию порта на хосте. Но документацию читают
 * один раз, при установке, а .env живёт на машине годами и переезжает
 * копированием с прошлого ноутбука: строки, которой в нём не оказалось, из
 * README уже не видно. Поэтому открытую дверь называет вслух сам процесс — в
 * журнале, у того, кто запускает, а не у того, кто читает документацию: иначе
 * преподаватель, запустивший `make run` в аудитории, раздаёт комнату ещё и по
 * http://<ip-ноутбука>:3000 — мимо ссылки, мимо туннеля и без своего ведома.
 * Ту же дверь на 8888 docker-compose.dev.yml закрывает публикацией на петлю —
 * там её и закрыли после того, как она открылась в аудитории.
 *
 * Печатается один раз на запуск и только когда дверь правда открыта: строка,
 * которая появляется всегда, перестаёт читаться на второй неделе.
 */
function announceBind(): void {
  if (bindAddr) return
  console.log(
    `[net] BIND_ADDR не задан: порт ${config.port} открыт на всех интерфейсах этой машины — ` +
      `в аудиторной сети комната отвечает и по http://<ip-этой-машины>:${config.port}, ` +
      'мимо ссылки. На ноутбуке и на выделенной машине поставьте BIND_ADDR=127.0.0.1 ' +
      '(наружу Colloq выходит туннелем, см. make host); под make up так и нужно — ' +
      'до сервера в контейнере иначе не достучаться, а публикацию порта решает compose.',
  )
}

/**
 * Пароль к ядру — из публичного файла: сказать вслух, пока не заменили.
 *
 * `make up` при создании .env выписывает случайный токен, и в норме этой строки
 * никто не увидит. Она про два обычных случая: `cp .env.example .env` руками и
 * .env, лежащий с прошлого семестра. В обоих в контейнер с файлами ВСЕХ
 * семинаров ведёт пароль, напечатанный в публичном репозитории.
 *
 * Не отказ и не остановка: на ноутбуке за NAT это ровно тот случай, ради
 * которого умолчание и заведено, а сорвать пару предупреждением о конфигурации
 * было бы хуже самой дыры. Изоляция комнат по контейнерам и своя сеть у общего
 * ядра (docker-compose.yml) — первый замок; этот токен — второй, и он должен
 * быть настоящим.
 */
function announceJupyterToken(): void {
  if (config.jupyter.token !== DEV_JUPYTER_TOKEN) return
  console.warn(
    `[kernel] JUPYTER_TOKEN — общеизвестное значение из .env.example (${DEV_JUPYTER_TOKEN}); ` +
      'замените его или пересоздайте .env через make up',
  )
}

/**
 * The entire onboarding story, printed by the only thing that can see it.
 *
 * An unclaimed instance has exactly one way in, and the panel deliberately
 * never shows the token back — so if this line is not readable and actionable
 * on its own, nobody gets in without reading documentation. It prints on every
 * boot while the instance is unclaimed, not only the boot that minted the file:
 * the operator who scrolled past it yesterday needs it again today, and it
 * stops the moment someone claims the instance.
 */
function announceSetupToken(): void {
  if (isClaimed()) return
  console.log(
    [
      '',
      '  ┌ nobody owns this Colloq yet',
      `  │ open  ${config.publicUrl}/admin/t/${readSetupToken()}`,
      '  │ then type your name and email — that makes you the owner, and everyone',
      '  │ else teaching here gets a personal sign-in link from you.',
      '  │',
      // The link carries the token, so it is not a URL to paste into a chat.
      // Saying so next to it is cheaper than explaining it afterwards.
      '  │ That link IS the key to this instance. Do not share it, and do not',
      '  │ leave it on screen while the room is watching.',
      `  └ the token alone is in ${setupTokenPath} (0600). Keep it: it is also the`,
      '    way back in if an owner ever loses their link.',
      '',
    ].join('\n'),
  )
}

let stopping = false

async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`\ncolloq shutting down (${signal})`)
  // Сводка за оборванную минуту ничего не значит, а строка про ноль комнат
  // между строк выключения — просто шум.
  stopJournal()

  const force = setTimeout(() => {
    console.warn('colloq: shutdown timed out, exiting anyway')
    process.exit(1)
  }, SHUTDOWN_GRACE_MS)

  server.close()
  for (const client of wss.clients) {
    try {
      client.close(1001, tr("server.serverShuttingDown.0df697"))
    } catch {
      client.terminate()
    }
  }

  // Отметки «был здесь», не успевшие уехать пачкой: их немного, они дешёвые, а
  // без этой строки перезапуск посреди пары теряет последние пять секунд входов.
  flushLastSeen()

  // Snapshots first: an unsaved notebook is the only thing here that cannot be
  // rebuilt. Kernels are disposable, and shutting them down may involve HTTP.
  try {
    shutdownCollab()
  } catch (err) {
    console.error('colloq: could not flush notebooks:', err instanceof Error ? err.message : err)
  }
  try {
    await shutdownKernels()
    if (stopsLocalKernelsOnExit()) await retireDatabaseKernels(db, dropLocalRoomKernel)
  } catch (err) {
    console.error('colloq: could not stop kernels:', err instanceof Error ? err.message : err)
  }
  /*
   * Последним: база закрывается по-настоящему.
   *
   * Раньше процесс просто уходил через process.exit, и журнал WAL оставался
   * лежать рядом: `colloq.db` остановленного инстанса был вчерашним, а весь
   * день — в файле, который никто не копирует. db.close() сводит журнал и
   * закрывает файл, то есть делает ровно то, чего ждут от «остановлено».
   */
  try {
    closeDatabase()
  } catch (err) {
    console.error('colloq: could not close the database:', err instanceof Error ? err.message : err)
  }

  clearTimeout(force)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// A stray rejection from a kernel or model call must not end the class.
process.on('unhandledRejection', (err: unknown) => {
  console.error(
    'colloq: unhandled rejection:',
    err instanceof Error ? (err.stack ?? err.message) : err,
  )
})

/*
 * Необработанное исключение — не то же, что отвергнутое обещание.
 *
 * Обещание можно проглотить: где-то не дождались ответа, семинар от этого не
 * ломается. Исключение, дошедшее сюда, оставляет процесс в состоянии, о
 * котором никто ничего не знает, — а по умолчанию node в этом случае просто
 * умирает молча, без единой строки о причине. Пишем причину и уходим с
 * ненулевым кодом: перезапуск честнее, чем сервер, про который неизвестно,
 * работает ли он.
 */
process.on('uncaughtException', (err: unknown) => {
  console.error(
    'colloq: uncaught exception:',
    err instanceof Error ? (err.stack ?? err.message) : err,
  )
  try {
    shutdownCollab()
  } catch {
    // Снимки — последнее, что можно попробовать спасти, и не повод не выйти.
  }
  process.exit(1)
})

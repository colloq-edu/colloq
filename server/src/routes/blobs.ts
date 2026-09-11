import { tr } from '@shared/i18n'
/**
 * Картинки вывода — отдельным запросом, а не внутри документа комнаты.
 *
 * Почему они лежат снаружи, сказано в `server/src/blobs.ts`. Здесь про то, как
 * их забирают.
 *
 * КЛЮЧ. Адрес попадает в `src` элемента `<img>`, а туда нельзя положить
 * заголовок — значит, удостоверение едет строкой запроса, и это ровно тот
 * случай, для которого заведён `signDownloadToken` (см. routes/files.ts):
 * короткоживущий ключ на одно дело вместо токена участника, которым
 * открывается управляющий сокет. Ключ здесь один на комнату, а не на картинку:
 * вывод одной ячейки — это десяток записей, и просить ключ на каждую значило
 * бы десяток лишних запросов на каждый график. Ничего сверх того, что человек
 * и так видит в тетради, этот ключ не открывает: он годится ровно для
 * `/api/sessions/:id/blobs/*` той комнаты, в которую человек вошёл.
 *
 * КЭШ. Имя записи — хэш её содержимого, поэтому ответ раздаётся `immutable` на
 * год: по этому адресу не может появиться другая картинка. `private` — потому
 * что доступ к ней всё-таки по ключу, и общему кэшу перед сервером хранить её
 * не полагается.
 */
import { Router } from 'express'
import { SESSION_MISSING } from '@shared/protocol'
import { signDownloadToken, verifyDownloadToken } from '../auth.js'
import { blobBytes, readBlob, sniffMime } from '../blobs.js'
import { getSession } from '../db.js'
import { banDoor, sessionAuth } from './sessions.js'

/**
 * Чем подписан ключ на картинки комнаты.
 *
 * `signDownloadToken` подписывает пару «семинар + имя», и имя здесь — не файл,
 * а вся полка выводов. Столкнуться с настоящим файлом оно не может: путь файла
 * нормализован (`normalizePath`), а двоеточия в начале там не бывает; и даже
 * если бы совпало, обе двери открывает одно и то же — участие в комнате.
 */
const BLOB_SUBJECT = ':blobs'

export function blobRoutes(): Router {
  const router = Router()

  // Закрытый доступ закрыт и здесь: выведенный из комнаты не забирает из неё
  // картинки по старому ключу (routes/sessions.ts · banDoor).
  router.use('/api/sessions/:id/blobs', banDoor)

  /**
   * Ключ на картинки этой комнаты — за обычным удостоверением участника.
   *
   * Пять минут (`DOWNLOAD_TTL_MS`), и этого хватает: ключ берут перед тем, как
   * нарисовать первую картинку, а нарисованная картинка живёт в кэше браузера
   * по своему адресу и второй раз не запрашивается.
   */
  router.get('/api/sessions/:id/blobs/ticket', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    if (!sessionAuth(req)) {
      return res.status(401).json({ error: tr('server.joinTheSessionFirst.442dd6') })
    }
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ token: signDownloadToken(sessionId, BLOB_SUBJECT) })
  })

  router.get('/api/sessions/:id/blobs/:sha', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const ticket = typeof req.query.token === 'string' ? req.query.token : ''
    const allowed = sessionAuth(req) !== null || verifyDownloadToken(sessionId, BLOB_SUBJECT, ticket)
    if (!allowed) return res.status(401).json({ error: tr('server.joinTheSessionFirst.442dd6') })

    const sha = req.params.sha
    /*
     * ETag — до чтения файла: имя записи и есть её содержимое, так что на
     * повторный заход отвечать можно, не трогая диск вовсе. Это не
     * оптимизация ради оптимизации: картинка на семинаре одна на всех, и
     * пятьсот вкладок, вернувшихся после сна, приходят за ней в одну секунду.
     */
    const etag = `"${sha}"`
    const bytes = blobBytes(sessionId, sha)
    if (bytes === null) return res.status(404).json({ error: tr('server.fileNotFound.3e2256') })
    res.setHeader('ETag', etag)
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    if (req.headers['if-none-match'] === etag) return res.status(304).end()

    const body = readBlob(sessionId, sha)
    if (!body) return res.status(404).json({ error: tr('server.fileNotFound.3e2256') })
    /*
     * Тип — по самим байтам (`sniffMime`), а не по тому, что попросили: набор
     * `display_data` собирает библиотека в коде студента, и «а покажите эти
     * байты как text/html» было бы чужим документом на origin инстанса.
     */
    res.setHeader('Content-Type', sniffMime(body))
    res.setHeader('Content-Length', String(body.length))
    // Картинка показывается, а не открывается отдельной страницей.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(body)
  })

  return router
}

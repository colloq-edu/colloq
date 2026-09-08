/**
 * Три двери бана: завести, перечислить, снять.
 *
 * Всё, на что бан опирается, — метки, срок, совпадение, отказ забаненному —
 * живёт в server/src/bans.ts, рядом с проверкой входа. Здесь только то, что
 * делает нажатие кнопки: право, отказ словами и три последствия, которых у
 * проверки входа нет.
 *
 * Последствия и есть причина, по которой бан — не одна строка в таблице.
 * Забанили того, кто сидит в комнате прямо сейчас: его вопросы висят в общей
 * ленте (обычно именно за них и банят), модель ему что-то дописывает, а сокеты
 * у него открыты и о бане ничего не знают. Дверь закрывают все три двери сразу.
 */
import { Router } from 'express'
import { addressOf, banParticipant, deviceOf, liftBan, listBans } from '../bans.js'
import { evictBanned, purgeCouncilOf } from '../control.js'
import { getParticipant, getSession } from '../db.js'
import { purgeQuestions } from './ai.js'
import { banDoor, sessionAuth } from './sessions.js'
import { SESSION_MISSING } from '@shared/protocol'

/** Столько же, сколько у прочих идентификаторов на этих проводах. */
const MAX_ID = 128

export function banRoutes(): Router {
  const router = Router()

  // И на своих дверях тоже: список банов — это комната, а право у неё одно
  // (routes/sessions.ts · banDoor).
  router.use('/api/sessions/:id', banDoor)

  /*
   * Право во всех трёх дверях одно и спрашивается там же, где его спрашивают
   * соседние маршруты: `sessionAuth` пересчитывает роль на каждом запросе по
   * куке штата, а не берёт её из токена. Иначе снятый из штата преподаватель
   * банил бы в каждой комнате, которую когда-либо открывал.
   *
   * И комната обязана существовать раньше всего остального: вычистка ленты
   * поднимает документ, а поднимать документ снесённого семинара — воскрешать
   * его по токену, которого в списке уже нет.
   */

  router.get('/api/sessions/:id/bans', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: 'join the session first' })
    if (auth.role !== 'host') {
      return res.status(403).json({ error: 'Список закрытых доступов видит преподаватель.' })
    }
    res.json({ bans: listBans(sessionId, deviceOf(req.headers.cookie)) })
  })

  router.post('/api/sessions/:id/bans', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: 'join the session first' })
    if (auth.role !== 'host') {
      return res.status(403).json({ error: 'Закрыть доступ в этот семинар может преподаватель.' })
    }

    const body = req.body as { participantId?: unknown } | undefined
    const participantId =
      typeof body?.participantId === 'string' && body.participantId.length <= MAX_ID
        ? body.participantId
        : ''
    if (!participantId) return res.status(400).json({ error: 'participantId is required' })
    /*
     * «Такого человека тут нет» и «это преподаватель» — разные ответы, а
     * `banParticipant` на оба отвечает `null`: инвариант «штат не банится»
     * живёт там, рядом с самой проверкой. Различает их эта строка, и только
     * ради слов отказа.
     */
    if (!getParticipant(sessionId, participantId)) {
      return res.status(404).json({ error: 'participant not found' })
    }

    const ban = banParticipant({
      sessionId,
      participantId,
      // Подсказка «кажется, вернулся» — и ничего кроме: в проверке адрес не
      // участвует, за одним NAT сидит вся аудитория.
      ip: addressOf(req),
      // Имя, а не идентификатор штата: строку читает второй преподаватель той
      // же комнаты, и ему нужно знать, кто закрыл, а не чей это ключ.
      byTeacher: getParticipant(sessionId, auth.participantId)?.name ?? null,
      viewerDevice: deviceOf(req.headers.cookie),
    })
    if (!ban) return res.status(403).json({ error: 'Нельзя закрыть доступ преподавателю.' })

    /*
     * Порядок здесь значимый.
     *
     * Сначала строка в базе: за вычисткой стоит запись в историю и правка
     * общего документа, и упади она посередине — человек остался бы
     * незакрытым при уже стёртых вопросах. Выселение последним: пока сокеты
     * открыты, ленту можно прибрать из-под него молча, а после кадра он уже
     * ничего не увидит.
     */
    purgeQuestions(sessionId, { participantId, name: ban.name }, auth.participantId)
    // И его попытки в консилиуме — тот же текст перед глазами преподавателя,
    // только не в ленте, а в стопке. Стопки без него уезжают хосту отсюда же.
    purgeCouncilOf(sessionId, participantId)
    evictBanned(sessionId, participantId, ban.until)

    res.status(201).json({ ban })
  })

  router.delete('/api/sessions/:id/bans/:banId', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: 'join the session first' })
    if (auth.role !== 'host') {
      return res.status(403).json({ error: 'Восстановить доступ может только преподаватель.' })
    }
    /*
     * Снятие возвращает человека, а не его вопросы: стёртое из ленты
     * возвращают версией, названной «до бана <имя>». Обещать здесь большее
     * значило бы соврать преподавателю ровно в ту минуту, когда он понял, что
     * промахнулся человеком.
     */
    if (!liftBan(sessionId, req.params.banId)) {
      return res.status(404).json({ error: 'no such ban' })
    }
    res.json({ ok: true })
  })

  return router
}

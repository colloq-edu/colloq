import { Router } from 'express'
import { tr } from '@shared/i18n'
import { ACTIVITY_CATEGORIES, ACTIVITY_LEVELS, type ActivityCategory, type ActivityLevel } from '@shared/activity'
import { SESSION_MISSING } from '@shared/protocol'
import { activitySummary, listActivity } from '../activity.js'
import { getSession } from '../db.js'
import { banDoor, sessionAuth } from './sessions.js'

/** Attendance and student usage belong to the teacher, independent of notebook history rules. */
export function activityRoutes(): Router {
  const router = Router()
  router.use('/api/sessions/:id/activity', (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store')
    next()
  })
  router.get('/api/sessions/:id/activity/summary', banDoor, (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: SESSION_MISSING })
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr('server.joinTheSessionFirst.442dd6') })
    if (auth.role !== 'host') return res.status(403).json({ error: tr('server.onlyTheTeacherCanViewThisSeminar.4c05e0') })
    res.json(activitySummary(req.params.id))
  })
  router.get('/api/sessions/:id/activity', banDoor, (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: SESSION_MISSING })
    const auth = sessionAuth(req)
    if (!auth) return res.status(401).json({ error: tr('server.joinTheSessionFirst.442dd6') })
    if (auth.role !== 'host') return res.status(403).json({ error: tr('server.onlyTheTeacherCanViewThisSeminar.4c05e0') })
    const level = req.query.level ?? 'normal'
    const category = req.query.category ?? 'all'
    const before = req.query.before === undefined ? undefined : Number(req.query.before)
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit)
    if (!ACTIVITY_LEVELS.includes(level as ActivityLevel) || !ACTIVITY_CATEGORIES.includes(category as ActivityCategory)
      || (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: 'Invalid activity filter or page.' })
    }
    res.json(listActivity(req.params.id, { level: level as ActivityLevel, category: category as ActivityCategory, before, limit }))
  })
  return router
}

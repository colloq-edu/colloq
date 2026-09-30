/**
 * The staff audit log, for reading (admin/audit-log.ts writes it).
 *
 * Owner-only. The log is the record of what every teacher did — their
 * sign-ins, from which address, what they deleted — and reading it is the
 * owner's job of answering for the instance, not a colleague's curiosity about
 * another's week. A teacher gets the same 403 with the same wording as every
 * other owner-only door.
 */
import { Router } from 'express'
import { ownerOnly } from '../admin/auth.js'
import { listAdminEvents } from '../admin/audit-log.js'

export function adminAuditRoutes(): Router {
  const router = Router()

  /**
   * `?before=<id>&limit=<n>`: newest first, and `next` in the answer is the
   * `before` of the following page. Anything else in the query is ignored
   * rather than refused — a page cursor is not worth a 400.
   */
  router.get('/api/admin/audit-log', ownerOnly('server.ownerAction.auditLog'), (req, res) => {
    const before = Number(req.query.before)
    const limit = Number(req.query.limit)
    res.set('Cache-Control', 'no-store').json(
      listAdminEvents({
        before: Number.isInteger(before) && before > 0 ? before : null,
        limit: Number.isInteger(limit) ? limit : undefined,
      }),
    )
  })

  return router
}

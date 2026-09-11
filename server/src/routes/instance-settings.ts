import { Router } from 'express'
import { ownerOnly, requireStaff } from '../admin/auth.js'
import { getInstanceLanguage, setInstanceLanguage } from '../admin/settings.js'
import { isLocale, tr } from '@shared/i18n'
export function instanceSettingsRoutes(): Router {
  const router = Router()
  router.get('/api/instance', (_req, res) => {
    // `no-cache`, а не `no-store`: ответ обязан перепроверяться каждый раз, но
    // храниться он может — тогда опрос языка становится 304 без тела, а не
    // полным 200. Свежесть та же: без перепроверки браузер его не отдаёт.
    res.set('Cache-Control', 'no-cache').json({ language: getInstanceLanguage() })
  })
  router.get('/api/admin/instance/settings', requireStaff, (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ language: getInstanceLanguage() })
  })
  router.patch(
    '/api/admin/instance/settings',
    ownerOnly('server.ownerAction.instanceLanguage'),
    (req, res) => {
      const body: unknown = req.body
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !('language' in body) ||
        !isLocale(body.language)
      ) {
        res.status(400).json({ error: tr('common.invalidLanguage'), reason: 'invalid' })
        return
      }
      setInstanceLanguage(body.language)
      res.json({ language: getInstanceLanguage() })
    },
  )
  return router
}

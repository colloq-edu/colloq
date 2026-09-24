import { Router } from 'express'
import { FRAME_HTML, frameOrigin, framePolicy } from '../plotly-frame.js'
import { PLOTLY_FRAME_PATH, PLOTLY_ORIGIN_PARAM } from '@shared/plotly'

/**
 * The chart frame: the only server response with a policy of its own.
 *
 * Why the frame exists at all and what each directive does is written in
 * `server/src/plotly-frame.ts`. Here are two decisions about the route itself.
 *
 * NO CREDENTIAL. The page is empty: there is no class data in it at all, and
 * it can show only what is sent to it by `postMessage`, that is, only what
 * the person already sees in their notebook. Asking a token for it would mean
 * introducing a credential where there is nothing to guard, and breaking it
 * on a published page, where there is no login at all.
 *
 * THE POLICY IS BUILT PER REQUEST, because it contains the origin, and the
 * same instance has different origins: `localhost:5173` in development, the
 * relay's address during a class, `127.0.0.1:3000` when run directly. The
 * server does not know it (anything may stand in front of it), the page
 * does, and sends it as a parameter. A forgery opens nothing: the script's
 * address in the markup is fixed and ours, and a foreign origin in the policy
 * only blocks the bundle.
 */
export function plotlyRoutes(): Router {
  const router = Router()

  router.get(PLOTLY_FRAME_PATH, (req, res) => {
    const origin = frameOrigin(req.query[PLOTLY_ORIGIN_PARAM])
    if (!origin) return res.status(400).type('text/plain').send('bad origin')
    // Our own policy instead of the common one: `setHeader` replaces the one
    // set by the header middleware, which has `frame-ancestors 'none'`, and
    // with it the notebook could not embed its own frame.
    res.setHeader('Content-Security-Policy', framePolicy(origin))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    /*
     * Ten minutes, and there is still one request per frame: a notebook with
     * ten charts opens ten `<iframe>`s with ONE address, and the browser takes
     * it from memory. No longer than that: the policy contains the origin, and
     * yesterday's response would outlive the instance moving to another
     * address.
     */
    res.setHeader('Cache-Control', 'private, max-age=600')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    res.type('html').send(FRAME_HTML)
  })

  return router
}

import { Router } from 'express'
import { FRAME_HTML, frameOrigin, framePolicy } from '../plotly-frame.js'
import { PLOTLY_FRAME_PATH, PLOTLY_ORIGIN_PARAM } from '@shared/plotly'

/**
 * Рамка графика — единственный ответ сервера со своей политикой.
 *
 * Почему рамка вообще есть и что делает каждая директива, написано в
 * `server/src/plotly-frame.ts`. Здесь — два решения про сам маршрут.
 *
 * БЕЗ УДОСТОВЕРЕНИЯ. Страница пустая: ни одной цифры занятия в ней нет, и
 * показать она может только то, что ей пришлют `postMessage` — то есть только
 * то, что человек и так видит в своей тетради. Просить за неё токен значило бы
 * завести удостоверение там, где нечего охранять, и сломать её на
 * опубликованной странице, где входа нет вовсе.
 *
 * ПОЛИТИКА СОБИРАЕТСЯ НА КАЖДЫЙ ЗАПРОС, потому что в ней есть origin, а origin
 * у одного и того же инстанса разный: `localhost:5173` в разработке, адрес
 * ретранслятора на занятии, `127.0.0.1:3000` при прямом запуске. Сервер его не
 * знает (за ним может стоять что угодно), страница знает — и присылает
 * параметром. Подделка этим ничего не открывает: адрес скрипта в разметке
 * постоянный и наш, чужой origin в политике только запретит бандл.
 */
export function plotlyRoutes(): Router {
  const router = Router()

  router.get(PLOTLY_FRAME_PATH, (req, res) => {
    const origin = frameOrigin(req.query[PLOTLY_ORIGIN_PARAM])
    if (!origin) return res.status(400).type('text/plain').send('bad origin')
    // Своя политика вместо общей: `setHeader` заменяет ту, что поставил
    // заголовочный middleware, — у неё `frame-ancestors 'none'`, и с ней
    // тетрадь не смогла бы встроить собственную рамку.
    res.setHeader('Content-Security-Policy', framePolicy(origin))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    /*
     * Десять минут, и запрос на каждую рамку всё равно один: тетрадь с
     * десятью графиками открывает десять `<iframe>` с ОДНИМ адресом, и
     * браузер берёт его из памяти. Дольше не надо — в политике origin, и
     * вчерашний ответ пережил бы переезд инстанса на другой адрес.
     */
    res.setHeader('Cache-Control', 'private, max-age=600')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    res.type('html').send(FRAME_HTML)
  })

  return router
}

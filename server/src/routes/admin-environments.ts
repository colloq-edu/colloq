/**
 * The Environments screen's routes.
 *
 * Staff-only, like everything else in the panel. Building and switching are
 * owner-only: a build occupies the machine the whole faculty is teaching on,
 * and switching decides what every seminar created from now on will run — and,
 * where rooms share one kernel, takes their variables away as well. Both are
 * actions on people who are not in the request, which is the line the rest of
 * this surface already draws.
 */
import { Router, type Request, type Response } from 'express'
import { ownerOnly, requireStaff } from '../admin/auth.js'
import {
  activate,
  activeName,
  buildLog,
  cancelBuild,
  dockerAvailable,
  exists,
  isBuilding,
  listEnvironments,
  readSource,
  removeEnvironment,
  startBuild,
  watchBuild,
  writeSource,
} from '../environments.js'
import { sessionsOnEnvironment } from '../db.js'
import { expectKernelChurn } from '../kernel/index.js'
import { gpuBusy, gpuDevices, isolationAvailable } from '../kernel/pool.js'
import {
  ENVIRONMENT_NAME,
  type AdminErrorBody,
  type AdminErrorReason,
  type EnvironmentsState,
  type SaveEnvironmentRequest,
} from '@shared/admin'

function fail(res: Response, status: number, reason: AdminErrorReason, message: string): void {
  const body: AdminErrorBody = { error: message, reason }
  res.status(status).json(body)
}

/** A requirements file is text somebody types; this is a sanity bound, not a rule. */
const MAX_SOURCE = 16 * 1024

/**
 * Сколько срезов видеокарты названо в KERNEL_GPUS и сколько из них свободно.
 *
 * Занят тот срез, который стоит меткой на контейнере комнаты, — остановленной
 * тоже: её поднимут обратно тем же устройством. Занятость, которой больше нет в
 * списке (оператор переписал KERNEL_GPUS), свободных не прибавляет и не
 * убавляет: считаем по настроенным.
 *
 * На машине без карт docker не спрашиваем вовсе — `docker ps -a` на каждое
 * открытие экрана ради заведомо пустого списка платить не за что.
 */
async function gpuState(): Promise<{ total: number; free: number }> {
  const devices = gpuDevices()
  if (devices.length === 0) return { total: 0, free: 0 }
  const busy = new Set(await gpuBusy())
  return { total: devices.length, free: devices.filter((device) => !busy.has(device)).length }
}

export function adminEnvironmentRoutes(): Router {
  const router = Router()

  router.get('/api/admin/environments', requireStaff, async (_req: Request, res: Response) => {
    const docker = await dockerAvailable()
    const body: EnvironmentsState = {
      // `gpu` у каждой строки — оттуда же, откуда packages: директива читается
      // тем же чтением файла, что и список пакетов, и тем же разбором, по
      // которому подъём ядра потом решает, просить ли срез.
      environments: await listEnvironments(),
      canBuild: docker.ok,
      cannotBuildReason: docker.reason,
      /*
       * Делят ли комнаты одно ядро — правда, которую знает только сервер.
       *
       * Экраны обещали контейнер на семинар безусловно («runs in its own
       * container», «The container mounts this room's folder»), а на установке
       * без сокета, без сети комнат или с KERNEL_ISOLATION=off это неправда
       * сразу в двух местах: комнаты видят файлы друг друга, и «Make default»
       * действительно забирает переменные у открытых семинаров. Признак едет
       * вместе со списком, потому что показывают его там же.
       */
      shared: !(await isolationAvailable()),
      /*
       * Срезы — рядом со списком по той же причине, что и `shared`: смотрят на
       * них там же. Без этого числа преподаватель заводит семинар на
       * GPU-окружении на машине, где карт нет вовсе, и узнаёт об этом отказом
       * ядра посреди пары.
       */
      gpus: await gpuState(),
    }
    res.json(body)
  })

  /** The file itself, for the editor. Kept separate: the list does not need it. */
  router.get('/api/admin/environments/:name', requireStaff, (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!ENVIRONMENT_NAME.test(name)) return fail(res, 400, 'invalid', 'that is not an environment name')
    if (!exists(name)) return fail(res, 404, 'not_found', 'no such environment')
    res.json({ name, source: readSource(name) })
  })

  router.put('/api/admin/environments/:name', requireStaff, (req: Request, res: Response) => {
    const name = String(req.params.name)
    const body = req.body as Partial<SaveEnvironmentRequest> | undefined
    if (!ENVIRONMENT_NAME.test(name)) {
      return fail(
        res,
        400,
        'invalid',
        'An environment name is lowercase letters, digits and dashes — it becomes a filename and a Docker tag.',
      )
    }
    const source = typeof body?.source === 'string' ? body.source : ''
    if (source.length > MAX_SOURCE) {
      return fail(res, 400, 'too_long', `A package list is at most ${MAX_SOURCE / 1024} KB.`)
    }
    /*
     * Создание и правка — разные намерения, хотя запрос один и тот же.
     *
     * Перезапись верна, когда открыли существующий список. Но форма «New
     * environment» шлёт тот же PUT, и на занятом имени она затирала чужой
     * список пакетов целиком: две вкладки, планшет рядом с ноутбуком, curl —
     * и от окружения не остаётся ни строки, а истории у этих файлов нет.
     * `If-None-Match: *` — это и есть «только если такого ещё нет»; тот же
     * барьер стоит на клиенте и в `make env-new`.
     */
    if (req.get('if-none-match')?.trim() === '*' && exists(name)) {
      return fail(
        res,
        409,
        'exists',
        `An environment called ${name} already exists. Open it to change its packages, or pick another name.`,
      )
    }
    try {
      writeSource(name, source)
    } catch (err) {
      /*
       * Каталог со списками — папка хоста, смонтированная внутрь. Когда её
       * владелец не совпадает с пользователем, от которого работает сервер,
       * запись падает EACCES — и раньше это уходило в общий обработчик голым
       * «internal error», по которому не понять ни что произошло, ни где.
       */
      return fail(
        res,
        500,
        'failed',
        `Could not write kernel/environments/${name}.txt: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    res.json({ name, source: readSource(name) })
  })

  router.delete('/api/admin/environments/:name', ownerOnly('delete an environment'), (req, res) => {
    const name = String(req.params.name)
    if (!ENVIRONMENT_NAME.test(name)) return fail(res, 400, 'invalid', 'that is not an environment name')
    if (name === activeName()) {
      return fail(
        res,
        409,
        'in_use',
        'That is the environment the room is running. Switch to another one first.',
      )
    }
    if (name === 'base') {
      return fail(res, 409, 'protected', 'base is what every environment is built on top of.')
    }
    /*
     * Комнаты, которые на нём стоят.
     *
     * Проверялось только «не то ли это окружение, на котором работает
     * инстанс». Семинар, которому окружение выбрали при создании, держит его
     * имя в своей строке — и после удаления просыпался в комнате, где ядро не
     * поднимается вовсе: имя есть, образа нет. Узнавали об этом на первом Run
     * посреди пары.
     *
     * Отказ, а не молчаливый перевод на общее окружение: у семинара по
     * компьютерному зрению и семинара на голом Python разные тетради, и решать
     * за преподавателя, что «сойдёт и так», нельзя.
     */
    const attached = sessionsOnEnvironment(name)
    if (attached.length > 0) {
      const names = attached.slice(0, 3).map((s) => s.name).join(', ')
      const more = attached.length > 3 ? `, and ${attached.length - 3} more` : ''
      /*
       * Инструкция должна быть выполнимой.
       *
       * Здесь стояло «Move them to another environment first», а перевести
       * семинар на другое окружение нельзя ничем: имя выбирается при создании и
       * дальше не меняется ни в панели, ни через PATCH. Архивные семинары
       * считаются наравне с живыми — они точно так же откроются и потребуют
       * свой образ, — поэтому сказано и про них: иначе прошлосеместровый
       * архивный семинар держит имя навсегда, а человек ищет несуществующую
       * кнопку.
       */
      return fail(
        res,
        409,
        'in_use',
        `${attached.length === 1 ? 'A seminar runs' : `${attached.length} seminars run`} on ${name} (${names}${more}). ` +
          'A seminar keeps the environment it was created with — archived ones included — so this name is ' +
          'free only once those seminars are deleted.',
      )
    }
    removeEnvironment(name)
    res.status(204).end()
  })

  router.post('/api/admin/environments/:name/build', ownerOnly('build an environment'), async (req, res) => {
    const name = String(req.params.name)
    if (!ENVIRONMENT_NAME.test(name) || !exists(name)) {
      return fail(res, 404, 'not_found', 'no such environment')
    }
    const docker = await dockerAvailable()
    if (!docker.ok) return fail(res, 409, 'no_docker', docker.reason ?? 'docker is unavailable')
    await startBuild(name)
    res.status(202).json({ name })
  })

  router.post('/api/admin/environments/:name/cancel', ownerOnly('cancel a build'), (req, res) => {
    const name = String(req.params.name)
    res.json({ cancelled: cancelBuild(name) })
  })

  router.post('/api/admin/environments/:name/use', ownerOnly('switch the environment'), async (req, res) => {
    const name = String(req.params.name)
    if (!ENVIRONMENT_NAME.test(name) || !exists(name)) {
      return fail(res, 404, 'not_found', 'no such environment')
    }
    if (isBuilding(name)) return fail(res, 409, 'building', 'That environment is still building.')
    const docker = await dockerAvailable()
    if (!docker.ok) return fail(res, 409, 'no_docker', docker.reason ?? 'docker is unavailable')
    /*
     * Ядро compose трогаем только когда комнаты в нём и живут.
     *
     * При изоляции у каждой комнаты свой контейнер из образа её окружения, и
     * «Make default» до них не дотягивается вовсе. Окно churn при этом стояло
     * всегда: любое настоящее падение ядра в ближайшие две минуты — OOM от
     * ячейки студента — объяснялось «кто-то переключил окружение», и
     * преподаватель шёл искать админа вместо своей ячейки.
     */
    const shared = !(await isolationAvailable())
    if (shared) {
      // Пересоздание контейнера снимет ядро у всех, кто сейчас считает, и без
      // этой строки каждая такая комната услышит «ядру не хватило памяти».
      expectKernelChurn(
        `Someone switched this instance to the ${name} environment, so the kernel was replaced.`,
      )
    }
    const result = await activate(name, shared)
    if (!result.ok) {
      return fail(res, 500, 'failed', `The kernel did not come back: ${result.out.slice(-400)}`)
    }
    res.json({ active: name })
  })

  /*
   * The build log, as it happens.
   *
   * Server-sent events rather than a websocket: this is one direction, it is
   * text, and the browser reconnects on its own. The backlog goes out first so
   * a panel opened halfway through a build is not left staring at an empty box.
   */
  router.get('/api/admin/environments/:name/log', requireStaff, (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!ENVIRONMENT_NAME.test(name)) return fail(res, 400, 'invalid', 'that is not an environment name')

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Nginx and friends buffer by default, which turns a live log into a
      // single burst at the end — the one thing this endpoint exists to avoid.
      'X-Accel-Buffering': 'no',
    })

    const send = (event: string, data: string) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const existing = buildLog(name)
    for (const line of existing?.lines ?? []) send('line', line)
    if (!existing || existing.done) {
      send('done', existing?.failed ? 'failed' : 'ok')
      return res.end()
    }

    const stop = watchBuild(name, (line) => send('line', line))
    // A proxy that sees nothing for a minute closes the connection; a comment
    // frame is the cheapest thing that keeps it open and is ignored by clients.
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000)
    const finish = setInterval(() => {
      const now = buildLog(name)
      if (now?.done) {
        send('done', now.failed ? 'failed' : 'ok')
        cleanup()
        res.end()
      }
    }, 500)
    const cleanup = () => {
      stop()
      clearInterval(beat)
      clearInterval(finish)
    }
    req.on('close', cleanup)
  })

  return router
}

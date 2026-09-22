import { tr } from '@shared/i18n'
import { readEnvironmentInventory } from '../environment-inventory.js'
import {
  usingRuntimeBroker,
  kernelRuntimeClient,
  loadRuntimeCatalog,
} from '../kernel/runtime-client.js'
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
  environmentAbilities,
  exists,
  isBuilding,
  isShipped,
  listEnvironments,
  readSource,
  removeEnvironment,
  startBuild,
  watchBuild,
  writeSource,
} from '../environments.js'
import { sessionsOnEnvironment } from '../db.js'
import { gpuBusy, gpuDevices } from '../kernel/pool.js'
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
  if (usingRuntimeBroker()) return { total: 0, free: 0 }
  const devices = gpuDevices()
  if (devices.length === 0) return { total: 0, free: 0 }
  const busy = new Set(await gpuBusy())
  return { total: devices.length, free: devices.filter((device) => !busy.has(device)).length }
}

/**
 * Откуда маршрут берёт сборку и ответ «что здесь можно». По умолчанию — из
 * environments.ts; подменяется в тестах, потому что настоящая сборка ходит в
 * docker, а проверять надо не её, а то, что ответ уходит раньше неё.
 */
export interface BuildDeps {
  startBuild: typeof startBuild
  environmentAbilities: typeof environmentAbilities
}

const liveBuilds: BuildDeps = { startBuild, environmentAbilities }

export function adminEnvironmentRoutes(deps: BuildDeps = liveBuilds): Router {
  const router = Router()

  router.get('/api/admin/environments', requireStaff, async (_req: Request, res: Response) => {
    const body: EnvironmentsState = {
      // `gpu` у каждой строки — оттуда же, откуда packages: директива читается
      // тем же чтением файла, что и список пакетов, и тем же разбором, по
      // которому подъём ядра потом решает, просить ли срез.
      environments: await listEnvironments(),
      /*
       * Собрать и назначить умолчанием — два разных «можно ли», и панель гасит
       * ровно ту кнопку, которой нельзя: в контейнере сборка работает (каталог
       * kernel примонтирован), а запись KERNEL_ENV — это .env хоста.
       */
      ...(await deps.environmentAbilities()),
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
      shared: false,
      managed: usingRuntimeBroker(),
      gpuCapacityKnown: !usingRuntimeBroker(),
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

  router.get('/api/admin/environments/:name/inventory', requireStaff, async (req, res) => {
    const name = String(req.params.name)
    if (!ENVIRONMENT_NAME.test(name) || !exists(name)) {
      return fail(res, 404, 'not_found', tr('server.noSuchEnvironment.7ca461'))
    }
    try {
      res.json(await readEnvironmentInventory(name))
    } catch {
      fail(res, 503, 'failed', tr('common.environmentUnavailable'))
    }
  })

  /** The file itself, for the editor. Kept separate: the list does not need it. */
  router.get('/api/admin/environments/:name', requireStaff, (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!ENVIRONMENT_NAME.test(name))
      return fail(res, 400, 'invalid', tr('server.thatIsNotAnEnvironmentName.db085f'))
    if (!exists(name)) return fail(res, 404, 'not_found', tr('server.noSuchEnvironment.7ca461'))
    res.json({ name, source: readSource(name) })
  })

  router.put('/api/admin/environments/:name', requireStaff, (req: Request, res: Response) => {
    if (usingRuntimeBroker())
      return fail(
        res,
        409,
        'managed_environment',
        tr('server.imagesAreManagedByTheReleaseCatalog.14206b'),
      )
    const name = String(req.params.name)
    const body = req.body as Partial<SaveEnvironmentRequest> | undefined
    if (!ENVIRONMENT_NAME.test(name)) {
      return fail(res, 400, 'invalid', tr('server.useLowercaseLettersDigitsAndDashesFor.4f31ec'))
    }
    const source = typeof body?.source === 'string' ? body.source : ''
    if (source.length > MAX_SOURCE) {
      return fail(
        res,
        400,
        'too_long',
        tr('server.aPackageListIsAtMostKb.90ace1', { p0: MAX_SOURCE / 1024 }),
      )
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
        tr('server.anEnvironmentCalledAlreadyExistsOpenIt.a64ba5', { p0: name }),
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
        tr('server.couldNotWriteKernelEnvironmentsTxt.bd3f19', {
          p0: name,
          p1: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    res.json({ name, source: readSource(name) })
  })

  router.delete('/api/admin/environments/:name', ownerOnly('server.ownerAction.3'), (req, res) => {
    if (usingRuntimeBroker())
      return fail(
        res,
        409,
        'managed_environment',
        tr('server.imagesAreManagedByTheReleaseCatalog.14206b'),
      )
    const name = String(req.params.name)
    if (!ENVIRONMENT_NAME.test(name))
      return fail(res, 400, 'invalid', tr('server.thatIsNotAnEnvironmentName.db085f'))
    if (name === activeName()) {
      return fail(res, 409, 'in_use', tr('server.thatIsTheEnvironmentTheRoomIs.c699b1'))
    }
    if (name === 'base') {
      return fail(res, 409, 'protected', tr('server.baseIsWhatEveryEnvironmentIsBuilt.1c36b7'))
    }
    /*
     * Привезённое с продуктом удалить нельзя, и сказать об этом надо здесь.
     *
     * Список такого окружения лежит в каталоге приложения — у установленного
     * colloq это site-packages: `rm` там либо падает правами (и человек видит
     * голое «internal error»), либо снимает файл, который вернётся следующим
     * `pip install -U`. Отказ называет, что делать вместо этого: правка ложится
     * своей копией рядом с настройками и переживает обновление.
     *
     * В репозитории каталог один, свой и привезённый совпадают, и эта ветка не
     * срабатывает никогда — удаление там работает ровно как работало.
     */
    if (isShipped(name)) {
      return fail(
        res,
        409,
        'protected',
        tr('server.shipsWithColloqAndCannotBeDeletedHere.06a8ea', { p0: name }),
      )
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
      const names = attached
        .slice(0, 3)
        .map((s) => s.name)
        .join(', ')
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
        `${attached.length === 1 ? 'One seminar uses' : `${attached.length} seminars use`} ${name} (${names}${more}). ` +
          tr('server.thisEnvironmentCannotBeDeletedWhileLinked.8047b8'),
      )
    }
    removeEnvironment(name)
    res.status(204).end()
  })

  router.post(
    '/api/admin/environments/:name/build',
    ownerOnly('server.ownerAction.4'),
    async (req, res) => {
      const name = String(req.params.name)
      if (!ENVIRONMENT_NAME.test(name) || !exists(name)) {
        return fail(res, 404, 'not_found', tr('server.noSuchEnvironment.7ca461'))
      }
      const can = await deps.environmentAbilities()
      if (!can.canBuild) {
        return fail(
          res,
          409,
          'no_docker',
          can.cannotBuildReason ?? tr('server.dockerIsUnavailable.6292c5'),
        )
      }
      /*
       * 202 — это «принято», и уходить оно обязано сейчас.
       *
       * Здесь стояло `await startBuild(name)`, а сборка — это минуты docker
       * build: запрос висел всё это время, и «Accepted» приезжало ровно тогда,
       * когда принимать было уже нечего. Вкладка, нажавшая Build, всё это время
       * держала строку занятой — то есть не открывала живой журнал, ради
       * которого сделан /log, и не давала нажать Cancel на своей же сборке; а
       * ретранслятор, обрывающий десятиминутный запрос, показывал владельцу
       * ошибку при прекрасно идущей сборке.
       *
       * Слот в `builds` занимается синхронно, до первого await (environments.ts ·
       * startBuild), так что /log и Cancel находят сборку сразу после ответа.
       * Провал сборки и так лежит в её журнале — сюда он приехать не может,
       * незачем и ждать его.
       */
      void deps.startBuild(name).catch((err: unknown) => {
        console.error(
          `[environments] build ${name} failed:`,
          err instanceof Error ? err.message : err,
        )
      })
      res.status(202).json({ name })
    },
  )

  router.post('/api/admin/environments/:name/cancel', ownerOnly('cancel a build'), (req, res) => {
    const name = String(req.params.name)
    res.json({ cancelled: cancelBuild(name) })
  })

  router.post(
    '/api/admin/environments/:name/use',
    ownerOnly('server.ownerAction.5'),
    async (req, res) => {
      const name = String(req.params.name)
      if (!ENVIRONMENT_NAME.test(name) || !exists(name)) {
        return fail(res, 404, 'not_found', tr('server.noSuchEnvironment.7ca461'))
      }
      if (isBuilding(name))
        return fail(res, 409, 'building', tr('server.thatEnvironmentIsStillBuilding.d8f6a6'))
      // Не «виден ли docker»: умолчание — это строка в .env рядом с
      // docker-compose.yml, и в контейнере писать её некуда.
      const can = await deps.environmentAbilities()
      if (!can.canSetDefault) {
        return fail(
          res,
          409,
          'no_docker',
          can.cannotSetDefaultReason ?? tr('server.dockerIsUnavailable.6292c5'),
        )
      }
      /*
       * Ядро compose трогаем только когда комнаты в нём и живут.
       *
       * При изоляции у каждой комнаты свой контейнер из образа её окружения, и
       * «Make default» до них не дотягивается вовсе. Окно churn при этом стояло
       * всегда: любое настоящее падение ядра в ближайшие две минуты — OOM от
       * ячейки студента — объяснялось «кто-то переключил окружение», и
       * преподаватель шёл искать админа вместо своей ячейки.
       */
      const result = await activate(name, false)
      if (!result.ok) {
        return fail(
          res,
          500,
          'failed',
          tr('server.theKernelDidNotComeBack.ffdde9', { p0: result.out.slice(-400) }),
        )
      }
      res.json({ active: name })
    },
  )

  /*
   * The build log, as it happens.
   *
   * Server-sent events rather than a websocket: this is one direction, it is
   * text, and the browser reconnects on its own. The backlog goes out first so
   * a panel opened halfway through a build is not left staring at an empty box.
   */
  router.get('/api/admin/environments/:name/log', requireStaff, (req: Request, res: Response) => {
    const name = String(req.params.name)
    if (!ENVIRONMENT_NAME.test(name))
      return fail(res, 400, 'invalid', tr('server.thatIsNotAnEnvironmentName.db085f'))

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

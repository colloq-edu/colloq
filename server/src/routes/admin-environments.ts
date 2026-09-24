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
 * How many GPU slices are named in KERNEL_GPUS and how many of them are free.
 *
 * A slice is taken if it is the label on a room's container, a stopped one
 * too: it will be brought back up with the same device. A taken slice that
 * is no longer in the list (the operator rewrote KERNEL_GPUS) neither adds to
 * nor subtracts from the free ones: we count by the configured ones.
 *
 * On a machine without cards docker is not asked at all: there is no point
 * paying for `docker ps -a` on every screen open for a list known to be
 * empty.
 */
async function gpuState(): Promise<{ total: number; free: number }> {
  if (usingRuntimeBroker()) return { total: 0, free: 0 }
  const devices = gpuDevices()
  if (devices.length === 0) return { total: 0, free: 0 }
  const busy = new Set(await gpuBusy())
  return { total: devices.length, free: devices.filter((device) => !busy.has(device)).length }
}

/**
 * Where the route gets the build and the "what is possible here" answer. By
 * default from environments.ts; replaced in tests, because the real build
 * goes to docker, and what has to be checked is not the build but that the
 * response goes out before it.
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
      // Each row's `gpu` comes from the same place as packages: the directive
      // is read by the same file read as the package list, and by the same
      // parse by which a kernel start later decides whether to ask for a
      // slice.
      environments: await listEnvironments(),
      /*
       * Build and set as default are two different "is it allowed"s, and the
       * panel disables exactly the button that is not allowed: in a container
       * the build works (the kernel directory is mounted), while writing
       * KERNEL_ENV means the host's .env.
       */
      ...(await deps.environmentAbilities()),
      /*
       * Whether rooms share one kernel: a truth only the server knows.
       *
       * The screens promised a container per seminar unconditionally ("runs
       * in its own container", "The container mounts this room's folder"),
       * and on an install without the socket, without the room network or
       * with KERNEL_ISOLATION=off that is untrue in two places at once: rooms
       * see each other's files, and "Make default" really does take the
       * variables away from open seminars. The flag travels with the list
       * because it is shown in the same place.
       */
      shared: false,
      managed: usingRuntimeBroker(),
      gpuCapacityKnown: !usingRuntimeBroker(),
      /*
       * Slices sit next to the list for the same reason as `shared`: people
       * look at them in the same place. Without this number a teacher creates
       * a seminar on a GPU environment on a machine with no cards at all, and
       * learns about it from a kernel refusal in the middle of the lesson.
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
     * Creating and editing are different intentions, even though the request
     * is the same.
     *
     * Overwriting is right when an existing list was opened. But the "New
     * environment" form sends the same PUT, and on a taken name it wiped out
     * someone else's package list entirely: two tabs, a tablet next to a
     * laptop, curl, and not a line of the environment is left, and these
     * files have no history. `If-None-Match: *` means exactly "only if there
     * is no such one yet"; the same barrier stands on the client and in
     * `make env-new`.
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
       * The lists directory is a host folder mounted inside. When its owner
       * does not match the user the server runs as, the write fails with
       * EACCES, and this used to go to the common handler as a bare "internal
       * error", from which one could tell neither what happened nor where.
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
     * What ships with the product cannot be deleted, and this is the place to
     * say so.
     *
     * The list of such an environment lies in the application directory,
     * which for an installed colloq is site-packages: `rm` there either fails
     * on permissions (and the person sees a bare "internal error") or removes
     * a file that the next `pip install -U` brings back. The refusal says what
     * to do instead: an edit goes into a copy of its own next to the settings
     * and survives an update.
     *
     * In the repository there is one directory, the own and the shipped ones
     * coincide, and this branch never fires: deletion works there exactly as
     * it did.
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
     * The rooms that stand on it.
     *
     * Only "is this the environment the instance runs on" used to be checked.
     * A seminar whose environment was chosen at creation keeps its name in
     * its row, and after the deletion it woke up in a room where the kernel
     * does not start at all: the name is there, the image is not. People
     * found out on the first Run in the middle of the lesson.
     *
     * A refusal, not a silent move to the common environment: a computer
     * vision seminar and a plain Python seminar have different notebooks, and
     * deciding for the teacher that "it will do" is not allowed.
     */
    const attached = sessionsOnEnvironment(name)
    if (attached.length > 0) {
      const names = attached
        .slice(0, 3)
        .map((s) => s.name)
        .join(', ')
      const more = attached.length > 3 ? `, and ${attached.length - 3} more` : ''
      /*
       * The instruction has to be doable.
       *
       * This used to say "Move them to another environment first", yet there
       * is no way to move a seminar to another environment: the name is
       * chosen at creation and never changes afterwards, neither in the panel
       * nor through PATCH. Archived seminars count the same as live ones (they
       * will open just the same and need their image), so they are mentioned
       * too: otherwise last semester's archived seminar holds the name
       * forever, and the person looks for a button that does not exist.
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
       * 202 means "accepted", and it has to go out now.
       *
       * There used to be `await startBuild(name)` here, and a build is
       * minutes of docker build: the request hung all that time, and
       * "Accepted" arrived exactly when there was nothing left to accept. The
       * tab that pressed Build kept the row busy all that time, that is, it
       * did not open the live log that /log exists for and did not let one
       * press Cancel on its own build; and a relay that cuts off a ten-minute
       * request showed the owner an error while the build was going perfectly
       * well.
       *
       * The slot in `builds` is taken synchronously, before the first await
       * (environments.ts · startBuild), so /log and Cancel find the build
       * right after the response. A build failure is in its log anyway: it
       * cannot arrive here, and there is no point waiting for it.
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
      // Not "is docker visible": the default is a line in .env next to
      // docker-compose.yml, and inside a container there is nowhere to write it.
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
       * The compose kernel is touched only when the rooms actually live in it.
       *
       * With isolation every room has its own container from its environment's
       * image, and "Make default" does not reach them at all. Yet the churn
       * window was always set: any real kernel crash in the next two minutes
       * (an OOM from a student's cell) was explained as "someone switched the
       * environment", and the teacher went looking for the admin instead of
       * at their own cell.
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

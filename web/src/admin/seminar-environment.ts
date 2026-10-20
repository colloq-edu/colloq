/**
 * A class's environment as the «Занятия» list and its settings window show
 * it: which one the class is set to, what is the matter with it, and which
 * environments the window lets the class move to.
 *
 * Pure, like seminar-list.ts beside it: the words are the screen's, the
 * decisions are here, where a test reads them without a browser. The bars
 * mirror the server's refusals (routes/admin-instance.ts · environmentMove),
 * so the window never offers a choice the server would turn down. The one
 * refusal not decided here is a kernel of the class running: only the
 * server's census knows, and the window asks it
 * (GET /api/admin/seminars/:id/kernel).
 */
import type { AdminEnvironment, AdminSeminar, EnvironmentsState } from '@shared/admin'

type EnvironmentFields = Pick<AdminSeminar, 'chosenEnvironment' | 'environment'>

/**
 * The environment the class is set to. An older server sends only the one
 * its kernel is on (or was set at creation), which is the best it knows.
 */
export function chosenEnvironment(seminar: EnvironmentFields): string | null {
  return seminar.chosenEnvironment ?? seminar.environment
}

/**
 * Why a GPU environment's kernel cannot start on this machine: it gives
 * classes no card — none in KERNEL_GPUS (`noGpu`), or every card given to
 * competition submissions (`gpuToSubmissions`). Busy slices are no bar: they
 * may free up by the class, as the creation form says too. Under the runtime
 * broker the cluster's scheduler knows the cards and the panel cannot
 * (`gpuCapacityKnown`).
 */
export type GpuBar = 'noGpu' | 'gpuToSubmissions'

export function gpuBar(
  environment: Pick<AdminEnvironment, 'gpu'>,
  state: Pick<EnvironmentsState, 'gpus' | 'gpuCapacityKnown'>,
): GpuBar | null {
  if (!environment.gpu || state.gpuCapacityKnown === false || state.gpus.total > 0) return null
  return (state.gpus.runners ?? 0) > 0 ? 'gpuToSubmissions' : 'noGpu'
}

/**
 * Why an environment cannot be chosen for a class here: its image is not
 * built (the server's «не собрано», as the creation form counts it: anything
 * but `ready`), or a GPU bar.
 */
export type EnvironmentBar = 'unbuilt' | GpuBar

export function environmentBar(
  environment: Pick<AdminEnvironment, 'state' | 'gpu'>,
  state: Pick<EnvironmentsState, 'gpus' | 'gpuCapacityKnown'>,
): EnvironmentBar | null {
  if (environment.state !== 'ready') return 'unbuilt'
  return gpuBar(environment, state)
}

/**
 * What the settings window says of the class's OWN environment when it is
 * not `ready`. The choice above counts all of that as «не собрано», and for
 * a choice that is right; for the environment a class already has, the
 * kernel's fate differs:
 *
 * - `missing`: no image at all — never built, or its only build failed. The
 *   class's kernel does not start until it is built or the class moves.
 * - `building`: no image yet, a build under way: it starts once that ends.
 * - `stale`: a build exists, and something since asks for another — its list
 *   or its Python edited, its parent rebuilt, a rebuild under way or failed:
 *   the kernel starts on that earlier build, which is what docker's tag still
 *   names (kernel/pool.ts · imageExists).
 */
export type ChosenNote = 'missing' | 'building' | 'stale'

export function chosenNote(
  environment: Pick<AdminEnvironment, 'state' | 'builtAt' | 'imageBytes'>,
): ChosenNote | null {
  if (environment.state === 'ready') return null
  if (environment.builtAt !== null || environment.imageBytes !== null) return 'stale'
  return environment.state === 'building' ? 'building' : 'missing'
}

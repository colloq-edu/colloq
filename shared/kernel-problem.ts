import { formatNumber, tr } from './i18n.js'
import { parseRuntimeStartFailure, type RuntimeStartFailure } from './runtime.js'

/**
 * Почему Python комнаты не поднялся — так, чтобы преподаватель мог это исправить.
 *
 * Лежит в `meta` общего документа (`kernelProblem`), а не только в тексте
 * ошибки, по одной причине: текст ячейки и журнала ядра видят все, и там
 * студенту — короткое «сервер занят, преподаватель видит причину»
 * (server.kernel.unschedulable). Совет с числами — «уменьшите память этой или
 * других комнат» — нужен одному преподавателю, и комната рисует его сама, по
 * роли, из этого слова. Документ, а не сообщение сокета, — чтобы совет увидел и
 * преподаватель, вошедший уже после отказа.
 *
 * Пишет только сервер: `meta` клиентам закрыта гейтом (collab/gate.ts), а
 * читается значение всё равно как недоверенное.
 */
export type KernelProblem = RuntimeStartFailure
export const KERNEL_PROBLEM_KEY = 'kernelProblem'

export function readKernelProblem(value: unknown): KernelProblem | null {
  return parseRuntimeStartFailure(value) ?? null
}

/** «6», «2,5» — шаг поля памяти полгигабайта, сотые доли ему не нужны. */
const gigabytes = (mb: number): string => formatNumber(Math.round(mb / 102.4) / 10)

/** Совет преподавателю: что узлу не дать и что с этим сделать в панели. */
export function kernelProblemAdvice(problem: KernelProblem): string {
  switch (problem.unschedulable) {
    case 'memory':
      return problem.memoryMb === undefined
        ? tr('room.kernel.unschedulable.memoryAny')
        : tr('room.kernel.unschedulable.memory', { gb: gigabytes(problem.memoryMb) })
    case 'cpu':
      return problem.cpus === undefined
        ? tr('room.kernel.unschedulable.cpuAny')
        : tr('room.kernel.unschedulable.cpu', { count: problem.cpus })
    case 'gpu':
      return tr('room.kernel.unschedulable.gpu')
    default:
      return tr('room.kernel.unschedulable.other')
  }
}

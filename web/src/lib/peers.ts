/**
 * Кто в комнате — снимком, который меняется только когда меняется нарисованное.
 *
 * Присутствие — самый болтливый провод в продукте: y-codemirror публикует
 * курсор на каждое нажатие, сервер рассылает это всем, и на пятистах вкладках
 * кадры идут сотнями в секунду. Каждый такой кадр раньше собирал пятьсот новых
 * объектов, сортировал их `localeCompare` и клал НОВЫЙ массив в `session.peers`
 * — после чего просыпались все его читатели: счётчик в шапке, панель людей,
 * аватары оракула и поиск «кто запускал» в каждой смонтированной ячейке. Сорок
 * ячеек на пятьсот человек — это двадцать тысяч сравнений на один чужой курсор.
 *
 * Здесь то же правило, что в шапке yreactive: **снимок отдаётся дальше только
 * если он отличается от прошлого, а неизменившиеся куски сохраняют
 * тождественность**. Курсор, проехавший внутри той же ячейки, не меняет ничего
 * из того, что комната рисует, — и не должен доходить ни до кого.
 *
 * Без рун и без Yjs, чтобы правило проверялось без браузера: по нему рисуется
 * число, которое человек читает с экрана и которому верит.
 */
import type { AwarenessUser } from '@shared/protocol'

/** Одна вкладка в комнате: чья она и она ли наша. */
export interface Peer {
  clientId: number
  user: AwarenessUser
  isSelf: boolean
}

/**
 * Как часто пересобирается список людей, миллисекунды.
 *
 * Сотая доля секунды — это ещё «сразу» для метки «правит ячейку 04» и уже не
 * «на каждое нажатие»: сотня печатающих даёт сотни кадров в секунду, а пересчёт
 * при этом идёт десять раз. Ровно тот же тик стоит на индексе ячеек
 * (yreactive · PeerIndex), чтобы оба списка людей на экране обновлялись в один
 * момент, а не по очереди.
 */
export const PRESENCE_TICK_MS = 100

/**
 * Порядок имён — одним сравнителем на всё приложение.
 *
 * `String.prototype.localeCompare` заводит правила сравнения на КАЖДЫЙ вызов, а
 * их тут N·logN: пятьсот человек — это около четырёх с половиной тысяч
 * сравнений на пересборку. Один `Intl.Collator` даёт тот же порядок в разы
 * дешевле.
 */
const byName = new Intl.Collator()

function sameViewing(a: AwarenessUser['viewing'], b: AwarenessUser['viewing']): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null)
  return a.file === b.file && a.page === b.page && a.y === b.y
}

/**
 * Один ли это человек в одном и том же состоянии — по тому, что РИСУЮТ.
 *
 * Состояние присутствия декодируется заново на каждом кадре, так что
 * тождественность объектов не говорит ни о чём: сравнивать приходится поля. Все
 * они здесь перечислены поимённо, и это намеренно — новое поле, которое рисуют,
 * обязано попасть в список, иначе оно тихо перестанет доезжать до экрана.
 */
export function samePeerUser(a: AwarenessUser, b: AwarenessUser): boolean {
  if (a === b) return true
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.color === b.color &&
    a.avatar === b.avatar &&
    a.role === b.role &&
    (a.activeCellId ?? null) === (b.activeCellId ?? null) &&
    (a.editing ?? null) === (b.editing ?? null) &&
    (a.composing ?? false) === (b.composing ?? false) &&
    (a.inTerminal ?? false) === (b.inTerminal ?? false) &&
    sameViewing(a.viewing, b.viewing)
  )
}

/**
 * Собрать список людей из состояний присутствия — или вернуть прежний.
 *
 * Прежний массив ВОЗВРАЩАЕТСЯ ТОТ ЖЕ, когда ничего из нарисованного не
 * изменилось: присвоение того же значения руне не будит ни одного `$derived`, а
 * новый массив с тем же содержимым будит всех. Отдельно сохраняется
 * тождественность каждой не изменившейся вкладки — ради `{#each}` по clientId и
 * ради тех, кто складывает по людям производные списки.
 *
 * Себя — первым, остальных по имени: этот порядок читает и шапка, и панель
 * людей, и он не должен зависеть от того, в каком порядке приехали кадры.
 */
export function nextPeers(
  states: Iterable<readonly [number, { user?: unknown } | undefined]>,
  self: number,
  previous: readonly Peer[],
): readonly Peer[] {
  const next: Peer[] = []
  for (const [clientId, state] of states) {
    const user = state?.user as AwarenessUser | undefined
    // Сокет без личности — это страница, которая ещё входит, а не человек.
    if (!user?.id) continue
    next.push({ clientId, user, isSelf: clientId === self })
  }
  next.sort(
    (a, b) => Number(b.isSelf) - Number(a.isSelf) || byName.compare(a.user.name, b.user.name),
  )

  const kept = new Map<number, Peer>()
  for (const peer of previous) kept.set(peer.clientId, peer)
  let same = next.length === previous.length
  for (let i = 0; i < next.length; i++) {
    const was = kept.get(next[i].clientId)
    if (was && was.isSelf === next[i].isSelf && samePeerUser(was.user, next[i].user)) next[i] = was
    // Перестановка — тоже изменение: список рисуется в этом порядке.
    if (same && previous[i] !== next[i]) same = false
  }
  return same ? previous : next
}

/**
 * Люди по участнику, а не по вкладке: `runById` → чьё это лицо.
 *
 * Карта, а не поиск: «кто запускал» спрашивает КАЖДАЯ ячейка с выводом, и на
 * двухстах ячейках с пятьюстами вкладками поиск перебором — это сто тысяч
 * сравнений на кадр присутствия. Ключ — id участника: имена в комнате не
 * уникальны, две Анны — два человека.
 *
 * Первая вкладка человека и выигрывает: имя, цвет и лицо у всех его вкладок
 * одни и те же, а больше отсюда ничего не читают.
 */
export function peersById(peers: readonly Peer[]): ReadonlyMap<string, AwarenessUser> {
  const byId = new Map<string, AwarenessUser>()
  for (const peer of peers) if (!byId.has(peer.user.id)) byId.set(peer.user.id, peer.user)
  return byId
}

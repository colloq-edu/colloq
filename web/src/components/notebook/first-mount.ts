/**
 * Remember the cells whose full component has been constructed. Once visited,
 * a cell keeps its local editing state and subscriptions; CellView still parks
 * its expensive editor/output body when it leaves the viewport.
 */
export function nextBuiltCells(
  previous: ReadonlySet<string>,
  ids: readonly string[],
  needed: (id: string, index: number) => boolean,
): ReadonlySet<string> {
  const next = new Set<string>()
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]
    if (previous.has(id) || needed(id, index)) next.add(id)
  }
  return next.size === previous.size && [...next].every((id) => previous.has(id)) ? previous : next
}

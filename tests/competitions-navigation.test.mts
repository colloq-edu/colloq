import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../web/src/screens/CompetitionsScreen.svelte', import.meta.url), 'utf8')
function loader(name: string, state: Record<string, unknown>, api: Record<string, unknown>) {
  const start = source.indexOf(`  async function ${name}(`)
  const end = source.indexOf('\n  }', start) + 4
  const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
  return new Function('state', 'entrantApi', `with (state) { ${code}; return ${name}; }`)(state, api)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

for (const [name, apiName, field] of [['loadPage', 'competition', 'page'], ['loadBoard', 'leaderboard', 'board'], ['loadMine', 'submissions', 'mine']] as const) {
  test(`${name} ignores a late response from the previous route or identity`, async () => {
    for (const change of ['route', 'identity']) {
      const pending = deferred<object>()
      const state: Record<string, any> = { route: { slug: 'alpha' }, me: { entrant: { id: 'one' } }, generation: 1,
        page: null, board: null, mine: null, failure: null, ready: false,
        requestContext: () => ({ generation: state.generation, slug: state.route.slug, identity: state.me.entrant.id }),
        currentContext: (context: any) => context.generation === state.generation && context.slug === state.route.slug && context.identity === state.me.entrant.id }
      const load = loader(name, state, { [apiName]: () => pending.promise })
      const task = load('alpha')
      state.generation++
      if (change === 'route') state.route.slug = 'beta'
      else state.me.entrant.id = 'two'
      state[field] = { current: 'new' }
      pending.resolve({ stale: 'old' })
      await task
      assert.deepEqual(state[field], { current: 'new' })
      assert.equal(state.failure, null)
    }
  })
}

test('loadMe cannot overwrite identity established by a newer sign-in', async () => {
  const pending = deferred<object>()
  const state = { identityRequest: 0, me: null as object | null }
  const load = loader('loadMe', state, { me: () => pending.promise })
  const task = load()
  state.identityRequest++
  state.me = { entrant: { id: 'signed-in' } }
  pending.resolve({ entrant: null })
  await task
  assert.deepEqual(state.me, { entrant: { id: 'signed-in' } })
})

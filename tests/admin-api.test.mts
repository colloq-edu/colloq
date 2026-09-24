/**
 * What the panel actually puts into the request.
 *
 * Two places where a client/server mismatch cost a class and did not break
 * any build. A notebook from disk travelled whole, outputs included: the
 * request body is limited to a megabyte, while an executed notebook with a
 * couple of plots is megabytes of base64, and the door answered "internal
 * error" to a file about which it had itself promised "outputs are
 * dropped". Deleting a seminar never asked about the fate of the public
 * page, although the server declares that question a separate one: the copy
 * of the notebook stayed open to everyone, and there was nothing left to
 * take it down with.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adminApi } from '../web/src/lib/adminApi.js'

interface Seen {
  url: string
  init: RequestInit | undefined
}

/** Replaces fetch and returns what the panel tried to send. */
async function capture(run: () => Promise<unknown>): Promise<Seen> {
  const seen: Seen[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return {
      ok: true,
      status: 204,
      headers: new Headers({ 'content-length': '0' }),
      json: async () => ({}),
    } as unknown as Response
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = real
  }
  assert.equal(seen.length, 1, 'exactly one request')
  return seen[0]
}

const bodyOf = (seen: Seen): Record<string, unknown> =>
  JSON.parse(String(seen.init?.body ?? '{}')) as Record<string, unknown>

/* ---------------------------------------------------- notebook from disk */

test('notebook import sends cells, not the whole file', async () => {
  const cells = [
    { cell_type: 'code', source: 'print(1)' },
    { cell_type: 'markdown', source: '# hello' },
  ]
  const seen = await capture(() => adminApi.importNotebook({ cells, filename: 'week07.ipynb' }))

  assert.equal(seen.url, '/api/admin/import/notebook')
  const body = bodyOf(seen)
  assert.deepEqual(body.cells, cells)
  // The field with the file text is gone entirely: it was exactly what did not fit the limit.
  assert.equal('notebook' in body, false)
})

test('outputs do not get into the request body', async () => {
  // Exactly what the screen does: the type and text are taken from a cell, nothing else.
  const raw = {
    cell_type: 'code',
    source: 'plt.show()',
    outputs: [{ data: { 'image/png': 'A'.repeat(4096) } }],
    execution_count: 7,
  }
  const stripped = { cell_type: raw.cell_type, source: raw.source }
  const seen = await capture(() =>
    adminApi.importNotebook({ cells: [stripped], filename: 'plots.ipynb' }),
  )

  const sent = String(seen.init?.body ?? '')
  assert.equal(sent.includes('image/png'), false)
  assert.equal(sent.includes('execution_count'), false)
  assert.ok(sent.length < 1024, 'the body is measured in hundreds of bytes, not megabytes')
})

/* -------------------------------------------------- deletion and its page */

test('by default the page stays: a link already handed out cannot be recalled', async () => {
  const seen = await capture(() => adminApi.deleteSeminar('abc12345'))
  assert.equal(seen.url, '/api/admin/seminars/abc12345')
  assert.equal(seen.init?.method, 'DELETE')
})

test('consent to take the page down reaches the server as a parameter', async () => {
  const seen = await capture(() => adminApi.deleteSeminar('abc12345', true))
  assert.equal(seen.url, '/api/admin/seminars/abc12345?reading=drop')
  assert.equal(seen.init?.method, 'DELETE')
})

test('a page without a room can be taken down at its own address', async () => {
  const seen = await capture(() => adminApi.withdrawPublication('p0000001'))
  assert.equal(seen.url, '/api/admin/publications/p0000001')
  assert.equal(seen.init?.method, 'DELETE')
})

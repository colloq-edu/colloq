/**
 * A branch with a slash: `release/2024`, `feature/x`, `students/2026-fall`.
 *
 * In the browser the address of such a branch looks exactly like that of an
 * ordinary one — `/o/r/tree/release/2024/week1` — and nothing in it shows where
 * the branch name ends and the path begins. Parsing takes the first segment,
 * GitHub answers 404, and the server turned that into "no such thing, or the
 * repository is private": the teacher went looking for a typo in a link that
 * was fine, or making public a repository that was already public.
 *
 * There is no network here: `fetch` is replaced for the duration of the test.
 * What is checked is not GitHub but our behaviour — how many requests, in what
 * order, and what goes up if the guess fails.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listDirectory, resolveRef, type GithubTarget } from '../server/src/github.js'

const real = globalThis.fetch

interface Call {
  url: string
}

/**
 * A fake `fetch`: a map "piece of the address → response". Everything not in
 * the map is a 404, because that is exactly how GitHub answers both "no such
 * thing" and "not for you".
 */
function fakeGithub(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    calls.push({ url })
    for (const [needle, body] of Object.entries(routes)) {
      if (!url.includes(needle)) continue
      return {
        ok: true,
        status: 200,
        json: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
      } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  }) as typeof fetch
  return calls
}

function restore(): void {
  globalThis.fetch = real
}

const target = (over: Partial<GithubTarget> = {}): GithubTarget => ({
  owner: 'o',
  repo: 'r',
  ref: 'release',
  path: '2024/week1',
  kind: 'dir',
  ...over,
})

test('a branch with a slash is recognised from the branch list, not from the phrase about privacy', async () => {
  const calls = fakeGithub({
    'branches?per_page=100': [{ name: 'main' }, { name: 'release/2024' }],
    'contents/week1?ref=release%2F2024': [
      { name: 'nb.ipynb', path: 'week1/nb.ipynb', type: 'file', size: 10, download_url: 'https://raw/nb' },
    ],
  })
  try {
    const entries = await listDirectory(target())
    assert.deepEqual(entries.map((e) => e.name), ['nb.ipynb'])
    /*
     * Three requests and in exactly this order: first as parsed, then — only
     * after the 404 — the branch list, then again. Asking for the branches up
     * front is not allowed: anonymous requests to GitHub are sixty per hour,
     * and an import already costs two.
     */
    assert.equal(calls.length, 3, calls.map((c) => c.url).join('\n'))
    assert.match(calls[0]?.url ?? '', /contents\/2024\/week1\?ref=release$/)
    assert.match(calls[1]?.url ?? '', /branches\?per_page=100$/)
    assert.match(calls[2]?.url ?? '', /contents\/week1\?ref=release%2F2024$/)
  } finally {
    restore()
  }
})

test('a live answer does not pay for the guess: branches are not asked for at all', async () => {
  const calls = fakeGithub({ 'contents/week02?ref=main': [] })
  try {
    await listDirectory(target({ ref: 'main', path: 'week02' }))
    assert.equal(calls.length, 1, 'an extra request to GitHub on every successful import')
  } finally {
    restore()
  }
})

test('if there is no such branch, the original refusal goes up, not an invented one', async () => {
  fakeGithub({ 'branches?per_page=100': [{ name: 'main' }] })
  try {
    await assert.rejects(
      () => listDirectory(target()),
      // That very phrase about privacy — here it really is the only honest
      // answer: the repository has no branch with that name.
      /репозиторий закрытый/,
    )
  } finally {
    restore()
  }
})

test('of two matching branches the longest one is taken', async () => {
  // `release/2024/hotfix` beats `release/2024`, and that one beats a bare
  // `release`: otherwise the path would go off with a piece of the branch name.
  fakeGithub({
    'branches?per_page=100': [
      { name: 'release' },
      { name: 'release/2024' },
      { name: 'release/2024/hotfix' },
    ],
  })
  try {
    const fixed = await resolveRef(target({ path: '2024/hotfix/week1' }))
    assert.equal(fixed.ref, 'release/2024/hotfix')
    assert.equal(fixed.path, 'week1')
  } finally {
    restore()
  }
})

test('a branch as long as the whole path leaves the repository root, not a tail of the name', async () => {
  fakeGithub({ 'branches?per_page=100': [{ name: 'students/2026-fall' }] })
  try {
    const fixed = await resolveRef(target({ ref: 'students', path: '2026-fall' }))
    assert.equal(fixed.ref, 'students/2026-fall')
    assert.equal(fixed.path, '')
  } finally {
    restore()
  }
})

test('without a path there is nothing to guess, and no request is spent', async () => {
  const calls = fakeGithub({})
  try {
    const same = await resolveRef(target({ ref: 'main', path: '' }))
    assert.equal(same.ref, 'main')
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

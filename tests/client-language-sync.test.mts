import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { compileModule } from 'svelte/compiler'
import { setLocaleResolver } from '../shared/i18n.js'

type Client = typeof import('../web/src/lib/i18n.svelte.js')
type Pending = { resolve: (response: Response) => void; reject: (cause: unknown) => void }
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const response = (language: string) => Response.json({ language })

/** Exercise the actual compiled rune module with controllable HTTP responses. */
async function withClient(run: (client: Client, requests: Pending[]) => Promise<void>, cached?: string, supplied?: string, path = '/admin') {
  const names = ['window', 'document', 'localStorage', 'fetch', 'location'] as const
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const requests: Pending[] = []
  const storage = new Map(cached ? [['colloq:instance-language', cached]] : [])
  const win = Object.assign(new EventTarget(), { setInterval: () => 1, clearInterval: () => {} })
  const doc = Object.assign(new EventTarget(), {
    documentElement: { lang: '' }, visibilityState: 'visible',
    querySelector: () => supplied === undefined ? null : { getAttribute: () => supplied },
  })
  const globals = {
    window: win,
    document: doc,
    // Адрес решает, опрашивать ли сервер: в комнате язык приносит сокет.
    location: { pathname: path },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    fetch: () => new Promise<Response>((resolve, reject) => requests.push({ resolve, reject })),
  }
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: globals[name] })
  const dir = await mkdtemp(join(tmpdir(), 'colloq-language-client-'))
  let client: Client | undefined
  try {
    const source = await readFile(new URL('../web/src/lib/i18n.svelte.ts', import.meta.url), 'utf8')
    const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    const compiled = compileModule(javascript, { filename: 'i18n.svelte.js', generate: 'client' }).js.code
      .replaceAll("'svelte/internal/client'", JSON.stringify(import.meta.resolve('svelte/internal/client')))
      .replaceAll("'@shared/i18n'", JSON.stringify(new URL('../shared/i18n.ts', import.meta.url).href))
      .replaceAll("'./routes'", JSON.stringify(new URL('../web/src/lib/routes.ts', import.meta.url).href))
    const file = join(dir, 'client.mjs')
    await writeFile(file, compiled)
    client = await import(pathToFileURL(file).href) as Client
    await run(client, requests)
  } finally {
    client?.stopLanguageSync()
    setLocaleResolver(() => 'ru')
    for (const name of names) {
      const descriptor = descriptors.get(name)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('an older GET cannot overwrite a newer room language', async () => {
  await withClient(async (client, requests) => {
    const initial = client.initializeLanguage()
    client.setLanguage('en')
    requests[0].resolve(response('ru'))
    await initial
    assert.equal(client.language.current, 'en')
    assert.equal(document.documentElement.lang, 'en')
  })
})

test('HTML-supplied language starts a cold app with no settings request at all', async () => {
  await withClient(async (client, requests) => {
    assert.equal(client.language.current, 'en')
    let ready = false
    const initial = client.initializeLanguage().then(() => { ready = true })
    await settle()
    assert.equal(ready, true, 'initial app still waits for the language round trip')
    assert.equal(document.documentElement.lang, 'en')
    // Навигационный HTML уже принёс язык инстанса. Спрашивать его ещё раз —
    // это лишний запрос на пути к первому кадру у каждого входящего.
    assert.deepEqual(requests, [])
    await initial
  }, undefined, 'en')
})

test('a room leaves the polling to its control socket; other screens keep a slow one', async () => {
  const started: number[] = []
  const stopped: number[] = []
  const spy = { setInterval: (_run: () => void, every: number) => started.push(every), clearInterval: (id: number) => stopped.push(id) }
  await withClient(async (client, requests) => {
    Object.assign(window, spy)
    await client.initializeLanguage()
    requests[0]?.resolve(response('ru'))
    assert.deepEqual(started, [], 'a seminar room polls nothing')
  }, 'ru', undefined, '/s/room1')
  await withClient(async (client, requests) => {
    Object.assign(window, spy)
    await client.initializeLanguage()
    requests[0]?.resolve(response('ru'))
    assert.deepEqual(started, [5 * 60_000], 'the panel still reads, ten times more slowly')
  }, 'ru', undefined, '/admin')
})

test('current HTML language overrides stale cache, while unsupported values use normal initialization', async () => {
  await withClient(async client => { assert.equal(client.language.current, 'en') }, 'ru', 'en')
  await withClient(async (client, requests) => {
    const initial = client.initializeLanguage()
    requests[0].resolve(response('en'))
    await initial
    assert.equal(client.language.current, 'en')
  }, undefined, 'unsupported')
})

test('owner confirmation waits for an older GET and starts a fresh read', async () => {
  await withClient(async (client, requests) => {
    await client.initializeLanguage()
    const confirmation = client.revalidateLanguage()
    assert.equal(requests.length, 1)
    requests[0].resolve(response('ru'))
    await settle()
    assert.equal(requests.length, 2)
    requests[1].resolve(response('en'))
    await confirmation
    assert.equal(client.language.current, 'en')
  }, 'ru')
})

test('a newer WS language wins while owner confirmation is in flight', async () => {
  await withClient(async (client, requests) => {
    const confirmation = client.revalidateLanguage()
    client.setLanguage('en')
    requests[0].resolve(response('ru'))
    await confirmation
    assert.equal(client.language.current, 'en')
    const failedConfirmation = client.revalidateLanguage()
    client.setLanguage('ru')
    requests[1].reject(new TypeError('offline'))
    await failedConfirmation
    assert.equal(client.language.current, 'ru')
  })
})

test('unconfirmed writes fail visibly while ordinary background reads tolerate offline mode', async () => {
  await withClient(async (client, requests) => {
    const initial = client.initializeLanguage()
    requests[0].reject(new TypeError('offline'))
    await initial
    assert.equal(client.language.current, 'ru')
    const confirmation = client.revalidateLanguage()
    requests[1].resolve(new Response('', { status: 503 }))
    await assert.rejects(confirmation)
    const malformed = client.revalidateLanguage()
    requests[2].resolve(response('fr'))
    await assert.rejects(malformed)
    assert.equal(client.language.current, 'ru')
  })
})

test('background synchronization does not inherit a concurrent confirmation failure', async () => {
  await withClient(async (client, requests) => {
    const confirmation = client.revalidateLanguage()
    const background = client.initializeLanguage()
    requests[0].reject(new TypeError('offline'))
    await assert.rejects(confirmation)
    await background
    assert.equal(client.language.current, 'ru')
  })
})

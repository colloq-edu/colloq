/**
 * Who deployed this instance.
 *
 * The line next to the logo was hard-coded into the markup and named one
 * specific university. The product is deployed by different organisations: at
 * one address it is HSE, at another a bank, at a third nothing is needed — and
 * at someone else's address the hard-coded line was not a default but a
 * stranger's name in the header of every room and on the join screen. Now it
 * is `INSTITUTION`, and the default is empty.
 *
 * What is checked is what can be seen without a browser: the line rides in the
 * seminar card — that is, onto every room screen and the join screen, without
 * a single extra request — and is cut by the ceiling before it reaches the
 * markup.
 */
import './_env.mts'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

/**
 * Longer than the ceiling — otherwise there is nothing to cut.
 *
 * Assigned BEFORE a single server module is loaded: `config` reads the
 * environment once, at import. The imports above are harmless — none of them
 * knows anything about the environment — and everything that does arrives via
 * a dynamic import below, because a static one would be hoisted above this
 * line, and the line would be late for exactly everything.
 */
const LONG =
  'Национальный исследовательский университет имени очень длинного названия · Факультет чего-нибудь'
process.env.INSTITUTION = LONG

const { config } = await import('../server/src/config.js')
const { createSession, getSession } = await import('../server/src/db.js')
// The whole app (server/src/app.ts): its middleware order is the same as in
// class, while one assembled here would only be similar.
const { app } = await import('../server/src/app.js')

/* ------------------------------------------------------------------ ceiling */

test('a long name is cut by the ceiling, not by the markup', () => {
  /*
   * Eighty characters — the same ceiling as for the model name in the room
   * rules (shared/rules.ts). Cutting in the markup would be too late: the line
   * rides in every response about the seminar and lands in the localStorage of
   * every browser as part of the room card.
   */
  assert.ok(LONG.length > 80, 'the test string is shorter than the ceiling — nothing to check')
  assert.equal(config.institution.length, 80)
  assert.equal(config.institution, LONG.slice(0, 80))
})

/* ------------------------------------------------------------ room card */

test('both a new room and one read from the database name the organisation the same way', () => {
  const id = 'inst-card'
  /*
   * A property of the instance, not a field in a table row: both ways of
   * building the card take it from the config. By changing INSTITUTION the
   * operator changes the label in all rooms at once, including last year's —
   * not only in those created from now on.
   */
  assert.equal(createSession(id, 'Комната', null).institution, config.institution)
  assert.equal(getSession(id)?.institution, config.institution)
})

let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

test('the join screen learns the organisation from the same room card', async () => {
  const id = 'inst-route'
  createSession(id, 'Комната', null)

  const res = await fetch(`${base}/api/sessions/${id}`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { institution: string }
  // That is the whole choice of delivery: the join poster is drawn from this
  // response and fetches nothing else.
  assert.equal(body.institution, config.institution)
})

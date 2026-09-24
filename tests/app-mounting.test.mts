/**
 * Middleware order is not rewritten in tests: it is mounted.
 *
 * The panel and room doors were checked behind an express assembly of their
 * own: `admin.test` built the app itself and COPIED the order into it ("the
 * same order as in index.ts", said the comment above the copy). A copy does
 * not catch divergences from the product, it repeats them: move the origin
 * check relative to the routers, and the unit tests stay green over a
 * server where a write from someone else's page gets through. The app lives
 * in `server/src/app.ts` and is exported whole, so nobody needs the copy
 * any more.
 *
 * Two things are here that would otherwise be seen only at the next audit:
 * that the copy has not come back (the test does not import the origin
 * check; the product installs it) and that the doors behind which there is a
 * right are mounted by the app. Separate routers in tests remain legitimate:
 * some of them are started with fakes and ceilings of their own
 * (`councilRoutes(deps)`, the oracle at 4 MB); there the router is tested,
 * not the door.
 *
 * The same device as in `panels-ban-promise` and `*-craft`: the rule is read
 * from the files, not retold next to them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const TESTS = import.meta.dirname
const read = (name: string): string => fs.readFileSync(path.join(TESTS, name), 'utf8')
const files = fs.readdirSync(TESTS).filter((name) => name.endsWith('.test.mts'))
const SRC = path.join(TESTS, '..', 'server', 'src')
const server = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8')

test('no test assembles the origin check on its own', () => {
  assert.ok(files.length > 50, 'there are suddenly too few tests, nothing to check')
  /*
   * Exactly an import, not a word: one may and should write about
   * `sameOrigin` in comments (`app-wiring`, `upload-budget` explain where it
   * stands), but putting it into one's own `app.use` means creating a second
   * copy of the rule.
   */
  const imports = /import\s*(?:type\s*)?\{[^}]*\bsameOrigin\b[^}]*\}\s*from/
  for (const name of files) {
    assert.equal(imports.test(read(name)), false, `${name}: the middleware order is copied into the test`)
  }
})

test('doors with a right are checked on the app, not on a lookalike', () => {
  /*
   * The panel, room entry, files and the ban: four places where a refusal is
   * decided not by the router but by what stands in front of it. Each of them
   * takes the whole `app`.
   */
  for (const name of [
    'admin.test.mts',
    'identity.test.mts',
    'file-access.test.mts',
    'ban-http.test.mts',
  ]) {
    const source = read(name)
    assert.match(source, /from '\.\.\/server\/src\/app\.js'/, `${name}: the app is not mounted`)
    assert.doesNotMatch(
      source,
      /^\s*(?:const|let)\s+app\s*=\s*express\(\)/m,
      `${name}: another app is assembled next to the real one`,
    )
  }
})

test('index.ts holds the process, not the assembly', () => {
  /*
   * The other side of the move: as long as `app.use` can be added to
   * index.ts, the order will again end up in two places, and nobody will
   * mount the second one.
   */
  const index = server('index.ts')
  assert.match(index, /from '\.\/app\.js'/, 'index.ts assembles the app itself instead of taking the ready one')
  for (const [pattern, what] of [
    [/\bexpress\(\)/, 'express()'],
    [/^\s*app\.use\(/m, 'app.use'],
    [/express\.json\(/, 'express.json'],
  ] as const) {
    assert.doesNotMatch(index, pattern, `index.ts assembles the app again: ${what}`)
  }
  const app = server('app.ts')
  assert.match(app, /app\.use\('\/api', \(req, res, next\) => \{/, 'app.ts lost the /api entry')
  assert.match(app, /express\.json\(\{ limit: '1mb' \}\)/, 'app.ts lost the body limit')
})

test('comments do not send the reader to index.ts for the assembly', () => {
  /*
   * Three files where the assembly is talked about in words: `admin/auth.ts`
   * writes the rule, `app.ts` mounts it, index.ts no longer holds it. Sending
   * a reader to index.ts for the order is exactly a divergence between word
   * and deed: they will go and not find it. Writing about the neighbouring
   * `collab/index.ts` is still allowed: only a bare name next to words about
   * the assembly is forbidden.
   *
   * And the whole `routes/` folder: both lines that lied about index.ts lived
   * right there (`admin-import.ts` about `express.json`, `sessions.ts` about
   * the mounting order), because a router is exactly what explains what
   * stands in front of it. A folder walk, not a list of names: the next
   * router falls under the guard by itself, without editing this test.
   */
  const bare = /(?<![\w./])index\.ts/
  const wiring = /(`\/api`|express\.json|sameOrigin|slideStaffCookie|mount|middleware)/
  const routes = fs
    .readdirSync(path.join(SRC, 'routes'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `routes/${name}`)
  assert.ok(routes.length > 10, 'the routes/ folder is suddenly empty, nothing to guard')
  for (const rel of ['admin/auth.ts', 'app.ts', 'index.ts', ...routes]) {
    for (const [at, line] of server(rel).split('\n').entries()) {
      if (!bare.test(line) || !wiring.test(line)) continue
      assert.fail(`${rel}:${at + 1}: the assembly lives in app.ts, but the comment sends the reader to index.ts`)
    }
  }
})

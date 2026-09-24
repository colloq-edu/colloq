/**
 * `make dev` lays out the static bundles itself.
 *
 * The pdf.js worker and plotly.js are put into `web/public` by the
 * `npm run assets` step, while `make dev` calls Vite directly, bypassing npm.
 * While the worker lay in git, nobody noticed; plotly.js is not in git (five
 * megabytes from package-lock), and on a fresh clone the chart would say it
 * failed to load. The check is by reading: the list of copies in the
 * launcher and the list in web/package.json must match.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const launch = readFileSync(new URL('../cli/src/launch.ts', import.meta.url), 'utf8')
const web = JSON.parse(readFileSync(new URL('../web/package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>
}

test('the dev launcher lays the static bundles out before Vite starts', () => {
  const at = launch.indexOf('if (dev) layOutWebAssets(root)')
  assert.ok(at > 0, 'the dev launch does not lay out the bundles')
  assert.ok(at < launch.indexOf("'Dev frontend'"), 'the layout must come BEFORE Vite starts')
})

test('the launcher copies exactly what `npm run assets` copies', () => {
  for (const script of ['pdf:worker', 'plotly:dist']) {
    const line = web.scripts[script]
    assert.ok(line, `web/package.json has no ${script} step`)
    const source = /require\.resolve\('([^']+)'\)/.exec(line)?.[1]
    const target = /'(public\/[^']+\.(?:m?js))'\)/.exec(line)?.[1]
    assert.ok(source && target, `could not parse the ${script} step`)
    assert.ok(launch.includes(`'${source}'`), `the dev launch does not know about ${source}`)
    assert.ok(launch.includes(`'web/${target}'`), `the dev launch puts ${source} in the wrong place`)
  }
  assert.match(web.scripts.assets, /pdf:worker.*plotly:dist/)
})

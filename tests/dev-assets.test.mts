/**
 * `make dev` раскладывает статические бандлы сам.
 *
 * Воркер pdf.js и plotly.js кладёт в `web/public` шаг `npm run assets`, а
 * `make dev` зовёт Vite напрямую, минуя npm. Пока воркер лежал в git, этого
 * никто не замечал; plotly.js в git нет (пять мегабайт из package-lock), и на
 * свежем клоне график писал бы, что не смог загрузиться. Проверка — чтением:
 * список копий в запуске и список в web/package.json обязаны совпадать.
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
  assert.ok(at > 0, 'запуск dev не раскладывает бандлы')
  assert.ok(at < launch.indexOf("'Dev frontend'"), 'раскладка обязана стоять ДО старта Vite')
})

test('the launcher copies exactly what `npm run assets` copies', () => {
  for (const script of ['pdf:worker', 'plotly:dist']) {
    const line = web.scripts[script]
    assert.ok(line, `в web/package.json нет шага ${script}`)
    const source = /require\.resolve\('([^']+)'\)/.exec(line)?.[1]
    const target = /'(public\/[^']+\.(?:m?js))'\)/.exec(line)?.[1]
    assert.ok(source && target, `не разобрал шаг ${script}`)
    assert.ok(launch.includes(`'${source}'`), `запуск dev не знает про ${source}`)
    assert.ok(launch.includes(`'web/${target}'`), `запуск dev кладёт ${source} не туда`)
  }
  assert.match(web.scripts.assets, /pdf:worker.*plotly:dist/)
})

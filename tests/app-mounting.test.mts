/**
 * Порядок middleware в тестах не переписывают — его монтируют.
 *
 * Двери панели и комнаты проверялись за своей сборкой express: `admin.test`
 * собирал приложение сам и КОПИРОВАЛ в него порядок — «тот же порядок, что в
 * index.ts», говорил комментарий над копией. Копия расхождений с продуктом не
 * ловит, она их повторяет: перенеси проверку происхождения относительно
 * роутеров — и юнит-тесты останутся зелёными над сервером, где запись с чужой
 * страницы проходит. Приложение живёт в `server/src/app.ts` и экспортируется
 * целиком, так что копия больше не нужна никому.
 *
 * Здесь две вещи, которые иначе видно только при следующем аудите: что копия
 * не вернулась (проверку происхождения тест не импортирует — её ставит
 * продукт) и что двери, за которыми есть право, монтируются приложением.
 * Отдельные роутеры в тестах остаются законными: часть из них поднимают с
 * подделками и своими потолками (`councilRoutes(deps)`, оракул на 4 МБ) — там
 * проверяют роутер, а не дверь.
 *
 * Тот же приём, что в `panels-ban-promise` и `*-craft`: правило читается из
 * файлов, а не пересказывается рядом.
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

test('ни один тест не собирает у себя проверку происхождения', () => {
  assert.ok(files.length > 50, 'тестов вдруг стало мало — проверять нечего')
  /*
   * Именно импорт, а не слово: про `sameOrigin` можно и нужно писать в
   * комментариях (`app-wiring`, `upload-budget` объясняют, где она стоит), но
   * ввести её в свой `app.use` значит завести вторую копию правила.
   */
  const imports = /import\s*(?:type\s*)?\{[^}]*\bsameOrigin\b[^}]*\}\s*from/
  for (const name of files) {
    assert.equal(imports.test(read(name)), false, `${name}: порядок middleware скопирован в тест`)
  }
})

test('двери с правом проверяются на приложении, а не на подобии', () => {
  /*
   * Панель, вход в комнату, файлы и бан — четыре места, где отказ решает не
   * роутер, а то, что стоит перед ним. Каждое из них берёт `app` целиком.
   */
  for (const name of [
    'admin.test.mts',
    'identity.test.mts',
    'file-access.test.mts',
    'ban-http.test.mts',
  ]) {
    const source = read(name)
    assert.match(source, /from '\.\.\/server\/src\/app\.js'/, `${name}: приложение не смонтировано`)
    assert.doesNotMatch(
      source,
      /^\s*(?:const|let)\s+app\s*=\s*express\(\)/m,
      `${name}: рядом с приложением собрано ещё одно`,
    )
  }
})

test('index.ts держит процесс, а не сборку', () => {
  /*
   * Обратная сторона переезда: пока `app.use` можно дописать в index.ts,
   * порядок снова окажется в двух местах, и второе никто не смонтирует.
   */
  const index = server('index.ts')
  assert.match(index, /from '\.\/app\.js'/, 'index.ts собирает приложение сам, а не берёт готовое')
  for (const [pattern, what] of [
    [/\bexpress\(\)/, 'express()'],
    [/^\s*app\.use\(/m, 'app.use'],
    [/express\.json\(/, 'express.json'],
  ] as const) {
    assert.doesNotMatch(index, pattern, `index.ts снова собирает приложение: ${what}`)
  }
  const app = server('app.ts')
  assert.match(app, /app\.use\('\/api', \(req, res, next\) => \{/, 'app.ts потерял вход /api')
  assert.match(app, /express\.json\(\{ limit: '1mb' \}\)/, 'app.ts потерял предел на тело')
})

test('комментарии не отправляют за сборкой в index.ts', () => {
  /*
   * Три файла, где о сборке говорят словами: `admin/auth.ts` пишет правило,
   * `app.ts` его монтирует, index.ts его больше не держит. Отправить читателя
   * за порядком в index.ts — это и есть расхождение слова и дела: он пойдёт и
   * не найдёт. Про соседний `collab/index.ts` писать по-прежнему можно —
   * запрещено только голое имя рядом со словами о сборке.
   *
   * И вся папка `routes/`: обе строки, которые врали про index.ts, жили
   * именно там — `admin-import.ts` про `express.json`, `sessions.ts` про
   * порядок монтирования, — потому что роутер как раз и объясняет, что стоит
   * перед ним. Обход папки, а не список имён: следующий роутер попадает под
   * сторож сам, без правки этого теста.
   */
  const bare = /(?<![\w./])index\.ts/
  const wiring = /(`\/api`|express\.json|sameOrigin|slideStaffCookie|монтир|middleware)/
  const routes = fs
    .readdirSync(path.join(SRC, 'routes'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `routes/${name}`)
  assert.ok(routes.length > 10, 'папка routes/ вдруг опустела — сторожить нечего')
  for (const rel of ['admin/auth.ts', 'app.ts', 'index.ts', ...routes]) {
    for (const [at, line] of server(rel).split('\n').entries()) {
      if (!bare.test(line) || !wiring.test(line)) continue
      assert.fail(`${rel}:${at + 1}: сборка живёт в app.ts, а комментарий шлёт в index.ts`)
    }
  }
})

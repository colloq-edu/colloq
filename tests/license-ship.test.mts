import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

// Что едет наружу вместе с программой и как её собирают на GitHub. Каждая
// проверка — про вещь, которую легко потерять правкой рядом и которую никто не
// заметит до публикации: колесо и образы без текста MIT, страница PyPI без
// ссылки на исходник, токен в .git/config на время чужих install-скриптов.
const read = (file: string) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')

test('the wheel and every image carry LICENSE and the third-party notices', () => {
  // scripts/pack.mts кладёт оба файла в корень приложения, то есть в колесо.
  const pack = read('scripts/pack.mts')
  assert.match(pack, /\['LICENSE', 'THIRD_PARTY_NOTICES\.md'\]/)

  const dockerfile = read('Dockerfile')
  const base = dockerfile.split('AS app-base')[1]!.split('FROM app-base AS development')[0]!
  assert.match(base, /^COPY LICENSE THIRD_PARTY_NOTICES\.md \.\/$/m)
  const broker = dockerfile.split('AS broker')[1]!.split('FROM ')[0]!
  assert.match(broker, /^COPY LICENSE \.\/$/m)

  assert.match(read('deploy/vast/Dockerfile'), /^COPY LICENSE THIRD_PARTY_NOTICES\.md \.\/$/m)
  // .dockerignore не должен их отсечь: COPY тогда падает, но уже на выпуске.
  const ignored = read('.dockerignore').split('\n').map((line) => line.trim())
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', '*.md'])
    assert.equal(ignored.includes(name), false, `.dockerignore drops ${name}`)
})

test('the PyPI page links the source, the tracker and the changelog', () => {
  const pyproject = read('python/pyproject.toml')
  const urls = pyproject.split('[project.urls]')[1]!.split('\n[')[0]!
  for (const key of ['Homepage', 'Documentation', 'Source', 'Issues', 'Changelog'])
    assert.match(urls, new RegExp(`^${key} = "https://`, 'm'), `${key} is missing`)
  assert.doesNotMatch(pyproject, /authors = \[\{ name = "Colloq" \}\]/)
})

test('no workflow leaves the token in .git/config after checkout', () => {
  const dir = new URL('../.github/workflows/', import.meta.url)
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.yml'))) {
    const text = readFileSync(new URL(file, dir), 'utf8')
    // Шаг checkout — от `uses:` до следующего шага; внутри обязан быть флаг.
    const steps = text.split(/\n\s+- (?=uses:|name:|run:|id:)/)
    for (const step of steps.filter((s) => /uses: actions\/checkout@/.test(s)))
      assert.match(step, /persist-credentials: false/, `${file}: checkout keeps its token`)
  }
})

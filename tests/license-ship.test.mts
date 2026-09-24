import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

// What ships out together with the program and how it is built on GitHub.
// Each check is about a thing that is easy to lose with an edit nearby and
// that nobody would notice until publication: a wheel and images without the
// MIT text, a PyPI page without a link to the source, a token in .git/config
// while someone else's install scripts run.
const read = (file: string) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')

test('the wheel and every image carry LICENSE and the third-party notices', () => {
  // scripts/pack.mts puts both files at the app root, that is, into the wheel.
  const pack = read('scripts/pack.mts')
  assert.match(pack, /\['LICENSE', 'THIRD_PARTY_NOTICES\.md'\]/)

  const dockerfile = read('Dockerfile')
  const base = dockerfile.split('AS app-base')[1]!.split('FROM app-base AS development')[0]!
  assert.match(base, /^COPY LICENSE THIRD_PARTY_NOTICES\.md \.\/$/m)
  const broker = dockerfile.split('AS broker')[1]!.split('FROM ')[0]!
  assert.match(broker, /^COPY LICENSE \.\/$/m)

  assert.match(read('deploy/vast/Dockerfile'), /^COPY LICENSE THIRD_PARTY_NOTICES\.md \.\/$/m)
  // .dockerignore must not cut them off: COPY would then fail, but only at
  // release time.
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
    // The checkout step: from `uses:` to the next step; the flag must be inside.
    const steps = text.split(/\n\s+- (?=uses:|name:|run:|id:)/)
    for (const step of steps.filter((s) => /uses: actions\/checkout@/.test(s)))
      assert.match(step, /persist-credentials: false/, `${file}: checkout keeps its token`)
  }
})

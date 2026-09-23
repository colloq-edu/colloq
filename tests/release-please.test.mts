/**
 * Выпуск через release-please: .github/workflows/release-please.yml, его конфиг
 * и то, как publish.yml и release.yml встают за ним.
 *
 * Workflow на GitHub отсюда не запустить, поэтому проверяется то, что можно
 * проверить локально и что ломается молча:
 *
 *   · токен — только личный RELEASE_PLEASE_TOKEN, без тихого отката на
 *     GITHUB_TOKEN: с ним PR выпуска был бы от бота и без CI;
 *   · публикация — ровно одним путём: запуск с тега из release-please.yml, без
 *     `push: tags` (тег от личного токена запустил бы его второй раз), и
 *     GitHub Release создаёт только release-please;
 *   · конфиг: тег vX.Y.Z без имени компонента, каждый путь extra-files
 *     существует и сейчас держит текущее число — сверено здесь отдельно от
 *     scripts/version.mts, другим способом;
 *   · проверка заголовка PR пропускает Conventional Commits (и PR выпуска) и
 *     не пропускает остальное — исполняется тот самый скрипт из workflow.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8')
const workflows = fs.readdirSync(path.join(repo, '.github/workflows')).filter((name) => name.endsWith('.yml'))

/** Текст задачи workflow: от «  <name>:» до следующей задачи того же отступа. */
function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `no job ${name}`)
  const rest = text.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

/** Блок `run: |` шага с именем `step` — без отступа, как его исполнит bash. */
function runBlock(text: string, step: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.includes(`- name: ${step}`))
  assert.notEqual(at, -1, `no step ${step}`)
  const run = lines.findIndex((line, i) => i > at && /^\s+run: \|\s*$/.test(line))
  const indent = lines[run + 1]!.match(/^\s*/)![0].length
  const body: string[] = []
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.match(/^\s*/)![0].length < indent) break
    body.push(line.slice(indent))
  }
  return body.join('\n')
}

test('release-please runs on main with the owner token, and fails rather than fall back', () => {
  const text = read('.github/workflows/release-please.yml')
  assert.match(text, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:/m)
  assert.match(text, /^permissions: \{\}$/m)
  const rp = job(text, 'release-please')

  // Закреплён по коммиту: action держит личный токен с записью в main.
  assert.match(rp, /uses: googleapis\/release-please-action@[0-9a-f]{40} # v4\.\d+\.\d+/)
  assert.match(rp, /token: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/)
  assert.doesNotMatch(rp, /token: \$\{\{ (github\.token|secrets\.GITHUB_TOKEN)/)
  assert.doesNotMatch(rp, /RELEASE_PLEASE_TOKEN \|\|/)
  // Проверка секрета — до action, и она падает на пустом.
  const guard = rp.indexOf('RELEASE_PLEASE_TOKEN is set')
  assert.ok(guard !== -1 && guard < rp.indexOf('googleapis/release-please-action'))
  const script = runBlock(rp, 'RELEASE_PLEASE_TOKEN is set')
  const empty = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH!, TOKEN: '' }, encoding: 'utf8' })
  assert.equal(empty.status, 1)
  assert.match(empty.stdout, /::error::Repository secret RELEASE_PLEASE_TOKEN is not set/)
  const set = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH!, TOKEN: 'github_pat_x' }, encoding: 'utf8' })
  assert.equal(set.status, 0)

  // Токен ходит только в API: ни checkout, ни npm рядом с ним.
  assert.doesNotMatch(rp, /actions\/checkout|npm (ci|install)/)
  assert.match(rp, /permissions: \{\}/)
  // В форке секрета нет — задачу там не запускаем вовсе.
  assert.match(rp, /if: \$\{\{ !github\.event\.repository\.fork \}\}/)
})

test('a release publishes exactly once: started from release-please on the tag, never a tag push', () => {
  const rp = read('.github/workflows/release-please.yml')
  const publish = job(rp, 'publish')
  assert.match(publish, /needs: release-please/)
  assert.match(publish, /if: needs\.release-please\.outputs\.release_created == 'true'/)
  // Запуск с тега, а не `uses:`: вызванный переиспользуемым, publish.yml нёс
  // workflow_ref = release-please.yml, и PyPI отказал v0.2.0 (invalid-publisher).
  assert.doesNotMatch(publish, /uses: \.\/\.github\/workflows\/publish\.yml/)
  assert.match(publish, /gh workflow run publish\.yml --ref "\$TAG" -f tag="\$TAG"/)
  assert.match(publish, /TAG: \$\{\{ needs\.release-please\.outputs\.tag_name \}\}/)
  // Личного токена рядом не держим: запускает GITHUB_TOKEN.
  assert.doesNotMatch(publish, /secrets\./)
  assert.match(job(rp, 'release-please'), /release_created: \$\{\{ steps\.release\.outputs\.release_created \}\}/)

  const text = read('.github/workflows/publish.yml')
  const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'))
  assert.doesNotMatch(on, /\n {2}push:/)
  assert.doesNotMatch(on, /\n {2}workflow_call:/)
  assert.match(on, /\n {2}workflow_dispatch:/)
  // Ни один workflow не заводит выпуск сам: заметки пишет release-please.
  for (const file of workflows) {
    assert.doesNotMatch(read(`.github/workflows/${file}`), /gh release create/, `${file} creates a release`)
  }
  // Every wheel at once, universal and platform, with the list of sums.
  const release = job(text, 'github-release')
  assert.match(release, /for file in out\/\*\.whl out\/python-SHA256SUMS; do/)
  assert.match(release, /gh release upload "\$TAG" "\$\{upload\[@\]\}"/)
  assert.doesNotMatch(release, /gh release upload[^\n]*--clobber/)
  assert.match(read('.github/workflows/release.yml'), /gh release upload "\$VERSION" release\.json/)
})

test('no workflow has a plain step name with ": " in it', () => {
  // YAML-парсера среди зависимостей нет, а текстовые проверки выше такой файл
  // пропускают: «- name: type(scope)!: subject» — уже не строка, а ошибка
  // разбора, и GitHub отвергает весь workflow. Так было с pr-title.yml.
  for (const file of workflows) {
    for (const line of read(`.github/workflows/${file}`).split('\n')) {
      const m = /^\s*(?:- )?name: (.*)$/.exec(line)
      if (!m || /^["']/.test(m[1]!)) continue
      assert.doesNotMatch(m[1]!.replace(/\s+#.*$/, ''), /: /, `${file}: ${line.trim()}`)
    }
  }
})

test('nothing points at the removed cut-release machinery', () => {
  for (const gone of ['.github/workflows/cut-release.yml', 'scripts/release-commit-check.sh', 'scripts/changelog-notes.mts']) {
    assert.equal(fs.existsSync(path.join(repo, gone)), false, `${gone} is back`)
  }
  const places = [
    ...workflows.map((file) => `.github/workflows/${file}`),
    'Makefile',
    'README.md',
    // Русский README тоже рассказывает про выпуски: переводу стареть здесь так
    // же нельзя, как оригиналу.
    'README.ru.md',
    'RELEASING.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'deploy/k3s/README.md',
    'scripts/release-build.py',
  ]
  for (const file of places) {
    const text = read(file)
    assert.doesNotMatch(text, /cut-release|Cut release|release-commit-check|changelog-notes|RELEASE_TOKEN\b/, file)
    assert.doesNotMatch(text, /version\.mts (bump|notes)|make bump PART/, file)
    assert.doesNotMatch(text, /## \[Unreleased\]/, file)
  }
})

test('the config tags vX.Y.Z and names every copy of the version at its current value', () => {
  const config = JSON.parse(read('release-please-config.json'))
  const manifest = JSON.parse(read('.release-please-manifest.json'))
  const version = JSON.parse(read('package.json')).version as string
  assert.deepEqual(manifest, { '.': version })
  assert.equal(config['release-type'], 'node')
  assert.equal(config['include-v-in-tag'], true)
  assert.equal(config['include-component-in-tag'], false)
  // До 1.0: feat и ломающая правка поднимают minor, fix — patch.
  assert.equal(config['bump-minor-pre-major'], true)
  assert.equal(config['bump-patch-for-minor-pre-major'], false)
  assert.deepEqual(Object.keys(config.packages), ['.'])
  // prerelease: true пометило бы предвыпуском и каждый 0.x (manifest.ts);
  // -rc.N помечает publish.yml.
  assert.equal(config.prerelease ?? config.packages['.'].prerelease, undefined)

  const extra = config.packages['.']['extra-files'] as Array<{ type: string; path: string; jsonpath?: string }>
  const lock = JSON.parse(read('package-lock.json'))
  const workspaces = JSON.parse(read('package.json')).workspaces as string[]
  const covered = new Set<string>()
  for (const entry of extra) {
    assert.ok(fs.existsSync(path.join(repo, entry.path)), `${entry.path} does not exist`)
    if (entry.type === 'json') {
      // Путь — только $.a.b.c: ровно то, что jsonpath-plus поймёт однозначно.
      assert.match(entry.jsonpath!, /^\$(\.[A-Za-z_]\w*)+$/, entry.jsonpath)
      let node: unknown = JSON.parse(read(entry.path))
      for (const key of entry.jsonpath!.slice(2).split('.')) node = (node as Record<string, unknown>)[key]
      assert.equal(node, version, `${entry.path} ${entry.jsonpath}`)
      covered.add(`${entry.path} ${entry.jsonpath}`)
    } else {
      assert.equal(entry.type, 'generic')
      const marked = read(entry.path).split('\n').filter((line) => line.includes('x-release-please-version'))
      assert.equal(marked.length, 1, `${entry.path}: one marked line`)
      assert.ok(marked[0]!.includes(`"${version}"`), marked[0])
      covered.add(entry.path)
    }
  }
  // Корень и packages[""] замка release-type node правит сам; воркспейсы — нет.
  for (const w of workspaces) {
    assert.ok(covered.has(`${w}/package.json $.version`), `${w}/package.json is not in extra-files`)
    assert.ok(lock.packages[w], `package-lock.json has no packages["${w}"]`)
    assert.ok(covered.has(`package-lock.json $.packages.${w}.version`), `package-lock.json packages["${w}"] is not in extra-files`)
  }
  assert.ok(covered.has('shared/package.json $.version'))
  assert.ok(covered.has('python/colloq/_version.py'))
})

test('release-as pins only the first release, and its reminder travels with it', () => {
  const root = JSON.parse(read('release-please-config.json')).packages['.']
  const version = JSON.parse(read('package.json')).version as string
  if (root['release-as'] === undefined) {
    // После первого выпуска строку убрали — вместе с напоминанием в шапке PR.
    assert.equal(root['pull-request-header'], undefined)
    return
  }
  // Пока стоит, она обязана вести вперёд: release-as, равный выпущенному
  // числу, открыл бы второй PR «release X».
  assert.match(root['release-as'], /^\d+\.\d+\.\d+$/)
  const [a, b] = [root['release-as'], version].map((v: string) => v.split('.').map(Number))
  const newer = a![0]! - b![0]! || a![1]! - b![1]! || a![2]! - b![2]!
  assert.ok(newer > 0 || root['release-as'] === version, `release-as ${root['release-as']} is behind ${version}`)
  assert.match(root['pull-request-header'], /delete `release-as` and this `pull-request-header`/)
  // Шапка не должна содержать разделитель заметок: release-please режет тело
  // PR по строке «---», и шапка с ним съела бы заметки выпуска.
  assert.doesNotMatch(root['pull-request-header'], /^---$/m)
})

test('the PR title check accepts Conventional Commits and the release PR, and nothing else', () => {
  const text = read('.github/workflows/pr-title.yml')
  const script = runBlock(text, 'The title is a Conventional Commit')
  const check = (title: string) =>
    spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH!, TITLE: title }, encoding: 'utf8' }).status
  for (const good of [
    'feat(council): show the queue to the teacher',
    'fix: keep the notebook where it was',
    'feat(cli)!: drop the vast command',
    'perf(server): compress the first sync frame',
    'revert: feat(web): tab reordering',
    'docs(deploy): k3s upgrade notes',
    'chore(main): release 0.2.0',
    'build(deps): bump yjs',
  ]) {
    assert.equal(check(good), 0, good)
  }
  for (const bad of [
    'Fix the queue',
    'feat:no space',
    'feature(council): x',
    'feat(Council): capital scope',
    'feat(): empty scope',
    'Revert "feat: x"',
    'fix(council) missing colon',
  ]) {
    assert.equal(check(bad), 1, bad)
  }
  // Типы проверки и разделы журнала — один список: тип, которого не знает
  // release-please, прошёл бы проверку и пропал бы из заметок.
  const types = /types='([^']+)'/.exec(script)![1]!.split('|').sort()
  const sections = (JSON.parse(read('release-please-config.json'))['changelog-sections'] as Array<{ type: string }>)
    .map((s) => s.type)
    .sort()
  assert.deepEqual(types, sections)
})

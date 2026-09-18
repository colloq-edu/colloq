/**
 * Версия проекта: одно число в корневом package.json и его копии.
 *
 * Здесь проверяется то, что ломается молча. Поднимает число release-please, и
 * копию, которой нет в его extra-files, он просто не тронет: PR выпуска уедет
 * с колесом одной версии и тегом другой, и заметно это станет на PyPI, где
 * ничего нельзя перезалить. Поэтому `version.mts check` проигрывает правку
 * release-please офлайн, и тесты ниже держат эту репетицию честной — теми же
 * правилами, что в исходниках release-please 17 (updaters/generic.ts,
 * generic-json.ts, node/package-lock-json.ts, changelog.ts). Последний тест тот
 * же, что `make version` и CI, — на настоящем дереве.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  changelogVersions,
  checkVersions,
  diskReader,
  isVersion,
  main,
  pythonVersionFile,
  simulateRelease,
  versionEdits,
} from '../scripts/version.mts'

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

const HEADER = `# Changelog

Written by release-please from Conventional Commits.

`

const CHANGELOG = `${HEADER}## [0.1.0](https://github.com/example/colloq/releases/tag/v0.1.0) (2026-09-13)

### Added

- Everything.
`

/** Конфиг release-please того же устройства, что настоящий, на два воркспейса. */
function rpConfig(extra?: unknown[]) {
  return {
    'release-type': 'node',
    'include-v-in-tag': true,
    'include-component-in-tag': false,
    packages: {
      '.': {
        'extra-files': extra ?? [
          { type: 'json', path: 'server/package.json', jsonpath: '$.version' },
          { type: 'json', path: 'cli/package.json', jsonpath: '$.version' },
          { type: 'json', path: 'shared/package.json', jsonpath: '$.version' },
          { type: 'json', path: 'package-lock.json', jsonpath: '$.packages.server.version' },
          { type: 'json', path: 'package-lock.json', jsonpath: '$.packages["cli"].version' },
          { type: 'generic', path: 'python/colloq/_version.py' },
        ],
      },
    },
  }
}

/** Дерево с теми же копиями, что у настоящего: корень, два воркспейса, замок, питон, журнал, release-please. */
function fixture(version = '0.1.0', changelog = CHANGELOG): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-version-'))
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  write('package.json', json({ name: 'colloq', private: true, version, workspaces: ['server', 'cli'] }))
  write('server/package.json', json({ name: '@colloq/server', private: true, version, type: 'module' }))
  write('cli/package.json', json({ name: '@colloq/cli', private: true, version }))
  write('shared/package.json', json({ name: '@colloq/shared', private: true, version, type: 'module' }))
  write(
    'package-lock.json',
    json({
      name: 'colloq',
      version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'colloq', version, workspaces: ['server', 'cli'] },
        cli: { name: '@colloq/cli', version },
        'node_modules/@colloq/cli': { resolved: 'cli', link: true },
        'node_modules/left-pad': { version: '1.3.0' },
        server: { name: '@colloq/server', version, dependencies: { 'left-pad': '^1.3.0' } },
      },
    }),
  )
  write('python/colloq/_version.py', pythonVersionFile(version))
  write('CHANGELOG.md', changelog)
  write('release-please-config.json', json(rpConfig()))
  write('.release-please-manifest.json', json({ '.': version }))
  return dir
}

function withFixture(fn: (dir: string) => void, version?: string, changelog?: string): void {
  const dir = fixture(version, changelog)
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function quietly<T>(fn: () => T): T {
  const log = console.log
  const error = console.error
  console.log = () => {}
  console.error = () => {}
  try {
    return fn()
  } finally {
    console.log = log
    console.error = error
  }
}

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf8')
const writeJson = (dir: string, file: string, value: unknown) => fs.writeFileSync(path.join(dir, file), json(value))

/*
 * Правка release-please Generic, переписанная отдельно от version.mts: строка
 * с x-release-please-version, первое число semver в ней меняется, остальное
 * нетронуто (release-please 17, src/updaters/generic.ts). Два независимых
 * списания одного правила — чтобы опечатка в одном не подтвердила сама себя.
 */
function releasePleaseGeneric(text: string, version: string): string {
  const semver = /(\d+)\.(\d+)\.(\d+)(-[\w.]+)?(\+[-\w.]+)?/
  return text
    .split(/\r?\n/)
    .map((line) => (/x-release-please-(version|major|minor|patch|date)/.test(line) ? line.replace(semver, version) : line))
    .join('\n')
}

test('only versions the wheel, the tag and the image can all carry are accepted', () => {
  for (const good of ['0.1.0', '10.20.30', '1.0.0-alpha.0', '1.0.0-beta.2', '1.0.0-rc.11']) {
    assert.ok(isVersion(good), good)
  }
  // PEP 440 не знает «next», у тега и образа нет «+», ведущий ноль — не semver.
  for (const bad of ['v1.0.0', '1.0', '01.0.0', '1.0.0-next.1', '1.0.0-rc', '1.0.0+sha', '1.0.0-rc.01']) {
    assert.equal(isVersion(bad), false, bad)
  }
})

test('the version file carries the release-please marker on its version line and nowhere else', () => {
  const text = pythonVersionFile('0.1.0')
  const marked = text.split('\n').filter((line) => line.includes('x-release-please'))
  // Строку с пометкой Generic правит целиком: пометка в шапке превратила бы в
  // «версию» первое число в комментарии.
  assert.deepEqual(marked, ['__version__ = "0.1.0"  # x-release-please-version'])
  // release-please меняет ровно число — и получается тот же шаблон: упаковка
  // (scripts/pack.mts) после PR выпуска дерево не пачкает.
  assert.equal(releasePleaseGeneric(text, '0.2.0'), pythonVersionFile('0.2.0'))
  assert.equal(releasePleaseGeneric(text, '1.0.0-rc.1'), pythonVersionFile('1.0.0-rc.1'))
  // hatchling читает __version__ своим шаблоном; хвостовой комментарий ему не мешает.
  const hatchling = /^(__version__|VERSION) *= *(['"])v?(?<version>.+?)\2/m
  assert.equal(hatchling.exec(text)?.groups?.version, '0.1.0')
})

test('check names every copy that disagrees, and a tag that does not match', () => {
  withFixture((dir) => {
    assert.deepEqual(checkVersions(dir), [])
    assert.deepEqual(checkVersions(dir, { tag: 'v0.1.0' }), [])
    assert.match(checkVersions(dir, { tag: 'v0.2.0' }).join('\n'), /tag v0\.2\.0 does not match/)
    assert.match(checkVersions(dir, { tag: '0.1.0' }).join('\n'), /expected v0\.1\.0/)

    writeJson(dir, 'cli/package.json', { name: '@colloq/cli', version: '0.0.9' })
    const lock = JSON.parse(read(dir, 'package-lock.json'))
    lock.packages.server.version = '0.0.8'
    writeJson(dir, 'package-lock.json', lock)
    fs.writeFileSync(path.join(dir, 'python/colloq/_version.py'), pythonVersionFile('0.0.7'))
    const problems = checkVersions(dir).join('\n')
    assert.match(problems, /cli\/package\.json says 0\.0\.9/)
    assert.match(problems, /package-lock\.json packages\["server"\] says 0\.0\.8/)
    assert.match(problems, /_version\.py says 0\.0\.7/)
  })
})

test('a version raised by hand, past release-please, is caught by its manifest', () => {
  withFixture((dir) => {
    // Все копии подняты «как надо», но мимо PR выпуска: манифест остался 0.1.0.
    const edits = versionEdits(diskReader(dir), '0.2.0')
    for (const [file, text] of edits) fs.writeFileSync(path.join(dir, file), text)
    writeJson(dir, 'package.json', { ...JSON.parse(read(dir, 'package.json')), version: '0.2.0' })
    const problems = checkVersions(dir).join('\n')
    assert.match(problems, /\.release-please-manifest\.json says 0\.1\.0, package\.json says 0\.2\.0/)
    assert.match(problems, /top section is 0\.1\.0, package\.json says 0\.2\.0/)
  })
})

test('the changelog: release-please headings count, the top one is the version, nothing sits above it', () => {
  const released = `${HEADER}## [0.2.0](https://github.com/example/colloq/compare/v0.1.0...v0.2.0) (2026-09-20)

### Features

* **council:** something ([abc1234](https://github.com/example/colloq/commit/abc1234))

## 0.1.1 (2026-09-15)

### Bug Fixes

* a fix

### [0.1.0](https://example) (2026-09-13)

## [0.0.9] - 2026-09-01
`
  assert.deepEqual(changelogVersions(released), ['0.2.0', '0.1.1', '0.1.0', '0.0.9'])
  withFixture((dir) => assert.deepEqual(checkVersions(dir), []), '0.2.0', released)

  // Рукописный «Unreleased» над выпусками перехватил бы вставку release-please.
  const unreleased = CHANGELOG.replace('## [0.1.0]', '## [Unreleased]\n\n- Pending.\n\n## [0.1.0]')
  withFixture((dir) => {
    const problems = checkVersions(dir).join('\n')
    assert.match(problems, /"## \[Unreleased\]" would take release-please's next section/)
  }, '0.1.0', unreleased)

  // Второй раздел того же числа — второй PR «release 0.2.0» после выпуска
  // 0.2.0 (release-as забыли убрать): CI должен уронить его до слияния.
  const twice = released.replace('## 0.1.1 (2026-09-15)', '## [0.2.0](https://x) (2026-09-21)')
  withFixture((dir) => assert.match(checkVersions(dir).join('\n'), /two sections for 0\.2\.0/), '0.2.0', twice)

  withFixture((dir) => assert.match(checkVersions(dir).join('\n'), /top section is 0\.1\.0, package\.json says 0\.3\.0/), '0.3.0')
})

test('the release-please rehearsal moves every copy, and only version lines', () => {
  withFixture((dir) => {
    const { files, problems } = simulateRelease(diskReader(dir), '0.2.0')
    assert.deepEqual(problems, [])
    assert.deepEqual([...files.keys()].sort(), [
      '.release-please-manifest.json',
      'CHANGELOG.md',
      'cli/package.json',
      'package-lock.json',
      'package.json',
      'python/colloq/_version.py',
      'server/package.json',
      'shared/package.json',
    ])
    // Замок: версии корня и воркспейсов — да, чужие пакеты — нет; меняются
    // ровно строки с версией.
    const before = read(dir, 'package-lock.json').split('\n')
    const after = files.get('package-lock.json')!.split('\n')
    assert.equal(before.length, after.length)
    const changed = before.filter((line, i) => line !== after[i])
    assert.equal(changed.length, 4)
    assert.ok(changed.every((line) => /"version": "0\.1\.0"/.test(line)))
    assert.equal(JSON.parse(files.get('package-lock.json')!).packages['node_modules/left-pad'].version, '1.3.0')
    assert.equal(files.get('python/colloq/_version.py'), pythonVersionFile('0.2.0'))
    // Раздел нового выпуска — наверху, под шапкой; прежний журнал цел.
    const changelog = files.get('CHANGELOG.md')!
    assert.deepEqual(changelogVersions(changelog), ['0.2.0', '0.1.0'])
    assert.ok(changelog.startsWith(HEADER))
    assert.match(changelog, /- Everything\.\n$/)

    // Итог репетиции проходит ту же сверку, что PR выпуска в CI.
    for (const [file, text] of files) fs.writeFileSync(path.join(dir, file), text)
    assert.deepEqual(checkVersions(dir, { tag: 'v0.2.0' }), [])
  })
})

test('a copy release-please would not touch fails the check, whatever the reason', () => {
  // Новый воркспейс без строки в extra-files.
  withFixture((dir) => {
    const config = rpConfig()
    config.packages['.']['extra-files'] = config.packages['.']['extra-files'].filter(
      (entry) => (entry as { path: string }).path !== 'cli/package.json',
    )
    writeJson(dir, 'release-please-config.json', config)
    assert.match(
      checkVersions(dir).join('\n'),
      /release-please would leave cli\/package\.json at 0\.1\.0: add it to extra-files/,
    )
  })
  // Опечатка в пути, путь к полю, которого нет, и файл версии без пометки —
  // release-please все три пропускает молча.
  withFixture((dir) => {
    writeJson(
      dir,
      'release-please-config.json',
      rpConfig([
        { type: 'json', path: 'server/pakage.json', jsonpath: '$.version' },
        { type: 'json', path: 'package-lock.json', jsonpath: '$.packages.srever.version' },
        { type: 'generic', path: 'python/colloq/_version.py' },
      ]),
    )
    fs.writeFileSync(path.join(dir, 'python/colloq/_version.py'), '__version__ = "0.1.0"\n')
    const problems = checkVersions(dir).join('\n')
    assert.match(problems, /server\/pakage\.json does not exist/)
    assert.match(problems, /\$\.packages\.srever\.version: no version string there/)
    assert.match(problems, /no line marked x-release-please-version in python\/colloq\/_version\.py/)
  })
  // release-type не node — корень замка и package.json никто не поднимет.
  withFixture((dir) => {
    writeJson(dir, 'release-please-config.json', { ...rpConfig(), 'release-type': 'simple' })
    assert.match(checkVersions(dir).join('\n'), /release-type must be "node"/)
  })
})

test('sync repairs copies without a new number; it refuses to reformat a hand-formatted file', () => {
  withFixture((dir) => {
    writeJson(dir, 'server/package.json', { name: '@colloq/server', private: true, version: '0.0.1', type: 'module' })
    assert.match(checkVersions(dir).join('\n'), /server\/package\.json says 0\.0\.1/)
    const before = read(dir, 'server/package.json')
    assert.equal(quietly(() => main(['sync', '--dry-run'], dir)), 0)
    assert.equal(read(dir, 'server/package.json'), before)
    assert.equal(quietly(() => main(['sync'], dir)), 0)
    assert.deepEqual(checkVersions(dir), [])
    assert.equal(read(dir, '.release-please-manifest.json'), json({ '.': '0.1.0' }))

    fs.writeFileSync(path.join(dir, 'cli/package.json'), '{"name":"@colloq/cli","version":"0.1.0"}\n')
    assert.throws(() => versionEdits(diskReader(dir), '0.2.0'), /cli\/package\.json is not in npm's canonical JSON/)
  })
})

test('the command line: check fails loudly, the old bump is gone', () => {
  withFixture((dir) => {
    assert.equal(quietly(() => main(['check'], dir)), 0)
    assert.equal(quietly(() => main(['current'], dir)), 0)
    writeJson(dir, '.release-please-manifest.json', { '.': '0.0.1' })
    assert.equal(quietly(() => main(['check'], dir)), 1)
    // Числа поднимает только PR выпуска release-please.
    assert.equal(quietly(() => main(['bump', 'minor'], dir)), 2)
    assert.equal(quietly(() => main(['notes', '0.1.0'], dir)), 2)
  })
})

test('this checkout: every copy agrees, release-please would move them all, and nothing hard-codes it', async () => {
  assert.deepEqual(checkVersions(repo), [])
  const version = JSON.parse(read(repo, 'package.json')).version as string
  // Упаковка пишет _version.py той же функцией — значит, `make pack` не пачкает дерево.
  assert.equal(read(repo, 'python/colloq/_version.py'), pythonVersionFile(version))
  assert.match(read(repo, 'scripts/pack.mts'), /writeFileSync\([^\n]*_version\.py'\), pythonVersionFile\(version\)\)/)
  const { COLLOQ_VERSION } = await import('../server/src/version.ts')
  assert.equal(COLLOQ_VERSION, version)
  // Панель берёт число из сборки (vite define), а не из строки в разметке.
  const shell = read(repo, 'web/src/admin/AdminShell.svelte')
  assert.doesNotMatch(shell, /<Wordmark[^>]*version="v?\d/)
  assert.match(shell, /__COLLOQ_VERSION__/)
  assert.match(read(repo, 'web/vite.config.ts'), /__COLLOQ_VERSION__: JSON\.stringify\(COLLOQ_VERSION\)/)
})

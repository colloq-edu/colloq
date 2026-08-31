/**
 * Environments: the packages a seminar's Python has.
 *
 * One environment is one file in `kernel/environments/`, installed on top of
 * the base every kernel carries, and built into the image `colloq-kernel:<name>`.
 * The panel and the `make env-*` targets are two faces of the same directory
 * and the same `KERNEL_ENV` line, which is why the parsing rules live in one
 * place and are pinned here.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listChanged, parsePackages } from '../server/src/environments.js'
import { ENVIRONMENT_NAME } from '../shared/admin.js'

/* ------------------------------------------------ what counts as a package */

test('a package per line, as a person would count them', () => {
  assert.deepEqual(parsePackages('torch>=2.4\ntimm>=1.0\n'), ['torch>=2.4', 'timm>=1.0'])
})

test('comments and blank lines are not packages', () => {
  const source = '# computer vision\n\ntorch>=2.4\n\n#  another note\ntimm>=1.0\n'
  assert.deepEqual(parsePackages(source), ['torch>=2.4', 'timm>=1.0'])
})

test('a pip directive is not a package', () => {
  // Counting these told a room "6 packages" for a file that listed five, which
  // is the sort of small lie that makes the rest of a number untrustworthy.
  const source = '--extra-index-url https://download.pytorch.org/whl/cpu\ntorch>=2.4\n'
  assert.deepEqual(parsePackages(source), ['torch>=2.4'])
})

test('surrounding whitespace does not make two packages out of one', () => {
  assert.deepEqual(parsePackages('  torch>=2.4  \n\t timm \n'), ['torch>=2.4', 'timm'])
})

test('an empty file asks for nothing, and says so without crashing', () => {
  assert.deepEqual(parsePackages(''), [])
  assert.deepEqual(parsePackages('\n\n#только комментарий\n'), [])
})

test('a package with a marker or an extra survives whole', () => {
  const source = "uvicorn[standard]>=0.30\nnumpy>=1.26; python_version < '3.13'\n"
  assert.deepEqual(parsePackages(source), [
    'uvicorn[standard]>=0.30',
    "numpy>=1.26; python_version < '3.13'",
  ])
})

/* ------------------------------------------------------------ the name */

test('a name is what a filename and a Docker tag can both be', () => {
  for (const ok of ['base', 'cv', 'cv-torch-2', 'a', 'nlp-hf']) {
    assert.ok(ENVIRONMENT_NAME.test(ok), ok)
  }
})

test('a name that would escape the directory or break a tag is refused', () => {
  // It becomes a path and an image tag, so this is not cosmetic.
  for (const bad of ['../etc', 'CV', 'cv torch', 'cv.torch', '-cv', 'cv-', '', 'cv/../x', 'cv:latest']) {
    assert.ok(!ENVIRONMENT_NAME.test(bad), bad)
  }
})

test('a name is short enough to read in a table row', () => {
  assert.ok(ENVIRONMENT_NAME.test('a'.repeat(32)))
  assert.ok(!ENVIRONMENT_NAME.test('a'.repeat(33)))
})

/* ------------------------------------------- собрана ли она на самом деле */

/*
 * «Собрана или нет» решалось сравнением времени правки файла со временем
 * сборки образа — то есть отвечало на другой вопрос: не изменился ли список, а
 * трогали ли файл. Открыть список и сохранить не меняя, или просто иметь файл
 * новее образа, собранного через docker compose, — этого хватало, чтобы на
 * рабочей среде повисло «Needs rebuild» рядом с «216 MB · built 5 days ago».
 */
test('сохранение без изменений — не изменение', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'torch>=2.4\ntimm>=1.0\n'), false)
})

test('комментарий и пустая строка не меняют того, что поставит pip', () => {
  assert.equal(
    listChanged('torch>=2.4\ntimm>=1.0\n', '# зрение\n\ntorch>=2.4\n\ntimm>=1.0\n'),
    false,
  )
})

test('тот же список в другом порядке — тот же список', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'timm>=1.0\ntorch>=2.4\n'), false)
})

test('новый пакет — изменение', () => {
  assert.equal(listChanged('torch>=2.4\n', 'torch>=2.4\nnumpy\n'), true)
})

test('другая версия того же пакета — изменение', () => {
  assert.equal(listChanged('torch>=2.4\n', 'torch>=2.5\n'), true)
})

test('убранный пакет — изменение', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'torch>=2.4\n'), true)
})

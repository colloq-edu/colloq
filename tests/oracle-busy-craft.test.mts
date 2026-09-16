/**
 * «Оракул взял эту ячейку» — признак, который держится на трёх стыках.
 *
 * Проверка по исходнику, а не по поведению, и это тот же выбор, что у
 * sanitize.test.mts: чтобы увидеть бегущую полосу, нужен браузер, которого в
 * этой сюите нет. А каждый из трёх стыков — это одна строка в одном месте, и
 * потеря любой из них гасит признак МОЛЧА: кнопку нажали, оракул работает, а
 * на ячейке по-прежнему ничего.
 *
 * Стык первый — наблюдатель. Реестр ленты будит ячейки только на перечисленные
 * ключи, и `state` попал в этот список ровно ради занятости: без него смена
 * `streaming` → `done` проходит мимо, и признак не гаснет НИКОГДА.
 *
 * Стык второй — старшинство. Ядро и оракул могут взяться за одну ячейку, и
 * слот в поле номера достаётся ядру: оно ячейку меняет, а оракул пока только
 * читает, и путать их в одном знаке нельзя.
 *
 * Стык третий — само мерцание. Оно живёт на ДВУХ путях внутри значка, и держит
 * его связка «класс на обёртке + nth-of-type». Поменяют форму значка — и
 * мерцание тихо исчезнет, а признак останется неподвижной звёздочкой, которую
 * не отличить от простой пометки.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

test('реестр ленты будит ячейки на смену состояния хода', () => {
  const source = read('web/src/lib/yreactive.svelte.ts')
  const keys = /const PATCH_KEYS = \[([^\]]*)\]/.exec(source)
  assert.ok(keys, 'список ключей, на которые смотрит реестр, исчез')
  assert.match(keys[1], /'state'/, 'без state признак занятости не погаснет никогда')
  assert.match(keys[1], /'cellIds'/, 'агент берёт несколько ячеек одним ходом')
  /*
   * На ЛЕНТУ — один наблюдатель на документ, и занятость считается тем же
   * проходом, что и предложения. Второй наблюдатель по ленте означал бы второй
   * обход на каждое событие — ровно та цена, ради которой реестр и заведён
   * (в файле есть и другие observeDeep: у метаданных, у выводов — они про
   * другое).
   */
  assert.equal((source.match(/#chat\.observeDeep/g) ?? []).length, 1)
})

test('занятым считается ход, который ещё идёт, и обе формы адреса', () => {
  const source = read('web/src/lib/yreactive.svelte.ts')
  const working = source.slice(source.indexOf('#working()'), source.indexOf('busy(id: string)'))
  assert.match(working, /'streaming'/, 'занятость считается не по состоянию хода')
  assert.match(working, /cellId/)
  assert.match(working, /cellIds/)
})

test('звёздочка стоит в поле номера и уступает выполнению', () => {
  /*
   * Слот тот же, где стоит метка выполнения: это «что сейчас с этой ячейкой
   * делают». Заняли оба — слот остаётся за `[*]`: ядро ячейку МЕНЯЕТ, оракул
   * пока только читает. Про оракула в этом случае говорит строка под ячейкой.
   */
  const cell = read('web/src/components/notebook/CellView.svelte')
  const at = cell.indexOf('{#if oracleBusy && !shownRunning}')
  assert.notEqual(at, -1, 'звёздочка больше не уступает выполнению')
  const slot = cell.slice(at, cell.indexOf('{/if}', at))
  assert.match(slot, /name="sparkles"/, 'знак оракула сменился — его узнают по нему')
  assert.match(slot, /cell-sparkle/, 'без класса мерцание не за что зацепить')
  assert.match(slot, /\{:else if mark\}/, 'метка выполнения должна возвращаться после хода')
})

test('слово под ячейкой — не только движение', () => {
  // Движение у кромки означает «что-то происходит»; кто именно занят, говорит
  // слово. Ради него всё и заведено: панель оракула бывает свёрнута.
  const cell = read('web/src/components/notebook/CellView.svelte')
  assert.match(cell, /\{#if oracleBusy\}[\s\S]{0,600}room\.oracle\.working/)
})

test('мерцают обе половины значка, и в противофазе', () => {
  const css = read('web/src/index.css')
  assert.match(css, /\.cell-sparkle path:nth-of-type\(1\)/)
  assert.match(css, /\.cell-sparkle path:nth-of-type\(2\)/)
  // Противофаза и есть мерцание: в один и тот же миг одна половина ярче другой.
  const big = /@keyframes cell-sparkle-big \{([\s\S]*?)\}\s*\}/.exec(css)
  const small = /@keyframes cell-sparkle-small \{([\s\S]*?)\}\s*\}/.exec(css)
  assert.ok(big && small, 'кадры мерцания исчезли')
  assert.notEqual(big[1].trim(), small[1].trim(), 'обе половины мерцают одинаково — это не мерцание')

  /*
   * Меняется ТОЛЬКО прозрачность, и поэтому у мерцания нет тихого близнеца:
   * по политике из шапки index.css такие указатели при `prefers-reduced-motion`
   * остаются как есть — остановленный указатель это ложь о системе.
   */
  for (const frames of [big[1], small[1]]) {
    assert.doesNotMatch(frames, /transform|translate|scale/, 'мерцание начало двигать значок')
  }
  const quiet = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'), css.indexOf('@media (prefers-color-scheme: dark)'))
  assert.doesNotMatch(quiet, /cell-sparkle/, 'мерцание не должно отниматься: оно ничего не двигает')

  // И значок обязан остаться двухчастным: мерцание держится на nth-of-type.
  const icon = read('web/src/components/ui/Icon.svelte')
  const sparkles = /sparkles:\s*\n?\s*'([^']*)'/.exec(icon)
  assert.ok(sparkles, 'знак оракула пропал из набора')
  assert.equal((sparkles[1].match(/<path/g) ?? []).length, 2, 'у знака стало не две половины — мерцать нечем')
})

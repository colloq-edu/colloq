/**
 * «арендовать?» принимает не только да/нет, но и номер предложения.
 *
 * Скрипт выбирал самое дешёвое сам и спрашивал [y/N]: взять соседнее — карту
 * новее, машину ближе — было нечем, кроме как ослаблять фильтры и надеяться.
 * Теперь на вопрос можно ответить номером из списка (или назвать его заранее,
 * OFFER=…). Номер сверяется со списком ПОДХОДЯЩИХ: арендовать то, что не
 * прошло предел цены и отсев по драйверу, по-прежнему нельзя.
 *
 * Проверка — настоящим bash: кусок скрипта от выбора до «3/… арендую» вынут
 * как есть и запущен с подставными `say`/`die`/`py`. Оба скрипта (релизный и
 * прежний) несут один и тот же кусок — оба и проверяются.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const OFFERS = ['50555691\t0.348\t1 x RTX 4080S', '49411540\t0.364\t1 x RTX 3090', '48626543\t0.429\t1 x RTX 4090']

function harness(script: string): string {
  const text = readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8')
  const from = text.indexOf('    local offer_id price what\n')
  const to = text.indexOf('    say "${BOLD}3/$STEPS${OFF} арендую"')
  assert.ok(from > 0 && to > from, `${script}: не нашёл кусок выбора предложения`)
  // Терминала у теста нет — проверку «вижу ли терминал» снимаем, остальное как есть.
  const block = text.slice(from, to).replace(/\[ -t 0 \] \|\| die[^\n]*\n/, ':\n')
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    "BOLD=''; OFF=''; DIM=''",
    'say() { :; }',
    'die() { printf "DIE %s\\n" "$1"; exit 1; }',
    'py() { echo 0.70; }',
    `suitable=$'${OFFERS.join('\\n')}'`,
    'run() {',
    '  local pick',
    block,
    '  printf "\\nRESULT %s %s\\n" "$offer_id" "$price"',
    '}',
    'run',
  ].join('\n')
}

function answer(script: string, input: string, env: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'colloq-vast-'))
  const file = path.join(dir, 'harness.sh')
  writeFileSync(file, harness(script))
  const run = spawnSync('bash', [file], { input: input + '\n', encoding: 'utf8', env: { ...process.env, ...env } })
  const line = /(RESULT|DIE) [^\n]*/.exec(run.stdout)?.[0] ?? ''
  return line
}

for (const script of ['vast.sh', 'vast-legacy.sh']) {
  test(`${script}: «да» берёт самое дешёвое, как и раньше`, () => {
    assert.equal(answer(script, 'y'), 'RESULT 50555691 0.348')
    assert.equal(answer(script, 'да'), 'RESULT 50555691 0.348')
  })

  test(`${script}: номер из списка берёт именно его — без второго вопроса`, () => {
    assert.equal(answer(script, '49411540'), 'RESULT 49411540 0.364')
  })

  test(`${script}: чужой номер, «нет», пустой ответ и мусор — отказ, а не аренда`, () => {
    assert.match(answer(script, '123'), /^DIE предложения 123 нет среди подходящих/)
    assert.match(answer(script, 'n'), /^DIE не арендую/)
    assert.match(answer(script, ''), /^DIE не арендую/)
    assert.match(answer(script, '4941x'), /^DIE не арендую/)
  })

  test(`${script}: OFFER=… называет предложение заранее, и с FORCE=1 вопроса нет`, () => {
    assert.equal(answer(script, '', { OFFER: '48626543', FORCE: '1' }), 'RESULT 48626543 0.429')
    assert.match(answer(script, '', { OFFER: '999', FORCE: '1' }), /^DIE предложения 999 нет среди подходящих/)
  })
}

test('make vast-up передаёт OFFER скрипту', () => {
  const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8')
  assert.match(makefile, /OFFER="\$\(OFFER\)" \.\/scripts\/\$\(VAST_SCRIPT\) up/)
})

/**
 * "Rent?" accepts not only yes/no but also an offer number.
 *
 * The script picked the cheapest one itself and asked [y/N]: there was no way
 * to take a neighbouring one — a newer card, a closer machine — other than
 * loosening the filters and hoping. Now the question can be answered with a
 * number from the list (or it can be named in advance, OFFER=…). The number
 * is checked against the list of SUITABLE offers: renting something that did
 * not pass the price limit and the driver filter is still impossible.
 *
 * The check runs in real bash: the piece of the script from the choice up to
 * step "3/…" (renting) is cut out as is and run with stub `say`/`die`/`py`.
 * Both scripts (the release one and the old one) carry the same piece — both
 * are checked.
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
  const to = text.indexOf('    say "${BOLD}3/$STEPS${OFF} renting"')
  assert.ok(from > 0 && to > from, `${script}: did not find the offer-choice piece`)
  // The test has no terminal — the "do I see a terminal" check is removed,
  // the rest is kept as is.
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
  test(`${script}: "yes" takes the cheapest one, as before`, () => {
    assert.equal(answer(script, 'y'), 'RESULT 50555691 0.348')
    assert.equal(answer(script, 'да'), 'RESULT 50555691 0.348')
  })

  test(`${script}: a number from the list takes exactly that one — without a second question`, () => {
    assert.equal(answer(script, '49411540'), 'RESULT 49411540 0.364')
  })

  test(`${script}: a foreign number, "no", an empty answer and garbage are a refusal, not a rental`, () => {
    assert.match(answer(script, '123'), /^DIE offer 123 is not among the suitable ones/)
    assert.match(answer(script, 'n'), /^DIE not renting/)
    assert.match(answer(script, ''), /^DIE not renting/)
    assert.match(answer(script, '4941x'), /^DIE not renting/)
  })

  test(`${script}: OFFER=… names the offer in advance, and with FORCE=1 there is no question`, () => {
    assert.equal(answer(script, '', { OFFER: '48626543', FORCE: '1' }), 'RESULT 48626543 0.429')
    assert.match(answer(script, '', { OFFER: '999', FORCE: '1' }), /^DIE offer 999 is not among the suitable ones/)
  })
}

test('make vast-up passes OFFER to the script', () => {
  const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8')
  assert.match(makefile, /OFFER="\$\(OFFER\)" \.\/scripts\/\$\(VAST_SCRIPT\) up/)
})

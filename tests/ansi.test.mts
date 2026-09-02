/**
 * Folding the kernel's colours into the palette we can actually theme.
 *
 * IPython paints tracebacks with xterm-256 codes. ansi_up turns only the basic
 * sixteen into classes; a 256 colour survives as an inline `color:` that no
 * stylesheet can reach, and those measured 4.01:1 on the dark ground — a word
 * of a traceback, at the moment a traceback is being read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ansi256ToBasic, foldAnsiColours, pendingEscape } from '../web/src/lib/ansi.js'

const ESC = '\u001b'

test('the basic sixteen are already themselves', () => {
  for (let i = 0; i < 16; i++) assert.equal(ansi256ToBasic(i), i)
})

test('cube colours fold to the hue they plainly are', () => {
  // 196 is pure red, 46 pure green, 21 pure blue, 226 yellow, 51 cyan, 201 magenta.
  const hue = (code: number) => ansi256ToBasic(code) % 8
  assert.equal(hue(196), 1, 'red')
  assert.equal(hue(46), 2, 'green')
  assert.equal(hue(21), 4, 'blue')
  assert.equal(hue(226), 3, 'yellow')
  assert.equal(hue(51), 6, 'cyan')
  assert.equal(hue(201), 5, 'magenta')
  // 28 is the dark green IPython actually uses, and it must stay green.
  assert.equal(hue(28), 2, 'IPython green')
})

test('the greyscale ramp becomes black or white, never a colour', () => {
  for (let code = 232; code < 256; code++) {
    const basic = ansi256ToBasic(code)
    assert.ok([0, 7, 8, 15].includes(basic), `${code} -> ${basic}`)
  }
  assert.equal(ansi256ToBasic(232) % 8, 0, 'the darkest grey is black')
  assert.equal(ansi256ToBasic(255) % 8, 7, 'the lightest grey is white')
})

test('every one of the 256 folds to something in range', () => {
  for (let code = 0; code < 256; code++) {
    const basic = ansi256ToBasic(code)
    assert.ok(Number.isInteger(basic) && basic >= 0 && basic < 16, `${code} -> ${basic}`)
  }
})

test('a 256-colour foreground is rewritten to a basic one', () => {
  const folded = foldAnsiColours(`${ESC}[38;5;28mimport${ESC}[0m`)
  assert.ok(!folded.includes('38;5;'), folded)
  // 28 is green, so it must land on the green foreground, 32 or its bright 92.
  assert.match(folded, /\u001b\[(32|92)m/)
  assert.ok(folded.includes('import'))
})

test('a 256-colour background is rewritten too', () => {
  const folded = foldAnsiColours(`${ESC}[48;5;196mDANGER${ESC}[0m`)
  assert.ok(!folded.includes('48;5;'), folded)
  assert.match(folded, /\u001b\[(41|101)m/)
})

test('truecolor is folded as well', () => {
  const folded = foldAnsiColours(`${ESC}[38;2;255;0;0mred${ESC}[0m`)
  assert.ok(!folded.includes('38;2;'), folded)
  assert.match(folded, /\u001b\[(31|91)m/)
})

test('the ordinary escapes are left exactly as they were', () => {
  for (const raw of [
    `${ESC}[0m`,
    `${ESC}[1;31mbold red${ESC}[0m`,
    `${ESC}[32mgreen${ESC}[39m`,
    'no escapes at all',
    `${ESC}[Kclear to end of line`,
  ]) {
    assert.equal(foldAnsiColours(raw), raw, JSON.stringify(raw))
  }
})

test('a mixed sequence keeps its other parameters', () => {
  // Bold, then a 256 colour, then underline: only the middle should change.
  const folded = foldAnsiColours(`${ESC}[1;38;5;196;4mx${ESC}[0m`)
  const params = /\u001b\[([0-9;]*)m/.exec(folded)?.[1].split(';')
  assert.ok(params?.includes('1'), 'bold was dropped')
  assert.ok(params?.includes('4'), 'underline was dropped')
  assert.ok(!folded.includes('38;5;'), folded)
})

test('malformed input is returned rather than mangled', () => {
  for (const raw of [`${ESC}[38;5m`, `${ESC}[38;2;1m`, `${ESC}[m`, `${ESC}[;;m`]) {
    assert.doesNotThrow(() => foldAnsiColours(raw))
  }
})

/*
 * Хвост растущего вывода дорисовывается отдельно (см. `ansi` в
 * render.svelte.ts), и вся его безопасность держится на одном: не разрезать
 * escape-последовательность пополам. Половина кода уехала бы в разбор как
 * мусор, а вторая покрасила бы остаток лога наугад.
 */
test('a finished buffer may be cut anywhere', () => {
  for (const text of [
    '',
    'plain text',
    `${ESC}[31mred${ESC}[0m`,
    `${ESC}[31mred${ESC}[0m and more text after it`,
    `${ESC}]8;;http://example.com${ESC}\\link`,
    'a line ending in a newline\n',
  ]) {
    assert.equal(pendingEscape(text), 0, JSON.stringify(text))
  }
})

test('an escape the flush cut in half is left for the next one', () => {
  const started = `${ESC}[38;5;1`
  assert.equal(pendingEscape(`green text${started}`), started.length)
  assert.equal(pendingEscape(`${ESC}[31mred${ESC}`), 1, 'a lone escape byte')
  // Незакрытый OSC: терминатор ещё не приехал.
  const osc = `${ESC}]8;;http://example.com`
  assert.equal(pendingEscape(osc), osc.length)
})

test('cutting at the pending escape leaves the visible text whole', () => {
  const text = `${ESC}[31mred${ESC}[38;5;2`
  const body = text.slice(0, text.length - pendingEscape(text))
  assert.equal(body, `${ESC}[31mred`)
  // Хвост дописывается следующим флешем и складывается обратно без потерь.
  assert.equal(body + text.slice(body.length) + '8mgreen', `${text}8mgreen`)
})

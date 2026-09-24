/**
 * The CLI speaks English, and explains itself in English.
 *
 * A string is the SCREEN: it is read by a person who ran `pip install colloq`
 * anywhere in the world. A comment is the REASON: it is read by whoever edits
 * the neighbouring line a year from now. The comments used to be Russian; since
 * the code went public (24 Sep 2026) they are English too, like the rest of the
 * repository's code.
 *
 * Nothing but this check holds that: neither types nor the build. Let someone
 * add a refusal in their native language, and half of the teachers will see a
 * Russian phrase in the middle of an English screen. We catch it here, not in
 * class.
 *
 * Comments are cut out of the code without a regex. A regex trips over the
 * most ordinary things: `'https://colloq.ru'` inside a string looks like the
 * start of a comment, and `'/*'` in text like the start of a block comment.
 * Hence the small character-by-character scanner below, which knows three
 * states (code, string, comment) and therefore gets neither case wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const CYRILLIC = /[А-Яа-яЁё]/

/** Every string literal in a file: three kinds of quotes, comments skipped. */
function literals(source: string): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = []
  let line = 1
  for (let at = 0; at < source.length; at++) {
    const ch = source[at]
    if (ch === '\n') {
      line++
      continue
    }
    if (ch === '/' && source[at + 1] === '/') {
      while (at < source.length && source[at] !== '\n') at++
      at--
      continue
    }
    if (ch === '/' && source[at + 1] === '*') {
      at += 2
      while (at < source.length && !(source[at] === '*' && source[at + 1] === '/')) {
        if (source[at] === '\n') line++
        at++
      }
      at++
      continue
    }
    if (ch !== "'" && ch !== '"' && ch !== '`') continue
    const quote = ch
    const at0 = at
    const line0 = line
    at++
    for (; at < source.length; at++) {
      if (source[at] === '\\') {
        at++
        continue
      }
      if (source[at] === '\n') {
        line++
        // An unclosed single or double quote is not a literal but, say, an
        // apostrophe inside a comment we would already have skipped. A
        // template literal may legally span lines, so it continues.
        if (quote !== '`') break
        continue
      }
      if (source[at] === quote) break
    }
    found.push({ text: source.slice(at0, at + 1), line: line0 })
  }
  return found
}

function cliSources(): { name: string; source: string }[] {
  const dir = new URL('../cli/src/', import.meta.url)
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, source: readFileSync(new URL(name, dir), 'utf8') }))
}

test('CLI strings are English', () => {
  const guilty: string[] = []
  for (const { name, source } of cliSources())
    for (const { text, line } of literals(source))
      if (CYRILLIC.test(text)) guilty.push(`cli/src/${name}:${line}  ${text.slice(0, 80)}`)
  assert.deepEqual(
    guilty,
    [],
    'a Russian string on an English screen:\n' +
      guilty.join('\n') +
      '\n\nThe screen is in English.',
  )
})

test('CLI comments are English too', () => {
  const guilty: string[] = []
  for (const { name, source } of cliSources())
    for (const [at, line] of source.split('\n').entries())
      if (CYRILLIC.test(line)) guilty.push(`cli/src/${name}:${at + 1}  ${line.trim().slice(0, 80)}`)
  assert.deepEqual(guilty, [], 'Russian in the CLI source:\n' + guilty.join('\n'))
})

/**
 * The check does not take its own word for it: the scanner is tested on
 * samples where a regex goes wrong. Otherwise one day it would quietly stop
 * finding anything at all, and the test would turn green forever while
 * checking nothing.
 */
test('the scanner tells a string from a comment, including the tricky shapes', () => {
  const sample = [
    `const url = 'https://colloq.ru/// не комментарий'`,
    `// зато это комментарий: 'русская строка внутри него не в счёт'`,
    `/* и это тоже: "и здесь" */ const ok = "English"`,
    'const tpl = `и это строка`',
    `const apostrophe = "don't"`,
  ].join('\n')
  const texts = literals(sample).map((item) => item.text)
  assert.deepEqual(texts, [
    `'https://colloq.ru/// не комментарий'`,
    `"English"`,
    '`и это строка`',
    `"don't"`,
  ])
  assert.equal(literals(sample).filter((item) => CYRILLIC.test(item.text)).length, 2)
})

/**
 * "Seminar" is gone from the product in both alphabets.
 *
 * The Russian word was removed earlier: a class is called "занятие". The
 * English "seminar" would bring back the same confusion from the other side:
 * Classes in the panel, seminars in the CLI. We catch both, in example names
 * too: `colloq tunnel setup seminar.example.ru` is the same vocabulary, just
 * in an address.
 */
test('the CLI says class, in both alphabets', () => {
  const guilty: string[] = []
  for (const { name, source } of cliSources())
    source.split('\n').forEach((text, index) => {
      if (/семинар|seminar/i.test(text)) guilty.push(`cli/src/${name}:${index + 1}  ${text.trim()}`)
    })
  assert.deepEqual(guilty, [], 'a class is called a class:\n' + guilty.join('\n'))
})

/**
 * The launch summary: one link, and it carries the sign-in token, like Jupyter.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logTail, renderBanner, teacherLink, tilde } from '../cli/src/launch-banner.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-banner-'))
}

test('the link carries the setup token, and falls back to the panel without one', () => {
  const dir = tmp()
  try {
    assert.equal(teacherLink('http://localhost:3000', dir), 'http://localhost:3000/admin')
    fs.writeFileSync(path.join(dir, 'setup-token'), 'QVeZ98Oo_x-z\n')
    assert.equal(teacherLink('http://localhost:3000', dir), 'http://localhost:3000/admin/t/QVeZ98Oo_x-z')
    // Wrong alphabet — the link would lead to an empty panel with junk in the
    // address.
    fs.writeFileSync(path.join(dir, 'setup-token'), 'a b/c\n')
    assert.equal(teacherLink('http://localhost:3000', dir), 'http://localhost:3000/admin')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the banner is the link, where the files are, and how to stop', () => {
  const text = renderBanner(
    {
      link: 'http://localhost:3000/admin/t/abc',
      workspaceDir: '/home/t/colloq/workspace',
      logFile: '/home/t/colloq/.colloq.log',
      detached: false,
      version: '0.2.1',
    },
    '/home/t',
  ).join('\n')
  assert.match(text, /Colloq 0\.2\.1 is running\n/)
  assert.match(text, /^ {4}http:\/\/localhost:3000\/admin\/t\/abc$/m)
  assert.match(text, /Files {2}~\/colloq\/workspace/)
  assert.match(text, /Log {4}~\/colloq\/\.colloq\.log/)
  assert.match(text, /Ctrl\+C/)
  const background = renderBanner(
    { link: 'x', workspaceDir: '/w', logFile: '/l', detached: true },
    '/home/t',
  ).join('\n')
  assert.match(background, /Colloq is running in the background/)
  assert.match(background, /colloq stop/)
  assert.doesNotMatch(background, /Ctrl\+C/)
})

test('tilde shortens only paths inside home', () => {
  assert.equal(tilde('/home/t/x', '/home/t'), '~/x')
  assert.equal(tilde('/home/tt/x', '/home/t'), '/home/tt/x')
})

test('the log tail drops colour codes, carriage returns and blank lines', () => {
  const dir = tmp()
  try {
    const file = path.join(dir, 'log')
    fs.writeFileSync(file, 'one\n\n\x1b[31mtwo\x1b[0m\rthree\r\nfour\n')
    assert.deepEqual(logTail(file, 3), ['two', 'three', 'four'])
    assert.deepEqual(logTail(path.join(dir, 'missing')), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Credentials that arrive as a URL.
 *
 * Two of them: a teacher's personal sign-in link, and the server's setup token
 * carried in `/admin/t/<token>` so that a tunnel does not make somebody retype
 * thirty-two characters at the start of every seminar.
 *
 * Both are spent on arrival and erased from the address bar. A pattern that
 * quietly stopped matching would not fail a build — it would land a person on
 * an empty panel with a live credential still in the URL, on a projector.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readEntryCredential, SPENT_PATH } from '../web/src/admin/entry.js'

/* ------------------------------------------------------ what is a credential */

test('a personal sign-in link is read as a key', () => {
  assert.deepEqual(readEntryCredential('/admin/k/abc123'), { kind: 'key', value: 'abc123' })
})

test('a setup-token link is read as a token', () => {
  // The shape the server prints on boot and `make host` prints again.
  assert.deepEqual(readEntryCredential('/admin/t/6RSL_ZJ5wgEPPM2EZk3io7rcfoeJG98g'), {
    kind: 'token',
    value: '6RSL_ZJ5wgEPPM2EZk3io7rcfoeJG98g',
  })
})

test('base64url survives intact — including the two characters that are not letters', () => {
  // A token mangled here verifies against nothing and reads as "wrong token".
  const value = 'a-b_c-D_E123'
  assert.deepEqual(readEntryCredential(`/admin/t/${value}`), { kind: 'token', value })
})

test('a trailing slash is the same link', () => {
  assert.deepEqual(readEntryCredential('/admin/t/abc/'), { kind: 'token', value: 'abc' })
  assert.deepEqual(readEntryCredential('/admin/k/abc/'), { kind: 'key', value: 'abc' })
})

/* ----------------------------------------------------- what is NOT one */

test('the panel and its own tabs carry no credential', () => {
  for (const path of ['/admin', '/admin/', '/admin/seminars', '/admin/teachers', '/admin/assistant']) {
    assert.equal(readEntryCredential(path), null, path)
  }
})

test('a tab whose name starts with the credential letter is not a credential', () => {
  // /admin/teachers begins with the same letter as /admin/t/ — one careless
  // pattern and opening the teachers tab tries to spend "eachers" as a token.
  assert.equal(readEntryCredential('/admin/teachers'), null)
  assert.equal(readEntryCredential('/admin/keys'), null)
})

test('a seminar link is never mistaken for a credential', () => {
  assert.equal(readEntryCredential('/s/kf3n8q2p'), null)
  assert.equal(readEntryCredential('/'), null)
})

test('an empty credential is not a credential', () => {
  assert.equal(readEntryCredential('/admin/t/'), null)
  assert.equal(readEntryCredential('/admin/k/'), null)
})

test('anything with a character the token alphabet does not use is refused', () => {
  // Not validation for its own sake: it keeps a path segment carrying a slash,
  // a dot or a percent-escape from being handed to the server as a token.
  for (const bad of ['/admin/t/abc.def', '/admin/t/abc%2F', '/admin/t/abc/def', '/admin/t/ab c']) {
    assert.equal(readEntryCredential(bad), null, bad)
  }
})

test('a deeper path under the credential is not a credential', () => {
  assert.equal(readEntryCredential('/admin/t/abc/extra'), null)
})

/* ------------------------------------------------------------ where it goes */

test('a spent credential is replaced by the panel itself', () => {
  // Must be a path the panel actually renders, and must not be the link that
  // was just spent — Back would otherwise put the credential back on screen.
  assert.equal(SPENT_PATH, '/admin')
  assert.equal(readEntryCredential(SPENT_PATH), null)
})

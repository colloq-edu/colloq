/**
 * The link a teacher copies out of the panel.
 *
 * It used to be `PUBLIC_URL + /s/<id>`, built on the server, which is one
 * setting away from being wrong — and wrong here is expensive twice over. The
 * link opens for the person who copied it and nobody else, and it costs that
 * person their own host seat: a link on another origin carries neither the
 * staff cookie nor the staff hint, so the author of the seminar arrives at it
 * as an anonymous participant.
 *
 * Measured through a live Cloudflare tunnel: the room was on
 * https://seminar.sleep3r.ru, PUBLIC_URL still said http://localhost:3000, and
 * every link in the panel pointed at a machine one person could reach.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seminarLink } from '../web/src/lib/seminar-link.js'

const TUNNEL = 'https://seminar.sleep3r.ru'
const LOCAL = 'http://localhost:3000'

test('a configured public address is honoured, whatever the panel is open on', () => {
  // The operator who administers over an SSH tunnel on localhost while the room
  // uses a real hostname has said what they mean; this must not second-guess it.
  assert.equal(seminarLink('https://colloq.example.edu', LOCAL, 'abc'), 'https://colloq.example.edu/s/abc')
})

test('a PUBLIC_URL left on localhost loses to the address actually being read', () => {
  // The failure this exists for: the tunnel is up, the setting was never changed.
  assert.equal(seminarLink(`${LOCAL}/s/abc`, TUNNEL, 'abc'), `${TUNNEL}/s/abc`)
})

test('every way of writing "this machine" counts as one', () => {
  for (const local of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://0.0.0.0:3000', 'http://[::1]:3000']) {
    assert.equal(seminarLink(local, TUNNEL, 'abc'), `${TUNNEL}/s/abc`, local)
  }
})

test('working locally keeps a local link, because both answers agree', () => {
  // Nobody is being helped here, and nobody should be surprised either.
  assert.equal(seminarLink(LOCAL, LOCAL, 'abc'), `${LOCAL}/s/abc`)
})

test('a port is part of the address and survives', () => {
  assert.equal(seminarLink('https://colloq.example.edu:8443', LOCAL, 'abc'), 'https://colloq.example.edu:8443/s/abc')
})

test('a path, query or fragment on PUBLIC_URL is dropped, not glued on', () => {
  // PUBLIC_URL is operator-configured; a trailing slash or a stray path would
  // otherwise produce //s/abc or /admin/s/abc, both of which 404.
  assert.equal(seminarLink('https://colloq.example.edu/', LOCAL, 'abc'), 'https://colloq.example.edu/s/abc')
  assert.equal(seminarLink('https://colloq.example.edu/admin?x=1#y', LOCAL, 'abc'), 'https://colloq.example.edu/s/abc')
})

test('a PUBLIC_URL that is not a URL at all falls through to the page', () => {
  for (const junk of ['', 'colloq.example.edu', 'not a url', '/s/abc']) {
    assert.equal(seminarLink(junk, TUNNEL, 'abc'), `${TUNNEL}/s/abc`, JSON.stringify(junk))
  }
})

test('the id is what identifies the seminar, and it is never rewritten', () => {
  assert.equal(seminarLink(TUNNEL, LOCAL, 'kf3n8q2p'), `${TUNNEL}/s/kf3n8q2p`)
})

test('there is exactly one slash between the origin and the path', () => {
  for (const base of ['https://colloq.example.edu', 'https://colloq.example.edu/', 'https://colloq.example.edu///']) {
    assert.equal(seminarLink(base, LOCAL, 'abc'), 'https://colloq.example.edu/s/abc', base)
  }
})

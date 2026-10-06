/**
 * The common harness of the scoping-*.test.mts files: the real app on a
 * port, staff rows with cookies, and one fetch helper. Not a test file itself
 * (the runner only picks up *.test.mts).
 */
import './_env.mts'
import http from 'node:http'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE, type AdminRole, type Teacher } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { app } from '../server/src/app.js'

export interface Running {
  base: string
  close: () => void
}

export async function startApp(): Promise<Running> {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => server.close(),
  }
}

export function cookieFor(teacher: Teacher): string {
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse, teacher)
  return `${STAFF_COOKIE}=${value}`
}

let made = 0

/** A staff member with a link (so the cookie verifies) and their cookie. */
export function staffMember(name: string, role: AdminRole = 'teacher'): { teacher: Teacher; cookie: string } {
  made += 1
  const teacher = createTeacher({ name, email: `scoping-${made}-${process.pid}@example.edu`, role })
  assert.ok(teacher, `could not create ${name}`)
  rotateLinkKey(teacher.id)
  return { teacher, cookie: cookieFor(teacher) }
}

export function call(
  base: string,
  method: string,
  path: string,
  init: { cookie?: string; body?: unknown; bearer?: string } = {},
): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

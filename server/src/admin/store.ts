/**
 * The staff table: who may run this instance.
 *
 * Its schema lives here rather than in db.ts because the admin surface is a
 * self-contained half of the product — an instance that never claims itself
 * still boots, and the table it never uses costs nothing.
 *
 * One rule runs through the whole module: `link_key` is a credential, and a
 * Teacher is a DTO that gets serialised to a browser. The two never meet. Only
 * `linkKeyOf` and the mint functions ever return the secret, and the routes
 * hand it out exactly once, in a sign-in URL.
 */
import crypto from 'node:crypto'
import { db } from '../db.js'
import type { AdminRole, Teacher } from '@shared/admin'

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER,
    link_key      TEXT
  );

  -- Partial, because "no link minted yet" is a state many rows share at once
  -- while a live key must resolve to exactly one person.
  CREATE UNIQUE INDEX IF NOT EXISTS staff_link_key ON staff(link_key) WHERE link_key IS NOT NULL;
`)

interface StaffRow {
  id: string
  email: string
  name: string
  role: string
  created_at: number
  last_seen_at: number | null
  link_key: string | null
}

/** Returned when a link is minted or rotated. The key is shown once and never stored elsewhere. */
export interface MintedLink {
  teacher: Teacher
  key: string
}

const selectAll = db.prepare('SELECT * FROM staff ORDER BY created_at ASC')
const selectById = db.prepare('SELECT * FROM staff WHERE id = ?')
const selectByEmail = db.prepare('SELECT * FROM staff WHERE email = ?')
const selectByLinkKey = db.prepare('SELECT * FROM staff WHERE link_key = ?')
const selectOldestOwner = db.prepare(
  "SELECT * FROM staff WHERE role = 'owner' ORDER BY created_at ASC, id ASC LIMIT 1",
)
const selectLinkKey = db.prepare('SELECT link_key FROM staff WHERE id = ?')
const insertStaff = db.prepare(`
  INSERT INTO staff (id, email, name, role, created_at, last_seen_at, link_key)
  VALUES (@id, @email, @name, @role, @created_at, NULL, NULL)
`)
const updateRole = db.prepare('UPDATE staff SET role = ? WHERE id = ?')
const updateLinkKey = db.prepare('UPDATE staff SET link_key = ? WHERE id = ?')
const deleteById = db.prepare('DELETE FROM staff WHERE id = ?')
const touchSeen = db.prepare('UPDATE staff SET last_seen_at = ? WHERE id = ?')
const countOwnersStmt = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner'")
const countStaffStmt = db.prepare('SELECT COUNT(*) AS n FROM staff')

function toTeacher(row: StaffRow): Teacher {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role === 'owner' ? 'owner' : 'teacher',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    hasLink: row.link_key !== null,
  }
}

/** Identity, so it is compared the way a human would read it: same address, same person. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function newStaffId(): string {
  return 't_' + crypto.randomBytes(9).toString('base64url')
}

/** 24 bytes: this is the whole credential behind a sign-in link, guessing is the only attack. */
export function newLinkKey(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export function listTeachers(): Teacher[] {
  return (selectAll.all() as StaffRow[]).map(toTeacher)
}

export function getTeacher(id: string): Teacher | null {
  const row = selectById.get(id) as StaffRow | undefined
  return row ? toTeacher(row) : null
}

export function getTeacherByEmail(email: string): Teacher | null {
  const row = selectByEmail.get(normalizeEmail(email)) as StaffRow | undefined
  return row ? toTeacher(row) : null
}

export function getTeacherByLinkKey(key: string): Teacher | null {
  // An empty key would otherwise match nothing by luck rather than by rule.
  if (!key) return null
  const row = selectByLinkKey.get(key) as StaffRow | undefined
  return row ? toTeacher(row) : null
}

/** The recovery path: the setup token signs in as whoever claimed the instance. */
export function oldestOwner(): Teacher | null {
  const row = selectOldestOwner.get() as StaffRow | undefined
  return row ? toTeacher(row) : null
}

/**
 * Null when the address is taken. The UNIQUE index is the check, not a prior
 * SELECT: only the write itself can decide, and the routes want to answer 409
 * rather than crash.
 */
export function createTeacher(input: { email: string; name: string; role: AdminRole }): Teacher | null {
  const id = newStaffId()
  try {
    insertStaff.run({
      id,
      email: normalizeEmail(input.email),
      name: input.name,
      role: input.role,
      created_at: Date.now(),
    })
  } catch (err) {
    if (err instanceof Error && 'code' in err && String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return null
    }
    throw err
  }
  return getTeacher(id)
}

export function updateTeacherRole(id: string, role: AdminRole): Teacher | null {
  if (updateRole.run(role, id).changes === 0) return null
  return getTeacher(id)
}

/** Mints a fresh key and discards the old one, which is what makes a link revocable. */
export function rotateLinkKey(id: string): MintedLink | null {
  const key = newLinkKey()
  if (updateLinkKey.run(key, id).changes === 0) return null
  const teacher = getTeacher(id)
  return teacher ? { teacher, key } : null
}

export function deleteTeacher(id: string): boolean {
  return deleteById.run(id).changes > 0
}

export function touchTeacherLastSeen(id: string): void {
  touchSeen.run(Date.now(), id)
}

export function countOwners(): number {
  return (countOwnersStmt.get() as { n: number }).n
}

export function countStaff(): number {
  return (countStaffStmt.get() as { n: number }).n
}

/**
 * The raw secret, for cookie signing only — see admin/auth.ts. It must never
 * reach a response body; everything a client is allowed to know about a link is
 * the `hasLink` boolean on Teacher.
 */
export function linkKeyOf(id: string): string | null {
  const row = selectLinkKey.get(id) as { link_key: string | null } | undefined
  return row ? row.link_key : null
}

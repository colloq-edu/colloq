/**
 * Sign-in and the staff list.
 *
 * Two credentials come in here — the setup token and a personal link — and both
 * leave as the same HttpOnly cookie; every other admin route only ever sees the
 * cookie. The one unauthenticated endpoint is /api/admin/state, and it is
 * written to say whether the instance has an owner without saying who.
 *
 * The instance is guaranteed to always have at least one owner. That invariant
 * is enforced twice below (demote, delete) because losing it means nobody can
 * add anyone, and the only way back is a shell on the server.
 */
import { Router, type Response } from 'express'
import {
  clearStaffCookie,
  currentStaff,
  isClaimed,
  issueStaffCookie,
  ownerOnly,
  requireOwner,
  requireStaff,
  verifySetupToken,
} from '../admin/auth.js'
import {
  countOwners,
  createTeacher,
  deleteTeacher,
  getTeacher,
  getTeacherByEmail,
  getTeacherByLinkKey,
  linkKeyOf,
  listTeachers,
  normalizeEmail,
  oldestOwner,
  rotateLinkKey,
  touchTeacherLastSeen,
  updateTeacherIdentity,
  updateTeacherRole,
} from '../admin/store.js'
import { config } from '../config.js'
import {
  LIMITS,
  SIGN_IN_PATH,
  type AdminErrorBody,
  type AdminMe,
  type AdminRole,
  type ClaimRequest,
  type InstanceState,
  type SignInWithTokenRequest,
  type Teacher,
  type TeacherWithLink,
} from '@shared/admin'

function fail(res: Response, status: number, reason: AdminErrorBody['reason'], error: string): void {
  const body: AdminErrorBody = { error, reason }
  res.status(status).json(body)
}

/** Collapse whitespace and drop control characters so a name cannot break the staff list. */
function normalizeName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Deliberately loose: it rejects what cannot be an address, not what is
 * unusual. A self-hosted instance may well have staff at a host with no dot in
 * it, and refusing them would be a bug of our own making.
 */
function looksLikeEmail(value: string): boolean {
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false
  if (/[\s,;:<>"'\u0000-\u001f]/.test(value)) return false
  const domain = value.slice(at + 1)
  if (/^[.-]|[.-]$/.test(domain) || domain.includes('..')) return false
  return true
}

function meOf(teacher: Teacher): AdminMe {
  return { teacher, ownerCount: countOwners() }
}

function withLink(minted: { teacher: Teacher; key: string }): TeacherWithLink {
  return { teacher: minted.teacher, signInUrl: `${config.publicUrl}${SIGN_IN_PATH}${minted.key}` }
}

export function adminAuthRoutes(): Router {
  const router = Router()

  /* --------------------------------------------------------------- public */

  router.get('/api/admin/state', (_req, res) => {
    const claimed = isClaimed()
    const state: InstanceState = {
      claimed,
      // Only a fresh install has a claim form to prefill. Afterwards this is
      // just the operator's address, handed to every anonymous visitor who asks
      // this endpoint — and on an instance whose recovery story is "someone
      // sends you a link", that is a phishing target.
      suggestedEmail: claimed ? '' : config.adminEmail,
      openSeminarCreation: config.openSeminarCreation,
    }
    // Claiming is a race against whoever else can read the disk; a cached
    // "unclaimed" would be a lie the moment it mattered.
    res.setHeader('Cache-Control', 'no-store')
    res.json(state)
  })

  router.post('/api/admin/claim', (req, res) => {
    // Checked before the token, so a second claimant learns nothing about the
    // token by how long the refusal took.
    if (isClaimed()) {
      return fail(res, 409, 'invalid', 'this instance has already been claimed')
    }
    const body = req.body as Partial<ClaimRequest> | undefined
    if (!verifySetupToken(body?.token)) {
      return fail(res, 401, 'unauthenticated', 'that setup token is not the one on this server')
    }

    const name = normalizeName(body?.name)
    if (!name) return fail(res, 400, 'invalid', 'a name is required')
    if (name.length > LIMITS.teacherName) {
      return fail(res, 400, 'invalid', `name must be ${LIMITS.teacherName} characters or fewer`)
    }
    const email = normalizeEmail(typeof body?.email === 'string' ? body.email : '')
    if (!email || email.length > LIMITS.email || !looksLikeEmail(email)) {
      return fail(res, 400, 'invalid', 'a valid email address is required')
    }

    const teacher = createTeacher({ email, name, role: 'owner' })
    if (!teacher) return fail(res, 409, 'invalid', 'that email is already on the staff list')
    const minted = rotateLinkKey(teacher.id)
    if (!minted) return fail(res, 409, 'invalid', 'that account disappeared mid-claim')

    touchTeacherLastSeen(minted.teacher.id)
    issueStaffCookie(res, minted.teacher)
    res.status(201).json(meOf(getTeacher(minted.teacher.id) ?? minted.teacher))
  })

  /**
   * Recovery: the setup token keeps working after the instance is claimed and
   * signs in as the founding owner. It is the documented way back in when the
   * owner has lost their personal link.
   */
  router.post('/api/admin/signin/token', (req, res) => {
    const body = req.body as Partial<SignInWithTokenRequest> | undefined
    if (!verifySetupToken(body?.token)) {
      return fail(res, 401, 'unauthenticated', 'that setup token is not the one on this server')
    }
    const owner = oldestOwner()
    if (!owner) return fail(res, 409, 'unclaimed', 'this instance has not been claimed yet')

    touchTeacherLastSeen(owner.id)
    issueStaffCookie(res, owner)
    res.json(meOf(getTeacher(owner.id) ?? owner))
  })

  router.post('/api/admin/signin/key', (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : ''
    const teacher = getTeacherByLinkKey(key)
    // One answer for an unknown key and a rotated one: neither says whether the
    // person on the other end of that link still exists.
    if (!teacher) return fail(res, 401, 'unauthenticated', 'that sign-in link is no longer valid')

    touchTeacherLastSeen(teacher.id)
    issueStaffCookie(res, teacher)
    res.json(meOf(getTeacher(teacher.id) ?? teacher))
  })

  router.post('/api/admin/signout', (_req, res) => {
    clearStaffCookie(res)
    res.status(204).end()
  })

  /* ------------------------------------------------------------ signed in */

  router.get('/api/admin/me', requireStaff, (req, res) => {
    const teacher = currentStaff(req)
    if (!teacher) return fail(res, 401, 'unauthenticated', 'sign in to use the admin panel')
    res.json(meOf(teacher))
  })

  // Any staff member may read it: a teacher needs to know who to ask when they
  // want something only an owner can do.
  router.get('/api/admin/teachers', requireStaff, (_req, res) => {
    const teachers: Teacher[] = listTeachers()
    res.json(teachers)
  })

  router.post('/api/admin/teachers', requireOwner, (req, res) => {
    const name = normalizeName(req.body?.name)
    if (!name) return fail(res, 400, 'invalid', 'a name is required')
    if (name.length > LIMITS.teacherName) {
      return fail(res, 400, 'invalid', `name must be ${LIMITS.teacherName} characters or fewer`)
    }
    const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '')
    if (!email || email.length > LIMITS.email || !looksLikeEmail(email)) {
      return fail(res, 400, 'invalid', 'a valid email address is required')
    }
    if (getTeacherByEmail(email)) {
      return fail(res, 409, 'invalid', 'someone with that email is already on the staff list')
    }

    // Everyone is added as a teacher and promoted afterwards, so granting the
    // second owner is always a deliberate second act.
    const teacher = createTeacher({ email, name, role: 'teacher' })
    if (!teacher) return fail(res, 409, 'invalid', 'someone with that email is already on the staff list')
    const minted = rotateLinkKey(teacher.id)
    if (!minted) return fail(res, 409, 'invalid', 'that account disappeared mid-create')

    res.status(201).json(withLink(minted))
  })

  /*
   * Copy an existing link without rotating it. The server holds the key in
   * plaintext already, so refusing to say it again buys nothing against an
   * attacker — while forcing a rotation on "they lost the link" is a real cost:
   * it kills that person's other devices to solve a problem they did not have.
   *
   * The row still never DISPLAYS the key, only its shape, so a screen share in
   * a lecture hall spills nothing; this is the clipboard, not the screen. Owner
   * only, like every other write on this list.
   */
  router.get('/api/admin/teachers/:id/link', ownerOnly('read a sign-in link'), (req, res) => {
    const teacher = getTeacher(req.params.id)
    if (!teacher) return fail(res, 404, 'invalid', 'no such teacher')
    const key = linkKeyOf(teacher.id)
    if (!key) return fail(res, 409, 'invalid', 'that person has no sign-in link yet — mint one first')
    res.json(withLink({ teacher, key }))
  })

  router.post('/api/admin/teachers/:id/rotate', requireOwner, (req, res) => {
    // Read before the rotation: afterwards the caller's own cookie may be one
    // of the ones it just killed, and currentStaff would answer null.
    const actor = currentStaff(req)

    const minted = rotateLinkKey(req.params.id)
    if (!minted) return fail(res, 404, 'invalid', 'no such teacher')

    // Rotating signs the old key out everywhere, which includes this browser
    // when an owner rotates their own link. Re-issuing keeps the tab they are
    // standing in alive; every other copy of their cookie still dies.
    if (actor && actor.id === minted.teacher.id) issueStaffCookie(res, minted.teacher)

    res.status(200).json(withLink(minted))
  })

  /*
   * Одна ручка на роль и на имя с адресом.
   *
   * Роль была единственным, что здесь принималось, и опечатка в фамилии
   * лечилась удалением с заводом заново: новая ссылка, потерянное авторство
   * семинаров и выброшенный из панели человек — ради одной буквы. Поля
   * необязательные: кто прислал только роль, работает как раньше.
   */
  router.patch('/api/admin/teachers/:id', requireOwner, (req, res) => {
    const target = getTeacher(req.params.id)
    if (!target) return fail(res, 404, 'invalid', 'no such teacher')

    const wantsIdentity = req.body?.name !== undefined || req.body?.email !== undefined
    if (wantsIdentity) {
      const name = normalizeName(req.body?.name)
      if (!name) return fail(res, 400, 'invalid', 'a name is required')
      if (name.length > LIMITS.teacherName) {
        return fail(res, 400, 'invalid', `name must be ${LIMITS.teacherName} characters or fewer`)
      }
      const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '')
      if (!email || email.length > LIMITS.email || !looksLikeEmail(email)) {
        return fail(res, 400, 'invalid', 'a valid email address is required')
      }
      const taken = getTeacherByEmail(email)
      if (taken && taken.id !== target.id) {
        return fail(res, 409, 'invalid', 'someone with that email is already on the staff list')
      }
      const renamed = updateTeacherIdentity(target.id, { name, email })
      if (!renamed) {
        return fail(res, 409, 'invalid', 'someone with that email is already on the staff list')
      }
      // Смена только имени и адреса — роль трогать незачем.
      if (req.body?.role === undefined) return res.json(renamed)
    }

    const role = req.body?.role as AdminRole | undefined
    if (role !== 'owner' && role !== 'teacher') {
      return fail(res, 400, 'invalid', "role must be 'owner' or 'teacher'")
    }

    if (target.role === 'owner' && role === 'teacher' && countOwners() <= 1) {
      return fail(res, 409, 'invalid', 'the last owner cannot be demoted')
    }

    const updated = updateTeacherRole(target.id, role)
    if (!updated) return fail(res, 404, 'invalid', 'no such teacher')
    res.json(updated)
  })

  router.delete('/api/admin/teachers/:id', requireOwner, (req, res) => {
    const target = getTeacher(req.params.id)
    if (!target) return fail(res, 404, 'invalid', 'no such teacher')

    // The same rule that lets an owner remove themselves: allowed exactly when
    // somebody else is left holding the keys.
    if (target.role === 'owner' && countOwners() <= 1) {
      return fail(res, 409, 'invalid', 'the last owner cannot be removed')
    }

    const actor = currentStaff(req)
    if (!deleteTeacher(target.id)) return fail(res, 404, 'invalid', 'no such teacher')
    // Their cookie stops verifying the moment the row is gone; clearing it only
    // saves the browser from sending a dead one on every request.
    if (actor && actor.id === target.id) clearStaffCookie(res)
    res.status(204).end()
  })

  return router
}

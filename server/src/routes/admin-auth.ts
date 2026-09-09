import { tr } from '@shared/i18n'
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
  rotateSetupToken,
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
import { normalizeLabel } from '@shared/text'
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

/**
 * Collapse whitespace and drop control characters so a name cannot break the
 * staff list. Мерка общая — shared/text.ts.
 */
const normalizeName = normalizeLabel

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
      /*
       * Предел загрузки — числом, а не догадкой панели.
       *
       * Форма создания семинара печатает его («Up to 50 MB each») и по нему же
       * отказывает слишком большому файлу ДО того, как комната появится; до
       * этого поля она держала свою копию умолчания, и оператор, поднявший
       * MAX_UPLOAD_MB до 200, читал на экране чужое число.
       *
       * Секрета здесь нет: то же число сервер называет в отказе всякому
       * загружающему (routes/files.ts).
       */
      maxUploadBytes: config.maxUploadBytes,
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
      return fail(res, 409, 'invalid', tr("server.thisInstanceHasAlreadyBeenClaimed.585bbd"))
    }
    const body = req.body as Partial<ClaimRequest> | undefined
    if (!verifySetupToken(body?.token)) {
      return fail(res, 401, 'unauthenticated', tr("server.thatSetupTokenIsNotTheOne.cc477e"))
    }

    const name = normalizeName(body?.name)
    if (!name) return fail(res, 400, 'invalid', tr("server.aNameIsRequired.d1287e"))
    if (name.length > LIMITS.teacherName) {
      return fail(res, 400, 'invalid', tr("server.nameMustBeCharactersOrFewer.f2480d", { p0: LIMITS.teacherName }))
    }
    const email = normalizeEmail(typeof body?.email === 'string' ? body.email : '')
    if (!email || email.length > LIMITS.email || !looksLikeEmail(email)) {
      return fail(res, 400, 'invalid', tr("server.aValidEmailAddressIsRequired.6f16a6"))
    }

    const teacher = createTeacher({ email, name, role: 'owner' })
    if (!teacher) return fail(res, 409, 'invalid', tr("server.thatEmailIsAlreadyOnTheStaff.cc750b"))
    const minted = rotateLinkKey(teacher.id)
    if (!minted) return fail(res, 409, 'invalid', tr("server.thatAccountDisappearedMidClaim.c3a494"))

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
      return fail(res, 401, 'unauthenticated', tr("server.thatSetupTokenIsNotTheOne.cc477e"))
    }
    const owner = oldestOwner()
    if (!owner) return fail(res, 409, 'unclaimed', tr("server.thisInstanceHasNotBeenClaimedYet.6bbdc7"))

    touchTeacherLastSeen(owner.id)
    issueStaffCookie(res, owner)
    res.json(meOf(getTeacher(owner.id) ?? owner))
  })

  /*
   * Отозвать токен установки.
   *
   * Он подписывает вошедшего как самого старого владельца и печатается
   * `make host` при каждом запуске: он есть в истории терминала, на снимках
   * проектора и в переписке, куда его пересылали. Отозвать его было нечем.
   *
   * Только владелец, и ответ содержит новый токен: он показывается один раз,
   * как и ссылки преподавателей.
   */
  router.post('/api/admin/setup-token/rotate', ownerOnly('server.ownerAction.1'), (_req, res) => {
    res.json({ token: rotateSetupToken() })
  })

  router.post('/api/admin/signin/key', (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : ''
    const teacher = getTeacherByLinkKey(key)
    // One answer for an unknown key and a rotated one: neither says whether the
    // person on the other end of that link still exists.
    if (!teacher) return fail(res, 401, 'unauthenticated', tr("server.thatSignInLinkIsNoLonger.4fdb45"))

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
    if (!teacher) return fail(res, 401, 'unauthenticated', tr("server.signInToUseTheAdminPanel.301d28"))
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
    if (!name) return fail(res, 400, 'invalid', tr("server.aNameIsRequired.d1287e"))
    if (name.length > LIMITS.teacherName) {
      return fail(res, 400, 'invalid', tr("server.nameMustBeCharactersOrFewer.f2480d", { p0: LIMITS.teacherName }))
    }
    const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '')
    if (!email || email.length > LIMITS.email || !looksLikeEmail(email)) {
      return fail(res, 400, 'invalid', tr("server.aValidEmailAddressIsRequired.6f16a6"))
    }
    if (getTeacherByEmail(email)) {
      return fail(res, 409, 'invalid', tr("server.someoneWithThatEmailIsAlreadyOn.c19140"))
    }

    // Everyone is added as a teacher and promoted afterwards, so granting the
    // second owner is always a deliberate second act.
    const teacher = createTeacher({ email, name, role: 'teacher' })
    if (!teacher) return fail(res, 409, 'invalid', tr("server.someoneWithThatEmailIsAlreadyOn.c19140"))
    const minted = rotateLinkKey(teacher.id)
    if (!minted) return fail(res, 409, 'invalid', tr("server.thatAccountDisappearedMidCreate.591b74"))

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
  router.get('/api/admin/teachers/:id/link', ownerOnly('server.ownerAction.2'), (req, res) => {
    const teacher = getTeacher(req.params.id)
    if (!teacher) return fail(res, 404, 'invalid', tr("server.noSuchTeacher.dc9e13"))
    const key = linkKeyOf(teacher.id)
    if (!key) return fail(res, 409, 'invalid', tr("server.thatPersonHasNoSignInLink.538ff7"))
    res.json(withLink({ teacher, key }))
  })

  router.post('/api/admin/teachers/:id/rotate', requireOwner, (req, res) => {
    // Read before the rotation: afterwards the caller's own cookie may be one
    // of the ones it just killed, and currentStaff would answer null.
    const actor = currentStaff(req)

    const minted = rotateLinkKey(req.params.id)
    if (!minted) return fail(res, 404, 'invalid', tr("server.noSuchTeacher.dc9e13"))

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
    if (!target) return fail(res, 404, 'invalid', tr("server.noSuchTeacher.dc9e13"))

    const wantsIdentity = req.body?.name !== undefined || req.body?.email !== undefined
    if (wantsIdentity) {
      /*
       * Поля правда необязательные — по одному тоже.
       *
       * `wantsIdentity` требовал имя и адрес ВМЕСТЕ: `{name:'Иванов'}` без
       * адреса отвечал «a valid email address is required», то есть просил
       * прислать то, что менять не собирались. Панель шлёт оба поля и этого не
       * видела; видел тот, кто читал комментарий выше и поверил ему.
       * Неприсланное берётся из записи — это и значит «необязательное».
       */
      const name =
        req.body?.name === undefined ? target.name : normalizeName(req.body.name)
      if (!name) return fail(res, 400, 'invalid', tr("server.aNameIsRequired.d1287e"))
      if (name.length > LIMITS.teacherName) {
        return fail(res, 400, 'invalid', tr("server.nameMustBeCharactersOrFewer.f2480d", { p0: LIMITS.teacherName }))
      }
      const email =
        req.body?.email === undefined
          ? target.email
          : normalizeEmail(typeof req.body.email === 'string' ? req.body.email : '')
      if (!email || email.length > LIMITS.email || !looksLikeEmail(email)) {
        return fail(res, 400, 'invalid', tr("server.aValidEmailAddressIsRequired.6f16a6"))
      }
      const taken = getTeacherByEmail(email)
      if (taken && taken.id !== target.id) {
        return fail(res, 409, 'invalid', tr("server.someoneWithThatEmailIsAlreadyOn.c19140"))
      }
      const renamed = updateTeacherIdentity(target.id, { name, email })
      if (!renamed) {
        return fail(res, 409, 'invalid', tr("server.someoneWithThatEmailIsAlreadyOn.c19140"))
      }
      // Смена только имени и адреса — роль трогать незачем.
      if (req.body?.role === undefined) return res.json(renamed)
    }

    const role = req.body?.role as AdminRole | undefined
    if (role !== 'owner' && role !== 'teacher') {
      return fail(res, 400, 'invalid', tr("server.roleMustBeOwnerOrTeacher.514175"))
    }

    if (target.role === 'owner' && role === 'teacher' && countOwners() <= 1) {
      return fail(res, 409, 'invalid', tr("server.theLastOwnerCannotBeDemoted.1782e0"))
    }

    const updated = updateTeacherRole(target.id, role)
    if (!updated) return fail(res, 404, 'invalid', tr("server.noSuchTeacher.dc9e13"))
    res.json(updated)
  })

  router.delete('/api/admin/teachers/:id', requireOwner, (req, res) => {
    const target = getTeacher(req.params.id)
    if (!target) return fail(res, 404, 'invalid', tr("server.noSuchTeacher.dc9e13"))

    // The same rule that lets an owner remove themselves: allowed exactly when
    // somebody else is left holding the keys.
    if (target.role === 'owner' && countOwners() <= 1) {
      return fail(res, 409, 'invalid', tr("server.theLastOwnerCannotBeRemoved.d6e1d4"))
    }

    const actor = currentStaff(req)
    if (!deleteTeacher(target.id)) return fail(res, 404, 'invalid', tr("server.noSuchTeacher.dc9e13"))
    // Their cookie stops verifying the moment the row is gone; clearing it only
    // saves the browser from sending a dead one on every request.
    if (actor && actor.id === target.id) clearStaffCookie(res)
    res.status(204).end()
  })

  return router
}

import { roleFor } from '../authorization.js'
import { tr } from '@shared/i18n'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { kernelRetirementInProgress } from '../kernel/retirement.js'
import { currentStaff } from '../admin/auth.js'
import {
  HANDOFF_TTL_MS,
  newParticipantId,
  newSessionId,
  signHandoffToken,
  signHostToken,
  signToken,
  spendHandoffToken,
  type TokenPayload,
  verifyHostToken,
  verifyToken,
} from '../auth.js'
import { addressOf, banFor, banRefusal, deviceOf } from '../bans.js'
import { config } from '../config.js'
import {
  createSession,
  getParticipant,
  storedRules,
  getSession,
  isFinished,
  listParticipants,
  setRules,
  setSessionCpus,
  setSessionMemoryMb,
  upsertParticipant,
} from '../db.js'
import { onlineParticipantIds } from '../collab/index.js'
import { freeMark } from '@shared/marks'
import { seldom, tally } from '../log.js'
import { ensureKernel, syncBookKernels, syncDangerGuard } from '../kernel/index.js'
import { forgetResources, readCpuInput, readMemoryInput } from '../kernel/resources.js'
import { applyOwnLimits } from '../kernel/pool.js'
import { activeName, exists as environmentExists } from '../environments.js'
import { publicationOf, stepCount } from '../publish/store.js'
import { broadcast } from '../control.js'
import { readRules } from '@shared/rules'
import { normalizeLabel } from '@shared/text'
import { courseOfSeminar } from './course-view.js'
import { isArchived, setSeminarCreator } from './admin-instance.js'
import { ENVIRONMENT_NAME, type AdminErrorBody } from '@shared/admin'
import { SESSION_MISSING } from '@shared/protocol'
import type {
  CreateSessionResponse,
  HandoffResponse,
  JoinResponse,
  ParticipantRole,
  SessionMe,
} from '@shared/protocol'

/*
 * Lengths that have to survive being drawn, not just stored. A seminar name is
 * a display heading and a person's name sits in a cell footer and an avatar
 * tooltip, so both are cut where the layout stops coping rather than where the
 * column would. The avatar is one emoji, and 512 UTF-16 code units is
 * room for the longest of them — flags and family sequences run long.
 */
const MAX_SESSION_NAME = 80
const MAX_PARTICIPANT_NAME = 40
const MAX_AVATAR = 512

/**
 * Collapse whitespace and drop control characters so a name cannot break the
 * roster layout.
 *
 * There is one rule for every door, and it lives in shared/text.ts: the same
 * name arrives from the panel, from the staff list and from an import, and
 * three verbatim copies of this function were enough for a fourth door to
 * make do with a bare trim().
 */
const normalize = normalizeLabel

/**
 * An avatar is a sign, not an address.
 *
 * Only the length used to be checked, while this string is drawn as
 * `<img src>` when it starts with http or data:
 * (web/src/components/ui/Avatar.svelte). That is, one request made the
 * browser of EVERYONE in the room go to a foreign server — both in the roster
 * and in the caption of each of that person's cells, latecomers included. The
 * scheme is rejected here; in the room the avatar also arrives through
 * awareness, and that is closed not here but at rendering.
 */
function readAvatar(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const avatar = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!avatar || avatar.length > MAX_AVATAR) return null
  // Any scheme, not only http and data: no emoji starts with `word:`, and the
  // list of what a browser will load as a picture is longer than our memory.
  if (/^[a-z][a-z0-9+.-]*:/i.test(avatar)) return null
  return avatar
}

/**
 * How many NEW participants a room accepts per minute.
 *
 * Joining requires nothing but the link, and without a proven
 * participantId+token pair it creates a new row. A script in a loop used this
 * to inflate a seminar's roster and database to tens of thousands of "people"
 * nobody had ever seen — and the list travelled whole to every real
 * participant. Someone returning with their own token does not get here at
 * all, and neither does staff.
 *
 * The number used to be 120 and rested on "more than any real class
 * produces". That stopped being true: a load test with a cohort of five
 * hundred people showed 122 joined and 378 refused — the whole second half of
 * the hall ran into the anti-script protection and had to press again, and
 * the client does not know how to retry. Six hundred is a full cohort plus
 * the rejoins of those whose Wi-Fi blinked, and still orders of magnitude
 * less than a loop produces: that makes thousands a minute and hits this
 * ceiling within the first seconds.
 */
const ARRIVAL_WINDOW_MS = 60_000
const MAX_NEW_PARTICIPANTS = 600
const arrivals = new Map<string, number[]>()

/*
 * And by address too. Six hundred a minute per room is about the bell, when
 * the whole cohort comes in; but five hundred "participants" from one address
 * over two hours (13 Sep 2026, a script against the oracle) did not fall
 * under that ceiling. A class behind one NAT joins all at once, so the window
 * is longer, and the number leaves headroom for a lecture hall.
 */
const ADDRESS_WINDOW_MS = 10 * 60_000
const MAX_NEW_PER_ADDRESS = 60
const arrivalsByAddress = new Map<string, number[]>()

function tooManyArrivalsFrom(sessionId: string, address: string | null): boolean {
  if (!address) return false
  const key = `${sessionId} ${address}`
  const now = Date.now()
  const recent = (arrivalsByAddress.get(key) ?? []).filter((at) => now - at < ADDRESS_WINDOW_MS)
  if (recent.length >= MAX_NEW_PER_ADDRESS) {
    arrivalsByAddress.set(key, recent)
    return true
  }
  recent.push(now)
  arrivalsByAddress.set(key, recent)
  if (arrivalsByAddress.size > 5000) {
    for (const [k, v] of arrivalsByAddress) if (v.every((at) => now - at >= ADDRESS_WINDOW_MS)) arrivalsByAddress.delete(k)
  }
  return false
}

function tooManyArrivals(sessionId: string): boolean {
  const now = Date.now()
  const recent = (arrivals.get(sessionId) ?? []).filter((at) => now - at < ARRIVAL_WINDOW_MS)
  if (recent.length >= MAX_NEW_PARTICIPANTS) {
    arrivals.set(sessionId, recent)
    return true
  }
  recent.push(now)
  arrivals.set(sessionId, recent)
  return false
}

/**
 * A mark is handed out at the door, and it has one judge — the server.
 *
 * The join screen picks an animal from the roster and promises: "Picked from
 * the ones nobody in this room has taken". The client narrowed this promise
 * down to one network round trip (web/src/components/join/pick.ts rereads the
 * roster right before knocking), but it cannot close it: two tabs knocking in
 * the same second do not see each other. Forty marks for a class of thirty
 * give about eleven pairs with the same animal — that is, with the same
 * cursor in the notebook, and the color does not tell them apart (it is
 * minted from the id). People notice it at minute twenty.
 *
 * Two groups count as taken: those who are IN THE ROOM now (the same list
 * `/participants` returns in its `online` field), and those who were just
 * handed a mark here. The second is not overcaution but the whole point:
 * a second passes between `/join` and the first presence frame, and without a
 * short memory a class that opened the link all at once fits entirely into
 * that second and scatters with identical animals.
 *
 * One's own past place does not count: someone returning takes exactly the
 * mark that was theirs, and there is nothing to replace it with and no reason
 * to.
 */
const MARK_HOLD_MS = 60_000
/** Rooms beyond which the whole memory is swept: otherwise it grows until a restart. */
const MARK_ROOMS_KEPT = 200

interface HandedMark {
  id: string
  mark: string
  at: number
}

const handedOut = new Map<string, HandedMark[]>()

function recentMarks(sessionId: string): HandedMark[] {
  const now = Date.now()
  const fresh = (handedOut.get(sessionId) ?? []).filter((row) => now - row.at < MARK_HOLD_MS)
  if (fresh.length > 0) handedOut.set(sessionId, fresh)
  else handedOut.delete(sessionId)
  return fresh
}

function rememberMark(sessionId: string, id: string, mark: string): void {
  // A person's own earlier mark does not block them: joining from a second tab is still them.
  const fresh = recentMarks(sessionId).filter((row) => row.id !== id)
  fresh.push({ id, mark, at: Date.now() })
  handedOut.set(sessionId, fresh)
  // Rooms nobody has joined for a long time are swept wholesale: a row lives a
  // minute, but the map itself would otherwise remember every room of the instance.
  if (handedOut.size > MARK_ROOMS_KEPT) for (const id of [...handedOut.keys()]) recentMarks(id)
}

/**
 * The mark a person will actually join with.
 *
 * What gets replaced is a mark that is taken AND was not chosen: the person
 * may have tapped a particular animal by hand (`picked`), and changing a
 * choice simply because that suits us better is the worse of two evils. The
 * picker does not let anyone press taken marks and rereads the roster when it
 * opens (web/src/components/join/MarkPicker.svelte), so a hand-picked one can
 * collide only within a network round trip — and two hedgehogs in a room are
 * cheaper than a screen that silently pretended not to hear.
 *
 * An empty mark is not made up: someone joining without one is a join that
 * bypasses the screen (the console, a script), and there is no reason to
 * hand them an animal.
 */
function markToHand(
  sessionId: string,
  asked: string | null,
  mine: string | null,
  picked: boolean,
): string | null {
  if (!asked || picked) return asked
  const inside = new Set(onlineParticipantIds(sessionId))
  const taken = new Set<string>()
  for (const person of listParticipants(sessionId)) {
    if (person.id === mine || !person.avatar || !inside.has(person.id)) continue
    taken.add(person.avatar)
  }
  for (const row of recentMarks(sessionId)) if (row.id !== mine) taken.add(row.mark)
  return taken.has(asked) ? freeMark(taken, null) : asked
}

/**
 * Why the person who joined turned out to be a NEW person rather than their
 * former self.
 *
 * On a production machine one seminar accumulated five hundred participant
 * rows with the same name, and the code does not show why: the browser sends
 * both participantId and the token, and a new row is created anyway. The
 * condition for coming back is a conjunction of four parts, and the log needs
 * the part that failed, otherwise finding it out is pure guesswork.
 *
 * No name, no avatar, no token contents: only which check failed.
 */
type JoinedAs =
  | 'back'
  | 'no id'
  | 'no token'
  | 'bad token'
  | 'other room'
  | 'other person'
  | 'row gone'

function joinedAs(
  sessionId: string,
  claimed: string | null,
  sent: unknown,
  proof: TokenPayload | null,
  returning: boolean,
): JoinedAs {
  if (returning) return 'back'
  if (claimed === null) return 'no id'
  if (typeof sent !== 'string' || !sent) return 'no token'
  // Parsing fails in two ways at once — a bad signature and an age beyond
  // TOKEN_MAX_AGE_MS — and they cannot be told apart from outside `verifyToken`.
  // For an investigation that is enough: both mean "nothing to show".
  if (proof === null) return 'bad token'
  if (proof.sessionId !== sessionId) return 'other room'
  if (proof.participantId !== claimed) return 'other person'
  // Everything matched, yet the row is gone: the seminar was cleaned up or the database redeployed.
  return 'row gone'
}

/**
 * A warmup failure — one line per room, not per person joining.
 *
 * `ensureKernel` hands one shared promise to everyone who called it in the
 * same millisecond, and each of them attaches a `.catch`: the log held
 * sixteen identical lines per room within one millisecond, and the real cause
 * drowned in them. The room learns about the failure its own way — through an
 * entry in the kernel log inside `ensureKernel`; the process log is fine with
 * one line a minute.
 */
const WARMUP_QUIET_MS = 60_000
const warmupWarnedAt = new Map<string, number>()

function noteWarmupFailure(sessionId: string, err: unknown): void {
  const now = Date.now()
  if (now - (warmupWarnedAt.get(sessionId) ?? 0) < WARMUP_QUIET_MS) return
  for (const [id, at] of warmupWarnedAt) if (now - at >= WARMUP_QUIET_MS) warmupWarnedAt.delete(id)
  warmupWarnedAt.set(sessionId, now)
  console.warn(
    `[session ${sessionId}] kernel warmup failed:`,
    err instanceof Error ? err.message : err,
  )
}

/**
 * The token from the header, if it is for THIS room.
 *
 * Header only. The query string used to be accepted here as well, for the
 * one route that needs it — a download is an `<a href download>` and an
 * anchor cannot send a header — but accepting it everywhere meant the string
 * that opens the control socket travelled in a URL a teacher could copy into
 * a group chat. The download route has its own short-lived credential now
 * (signDownloadToken); this one takes a header and nothing else.
 */
function bearerFor(req: Request): TokenPayload | null {
  const header = req.headers.authorization ?? ''
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const payload = verifyToken(raw)
  if (!payload || payload.sessionId !== req.params.id) return null
  return payload
}

/**
 * The ban at the threshold of everything that lives under /api/sessions/:id.
 *
 * One door for all of a room's REST routes — files, history, oracle,
 * council, rules — and it hangs in each router separately, because the
 * mounting order in app.ts is not a place where such a thing can be
 * remembered. `sessionAuth` knows about the ban by itself; the point here is
 * the words: a person should read "the teacher has closed your access", not
 * "join the seminar".
 *
 * The refusal goes only to someone who presented a token for this room. A
 * guest without a token passes: the join screen and `/join` go the same way,
 * and they have their own conversation about bans — refusing earlier would
 * mean showing the newcomer "seminar not found" instead of an explanation.
 * The device mark is still counted: for `banFor` it is the second half of the
 * match.
 */
export function banDoor(req: Request, res: Response, next: NextFunction): void {
  if (kernelRetirementInProgress(String(req.params.id))) {
    res.status(503).json({ error: tr("server.theSeminarIsStoppingTryAgainShortly.b8256e") })
    return
  }
  const payload = bearerFor(req)
  if (!payload) return next()
  const ban = banFor(payload.sessionId, payload.participantId, req.headers.cookie)
  if (!ban) return next()
  res.status(403).json(banRefusal(ban))
}

/**
 * Bearer credential that must belong to the `:id` in the path. Lives here
 * because this module mints the tokens; the file and AI routes import it.
 *
 * A staff cookie outranks the role the token was minted with — the same rule
 * the WebSocket upgrade applies in effectiveRole(), and it has to be the same
 * rule or the product answers one question two ways. It did: a teacher who
 * opened the seminar link before signing in holds a participant token for a
 * room that is theirs, and while the sockets let them interrupt the kernel, the
 * HTTP side refused them a checkpoint, a restore and the thread's own eraser.
 * Same person, same browser, same second, two answers.
 *
 * Re-read per request rather than baked into the token, so signing out of the
 * teaching side takes the powers with it on the next call.
 */
export function sessionAuth(req: Request): TokenPayload | null {
  const payload = bearerFor(req)
  if (!payload) return null
  /*
   * A banned person does not get through here either.
   *
   * The ban check stood on two doors out of three — `/join` and the socket
   * handshake — while a participant's token is signed and lives up to thirty
   * days, and there is no way to take it back. That is, closing someone's
   * access closed the room and closed nothing over HTTP: handouts, history,
   * file uploads (the very spam people get banned for) and oracle questions
   * on the instance's key stayed open until the token expired. `banDoor`
   * below answers with words about the ban; this is here so that a route
   * that forgot to hang it still does not let them in.
   */
  if (banFor(payload.sessionId, payload.participantId, req.headers.cookie)) return null
  /*
   * The role is decided here, on every request, and never read from the token.
   *
   * It used to be baked in at join time, which made `host` permanent: a teacher
   * removed from the staff list kept Restart, Clear and Restore in every room
   * they had ever opened, because their old token still said so. The cookie is
   * the only thing that can be taken away, so it is the only thing that grants.
   * The one exception is a seminar created straight against the API, where a
   * host token is the only credential there is — that is minted host and stays
   * host, and it is the path no browser walks.
   */
  return { ...payload, role: roleFor(req.headers.cookie, payload) }
}

/**
 * Who this is — for this request, not as of joining.
 *
 * One function for both entrances, on purpose. There were two, and they
 * answered differently: HTTP remembered the host tokens it had issued in an
 * in-memory set, while the socket did not know about that set at all — so the
 * author of a seminar created by a script got `host` on the buttons and
 * `participant` on the connection those buttons work through. Now there is
 * nowhere for them to drift apart.
 */
export { roleFor } from '../authorization.js'

/**
 * Whether to warm the kernel on join.
 *
 * `/join` called `ensureKernel` unconditionally, and with isolation that
 * means starting the room's container — which then lives through two hours
 * of idleness. The evening before a test, a class opens a dozen FINISHED
 * seminars of the course to reread the solutions, and every such visit
 * brought up a container (about two gigabytes) on the same machine where a
 * live class is running at that moment. A student cannot run anything there
 * anyway: the end of class hands `run` to the teacher (shared/rules.ts ·
 * rulesAfterClass).
 *
 * The teacher always warms it: they come into a finished room precisely to
 * recompute something in it, and there is no reason for them to wait for the
 * kernel to come up after pressing Run. An archived seminar is the same
 * story: the "removed from the list" mark means exactly that nobody intends
 * to work in it any more.
 */
export function warmsKernel(sessionId: string, role: ParticipantRole): boolean {
  if (role === 'host') return true
  return !isFinished(sessionId) && !isArchived(sessionId)
}

export function sessionRoutes(): Router {
  const router = Router()

  /**
   * "But am I let in?" — the only door that answers a banned person.
   *
   * It stands BEFORE `banDoor` on purpose, and this is not a slip in the
   * ordering: a tab refused at the socket handshake does not know what
   * happened to it. The socket closes before the upgrade and without words —
   * the browser sees 1006 — and "there is no room", "the key has expired" and
   * "the teacher has closed access" can only be told apart by asking.
   * Answering this question with a refusal ("you may not come here") would
   * leave the person exactly where they were: behind a 403 with no
   * explanation. So here `banFor` is asked directly and its expiry travels in
   * the answer.
   *
   * And it is cheap: every tab that dropped off calls it about once every half
   * minute, that is, hundreds of times a minute at a big lecture. No file
   * tree, no room document, no roster: the seminar row, parsing the signature
   * and one ban row.
   *
   * What each field means is at `SessionMe` in shared/protocol.ts.
   */
  router.get('/api/sessions/:id/me', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })

    const payload = bearerFor(req)
    if (!payload) {
      // No key, or it is for another room — "show your key", not "you have
      // been removed": nothing can be said about a ban without a proven id.
      const nobody: SessionMe = {
        tokenValid: false,
        ban: null,
        participantId: null,
        role: null,
      }
      return res.json(nobody)
    }

    const ban = banFor(payload.sessionId, payload.participantId, req.headers.cookie)
    const me: SessionMe = {
      tokenValid: true,
      ban: ban ? { until: ban.until } : null,
      participantId: payload.participantId,
      // The role is the one the server will act with on this key right now
      // (the cookie beats the token, see roleFor). A banned person has none:
      // they can do nothing, and calling them the host would be untrue.
      role: ban ? null : roleFor(req.headers.cookie, payload),
    }
    res.json(me)
  })

  // The ban closes this door too: /rules, /participants, /handoff and
  // everything that authorizes with the room's token. `/join` goes past it
  // (its token is in the body, not in a header) and refuses by itself, in its
  // own words.
  router.use('/api/sessions/:id', banDoor)

  router.post('/api/sessions', (req, res) => {
    // Who may open a room. An instance with OPEN_SEMINAR_CREATION off is one
    // where a visitor spinning up a seminar would be spending the owner's API
    // key, so staff are the only ones left; the students who matter here arrive
    // through /join with a link and never touch this route.
    const staff = currentStaff(req)
    if (!config.openSeminarCreation && !staff) {
      const denied: AdminErrorBody = {
        error:
          tr("server.onlyStaffCanCreateASeminarOn.eb0b8c"),
        reason: 'forbidden',
      }
      return res.status(403).json(denied)
    }

    const name = normalize(req.body?.name)
    if (!name) return res.status(400).json({ error: tr("server.aSessionNameIsRequired.15da74") })
    if (name.length > MAX_SESSION_NAME) {
      return res.status(400).json({
        error: tr("server.sessionNameMustBeCharactersOrFewer.a4c426", { p0: MAX_SESSION_NAME }),
      })
    }

    /*
     * The environment is recorded by NAME, and always.
     *
     * `createSession(id, name)` wrote NULL, and to the kernel NULL means
     * "follow the instance": the next "Make default" took such a room's Python
     * to another image, while the panel showed an empty column for it and did
     * not count it among those keeping an environment from deletion. The
     * panel abolished that state (routes/admin-instance.ts · "A concrete name
     * is always recorded"), and the scripted door must live by the same rule
     * — otherwise there are two.
     *
     * The name can also be sent: the same check as in the panel, so that the
     * name of a nonexistent image does not land in the seminar row.
     */
    const wanted = typeof req.body?.environment === 'string' ? req.body.environment.trim() : ''
    if (wanted && (!ENVIRONMENT_NAME.test(wanted) || !environmentExists(wanted))) {
      return res.status(400).json({ error: tr("server.thereIsNoEnvironmentCalled.a8903e", { p0: wanted }) })
    }

    /*
     * The room's memory is for staff only, and only within the machine's
     * bounds.
     *
     * On an open instance anyone can push this door, and "how much memory to
     * give" is not a question for a guest to decide: a room that took
     * everything kills not itself but the server under it. Staff send a
     * number, everyone else says nothing, and then the room lives by its
     * environment's default.
     */
    const memory = readMemoryInput(req.body?.memoryMb)
    if (!memory.ok) {
      return res.status(400).json({ error: tr('server.memoryMustBeWholeMegabytes') })
    }
    if (memory.mb !== null && !staff) {
      return res.status(403).json({ error: tr('server.memoryIsStaffOnly'), reason: 'forbidden' })
    }
    const cpu = readCpuInput(req.body?.cpus)
    if (!cpu.ok) {
      return res.status(400).json({ error: tr('server.cpusMustBeWholeCores') })
    }
    if (cpu.cpus !== null && !staff) {
      return res.status(403).json({ error: tr('server.memoryIsStaffOnly'), reason: 'forbidden' })
    }

    const id = newSessionId()
    const session = createSession(id, name, wanted || activeName())
    if (memory.mb !== null) {
      setSessionMemoryMb(id, memory.mb)
      forgetResources()
    }
    if (cpu.cpus !== null) {
      setSessionCpus(id, cpu.cpus)
      forgetResources()
    }
    // A seminar created straight against this endpoint by a signed-in teacher
    // is still theirs. There is no page that does it — the panel has its own
    // route — so this is the scripted path, and on an open instance it produces
    // a seminar with nobody's name on it.
    if (staff) setSeminarCreator(id, staff.name)
    const body: CreateSessionResponse = {
      session,
      hostToken: signHostToken(id),
    }
    res.status(201).json(body)
  })

  router.get('/api/sessions/:id', (req, res) => {
    const session = getSession(req.params.id)
    if (!session) return res.status(404).json({ error: SESSION_MISSING })
    /*
     * The pointer to the published version is here because this is where the
     * join screen reads it. It repairs the only address a student really has:
     * the link in the chat leads to the room, and without a hint a person a
     * week later types their name into a finished class and stays in it alone.
     */
    const pub = publicationOf(session.id)
    const course = pub ? courseOfSeminar(session.id) : null
    res.json({
      ...session,
      published:
        pub && pub.state === 'published'
          ? { id: pub.id, slug: pub.slug, steps: stepCount(pub.id) }
          : null,
      course: course ? { id: course.id, name: course.name } : null,
    })
  })

  router.post('/api/sessions/:id/join', (req, res) => {
    const sessionId = req.params.id
    const session = getSession(sessionId)
    if (!session) return res.status(404).json({ error: SESSION_MISSING })

    const name = normalize(req.body?.name).slice(0, MAX_PARTICIPANT_NAME)
    if (!name) return res.status(400).json({ error: tr("server.aNameIsRequired.d1287e") })

    const asked = readAvatar(req.body?.avatar)
    // Strictly `=== true`: the field comes from the browser, and a merely
    // "truthy" value like a string or a 1 does not earn the right to keep the
    // mark unreplaced.
    const picked = req.body?.picked === true

    /*
     * Role never comes from the client's stored identity — anyone could paste in
     * someone else's participantId and inherit their badge. Two things grant it:
     *
     *  - a signed host token, minted at creation and kept by whoever made the
     *    room, which is how an open instance with no staff list works;
     *  - a staff cookie. Seminars created in the admin panel never handed a host
     *    token to anybody, so nobody could interrupt or restart the kernel in
     *    them — the controls were dead for the whole room. A teacher signed in
     *    to this instance is exactly the person those controls are for, and the
     *    cookie is a stronger credential than the token.
     */
    const staff = currentStaff(req)
    // The two sources of the role are told apart in the log, so they are
    // computed separately. `!staff &&` keeps the old order: a cookie needs no
    // host token.
    const byHostToken = !staff && verifyHostToken(sessionId, req.body?.hostToken)
    const role: ParticipantRole = staff || byHostToken ? 'host' : 'participant'

    /*
     * Coming back as yourself has to be proved.
     *
     * Awareness broadcasts every participant id to the whole room, because that
     * is how a caret gets a face — so "I am p_xyz" is a sentence any student in
     * the seminar can say about anybody in it. It never granted the badge: the
     * role is decided above, from credentials this request carries. But an
     * unproved claim still overwrote the row it named, which meant one person
     * could rename another in the participants list, take their avatar, and set
     * the role recorded against them back to participant.
     *
     * The proof is the token minted for that participant when they joined. Only
     * their own browser has it. Without it — a cleared store, another machine —
     * the visitor is somebody new, which is the honest reading of "I cannot show
     * you anything that says I was here before".
     */
    const claimed = typeof req.body?.participantId === 'string' ? req.body.participantId : null
    const proof = verifyToken(typeof req.body?.token === 'string' ? req.body.token : null)
    const proved =
      claimed !== null &&
      proof !== null &&
      proof.sessionId === sessionId &&
      proof.participantId === claimed
    const known = proved ? getParticipant(sessionId, claimed) : null

    /*
     * A banned person learns about it here, before anything else.
     *
     * It is the proven id that is checked, not the one sent: "I am p_xyz" is a
     * sentence anyone can say about anyone (see above), and with it one could
     * try someone else's ban on oneself. That does not concern the second
     * mark, the device's: the browser sends it, and only its own.
     *
     * Before the new-participant counter: a rush is about the room, while a
     * ban is about one person, and getting "too many people are joining"
     * instead of "the teacher has closed your access" means understanding
     * nothing.
     */
    const ban = banFor(sessionId, known?.id ?? null, req.headers.cookie)
    if (ban) {
      console.log(
        `[join ${sessionId}] banned ${known ? known.id : 'by device'} · until ${ban.until}`,
      )
      return res.status(403).json(banRefusal(ban))
    }

    // A stranger creates a row — and this is the only place where the room
    // grows from someone else's request. Staff and those returning with their
    // own token pass by.
    if (!known && !staff && (tooManyArrivals(sessionId) || tooManyArrivalsFrom(sessionId, addressOf(req)))) {
      tally('joins')
      // The first refusal in a minute goes in words, the rest as a number in
      // the summary: the load test on five hundred students produced 378 of
      // these in a row, and that is exactly the flood the log is being cured of.
      if (seldom(`arrivals:${sessionId}`)) {
        console.warn(`[join ${sessionId}] refused — more than ${MAX_NEW_PARTICIPANTS} new/min`)
      }
      return res.status(429).json({
        error: tr("server.tooManyPeopleAreJoiningThisSeminar.11739b"),
      })
    }
    const participantId = known ? known.id : newParticipantId()
    /*
     * One line per join — and it is deliberately not counted into the summary.
     *
     * Five hundred joins per class is five hundred lines, and the log can bear
     * that; but without such a line it is impossible to understand from the
     * log why the same person gets created anew. No name, no avatar, no token
     * here: only the room, the participant, the role and which return check
     * failed.
     */
    const how = joinedAs(sessionId, claimed, req.body?.token, proof, known !== null)
    const why = staff ? 'staff' : byHostToken ? 'host-token' : 'link'
    console.log(
      `[join ${sessionId}] ${how === 'back' ? 'back' : 'new'} ${participantId} · ` +
        `${role} by ${why}${how === 'back' ? '' : ` · ${how}`}`,
    )

    /*
     * The mark comes after it is known who joined: one's own past place is
     * not counted as taken (see markToHand). The answer carries the one
     * actually handed out — the join screen saves it as is and draws the
     * cursor with it.
     */
    const avatar = markToHand(sessionId, asked, known?.id ?? null, picked)
    if (avatar) rememberMark(sessionId, participantId, avatar)

    // The host token is the only thing recorded for good: the cookie is
    // reread on every request, and "host by cookie" in the row would be
    // forever.
    const participant = upsertParticipant({
      id: participantId,
      sessionId,
      name,
      avatar,
      role,
      tokenHost: role === 'host' && !staff,
      // The browser's mark — so that a ban on one id also closes the window
      // the same person would come back from as a "new person" a minute later.
      device: deviceOf(req.headers.cookie),
    })
    const token = signToken({ sessionId, participantId, role })

    // Warm the kernel while the student is still reading the page; a failure
    // here is not fatal, the control socket reports kernel health on its own.
    // But only where it will be worked on — see warmsKernel.
    if (warmsKernel(sessionId, role)) {
      void ensureKernel(sessionId).catch((err: unknown) => noteWarmupFailure(sessionId, err))
    }

    const body: JoinResponse = { session, participant, token }
    res.json(body)
  })

  /**
   * Hand your own console over to your own tablet.
   *
   * Lectures are given from an iPad: pages are turned with a finger, written
   * on with the Pencil, and the projector shows what arrives over the
   * network. But for the tablet to become the console, it has to enter the
   * room as THE SAME person with the same rights — and a teacher's rights
   * have exactly two sources, both on another machine: the panel's cookie and
   * the token in its localStorage.
   *
   * This door issues a key for exchange (see signHandoffToken): ten minutes,
   * one exchange. The rights travel in the key itself — either this is a host
   * by their own host token, and then there is nothing to carry, or a host by
   * cookie, and then the key names them: on a tablet without the cookie the
   * very same person would otherwise turn out to be a student, and the
   * lecture under the `board` rule would not be led by them.
   *
   * Said out loud: the key lets someone into the room AS YOU. Whoever opens
   * the link first is the teacher — which is why it lives ten minutes, is
   * spent by the very first exchange, and why the screen that shows it says
   * so plainly.
   */
  router.post('/api/sessions/:id/handoff', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const payload = sessionAuth(req)
    if (!payload) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    if (payload.role !== 'host') {
      return res.status(403).json({ error: tr("server.onlyTheTeacherMaySharePresenterControls.d098fa") })
    }
    const known = getParticipant(sessionId, payload.participantId)
    if (!known) return res.status(404).json({ error: tr("server.participantNotFound.d59506") })
    /*
     * The right moves together with the person, but stays revocable.
     *
     * `tokenHost: true` used to stand here — and it broke the main invariant
     * of roles: a seminar created in the panel has no host token at all, the
     * teacher in it is host only by cookie, and one press of "Console" wrote
     * `token_host` for them forever. Someone removed from staff kept Restart,
     * Clear and Restore in every room where they had ever opened the console —
     * exactly the hole for whose sake the role was made non-permanent.
     *
     * So what travels in the key is not a flag in the database but the
     * teacher's name: the tablet will get a token carrying it, and `roleFor`
     * will ask on every request whether there is such a person on staff. A
     * host by their own host token has nothing to add — they already have
     * `token_host`, and nobody meant to take it away.
     */
    const staff = currentStaff(req)
    const grantedBy = staff?.id ?? payload.staff ?? null
    /*
     * We hand out the address, not the teacher's browser.
     *
     * The console link used to be built from `location.origin`, and a teacher
     * most often opens the room at `http://localhost:3000` — such a link will
     * not open on a tablet at all, even though the seminar is exposed to the
     * outside. The room has nowhere to take `PUBLIC_URL` from, so it travels
     * in the answer; the client then picks one of the two addresses by the
     * same rule as the panel (seminar-link.ts): trust the setting when it
     * names an address that can be opened.
     */
    const body: HandoffResponse = {
      key: signHandoffToken(sessionId, known.id, grantedBy),
      livesMs: HANDOFF_TTL_MS,
      origin: config.publicUrl,
    }
    res.json(body)
  })

  /**
   * The tablet exchanges the key for an ordinary join.
   *
   * The answer has the same shape as `/join`'s: from here on the tablet is no
   * different from anyone who joined — the same token, the same identity in
   * localStorage, the same socket. It does not ask for a name and cannot: the
   * person is already known here, and asking them to introduce themselves
   * again would mean creating a second one.
   */
  router.post('/api/sessions/:id/handoff/claim', (req, res) => {
    const sessionId = req.params.id
    const session = getSession(sessionId)
    if (!session) return res.status(404).json({ error: SESSION_MISSING })
    // Spent right here: the key is promised for one exchange, and that promise
    // holds only because a second exchange of the same key is refused.
    const who = spendHandoffToken(sessionId, req.body?.key)
    if (!who) {
      return res.status(401).json({ error: tr("server.thisPresenterLinkIsInvalidOrHas.0f5b09") })
    }
    const known = getParticipant(sessionId, who.participantId)
    if (!known) return res.status(404).json({ error: tr("server.participantNotFound.d59506") })
    // The role in the row is for the badge in the list; `token_host` is left
    // alone: a host by their own key already has it, and a host by cookie must
    // not get it.
    const participant = upsertParticipant({
      id: known.id,
      sessionId,
      name: known.name,
      avatar: known.avatar,
      role: 'host',
    })
    const body: JoinResponse = {
      session,
      participant,
      token: signToken({
        sessionId,
        participantId: known.id,
        role: 'host',
        ...(who.staff ? { staff: who.staff } : {}),
      }),
    }
    res.json(body)
  })

  /**
   * The room's rules — from the room itself.
   *
   * Without this door the model exists but there is nothing to configure it
   * with: the panel sets rules only at creation, and a host by host token
   * never goes to the panel at all — the seminar may be entirely theirs,
   * while the rules in it cannot be changed.
   *
   * What is sent is laid over the current rules rather than replacing them: a
   * screen that touches one switch must not be able to silently reset the
   * rest to defaults.
   *
   * A finished class does not close this door: the teacher prepares the next
   * class in the same room, and the rules are a choice that the end of class
   * tightens on top without rewriting it (shared/rules.ts · rulesAfterClass).
   * That is also why they are laid over `storedRules`: had the check taken the
   * effective rules, a single press in the middle of a finished class would
   * have written "everything to the teacher" for good.
   */
  router.patch('/api/sessions/:id/rules', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    const payload = sessionAuth(req)
    if (!payload) return res.status(401).json({ error: tr("server.joinTheSessionFirst.442dd6") })
    if (payload.role !== 'host') {
      return res.status(403).json({ error: tr("server.onlyTheTeacherMayChangeThisSeminar.a9e299") })
    }
    const incoming: unknown = req.body?.rules
    if (typeof incoming !== 'object' || incoming === null) {
      return res.status(400).json({ error: tr("server.rulesMustBeAnObject.c2a9d1") })
    }
    /*
     * The personal-notebook numbers are measured against the machine — by the
     * same yardstick as the class's own memory.
     *
     * `readRules` sanitizes them for any input and clamps them to reasonable
     * bounds, but it knows nothing about docker or about this machine's
     * memory: it is shared with the browser. Here a number the machine will
     * not give is rejected in words — otherwise the container would simply
     * fail to come up in the middle of a class, and nothing would tie that to
     * the press.
     */
    const asked = incoming as Record<string, unknown>
    if ('ownMemoryMb' in asked && asked.ownMemoryMb !== null) {
      const read = readMemoryInput(asked.ownMemoryMb)
      if (!read.ok) return res.status(400).json({ error: tr('server.rules.ownMemoryRefused') })
    }
    if ('ownCpus' in asked && asked.ownCpus !== null) {
      const read = readCpuInput(asked.ownCpus)
      if (!read.ok) return res.status(400).json({ error: tr('server.rules.ownCpusRefused') })
    }
    const rules = setRules(sessionId, readRules({ ...storedRules(sessionId), ...incoming }))
    /*
     * What the personal notebooks are allotted goes to their container, and
     * right now: the teacher chose a number in the middle of a class and
     * expects it to take effect, not after the class is closed some day. This
     * path does not touch the room's container.
     */
    void applyOwnLimits(sessionId).catch(() => {})
    /*
     * A notebook's access decides which container its kernel lives in: a
     * personal one has its own, without the class's GPU (shared/rules.ts ·
     * bookHasOwnKernel). A live process cannot be moved — so the kernel of a
     * notebook whose access changed is shut down, and the room reads about it
     * in a line of the kernel log.
     */
    syncBookKernels(sessionId)
    /*
     * And the guard against dangerous commands — into every live kernel of the
     * class right away.
     *
     * It lives as substitutions INSIDE the kernel process, not as a check on
     * the server, so it will not learn the new rule by itself: having flipped
     * the switch to show `os._exit` in a Python course, the teacher expects
     * the very next cell to show it, not the next class. The reverse matters
     * more: having turned the guard on in the middle of a class, they expect
     * it to be in effect already.
     */
    syncDangerGuard(sessionId)
    /*
     * The room learns now, not at the next reload: the interface disables
     * buttons by this, and a rule nobody announced looks like a breakage — a
     * button stopped working and nobody knows why.
     *
     * What travels is the chosen rules, not the effective ones: the room
     * applies the end of class itself (web/src/lib/may.ts), and sending it the
     * already tightened value would show the teacher, in the settings, a
     * choice that is not theirs.
     */
    broadcast(sessionId, { t: 'rules', rules })
    res.json({ rules })
  })

  router.get('/api/sessions/:id/participants', (req, res) => {
    const sessionId = req.params.id
    if (!getSession(sessionId)) return res.status(404).json({ error: SESSION_MISSING })
    /*
     * `participants` is everyone who has ever come in; `online` is who is in
     * the room now. The join screen needs the second, to say "three are
     * already inside" and not count the cohort before last.
     *
     * And that is exactly why someone who has not joined gets only the
     * second. The seminar link is eight characters read out loud; it opens
     * the room, and that is intended, but it must not list by name the whole
     * course that attended it all semester. Someone already inside sees the
     * whole list: they see these people's cursors anyway.
     */
    const online = onlineParticipantIds(sessionId)
    const everyone = listParticipants(sessionId)
    if (sessionAuth(req)) return res.json({ participants: everyone, online })
    const inside = new Set(online)
    res.json({
      participants: everyone.filter((p) => inside.has(p.id)),
      online,
    })
  })

  router.get('/api/sessions/:id/link', (req, res) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: SESSION_MISSING })
    res.json({ url: `${config.publicUrl}/s/${req.params.id}` })
  })

  return router
}

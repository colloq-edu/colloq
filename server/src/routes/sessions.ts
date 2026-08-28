import { Router, type Request } from "express";
import { currentStaff, staffFromCookieHeader } from "../admin/auth.js";
import {
  newParticipantId,
  newSessionId,
  signHostToken,
  signToken,
  type TokenPayload,
  verifyHostToken,
  verifyToken,
} from "../auth.js";
import { config } from "../config.js";
import {
  createSession,
  getParticipant,
  getRules,
  getSession,
  isTokenHost,
  listParticipants,
  setRules,
  upsertParticipant,
} from "../db.js";
import { onlineParticipantIds } from "../collab/index.js";
import { ensureKernel } from "../kernel/index.js";
import { clearTerminal, closeTerminal } from "../kernel/terminal.js";
import { broadcast } from "../control.js";
import { readRules } from "@shared/rules";
import { setSeminarCreator } from "./admin-instance.js";
import type { AdminErrorBody } from "@shared/admin";
import type {
  CreateSessionResponse,
  JoinResponse,
  ParticipantRole,
} from "@shared/protocol";

/*
 * Lengths that have to survive being drawn, not just stored. A seminar name is
 * a display heading and a person's name sits in a cell footer and an avatar
 * tooltip, so both are cut where the layout stops coping rather than where the
 * column would. The avatar is one emoji, and 512 UTF-16 code units is
 * room for the longest of them — flags and family sequences run long.
 */
const MAX_SESSION_NAME = 80;
const MAX_PARTICIPANT_NAME = 40;
const MAX_AVATAR = 512;

/** Collapse whitespace and drop control characters so a name cannot break the roster layout. */
function normalize(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  const header = req.headers.authorization ?? "";
  /*
   * Header only. The query string used to be accepted here as well, for the
   * one route that needs it — a download is an `<a href download>` and an
   * anchor cannot send a header — but accepting it everywhere meant the string
   * that opens the control socket travelled in a URL a teacher could copy into
   * a group chat. The download route has its own short-lived credential now
   * (signDownloadToken); this one takes a header and nothing else.
   */
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const payload = verifyToken(raw);
  if (!payload || payload.sessionId !== req.params.id) return null;
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
  return { ...payload, role: roleFor(req.headers.cookie, payload) };
}

/**
 * Кто это — на этот запрос, а не на момент входа.
 *
 * Одна функция на оба входа нарочно. Их было две, и они отвечали по-разному:
 * HTTP помнил выданные хост-токены в множестве в памяти, а сокет про это
 * множество не знал вовсе — так что автор семинара, заведённого скриптом,
 * получал `host` на кнопках и `participant` на соединении, которым эти кнопки
 * работают. Расходиться им теперь негде.
 */
export function roleFor(
  cookieHeader: string | undefined,
  payload: Pick<TokenPayload, "sessionId" | "participantId">,
): TokenPayload["role"] {
  // Кука сильнее и проверяется первой: её можно отобрать, и в этом смысл.
  if (staffFromCookieHeader(cookieHeader)) return "host";
  return isTokenHost(payload.sessionId, payload.participantId)
    ? "host"
    : "participant";
}

export function sessionRoutes(): Router {
  const router = Router();

  router.post("/api/sessions", (req, res) => {
    // Who may open a room. An instance with OPEN_SEMINAR_CREATION off is one
    // where a visitor spinning up a seminar would be spending the owner's API
    // key, so staff are the only ones left; the students who matter here arrive
    // through /join with a link and never touch this route.
    const staff = currentStaff(req);
    if (!config.openSeminarCreation && !staff) {
      const denied: AdminErrorBody = {
        error:
          "Only staff can create a seminar on this instance. Ask for a link to the one you are joining.",
        reason: "forbidden",
      };
      return res.status(403).json(denied);
    }

    const name = normalize(req.body?.name);
    if (!name)
      return res.status(400).json({ error: "a session name is required" });
    if (name.length > MAX_SESSION_NAME) {
      return res
        .status(400)
        .json({
          error: `session name must be ${MAX_SESSION_NAME} characters or fewer`,
        });
    }

    const id = newSessionId();
    const session = createSession(id, name);
    // A seminar created straight against this endpoint by a signed-in teacher
    // is still theirs. There is no page that does it — the panel has its own
    // route — so this is the scripted path, and on an open instance it produces
    // a seminar with nobody's name on it.
    if (staff) setSeminarCreator(id, staff.name);
    const body: CreateSessionResponse = {
      session,
      hostToken: signHostToken(id),
    };
    res.status(201).json(body);
  });

  router.get("/api/sessions/:id", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "session not found" });
    res.json(session);
  });

  router.post("/api/sessions/:id/join", (req, res) => {
    const sessionId = req.params.id;
    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: "session not found" });

    const name = normalize(req.body?.name).slice(0, MAX_PARTICIPANT_NAME);
    if (!name) return res.status(400).json({ error: "a name is required" });

    const rawAvatar = req.body?.avatar;
    const avatar =
      typeof rawAvatar === "string" &&
      rawAvatar.length > 0 &&
      rawAvatar.length <= MAX_AVATAR
        ? rawAvatar
        : null;

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
    const staff = currentStaff(req);
    const role: ParticipantRole =
      staff || verifyHostToken(sessionId, req.body?.hostToken)
        ? "host"
        : "participant";

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
    const claimed =
      typeof req.body?.participantId === "string"
        ? req.body.participantId
        : null;
    const proof = verifyToken(
      typeof req.body?.token === "string" ? req.body.token : null,
    );
    const proved =
      claimed !== null &&
      proof !== null &&
      proof.sessionId === sessionId &&
      proof.participantId === claimed;
    const known = proved ? getParticipant(sessionId, claimed) : null;
    const participantId = known ? known.id : newParticipantId();

    // Хост-токен — единственное, что записывается насовсем: куку перечитывают
    // на каждом запросе, и «ведущий по куке» в строке был бы навсегда.
    const participant = upsertParticipant({
      id: participantId,
      sessionId,
      name,
      avatar,
      role,
      tokenHost: role === "host" && !staff,
    });
    const token = signToken({ sessionId, participantId, role });

    // Warm the kernel while the student is still reading the page; a failure
    // here is not fatal, the control socket reports kernel health on its own.
    void ensureKernel(sessionId).catch((err: unknown) => {
      console.warn(
        `[session ${sessionId}] kernel warmup failed:`,
        err instanceof Error ? err.message : err,
      );
    });

    const body: JoinResponse = { session, participant, token };
    res.json(body);
  });

  /**
   * Правила комнаты — из самой комнаты.
   *
   * Без этой двери модель есть, а настроить её нечем: панель задаёт правила
   * только при создании, а ведущий по хост-токену в панель вообще не ходит —
   * семинар может быть целиком его, а правила в нём неизменяемы.
   *
   * Присланное накладывается на текущее, а не заменяет его: экран, который
   * трогает один переключатель, не должен уметь молча вернуть остальные к
   * умолчаниям.
   */
  router.patch("/api/sessions/:id/rules", (req, res) => {
    const sessionId = req.params.id;
    if (!getSession(sessionId))
      return res.status(404).json({ error: "session not found" });
    const payload = sessionAuth(req);
    if (!payload)
      return res.status(401).json({ error: "join the session first" });
    if (payload.role !== "host") {
      return res
        .status(403)
        .json({ error: "Правила этого семинара задаёт преподаватель." });
    }
    const incoming: unknown = req.body?.rules;
    if (typeof incoming !== "object" || incoming === null) {
      return res.status(400).json({ error: "rules must be an object" });
    }
    const rules = setRules(
      sessionId,
      readRules({ ...getRules(sessionId), ...incoming }),
    );
    /*
     * Комната узнаёт сейчас, а не при следующей перезагрузке: интерфейс гасит
     * по этому кнопки, и правило, о котором не сказали, выглядит как поломка —
     * кнопка перестала работать и никто не знает почему.
     */
    broadcast(sessionId, { t: "rules", rules });
    // «Терминала нет» — обещание про комнату: открытую оболочку надо закрыть,
    // иначе половина обещания.
    if (rules.terminal === "off") {
      clearTerminal(sessionId);
      void closeTerminal(sessionId).catch(() => {
        /* закрывать было нечего */
      });
    }
    res.json({ rules });
  });

  router.get("/api/sessions/:id/participants", (req, res) => {
    const sessionId = req.params.id;
    if (!getSession(sessionId))
      return res.status(404).json({ error: "session not found" });
    /*
     * `participants` — все, кто когда-либо заходил; `online` — кто в комнате
     * сейчас. Экрану входа нужно второе, чтобы сказать «трое уже внутри» и не
     * посчитать позапрошлый поток.
     *
     * И ровно поэтому не вошедшему отдаётся только второе. Ссылка на семинар —
     * восемь символов, которые читают вслух; она открывает комнату, и это
     * задумано, но она не должна перечислять поимённо весь курс, ходивший на
     * него весь семестр. Тот, кто уже внутри, видит список целиком: он и так
     * видит их курсоры.
     */
    const online = onlineParticipantIds(sessionId);
    const everyone = listParticipants(sessionId);
    if (sessionAuth(req)) return res.json({ participants: everyone, online });
    const inside = new Set(online);
    res.json({
      participants: everyone.filter((p) => inside.has(p.id)),
      online,
    });
  });

  router.get("/api/sessions/:id/link", (req, res) => {
    if (!getSession(req.params.id))
      return res.status(404).json({ error: "session not found" });
    res.json({ url: `${config.publicUrl}/s/${req.params.id}` });
  });

  return router;
}

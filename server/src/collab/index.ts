import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import type { Awareness } from "y-protocols/awareness";
import { WebSocket, type RawData } from "ws";
import type { YCell } from "@shared/notebook";
import {
  clearStaleExecution,
  createTerminalLine,
  ensureInitialNotebook,
  getCells,
  getMeta,
  getTerminal,
} from "@shared/notebook";
import type { AwarenessUser, ParticipantRole } from "@shared/protocol";
import { getRules, getSession, renameSession } from "../db.js";
import { classify, permits } from "./gate.js";
import {
  forgetSession,
  rememberDeleted,
  rememberedIn,
  resetRetyped,
  settleFresh,
} from "./ops.js";
import {
  bindPersistence,
  flushPersistence,
  discardPersistence,
  flushAllPersistence,
} from "./persistence.js";
import {
  RESTORE_ORIGIN,
  beginHistory,
  discardBurst,
  flushAllHistory,
  record,
} from "./history.js";

/**
 * Происхождение для записи, которую сервер делает от чьего-то имени.
 *
 * `onBehalfOf(id)` в транзакции — и версия в истории подписана этим человеком,
 * а не «комнатой». Составить такую строку может только код на сервере:
 * обновление от клиента приходит с сокетом в качестве происхождения.
 */
const BEHALF_PREFIX = "on-behalf:";

/**
 * Записать в документ комнаты от имени человека, а не от имени сервера.
 *
 * Вложенная `doc.transact` присоединяется к внешней, и происхождение остаётся
 * внешним — поэтому обёртка работает даже вокруг кода, который заводит свою
 * транзакцию сам (а `acceptPatch` именно такой).
 */
export function applyOnBehalf(
  sessionId: string,
  participantId: string,
  write: () => void,
): void {
  const { doc } = getSessionDoc(sessionId);
  doc.transact(write, `${BEHALF_PREFIX}${participantId}`);
}

/**
 * The server side of the collaborative document.
 *
 * This speaks the y-websocket wire protocol (the browser uses the stock
 * `WebsocketProvider`), but it is not a dumb relay: the server holds the
 * authoritative Y.Doc in memory and is a first-class writer. The kernel runtime
 * appends execution output straight into that doc, which is how results reach
 * everyone — including whoever opens the link two minutes later.
 */

/** y-websocket's own frame tags. The numbers are the protocol, not a choice. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/*
 * Under the thirty seconds that proxies and load balancers commonly use as an
 * idle timeout. A seminar has long silences — nobody types while the teacher
 * talks — and a socket dropped for being quiet looks to the room like the
 * server going away.
 */
const PING_INTERVAL_MS = 25_000;
/** A socket that ignores this many consecutive pings is a closed laptop lid. */
const MAX_MISSED_PONGS = 2;

export interface SessionDoc {
  sessionId: string;
  doc: Y.Doc;
  awareness: Awareness;
}

/** Marks a write as the server's own, so its observers do not chase themselves. */
const ORIGIN = "server";

interface ConnState {
  /**
   * Who is on the other end.
   *
   * The history needs an author for every change, and the update bytes cannot
   * give one: an insertion carries the Yjs client that made it, but a deletion
   * carries the client whose text was deleted — the victim, not the author. The
   * socket knows, because the token said so when it connected.
   */
  participantId: string | null;
  /** Awareness clientIDs this socket introduced, so we can retract exactly those. */
  clientIds: Set<number>;
  missedPongs: number;
  pingTimer: NodeJS.Timeout;
  /**
   * The role the token carried. The document is shared and every field in it is
   * writable by anyone connected — that is what a CRDT is — so this is not an
   * access list. It is here for the one field the interface already promises is
   * the host's: the seminar's name.
   */
  role: ParticipantRole;
}

interface DocEntry extends SessionDoc {
  conns: Map<WebSocket, ConnState>;
  dispose: () => void;
}

const docs = new Map<string, DocEntry>();

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data);
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
  }
  const buf = data as Buffer;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function send(entry: DocEntry, conn: WebSocket, message: Uint8Array): void {
  if (
    conn.readyState !== WebSocket.CONNECTING &&
    conn.readyState !== WebSocket.OPEN
  ) {
    closeConn(entry, conn);
    return;
  }
  try {
    conn.send(message, (err) => {
      if (err) closeConn(entry, conn);
    });
  } catch {
    closeConn(entry, conn);
  }
}

function closeConn(entry: DocEntry, conn: WebSocket): void {
  const state = entry.conns.get(conn);
  if (!state) return;
  entry.conns.delete(conn);
  clearInterval(state.pingTimer);
  // Without this the People panel keeps showing whoever just walked out.
  awarenessProtocol.removeAwarenessStates(
    entry.awareness,
    Array.from(state.clientIds),
    null,
  );
  try {
    conn.close();
  } catch {
    /* already gone */
  }
}

function broadcastDocUpdate(
  entry: DocEntry,
  update: Uint8Array,
  origin: unknown,
): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  for (const conn of entry.conns.keys()) {
    // Origin is a connection only for edits that arrived on it; server-side
    // writes (kernel output, AI edits) carry another origin and go to everyone.
    if (conn === origin) continue;
    send(entry, conn, message);
  }
}

function broadcastAwareness(entry: DocEntry, clients: number[]): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(entry.awareness, clients),
  );
  const message = encoding.toUint8Array(encoder);
  for (const conn of entry.conns.keys()) send(entry, conn, message);
}

/**
 * The document for a session, created on first use.
 *
 * Seeding happens here rather than in the browser: this runs once, under a
 * single writer, before anyone can connect. Two students tapping the link at
 * the same instant would otherwise each seed the starter cells into their own
 * copy and the merge would show both.
 */
export function getSessionDoc(sessionId: string, title?: string): SessionDoc {
  return getEntry(sessionId, title);
}

function getEntry(sessionId: string, title?: string): DocEntry {
  const existing = docs.get(sessionId);
  if (existing) return existing;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  // The server is a writer, not a person in the room.
  awareness.setLocalState(null);

  const entry: DocEntry = {
    sessionId,
    doc,
    awareness,
    conns: new Map(),
    dispose: bindPersistence(sessionId, doc),
  };
  docs.set(sessionId, entry);

  /*
   * Start the history from what was just hydrated, before the seeding below.
   * A brand-new room therefore records its starter cells as its first version,
   * and a room coming back after a restart does not record its whole notebook
   * as somebody's edit.
   */
  beginHistory(sessionId, doc);

  /*
   * Seed, then put it on disk before returning. A room that has just been
   * created is at its most vulnerable: the snapshot is debounced by seconds and
   * the room is reachable immediately, so a crash in between leaves a seminar
   * with a row and no document. On the way back the server would find nothing
   * stored, conclude the room is new and seed it again — and the students, who
   * still hold the real notebook, would merge it in underneath a second copy of
   * the starter cells. Encoding a two-cell document costs less than the
   * scheduling does.
   */
  if (ensureInitialNotebook(doc, title ?? getSession(sessionId)?.name)) {
    flushPersistence(sessionId);
  }

  /*
   * Whatever the snapshot says was running, was not running by the time this
   * process existed. Cleared here rather than by the kernel, because a room can
   * be reopened without a kernel ever being asked for one — the notebook has to
   * be honest before anybody presses anything.
   */
  if (clearStaleExecution(doc) > 0) {
    doc.transact(() => {
      getTerminal(doc).push([
        createTerminalLine({
          kind: "system",
          text: "The server restarted. Cells that were running or queued were put back to rest — run them again when you are ready.",
        }),
      ]);
    }, ORIGIN);
  }

  /*
   * A cell id appears once.
   *
   * Y.Array has no move, so the editor moves a cell by cloning it and deleting
   * the original. Two people nudging the same cell at the same moment merge
   * into two deletes — which collapse into one — and two inserts, which do not:
   * the notebook ends up holding the same cell twice, under one id. Everything
   * downstream is keyed by that id — running it, attributing it, asking the
   * oracle about it — so a duplicate is not a cosmetic problem.
   *
   * Repaired here rather than in the editor for the reason the title is: there
   * is exactly one server, and it cannot be a stale client racing another. The
   * first copy stays, later ones go; they are copies of each other, so which
   * one survives does not matter, only that the choice is the same everywhere.
   */
  const cells = getCells(doc);
  cells.observe((event: Y.YArrayEvent<YCell>) => {
    if (event.transaction.origin === ORIGIN) return;
    // Only an insert can introduce one, and the array is tens of items long.
    if (!event.changes.added.size) return;
    const seen = new Set<string>();
    const doomed: number[] = [];
    cells.forEach((cell, index) => {
      const id = cell.get("id");
      if (typeof id !== "string") return;
      if (seen.has(id)) doomed.push(index);
      else seen.add(id);
    });
    if (doomed.length === 0) return;
    doc.transact(() => {
      // Back to front, so the earlier indices stay valid as they go.
      for (const index of doomed.reverse()) cells.delete(index, 1);
    }, ORIGIN);
  });

  /*
   * The room's title is the seminar's name, and the admin list reads it from the
   * sessions row. Mirror one into the other so a rename — from the header or
   * from the panel — is one name and not two.
   *
   * Observed rather than written by whoever renamed: there is exactly one
   * writer this way, and it is the server, which cannot be a stale client.
   */
  const meta = getMeta(doc);
  meta.observe((event: Y.YMapEvent<unknown>) => {
    if (!event.keysChanged.has("title")) return;
    if (event.transaction.origin === ORIGIN) return;

    /*
     * The header lets only the host rename the room, and this mirrors the name
     * into the row the admin list reads — so a rename written straight into the
     * shared document by anyone else would reach further than the interface it
     * came from. Put it back rather than pass it on.
     *
     * This is the one field defended this way. Everything else in the document
     * is writable by everyone by construction, which the README says out loud.
     */
    const from = event.transaction.origin;
    const writer =
      from instanceof WebSocket ? entry.conns.get(from) : undefined;
    if (writer && writer.role !== "host") {
      const previous = event.changes.keys.get("title")?.oldValue;
      doc.transact(() => {
        if (typeof previous === "string") meta.set("title", previous);
        else meta.delete("title");
      }, ORIGIN);
      return;
    }

    const title = meta.get("title");
    if (typeof title !== "string" || !title.trim()) return;
    if (getSession(sessionId)?.name === title) return;
    renameSession(sessionId, title);
  });

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    broadcastDocUpdate(entry, update, origin);
    /*
     * The author comes from the origin, which for anything a person did is the
     * socket it arrived on. The server's own writes — seeding a new room,
     * importing from GitHub, the kernel writing an output — have no author, and
     * that is honest: nobody in the room typed them.
     *
     * A restore is skipped here and recorded by the restore itself, under the
     * name of whoever pressed the button.
     */
    if (origin === RESTORE_ORIGIN) return;
    /*
     * Автор берётся из происхождения обновления.
     *
     * Обычно это сокет, по которому оно пришло. Но сервер и сам иногда пишет в
     * документ от чьего-то имени — сейчас так применяется предложение оракула:
     * решение принимает сервер, чтобы две вкладки не вписали патч дважды, и
     * без этой ветки версия в истории оказывалась ничьей. Строка «принял
     * Пётр» превращалась в «the room», а Ctrl+Z у самого Петра переставал
     * доставать до его же собственной правки.
     *
     * Форма — `on-behalf:<participantId>`: строка, которую может составить
     * только код на сервере, потому что клиентское обновление приходит с
     * сокетом в качестве происхождения и никогда со строкой.
     */
    const author =
      origin instanceof WebSocket
        ? (entry.conns.get(origin)?.participantId ?? null)
        : typeof origin === "string" && origin.startsWith(BEHALF_PREFIX)
          ? origin.slice(BEHALF_PREFIX.length)
          : null;
    record(sessionId, doc, update, author);
  });

  awareness.on(
    "update",
    (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const state =
        origin instanceof WebSocket ? entry.conns.get(origin) : undefined;
      if (state) {
        for (const id of changes.added) state.clientIds.add(id);
        for (const id of changes.removed) state.clientIds.delete(id);
        /*
         * Before the relay, not after. Awareness is whatever the client says
         * it is — that is the point of it, and why a caret can carry a colour.
         * But `role` is not a preference: the People panel draws a Host badge
         * from it, and one edit to localStorage put a second teacher in front
         * of the room. The server knows the real role for this socket, so it
         * corrects the state and then broadcasts the corrected one. The forger
         * still lies to their own screen; nobody else hears it.
         */
        pinRole(entry, state, changes.added.concat(changes.updated));
      }
      broadcastAwareness(
        entry,
        changes.added.concat(changes.updated, changes.removed),
      );
    },
  );

  return entry;
}

/**
 * Подтипы протокола синхронизации. Числа — сам протокол, а не выбор.
 *
 * `1` (step2) и `2` (update) проверяются одинаково. Проверять только `2` — дыра
 * шириной в одно переподключение: сервер шлёт step1 при каждом соединении,
 * браузер отвечает step2 всем, чего у сервера нет, и любой отказ отмывается
 * повторным входом.
 */
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

/**
 * Отказать этому соединению в кадре.
 *
 * Закрытие, а не молчание. Ничто в протоколе синхронизации не умеет убрать у
 * клиента структуру, которая у него уже есть: слияние CRDT — объединение, и
 * ни `encodeStateAsUpdate`, ни полный круг step1/step2 не уберут отказанный
 * текст с экрана того, кто его набрал. Поэтому клиент, получивший 4403,
 * пересобирает документ с нуля — и новый clientID заодно лечит разрыв в
 * тактах, из-за которого следующее разрешённое нажатие иначе легло бы в
 * `pendingStructs` за тактом, который сервер не принял.
 */
function refuse(
  entry: DocEntry,
  conn: WebSocket,
  refusal: { rule: "structure" | "edit" | "title"; message: string },
): void {
  const state = entry.conns.get(conn);
  if (state?.participantId && refusalListener) {
    refusalListener(entry.sessionId, state.participantId, refusal);
  }
  try {
    conn.close(4403, refusal.rule);
  } catch {
    /* сокет уже закрыт — отказ всё равно состоялся: кадр не применён */
  }
}

type RefusalListener = (
  sessionId: string,
  participantId: string,
  refusal: { rule: "structure" | "edit" | "title"; message: string },
) => void;

let refusalListener: RefusalListener | null = null;

/**
 * Кому сообщать словами об отказе. Регистрирует `control.ts`: сообщение уходит
 * по управляющему сокету, а импортировать его отсюда значило бы замкнуть цикл.
 */
export function onRefusal(listener: RefusalListener): void {
  refusalListener = listener;
}

/**
 * Сколько лиц одно соединение может завести в комнате.
 *
 * Одно на вкладку — норма; вторым бывает переход между провайдерами при
 * переподключении. Четыре — потолок с запасом, а без потолка один сокет
 * наполняет панель людей выдуманными участниками, у каждого из которых имя,
 * цвет и курсор в чужой ячейке.
 */
const MAX_AWARENESS_CLIENTS = 4;

/**
 * Кадр присутствия — только про себя.
 *
 * `applyAwarenessUpdate` принимает состояние ЛЮБОГО clientID, лишь бы такт был
 * выше: то есть один участник мог убрать всех остальных из панели людей для
 * всей комнаты или переписать чужой курсор вместе с именем и ролью. Сокет
 * знает, кого он привёл (`state.clientIds`), — и всё остальное отвергается.
 *
 * Отвергается кадр целиком, а не по одному лицу: у пакета присутствия нет
 * способа выкинуть из середины одну запись, и разбирать его на части значило бы
 * пересобирать его же протокол.
 */
export function ownAwareness(
  entry: Pick<DocEntry, "conns" | "awareness">,
  conn: WebSocket,
  payload: Uint8Array,
): boolean {
  const state = entry.conns.get(conn);
  if (!state) return false;
  const decoder = decoding.createDecoder(payload);
  const count = decoding.readVarUint(decoder);
  for (let i = 0; i < count; i += 1) {
    const clientId = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder); // такт — не наше дело
    decoding.readVarString(decoder); // само состояние тоже
    if (state.clientIds.has(clientId)) continue;
    // Новое лицо этого сокета — можно, пока их не слишком много.
    if (state.clientIds.size + 1 > MAX_AWARENESS_CLIENTS) return false;
    if (entry.awareness.getStates().has(clientId)) return false;
    state.clientIds.add(clientId);
  }
  return true;
}

function handleMessage(
  entry: DocEntry,
  conn: WebSocket,
  data: Uint8Array,
): void {
  try {
    const decoder = decoding.createDecoder(data);
    const encoder = encoding.createEncoder();
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        /*
         * Проверка до применения, и позже её поставить некуда: ретрансляция,
         * запись в историю и запись на диск висят синхронно внутри
         * `applyUpdate` внутри `readSyncMessage`. Подтип читается с копии
         * декодера, чтобы настоящий остался нетронутым, если кадр принят.
         */
        const peek = decoding.clone(decoder);
        const subtype = decoding.readVarUint(peek);
        let accepted: { retyped: string[]; created: string[] } | null = null;
        if (subtype === SYNC_STEP2 || subtype === SYNC_UPDATE) {
          const state = entry.conns.get(conn);
          const judgement = classify(
            entry.doc,
            decoding.readVarUint8Array(peek),
            rememberedIn(entry.sessionId),
          );
          if (!judgement.ok) {
            // Пол комнаты: это не право, а то, что сервер пишет сам.
            return refuse(entry, conn, {
              rule: "edit",
              message: floorMessage(judgement.why),
            });
          }
          const verdict = permits(
            judgement.verdicts,
            getRules(entry.sessionId),
            state?.role ?? "participant",
          );
          if (!verdict.ok) return refuse(entry, conn, verdict);
          /*
           * Запомнить ДО применения: после него читать уже нечего, а без этого
           * Ctrl+Z вернул бы ячейку без вывода — Yjs отменяет удаление копией,
           * и вывод в копии пришлось бы взять у браузера, чего пол не разрешает.
           */
          rememberDeleted(entry.sessionId, entry.doc, judgement.removed);
          accepted = judgement;
        }
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, entry.doc, conn);
        if (accepted) {
          const { retyped, created } = accepted;
          if (retyped.length > 0 || created.length > 0) {
            entry.doc.transact(() => {
              resetRetyped(entry.doc, retyped);
              settleFresh(entry.sessionId, entry.doc, created);
            }, ORIGIN);
          }
        }
        // A bare message type and nothing after it means there is nothing to say.
        if (encoding.length(encoder) > 1)
          send(entry, conn, encoding.toUint8Array(encoder));
        break;
      }
      case MESSAGE_AWARENESS: {
        const payload = decoding.readVarUint8Array(decoder);
        if (!ownAwareness(entry, conn, payload)) break;
        awarenessProtocol.applyAwarenessUpdate(entry.awareness, payload, conn);
        break;
      }
    }
  } catch (err) {
    /*
     * Отказ, а не проглатывание.
     *
     * Раньше здесь стояло «одному кривому кадру стоить сокету сообщения, а не
     * семинару» — и это верно ровно до появления проверки: проглотить кадр
     * синхронизации значит навсегда и молча онеметь, потому что клиент считает
     * его доставленным и никогда не повторит. Развалившаяся проверка обязана
     * отказывать, иначе она выполняется после того, как перестала смотреть.
     */
    console.error(`[collab] bad message in ${entry.sessionId}`, err);
    refuse(entry, conn, {
      rule: "edit",
      message: "Правку не удалось разобрать — она не отправлена.",
    });
  }
}

/**
 * Слова для отказа по полу комнаты — то есть не по правилу, а по тому, что
 * сервер пишет сам. Человеку незачем знать про пути внутри документа.
 */
function floorMessage(why: string): string {
  return `Эта правка не принята: ${why}.`;
}

/**
 * Force this connection's awareness role back to what the socket was opened
 * with. Cheap: one map lookup per awareness frame, and awareness frames are
 * already the chattiest thing on this wire.
 */
function pinRole(entry: DocEntry, state: ConnState, clientIds: number[]): void {
  if (!state.participantId) return;
  for (const clientId of clientIds) {
    const local = entry.awareness.getStates().get(clientId) as
      | { user?: { id?: string; role?: ParticipantRole } }
      | undefined;
    const user = local?.user;
    if (!user) continue;
    if (user.id === state.participantId && user.role === state.role) continue;
    entry.awareness.states.set(clientId, {
      ...local,
      user: { ...user, id: state.participantId, role: state.role },
    });
  }
}

export function handleCollabSocket(
  ws: WebSocket,
  sessionId: string,
  role: ParticipantRole = "participant",
  participantId: string | null = null,
): void {
  const entry = getEntry(sessionId);
  ws.binaryType = "arraybuffer";

  const state: ConnState = {
    role,
    participantId,
    clientIds: new Set<number>(),
    missedPongs: 0,
    pingTimer: setInterval(() => {
      if (state.missedPongs >= MAX_MISSED_PONGS) {
        closeConn(entry, ws);
        ws.terminate();
        return;
      }
      state.missedPongs++;
      try {
        ws.ping();
      } catch {
        closeConn(entry, ws);
        ws.terminate();
      }
    }, PING_INTERVAL_MS),
  };
  entry.conns.set(ws, state);

  ws.on("pong", () => {
    state.missedPongs = 0;
  });
  ws.on("message", (data: RawData) =>
    handleMessage(entry, ws, toUint8Array(data)),
  );
  ws.on("close", () => closeConn(entry, ws));
  ws.on("error", () => closeConn(entry, ws));

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, entry.doc);
  send(entry, ws, encoding.toUint8Array(encoder));

  const states = entry.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(
        entry.awareness,
        Array.from(states.keys()),
      ),
    );
    send(entry, ws, encoding.toUint8Array(awarenessEncoder));
  }
}

/** Open sockets, not distinct people — a second tab counts twice. */
export function onlineCount(sessionId: string): number {
  return docs.get(sessionId)?.conns.size ?? 0;
}

/**
 * The participant ids actually present right now, deduplicated.
 *
 * Not the same as onlineCount, which counts sockets: one person with the
 * seminar open in two tabs is two connections and one participant. And not the
 * same as the participants table either, which is every name that ever joined —
 * the join screen said "148 people are already inside" about a room holding one,
 * because that table never forgets.
 */
export function onlineParticipantIds(sessionId: string): string[] {
  const entry = docs.get(sessionId);
  if (!entry) return [];
  const ids = new Set<string>();
  for (const state of entry.awareness.getStates().values()) {
    /*
     * Typed against the shared contract on purpose. This read used to be a
     * hand-written `{ user?: { participantId?: unknown } }`, and the field the
     * browser actually publishes is `id` — so every real page was invisible
     * here and the room's online list came back empty for everybody, while the
     * test client, which happened to send `participantId`, showed thirty. An
     * inline cast asserts what you meant; the shared type is what is true.
     *
     * One person can hold several of these — two tabs, or a reconnect whose old
     * socket has not timed out — so the set is by participant, not by socket.
     */
    const user = (state as { user?: Partial<AwarenessUser> } | undefined)?.user;
    if (typeof user?.id === "string" && user.id) ids.add(user.id);
  }
  return Array.from(ids);
}

/**
 * Evict a session's document for good: used when the seminar itself is deleted.
 *
 * Everything here is about making the deletion stick. The binding is discarded
 * rather than disposed, because disposing flushes and the flush would write a
 * snapshot row back for a room that has just been removed; the sockets are
 * closed so a browser still standing in the room cannot keep editing a document
 * nobody will ever load again; and the doc is destroyed so its observers go with
 * it. Called before the rows are dropped, so nothing can write between the two.
 */
export function dropSessionDoc(sessionId: string): void {
  const entry = docs.get(sessionId);
  if (!entry) return;
  docs.delete(sessionId);
  discardPersistence(sessionId);
  // The room is gone; an open burst describing it would be a version of nothing.
  discardBurst(sessionId);
  // И то, что сервер помнил об удалённых в ней ячейках: возвращать некуда.
  forgetSession(sessionId);
  for (const conn of Array.from(entry.conns.keys())) {
    const state = entry.conns.get(conn);
    if (state) clearInterval(state.pingTimer);
    entry.conns.delete(conn);
    try {
      conn.close(1001, "this seminar was deleted");
    } catch {
      /* already gone */
    }
  }
  entry.doc.destroy();
}

export function shutdownCollab(): void {
  for (const entry of docs.values()) {
    for (const conn of Array.from(entry.conns.keys())) {
      const state = entry.conns.get(conn);
      if (state) clearInterval(state.pingTimer);
      entry.conns.delete(conn);
      try {
        conn.close(1001, "server shutting down");
      } catch {
        /* already gone */
      }
    }
    entry.dispose();
  }
  docs.clear();
  flushAllPersistence();
  // Whatever somebody was typing when the process was told to stop is still a
  // thing they did, and the seminar may be reopened tomorrow.
  flushAllHistory();
}

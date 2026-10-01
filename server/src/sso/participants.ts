/**
 * One participant per person in a room, for people the sign-in proxy vouches for.
 *
 * Without the proxy a participant is a browser: the token minted at /join
 * lives in that browser's storage, and the same student on a phone is a second
 * person with the same name. With a verified identity (sso/identity.ts) the
 * room can do better — the person is the subject the proxy names, so a second
 * device, a cleared browser or a re-opened laptop come back as the same
 * participant, with their marks, their notebook and their activity.
 *
 * Its own table rather than a column on `participants`: the binding only
 * exists where the proxy does, and older code never reads it (a new table
 * needs no DATA_SCHEMA_VERSION bump, data-schema.ts). Triggers keep it from
 * outliving what it points at: a deleted room or participant takes its rows.
 */
import { db } from '../db.js'

db.exec(`
  CREATE TABLE IF NOT EXISTS sso_participants (
    session_id     TEXT NOT NULL,
    subject        TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    PRIMARY KEY (session_id, subject)
  );
  CREATE TRIGGER IF NOT EXISTS sso_participants_room_gone AFTER DELETE ON sessions
  BEGIN DELETE FROM sso_participants WHERE session_id = OLD.id; END;
  CREATE TRIGGER IF NOT EXISTS sso_participants_participant_gone AFTER DELETE ON participants
  BEGIN DELETE FROM sso_participants WHERE session_id = OLD.session_id AND participant_id = OLD.id; END;
`)

const selectBound = db.prepare('SELECT participant_id FROM sso_participants WHERE session_id = ? AND subject = ?')
const selectSubject = db.prepare('SELECT subject FROM sso_participants WHERE session_id = ? AND participant_id = ? LIMIT 1')
const upsertBound = db.prepare(`
  INSERT INTO sso_participants (session_id, subject, participant_id) VALUES (?, ?, ?)
  ON CONFLICT (session_id, subject) DO UPDATE SET participant_id = excluded.participant_id
`)

/** The participant this person already is in the room, if any. */
export function participantForSubject(sessionId: string, subject: string): string | null {
  const row = selectBound.get(sessionId, subject) as { participant_id: string } | undefined
  return row?.participant_id ?? null
}

/** The person a participant is bound to, if any: someone else's participant is not one to adopt. */
export function subjectForParticipant(sessionId: string, participantId: string): string | null {
  const row = selectSubject.get(sessionId, participantId) as { subject: string } | undefined
  return row?.subject ?? null
}

export function bindSubject(sessionId: string, subject: string, participantId: string): void {
  upsertBound.run(sessionId, subject, participantId)
}

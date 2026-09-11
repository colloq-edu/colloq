import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, db } from '../server/src/db.js'

test('the first activity schema migrates with counts, retained totals and deletion cleanup', async () => {
  createSession('legacy-activity', 'Legacy activity')
  db.exec(`
    CREATE TABLE session_activity (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      kind TEXT NOT NULL, level INTEGER NOT NULL, actor_id TEXT, actor_name TEXT, actor_role TEXT, details TEXT NOT NULL
    );
    CREATE TABLE activity_retention (session_id TEXT PRIMARY KEY, trimmed INTEGER NOT NULL DEFAULT 0);
    INSERT INTO session_activity VALUES (1, 'legacy-activity', 1000, 'presence.left', 1, 'p_legacy', 'Nina', 'participant', '{"durationMs":100}');
    INSERT INTO activity_retention VALUES ('legacy-activity', 1);
    CREATE TRIGGER activity_delete_session AFTER DELETE ON sessions BEGIN
      DELETE FROM session_activity WHERE session_id = OLD.id;
      DELETE FROM activity_retention WHERE session_id = OLD.id;
    END;
  `)
  const { appendActivity, activitySummary, listActivity } = await import('../server/src/activity.js')
  assert.equal(listActivity('legacy-activity').trimmed, true)
  assert.equal(activitySummary('legacy-activity').summaries[0].durationMs, 100)
  appendActivity('legacy-activity', 'p_legacy', 'presence.left', { durationMs: 50 })
  assert.equal(activitySummary('legacy-activity').summaries[0].events, 2)
  assert.equal(activitySummary('legacy-activity').summaries[0].durationMs, 150)
  assert.equal((db.prepare('SELECT event_count FROM activity_retention').get() as { event_count: number }).event_count, 2)
  db.prepare('DELETE FROM sessions WHERE id = ?').run('legacy-activity')
  assert.deepEqual(activitySummary('legacy-activity').summaries, [])
})

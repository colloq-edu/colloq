/**
 * The version of what this code keeps in colloq.db.
 *
 * Bump it by one in the same commit as a migration that older code cannot
 * live with: one that drops or renames a table or a column, moves values into
 * another column, or gives stored values a new meaning. competitions/store.ts ·
 * liftEntrantKeys is that kind: after it runs, a server from before it looks
 * for sign-in keys in a column that is empty and then gone. A new table, a
 * new nullable column or a new index does not need a bump — older code simply
 * never reads it.
 *
 * Three readers, and none of them may guess:
 *
 *  - db.ts writes it into the file (PRAGMA user_version) before any migration
 *    can run, and refuses a file that already carries a higher number: that
 *    file was written by newer code, and running older code over it is the
 *    downgrade nobody reviewed. Before it raises a lower number it copies the
 *    file to snapshots/pre-schema-<from>-to-<to>-<stamp>.db
 *    (db-snapshots.ts), so a bump always leaves the way back on the volume;
 *  - scripts/release-build.py publishes it as a release's dataSchemaVersion
 *    (and every lower number as compatible), so that cluster.sh refuses to
 *    roll the code back over newer data;
 *  - scripts/runtime-backup.py reads the stamp of the database inside an
 *    archive and refuses to restore it under a release that does not list it.
 *
 * A database from before this number existed carries 0 and reads as 1: every
 * release up to 0.8.4 wrote the schema of version 1. The rule is also written
 * down in RELEASING.md. release-build.py reads the line below with a regular
 * expression: keep it a plain integer literal.
 */
export const DATA_SCHEMA_VERSION = 1

/**
 * The variable that lets this code open a database stamped by newer code.
 *
 * For the operator who has read the refusal and knows the newer migration is
 * harmless for this release; everyone else restores the backup taken before
 * the update. It is read from the environment, so on the server image it goes
 * into /etc/colloq/colloq.env and for the pip package into the shell or .env.
 */
export const ALLOW_SCHEMA_DOWNGRADE = 'COLLOQ_ALLOW_SCHEMA_DOWNGRADE'

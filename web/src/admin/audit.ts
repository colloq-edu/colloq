import { hasTranslation, tr } from '@shared/i18n'
/**
 * The audit log's words, taken out of the screen.
 *
 * No Svelte and no browser, like `panel.ts`: these lines are what an owner
 * reads when a data-protection officer asks who deleted a room or replaced the
 * model key, and a mistake in them only shows on the day it matters.
 *
 * One rule: an event is shown even when this build does not know it. A row
 * written by a newer server (a new action, a new detail field) reads as its
 * raw name rather than disappearing — an audit view that hides what it cannot
 * name is worse than one that shows it plainly.
 */
import type { AdminAuditEvent, AdminAuditValue } from '@shared/admin'

/** "Teacher removed", or the action's own name for one this build has no words for. */
export function auditActionLabel(action: string): string {
  const key = `admin.audit.action.${action}`
  return hasTranslation(key) ? tr(key) : action
}

/**
 * Whether the server's console did it: nobody signed in, and the event says
 * it came from there (`colloq-host runner-code` records its codes with
 * `source: 'colloq-host'`, server/src/ops/runner-code.ts).
 */
function byConsole(event: AdminAuditEvent): boolean {
  return !event.actor && event.detail?.source === 'colloq-host'
}

/**
 * Who did it, for an event no signed-in person caused: the server's console,
 * when the event says it came from there (byConsole); otherwise a dash — the
 * server's own doing, a page republished at the end of a class, has nobody
 * to name. Under a dash, a code read as one nobody minted.
 */
export function auditActorless(event: AdminAuditEvent): string {
  return byConsole(event) ? tr('admin.audit.console') : '—'
}

/** What was acted on: its name as it read then, its id when it had none. */
export function auditTarget(event: AdminAuditEvent): string {
  if (!event.target) return ''
  return event.target.label || event.target.id || ''
}

/** A few recorded values have words: "set", "cleared", a role. Everything else reads as written. */
function word(value: AdminAuditValue): string {
  if (Array.isArray(value)) return value.join(', ')
  if (value === null) return '—'
  if (typeof value === 'boolean') return tr(value ? 'admin.audit.word.yes' : 'admin.audit.word.no')
  const text = String(value)
  const key = `admin.audit.word.${text}`
  return hasTranslation(key) ? tr(key) : text
}

function role(value: AdminAuditValue): string {
  const key = `admin.role.${String(value)}`
  return hasTranslation(key) ? tr(key) : String(value)
}

function lines(value: AdminAuditValue | undefined): string[] {
  return Array.isArray(value) ? (value as string[]) : []
}

/**
 * The event's details in one or a few lines.
 *
 * The actions whose facts read better as a sentence get one; the rest are
 * `field: value` pairs, which is exactly what they are — a setting's name and
 * what it became.
 */
export function auditDetail(event: AdminAuditEvent): string {
  const detail = event.detail
  if (!detail) return ''
  switch (event.action) {
    case 'instance.claimed':
      return tr('admin.audit.claimedDetail')
    case 'staff.signed_in':
      return tr(detail.via === 'setup_token' ? 'admin.audit.viaSetupToken' : 'admin.audit.viaLink')
    case 'staff.role_changed':
      return `${role(detail.from)} → ${role(detail.to)}`
    case 'staff.identity_changed':
      return [
        detail.name !== undefined ? `${word(detail.previousName ?? null)} → ${word(detail.name)}` : null,
        detail.email !== undefined ? `${word(detail.previousEmail ?? null)} → ${word(detail.email)}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join('\n')
    case 'settings.instance_changed':
      return `${word(detail.previousLanguage ?? null)} → ${word(detail.language ?? null)}`
    case 'runner.trusted':
      // One action for both directions (routes/admin-runners.ts records
      // `{ trusted }`): the label says the trust changed, and this line says
      // which way. The label used to read «доверен» for a removal too, and a
      // log that names the grant when trust was taken away is read the wrong
      // way round exactly when someone asks who gave a rented VM the test.
      return typeof detail.trusted === 'boolean'
        ? tr(detail.trusted ? 'admin.audit.runnerTrusted' : 'admin.audit.runnerUntrusted')
        : pairs(event)
    case 'runner.classes':
      // Both directions under one label, as with the trust: what the machine was opened to, or that its classes left it.
      return typeof detail.classes === 'boolean'
        ? tr(detail.classes ? 'admin.audit.runnerClassesOn' : 'admin.audit.runnerClassesOff')
        : pairs(event)
    case 'competition.hidden_test_downloaded': {
      // Which files left, and by which door (routes/admin-competitions.ts ·
      // recordHiddenTestDownload): the materials archive or the file's own
      // link. «files: test.csv · via: archive» read as the server's field
      // names in either language; a door this build does not know still
      // reads as written.
      const files = lines(detail.files)
      if (files.length === 0 || (detail.via !== 'archive' && detail.via !== 'file')) return pairs(event)
      return tr(detail.via === 'archive' ? 'admin.audit.hiddenTestViaArchive' : 'admin.audit.hiddenTestViaFile', { files: files.join(', ') })
    }
    case 'contest.problem.tests': {
      // Which problem's tests and how (routes/admin-contests.ts records
      // `{ problem, change }`, a test's number where one test changed); a
      // change this build has no words for still reads as written.
      const key = `admin.audit.contestTests.${String(detail.change ?? '')}`
      if (typeof detail.problem !== 'string' || !hasTranslation(key)) return pairs(event)
      return tr(key, { problem: detail.problem, test: typeof detail.test === 'number' ? detail.test : '' })
    }
    case 'contest.rejudged':
      // How many went back to the queue, whatever the scope (one, a problem, the contest).
      return typeof detail.count === 'number' ? tr('admin.audit.contestRejudged', { count: detail.count }) : pairs(event)
    case 'environment.created':
    case 'environment.edited':
      // A package list is a set of lines, and what it gained or lost is the
      // answer to "who added that index URL".
      return [...lines(detail.added).map((line) => `+ ${line}`), ...lines(detail.removed).map((line) => `− ${line}`)].join('\n')
    default:
      return pairs(event)
  }
}

/**
 * `field: value` pairs, for a detail that is a setting's name and what it
 * became — all but the console's `source`, which the Who column has already
 * read out (byConsole): a code minted there read «source: colloq-host» under
 * «Консоль сервера», a pair the panel's own code never has.
 */
function pairs(event: AdminAuditEvent): string {
  return Object.entries(event.detail ?? {})
    .filter(([field]) => field !== 'source' || !byConsole(event))
    .map(([field, value]) => `${field}: ${word(value)}`)
    .join(' · ')
}

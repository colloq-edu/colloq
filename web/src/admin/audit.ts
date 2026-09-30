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
    case 'environment.created':
    case 'environment.edited':
      // A package list is a set of lines, and what it gained or lost is the
      // answer to "who added that index URL".
      return [...lines(detail.added).map((line) => `+ ${line}`), ...lines(detail.removed).map((line) => `− ${line}`)].join('\n')
    default:
      return Object.entries(detail)
        .map(([field, value]) => `${field}: ${word(value)}`)
        .join(' · ')
  }
}

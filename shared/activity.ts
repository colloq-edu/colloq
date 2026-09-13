import type { AiAction, ParticipantRole } from './protocol'

/** Levels are cumulative: normal includes important, detailed includes everything. */
export const ACTIVITY_LEVELS = ['important', 'normal', 'detailed'] as const
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number]
export const ACTIVITY_CATEGORIES = ['all', 'presence', 'oracle', 'runtime', 'class', 'council', 'notebook'] as const
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]
export const ACTIVITY_KIND_LEVEL = {
  'presence.joined': 'normal',
  'presence.left': 'normal',
  'oracle.asked': 'important',
  'oracle.work_started': 'important',
  'oracle.finished': 'important',
  'oracle.work_finished': 'important',
  'class.finished': 'important',
  'class.resumed': 'important',
  'council.submitted': 'important',
  'council.withdrawn': 'normal',
  'notebook.contributed': 'detailed',
  'execution.queued': 'detailed',
  'execution.started': 'detailed',
  'execution.finished': 'detailed',
  'execution.interrupted': 'detailed',
  'execution.restarted': 'detailed',
  'oracle.work_step': 'detailed',
  'oracle.cancel_requested': 'detailed',
  'oracle.thread_cleared': 'detailed',
  'oracle.thread_pruned': 'detailed',
} as const satisfies Record<string, ActivityLevel>
export type ActivityKind = keyof typeof ACTIVITY_KIND_LEVEL
export type ActivityOutcome = 'completed' | 'cancelled' | 'error'
export interface ActivityDetails {
  /** Saved notebook burst containing this participant's direct editing activity. */
  versionSeq?: number
  /** The queue event identifying this exact execution attempt. */
  requestSeq?: number
  /** Owner of a council draft, which can differ from the teacher who runs it. */
  subjectId?: string
  action?: AiAction | 'work'
  cellId?: string
  entryId?: string
  count?: number
  durationMs?: number
  source?: 'participant' | 'oracle'
  outcome?: ActivityOutcome
  reason?: 'disconnected' | 'server_shutdown'
}
export interface ActivityEvent {
  seq: number
  createdAt: number
  kind: ActivityKind
  level: ActivityLevel
  actor: { id: string; name: string; role: ParticipantRole } | null
  details: ActivityDetails
}
export interface ActivityList {
  events: ActivityEvent[]
  nextBefore: number | null
  trimmed: boolean
}

import type { ActivityCategory, ActivityLevel, ActivityList } from '@shared/activity'
import { request } from './api'

export function listActivity(
  sessionId: string,
  token: string,
  level: ActivityLevel,
  category: ActivityCategory = 'all',
  before: number | null = null,
  signal?: AbortSignal,
): Promise<ActivityList> {
  const query = new URLSearchParams({ level, category, limit: '50' })
  if (before !== null) query.set('before', String(before))
  return request(`/api/sessions/${sessionId}/activity?${query}`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  })
}

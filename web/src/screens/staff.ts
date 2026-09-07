/**
 * «Не штат ли это?» — один вопрос, один ответ, одно место.
 *
 * Спрашивают два экрана: App, когда в браузере уже лежит личность участника
 * (преподаватель вошёл по ссылке как все, а потом подписался в панели), и
 * JoinScreen, когда личности нет вовсе. Раньше у каждого был свой код с
 * разными правилами снятия метки: один снимал её на ЛЮБОЙ сбой, включая
 * оборванный вайфай, другой — только на явный отказ. Метка живёт в
 * localStorage и стоит одного запроса, так что снятая по ошибке — это
 * преподаватель, которому со следующего захода никто больше не предлагает
 * войти собой.
 *
 * Правило здесь одно и оно из общего свода: различать «нет» и «не знаю».
 * Метку снимает только отказ сервера (401/403 или ответ без имени); молчание,
 * пятисотка и упавший fetch метку не трогают — со следующего захода спросим
 * снова.
 *
 * Живёт рядом с двумя экранами, которые об этом спрашивают, а не в lib/: это
 * их общая половина, и других читателей у неё нет.
 */
import { api } from '../lib/api'
import {
  clearStaffMark,
  mightBeStaff,
  saveIdentity,
  type StoredIdentity,
} from '../lib/identity'

/** Ответ на вопрос «подписан ли этот браузер на преподавательской стороне». */
export type StaffAnswer =
  /** Да, и вот имя, под которым он там подписан. */
  | { kind: 'staff'; name: string }
  /** Нет — сервер отказал явно. Метку можно снимать. */
  | { kind: 'no' }
  /** Не знаю: сервера не слышно, или он ответил не про это. */
  | { kind: 'unknown' }

/**
 * Что означает ответ `/api/admin/me`.
 *
 * Отдельно от запроса, потому что ломается молча именно эта таблица: код 0
 * (fetch не доехал) и 503 при перезапуске сервера читались как «этот браузер
 * не штат» и стирали метку.
 */
export function readStaffAnswer(status: number, name: string | null): StaffAnswer {
  if (status === 200) return name ? { kind: 'staff', name } : { kind: 'no' }
  // Печенья нет, она протухла или роль отозвали — это ответ, а не молчание.
  if (status === 401 || status === 403) return { kind: 'no' }
  return { kind: 'unknown' }
}

/**
 * Имя, под которым этот браузер подписан на преподавательской стороне.
 *
 * `null` — «войти собой нельзя»: либо это не штат, либо спросить не удалось.
 * Разницу знает только эта функция, и она же решает судьбу метки.
 */
export async function staffName(): Promise<string | null> {
  if (!mightBeStaff()) return null
  let answer: StaffAnswer
  try {
    const res = await fetch('/api/admin/me', { credentials: 'same-origin' })
    const body = res.ok ? ((await res.json()) as { teacher?: { name?: string } }) : null
    answer = readStaffAnswer(res.status, body?.teacher?.name?.trim() || null)
  } catch {
    // Сети нет. Метка цела: следующий заход спросит ещё раз.
    answer = { kind: 'unknown' }
  }
  if (answer.kind === 'no') clearStaffMark()
  return answer.kind === 'staff' ? answer.name : null
}

/**
 * Догнать роль, изменившуюся после того, как её здесь запомнили.
 *
 * Обычным входом с сохранённой личностью: роль назначает сервер по своей же
 * печенье, а не эта строка. Возвращает новую личность (её уже сохранили) или
 * `null`, если сервер сказал «участник» — тогда снимается и метка.
 *
 * Бросает, если сервера не слышно: тот, кто здесь есть, продолжает работать
 * тем, кем был, и следующий заход спросит снова.
 */
export async function upgradeIfStaff(
  sessionId: string,
  me: StoredIdentity,
): Promise<StoredIdentity | null> {
  const res = await api.join(sessionId, {
    name: me.name,
    avatar: me.avatar,
    participantId: me.participantId,
    token: me.token,
  })
  if (res.participant.role !== 'host') {
    // Подписи больше нет, или её не было вовсе. Перестаём спрашивать.
    clearStaffMark()
    return null
  }
  const next: StoredIdentity = {
    sessionId,
    participantId: res.participant.id,
    token: res.token,
    name: res.participant.name,
    avatar: res.participant.avatar,
    color: res.participant.color,
    role: res.participant.role,
  }
  saveIdentity(next)
  return next
}

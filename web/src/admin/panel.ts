import { tr, getLocale } from '@shared/i18n'
/**
 * Решения панели преподавателя, вынесенные из компонентов.
 *
 * Ни Svelte, ни браузера — как в `lib/bans.ts` и по той же причине: это слова,
 * которые преподаватель прочитает один раз и по которым пойдёт что-то делать
 * (искать настройки печенья вместо новой ссылки, выбирать режим оракула,
 * который в комнате не включится, класть файл, который не доедет, искать шаг,
 * которого на странице нет), и ошибку в них видно только на живой паре.
 *
 * Правило у всех одно: не выдавать догадку за факт. «Не знаю» и «нет»
 * — разные ответы, и там, где потолок инстанса ещё не прочитан, панель молчит,
 * а не рисует ограничение из ничего.
 */
import {
  isKeylessProvider,
  PROVIDER_PRESETS,
  providerConfigured,
  type AdminErrorReason,
  type OracleMode,
  type OracleSettings,
} from '@shared/admin'
import { SKIP_REASON_TEXT, type SkippedStep } from '@shared/publish'
import { OPEN_ROOM, oracleModeIn, type RoomRules } from '@shared/rules'

/* --------------------------------------------------------------- вход */

/**
 * Почему панель снова спрашивает «кто вы».
 *
 * `no-cookie` — вход в этой вкладке удавался, а печенье обратно не приехало;
 * `revoked` — печенье доехало и его отвергли (ссылку ротировали, из штата
 * сняли); `removed-self` — человек удалил собственный аккаунт и сервер сам
 * стёр печенье.
 */
export type SignedOutReason = 'no-cookie' | 'revoked' | 'removed-self'

/**
 * Что сказать на экране входа.
 *
 * Раньше все три случая говорили одно: «this browser sent no session back —
 * allow cookies». Преподаватель, которому ротировали ссылку посреди пары, шёл
 * разрешать печенья вместо того, чтобы попросить новую ссылку у владельца, а
 * тот, кто только что удалил себя сам, читал про настройки браузера про свой
 * же осознанный поступок.
 */
export function signedOutNotice(reason: SignedOutReason): string {
  switch (reason) {
    case 'revoked':
      return (
        (tr("admin.your.sign.in.is.no.longer.valid.the.link.may.have.been.replaced.o") + " ") +
        tr("admin.removed.ask.an.owner.for.a.new.sign.in.link")
      )
    case 'removed-self':
      return tr("admin.you.removed.your.own.account.so.this.browser.is.signed.out.an.own")
    default:
      return (
        (tr("admin.no.sign.in.session.was.received.from.this.browser.allow.cookies.f") + " ") +
        tr("admin.address.or.open.the.panel.over.the.address.the.server.publishes.a")
      )
  }
}

/* ------------------------------------------------------- правила комнаты */

/**
 * Отказ, каким его называет клиент панели: причина словом и код ответа.
 *
 * Ровно то, что `AdminApiError` и несёт (lib/adminApi.ts), но без него самого —
 * здесь ни Svelte, ни браузера, а `body` нужен только затем, чтобы отличить
 * ответ НАШЕГО маршрута от чужой страницы с тем же кодом.
 */
export interface AdminRefusal {
  reason: AdminErrorReason
  status: number
  /** Разобранное тело отказа или null, если ответ пришёл не JSON'ом. */
  body?: unknown
}

/**
 * Почему правило не сохранилось — по-русски, как и всё окно правил.
 *
 * Это окно — единственное в английской панели, которое говорит по-русски
 * целиком: подписи правил живут в языке КОМНАТЫ (web/src/lib/rule-rows.ts), и
 * рамка вокруг них другой быть не может. Причину отказа туда приносил общий
 * `explain()`, а он английский на всю панель — и в подвале выходило «Правило не
 * сохранилось — The server did not respond»: то самое половинчатое двуязычие,
 * ради которого окно и сделали русским (admin-17).
 *
 * Хвоста сервера здесь нет намеренно. Его фразы английские и приходят по сети
 * (statusText, «The request failed (500)», текст маршрута), перевести их на
 * лету нечем, и пересказывать наугад — хуже, чем не пересказывать: переводится
 * не фраза, а ПРИЧИНА, которую сервер называет отдельным полем `reason`.
 * Всё, что этим полем не названо, честнее закончить «попробуйте ещё раз».
 */
export function ruleRefusal(refusal: AdminRefusal | null): string {
  switch (refusal?.reason) {
    case 'network':
      return tr("admin.could.not.save.the.rule.the.server.did.not.respond.try.again")
    case 'unauthenticated':
      return tr("admin.could.not.save.the.rule.your.sign.in.session.is.no.longer.valid.s")
    case 'forbidden':
      return tr("admin.could.not.save.the.rule.you.do.not.have.access.to.this.seminar")
    default:
      /*
       * «Семинара больше нет» — это факт, а не догадка по коду.
       *
       * 404 маршрут отдаёт с `reason: 'invalid'` (routes/admin-instance.ts ·
       * notFound), тем же, что и отвергнутое тело, так что отличить их можно
       * только по коду ответа. Но 404 с той же цифрой отдаст и прокси перед
       * сервером, и туннель, забывший про /api, — а по «семинара больше нет»
       * преподаватель пойдёт заводить второй. Поэтому нужен ответ САМОГО
       * маршрута: разобранное тело, которого у чужой страницы не будет.
       */
      if (refusal?.status === 404 && refusal.body != null) {
        return tr("admin.could.not.save.the.rule.seminar.not.found")
      }
      return tr("admin.could.not.save.the.rule.try.again")
  }
}

/* -------------------------------------------------------------- оракул */

/**
 * Потолок инстанса: свободнее этого комната не станет, что бы в ней ни выбрали.
 *
 * `mode` — самый свободный режим, который инстанс вообще отдаст; `why` — почему
 * он такой, словами, или null, когда потолка нет и выбор в комнате настоящий.
 *
 * Считается по трём условиям, и все три сходятся на сервере в одной строке
 * (routes/ai.ts · `enabled = aiReady() && defaultMode !== 'off' &&
 * questionsPerHour > 0`): некому отвечать, `off` выключает оракула, ноль
 * вопросов в час — то же самое, только другими словами.
 *
 * Первое из трёх — не «есть ли ключ». `aiReady()` сводится к `providerReady()`
 * (ai/provider.ts): ключ ЛИБО локальный рантайм, у которого понятия ключа нет.
 * Панель считала здесь по одному ключу и на настроенной Ollama выдумывала
 * потолок `off` — гасила «Hints only» и «Full answers» и объявляла оракула
 * несуществующим, пока он отвечал. Теперь правило одно на обе стороны
 * (`providerConfigured` в shared/admin.ts), и `provider` с `baseUrl` для него
 * лежат в тех же `OracleSettings`, что уже прочитаны.
 */
export interface OracleCeiling {
  mode: OracleMode
  why: string | null
}

export function oracleCeiling(settings: OracleSettings): OracleCeiling {
  const hasKey = settings.apiKeyMasked !== null || settings.keyFromEnvironment
  if (!providerConfigured({ provider: settings.provider, baseUrl: settings.baseUrl, hasKey })) {
    // Два разных «некому отвечать», и чинятся они по-разному: одному не хватает
    // ключа, другому — адреса рантайма, который ключа не спросит.
    return {
      mode: 'off',
      why: isKeylessProvider(settings.provider)
        ? tr("admin.the.runtime.has.no.address.set", { p0: PROVIDER_PRESETS[settings.provider].label })
        : tr("admin.no.model.key.is.set.for.this.instance"),
    }
  }
  if (settings.defaultMode === 'off') return { mode: 'off', why: tr("admin.the.instance.has.the.oracle.off") }
  if (settings.questionsPerHour === 0) {
    return { mode: 'off', why: tr("admin.the.instance.allows.zero.questions.an.hour") }
  }
  if (settings.defaultMode === 'hints') {
    return { mode: 'hints', why: tr("admin.the.instance.allows.hints.only") }
  }
  return { mode: 'full', why: null }
}

/**
 * Что комната получит на самом деле, попросив `want`.
 *
 * Тем же правилом, что и на сервере: `oracleModeIn` из shared — единственная
 * копия «комната ужесточает и никогда не ослабляет».
 */
export function oracleUnder(want: RoomRules['oracle'], ceiling: OracleMode): OracleMode {
  return oracleModeIn({ ...OPEN_ROOM, oracle: want }, ceiling)
}

/**
 * Выбор, который выглядит настройкой, но ею не будет.
 *
 * `inherit` не бывает недействующим: он и значит «сколько даст инстанс».
 * Остальные три действуют ровно тогда, когда потолок их пропускает целиком.
 */
export function oracleOverCeiling(want: RoomRules['oracle'], ceiling: OracleMode): boolean {
  if (want === 'inherit') return false
  return oracleUnder(want, ceiling) !== want
}

/* -------------------------------------------------------------- файлы */

/** Мегабайты, которыми предел называют вслух: 52428800 → 50. */
export function uploadMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

/**
 * Что уедет, а что нет.
 *
 * Проверка стоит до нажатия Create, а не в загрузке после него: комната к тому
 * моменту уже создана, и «семинар создан, но датасет не доехал» — это поход в
 * комнату докладывать файл руками вместо одной строки на экране, где его ещё
 * можно заменить.
 */
export function splitBySize<T extends { name: string; size: number }>(
  files: T[],
  maxBytes: number,
): { taken: T[]; refused: T[] } {
  const taken: T[] = []
  const refused: T[] = []
  for (const file of files) {
    if (maxBytes > 0 && file.size > maxBytes) refused.push(file)
    else taken.push(file)
  }
  return { taken, refused }
}

/* ------------------------------------------------------- шаги публикации */

/**
 * Момент, который шагом не стал, — одной строкой.
 *
 * Пятое место того же правила: не выдавать молчание за согласие. Отмеченный
 * момент, который не собрался, исчезал бесследно — преподаватель отмечал семь,
 * получал страницу с шестью и пересчитывал их глазами, гадая, какой пропал.
 *
 * Причина берётся единственной копией из shared (SKIP_REASON_TEXT) — той же,
 * которой её называет сервер. Здесь решается только одно: чем назвать сам
 * момент. Именем, если оно есть; временем, если имени нет (безымянный момент —
 * это как раз одна из причин); номером версии, если и кандидата уже не видно.
 * По-русски, потому что по-русски весь экран публикации.
 */
export function skippedStepLine(step: SkippedStep, moment?: string): string {
  const named = step.label.trim() || moment?.trim() || tr("admin.version", { p0: step.seq })
  return tr("admin.version.skipped", { p0: named, p1: SKIP_REASON_TEXT[step.reason] })
}

/* --------------------------------------------------------- «идёт сейчас» */

/** Сколько прошло — словами, для баннера и строки списка. */
export function ago(from: number, at: number): string {
  const minutes = Math.max(0, Math.round((at - from) / 60_000))
  if (minutes < 1) return tr("admin.just.now")
  if (minutes < 60) return tr("admin.min.ago", { p0: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return tr("admin.h.ago", { p0: hours })
  const days = Math.floor(hours / 24)
  return days === 1 ? tr("admin.yesterday") : tr("admin.days.ago", { p0: days })
}

export const people = (n: number): string => tr("admin.count.people", { count: n })

/**
 * Строка баннера «Running now».
 *
 * Часы здесь две разные, и называются они разными словами. `liveSince` — когда
 * в комнату вошёл первый из тех, кто сидит в ней сейчас; это и есть «занятие
 * идёт столько-то». `createdAt` — когда комнату завели, а заводят их за неделю
 * до пары и переиспользуют на второй, так что «started 6 days ago» под
 * надписью «Running now» было неправдой всегда, кроме случая «создал и сразу
 * начал».
 *
 * Пока сервер `liveSince` не присылает, часы называются своим именем —
 * «created». Врать в самом заметном месте панели дороже, чем не знать.
 */
export function runningLine(
  seminar: { liveCount: number; liveSince?: number | null; createdAt: number },
  now: number,
): string {
  const since = seminar.liveSince ?? null
  const clock = since === null ? tr("admin.created", { p0: ago(seminar.createdAt, now) }) : tr("admin.started", { p0: ago(since, now) })
  return tr("admin.in.the.room", { p0: people(seminar.liveCount), p1: clock })
}

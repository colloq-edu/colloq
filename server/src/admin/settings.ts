/**
 * Instance settings: a key/value table, and the oracle configuration read
 * out of it.
 *
 * RESOLUTION ORDER — the whole point of this module. A value written from the
 * panel wins; where there is none, the corresponding `config.ai.*` env value
 * answers. An instance that was configured entirely through .env therefore
 * keeps working exactly as it did, and the panel is an override a teacher can
 * add and remove rather than a migration they are forced through.
 *
 * Обратно в окружение возвращаются ТРИ поля, и только они: baseUrl, model и
 * apiKey. Пустая строка стирает их строку (`set` ниже), и дальше отвечает
 * .env. Остальные так не умеют, и это не забывчивость, а разная природа
 * полей: houseRules пусты по умолчанию (возвращаться некуда), provider и
 * defaultMode — выбор из списка, где «ничего» не значение, а три числа
 * (вопросы в час, пауза, размер контекста) в окружении не живут вовсе и
 * падают на встроенные пределы из shared/admin. Написанное здесь однажды
 * говорило «clearing a field hands the question back to the environment» про
 * все девять, и человек, стерший «вопросы в час», ждал бы .env, а получал
 * прежнее число.
 *
 * The API key is stored in this SQLite file in plain text. That is deliberate:
 * Colloq is single-tenant and self-hosted, the database sits in the same
 * DATA_DIR as the setup token and beside the .env the key would otherwise live
 * in, and anyone who can read that directory already owns the instance.
 * Scrambling it here would only look like encryption while shipping the key and
 * its cipher in the same volume — and a teacher who believed that would store a
 * production key on a machine they would not otherwise trust with one.
 */
import { config } from '../config.js'
import { db } from '../db.js'
import {
  LIMITS,
  PROVIDER_PRESETS,
  type AiProviderId,
  type OracleMode,
  type OracleSettings,
  type UpdateOracleRequest,
} from '@shared/admin'

db.exec(`
  CREATE TABLE IF NOT EXISTS instance_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

/** Namespaced, because this table is the instance's junk drawer, not the AI's. */
const KEY = {
  provider: 'ai.provider',
  baseUrl: 'ai.baseUrl',
  model: 'ai.model',
  apiKey: 'ai.apiKey',
  defaultMode: 'ai.defaultMode',
  houseRules: 'ai.houseRules',
  questionsPerHour: 'ai.questionsPerHour',
  slowModeSeconds: 'ai.slowModeSeconds',
  contextChars: 'ai.contextChars',
} as const

const selectAll = db.prepare('SELECT key, value FROM instance_settings')
const upsertSetting = db.prepare(`
  INSERT INTO instance_settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`)
const deleteSetting = db.prepare('DELETE FROM instance_settings WHERE key = ?')

interface SettingRow {
  key: string
  value: string
}

/**
 * Read on every call rather than cached. A prepared SELECT over eight rows is
 * microseconds, and a cache here would need invalidating from the routes, the
 * provider and anything else that ever writes — a stale key is exactly the bug
 * this module exists to prevent.
 */
function stored(): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of selectAll.all() as SettingRow[]) map.set(row.key, row.value)
  return map
}

const MODES: readonly OracleMode[] = ['off', 'hints', 'full']

/**
 * Providers whose runtime ignores the key entirely; asking for one is asking
 * for a secret that does not exist.
 *
 * Реэкспорт, а не список: копия этого правила жила и здесь, и в панели
 * (web/src/admin/panel.ts), и следующая строка в одной из них разошлась бы со
 * второй молча — на настроенной Ollama сервер отвечает, а экран гасит выбор
 * оракула. Список один, в shared/admin.ts · KEYLESS_PROVIDERS.
 */
export { isKeylessProvider } from '@shared/admin'

function asProvider(value: string | undefined, fallback: AiProviderId): AiProviderId {
  return value && value in PROVIDER_PRESETS ? (value as AiProviderId) : fallback
}

function asMode(value: string | undefined): OracleMode {
  return MODES.includes(value as OracleMode) ? (value as OracleMode) : 'full'
}

function asInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (value === undefined || !Number.isFinite(parsed)) return fallback
  return clamp(Math.round(parsed), min, max)
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/* -------------------------------------------------------------- the key */

interface ResolvedKey {
  value: string
  fromEnvironment: boolean
}

function resolveKey(rows: Map<string, string>): ResolvedKey {
  const override = rows.get(KEY.apiKey)
  if (override !== undefined && override.length > 0) return { value: override, fromEnvironment: false }
  return { value: config.ai.apiKey, fromEnvironment: config.ai.apiKey.length > 0 }
}

/**
 * 'sk-…8fA2': enough for a teacher to recognise which key is installed, not
 * enough to be worth intercepting. The raw key never leaves the server.
 */
export function maskKey(key: string): string {
  const value = key.trim()
  if (!value) return ''
  if (value.length <= 8) return `…${value.slice(-2)}`
  // Vendor prefixes ('sk-', 'sk-proj-') identify the key's kind and are not secret.
  const dash = value.indexOf('-')
  const prefix = dash > 0 && dash <= 6 ? value.slice(0, dash + 1) : value.slice(0, 2)
  return `${prefix}…${value.slice(-4)}`
}

/* ------------------------------------------------------------------ read */

export function getOracleSettings(): OracleSettings {
  const rows = stored()
  const key = resolveKey(rows)
  return {
    provider: asProvider(rows.get(KEY.provider), asProvider(config.ai.provider, 'custom')),
    baseUrl: rows.get(KEY.baseUrl) ?? config.ai.baseUrl,
    model: rows.get(KEY.model) ?? config.ai.model,
    apiKeyMasked: key.value ? maskKey(key.value) : null,
    defaultMode: asMode(rows.get(KEY.defaultMode)),
    houseRules: rows.get(KEY.houseRules) ?? '',
    questionsPerHour: asInt(
      rows.get(KEY.questionsPerHour),
      LIMITS.questionsPerHour.default,
      LIMITS.questionsPerHour.min,
      LIMITS.questionsPerHour.max,
    ),
    slowModeSeconds: asInt(
      rows.get(KEY.slowModeSeconds),
      LIMITS.slowModeSeconds.default,
      LIMITS.slowModeSeconds.min,
      LIMITS.slowModeSeconds.max,
    ),
    contextChars: asInt(
      rows.get(KEY.contextChars),
      LIMITS.contextChars.default,
      LIMITS.contextChars.min,
      LIMITS.contextChars.max,
    ),
    keyFromEnvironment: key.fromEnvironment,
  }
}

export interface ResolvedAiConfig {
  apiKey: string
  baseUrl: string
  model: string
  provider: AiProviderId
}

/** What provider.ts talks to. Separate from getOracleSettings because this one carries the secret. */
export function resolveAiConfig(): ResolvedAiConfig {
  const rows = stored()
  return {
    apiKey: resolveKey(rows).value,
    baseUrl: (rows.get(KEY.baseUrl) ?? config.ai.baseUrl).replace(/\/+$/, ''),
    model: rows.get(KEY.model) ?? config.ai.model,
    provider: asProvider(rows.get(KEY.provider), asProvider(config.ai.provider, 'custom')),
  }
}

/* ----------------------------------------------------------------- write */

export function updateOracleSettings(patch: UpdateOracleRequest): OracleSettings {
  const write = db.transaction((changes: UpdateOracleRequest) => {
    if (changes.provider !== undefined) upsertSetting.run(KEY.provider, changes.provider)
    if (changes.baseUrl !== undefined) {
      set(KEY.baseUrl, changes.baseUrl.trim().replace(/\/+$/, '').slice(0, LIMITS.baseUrl))
    }
    if (changes.model !== undefined) set(KEY.model, changes.model.trim().slice(0, LIMITS.model))
    // '' clears the override, which puts OPENAI_API_KEY back in charge rather
    // than leaving the instance with no key at all.
    if (changes.apiKey !== undefined) set(KEY.apiKey, changes.apiKey.trim())
    if (changes.defaultMode !== undefined) upsertSetting.run(KEY.defaultMode, changes.defaultMode)
    if (changes.houseRules !== undefined) {
      set(KEY.houseRules, changes.houseRules.trim().slice(0, LIMITS.houseRules))
    }
    if (changes.questionsPerHour !== undefined) {
      const { min, max } = LIMITS.questionsPerHour
      upsertSetting.run(
        KEY.questionsPerHour,
        String(clamp(Math.round(changes.questionsPerHour), min, max)),
      )
    }
    if (changes.slowModeSeconds !== undefined) {
      const { min, max } = LIMITS.slowModeSeconds
      upsertSetting.run(
        KEY.slowModeSeconds,
        String(clamp(Math.round(changes.slowModeSeconds), min, max)),
      )
    }
    if (changes.contextChars !== undefined) {
      const { min, max } = LIMITS.contextChars
      upsertSetting.run(KEY.contextChars, String(clamp(Math.round(changes.contextChars), min, max)))
    }
  })
  write(patch)
  return getOracleSettings()
}

/** An empty string is "stop overriding this", not "override it with nothing". */
function set(key: string, value: string): void {
  if (value.length === 0) deleteSetting.run(key)
  else upsertSetting.run(key, value)
}

/* ------------------------------------------------------------ validation */

export type PatchResult = { patch: UpdateOracleRequest } | { error: string }

/**
 * Parses an untrusted body into a patch. Lives beside the store so the rules a
 * route enforces and the rules the store applies cannot drift apart: wrong
 * *types* are refused here, out-of-range *numbers* are clamped on write.
 */
export function parseOraclePatch(body: unknown): PatchResult {
  if (!body || typeof body !== 'object') return { error: 'a settings object is required' }
  const input = body as Record<string, unknown>
  const patch: UpdateOracleRequest = {}

  if (input.provider !== undefined) {
    if (typeof input.provider !== 'string' || !(input.provider in PROVIDER_PRESETS)) {
      return { error: 'unknown provider' }
    }
    patch.provider = input.provider as AiProviderId
  }
  for (const field of ['baseUrl', 'model', 'apiKey', 'houseRules'] as const) {
    if (input[field] === undefined) continue
    if (typeof input[field] !== 'string') return { error: `${field} must be text` }
    patch[field] = input[field] as string
  }
  if (input.defaultMode !== undefined) {
    if (!MODES.includes(input.defaultMode as OracleMode)) return { error: 'unknown oracle mode' }
    patch.defaultMode = input.defaultMode as OracleMode
  }
  for (const field of ['questionsPerHour', 'slowModeSeconds', 'contextChars'] as const) {
    if (input[field] === undefined) continue
    const value = input[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${field} must be a number` }
    patch[field] = value
  }

  const baseUrl = patch.baseUrl?.trim()
  if (baseUrl !== undefined && baseUrl.length > 0 && !/^https?:\/\//i.test(baseUrl)) {
    return { error: 'the base URL must start with http:// or https://' }
  }
  return { patch }
}

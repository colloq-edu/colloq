/**
 * «Есть ли на этом инстансе, кого спрашивать» — одно правило на сервер и на
 * панель.
 *
 * Копий было две. Сервер пускал вопрос по `providerReady()` («ключ, ИЛИ
 * рантайм, у которого понятия ключа нет, с адресом»), панель считала потолок
 * комнаты по одному ключу — и на настроенной Ollama гасила «Hints only» и
 * «Full answers» с подписью «на инстансе нет ключа», пока оракул в комнате
 * отвечал. Теперь правило живёт в `shared/admin.ts` (`providerConfigured`), и
 * этот файл держит сервер за руку: на любом наборе настроек его ответ обязан
 * совпасть с тем, что по тем же полям скажет панель.
 *
 * Ключ и адрес приходят из окружения, поэтому обе переменные гасятся ДО того,
 * как `config.ts` (а с ним и dotenv) прочитает их: иначе на машине с рабочим
 * `.env` тест был бы зелёным по чужому ключу.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDER_PRESETS,
  providerConfigured,
  isKeylessProvider,
  type AiProviderId,
} from '../shared/admin.js'

process.env.OPENAI_API_KEY = ''
process.env.OPENAI_BASE_URL = ''

const { resolveAiConfig, updateOracleSettings } = await import(
  '../server/src/admin/settings.js'
)
const { providerReady } = await import('../server/src/ai/provider.js')
const { config } = await import('../server/src/config.js')

const PROVIDERS = Object.keys(PROVIDER_PRESETS) as AiProviderId[]

test('сервер и панель отвечают одинаково на каждом наборе настроек', () => {
  for (const provider of PROVIDERS) {
    for (const baseUrl of ['', 'http://127.0.0.1:11434/v1', '   ', '/']) {
      for (const apiKey of ['', 'sk-test-key']) {
        updateOracleSettings({ provider, baseUrl, apiKey })
        const ai = resolveAiConfig()
        const panel = providerConfigured({
          provider: ai.provider,
          baseUrl: ai.baseUrl,
          hasKey: ai.apiKey.length > 0,
        })
        assert.equal(
          providerReady(),
          panel,
          `${provider} · baseUrl=${JSON.stringify(baseUrl)} · key=${apiKey ? 'да' : 'нет'}`,
        )
      }
    }
  }
})

test('локальный рантайм с адресом — полная настройка, ключа он не знает', () => {
  for (const provider of PROVIDERS.filter(isKeylessProvider)) {
    updateOracleSettings({ provider, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' })
    assert.equal(providerReady(), true, provider)
  }
})

test('облачный провайдер без ключа не готов, сколько бы адресов ни стояло', () => {
  for (const provider of PROVIDERS.filter((p) => !isKeylessProvider(p))) {
    updateOracleSettings({ provider, baseUrl: 'https://api.example.test/v1', apiKey: '' })
    assert.equal(providerReady(), false, provider)
  }
})

test('стёртый адрес — это «спросить окружение», а не «адреса нет»', () => {
  // Пустая строка удаляет строку настройки, и дальше отвечает .env; поэтому в
  // переборе выше '' — не «без адреса», а «адрес инстанса». Проверяется здесь,
  // чтобы следующий читатель не принял зелёный перебор за проверку пустоты.
  updateOracleSettings({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' })
  updateOracleSettings({ baseUrl: '' })
  assert.equal(resolveAiConfig().baseUrl, config.ai.baseUrl)

  // А хвостовой слеш сервер срезает при чтении — ровно то же делает shared,
  // иначе две стороны разошлись бы на «/».
  updateOracleSettings({ baseUrl: 'http://127.0.0.1:11434/v1/' })
  assert.equal(resolveAiConfig().baseUrl, 'http://127.0.0.1:11434/v1')
})

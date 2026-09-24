/**
 * "Is there anyone to ask on this instance" — one rule for the server and for
 * the panel.
 *
 * There were two copies. The server let a question through on
 * `providerReady()` ("a key, OR a runtime that has no notion of a key, with an
 * address"), while the panel computed the room's ceiling from the key alone —
 * and on a configured Ollama it dimmed "Hints only" and "Full answers" with
 * the caption "no key on the instance" while the oracle in the room was
 * answering. Now the rule lives in `shared/admin.ts` (`providerConfigured`),
 * and this file holds the server's hand: on any set of settings its answer
 * has to match what the panel says from the same fields.
 *
 * The key and the address come from the environment, so both variables are
 * blanked BEFORE `config.ts` (and dotenv with it) reads them: otherwise, on a
 * machine with a working `.env`, the test would be green on somebody else's
 * key.
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

test('the server and the panel answer the same on every set of settings', () => {
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
          `${provider} · baseUrl=${JSON.stringify(baseUrl)} · key=${apiKey ? 'yes' : 'no'}`,
        )
      }
    }
  }
})

test('a local runtime with an address is fully configured; it knows no key', () => {
  for (const provider of PROVIDERS.filter(isKeylessProvider)) {
    updateOracleSettings({ provider, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' })
    assert.equal(providerReady(), true, provider)
  }
})

test('a cloud provider without a key is not ready, however many addresses are set', () => {
  for (const provider of PROVIDERS.filter((p) => !isKeylessProvider(p))) {
    updateOracleSettings({ provider, baseUrl: 'https://api.example.test/v1', apiKey: '' })
    assert.equal(providerReady(), false, provider)
  }
})

test('an erased address means "ask the environment", not "no address"', () => {
  // An empty string deletes the settings row, and from then on .env answers; so
  // in the sweep above '' is not "no address" but "the instance's address". It
  // is checked here so the next reader does not take the green sweep for a check of emptiness.
  updateOracleSettings({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' })
  updateOracleSettings({ baseUrl: '' })
  assert.equal(resolveAiConfig().baseUrl, config.ai.baseUrl)

  // And the server strips a trailing slash on read — shared does exactly the
  // same, otherwise the two sides would part ways over "/".
  updateOracleSettings({ baseUrl: 'http://127.0.0.1:11434/v1/' })
  assert.equal(resolveAiConfig().baseUrl, 'http://127.0.0.1:11434/v1')
})

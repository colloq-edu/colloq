/**
 * What «вернуть …» under the runner cards gives back (the Resources tab):
 * the settings door names it beside the saved choice — the cards
 * COMPETITION_GPUS gives, of those KERNEL_GPUS lists, and
 * COMPETITION_GPU_PER_DEVICE, or the defaults: no card, one run per card.
 *
 * One quiet failure is guarded here. «вернуть умолчание» under the cards
 * forgot the saved choice and so handed submissions the .env cards back,
 * while the form went on showing the saved ticks and share until Save: the
 * owner who wanted no card for submissions got a card taken from the classes.
 * The form can show the truth at once and name its source only if the door
 * says what the truth is (CompetitionGpuSettings.fallback).
 *
 * No docker and no card: the probe of the cards is injected.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { gpuSettingsView } from '../server/src/competitions/gpu.js'
import { useGpuCardProbe } from '../server/src/kernel/resources.js'

/** Environment variables are read at call time, so they can be swapped for one body. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
  const all = { KERNEL_GPUS: undefined, COMPETITION_GPUS: undefined, COMPETITION_GPU_PER_DEVICE: undefined, COMPETITION_BACKEND: undefined, ...vars }
  const before = new Map(Object.keys(all).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(all)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    return await body()
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

useGpuCardProbe(async (devices) => new Map(devices.map((device) => [device, { name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564 }])))

after(() => {
  saveCompetitionSettings({ gpuDevices: null, gpuPerDevice: null })
  useGpuCardProbe(null)
})

test('the door says what forgetting the cards gives back: the .env cards this machine lists, and the .env runs per card', async () => {
  // COMPETITION_GPUS="1" COMPETITION_GPU_PER_DEVICE="2" (deploy/vast/onstart.sh); the owner then took every card back.
  await withEnv({ KERNEL_GPUS: '0,1', COMPETITION_GPUS: '1,7', COMPETITION_GPU_PER_DEVICE: '2' }, async () => {
    saveCompetitionSettings({ gpuDevices: [], gpuPerDevice: 4 })
    const saved = await gpuSettingsView()
    assert.deepEqual([saved.devices, saved.perDevice, saved.source], [[], 4, { devices: 'saved', perDevice: 'saved' }])
    assert.deepEqual(saved.fallback, { devices: ['1'], perDevice: 2, source: { devices: 'env', perDevice: 'env' } })
    // And that is exactly what the door answers once both are forgotten.
    saveCompetitionSettings({ gpuDevices: null, gpuPerDevice: null })
    const forgotten = await gpuSettingsView()
    assert.deepEqual([forgotten.devices, forgotten.perDevice], [saved.fallback!.devices, saved.fallback!.perDevice])
    assert.deepEqual(forgotten.source, { devices: 'env', perDevice: 'env' })
  })
})

test('with nothing in .env the defaults answer: no card, one run per card', async () => {
  await withEnv({ KERNEL_GPUS: '0,1' }, async () => {
    saveCompetitionSettings({ gpuDevices: ['0'], gpuPerDevice: 4 })
    assert.deepEqual((await gpuSettingsView()).fallback, { devices: [], perDevice: 1, source: { devices: 'default', perDevice: 'default' } })
    // A typo in .env is passed over, as the setting itself passes it over.
    await withEnv({ KERNEL_GPUS: '0,1', COMPETITION_GPU_PER_DEVICE: 'four' }, async () => {
      assert.deepEqual((await gpuSettingsView()).fallback?.perDevice, 1)
    })
  })
})

test('under the cluster nothing is given here, so nothing falls back', async () => {
  await withEnv({ KERNEL_GPUS: '0,1', COMPETITION_GPUS: '1', COMPETITION_BACKEND: 'broker' }, async () => {
    const managed = await gpuSettingsView()
    assert.equal(managed.managed, true)
    assert.equal(managed.fallback, undefined)
  })
})

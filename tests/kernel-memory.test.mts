/**
 * Почему ядро умерло — и сколько памяти ему было можно.
 *
 * 13.09 семинар пятнадцать раз подряд упирался в одну ячейку: `resnet18` на
 * батче 224×224 просил больше двух гигабайт, cgroup убивал python, Jupyter
 * молча поднимал новый, а комната каждый раз читала одно и то же «ядро
 * перезапустилось». Причину — лимит в два гигабайта — можно было узнать только
 * по `dmesg` на машине.
 *
 * Здесь закреплены обе половины починки: лимит, который можно поднять, не
 * трогая код, и разбор, который называет причину числами. Настоящего docker в
 * сюите нет (см. `_env.mts`), поэтому он подделывается целиком — ровно теми
 * ответами, которые сняты с живой машины в день происшествия.
 */
import './_env.mts'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { runArgs } from '../server/src/kernel/pool.js'
import {
  describe,
  explain,
  forgetKills,
  killedByMemory,
  useDockerForPostmortem,
  type MemoryReading,
} from '../server/src/kernel/postmortem.js'
import { setLocaleResolver } from '../shared/i18n.js'

/** Переменные окружения читаются в момент вызова, поэтому их можно подменить. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const before = new Map(Object.keys(vars).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    body()
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const room = { sessionId: 'pvhu2h7f', mount: '/srv/workspace/pvhu2h7f', network: '', gpu: null }

afterEach(() => {
  useDockerForPostmortem(null)
  forgetKills('pvhu2h7f')
  setLocaleResolver(() => 'ru')
})

/* ------------------------------------------------------ сколько памяти дать */

test('лимит памяти комнаты берётся из окружения, а по умолчанию остаётся прежним', () => {
  // Умолчания с 13.09.2026: 4g обычному окружению, 16g окружению с GPU.
  assert.ok(runArgs({ ...room, env: 'base' }).includes('--memory=4g'), 'умолчание изменилось')
  withEnv({ KERNEL_MEM: '12g' }, () => {
    assert.ok(runArgs({ ...room, env: 'base' }).includes('--memory=12g'))
  })
})

test('тяжёлому окружению можно выдать своё, не поднимая лимит всем комнатам', () => {
  /*
   * Ради этого всё и затевалось: семинар по зрению на `base-gpu` просит
   * шестнадцать гигабайт, а десять лёгких комнат рядом, получив столько же,
   * съели бы машину, ни разу этой памятью не воспользовавшись.
   */
  withEnv({ KERNEL_MEM: '2g', KERNEL_MEM_BASE_GPU: '16g' }, () => {
    assert.ok(runArgs({ ...room, env: 'base-gpu' }).includes('--memory=16g'), 'окружение не перебило общий лимит')
    assert.ok(runArgs({ ...room, env: 'base' }).includes('--memory=2g'), 'лимит подняли всем')
  })
})

/* ------------------------------------------- убила ли память — и та ли ячейка */

const reading = (over: Partial<MemoryReading> = {}): MemoryReading => ({
  limit: 2 * 1024 ** 3,
  peak: 2 * 1024 ** 3,
  current: 117 * 1024 ** 2,
  kills: 16,
  containerOomKilled: true,
  status: 'running',
  exit: 0,
  tail: [],
  ...over,
})

test('счётчик убийств отличает «убит этой ячейкой» от «убит утром»', () => {
  /*
   * `docker inspect` показывает OOMKilled: true и через восемь часов после
   * последнего убийства — контейнер-то жив, убили процесс внутри. Судить по
   * нему значит объявить нехваткой памяти любую следующую смерть ядра.
   */
  assert.equal(killedByMemory(reading(), 15), true, 'рост счётчика не признан убийством')
  assert.equal(killedByMemory(reading(), 16), false, 'залипший флаг выдан за свежее убийство')
})

test('без точки отсчёта решает пик: упёрся в лимит — значит упёрся', () => {
  // Сервер перезапустили посреди пары, запомненного числа нет.
  assert.equal(killedByMemory(reading({ peak: 2 * 1024 ** 3 + 1_679_360 }), undefined), true)
  assert.equal(
    killedByMemory(reading({ peak: 300 * 1024 ** 2, containerOomKilled: false }), undefined),
    false,
    'ядро, умершее вдали от лимита, объявлено съевшим память',
  )
})

test('фраза называет лимит, занятое и номер ячейки — тот же, что нарисован в комнате', () => {
  const text = describe(reading(), true, 21)
  assert.match(text, /по памяти/)
  assert.match(text, /2 ГБ/)
  assert.match(text, /ячейке 21/)
  assert.match(text, /KERNEL_MEM/, 'не сказано, какую ручку крутить')
  setLocaleResolver(() => 'en')
  assert.match(describe(reading(), true, 21), /killed by memory/)
  assert.match(describe(reading(), true, 21), /2 GB/)
})

/* ------------------------------------------------------ разбор целиком */

const V2 = [
  'limit 2147483648',
  'limit ',
  'peak 2149163008',
  'peak ',
  'current 122683392',
  'current ',
  'kills 16',
  'kills ',
].join('\n')

/** cgroup v1: те же числа под другими именами и в подкаталоге. */
const V1 = ['limit ', 'limit 2147483648', 'peak ', 'peak 2149163008', 'current ', 'current 122683392', 'kills 83'].join('\n')

function fakeDocker(cgroup: string, inspect = 'running 0 true 2147483648', logs = ''): Array<string[]> {
  const calls: Array<string[]> = []
  useDockerForPostmortem(async (args) => {
    calls.push(args)
    if (args[0] === 'exec') return { code: 0, out: cgroup }
    if (args[0] === 'logs') return { code: 0, out: logs }
    return { code: 0, out: inspect }
  })
  return calls
}

test('разбор читает cgroup живого контейнера и объясняет смерть ядра числами', async () => {
  const calls = fakeDocker(V2)
  const why = await explain('pvhu2h7f', 21)
  assert.ok(why, 'разбор промолчал там, где всё известно')
  assert.equal(why.oom, true)
  assert.equal(why.reading.limit, 2147483648)
  assert.equal(why.reading.peak, 2149163008)
  assert.match(why.text, /лимит 2 ГБ/)
  assert.match(why.text, /ячейке 21/)
  // Контейнер спрашивается по имени комнаты, а не по чему-то угаданному.
  assert.ok(calls.every((args) => args.includes('colloq-room-pvhu2h7f')), JSON.stringify(calls))
})

test('cgroup v1 читается теми же полями', async () => {
  fakeDocker(V1)
  const why = await explain('pvhu2h7f', null)
  assert.ok(why)
  assert.equal(why.reading.limit, 2147483648)
  assert.equal(why.oom, true)
})

test('второй разбор подряд не объявляет памятью смерть, которой она не была', async () => {
  /*
   * Первый вызов запоминает счётчик, второй сравнивает с ним: контейнер тот
   * же, убийств больше не было — значит, ядро умерло от чего-то другого, и
   * выдавать за нехватку памяти вчерашнее убийство нельзя.
   */
  fakeDocker(V2)
  assert.equal((await explain('pvhu2h7f', 21))?.oom, true)
  const again = await explain('pvhu2h7f', 22)
  assert.equal(again?.oom, false, 'тот же счётчик выдан за новое убийство')
  assert.match(String(again?.text), /не по памяти/)
})

test('упавший целиком контейнер объясняется кодом выхода и хвостом своего журнала', async () => {
  fakeDocker(
    'limit 2147483648\npeak 900000000\ncurrent 0\nkills 0',
    'exited 139 false 2147483648',
    ['[I 2026-09-13 12:00:00 ServerApp] Kernel started: 3868f7e5', 'Kernel is running over TCP without encryption.', 'Segmentation fault (core dumped)'].join('\n'),
  )
  const why = await explain('pvhu2h7f', 21)
  assert.ok(why)
  assert.equal(why.oom, false)
  assert.match(why.text, /139/)
  assert.match(why.text, /Segmentation fault/)
  // Болтовня Jupyter про шифрование в объяснении не нужна никому.
  assert.ok(!/without encryption/.test(why.text), 'в причину попал шум из журнала')
})

test('молчащий docker молчит и в комнате, а не выдумывает причину', async () => {
  useDockerForPostmortem(async () => ({ code: 1, out: 'Error: No such container' }))
  assert.equal(await explain('pvhu2h7f', 21), null)
})

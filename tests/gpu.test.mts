/**
 * Срез GPU достаётся комнате — и это единственное место, где это решается.
 *
 * Университетская A100 нарезана на MIG-срезы, их два или четыре, а семинаров за
 * день больше. Всё, чем срез привязан к комнате, — метка `colloq.gpu` на её
 * контейнере: карта в памяти умирает вместе с сервером, а контейнер вчерашней
 * пары живёт. Отсюда три правила, которые молча ломаются и которые здесь
 * закреплены: комната со своим контейнером получает ТОТ ЖЕ срез (иначе
 * контейнер пересоздаётся и переменные семинара исчезают на пустом месте),
 * остановленный контейнер свой срез держит (его поднимут `docker start`), а
 * когда свободных нет — отказ, а не тихий запуск на процессоре, где колёса
 * torch, собранные под CUDA, скажут об этом только на первом `.cuda()`.
 *
 * Настоящего docker в сюите нет (см. `_env.mts`), поэтому проверяется то, что
 * от него не зависит: правило раздачи и строка `docker run`, которую мы для
 * этого собираем.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gpuDevices, gpuRefusal, pickGpu, runArgs } from '../server/src/kernel/pool.js'

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

/* ------------------------------------------------- какие срезы у нас есть */

test('срезы перечисляются через запятую, в том виде, в каком их зовёт docker', () => {
  withEnv({ KERNEL_GPUS: ' MIG-GPU-a1b2/1/0 , 1 ' }, () => {
    assert.deepEqual(gpuDevices(), ['MIG-GPU-a1b2/1/0', '1'])
  })
})

test('переменной нет или она пуста — GPU не просит никто', () => {
  // Машина без карты — обычная машина: ни одна комната не должна споткнуться.
  withEnv({ KERNEL_GPUS: undefined }, () => assert.deepEqual(gpuDevices(), []))
  withEnv({ KERNEL_GPUS: '  ,, ' }, () => assert.deepEqual(gpuDevices(), []))
})

/* ---------------------------------------------------------- раздача срезов */

test('первая комната получает свободный срез', () => {
  assert.equal(pickGpu(['0', '1'], [], 'seminar'), '0')
})

test('занятый срез второй комнате не достаётся', () => {
  assert.equal(pickGpu(['0', '1'], [{ session: 'первый', gpu: '0' }], 'второй'), '1')
})

test('комната со своим контейнером получает тот же срез, а не первый свободный', () => {
  // Другой срез — это пересоздание контейнера, то есть потеря всех переменных
  // семинара посреди пары, и ровно из-за ничего.
  assert.equal(pickGpu(['0', '1'], [{ session: 'семинар', gpu: '1' }], 'семинар'), '1')
})

test('остановленный контейнер свой срез держит', () => {
  // Его поднимут `docker start` — с теми же переменными и тем же устройством,
  // поэтому занятые читаются через `docker ps -a`, а не только по живым.
  assert.equal(pickGpu(['0'], [{ session: 'вчерашний', gpu: '0' }], 'сегодняшний'), null)
})

test('срезов не хватило — null, а не первый попавшийся', () => {
  const taken = [
    { session: 'a', gpu: '0' },
    { session: 'b', gpu: '1' },
  ]
  assert.equal(pickGpu(['0', '1'], taken, 'c'), null)
})

test('срез, которого больше нет в KERNEL_GPUS, своим не считается', () => {
  // Оператор переписал список: устройства может уже не быть на машине, и
  // «тот же срез» тут означал бы контейнер, который не поднимется.
  assert.equal(pickGpu(['1'], [{ session: 'семинар', gpu: '0' }], 'семинар'), '1')
})

test('комната без GPU ничего не занимает', () => {
  assert.equal(pickGpu(['0'], [{ session: 'обычный', gpu: '' }], 'нейросети'), '0')
})

test('срезов нет вовсе — никому и ничего', () => {
  assert.equal(pickGpu([], [], 'семинар'), null)
})

/* ------------------------------------------------------------------ отказ */

test('отказ называет окружение и говорит, что делать', () => {
  const busy = gpuRefusal('gpu', ['0', '1'])
  assert.match(busy, /«gpu»/)
  // Два выхода, и оба выполнимы человеком в комнате: подождать или сменить
  // окружение. Обещать процессор нельзя — колёса собраны под CUDA.
  assert.match(busy, /Подожд/)
  assert.match(busy, /без GPU/)
})

test('на машине без выделенных срезов отказ называет переменную', () => {
  const none = gpuRefusal('gpu', [])
  assert.match(none, /KERNEL_GPUS/)
  assert.match(none, /«gpu»/)
})

/* ------------------------------------------------- строка docker run */

/** Значение флага вида `--name x`; для `--memory=2g` смотрите на весь элемент. */
function valueOf(args: string[], flag: string): string | null {
  const at = args.indexOf(flag)
  return at >= 0 ? (args[at + 1] ?? null) : null
}

const room = { sessionId: 'seminar1', env: 'gpu', mount: '/srv/workspace/seminar1', network: 'colloq-rooms', publish: true }

test('GPU-комната получает устройство, метку и разделяемую память', () => {
  const args = runArgs({ ...room, gpu: 'MIG-GPU-a1b2/1/0' })
  assert.equal(valueOf(args, '--gpus'), 'device=MIG-GPU-a1b2/1/0')
  // Метка — единственное, что переживает перезапуск сервера, поэтому она и
  // есть ответ на вопрос «кто держит срез».
  assert.ok(args.includes('colloq.gpu=MIG-GPU-a1b2/1/0'), 'нет метки со срезом')
  // 64 МБ по умолчанию у docker ломают DataLoader с несколькими воркерами.
  assert.ok(args.includes('--shm-size=1g'), 'нет --shm-size')
})

test('обычная комната запускается ровно как раньше', () => {
  const args = runArgs({ ...room, env: 'cv', gpu: null })
  assert.ok(!args.includes('--gpus'), 'обычной комнате пробросили устройство')
  assert.ok(
    !args.some((arg) => arg.startsWith('--shm-size') || arg.startsWith('colloq.gpu=')),
    'обычная комната получила лишнее',
  )
  // Всё прежнее на месте: образ по имени окружения, только папка этой комнаты,
  // петля хоста и потолки.
  assert.equal(args[args.length - 1], 'colloq-kernel:cv')
  assert.equal(valueOf(args, '-v'), '/srv/workspace/seminar1:/workspace/seminar1')
  assert.equal(valueOf(args, '-p'), '127.0.0.1:0:8888')
  // Умолчание памяти с 13.09.2026 — 4g обычному окружению (kernel/pool.ts).
  assert.ok(args.includes('--memory=4g') && args.includes('--cpus=2'))
  assert.ok(args.includes('colloq.session=seminar1'))
})

test('в сетевом режиме порт не публикуется вовсе', () => {
  const args = runArgs({ ...room, network: 'colloq', publish: false, gpu: null })
  assert.equal(valueOf(args, '--network'), 'colloq')
  assert.ok(!args.includes('-p'), 'Jupyter комнаты открылся на хосте')
})

test('потоков столько же, сколько выданных ядер, — у любой комнаты', () => {
  // os.cpu_count() внутри контейнера показывает ядра ХОСТА: без этих трёх строк
  // numpy и torch поднимают по тридцать потоков на два выделенных ядра.
  withEnv({ KERNEL_CPUS: '4' }, () => {
    for (const gpu of [null, '0']) {
      const args = runArgs({ ...room, gpu })
      for (const name of ['OMP', 'MKL', 'OPENBLAS']) {
        assert.ok(args.includes(`${name}_NUM_THREADS=4`), `${name} при gpu=${gpu}`)
      }
    }
  })
})

test('дробные --cpus не превращаются в дробное число потоков', () => {
  withEnv({ KERNEL_CPUS: '1.5' }, () => {
    const args = runArgs({ ...room, gpu: null })
    assert.ok(args.includes('OMP_NUM_THREADS=1'), 'потоков стало не целое число')
    // Сам лимит docker остаётся дробным: это он умеет.
    assert.ok(args.includes('--cpus=1.5'))
  })
})

test('размер разделяемой памяти настраивается', () => {
  withEnv({ KERNEL_SHM: '4g' }, () => {
    assert.ok(runArgs({ ...room, gpu: '0' }).includes('--shm-size=4g'))
  })
})

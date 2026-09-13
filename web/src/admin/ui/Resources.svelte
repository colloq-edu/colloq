<script lang="ts">
  /**
   * Сколько машины достаётся этой комнате.
   *
   * 13.09 ядро семинара убили по памяти шестнадцать раз подряд. Лимит был один
   * на все комнаты, лежал в переменной окружения и нигде в продукте не
   * показывался: преподаватель видел «ядро перезапустилось» на одной и той же
   * ячейке и не имел ни числа, ни ручки. Здесь и число, и ручка.
   *
   * Правило честности этого экрана (см. шапку NewSeminar.svelte) держится и
   * тут, поэтому память и ядра — поля, а карта — строка. Видеопамять cgroup не
   * режет вовсе: карту комнаты делят целиком, и рисовать рядом с ней поле
   * значило бы обещать ограничение, которого нет.
   *
   * У ядер своя оговорка, и она сказана вслух под полем: `docker update`
   * меняет долю процессора живому контейнеру сразу, но число потоков numpy и
   * torch считается ОДИН раз, при старте интерпретатора, — так что уже
   * работающее ядро продолжит считать прежним их числом до перезапуска.
   *
   * Один компонент на обе двери — форму нового занятия и настройки
   * существующего. Настройка, которую в двух местах называют по-разному и
   * считают по-разному, — это две настройки.
   */
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { cn } from '@/lib/utils'
  import type { InstanceResources } from '@shared/admin'

  interface Props {
    /** Что рассказала машина; null — ещё не доехало или не спросили. */
    resources: InstanceResources | null
    /** Выбранное окружение: от него зависит и умолчание, и нужна ли карта. */
    environment: string
    /** Что задано комнате, в мегабайтах; null — «как у окружения». */
    memoryMb: number | null
    /** Число уехало. `null` возвращает комнату к умолчанию окружения. */
    onmemory: (mb: number | null) => void
    /** Сколько ядер задано комнате; null — «как у инстанса». */
    cpus: number | null
    /** Ядра уехали. `null` возвращает комнату к умолчанию инстанса. */
    oncpus: (cores: number | null) => void
    /** Запрос идёт — поле не трогаем, чтобы не обогнать ответ. */
    busy?: boolean
    /** Отказ сервера, если он был: печатается под полем, а не в стороне. */
    refusal?: string | null
  }

  let {
    resources,
    environment,
    memoryMb,
    onmemory,
    cpus,
    oncpus,
    busy = false,
    refusal = null,
  }: Props = $props()

  const MB_IN_GB = 1024

  /** Умолчание ЭТОГО окружения. Общее — если про окружение ничего не известно. */
  const defaultMb = $derived(
    resources?.kernel.perEnvironment[environment]?.memoryMb ??
      (resources ? resources.kernel.defaultMemoryMb : null),
  )

  /** Просит ли выбранное окружение карту — по его же файлу, не по имени. */
  const usesGpu = $derived(resources?.kernel.perEnvironment[environment]?.gpu ?? false)

  /** Что реально получит комната: своё число либо умолчание окружения. */
  const effectiveMb = $derived(memoryMb ?? defaultMb ?? 0)

  /** Умолчание инстанса по ядрам; от окружения оно не зависит. */
  const defaultCores = $derived(resources?.kernel.defaultCpus ?? null)
  /** Что реально получит комната по ядрам. */
  const effectiveCores = $derived(cpus ?? defaultCores ?? 0)

  /*
   * Поле держит СВОЮ строку, а не производную от числа.
   *
   * Пока человек стирает «6» чтобы напечатать «12», значение проходит через
   * пустую строку и через «1». Считать из них мегабайты и слать наверх значит
   * на каждом нажатии клавиши отправлять запрос с числом, которого никто не
   * хотел, — а на «1» ещё и получать отказ «меньше 512 МБ». Поэтому поле живёт
   * своей жизнью, а наверх уходит только осмысленное.
   */
  let typed = $state('')
  let editing = $state(false)

  const shown = $derived(editing ? typed : gb(effectiveMb))

  function gb(mb: number): string {
    if (!mb) return ''
    const value = mb / MB_IN_GB
    // «6», а не «6.0»: половинки — шаг этого поля, десятые доли — нет.
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
  }

  /** Гигабайты с экрана — в мегабайты строки семинара, кратно половине гига. */
  function toMb(text: string): number | null {
    const value = Number(text.replace(',', '.').trim())
    if (!Number.isFinite(value) || value <= 0) return null
    return Math.round((value * MB_IN_GB) / 512) * 512
  }

  function commit(): void {
    editing = false
    const mb = toMb(typed)
    // Пусто — «как у окружения»: так комнату возвращают к умолчанию, не
    // выдумывая для этого второго переключателя рядом с полем.
    if (typed.trim() === '') {
      if (memoryMb !== null) onmemory(null)
      return
    }
    if (mb === null || mb === memoryMb) return
    onmemory(mb)
  }

  /* Ядра — тем же устройством, что и память: своя строка у поля, наверх едет
     только осмысленное. Целое и вниз: дробные `--cpus` docker понимает, а
     потоки numpy — нет, и число в поле обязано быть тем же, что уедет в обе. */
  let typedCores = $state('')
  let editingCores = $state(false)
  const shownCores = $derived(editingCores ? typedCores : effectiveCores ? String(effectiveCores) : '')

  function commitCores(): void {
    editingCores = false
    if (typedCores.trim() === '') {
      if (cpus !== null) oncpus(null)
      return
    }
    const value = Math.floor(Number(typedCores.replace(',', '.').trim()))
    if (!Number.isFinite(value) || value <= 0 || value === cpus) return
    oncpus(value)
  }

  /* ------------------------------------------------------------- полоска */

  const totalMb = $derived(resources?.memory.totalMb ?? 0)
  /** Доля машины, которую просит комната. Сотые не нужны — это полоска, а не число. */
  const share = $derived(totalMb > 0 ? Math.min(1, effectiveMb / totalMb) : 0)
  /*
   * Красным — когда комната просит больше, чем на машине СВОБОДНО.
   *
   * Не запрет: свободная память меняется между открытием формы и парой, чужую
   * комнату закроют, её контейнер уберут. Но взять восемь гигабайт там, где
   * свободно два, — это ядро, которое не поднимется, и узнать об этом лучше
   * сейчас, чем первым Run на занятии.
   */
  const tight = $derived(
    resources !== null && effectiveMb > resources.memory.availableMb && effectiveMb > 0,
  )

  /** Доля процессора машины, которую просит комната. */
  const cpuShare = $derived(
    resources && resources.cpus > 0 ? Math.min(1, effectiveCores / resources.cpus) : 0,
  )

  const asGb = (mb: number): string => {
    const value = mb / MB_IN_GB
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
  }
</script>

<div class="flex flex-col gap-3">
  <div class="flex flex-wrap items-center gap-2.5">
    <input
      type="number"
      min="0.5"
      step="0.5"
      inputmode="decimal"
      disabled={busy}
      class="field w-[110px]"
      aria-label={tr('admin.resources.memoryLabel')}
      value={shown}
      oninput={(event) => {
        editing = true
        typed = event.currentTarget.value
      }}
      onblur={commit}
      onkeydown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
    <span class="text-ui text-muted">{tr('admin.resources.gb')}</span>
    {#if memoryMb !== null && defaultMb !== null}
      <!-- Вернуть окружению — одним нажатием: иначе «как было» приходится
           набирать числом, подглядывая его в подсказке ниже. -->
      <button
        type="button"
        class="text-2xs text-muted underline decoration-line underline-offset-2 hover:text-ink"
        disabled={busy}
        onclick={() => {
          editing = false
          onmemory(null)
        }}
      >
        {tr('admin.resources.useDefault')}
      </button>
    {/if}
  </div>

  {#if resources}
    <!-- Полоска: какую долю машины просит эта комната. Число рядом с ней
         лишнее — оно стоит в поле выше. -->
    <div class="flex h-1 w-full max-w-[320px] bg-line-soft" aria-hidden="true">
      <div
        class={cn('h-full transition-[width] duration-[var(--speed-quick)] ease-out', tight ? 'bg-warning' : 'bg-accent')}
        style="width: {(share * 100).toFixed(1)}%"
      ></div>
    </div>

    <p class="text-2xs leading-snug text-muted">
      {tr('admin.resources.hint', {
        p0: asGb(resources.memory.totalMb),
        p1: asGb(resources.memory.availableMb),
        p2: environment || tr('admin.resources.thisEnvironment'),
        p3: asGb(defaultMb ?? resources.kernel.defaultMemoryMb),
      })}
    </p>

    {#if tight}
      <p class="flex items-start gap-2 text-2xs leading-snug text-warning">
        <Icon name="alert" size={13} class="mt-px shrink-0" />
        <span>{tr('admin.resources.overFree')}</span>
      </p>
    {/if}

    {#if refusal}
      <p class="text-2xs leading-snug text-danger" role="alert">{refusal}</p>
    {/if}

    <!--
      Процессор — вторым полем, и устроен он как первое.

      Целые ядра, потому что число из этого поля уезжает в две разные вещи
      сразу: в `--cpus` docker (тот понимает и дробные) и в OMP/MKL/OPENBLAS/
      NUMEXPR внутри контейнера (те — только целые). Показать «1,5» и молча
      округлить одно из двух значило бы снова развести слово и дело.
    -->
    <div class="flex flex-col gap-3 border-t border-line-soft pt-4">
      <div class="flex flex-wrap items-center gap-2.5">
        <input
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          disabled={busy}
          class="field w-[110px]"
          aria-label={tr('admin.resources.cpuLabel')}
          value={shownCores}
          oninput={(event) => {
            editingCores = true
            typedCores = event.currentTarget.value
          }}
          onblur={commitCores}
          onkeydown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <span class="text-ui text-muted">{tr('admin.resources.cores')}</span>
        {#if cpus !== null && defaultCores !== null}
          <button
            type="button"
            class="text-2xs text-muted underline decoration-line underline-offset-2 hover:text-ink"
            disabled={busy}
            onclick={() => {
              editingCores = false
              oncpus(null)
            }}
          >
            {tr('admin.resources.useDefaultCpu')}
          </button>
        {/if}
      </div>

      <div class="flex h-1 w-full max-w-[320px] bg-line-soft" aria-hidden="true">
        <div
          class="h-full bg-accent transition-[width] duration-[var(--speed-quick)] ease-out"
          style="width: {(cpuShare * 100).toFixed(1)}%"
        ></div>
      </div>

      <p class="text-2xs leading-snug text-muted">
        {tr('admin.resources.cpuHint', {
          p0: resources.cpus,
          p1: defaultCores ?? resources.kernel.defaultCpus,
        })}
      </p>
    </div>

    <!-- Карта — строкой, потому что она и есть строка: задать её этой комнате
         нечем, а знать, на чём она поедет, надо. -->
    <div class="flex flex-col gap-1.5 border-t border-line-soft pt-3">
      {#if resources.gpus.length > 0}
        {@const card = resources.gpus[0]}
        <p class="text-2xs leading-snug text-muted">
          <span class="font-semibold text-ink">GPU:</span>
          {card.name}, {asGb(card.memoryMb)} {tr('admin.resources.gb')}{resources.gpus.length > 1
            ? tr('admin.resources.moreCards', { p0: resources.gpus.length - 1 })
            : ''}
          ·
          {usesGpu ? tr('admin.resources.envUsesGpu') : tr('admin.resources.envNoGpu')}
        </p>
        <p class="text-2xs leading-snug text-faint">{tr('admin.resources.vramShared')}</p>
      {/if}
    </div>
  {:else}
    <!-- Числа не доехали: выдумывать их нельзя, и подсказка просто молчит. -->
    <p class="text-2xs text-muted">{tr('admin.resources.unknown')}</p>
  {/if}
</div>

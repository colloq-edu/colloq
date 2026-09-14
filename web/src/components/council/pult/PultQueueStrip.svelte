<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Полоса очереди, 44 px в покое и до 300 развёрнутой.
   *
   * Ядро в комнате одно и считает по одному — это единственное место, где
   * видно, чем оно занято. Свёрнутая полоса — одна строка из четырёх слов:
   * точка, кто считает, сколько в очереди, сколько ждут разрешения. Числа, а не
   * списки; списки живут в развёрнутом виде.
   *
   * «Ждут разрешения N» — единственное, что набрано полужирным warning: это то,
   * чего от вас ждут прямо сейчас.
   *
   * ПРЕДЕЛА ЯДРА КЛИЕНТ НЕ ЗНАЕТ. На макете с 25-й секунды счётчик желтеет и
   * справа появляется «оборвётся само»; числа, из которого это считается, в
   * протоколе нет (`CouncilRun` времени жизни не везёт, лимита в shared нет), и
   * желтеть по выдуманному порогу значило бы обещать залу обрыв, которого не
   * будет. Поэтому здесь только прошедшее время — и «Прервать» рукой.
   *
   * ПОРЯДОК В ОЧЕРЕДИ РУКОЙ НЕ ТРОГАЕТСЯ: кадра «переставить» или «убрать из
   * очереди» в протоколе нет, очередь ведёт ядро. Список показан только на
   * просмотр, и подпись говорит об этом прямо.
   */
  import type { CouncilAttempt } from '@shared/protocol'
  import { COUNCIL_SHARED_KERNEL_NOTE, type CouncilSettings } from '@shared/notebook'
  import { requestReason, type KernelView } from '@/lib/council-pult'
  import { clock } from '@/lib/history'
  import { cn, spell } from '@/lib/utils'

  interface Props {
    kernel: KernelView
    settings: CouncilSettings
    names: boolean
    /** Живые часы пульта — тикают раз в секунду в родителе. */
    now: number
    open: boolean
    /** Ничего решать нельзя: нет связи или ячейка уже не консилиум. */
    disabled: boolean
    ontoggle: () => void
    onpolicy: (value: CouncilSettings['studentRun']) => void
    oninterrupt: () => void
    onapprove: (attempt: CouncilAttempt) => void
    ondecline: (attempt: CouncilAttempt) => void
    onapproveall: () => void
  }

  let {
    kernel,
    settings,
    names,
    now,
    open,
    disabled,
    ontoggle,
    onpolicy,
    oninterrupt,
    onapprove,
    ondecline,
    onapproveall,
  }: Props = $props()

  const CAPS = 'text-micro font-bold uppercase tracking-caps'
  const running = $derived(kernel.running)
  const waiting = $derived(kernel.pending.length)
  const elapsed = $derived(running ? Math.max(now - running.run!.startedAt, 0) : 0)

  const POLICY: { value: CouncilSettings['studentRun']; label: string; hint: string }[] = [
    { value: false, label: tr('room.ui.1287'), hint: tr('room.ui.1288') },
    { value: true, label: tr('room.ui.1289'), hint: tr('room.ui.1290') },
    { value: 'request', label: tr('room.ui.1291'), hint: tr('room.ui.1292') },
  ]

  const policyWord = $derived(
    settings.studentRun === 'request'
      ? tr('room.ui.1283')
      : settings.studentRun === true
        ? tr('room.ui.1282')
        : tr('room.ui.1281'),
  )

  const who = (attempt: CouncilAttempt): string => (names ? attempt.name : tr('room.ui.1255', { p0: 0 }))
</script>

<div class="shrink-0 border-b border-line bg-raised" data-pult-queue>
  <!-- Свёрнутая полоса. Кнопки не переезжают при переключении ручки: гаснет
       то, чего больше нет, но остаётся на месте. -->
  <div class="flex min-h-11 flex-wrap items-center gap-3 px-4 py-2">
    <span
      class={cn('h-2 w-2 shrink-0 rounded-full', running ? 'bg-accent' : 'bg-faint')}
      aria-hidden="true"
    ></span>
    <span class="flex shrink-0 items-baseline gap-[7px]">
      <span class={cn(CAPS, 'text-faint')}>{running ? tr('room.ui.1275') : tr('room.ui.1273')}</span>
      {#if running}
        <span class="max-w-[180px] truncate text-ui font-bold text-ink">{who(running)}</span>
        <span class="font-mono text-2xs text-accent-text">{spell(elapsed)}</span>
      {:else}
        <span class="text-ui text-muted">{tr('room.ui.1274')}</span>
      {/if}
    </span>
    <span class="h-4 w-px shrink-0 bg-line" aria-hidden="true"></span>
    <span class="shrink-0 text-ui text-muted">
      {kernel.queued.length === 0 ? tr('room.ui.1277') : tr('room.ui.1278', { p0: kernel.queued.length })}
    </span>
    <span
      class={cn(
        'min-w-0 flex-1 truncate text-ui',
        waiting > 0 ? 'font-bold text-warning' : 'text-faint',
      )}
    >
      {#if waiting > 0}
        {tr('room.ui.1279', { p0: waiting })}
      {:else if settings.studentRun === false}
        {tr('room.ui.1303')}
      {/if}
    </span>
    <button
      type="button"
      class="shrink-0 pr-1 font-mono text-micro text-faint hover:text-ink"
      aria-expanded={open}
      onclick={ontoggle}
    >{tr('room.ui.1280', { p0: policyWord })} {open ? '▴' : '▾'}</button>
    <button
      type="button"
      class={cn(CAPS, 'h-6 shrink-0 border px-3', running ? 'border-line text-ink' : 'border-line text-faint')}
      disabled={!running || disabled}
      onclick={oninterrupt}
    >{tr('room.ui.1284')}</button>
    <button
      type="button"
      class={cn(
        CAPS,
        'h-6 shrink-0 px-3',
        waiting > 0 ? 'bg-warning text-surface' : 'border border-line text-faint',
      )}
      disabled={waiting === 0 || disabled}
      onclick={onapproveall}
    >{tr('room.ui.1285')}{waiting > 0 ? ` ${waiting}` : ''}</button>
  </div>

  {#if open}
    <div class="max-h-[300px] overflow-y-auto border-t border-line">
      <!-- Ручка стоит НАД очередью, а не в меню: переключили на «по просьбе» —
           под ней тут же появился список тех, кто просит. -->
      <div class="flex flex-col gap-2.5 border-b border-line p-4">
        <span class={cn(CAPS, 'text-faint')}>{tr('room.ui.1286')}</span>
        <div class="flex border border-line">
          {#each POLICY as item (String(item.value))}
            {@const on = settings.studentRun === item.value}
            <button
              type="button"
              class={cn(
                'flex flex-1 basis-0 flex-col gap-[3px] border-r border-line px-3.5 py-2.5 text-left last:border-r-0',
                on && 'border-b-2 border-b-accent bg-raised',
              )}
              aria-pressed={on}
              disabled={disabled}
              onclick={() => onpolicy(item.value)}
            >
              <span class={cn('text-ui font-bold', on ? 'text-ink' : 'text-muted')}>{item.label}</span>
              <span class={cn('text-2xs', on ? 'text-muted' : 'text-faint')}>{item.hint}</span>
            </button>
          {/each}
        </div>
        <!--
          Про общее ядро сказано ТАМ, ГДЕ РУЧКУ ВКЛЮЧАЮТ, — и ручка теперь
          здесь, а не в меню замка. Попытки считаются в одном ядре комнаты:
          имена, заведённые самой попыткой, сервер снимает, а изменения общих
          объектов остаются общими, и по выводу преподаватель ставит «верно».
          Копия одна на весь продукт (shared/notebook.ts) — пересказ своими
          словами разъехался бы с ручкой на первой же правке. Строкой, а не
          подсказкой: пульт ведут с планшета, где наведения нет вовсе.
        -->
        <p class="max-w-[660px] text-2xs leading-snug text-faint">{tr(COUNCIL_SHARED_KERNEL_NOTE)}</p>
      </div>

      {#if kernel.pending.length > 0}
        <div class="flex flex-col">
          <div class="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
            <span class={cn('shrink-0 text-2xs font-bold uppercase tracking-label text-warning')}>
              {tr('room.ui.1293')} · {kernel.pending.length}
            </span>
            <span class="min-w-0 flex-1 truncate text-2xs text-faint">{tr('room.ui.1294')}</span>
            <button
              type="button"
              class={cn(CAPS, 'h-7 shrink-0 bg-warning px-3.5 text-surface')}
              disabled={disabled}
              onclick={onapproveall}
            >{tr('room.ui.1295')}</button>
          </div>
          {#each kernel.pending as attempt (attempt.participantId)}
            {@const reason = requestReason(attempt)}
            <div class="flex h-[50px] shrink-0 items-center gap-3 border-b border-l-[3px] border-b-line border-l-warning px-4">
              <span
                class="h-6 w-6 shrink-0 rounded-full"
                style:background-color={names ? attempt.color : 'rgb(var(--line))'}
                aria-hidden="true"
              ></span>
              <span class="w-40 shrink-0 truncate text-ui-lg font-bold text-ink">{who(attempt)}</span>
              <span class="w-[120px] shrink-0 text-2xs text-muted">
                {tr('room.ui.1298', { p0: clock(attempt.runRequest!.requestedAt) })}
              </span>
              <span class="w-[72px] shrink-0 font-mono text-2xs text-warning">
                {tr('room.ui.1299', { p0: spell(Math.max(now - attempt.runRequest!.requestedAt, 0)) })}
              </span>
              <span class="min-w-0 flex-1 truncate font-mono text-micro text-faint">{reason ?? ''}</span>
              <button
                type="button"
                class={cn(CAPS, 'h-6 shrink-0 bg-warning px-3 text-surface')}
                disabled={disabled}
                onclick={() => onapprove(attempt)}
              >{tr('room.ui.1296')}</button>
              <button
                type="button"
                class={cn(CAPS, 'h-6 shrink-0 border border-line px-3 text-muted')}
                disabled={disabled}
                onclick={() => ondecline(attempt)}
              >{tr('room.ui.1297')}</button>
            </div>
          {/each}
        </div>
      {/if}

      {#if kernel.queued.length > 0}
        <div class="flex flex-col">
          <div class="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
            <span class="shrink-0 text-2xs font-bold uppercase tracking-label text-muted">
              {tr('room.ui.1300')} · {kernel.queued.length}
            </span>
            <span class="min-w-0 flex-1 truncate text-2xs text-faint">{tr('room.ui.1301')}</span>
          </div>
          {#each kernel.queued as attempt, at (attempt.participantId)}
            <div class="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
              <span class="w-4 shrink-0 font-mono text-2xs text-muted">{at + 1}</span>
              <span
                class="h-5 w-5 shrink-0 rounded-full"
                style:background-color={names ? attempt.color : 'rgb(var(--line))'}
                aria-hidden="true"
              ></span>
              <span class="w-40 shrink-0 truncate text-ui font-bold text-ink">{who(attempt)}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-code text-faint">
                {attempt.text.split('\n').find((line) => line.trim()) ?? ''}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

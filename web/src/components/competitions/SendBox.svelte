<script lang="ts">
  /**
   * Зона отправки тетради: перетаскивание и кнопка (P2), одна кнопка (P4).
   *
   * Загрузки «из тетради в занятии» здесь нет — владелец убрал её из макета, и
   * это не упрощение, а правило: проверка исполняет тетрадь С НУЛЯ, а тетрадь
   * в комнате живёт с сохранёнными переменными и чужими правками. Единственный
   * способ — файл, который человек сам выбрал и сам видел.
   *
   * Расширение проверяется здесь, до сети: двадцать мегабайт по телефонному
   * интернету ради ответа «принимается только .ipynb» — это не проверка, это
   * наказание.
   */
  import { tr } from '@shared/i18n'
  import type { EntrantCompetitionView, EntrantSubmissions } from '@shared/competitions-entrant'

  interface Props {
    view: EntrantCompetitionView
    mine: EntrantSubmissions
    phone: boolean
    busy: boolean
    /** Отказ отправки — словами сервера или своими про расширение. */
    refusal: string | null
    onsend: (file: File) => void
    onrefuse: (message: string) => void
  }

  const { view, mine, phone, busy, refusal, onsend, onrefuse }: Props = $props()

  let dragging = $state(false)
  let input = $state<HTMLInputElement | null>(null)

  const minutes = $derived(Math.max(1, Math.round(view.competition.limits.wallSeconds / 60)))
  const quota = $derived.by(() => {
    /*
     * У закрытого приёма нормы дня нет.
     *
     * «Сегодня можно отправить ещё 4 посылки из 5» над кнопкой, которая больше
     * ничего не примет, — обещание, и прочитать его можно ровно одним
     * способом: «значит, что-то сломалось». Под зоной и так стоит фраза о том,
     * почему приём закрыт, и она здесь единственная правда.
     */
    if (mine.accepting !== 'open') return ''
    if (mine.leftToday === null) return tr('competitions.p.dropNoLimit')
    if (mine.leftToday <= 0) {
      return tr('competitions.refusal.dailyQuota', { count: mine.perDay })
    }
    return tr(phone ? 'competitions.p.phoneLeftToday' : 'competitions.p.dropLeftToday', {
      count: mine.leftToday,
      perDay: mine.perDay,
    })
  })
  const blocked = $derived(
    busy || mine.accepting !== 'open' || mine.inFlight > 0 || mine.leftToday === 0,
  )

  function take(list: FileList | null | undefined): void {
    const file = list?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.ipynb')) {
      onrefuse(tr('competitions.refusal.notIpynb'))
      return
    }
    onsend(file)
  }
</script>

<div class="flex flex-col gap-2">
  {#if phone}
    <button
      class="flex h-12 w-full items-center justify-center bg-brand text-2xs font-black uppercase tracking-label text-white disabled:bg-faint"
      type="button"
      disabled={blocked}
      onclick={() => input?.click()}
    >
      {busy ? tr('competitions.p.sending') : tr('competitions.p.pickFilePhone')}
    </button>
    <p class="text-2xs leading-[18px] text-muted">
      {tr('competitions.p.phoneNeedsCsv')}{#if quota}<br />{quota}{/if}<br />{tr(
        'competitions.p.phoneLimits',
        { count: minutes },
      )}
    </p>
  {:else}
    <div
      class="flex flex-col gap-4 border-[1.5px] border-dashed bg-surface sm:flex-row sm:items-center {dragging
        ? 'border-accent bg-accent/5'
        : 'border-brand-2'}"
      role="region"
      aria-label={tr('competitions.p.dropTitle')}
      ondragover={(event) => {
        event.preventDefault()
        dragging = true
      }}
      ondragleave={() => (dragging = false)}
      ondrop={(event) => {
        event.preventDefault()
        dragging = false
        if (!blocked) take(event.dataTransfer?.files)
      }}
    >
      <div class="flex min-w-0 grow items-center gap-[18px] px-6 py-[22px]">
        <svg width="28" height="32" viewBox="0 0 28 32" class="shrink-0" aria-hidden="true">
          <path d="M2 2h15l9 9v19H2V2Z" fill="none" stroke="rgb(var(--brand))" stroke-width="2" />
          <path d="M17 2v9h9" fill="none" stroke="rgb(var(--brand))" stroke-width="2" />
          <path d="M14 25V15m0 0-4 4m4-4 4 4" fill="none" stroke="rgb(var(--accent))" stroke-width="2" />
        </svg>
        <div class="flex min-w-0 flex-col gap-1">
          <p class="text-title font-bold leading-6 text-ink">
            {dragging ? tr('competitions.p.dropHere') : tr('competitions.p.dropTitle')}
          </p>
          <p class="text-ui leading-5 text-muted">
            {tr('competitions.p.dropNeedsCsv')}{#if quota}<br />{quota}{/if}
          </p>
        </div>
      </div>
      <div class="flex shrink-0 items-center justify-center px-6 pb-[22px] sm:w-[238px] sm:pb-0">
        <button
          class="h-11 w-[190px] max-w-full bg-brand px-[18px] text-micro font-black uppercase tracking-label text-white hover:bg-brand-2 disabled:bg-faint"
          type="button"
          disabled={blocked}
          onclick={() => input?.click()}
        >
          {busy ? tr('competitions.p.sending') : tr('competitions.p.pickFile')}
        </button>
      </div>
    </div>
  {/if}

  {#if refusal}
    <p class="text-2xs leading-[18px] text-danger">{refusal}</p>
  {:else if mine.inFlight > 0}
    <p class="text-2xs leading-[18px] text-muted">{tr('competitions.refusal.inFlight')}</p>
  {:else if mine.accepting === 'closed'}
    <p class="text-2xs leading-[18px] text-muted">{tr('competitions.refusal.closed')}</p>
  {:else if mine.accepting === 'not_open'}
    <p class="text-2xs leading-[18px] text-muted">{tr('competitions.refusal.notOpen')}</p>
  {/if}

  <input
    class="hidden"
    type="file"
    accept=".ipynb,application/x-ipynb+json"
    bind:this={input}
    onchange={(event) => {
      const target = event.currentTarget
      take(target.files)
      // Поле сбрасывается, иначе повторный выбор ТОГО ЖЕ файла не поднимает
      // событие вовсе: человек правит тетрадь и шлёт её снова — обычный случай.
      target.value = ''
    }}
  />
</div>

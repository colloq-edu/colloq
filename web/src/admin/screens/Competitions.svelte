<!--
  Соревнования: список (A1) и дверь в одно из них.

  Соревнование — это задача с ответами, которых участник не видит. Список
  отвечает на один вопрос, ради которого сюда и заходят посреди пары: что с
  каждым сейчас не так. Поэтому в строке стоят не только числа, но и причина —
  бейзлайн не прошёл проверку, дедлайн горит, метрика упала.

  Экран одного соревнования выбирается его состоянием, а не отдельным
  адресом: черновик открывается редактором (A2), идущее и завершённое —
  пультом (A3). Так же, как их открывает клик по строке.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { onMount, tick } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Editor from '@/admin/screens/competitions/Editor.svelte'
  import Live, { type LiveTab } from '@/admin/screens/competitions/Live.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import RowsSkeleton from '@/components/ui/RowsSkeleton.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { cn } from '@/lib/utils'
  import { competitionPath, LIMITS, parseSlug, slugRefusal } from '@shared/competitions'
  import { suggestSlug } from '@shared/publish'
  import type { CompetitionRow, CompetitionView, CompetitionsList } from '@shared/competitions-api'
  import {
    baselineNote,
    count,
    deadlineLine,
    metricLine,
    metricNumber,
    runnerLine,
    stateTone,
    stateWord,
  } from '@/admin/competitions'

  interface Props {
    /** Открытое соревнование, если адрес его называет; `new` — форма заведения. */
    open: string | null
    /** Вкладка пульта: адрес несёт и её. */
    tab?: LiveTab
    navigate: (path: string) => void
  }

  let { open, tab = 'submissions', navigate }: Props = $props()

  let list = $state<CompetitionsList | null>(null)
  let view = $state<CompetitionView | null>(null)
  let loadingList = $state(true)
  let loadingOne = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let busy = $state(false)
  let query = $state('')
  let copied = $state<string | null>(null)
  let openMenu = $state<string | null>(null)
  let doomed = $state<CompetitionRow | null>(null)
  /** Часы списка: «осталось 1 ч 12 мин» обязано убывать само. */
  let now = $state(Date.now())

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : tr('admin.competitions.requestFailed')

  function lost(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') {
      void adminAuth.refresh('revoked')
    }
  }

  async function loadList(): Promise<void> {
    loadingList = true
    try {
      list = await adminApi.listCompetitions()
      // Число в рельсе — отсюда: иначе оболочка спрашивает тот же список второй
      // раз за тот же переход.
      navCounts.competitions = list.competitions.length
      errorText = null
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
    } finally {
      loadingList = false
    }
  }

  async function loadOne(id: string): Promise<void> {
    loadingOne = true
    try {
      view = await adminApi.competition(id)
      errorText = null
    } catch (cause) {
      lost(cause)
      // Пустая область на месте соревнования — не ответ: по этому адресу
      // приходят из чата и через неделю, когда его уже могло не стать.
      view = null
      errorText = () => explain(cause)
    } finally {
      loadingOne = false
    }
  }

  /*
   * Одна загрузка на открытие. Список нужен и на экране одного соревнования —
   * полоса исполнителя одна на инстанс, — но идти за ним вторым запросом
   * незачем: экран соревнования держит свою очередь живым потоком.
   */
  $effect(() => {
    const id = open
    if (id !== null && id !== 'new') {
      void loadOne(id)
      return
    }
    view = null
    void loadList()
  })

  /* Форма заведения — не адрес: недописанное название за ссылкой обещает, что
     оно там и останется. Но `/admin/competitions/new` набирают руками, и он
     обязан привести туда же, куда кнопка. */
  let creating = $state(false)
  let draftTitle = $state('')
  let draftSlug = $state('')
  let slugTouched = $state(false)
  let titleField = $state<HTMLInputElement | null>(null)

  $effect(() => {
    if (open === 'new' && !creating) void startCreating()
  })

  const proposedSlug = $derived(slugTouched ? draftSlug : suggestSlug(draftTitle))

  async function startCreating(): Promise<void> {
    creating = true
    openMenu = null
    await tick()
    titleField?.focus()
  }

  async function create(): Promise<void> {
    const title = draftTitle.trim()
    const slug = parseSlug(proposedSlug)
    // busy проверяется, а не только выставляется: кнопка по нему гаснет, а
    // Enter с автоповтором — нет, и полсекунды удержания заводят пять черновиков.
    if (!title || busy) return
    if (!slug) {
      const why = slugRefusal(proposedSlug) ?? 'chars'
      errorText = () => tr(`competitions.refusal.slug.${why}`)
      return
    }
    busy = true
    errorText = null
    try {
      const made = await adminApi.createCompetition({ title, slug })
      // Счётчик в рельсе ведёт список, а список мы сейчас покинем: без этой
      // строки рядом с «Соревнования» оставался ноль, пока не вернутся назад.
      navCounts.competitions = (navCounts.competitions ?? 0) + 1
      creating = false
      draftTitle = ''
      draftSlug = ''
      slugTouched = false
      navigate(`/admin/competitions/${made.competition.id}`)
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
    } finally {
      busy = false
    }
  }

  async function togglePause(): Promise<void> {
    if (!list || busy) return
    busy = true
    try {
      const queue = await adminApi.pauseCompetitionQueue(!list.queue.paused)
      list = { ...list, queue }
      errorText = null
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
    } finally {
      busy = false
    }
  }

  async function destroy(): Promise<void> {
    const going = doomed
    if (!going || busy) return
    busy = true
    errorText = null
    try {
      await adminApi.deleteCompetition(going.competition.id)
      doomed = null
      await loadList()
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
    } finally {
      busy = false
    }
  }

  async function copy(text: string, key: string): Promise<void> {
    try {
      await copyText(text)
    } catch {
      // Буфер закрыт (панель по http на чужом хосте — обычное дело для
      // инстанса кафедры): ссылку тогда показывают словами, а не молчат.
      errorText = () => tr('admin.competitions.copyFailed', { link: text })
      return
    }
    copied = key
    setTimeout(() => (copied = copied === key ? null : copied), 1600)
  }

  const shown = $derived.by(() => {
    const rows = list?.competitions ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(
      (row) =>
        row.competition.title.toLowerCase().includes(needle) ||
        row.competition.slug.toLowerCase().includes(needle) ||
        row.competition.metric.name.toLowerCase().includes(needle),
    )
  })

  onMount(() => {
    // Полминуты: строка дедлайна считает часы и минуты, и секунда здесь была бы
    // перерисовкой всего списка ради цифры, которой на экране нет.
    const tick = window.setInterval(() => (now = Date.now()), 30_000)
    const close = () => (openMenu = null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') openMenu = null
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(tick)
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  })

  const HEAD = 'text-micro font-bold uppercase tracking-caps text-muted'
  /*
   * Подпись колонки, переезжающая в строку, когда колонок больше нет.
   *
   * Шапка на узком экране спрятана, и без подписи «28 · 143 · 0.0412» — это
   * три числа без имён: список занятий уже проходил ровно это (admin-phone).
   */
  const MENU_ITEM =
    'block w-full px-3 py-2 text-left text-ui text-ink transition-colors duration-100 hover:bg-raised'
</script>

{#snippet caption(label: string)}
  <span class="comp-label mr-1.5 font-sans text-micro font-bold uppercase tracking-caps text-faint">
    {label}
  </span>
{/snippet}

{#if open !== null && open !== 'new'}
  {#if view}
    {#if view.competition.state === 'draft'}
      <Editor {view} {navigate} onview={(fresh) => (view = fresh)} />
    {:else}
      <Live {view} {tab} {navigate} onview={(fresh) => (view = fresh)} />
    {/if}
  {:else}
    <!-- Соревнования по этому адресу нет. Ссылкой на него делятся с коллегой,
         так что по устаревшей сюда придут — и пустая область без слов была бы
         единственным, что человек здесь увидел. -->
    <AdminPage title={tr('competitions.title')}>
      <div class="px-8 py-16 text-center">
        {#if loadingOne}
          <p class="text-ui text-muted">{tr('competitions.loading')}</p>
        {:else}
          <p class="text-title font-semibold text-ink">{tr('admin.competitions.notOpened')}</p>
          <p class="mx-auto mt-2 max-w-sm text-ui text-muted">
            {error ?? tr('admin.competitions.checkAddress')}
          </p>
          <button type="button" class="btn-primary mt-4" onclick={() => navigate('/admin/competitions')}>
            {tr('admin.competitions.all')}
          </button>
        {/if}
      </div>
    </AdminPage>
  {/if}
{:else}
  <AdminPage title={tr('competitions.title')} subtitle={tr('admin.competitions.lede')}>
    {#snippet actions()}
      <label class="relative flex items-center max-[640px]:w-full">
        <Icon name="search" size={12} class="pointer-events-none absolute left-3 text-faint" />
        <input
          class="h-[34px] w-[220px] border border-line bg-canvas pl-8 pr-3 text-2xs text-ink
                 placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40
                 max-[640px]:h-11 max-[640px]:w-full"
          placeholder={tr('admin.competitions.search')}
          aria-label={tr('admin.competitions.search')}
          bind:value={query}
        />
      </label>
      <button
        type="button"
        class="btn-primary h-[34px] gap-2 px-4 text-micro font-bold uppercase tracking-caps
               max-[640px]:h-11 max-[640px]:w-full"
        onclick={() => void startCreating()}
      >
        <span aria-hidden="true" class="text-ui-lg leading-none">+</span>
        {tr('admin.competitions.new')}
      </button>
    {/snippet}

    <!--
      Полоса исполнителя: состояние очереди ИНСТАНСА, одно на все соревнования.

      Стоит над таблицей, а не в строке каждого соревнования, потому что
      исполнитель один: две строки с разными числами про одну и ту же очередь —
      это экран, которому перестают верить.
    -->
    {#if list}
      {@const line = runnerLine(list.queue)}
      <div
        class="-mx-7 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b border-line bg-surface
               px-7 py-3"
      >
        <span
          class={cn('h-2 w-2 shrink-0', list.queue.paused ? 'bg-faint' : 'bg-accent')}
          aria-hidden="true"
        ></span>
        <span class="shrink-0 text-micro font-bold uppercase tracking-caps text-brand">
          {tr('admin.competitions.runner')}
        </span>
        <span class="text-2xs text-ink">{line.head}</span>
        <span class="min-w-0 text-2xs text-muted">{line.tail}</span>
        <button
          type="button"
          class="ml-auto shrink-0 text-2xs text-accent-text underline decoration-dotted
                 underline-offset-4 hover:brightness-110 disabled:text-faint"
          disabled={busy}
          onclick={() => void togglePause()}
        >
          {list.queue.paused
            ? tr('admin.competitions.resumeQueue')
            : tr('admin.competitions.pauseQueue')}
        </button>
      </div>
    {/if}

    <div class="py-1">
      {#if error && !creating}
        <div class="flex flex-wrap items-center gap-3 py-4">
          <p class="min-w-0 flex-1 text-ui text-danger">{error}</p>
          <button type="button" class="btn-outline shrink-0" onclick={() => void loadList()}>
            {tr('admin.try.again')}
          </button>
        </div>
      {/if}

      {#if creating}
        <!-- Заводят черновиком: адрес и название нужны сразу (по ним его ищут и
             в списке, и в чате), остальное правится в редакторе. -->
        <div class="mb-5 mt-4 flex flex-wrap items-center gap-3 border border-line bg-surface px-4 py-3">
          <input
            bind:this={titleField}
            class="h-9 min-w-0 flex-[3_1_240px] border border-line bg-canvas px-3 text-ui text-ink
                   placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
            placeholder={tr('admin.competitions.titlePlaceholder')}
            aria-label={tr('admin.competitions.titleLabel')}
            maxlength={LIMITS.title}
            bind:value={draftTitle}
            onkeydown={(event) => {
              if (event.key === 'Enter') void create()
              if (event.key === 'Escape') creating = false
            }}
          />
          <div class="flex min-w-0 flex-[1_1_200px] items-center border border-line bg-canvas px-3">
            <span class="shrink-0 font-mono text-2xs text-faint">/k/</span>
            <input
              class="h-9 min-w-0 flex-1 bg-transparent font-mono text-2xs text-ink
                     placeholder:text-faint focus:outline-none"
              aria-label={tr('admin.competitions.slugLabel')}
              maxlength={LIMITS.slug}
              value={proposedSlug}
              oninput={(event) => {
                slugTouched = true
                draftSlug = event.currentTarget.value
              }}
              onkeydown={(event) => {
                if (event.key === 'Enter') void create()
                if (event.key === 'Escape') creating = false
              }}
            />
          </div>
          <button
            type="button"
            class="btn-primary shrink-0"
            disabled={busy || !draftTitle.trim()}
            onclick={() => void create()}
          >
            {tr('admin.competitions.createDraft')}
          </button>
          <button
            type="button"
            class="btn-ghost shrink-0"
            onclick={() => {
              creating = false
              errorText = null
              if (open === 'new') navigate('/admin/competitions')
            }}
          >
            {tr('admin.cancel')}
          </button>
          {#if error}
            <p class="basis-full text-ui text-danger" role="alert">{error}</p>
          {/if}
        </div>
      {/if}

      {#if loadingList && !list}
        <RowsSkeleton label={tr('competitions.loading')} />
      {:else if shown.length === 0}
        <div class="py-16 text-center">
          <p class="text-title font-semibold text-ink">
            {query.trim()
              ? tr('admin.competitions.noMatch', { query: query.trim() })
              : tr('admin.competitions.none')}
          </p>
          {#if !query.trim()}
            <p class="mx-auto mt-2 max-w-md text-ui text-muted">{tr('admin.competitions.noneHint')}</p>
            {#if !creating}
              <button type="button" class="btn-primary mt-4" onclick={() => void startCreating()}>
                {tr('admin.competitions.new')}
              </button>
            {/if}
          {/if}
        </div>
      {:else}
        <div class="comp-rows">
          <div class="comp-head flex items-center gap-4 border-b border-line py-2.5">
            <span class="min-w-0 flex-1 {HEAD}">{tr('admin.competitions.col.competition')}</span>
            <span class="comp-cell w-[132px] shrink-0 {HEAD}">{tr('admin.competitions.col.status')}</span>
            <span class="comp-cell w-[176px] shrink-0 {HEAD}">{tr('admin.competitions.col.deadline')}</span>
            <span class="comp-cell w-[104px] shrink-0 text-right {HEAD}">
              {tr('admin.competitions.col.entrants')}
            </span>
            <span class="comp-cell w-[88px] shrink-0 text-right {HEAD}">
              {tr('admin.competitions.col.submissions')}
            </span>
            <span class="comp-cell w-[200px] shrink-0 text-right {HEAD}">
              {tr('admin.competitions.col.bestPublic')}
            </span>
            <span class="w-10 shrink-0"></span>
          </div>

          {#each shown as row (row.competition.id)}
            {@const c = row.competition}
            {@const deadline = deadlineLine(c, now, row.ready)}
            {@const baseline = baselineNote(row)}
            {@const draft = c.state === 'draft'}
            <div class="comp-row flex items-center gap-4 border-b border-line py-3.5">
              <button
                type="button"
                class="comp-name min-w-0 flex-1 text-left"
                onclick={() => navigate(`/admin/competitions/${c.id}`)}
              >
                <p class="truncate text-ui font-semibold text-ink">{c.title}</p>
                <p class="mt-1 flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5">
                  <span class="font-mono text-micro text-muted">/k/{c.slug}</span>
                  <span class="min-w-0 text-micro text-muted">{metricLine(row, now)}</span>
                </p>
              </button>

              <span class="comp-cell w-[132px] shrink-0">
                <Badge word={stateWord(c.state)} tone={stateTone(c.state)} />
              </span>

              <div class="comp-cell w-[176px] shrink-0">
                <p class="truncate text-2xs text-ink">{deadline.when}</p>
                <p
                  class={cn(
                    'mt-0.5 truncate text-micro',
                    deadline.hot ? 'font-bold text-warning' : 'text-muted',
                  )}
                >
                  {deadline.note}
                </p>
              </div>

              <!-- У черновика чисел нет вовсе: ноль участников и ноль посылок —
                   это утверждение о классе, которому соревнование ещё не
                   показывали. Прочерк говорит правду. -->
              <span class="comp-cell w-[104px] shrink-0 text-right font-mono text-2xs text-ink">
                {@render caption(tr('admin.competitions.col.entrants'))}{draft
                  ? '—'
                  : count(row.entrants)}
              </span>
              <span class="comp-cell w-[88px] shrink-0 text-right font-mono text-2xs text-ink">
                {@render caption(tr('admin.competitions.col.submissions'))}{draft
                  ? '—'
                  : count(row.submissions)}
              </span>

              <div class="comp-cell w-[200px] shrink-0 text-right">
                <p class="font-mono text-2xs font-bold text-ink">
                  {@render caption(tr('admin.competitions.col.bestPublic'))}{draft
                    ? '—'
                    : metricNumber(row.bestPublic)}
                </p>
                <p class={cn('mt-0.5 truncate text-micro', baseline.bad ? 'text-danger' : 'text-muted')}>
                  {baseline.text}
                </p>
              </div>

              <div class="relative w-10 shrink-0 text-right">
                <button
                  type="button"
                  class="inline-flex h-9 w-9 items-center justify-center text-faint transition-colors
                         duration-100 hover:bg-raised hover:text-ink max-[640px]:h-11 max-[640px]:w-11"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === c.id}
                  aria-label={tr('admin.competitions.rowMenu', { name: c.title })}
                  onclick={(event) => {
                    event.stopPropagation()
                    openMenu = openMenu === c.id ? null : c.id
                  }}
                >
                  <Icon name="more" size={15} />
                </button>
                {#if openMenu === c.id}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div
                    role="menu"
                    tabindex="-1"
                    class="row-menu absolute right-0 top-full z-20 mt-1 w-[240px] border border-line
                           bg-canvas py-1 text-left shadow-pop"
                    onclick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      class={MENU_ITEM}
                      onclick={() => {
                        openMenu = null
                        navigate(`/admin/competitions/${c.id}`)
                      }}
                    >
                      {draft ? tr('admin.competitions.menu.editor') : tr('admin.competitions.menu.open')}
                    </button>
                    {#if !draft}
                      <a
                        role="menuitem"
                        class={MENU_ITEM}
                        href={competitionPath(c.slug)}
                        target="_blank"
                        rel="noreferrer"
                        onclick={() => (openMenu = null)}
                      >
                        {tr('admin.competitions.menu.entrantPage')}
                      </a>
                      <button
                        type="button"
                        role="menuitem"
                        class={MENU_ITEM}
                        onclick={() => {
                          openMenu = null
                          void copy(`${location.origin}${competitionPath(c.slug)}`, c.id)
                        }}
                      >
                        {copied === c.id ? tr('admin.copied') : tr('admin.copy.link')}
                      </button>
                    {/if}
                    {#if adminAuth.isOwner}
                      <!-- Удаление уносит и каталог с ответами. Владельцу и вопросом. -->
                      <button
                        type="button"
                        role="menuitem"
                        class="{MENU_ITEM} text-danger"
                        onclick={() => {
                          openMenu = null
                          doomed = row
                        }}
                      >
                        {tr('admin.competitions.menu.delete')}
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
          {/each}

          <p class="py-3.5 text-micro text-faint">
            {tr('admin.competitions.countAll', { count: list?.competitions.length ?? 0 })} ·
            {tr('admin.competitions.seenAt')}
          </p>
        </div>
      {/if}
    </div>
  </AdminPage>
{/if}

{#if doomed}
  {@const going = doomed.competition}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="delete-competition-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[460px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="delete-competition-title" class="text-title font-semibold text-ink">
        {tr('admin.competitions.deleteHeading', { name: going.title })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr('admin.competitions.deleteBody', { count: doomed.submissions })}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger" role="alert">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (doomed = null)}>
          {tr('admin.cancel')}
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
          disabled={busy}
          onclick={() => void destroy()}
        >
          {tr('admin.competitions.deleteConfirm')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /*
   * Узкая таблица: название своей строкой, остальное под ним.
   *
   * Порог — по ширине самого списка, а не окна: рельс панели занимает 236px на
   * столе и 56 на телефоне, так что одна и та же ширина окна оставляет списку
   * разное место. 880px — это шесть колонок (132 + 176 + 104 + 88 + 200 + 40),
   * пять зазоров и хоть сколько-то на название.
   */
  .comp-rows {
    container-type: inline-size;
  }

  .comp-label {
    display: none;
  }

  @container (max-width: 880px) {
    .comp-row {
      flex-wrap: wrap;
      align-items: flex-start;
      row-gap: 0.5rem;
    }

    /* Название забирает первую строку целиком, кроме места под меню. */
    .comp-name {
      flex-basis: calc(100% - 56px);
    }

    /* Ячейки встают под ним в ряд и делят остаток по содержимому: своя
       колоночная ширина здесь означала бы шесть колонок в 320 пикселях. */
    .comp-cell {
      width: auto;
      min-width: 0;
      text-align: left;
    }

    /* Шапка колонок без колонок не значит ничего. */
    .comp-head {
      display: none;
    }

    /* Вместо неё подписи едут в саму строку. */
    .comp-label {
      display: inline;
    }
  }
</style>

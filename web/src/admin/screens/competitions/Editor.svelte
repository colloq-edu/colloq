<!--
  Редактор соревнования (A2) — и он же вкладка «Настройки» у идущего.

  Шесть секций, и порядок у них не оформительский: это порядок, в котором
  сервер проверяет готовность (server/src/competitions/panel.ts · openRefusal).
  Человек, которому отказали открыть, идёт по форме сверху вниз и чинит первое
  названное, а не прыгает по экрану за каждым следующим отказом.

  Главное правило экрана — ответы. `solution.csv` уезжает своей дверью, лежит
  вне рабочих папок занятий и не отдаётся обратно НИКОМУ: панель показывает
  имя, число строк и колонки, байты не показывает никогда (см. SECURITY.md).
-->
<script lang="ts">
  import { tr, formatNumber } from '@shared/i18n'
  import { onMount, untrack } from 'svelte'
  import DependencySettings from './DependencySettings.svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Section from '@/admin/ui/Section.svelte'
  import Choice from '@/admin/ui/Choice.svelte'
  import Badge from '@/admin/screens/competitions/Badge.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn, formatBytes } from '@/lib/utils'
  import { loadRenderers, renderers } from '@/lib/render.svelte'
  import {
    LIMITS,
    parseSlug,
    slugRefusal,
    type CompetitionLimits,
    type MetricDirection,
    type PrivateRelease,
    type ScoringRule,
  } from '@shared/competitions'
  import type { AdminEnvironment, InstanceResources } from '@shared/admin'
  import type { CompetitionInput, CompetitionView, FileView } from '@shared/competitions-api'
  import {
    answerColumns,
    applyPreset,
    count,
    isUntouchedPreset,
    METRIC_PRESETS,
    metricNumber,
    moment,
    presetCode,
    refusalSection,
    refusalText,
    spanWords,
    stateTone,
    stateWord,
  } from '@/admin/competitions'

  interface Props {
    view: CompetitionView
    navigate: (path: string) => void
    /** Свежий снимок с сервера: каждая загрузка файла возвращает его целиком. */
    onview: (view: CompetitionView) => void
    /** Внутри пульта идущего соревнования: своей шапки у формы тогда нет. */
    embedded?: boolean
  }

  let { view, navigate, onview, embedded = false }: Props = $props()

  const c = $derived(view.competition)
  const draftState = $derived(c.state === 'draft')

  let busy = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let saved = $state(false)
  let now = $state(Date.now())

  /* ------------------------------------------------------------ черновики */

  /*
   * Поля живут своей жизнью до «Сохранить».
   *
   * Ключ сброса — идентификатор соревнования, а не сам объект: `view`
   * переприсваивается ответом сервера после КАЖДОЙ загрузки файла, и черновик,
   * зависящий от объекта, стирал бы набранное описание ровно в тот момент,
   * когда преподаватель дотащил до формы первый csv.
   */
  let drafted: string | null = null
  let title = $state('')
  let slug = $state('')
  let blurb = $state('')
  let description = $state('')
  let metricName = $state('')
  let metricDirection = $state<MetricDirection>('lower')
  let metricCode = $state('')
  let publicPercent = $state<number | null>(LIMITS.publicPercent.default)
  let limits = $state<CompetitionLimits>({
    wallSeconds: LIMITS.wallSeconds.default,
    memoryMb: LIMITS.memoryMb.default,
    cpus: LIMITS.cpus.default,
    perDay: LIMITS.perDay.default,
  })
  let environment = $state('base')
  let deadline = $state('')
  let startsAt = $state('')
  let privateRelease = $state<PrivateRelease>('auto')
  let scoring = $state<ScoringRule>('chosen')

  $effect(() => {
    const open = view.competition
    if (drafted === open.id) return
    drafted = open.id
    title = open.title
    slug = open.slug
    blurb = open.blurb
    description = open.description
    metricName = open.metric.name
    metricDirection = open.metric.direction
    metricCode = open.metric.code
    publicPercent = open.publicPercent
    limits = { ...open.limits }
    environment = open.environment
    deadline = localInput(open.deadlineAt)
    startsAt = localInput(open.startsAt)
    privateRelease = open.privateRelease
    scoring = open.scoring
  })

  /**
   * Момент — в то, что понимает `datetime-local`, и обратно.
   *
   * Через местное время машины ЧЕЛОВЕКА, а не через ISO: дедлайн «27.09 23:59»
   * назначают глядя на расписание пары, и сдвиг на три часа здесь — это класс,
   * у которого приём закрылся в девять вечера.
   */
  function localInput(at: number | null): string {
    if (at === null) return ''
    const date = new Date(at)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function fromInput(value: string): number | null {
    if (!value.trim()) return null
    const at = new Date(value).getTime()
    return Number.isFinite(at) ? at : null
  }

  /* -------------------------------------------------------------- запросы */

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : tr('admin.competitions.requestFailed')

  function lost(cause: unknown): void {
    if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') {
      void adminAuth.refresh('revoked')
    }
  }

  /** Тело правки: только то, что форма показывала, — и ничего сверх. */
  function formBody(): CompetitionInput | null {
    const address = parseSlug(slug)
    if (!address) {
      const why = slugRefusal(slug) ?? 'chars'
      errorText = () => tr(`competitions.refusal.slug.${why}`)
      return null
    }
    if (!title.trim()) {
      errorText = () => tr('competitions.refusal.title')
      return null
    }
    const percent = Number(publicPercent)
    if (!Number.isFinite(percent) || percent < LIMITS.publicPercent.min || percent > LIMITS.publicPercent.max) {
      errorText = () =>
        tr('admin.competitions.percentRange', {
          min: LIMITS.publicPercent.min,
          max: LIMITS.publicPercent.max,
        })
      return null
    }
    return {
      slug: address,
      title: title.trim(),
      blurb: blurb.trim(),
      description,
      metric: { name: metricName.trim(), direction: metricDirection, code: metricCode },
      publicPercent: Math.round(percent),
      limits: { ...limits },
      environment,
      startsAt: fromInput(startsAt),
      deadlineAt: fromInput(deadline),
      privateRelease,
      scoring,
    }
  }

  async function act<T>(what: () => Promise<T>): Promise<T | null> {
    if (busy) return null
    busy = true
    errorText = null
    try {
      return await what()
    } catch (cause) {
      lost(cause)
      errorText = () => explain(cause)
      return null
    } finally {
      busy = false
    }
  }

  /*
   * Идентификатор снимается ДО первого await.
   *
   * `c` — производная от пропса, и открытие соревнования сносит сам редактор:
   * форма черновика уступает место пульту. Читать производную после того, как
   * её владелец уничтожен, — это `derived_inert` в консоли и устаревшее
   * значение вместо ошибки. Запрос обязан знать, кого он правит, с первой
   * строки и до последней.
   */
  async function save(): Promise<boolean> {
    const id = c.id
    const body = formBody()
    if (!body) return false
    const fresh = await act(() => adminApi.updateCompetition(id, body))
    if (!fresh) return false
    onview(fresh)
    saved = true
    setTimeout(() => (saved = false), 1600)
    return true
  }

  async function open(): Promise<void> {
    const id = c.id
    if (!(await save())) return
    const fresh = await act(() => adminApi.openCompetition(id))
    if (fresh) onview(fresh)
  }

  async function upload(files: FileList | null, what: 'data' | 'solution' | 'baseline'): Promise<void> {
    const id = c.id
    const list = [...(files ?? [])]
    if (list.length === 0) return
    const fresh = await act(() => {
      if (what === 'data') return adminApi.uploadCompetitionData(id, list)
      if (what === 'solution') return adminApi.uploadCompetitionSolution(id, list[0])
      return adminApi.uploadCompetitionBaseline(id, list[0])
    })
    if (fresh) onview(fresh)
  }

  async function dropFile(file: FileView): Promise<void> {
    const id = c.id
    const fresh = await act(() =>
      file.visibility === 'open'
        ? adminApi.deleteCompetitionFile(id, file.name)
        : adminApi.deleteCompetitionSolution(id, file.name),
    )
    if (fresh) onview(fresh)
  }

  /** Проверка сэмпл-тетради: она идёт в общую очередь настоящей посылкой. */
  async function checkBaseline(): Promise<void> {
    if (view.capabilities?.execution.available === false) return
    const id = c.id
    const started = await act(() => adminApi.checkCompetitionBaseline(id))
    if (started) await refresh(id)
  }

  /** «Проверить на бейзлайне» — только метрика, тетрадь второй раз не запускается. */
  async function checkMetric(): Promise<void> {
    if (view.capabilities?.execution.available === false) return
    const id = c.id
    if (!(await save())) return
    const started = await act(() => adminApi.checkCompetitionMetric(id))
    if (started) await refresh(id)
  }

  async function refresh(id: string): Promise<void> {
    try {
      onview(await adminApi.competition(id))
    } catch (cause) {
      lost(cause)
    }
  }

  /*
   * Пока заход сэмпл-тетради идёт, экран спрашивает о нём сам.
   *
   * Живого потока у редактора нет (он у пульта), а бейзлайн — единственное на
   * этой форме, что меняется без участия человека, и меняется оно минутами.
   * Без опроса «В ОЧЕРЕДИ» висит до перезагрузки страницы, и преподаватель
   * уходит с экрана, решив, что проверка не запустилась.
   */
  const baselineInFlight = $derived(
    view.baseline?.state === 'queued' || view.baseline?.state === 'running',
  )

  $effect(() => {
    const id = c.id
    if (!baselineInFlight) return
    const tick = window.setInterval(() => untrack(() => void refresh(id)), 3000)
    return () => window.clearInterval(tick)
  })

  onMount(() => {
    const tick = window.setInterval(() => (now = Date.now()), 30_000)
    return () => window.clearInterval(tick)
  })

  /* ------------------------------------------------------------ окружения */

  let environments = $state<AdminEnvironment[]>([])
  let resources = $state<InstanceResources | null>(null)

  onMount(() => {
    // Оба ответа — приписка к форме, а не сама форма: без них секция
    // «Исполнение посылки» показывает свои числа и молчит про машину.
    void adminApi
      .listEnvironments()
      .then((state) => (environments = state.environments))
      .catch(() => (environments = []))
    void adminApi
      .resources()
      .then((state) => (resources = state))
      .catch(() => (resources = null))
  })

  const chosenEnvironment = $derived(environments.find((one) => one.name === environment) ?? null)

  /** Гигабайты с десятой долей — и с той запятой, которую ставит язык инстанса. */
  const gb = (mb: number): string =>
    formatNumber(mb / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

  /* -------------------------------------------------------------- метрика */

  const solution = $derived(view.hiddenFiles[0] ?? null)
  const columns = $derived(answerColumns(solution?.columns))
  const presetName = $derived(
    METRIC_PRESETS.find((preset) => preset.name === metricName)?.name ?? '',
  )
  const codeLines = $derived(Math.max(10, metricCode.split('\n').length))

  function pickPreset(name: string): void {
    const next = applyPreset(
      { name: metricName, direction: metricDirection, code: metricCode },
      name,
      columns,
    )
    metricName = next.name
    metricDirection = next.direction
    metricCode = next.code
  }

  /* ------------------------------------------------------------- описание */

  let previewing = $state(false)
  const rendered = $derived(previewing ? (renderers()?.markdown(description) ?? null) : null)

  $effect(() => {
    if (previewing) void loadRenderers().catch(() => undefined)
  })

  /* ---------------------------------------------------------------- гейт */

  /** Первое, что мешает открыть; null — можно. Считает сервер, экран называет. */
  const refusal = $derived(view.ready)
  const blocked = $derived<string | null>(refusal === null ? null : refusalSection(refusal))

  const HEAD = 'text-micro font-bold uppercase tracking-caps text-muted'
  const TILE = 'flex flex-col gap-1.5 border border-line px-3.5 py-3'
</script>

{#snippet marker(section: string)}
  <!-- Секция, в которой лежит причина отказа, названа прямо в ней: иначе
       «Нет файла ответов» — это шесть мест, где его можно искать. -->
  {#if blocked === section && refusal}
    <p class="flex items-start gap-2 pt-2 text-micro leading-snug text-warning">
      <Icon name="alert" size={13} class="mt-px shrink-0" />
      <span>{refusalText(refusal)}</span>
    </p>
  {/if}
{/snippet}

{#snippet form()}
  {#if error}
    <p class="pt-4 text-ui text-danger" role="alert">{error}</p>
  {/if}

  <!-- 1 · Основное -->
  <Section title={tr('admin.competitions.section.basics')} description={tr('admin.competitions.basicsHint')}>
    <div class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center gap-2.5">
        <input
          class="field min-w-0 flex-[3_1_260px]"
          aria-label={tr('admin.competitions.titleLabel')}
          maxlength={LIMITS.title}
          bind:value={title}
        />
        <div class="flex min-w-0 flex-[1_1_200px] items-center border border-line bg-surface px-3">
          <span class="shrink-0 font-mono text-2xs text-faint">/k/</span>
          <input
            class="h-[38px] min-w-0 flex-1 bg-transparent font-mono text-2xs text-ink focus:outline-none"
            aria-label={tr('admin.competitions.slugLabel')}
            maxlength={LIMITS.slug}
            bind:value={slug}
          />
        </div>
      </div>
      <input
        class="field"
        aria-label={tr('admin.competitions.blurbLabel')}
        placeholder={tr('admin.competitions.blurbPlaceholder')}
        maxlength={LIMITS.blurb}
        bind:value={blurb}
      />

      <div class="border border-line">
        <div class="flex items-center gap-4 border-b border-line px-3 py-2">
          <button
            type="button"
            class={cn('text-micro font-bold uppercase tracking-caps', previewing ? 'text-faint' : 'text-primary')}
            aria-pressed={!previewing}
            onclick={() => (previewing = false)}
          >
            {tr('admin.competitions.tabText')}
          </button>
          <button
            type="button"
            class={cn('text-micro font-bold uppercase tracking-caps', previewing ? 'text-primary' : 'text-faint')}
            aria-pressed={previewing}
            onclick={() => (previewing = true)}
          >
            {tr('admin.competitions.tabPreview')}
          </button>
          <span class="ml-auto text-micro text-faint">{tr('admin.competitions.markdownHint')}</span>
        </div>
        {#if previewing}
          <div class="prose-note min-h-[140px] px-3 py-3">
            {#if rendered === null}
              <p class="text-ui text-muted">{tr('admin.competitions.previewLoading')}</p>
            {:else if description.trim() === ''}
              <p class="text-ui text-muted">{tr('admin.competitions.descriptionEmpty')}</p>
            {:else}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html rendered}
            {/if}
          </div>
        {:else}
          <textarea
            class="block min-h-[140px] w-full resize-y bg-canvas px-3 py-3 font-mono text-micro
                   leading-5 text-ink focus:outline-none"
            aria-label={tr('admin.competitions.descriptionLabel')}
            placeholder={tr('admin.competitions.descriptionPlaceholder')}
            maxlength={LIMITS.description}
            bind:value={description}
          ></textarea>
        {/if}
      </div>
    </div>
    {@render marker('basics')}
  </Section>

  <!-- 2 · Данные -->
  <Section title={tr('admin.competitions.section.data')} description={tr('admin.competitions.dataHint')}>
    <div class="flex flex-wrap items-start gap-3">
      <div class="min-w-0 flex-[2_1_320px] border border-line">
        <div class="flex items-center border-b border-line px-3 py-2">
          <span class={HEAD}>{tr('admin.competitions.openFilesHead')}</span>
          <span class="ml-auto font-mono text-micro text-faint">
            {formatBytes(view.dataBytes)} / {formatBytes(LIMITS.dataBytes)}
          </span>
        </div>
        {#each view.openFiles as file (file.name)}
          <div class="flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-b-0">
            <span class="min-w-0 flex-1 truncate font-mono text-micro text-ink" title={file.name}>
              {file.name}
            </span>
            <span class="w-[110px] shrink-0 text-micro text-muted">
              {file.rows === null
                ? ''
                : tr('admin.competitions.rows', { count: file.rows, n: count(file.rows) })}
            </span>
            <span class="w-[64px] shrink-0 text-right font-mono text-micro text-muted">
              {formatBytes(file.bytes)}
            </span>
            <button
              type="button"
              class="shrink-0 text-muted transition-colors duration-100 hover:text-danger disabled:text-faint"
              disabled={busy}
              aria-label={tr('admin.competitions.dropFile', { name: file.name })}
              title={tr('admin.competitions.dropFile', { name: file.name })}
              onclick={() => void dropFile(file)}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        {:else}
          <p class="px-3 py-4 text-ui text-muted">{tr('admin.competitions.noData')}</p>
        {/each}
        <label class="flex cursor-pointer items-center px-3 py-2.5 text-micro text-accent-text hover:brightness-110">
          <input
            type="file"
            multiple
            class="sr-only"
            disabled={busy}
            onchange={(event) => {
              void upload(event.currentTarget.files, 'data')
              event.currentTarget.value = ''
            }}
          />
          {tr('admin.competitions.addFiles', { mb: Math.round(LIMITS.dataBytes / 1024 / 1024) })}
        </label>
      </div>

      <!--
        Ответы — своей рамкой и своим цветом, и это не украшение: единственная
        ошибка этой формы, которую нельзя отменить, — положить ответы в
        открытые файлы. Разный цвет дороже любой подписи.
      -->
      <div class="min-w-0 flex-[1_1_300px] border border-brand">
        <div class="flex items-center gap-2 border-b border-primary bg-brand px-3 py-2">
          <Icon name="lock" size={12} class="shrink-0 text-white" />
          <span class="text-micro font-bold uppercase tracking-caps text-white">
            {tr('admin.competitions.hiddenHead')}
          </span>
        </div>
        {#each view.hiddenFiles as file (file.name)}
          <div class="flex items-center gap-3 border-b border-line px-3 py-2">
            <span class="min-w-0 flex-1 truncate font-mono text-micro text-ink">{file.name}</span>
            <span class="shrink-0 text-micro text-muted">
              {[
                file.rows === null
                  ? null
                  : tr('admin.competitions.rows', { count: file.rows, n: count(file.rows) }),
                file.columns?.join(', ') ?? null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {#if adminAuth.isOwner}
              <button
                type="button"
                class="shrink-0 text-muted transition-colors duration-100 hover:text-danger disabled:text-faint"
                disabled={busy}
                aria-label={tr('admin.competitions.dropFile', { name: file.name })}
                title={tr('admin.competitions.dropFile', { name: file.name })}
                onclick={() => void dropFile(file)}
              >
                <Icon name="trash" size={13} />
              </button>
            {/if}
          </div>
        {:else}
          <label class="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2.5 text-micro text-accent-text hover:brightness-110">
            <input
              type="file"
              accept=".csv,text/csv"
              class="sr-only"
              disabled={busy}
              onchange={(event) => {
                void upload(event.currentTarget.files, 'solution')
                event.currentTarget.value = ''
              }}
            />
            {tr('admin.competitions.addSolution')}
          </label>
        {/each}

        <div class="flex flex-col gap-1.5 px-3 py-2.5">
          <div class="flex items-center gap-2">
            <input
              class="h-7 w-[52px] border border-line bg-canvas text-center font-mono text-2xs text-ink
                     focus:outline-none focus:ring-2 focus:ring-accent/40"
              type="number"
              min={LIMITS.publicPercent.min}
              max={LIMITS.publicPercent.max}
              aria-label={tr('admin.competitions.publicPercentLabel')}
              bind:value={publicPercent}
            />
            <span class="text-2xs text-ink">{tr('admin.competitions.publicPercentUnit')}</span>
          </div>
          <p class="text-micro leading-snug text-muted">
            {#if view.split}
              {tr('admin.competitions.splitNow', {
                count: view.split.publicRows,
                n: count(view.split.publicRows),
              })},
              {tr('admin.competitions.splitAfter', { n: count(view.split.privateRows) })}
              {view.split.byUsage
                ? tr('admin.competitions.splitByUsage')
                : tr('admin.competitions.splitBySeed')}
            {:else}
              {tr('admin.competitions.splitUnknown')}
            {/if}
          </p>
        </div>
      </div>
    </div>
    {@render marker('data')}
  </Section>

  <!-- 3 · Сэмпл-тетрадь -->
  <Section
    title={tr('admin.competitions.section.baseline')}
    description={tr('admin.competitions.baselineHint')}
  >
    <div class="flex flex-col gap-2.5">
      {#if view.baseline}
        {@const b = view.baseline.inputsCurrent === false && view.baseline.state === 'scored' ? { ...view.baseline, state: null } : view.baseline}
        <div class="flex flex-wrap items-center gap-3.5 border border-line px-3.5 py-3">
          <Icon name="notebook" size={16} class="shrink-0 text-primary" />
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-2xs text-ink">{b.fileName}</p>
            <p class="mt-0.5 text-micro text-muted">
              {[
                b.cells === null ? null : tr('admin.competitions.cells', { count: b.cells }),
                tr('admin.competitions.uploadedAt', { when: moment(b.uploadedAt, now) }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <label class="shrink-0 cursor-pointer text-2xs text-accent-text hover:brightness-110">
            <input
              type="file"
              accept=".ipynb"
              class="sr-only"
              disabled={busy}
              onchange={(event) => {
                void upload(event.currentTarget.files, 'baseline')
                event.currentTarget.value = ''
              }}
            />
            {tr('admin.competitions.replace')}
          </label>
        </div>

        <!--
          Проверка бейзлайна — не галочка, а настоящая посылка: тот же
          одноразовый контейнер, та же очередь, тот же путь до числа. Пока она
          его не прошла, соревнование не открыть.
        -->
        <div
          class={cn(
            'flex flex-wrap items-stretch border',
            b.state === 'scored'
              ? 'border-positive'
              : b.state === null || b.state === 'queued' || b.state === 'running'
                ? 'border-line'
                : 'border-danger',
          )}
        >
          <div
            class={cn(
              'flex w-[150px] shrink-0 flex-col justify-center gap-1 px-3.5 py-3 max-[640px]:w-full',
              b.state === 'scored'
                ? 'bg-positive text-white dark:text-canvas'
                : b.state === null || b.state === 'queued' || b.state === 'running'
                  ? 'bg-surface text-ink'
                  : 'bg-danger text-white dark:text-canvas',
            )}
          >
            <span class="text-micro font-bold uppercase tracking-caps">
              {b.state === null
                ? tr('admin.competitions.baselineNotRunShort')
                : b.state === 'scored'
                  ? tr('admin.competitions.baselinePasses')
                  : b.state === 'queued' || b.state === 'running'
                    ? tr('admin.competitions.baselineGoing')
                    : tr('admin.competitions.baselineBroken')}
            </span>
            {#if b.durationMs !== null}
              <span class="text-micro opacity-85">
                {tr('admin.competitions.ofLimit', {
                  span: spanWords(b.durationMs),
                  limit: Math.round(c.limits.wallSeconds / 60),
                })}
              </span>
            {/if}
          </div>

          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-9 gap-y-3 px-4 py-3">
            <div class="shrink-0">
              <p class={HEAD}>{tr('admin.competitions.publicScore')}</p>
              <p class="font-mono text-head font-bold text-ink">{metricNumber(b.publicScore)}</p>
            </div>
            <div class="shrink-0">
              <p class={HEAD}>{tr('admin.competitions.privateScore')}</p>
              <p class="font-mono text-head font-bold text-ink">{metricNumber(b.privateScore)}</p>
            </div>
            <p class="min-w-0 flex-1 basis-[240px] text-micro leading-snug text-muted">
              {#if b.teacherError}
                <!-- Трейс — только здесь и только преподавателю: участнику он
                     ничего не объясняет, а виноват в нём чужой код. -->
                <span class="whitespace-pre-wrap font-mono text-danger">{b.teacherError}</span>
              {:else if b.participantError}
                <span class="text-warning">{b.participantError}</span>
              {:else if b.state === 'scored'}
                {tr('admin.competitions.baselinePassed', { env: c.environment })}
              {:else}
                {tr('admin.competitions.baselineWaiting')}
              {/if}
            </p>
            {#if view.capabilities?.execution.available === false}
              <p class="text-micro text-warning" role="status">{view.capabilities.execution.reason}</p>
            {/if}
            <button
              type="button"
              class="shrink-0 text-2xs text-accent-text underline decoration-dotted underline-offset-4
                     hover:brightness-110 disabled:text-faint"
              disabled={busy || baselineInFlight || view.capabilities?.execution.available === false}
              onclick={() => void checkBaseline()}
            >
              {b.state === null
                ? tr('admin.competitions.checkBaseline')
                : tr('admin.competitions.checkAgain')}
            </button>
          </div>
        </div>
      {:else}
        <label
          class="flex cursor-pointer flex-col items-center gap-2 border border-dashed border-brand-2
                 bg-surface px-4 py-8 text-center"
        >
          <input
            type="file"
            accept=".ipynb"
            class="sr-only"
            disabled={busy}
            onchange={(event) => {
              void upload(event.currentTarget.files, 'baseline')
              event.currentTarget.value = ''
            }}
          />
          <span class="text-ui font-semibold text-ink">{tr('admin.competitions.noBaseline')}</span>
          <span class="max-w-sm text-micro leading-snug text-muted">
            {tr('admin.competitions.noBaselineHint', {
              mb: Math.round(LIMITS.notebookBytes / 1024 / 1024),
            })}
          </span>
          <span class="btn-outline mt-1">{tr('admin.competitions.pickFile')}</span>
        </label>
      {/if}
    </div>
    {@render marker('baseline')}
  </Section>

  <!-- 4 · Метрика -->
  <Section title={tr('admin.competitions.section.metric')} description={tr('admin.competitions.metricHint')}>
    <div class="flex flex-col gap-2.5">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class={HEAD}>{tr('admin.competitions.presets')}</span>
        <div class="min-w-0">
          <Choice
            options={METRIC_PRESETS.map((preset) => ({ value: preset.name, label: preset.name }))}
            value={presetName}
            onchange={pickPreset}
          />
        </div>
        <!-- shrink-0: иначе пара «меньше — лучше | больше — лучше» ужимается по
             месту, оставшемуся от чипов, и переносится посреди слова. -->
        <div class="ml-auto shrink-0 whitespace-nowrap">
          <Choice
            size="lg"
            options={[
              { value: 'lower', label: tr('competitions.direction.lower') },
              { value: 'higher', label: tr('competitions.direction.higher') },
            ]}
            value={metricDirection}
            onchange={(value) => (metricDirection = value as MetricDirection)}
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2.5">
        <input
          class="field w-[200px] max-w-full"
          aria-label={tr('admin.competitions.metricNameLabel')}
          placeholder={tr('admin.competitions.metricNamePlaceholder')}
          maxlength={LIMITS.metricName}
          bind:value={metricName}
        />
        <span class="text-micro text-muted">{tr('admin.competitions.metricNameHint')}</span>
      </div>

      <!--
        Жёлоб номеров строк — не украшение: трейс метрики, который придёт с
        чужой посылки, называет строку («score(), строка 9»), и искать её в
        поле без номеров приходится пальцем по экрану.
      -->
      <div class="flex border border-line bg-surface">
        <div
          class="w-9 shrink-0 select-none border-r border-line py-3 pr-2 text-right font-mono
                 text-micro leading-5 text-faint"
          aria-hidden="true"
        >
          {#each Array.from({ length: codeLines }, (_, i) => i + 1) as line (line)}
            <div>{line}</div>
          {/each}
        </div>
        <textarea
          class="block min-h-[200px] w-full resize-y bg-transparent px-3.5 py-3 font-mono text-micro
                 leading-5 text-ink focus:outline-none"
          spellcheck="false"
          aria-label={tr('admin.competitions.metricCodeLabel')}
          placeholder={presetCode('MAPE', columns)}
          maxlength={LIMITS.metricCode}
          bind:value={metricCode}
        ></textarea>
      </div>

      <div class="flex flex-wrap items-center gap-3.5">
        <button
          type="button"
          class="btn-outline h-[30px] border-primary px-3 text-micro font-bold text-primary"
          disabled={busy || !view.baseline || view.capabilities?.execution.available === false}
          onclick={() => void checkMetric()}
        >
          {tr('admin.competitions.checkMetric')}
        </button>
        <p class="min-w-0 flex-1 basis-[280px] text-micro leading-snug text-muted">
          {tr('admin.competitions.checkMetricHint')}
        </p>
      </div>
      {#if isUntouchedPreset(metricCode, columns) && solution}
        <p class="text-micro text-muted">
          {tr('admin.competitions.presetColumns', { id: columns.id, target: columns.target })}
        </p>
      {/if}
    </div>
    {@render marker('metric')}
  </Section>

  <!-- 5 · Исполнение посылки -->
  <Section title={tr('admin.competitions.section.run')} description={tr('admin.competitions.runHint')}>
    <div class="flex flex-col gap-3.5">
      <div class="flex flex-wrap items-center gap-2.5 border border-line px-3.5 py-2.5">
        <span class="h-2 w-2 shrink-0 bg-accent" aria-hidden="true"></span>
        <select
          class="h-7 min-w-0 border border-line bg-canvas px-1.5 font-mono text-2xs text-ink
                 focus:outline-none focus:ring-2 focus:ring-accent/40"
          aria-label={tr('admin.competitions.environmentLabel')}
          bind:value={environment}
        >
          {#if !environments.some((one) => one.name === environment)}
            <option value={environment}>{environment}</option>
          {/if}
          {#each environments as one (one.name)}
            <option value={one.name}>{one.name}</option>
          {/each}
        </select>
        {#if chosenEnvironment}
          <Badge
            word={chosenEnvironment.state === 'ready'
              ? tr('admin.competitions.envReady')
              : tr('admin.competitions.envUnbuilt')}
            tone={chosenEnvironment.state === 'ready' ? 'positive' : 'warning'}
          />
          <span class="min-w-0 flex-1 truncate text-micro text-muted">
            {chosenEnvironment.packages.slice(0, 6).join(', ')}
          </span>
        {/if}
        <span class="ml-auto shrink-0 text-micro text-muted">
          {tr('admin.competitions.sameAsRoom')}
        </span>
      </div>

      <div class="flex flex-wrap gap-2.5">
        <label class="{TILE} min-w-0 flex-1 basis-[150px]">
          <span class={HEAD}>{tr('admin.competitions.limit.time')}</span>
          <span class="flex items-baseline gap-1.5">
            <input
              class="w-[64px] border-b border-line bg-transparent font-mono text-head font-bold text-ink
                     focus:outline-none focus:border-accent"
              type="number"
              min={Math.ceil(LIMITS.wallSeconds.min / 60)}
              max={Math.floor(LIMITS.wallSeconds.max / 60)}
              value={Math.round(limits.wallSeconds / 60)}
              oninput={(event) => {
                const minutes = Number(event.currentTarget.value)
                if (Number.isFinite(minutes) && minutes > 0) limits.wallSeconds = Math.round(minutes * 60)
              }}
            />
            <span class="text-2xs text-muted">{tr('admin.competitions.limit.timeUnit')}</span>
          </span>
        </label>
        <label class="{TILE} min-w-0 flex-1 basis-[150px]">
          <span class={HEAD}>{tr('admin.competitions.limit.memory')}</span>
          <span class="flex items-baseline gap-1.5">
            <input
              class="w-[64px] border-b border-line bg-transparent font-mono text-head font-bold text-ink
                     focus:outline-none focus:border-accent"
              type="number"
              step="0.5"
              min={LIMITS.memoryMb.min / 1024}
              max={LIMITS.memoryMb.max / 1024}
              value={Number((limits.memoryMb / 1024).toFixed(1))}
              oninput={(event) => {
                const gb = Number(event.currentTarget.value)
                if (Number.isFinite(gb) && gb > 0) limits.memoryMb = Math.round(gb * 1024)
              }}
            />
            <span class="text-2xs text-muted">{tr('admin.competitions.limit.memoryUnit')}</span>
          </span>
        </label>
        <label class="{TILE} min-w-0 flex-1 basis-[150px]">
          <span class={HEAD}>{tr('admin.competitions.limit.cpu')}</span>
          <span class="flex items-baseline gap-1.5">
            <input
              class="w-[64px] border-b border-line bg-transparent font-mono text-head font-bold text-ink
                     focus:outline-none focus:border-accent"
              type="number"
              min={LIMITS.cpus.min}
              max={LIMITS.cpus.max}
              bind:value={limits.cpus}
            />
            <span class="text-2xs text-muted">{tr('admin.competitions.limit.cpuUnit')}</span>
          </span>
        </label>
        <label class="{TILE} min-w-0 flex-1 basis-[150px]">
          <span class={HEAD}>{tr('admin.competitions.limit.perDay')}</span>
          <span class="flex items-baseline gap-1.5">
            <input
              class="w-[64px] border-b border-line bg-transparent font-mono text-head font-bold text-ink
                     focus:outline-none focus:border-accent"
              type="number"
              min={LIMITS.perDay.min}
              max={LIMITS.perDay.max}
              bind:value={limits.perDay}
            />
            <span class="text-2xs text-muted">{tr('admin.competitions.limit.perDayUnit')}</span>
          </span>
        </label>
      </div>

      <p class="text-micro leading-snug text-muted">
        {#if resources?.memory.availableMb != null}
          {tr('admin.competitions.machineFree', {
            free: gb(resources.memory.availableMb),
            rest: gb(Math.max(0, resources.memory.availableMb - limits.memoryMb)),
          })}
        {/if}
        {tr('admin.competitions.quotaNote')}
      </p>
    </div>
  </Section>

  {#key c.id}<DependencySettings competitionId={c.id} />{/key}

  <!-- 6 · Сроки и зачёт -->
  <Section title={tr('admin.competitions.section.terms')} description={tr('admin.competitions.termsHint')}>
    <div class="flex flex-col gap-3.5">
      <div class="flex flex-wrap gap-2.5">
        <label class="min-w-0 flex-1 basis-[220px]">
          <span class="mb-1 block {HEAD}">{tr('admin.competitions.startsAt')}</span>
          <input
            class="field font-mono text-2xs"
            type="datetime-local"
            aria-label={tr('admin.competitions.startsAt')}
            bind:value={startsAt}
          />
          <span class="mt-1 block text-micro text-muted">{tr('admin.competitions.startsAtHint')}</span>
        </label>
        <label class="min-w-0 flex-1 basis-[220px]">
          <span class="mb-1 block {HEAD}">{tr('admin.competitions.deadlineAt')}</span>
          <input
            class="field font-mono text-2xs"
            type="datetime-local"
            aria-label={tr('admin.competitions.deadlineAt')}
            bind:value={deadline}
          />
          <span class="mt-1 block text-micro text-muted">{tr('admin.competitions.deadlineHint')}</span>
        </label>
      </div>

      <div>
        <p class="mb-1.5 {HEAD}">{tr('admin.competitions.privateBoard')}</p>
        <Choice
          size="lg"
          options={[
            { value: 'auto', label: tr('admin.competitions.privateAuto') },
            { value: 'manual', label: tr('admin.competitions.privateManual') },
          ]}
          value={privateRelease}
          onchange={(value) => (privateRelease = value as PrivateRelease)}
        />
      </div>

      <div>
        <p class="mb-1.5 {HEAD}">{tr('admin.competitions.scoringHead')}</p>
        <Choice
          size="lg"
          options={[
            { value: 'chosen', label: tr('admin.competitions.scoringChosen') },
            { value: 'bestPublic', label: tr('admin.competitions.scoringBest') },
            { value: 'last', label: tr('admin.competitions.scoringLast') },
          ]}
          value={scoring}
          onchange={(value) => (scoring = value as ScoringRule)}
        />
      </div>

      <p class="text-micro leading-snug text-muted">{tr('admin.competitions.scoringNote')}</p>
    </div>
    {@render marker('terms')}
  </Section>

  <!--
    Кнопки внизу формы — не дубль верхних, а единственные для вкладки
    «Настройки»: там своей шапки у формы нет. На черновике они остаются
    вторым, ближним экземпляром: форма длиной в полтора экрана, и возвращаться
    к шапке за «Сохранить» — это прокрутка ради нажатия.
  -->
  <div class="flex flex-wrap items-center gap-3 border-t border-line py-5">
    <!-- «Сохранить черновик» — только у черновика: у идущего соревнования
         сохраняется не черновик, а настройки, которые класс видит сейчас. -->
    <button type="button" class="btn-primary" disabled={busy} onclick={() => void save()}>
      {saved
        ? tr('admin.competitions.savedWord')
        : draftState
          ? tr('admin.competitions.saveDraft')
          : tr('admin.save')}
    </button>
    {#if draftState}
      <button type="button" class="btn-outline" disabled={busy || refusal !== null || view.capabilities?.execution.available === false} onclick={() => void open()}>
        {tr('admin.competitions.openCompetition')}
      </button>
    {/if}
    {#if refusal !== null && draftState}
      <p class="min-w-0 flex-1 basis-[280px] text-micro leading-snug text-warning">
        {refusalText(refusal)}
      </p>
    {/if}
  </div>
{/snippet}

{#if embedded}
  {@render form()}
{:else}
  <AdminPage title={c.title}>
    {#snippet eyebrow()}
      <button
        type="button"
        class="shrink-0 text-micro text-muted transition-colors duration-100 hover:text-ink"
        onclick={() => navigate('/admin/competitions')}
      >
        {tr('competitions.title')}
      </button>
      <span aria-hidden="true">/</span>
      <span class="truncate font-mono">
        {draftState ? tr('admin.competitions.crumbDraft') : `/k/${c.slug}`}
      </span>
    {/snippet}

    {#snippet beside()}
      <Badge word={stateWord(c.state)} tone={stateTone(c.state)} />
    {/snippet}

    {#snippet actions()}
      <button
        type="button"
        class="btn-ghost max-[640px]:h-11"
        onclick={() => navigate('/admin/competitions')}
      >
        {tr('admin.cancel')}
      </button>
      <button
        type="button"
        class="btn-outline max-[640px]:h-11 max-[640px]:flex-1"
        disabled={busy}
        onclick={() => void save()}
      >
        {saved ? tr('admin.competitions.savedWord') : tr('admin.competitions.saveDraft')}
      </button>
      <!-- Гейт: открыть соревнование, задача которого не решается даже у
           автора, — это сто человек, безуспешно ищущих ошибку у себя. -->
      {#if draftState}
        <button
          type="button"
          class="btn-primary text-micro font-bold uppercase tracking-caps max-[640px]:h-11 max-[640px]:flex-1"
          disabled={busy || refusal !== null || view.capabilities?.execution.available === false}
          title={refusal === null ? undefined : refusalText(refusal)}
          onclick={() => void open()}
        >
          {tr('admin.competitions.openCompetition')}
        </button>
      {/if}
    {/snippet}

    {@render form()}
  </AdminPage>
{/if}

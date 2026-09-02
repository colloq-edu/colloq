<!--
  Курсы: список и один курс.

  Курс — это адрес, который дают классу в первую неделю и больше не дают
  ничего. Поэтому у него нет ни архива, ни скрытия, а удаление живёт внутри
  самого курса и называет ссылку, которую ломает.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi, type AdminPublication } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { plural } from '@/lib/plural'
  import {
    MAX_COURSE_NAME,
    slugOk,
    suggestSlug,
    type Course,
    type CourseItem,
  } from '@shared/publish'
  import type { AdminSeminar } from '@shared/admin'

  interface Props {
    /** Открытый курс, если адрес его называет. */
    open: string | null
    navigate: (path: string) => void
  }

  let { open, navigate }: Props = $props()

  let courses = $state<Course[]>([])
  let course = $state<Course | null>(null)
  let seminars = $state<AdminSeminar[]>([])
  let error = $state<string | null>(null)
  let busy = $state(false)
  let creating = $state(false)
  let draftName = $state('')
  let copied = $state<string | null>(null)
  let adding = $state(false)
  /** Курс запрошен, ответа ещё нет: пустая область — не ответ. */
  let loadingOne = $state(false)

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : 'что-то пошло не так'

  /** Адрес, который диктуют вслух: имя, если его дали, иначе идентификатор. */
  const addressOf = (item: { id: string; slug: string | null }): string => item.slug ?? item.id

  async function loadList(): Promise<void> {
    try {
      courses = await adminApi.listCourses()
      navCounts.courses = courses.length
      await loadOrphans()
    } catch (cause) {
      error = explain(cause)
    }
  }

  async function loadOne(id: string): Promise<void> {
    loadingOne = true
    try {
      course = await adminApi.course(id)
      error = null
    } catch (cause) {
      // Курса по этому адресу нет — ветка внизу скажет это словами, а раньше на
      // его месте была пустая область.
      course = null
      error = explain(cause)
      return
    } finally {
      loadingOne = false
    }
    try {
      // Список семинаров нужен только кнопке «Добавить семинар»: без него экран
      // курса остаётся целым, и объявлять курс ненайденным из-за него нельзя.
      seminars = await adminApi.listSeminars()
    } catch (cause) {
      error = explain(cause)
    }
  }

  onMount(() => {
    if (open) void loadOne(open)
    else void loadList()
  })

  $effect(() => {
    const id = open
    if (id) void loadOne(id)
    else {
      course = null
      void loadList()
    }
  })

  async function create(): Promise<void> {
    const name = draftName.trim()
    // busy проверяется, а не только выставляется: кнопка по нему гаснет, а Enter
    // с автоповтором — нет, и полсекунды удержания заводили пять одинаковых
    // курсов, каждый со своим адресом.
    if (!name || busy) return
    busy = true
    try {
      const made = await adminApi.createCourse({ name })
      draftName = ''
      creating = false
      navigate(`/admin/courses/${made.id}`)
    } catch (cause) {
      error = explain(cause)
    } finally {
      busy = false
    }
  }

  /**
   * Один порядок — один запрос, со сравнением версии.
   *
   * Несовпадение не ошибка, а гонка: другой преподаватель переставил этот курс,
   * пока экран держал его старым. Ответ несёт список таким, какой он сейчас.
   */
  async function writeItems(items: CourseItem[]): Promise<void> {
    if (!course) return
    busy = true
    error = null
    try {
      course = await adminApi.setCourseItems(course.id, course.rev, items)
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.status === 409) {
        error = 'Этот курс успел изменить кто-то ещё. Вот он, каким стал.'
        await loadOne(course.id)
      } else {
        error = explain(cause)
      }
    } finally {
      busy = false
    }
  }

  function move(index: number, by: -1 | 1): void {
    if (!course) return
    const next = [...course.items]
    const to = index + by
    if (to < 0 || to >= next.length) return
    ;[next[index], next[to]] = [next[to], next[index]]
    void writeItems(next)
  }

  function drop(index: number): void {
    if (!course) return
    void writeItems(course.items.filter((_, i) => i !== index))
  }

  function add(sessionId: string): void {
    if (!course) return
    const session = seminars.find((s) => s.id === sessionId)
    if (!session) return
    adding = false
    void writeItems([
      ...course.items,
      { kind: 'seminar', sessionId, name: session.name, publication: null },
    ])
  }

  /** Семинары, которых в этом курсе ещё нет. */
  const addable = $derived(
    seminars.filter(
      (s) => !course?.items.some((i) => i.kind === 'seminar' && i.sessionId === s.id),
    ),
  )

  async function copy(text: string, key: string): Promise<void> {
    await copyText(text)
    copied = key
    setTimeout(() => (copied = copied === key ? null : copied), 1600)
  }

  /**
   * Черновики полей курса.
   *
   * Предложение из названия — только когда имени ещё нет: подставлять его
   * поверх выбранного человеком значило бы переписывать чужое решение при
   * каждом открытии экрана.
   *
   * Ключ — идентификатор курса, а не сам объект: `course` переприсваивается
   * ответом сервера после каждой перестановки строк, и эффект, зависевший от
   * объекта, стирал набранный, но не сохранённый адрес — вместе с кнопкой
   * «Сохранить адрес», которой его собирались сохранить.
   */
  let slugDraft = $state('')
  let nameDraft = $state('')
  let blurbDraft = $state('')
  let drafted: string | null = null

  $effect(() => {
    const open = course
    if (!open) {
      drafted = null
      return
    }
    if (drafted === open.id) return
    drafted = open.id
    slugDraft = open.slug ?? suggestSlug(open.name)
    nameDraft = open.name
    blurbDraft = open.blurb ?? ''
  })

  async function saveSlug(): Promise<void> {
    if (!course || busy) return
    const next = slugDraft.trim().toLowerCase()
    if (next && !slugOk(next)) {
      error = 'Только строчные латинские буквы, цифры и дефис — адрес диктуют вслух.'
      return
    }
    busy = true
    error = null
    try {
      await adminApi.setSlug('course', course.id, next || null)
      await loadOne(course.id)
    } catch (cause) {
      error = explain(cause)
    } finally {
      busy = false
    }
  }
  /**
   * Название и подпись курса.
   *
   * Их не было нигде: курс, заведённый с опечаткой в названии, оставался с ней
   * навсегда, и опечатку видел весь класс на публичной странице.
   */
  const detailsChanged = $derived(
    Boolean(course) &&
      (nameDraft.trim() !== course?.name || blurbDraft.trim() !== (course?.blurb ?? '')),
  )

  async function saveDetails(): Promise<void> {
    const open = course
    if (!open || busy) return
    const name = nameDraft.trim()
    if (!name) {
      error = 'У курса должно быть название — его видят студенты.'
      return
    }
    busy = true
    error = null
    try {
      course = await adminApi.updateCourse(open.id, { name, blurb: blurbDraft.trim() || null })
    } catch (cause) {
      error = explain(cause)
    } finally {
      busy = false
    }
  }

  /**
   * Удаление курса — здесь же, и оно называет ссылку, которую ломает.
   *
   * Сами семинары и их страницы остаются: курс — это порядок и адрес, а не
   * хранилище. Ломается ровно то, что классу продиктовали в первую неделю.
   */
  let doomed = $state(false)

  async function destroy(): Promise<void> {
    const open = course
    if (!open || busy) return
    busy = true
    error = null
    try {
      await adminApi.deleteCourse(open.id)
      doomed = false
      navigate('/admin/courses')
    } catch (cause) {
      error = explain(cause)
    } finally {
      busy = false
    }
  }

  /**
   * Страницы, у которых больше нет комнаты.
   *
   * Удаление семинара по умолчанию оставляет чтение: розданную ссылку не
   * отозвать. Но дальше страница пропадала из панели совсем — все остальные
   * маршруты публикации спрашивают её по семинару, — и снять её можно было
   * только правкой базы. Здесь она видна и снимается.
   */
  let orphans = $state<AdminPublication[]>([])
  let orphanBusy = $state<string | null>(null)

  async function loadOrphans(): Promise<void> {
    try {
      orphans = (await adminApi.listPublications()).filter((p) => p.orphaned)
    } catch {
      // Не беда: это приписка к списку курсов, а не сам список.
      orphans = []
    }
  }

  async function actOnOrphan(id: string, what: () => Promise<void>): Promise<void> {
    orphanBusy = id
    error = null
    try {
      await what()
      await loadOrphans()
    } catch (cause) {
      error = explain(cause)
    } finally {
      orphanBusy = null
    }
  }

  const ROW = 'flex items-center gap-4 border-t border-line py-2.5'
  const ARROW =
    'flex h-6 w-6 items-center justify-center border border-line text-muted transition-colors ' +
    'duration-100 hover:border-faint hover:text-ink disabled:border-line-soft disabled:text-faint'
</script>

{#if !open}
  <AdminPage
    title="Courses"
    subtitle="Постоянная страница на семестр семинаров, в том порядке, в каком вы их вели."
  >
    {#snippet actions()}
      <button type="button" class="btn-primary" onclick={() => (creating = true)}>New course</button>
    {/snippet}

    <div class="px-8 py-6">
      {#if error}
        <p class="pb-4 text-ui text-danger">{error}</p>
      {/if}

      {#if creating}
        <div class="mb-5 flex items-center gap-3 border border-line bg-surface px-4 py-3">
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="h-9 min-w-0 flex-1 border border-line bg-canvas px-3 text-ui text-ink"
            placeholder="Название курса"
            maxlength={MAX_COURSE_NAME}
            autofocus
            bind:value={draftName}
            onkeydown={(event) => {
              if (event.key === 'Enter') void create()
              if (event.key === 'Escape') creating = false
            }}
          />
          <button type="button" class="btn-primary shrink-0" disabled={busy} onclick={() => void create()}>
            Создать
          </button>
          <button type="button" class="btn-ghost shrink-0" onclick={() => (creating = false)}>
            Отмена
          </button>
        </div>
      {/if}

      {#if courses.length === 0 && !creating}
        <div class="py-16 text-center">
          <p class="text-title font-semibold text-ink">Курсов пока нет</p>
          <p class="mx-auto mt-2 max-w-sm text-ui text-muted">
            Курс — одна ссылка, которую вы даёте классу в первую неделю и больше не даёте ничего.
          </p>
        </div>
      {/if}

      {#each courses as item (item.id)}
        {@const published = item.items.filter(
          (i) => i.kind === 'seminar' && i.publication !== null,
        ).length}
        {@const waiting = item.items.filter(
          (i) => i.kind === 'seminar' && i.publication === null,
        ).length}
        <div class="flex items-center gap-5 border-b border-line py-3.5">
          <button
            type="button"
            class="min-w-0 flex-1 text-left"
            onclick={() => navigate(`/admin/courses/${item.id}`)}
          >
            <p class="text-ui-lg font-semibold text-ink">{item.name}</p>
            <!-- Адрес печатается тот же, что диктуют классу: смысл имени в том,
                 что оно и есть ссылка, а не второй адрес рядом с ней. -->
            <p class="mt-0.5 font-mono text-2xs text-muted">/c/{addressOf(item)}</p>
          </button>
          <p class="shrink-0 text-ui text-muted">
            {published} опубликовано · {waiting} ещё нет
          </p>
        </div>
      {/each}

      <!--
        Страницы без комнаты. Сервер их отдаёт и `make site` выкладывает, а в
        панели их не было видно нигде — снять оставшуюся после удалённого
        семинара страницу можно было только правкой базы.
      -->
      {#if orphans.length > 0}
        <div class="mt-8 border-t border-line pt-5">
          <p class="text-ui font-semibold text-ink">Страницы без комнаты</p>
          <p class="mt-1 max-w-xl text-2xs leading-relaxed text-muted">
            Семинар удалён, а его публичная страница осталась — так и задумано: розданную ссылку не
            отозвать. Отсюда её можно снять (адрес скажет, что страницу убрали) или вернуть.
          </p>
          {#each orphans as page (page.id)}
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line py-3">
              <div class="min-w-0 flex-1">
                <p class="truncate text-ui text-ink">{page.title}</p>
                <p class="mt-0.5 font-mono text-2xs text-muted">
                  /p/{addressOf(page)} · {page.steps}
                  {plural(page.steps, 'шаг', 'шага', 'шагов')}
                  {page.state === 'withdrawn' ? ' · снята' : ''}
                </p>
              </div>
              <a class="shrink-0 text-ui text-accent-text" href={`/p/${addressOf(page)}`} target="_blank" rel="noreferrer">
                Открыть
              </a>
              {#if page.state === 'published'}
                <button
                  type="button"
                  class="shrink-0 text-ui font-semibold text-muted hover:text-ink"
                  disabled={orphanBusy === page.id}
                  onclick={() => void actOnOrphan(page.id, () => adminApi.withdrawPublication(page.id))}
                >
                  Снять страницу
                </button>
              {:else}
                <button
                  type="button"
                  class="shrink-0 text-ui font-semibold text-muted hover:text-ink"
                  disabled={orphanBusy === page.id}
                  onclick={() => void actOnOrphan(page.id, () => adminApi.restorePublication(page.id))}
                >
                  Вернуть страницу
                </button>
                <!-- Стереть — только владельцу и только у снятой: снятую можно
                     вернуть, стёртую нельзя, и надгробие в курсе теряет ссылку. -->
                {#if adminAuth.isOwner}
                  <button
                    type="button"
                    class="shrink-0 text-ui font-semibold text-danger"
                    disabled={orphanBusy === page.id}
                    onclick={() => {
                      if (!window.confirm(`Стереть страницу /p/${addressOf(page)} совсем? Вернуть её будет нечем.`)) return
                      void actOnOrphan(page.id, () => adminApi.erasePublication(page.id))
                    }}
                  >
                    Стереть совсем
                  </button>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </AdminPage>
{:else if course}
  {@const shown = course}
  <AdminPage title={shown.name}>
    {#snippet actions()}
      <!-- Копируется тот же адрес, что диктуют вслух: /c/<имя>, если имя дали.
           Иначе в чат уходил идентификатор, и у класса оказывалось два разных
           адреса одного курса. -->
      <button
        type="button"
        class="btn-ghost"
        onclick={() => void copy(`${location.origin}/c/${addressOf(shown)}`, 'link')}
      >
        {copied === 'link' ? 'Скопировано' : 'Копировать ссылку'}
      </button>
      <a class="btn-ghost" href={`/c/${addressOf(shown)}`} target="_blank" rel="noreferrer">
        Глазами студента
      </a>
      <button type="button" class="btn-primary" onclick={() => (adding = !adding)}>
        + Добавить семинар
      </button>
    {/snippet}

    <div class="px-8 py-6">
      <button
        type="button"
        class="mb-5 text-ui text-muted transition-colors hover:text-ink"
        onclick={() => navigate('/admin/courses')}
      >
        ← Все курсы
      </button>

      <!--
        Название и подпись — там же, где адрес: курс с опечаткой в названии
        нельзя было поправить нигде, а видит её весь класс.
      -->
      <div class="flex flex-wrap items-center gap-2 pb-4">
        <input
          class="h-9 w-[280px] max-w-full border border-line bg-canvas px-3 text-ui text-ink
                 focus:outline-none focus:ring-2 focus:ring-accent/40"
          maxlength={MAX_COURSE_NAME}
          aria-label="Название курса"
          bind:value={nameDraft}
          onkeydown={(event) => {
            if (event.key === 'Enter') void saveDetails()
          }}
        />
        <input
          class="h-9 min-w-[220px] flex-1 border border-line bg-canvas px-3 text-ui text-ink
                 placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
          placeholder="Подпись под названием — одна строка, необязательно"
          maxlength={200}
          aria-label="Подпись курса"
          bind:value={blurbDraft}
          onkeydown={(event) => {
            if (event.key === 'Enter') void saveDetails()
          }}
        />
        {#if detailsChanged}
          <button
            type="button"
            class="btn-primary h-9 shrink-0 px-3 text-2xs"
            disabled={busy}
            onclick={() => void saveDetails()}
          >
            Сохранить название
          </button>
        {/if}
      </div>

      <!--
        Адрес курса — то, что диктуют классу вслух и пишут на доске. Поэтому он
        редактируется прямо здесь, а не прячется в настройках: восемь случайных
        символов запоминаются хуже, чем «ml-strong», и переспрашивают их чаще.
      -->
      <div class="flex flex-wrap items-center gap-2 pb-5">
        <span class="font-mono text-2xs text-muted">{location.host}/c/</span>
        <input
          class="h-7 w-[220px] border border-line bg-canvas px-2 font-mono text-2xs text-ink
                 placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
          placeholder={shown.id}
          maxlength={64}
          bind:value={slugDraft}
          onkeydown={(event) => {
            if (event.key === 'Enter') void saveSlug()
          }}
        />
        {#if slugDraft.trim() !== (shown.slug ?? '')}
          <button type="button" class="btn-primary h-7 px-3 text-2xs" disabled={busy} onclick={() => void saveSlug()}>
            Сохранить адрес
          </button>
        {/if}
        {#if shown.slug}
          <span class="text-2xs text-muted">старый адрес /c/{shown.id} тоже работает</span>
        {/if}
      </div>

      {#if error}
        <p class="pb-4 text-ui text-danger">{error}</p>
      {/if}

      <!--
        Утверждение, а не переключатель: видимость курса ничем не управляется, и
        рисовать для неё тумблер значило бы обещать выбор, которого нет.
      -->
      <div class="mb-6 flex flex-wrap items-start gap-x-7 gap-y-2 border-y border-line py-4">
        <div class="w-[220px] shrink-0">
          <p class="text-ui font-semibold text-ink">Что видят студенты</p>
          <p class="mt-0.5 text-2xs leading-snug text-muted">
            Любой, у кого есть ссылка. Без имени и без входа.
          </p>
        </div>
        <p class="min-w-0 max-w-[640px] flex-1 text-ui leading-relaxed text-muted">
          Каждый семинар ниже появляется на странице курса по имени и в этом порядке.
          Опубликованные — ссылками, остальные — строкой «ещё не опубликован». Ссылок на сами
          комнаты там нет никогда.
        </p>
      </div>

      {#if adding}
        <div class="mb-5 border border-line bg-surface p-3">
          {#if addable.length === 0}
            <p class="text-ui text-muted">Все семинары уже в этом курсе.</p>
          {:else}
            <div class="flex flex-wrap gap-2">
              {#each addable as session (session.id)}
                <button
                  type="button"
                  class="border border-line bg-canvas px-3 py-1.5 text-ui text-ink transition-colors hover:border-faint"
                  onclick={() => add(session.id)}
                >
                  {session.name}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <div class="flex items-center gap-4 pb-2">
        <span class="w-[26px] shrink-0"></span>
        <span class="flex-1 text-micro font-bold uppercase tracking-caps text-muted">Семинар</span>
        <span class="w-[290px] shrink-0 text-micro font-bold uppercase tracking-caps text-muted">
          Публикация
        </span>
        <span class="w-[60px] shrink-0"></span>
      </div>

      {#each shown.items as item, index (index)}
        <div class={ROW}>
          <span class="w-[26px] shrink-0 font-mono text-2xs text-faint">
            {String(index + 1).padStart(2, '0')}
          </span>
          {#if item.kind === 'planned'}
            <div class="min-w-0 flex-1">
              <p class="text-ui text-ink">{item.name}</p>
              <p class="mt-0.5 text-2xs text-faint">по плану · {item.when}</p>
            </div>
            <div class="flex w-[290px] shrink-0 items-baseline gap-3">
              <span class="text-ui text-muted">комнаты ещё нет</span>
              <button
                type="button"
                class="text-ui font-semibold text-muted hover:text-ink"
                onclick={() => drop(index)}
              >
                Убрать строку
              </button>
            </div>
          {:else if item.kind === 'gone'}
            <div class="min-w-0 flex-1">
              <p class="text-ui text-muted">{item.name}</p>
              <p class="mt-0.5 text-2xs text-faint">
                семинар удалён · строка остаётся, чтобы номера не поехали
              </p>
            </div>
            <div class="flex w-[290px] shrink-0 items-baseline gap-3">
              <!-- «Публиковать нечего» — правда только когда страницы нет.
                   Комнату удалили, а чтение осталось: с курса до него иначе не
                   дойти, хотя курс — единственный адрес, который дают классу. -->
              {#if item.publication}
                <a
                  class="text-ui text-accent-text"
                  href={`/p/${addressOf(item.publication)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  комната закрыта, страница осталась
                </a>
              {:else}
                <span class="text-ui text-muted">публиковать нечего</span>
              {/if}
              <button type="button" class="text-ui font-semibold text-muted hover:text-ink" onclick={() => drop(index)}>
                Убрать строку
              </button>
            </div>
          {:else}
            <div class="min-w-0 flex-1">
              <p class="text-ui font-semibold text-ink">{item.name}</p>
              <p class="mt-0.5 font-mono text-2xs text-muted">/s/{item.sessionId}</p>
            </div>
            <div class="flex w-[290px] shrink-0 items-baseline gap-3">
              {#if item.publication}
                <a
                  class="text-ui text-accent-text"
                  href={`/p/${addressOf(item.publication)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  опубликован · {item.publication.steps}
                  {plural(item.publication.steps, 'шаг', 'шага', 'шагов')}
                </a>
              {:else}
                <span class="text-ui text-muted">ещё не опубликован</span>
                <button
                  type="button"
                  class="text-ui font-semibold text-accent-text"
                  onclick={() => navigate(`/admin/publish/${item.sessionId}`)}
                >
                  Опубликовать…
                </button>
              {/if}
            </div>
          {/if}
          <div class="flex w-[60px] shrink-0 items-center justify-end gap-1">
            <button
              type="button"
              class={ARROW}
              disabled={index === 0 || busy}
              aria-label="Выше"
              onclick={() => move(index, -1)}
            >
              <Icon name="chevron-up" size={11} />
            </button>
            <button
              type="button"
              class={ARROW}
              disabled={index === shown.items.length - 1 || busy}
              aria-label="Ниже"
              onclick={() => move(index, 1)}
            >
              <Icon name="chevron-down" size={11} />
            </button>
          </div>
        </div>
      {/each}

      {#if shown.items.length === 0}
        <p class="border-t border-line py-8 text-center text-ui text-muted">
          В этом курсе пока нет семинаров.
        </p>
      {/if}

      <p class="border-t border-line pt-4 text-2xs text-muted">
        Порядок на странице курса — этот. Стрелки двигают строку; студенты видят изменение сразу.
      </p>

      <!-- Удаление живёт внутри самого курса и называет ссылку, которую ломает:
           семинары и их страницы остаются, ломается адрес, который классу
           продиктовали в первую неделю. -->
      <div class="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <p class="min-w-0 flex-1 text-2xs text-muted">
          Удалить курс — значит убрать порядок и адрес
          <span class="font-mono">/c/{addressOf(shown)}</span>. Семинары и опубликованные страницы
          остаются на месте.
        </p>
        <button
          type="button"
          class="shrink-0 text-ui font-semibold text-danger hover:brightness-110"
          onclick={() => (doomed = true)}
        >
          Удалить курс…
        </button>
      </div>
    </div>
  </AdminPage>
{:else}
  <!--
    Курс по этому адресу не открылся. Адрес курса дают классу и им делятся с
    коллегой, так что по устаревшему сюда придут — а раньше здесь была пустая
    область без единого слова и без пути назад.
  -->
  <AdminPage title="Курс">
    <div class="px-8 py-16 text-center">
      {#if loadingOne}
        <p class="text-ui text-muted">Открываем курс…</p>
      {:else}
        <p class="text-title font-semibold text-ink">Такого курса здесь нет</p>
        <p class="mx-auto mt-2 max-w-sm text-ui text-muted">
          {error ?? 'Возможно, его удалили — или в адресе опечатка.'}
        </p>
        <button type="button" class="btn-primary mt-4" onclick={() => navigate('/admin/courses')}>
          ← Все курсы
        </button>
      {/if}
    </div>
  </AdminPage>
{/if}

{#if doomed && course}
  {@const going = course}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="delete-course-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="delete-course-title" class="text-title font-semibold text-ink">
        Удалить курс «{going.name}»?
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        Ссылка <span class="font-mono text-ink">/c/{addressOf(going)}</span> перестанет открываться
        — у тех, кому её дали, останется адрес в никуда. Сами семинары и их опубликованные страницы
        не трогаются: пропадает список и его порядок.
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (doomed = false)}>
          Отмена
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
          disabled={busy}
          onclick={() => void destroy()}
        >
          {busy ? 'Удаляем…' : 'Удалить курс'}
        </button>
      </div>
    </div>
  </div>
{/if}

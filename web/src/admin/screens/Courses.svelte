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
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { copyText } from '@/lib/clipboard'
  import { MAX_COURSE_BLURB, MAX_COURSE_NAME, type Course, type CourseItem } from '@shared/publish'
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

  const explain = (cause: unknown): string =>
    cause instanceof AdminApiError ? cause.message : 'что-то пошло не так'

  async function loadList(): Promise<void> {
    try {
      courses = await adminApi.listCourses()
      navCounts.courses = courses.length
    } catch (cause) {
      error = explain(cause)
    }
  }

  async function loadOne(id: string): Promise<void> {
    try {
      course = await adminApi.course(id)
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
    if (!name) return
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

  const publicUrl = (id: string): string => `${location.host}/c/${id}`
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
            <p class="mt-0.5 font-mono text-2xs text-muted">/c/{item.id}</p>
          </button>
          <p class="shrink-0 text-ui text-muted">
            {published} опубликовано · {waiting} ещё нет
          </p>
        </div>
      {/each}
    </div>
  </AdminPage>
{:else if course}
  {@const shown = course}
  <AdminPage title={shown.name}>
    {#snippet actions()}
      <button
        type="button"
        class="btn-ghost"
        onclick={() => void copy(`${location.origin}/c/${shown.id}`, 'link')}
      >
        {copied === 'link' ? 'Скопировано' : 'Копировать ссылку'}
      </button>
      <a class="btn-ghost" href={`/c/${shown.id}`} target="_blank" rel="noreferrer">
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

      <p class="pb-5 font-mono text-2xs text-muted">{publicUrl(shown.id)}</p>

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
              <span class="text-ui text-muted">публиковать нечего</span>
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
                  href={`/p/${item.publication.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  опубликован · {item.publication.steps}
                  {item.publication.steps === 1 ? 'шаг' : 'шага'}
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
    </div>
  </AdminPage>
{/if}

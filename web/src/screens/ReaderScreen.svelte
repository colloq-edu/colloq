<!--
  Публичное чтение: страница курса и опубликованный семинар.

  Ни токена, ни личности, ни сокетов. Это не «режим только для чтения», который
  серверу пришлось бы соблюдать, а другой предмет: за этими страницами нет ни
  комнаты, ни документа, ни ядра — только то, что было собрано в момент
  публикации. Поэтому здесь нет ни одной кнопки, которая могла бы что-нибудь
  изменить, и нечему давать сбой.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import { api, ApiError } from '@/lib/api'
  import Icon from '@/components/ui/Icon.svelte'
  import PublicNotebook from '@/components/reader/PublicNotebook.svelte'
  import CourseList from '@/components/reader/CourseList.svelte'
  import type { PublicCourseView, PublicSeminar, PublicStep } from '@shared/publish'

  interface Props {
    course: string | null
    publication: { id: string; step: number | null } | null
    onnavigate: (path: string) => void
  }

  let { course, publication, onnavigate }: Props = $props()

  let courseView = $state<PublicCourseView | null>(null)
  let seminar = $state<PublicSeminar | null>(null)
  let step = $state<PublicStep | null>(null)
  let missing = $state(false)
  let loading = $state(true)

  /*
   * Шаг живёт в адресе: `/p/x9tb4kwm/3184`. «Назад» в браузере обязана
   * возвращать на предыдущий шаг, а не выкидывать со страницы, — человек ходит
   * по ним туда-сюда, сравнивая «до» и «после».
   */
  const wanted = $derived(publication?.step ?? null)

  onMount(() => {
    document.documentElement.classList.add('reader')
    return () => document.documentElement.classList.remove('reader')
  })

  $effect(() => {
    const id = course
    if (!id) return
    let cancelled = false
    loading = true
    void api
      .course(id)
      .then((body) => {
        if (!cancelled) courseView = body.course
      })
      .catch((err) => {
        if (!cancelled) missing = err instanceof ApiError && err.status === 404
      })
      .finally(() => {
        if (!cancelled) loading = false
      })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const id = publication?.id
    if (!id) return
    let cancelled = false
    void api
      .publication(id)
      .then((body) => {
        if (!cancelled) seminar = body.seminar
      })
      .catch((err) => {
        if (!cancelled) missing = err instanceof ApiError && err.status === 404
      })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const id = publication?.id
    const seq = wanted
    if (!id) return
    let cancelled = false
    loading = true
    void api
      .step(id, seq)
      .then((body) => {
        if (!cancelled) step = body.step
      })
      .catch(() => {
        /* шага нет — страница покажет то, что уже есть */
      })
      .finally(() => {
        if (!cancelled) loading = false
      })
    return () => {
      cancelled = true
    }
  })

  const current = $derived(step?.seq ?? seminar?.steps[0]?.seq ?? null)
  /* Рельса из одного шага — мебель. В первом семестре это обычный случай. */
  const railed = $derived((seminar?.steps.length ?? 0) > 1)

  function go(seq: number): void {
    if (!publication) return
    onnavigate(`/p/${publication.id}/${seq}`)
  }

  const dateLong = (at: number): string =>
    new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
  const clock = (at: number): string =>
    new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
</script>

{#if missing}
  <div class="flex min-h-screen items-center justify-center bg-canvas px-6">
    <div class="max-w-md text-center">
      <p class="text-title font-semibold text-ink">Такой страницы здесь нет</p>
      <p class="mt-2 text-ui text-muted">
        Ссылка могла устареть или быть набрана с опечаткой.
      </p>
    </div>
  </div>
{:else if courseView}
  <CourseList course={courseView} {onnavigate} />
{:else if seminar && seminar.state === 'withdrawn'}
  <!-- Никогда 404 на ссылку, которую студенту дали: страница отвечает, что её
       сняли, и ведёт наверх, к курсу. -->
  <div class="flex min-h-screen items-center justify-center bg-canvas px-6">
    <div class="max-w-md text-center">
      <p class="text-title font-semibold text-ink">Преподаватель снял эту страницу</p>
      {#if seminar.course}
        <button
          class="mt-3 text-ui font-semibold text-accent-text"
          onclick={() => onnavigate(`/c/${seminar!.course!.id}`)}
        >
          {seminar.course.name}
        </button>
      {/if}
    </div>
  </div>
{:else if seminar}
  <div class="min-h-screen bg-canvas">
    <header class="border-b border-line px-6 pb-6 pt-10 sm:px-16">
      <h1 class="text-marquee-sm font-black leading-tight tracking-tight text-ink sm:text-marquee">
        {seminar.title}
      </h1>
      <p class="mt-2 flex flex-wrap items-baseline gap-x-2 text-ui text-muted">
        {#if seminar.course}
          <button
            class="font-semibold text-accent-text"
            onclick={() => onnavigate(`/c/${seminar!.course!.id}`)}
          >
            {seminar.course.name}
          </button>
        {/if}
        <span>
          · опубликован {dateLong(seminar.publishedAt)} ·
          {seminar.steps.length}
          {seminar.steps.length === 1 ? 'страница' : 'шага'}
        </span>
      </p>
    </header>

    <div class="flex items-start">
      {#if railed}
        <nav
          class="sticky top-0 hidden w-[300px] shrink-0 flex-col self-start border-r border-line
                 py-6 pl-6 pr-5 sm:flex sm:pl-16"
          aria-label="Шаги семинара"
        >
          <p class="pb-3 text-micro font-bold uppercase tracking-caps text-muted">Шаги семинара</p>
          {#each seminar.steps as heading (heading.seq)}
            {@const on = heading.seq === current}
            <button
              class="flex gap-3 border-l-[3px] py-2 pl-3 pr-2 text-left transition-colors duration-100
                     {on ? 'border-accent bg-surface' : 'border-transparent hover:bg-surface/60'}"
              aria-current={on ? 'step' : undefined}
              onclick={() => go(heading.seq)}
            >
              <span class="w-5 shrink-0 font-mono text-2xs {on ? 'text-accent-text' : 'text-faint'}">
                {String(seminar.steps.indexOf(heading) + 1).padStart(2, '0')}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-ui leading-snug {on ? 'font-semibold text-ink' : 'text-muted'}">
                  {heading.label}
                </span>
                <span class="mt-0.5 block font-mono text-2xs text-muted">
                  {clock(heading.at)} · {heading.cellCount}
                </span>
              </span>
            </button>
          {/each}
        </nav>
      {/if}

      <main class="min-w-0 flex-1 px-6 py-7 sm:px-11">
        <div class="max-w-[820px] border-l-[3px] border-accent bg-surface px-4 py-3">
          <p class="text-ui leading-relaxed text-muted">
            Здесь то, что писали и запускали на этом занятии. Того, что говорили, здесь нет.
          </p>
          {#if railed}
            <p class="mt-1.5 text-ui leading-relaxed text-muted">
              Моменты, которые отметил преподаватель. Выводы — те, что тетрадь держала в этот
              момент: у ячейки, код которой поменяли после запуска, остаётся прежний результат.
            </p>
          {/if}
          <p class="mt-1.5 text-ui leading-relaxed text-muted">
            Ничьих имён на этой странице нет.
          </p>
        </div>

        {#if step}
          <div class="mt-8 max-w-[820px]">
            <PublicNotebook cells={step.cells} publication={seminar.id} />
          </div>
        {:else if loading}
          <p class="mt-8 text-ui text-muted">Загружается…</p>
        {/if}

        <p class="mt-10 flex items-center gap-2 border-t border-line pt-5 text-ui text-muted">
          <Icon name="download" size={13} />
          <a class="font-semibold text-accent-text" href={`/api/p/${seminar.id}/notebook.ipynb`}>
            Скачать тетрадь (.ipynb)
          </a>
        </p>
      </main>
    </div>
  </div>
{:else}
  <div class="min-h-screen bg-canvas"></div>
{/if}

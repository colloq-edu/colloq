<!--
  Публичное чтение: страница курса и опубликованный семинар.

  Ни токена, ни личности, ни сокетов. Это не «режим только для чтения», который
  серверу пришлось бы соблюдать, а другой предмет: за этими страницами нет ни
  комнаты, ни документа, ни ядра — только то, что было собрано в момент
  публикации. Поэтому здесь нет ни одной кнопки, которая могла бы что-нибудь
  изменить, и нечему давать сбой.
-->
<script lang="ts">
  import { api, ApiError } from '@/lib/api'
  import Icon from '@/components/ui/Icon.svelte'
  import PublicNotebook from '@/components/reader/PublicNotebook.svelte'
  import CourseList from '@/components/reader/CourseList.svelte'
  import { plural } from '@/lib/plural'
  import {
    refusedStep,
    type PublicCourseView,
    type PublicSeminar,
    type PublicStep,
  } from '@shared/publish'

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
  /** Страницы больше нет вовсе: её сняли или удалили, пока её читали. */
  let gone = $state(false)
  /**
   * Шага нет, а страница есть: устаревшая ссылка на отметку или промах в номере.
   *
   * Отдельно от `gone`, потому что это другая новость и другая дорога: семинар
   * жив, открыт, и у него есть первая страница, на которую можно уйти. Оба
   * случая приходят с кодом 404, и различает их только тело ответа
   * (`refusedStep` в shared/publish.ts). Пока читалка смотрела на голый статус,
   * `/p/<id>/999` печатал «этой страницы семинара больше нет — его
   * опубликовали заново»: известие о непоправимом при живой, ничем не тронутой
   * публикации.
   */
  let noSuchStep = $state(false)
  /**
   * Не «страницы нет», а «не дошли»: 500, обрыв, таймаут.
   *
   * Пока их не отличали от 404, всё это давало `missing === false` и пустой
   * белый экран — ни слова, ни кнопки, ни намёка на то, что помогает
   * перезагрузка; человек в метро читал это как «курс удалили». Фразу для
   * человека api.ts готовит сам, здесь её достаточно показать.
   */
  let failure = $state<string | null>(null)
  /** «Ещё раз»: счётчик в зависимостях эффектов, а не второй способ загрузки. */
  let attempt = $state(0)
  let loading = $state(true)

  /*
   * Шаг живёт в адресе: `/p/x9tb4kwm/3184`. «Назад» в браузере обязана
   * возвращать на предыдущий шаг, а не выкидывать со страницы, — человек ходит
   * по ним туда-сюда, сравнивая «до» и «после».
   */
  const wanted = $derived(publication?.step ?? null)

  /**
   * Идентификатор публикации — строкой, а не через сам проп.
   *
   * `readPublicRoute` в роутере собирает НОВЫЙ объект на каждое изменение
   * адреса, включая `/p/x/3` → `/p/x/4`. Эффекты ниже читали `publication?.id`,
   * то есть зависели от объекта, и каждый шаг стоил лишнего GET /api/p/:id —
   * ровно того, что обещал не делать ключ `{#key}` в App.svelte («не загружать
   * семинар заново на каждый шаг»). Строковый `$derived` не будит зависимых,
   * пока значение то же, — и обещание начинает выполняться.
   */
  const pubId = $derived(publication?.id ?? null)

  /*
   * Чего на экране НЕТ — гасится, а не остаётся с прошлого адреса.
   *
   * Роутер пересобирает этот экран по ключу вида (App.svelte), и после
   * починки этого ключа сюда уже не должен приезжать курс под адресом
   * публикации. Но ветка `{:else if courseView}` в разметке стоит раньше
   * `{:else if seminar}`, и цена ошибки здесь — страница, показывающая не то,
   * что в адресе. Экран отвечает за это сам: пропало из пропсов — погасили.
   */
  $effect(() => {
    if (!course) courseView = null
    if (pubId === null) {
      seminar = null
      step = null
      gone = false
      noSuchStep = false
    }
  })

  /**
   * Отказ: 404 — это «такой страницы нет», всё остальное — «не дошли».
   *
   * Разные ответы, потому что разные действия: первое окончательно, второе
   * лечится кнопкой.
   */
  function refused(err: unknown): void {
    if (err instanceof ApiError && err.status === 404) missing = true
    else failure = err instanceof Error ? err.message : 'Страница не открылась.'
  }

  $effect(() => {
    const id = course
    void attempt
    if (!id) return
    let cancelled = false
    loading = true
    missing = false
    failure = null
    void api
      .course(id)
      .then((body) => {
        if (!cancelled) courseView = body.course
      })
      .catch((err) => {
        if (!cancelled) refused(err)
      })
      .finally(() => {
        if (!cancelled) loading = false
      })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const id = pubId
    void attempt
    if (!id) return
    let cancelled = false
    missing = false
    failure = null
    void api
      .publication(id)
      .then((body) => {
        if (!cancelled) seminar = body.seminar
      })
      .catch((err) => {
        if (!cancelled) refused(err)
      })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const id = pubId
    const seq = wanted
    void attempt
    if (!id) return
    let cancelled = false
    loading = true
    /*
     * Прежний шаг гасится ДО загрузки нового.
     *
     * Оставался — и при переходе на шаг, которого больше нет (семинар
     * переопубликовали без этой отметки), читатель молча видел предыдущую
     * тетрадь под новым адресом. Врущая страница хуже пустой.
     */
    step = null
    gone = false
    noSuchStep = false
    void api
      .step(id, seq)
      .then((body) => {
        if (!cancelled) step = body.step
      })
      .catch((err) => {
        if (cancelled) return
        if (!(err instanceof ApiError)) return refused(err)
        /*
         * Какой из двух 404 — решает тело, а не код.
         *
         * `gone` на любой 404 означал «его опубликовали заново» и промаху мимо
         * номера тоже; страница при этом жива, и вести с неё надо не туда.
         * Неизвестное тело (заглушка прокси, чужой ответ) — это «не знаю», а не
         * «нет»: показываем отказ с кнопкой «Ещё раз», как при обрыве.
         */
        const what = refusedStep(err.status, err.message)
        if (what === 'publication') gone = true
        else if (what === 'step') noSuchStep = true
        else if (err.status === 404) failure = 'Шаг не открылся.'
        else refused(err)
      })
      .finally(() => {
        if (!cancelled) loading = false
      })
    return () => {
      cancelled = true
    }
  })

  /*
   * Отмечен только тот шаг, который действительно открыт. Падало на первый —
   * и рельса жирным показывала шаг 01, хотя на экране было пусто или другое.
   */
  const current = $derived(step?.seq ?? null)
  /** Куда уводить с исчезнувшего шага: первый — он есть у любой публикации. */
  const first = $derived(seminar?.steps[0]?.seq ?? null)
  /**
   * Стоит ли читатель на последнем шаге — от этого зависит подпись у скачивания.
   *
   * Пока шага нет (грузится, промах в номере, публикацию сняли), считаем, что
   * на последнем: ссылка в этот момент идёт без `?step=`, а без него сервер
   * отдаёт именно последний шаг. Подпись и файл говорят одно и то же в любую
   * секунду жизни страницы.
   */
  const onLast = $derived(current === null || current === seminar?.steps.at(-1)?.seq)
  /* Рельса из одного шага — мебель. В первом семестре это обычный случай. */
  const railed = $derived((seminar?.steps.length ?? 0) > 1)

  function go(seq: number): void {
    if (!pubId) return
    onnavigate(`/p/${pubId}/${seq}`)
  }

  /**
   * Имя страницы в заголовке вкладки.
   *
   * Страницу курса кладут в закладки — это прямо написано под списком, и это
   * единственный адрес Colloq, который человек сохраняет. В закладках, в
   * истории и в переключателе вкладок все двенадцать курсов и все их семинары
   * назывались одинаково: «Colloq». Выгруженная статикой страница `<title>`
   * ставит (publish/render.ts), SPA не ставила — один и тот же адрес открывался
   * по-разному.
   */
  const named = $derived(courseView?.name ?? seminar?.title ?? null)
  $effect(() => {
    document.title = named === null ? 'Colloq' : `${named} · Colloq`
    return () => {
      document.title = 'Colloq'
    }
  })

  /**
   * Полоса шагов на телефоне: отмеченный шаг подводится к глазам сам.
   *
   * Полоса прокручивается вбок, а шагов бывает одиннадцать: открыв ссылку на
   * седьмой, человек видел бы первые три и ни одного признака, что он на
   * седьмом. Мгновенно, без плавности: это не жест, а состояние страницы при
   * её открытии.
   */
  let strip = $state<HTMLElement | null>(null)
  $effect(() => {
    const at = current
    const root = strip
    if (!root || at === null) return
    root
      .querySelector<HTMLElement>(`[data-step="${at}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center' })
  })

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
      <p class="text-title font-semibold text-ink">Публикация снята</p>
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
        <!-- «Страница» в единственном числе — не описка: один отмеченный
             момент и есть одна страница (так же говорит и окно публикации).
             Описка была во множественном: «5 шага», «11 шага». -->
        <span>
          · опубликован {dateLong(seminar.publishedAt)} ·
          {seminar.steps.length}
          {plural(seminar.steps.length, 'шаг', 'шага', 'шагов')}
        </span>
      </p>
    </header>

    <!--
      Рельса шагов на телефоне — полосой, а не колонкой.

      Боковая рельса ниже объявлена `hidden … sm:flex`: на телефоне её нет
      вовсе, а других переходов по шагам на странице не было — ни кнопок, ни
      списка. Шапка при этом честно писала «6 шагов», и публикация из шести
      сводилась к первому: остальные достижимы только правкой адреса. Между тем
      публичные страницы — единственные адреса Colloq, которые открывают с
      телефона, и статическая выгрузка той же публикации рельсу на узком экране
      оставляет (render.ts, `@media(max-width:860px)`): SPA была хуже статики.

      Полосой, а не стопкой: одиннадцать шагов колонкой — это экран, который
      надо пролистать, чтобы дойти до тетради, и так на каждом шаге. Липкая:
      уйдя вниз по тетради, к следующему шагу переходят оттуда, где дочитали.
    -->
    {#if railed}
      <nav
        bind:this={strip}
        class="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-line bg-canvas
               px-6 sm:hidden"
        aria-label="Шаги семинара"
      >
        {#each seminar.steps as heading, index (heading.seq)}
          {@const on = heading.seq === current}
          <button
            data-step={heading.seq}
            class="press flex shrink-0 items-baseline gap-2 border-b-2 py-3 pr-3
                   {on ? 'border-accent' : 'border-transparent'}"
            aria-current={on ? 'step' : undefined}
            onclick={() => go(heading.seq)}
          >
            <span class="font-mono text-2xs {on ? 'text-accent-text' : 'text-faint'}">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span class="whitespace-nowrap text-ui {on ? 'font-semibold text-ink' : 'text-muted'}">
              {heading.label}
            </span>
          </button>
        {/each}
      </nav>
    {/if}

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
              class="press flex gap-3 border-l-[3px] py-2 pl-3 pr-2 text-left transition-colors duration-100
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
            Опубликованная тетрадь занятия: код, текст и сохранённые результаты запусков.
          </p>
          {#if railed}
            <p class="mt-1.5 text-ui leading-relaxed text-muted">
              Шаги соответствуют моментам, отмеченным преподавателем. Если код изменили
              после запуска, сохранённый результат может ему не соответствовать.
            </p>
          {/if}
          <p class="mt-1.5 text-ui leading-relaxed text-muted">
            Список участников не публикуется. Имена в тексте ячеек и результатах сохраняются.
          </p>
        </div>

        {#if step}
          <div class="mt-8 max-w-[820px]">
            <PublicNotebook cells={step.cells} publication={seminar.id} />
          </div>
        {:else if loading}
          <p class="mt-8 text-ui text-muted">Загружается…</p>
        {:else if noSuchStep}
          <!--
            Семинар жив, а этой отметки в нём нет. Причин две, и сервер их не
            различает: семинар опубликовали заново (адрес тот же, отметки
            сменились) или в номере промах. Значит, и говорить надо о том, что
            известно: страницы нет, ссылка старая или с опечаткой. Прежний текст
            выбирал за читателя вторую половину правды — «его опубликовали
            заново» — и говорил её даже тому, кто просто ошибся цифрой.

            Дорога отсюда обязана быть на странице: у публикации из одного шага
            рельсы нет вовсе, и выбраться было нечем.
          -->
          <p class="mt-8 text-ui text-muted">
            {#if wanted === null}
              В этом семинаре пока нет ни одной страницы.
            {:else}
              Такой страницы у этого семинара нет. Ссылка могла устареть или быть набрана с
              опечаткой.
            {/if}
            {#if first !== null}
              <button class="press font-semibold text-accent-text" onclick={() => go(first)}>
                Открыть первую
              </button>
            {/if}
          </p>
        {:else if gone}
          <!--
            Публикации не стало, пока её читали: сняли с публикации или удалили
            (`publication not found`). Слова — те же, что на снятой странице
            выше, потому что событие для читателя то же самое; отсюда ведёт не
            первый шаг — его тоже нет, — а курс.
          -->
          <p class="mt-8 text-ui text-muted">
            Публикация снята.
            {#if seminar.course}
              <button
                class="press font-semibold text-accent-text"
                onclick={() => onnavigate(`/c/${seminar!.course!.id}`)}
              >
                {seminar.course.name}
              </button>
            {/if}
          </p>
        {:else if failure}
          <p class="mt-8 text-ui text-muted">
            {failure}
            <button class="font-semibold text-accent-text" onclick={() => (attempt += 1)}>
              Повторить
            </button>
          </p>
        {/if}

        <!--
          Ссылка отдаёт тот шаг, на котором стоят, и говорит, что именно в файле.

          Ссылка была одна на все шаги, а сервер собирал по ней тетрадь
          ПОСЛЕДНЕГО шага: читатель, сравнивающий «до» и «после» на шаге 2 из
          5 — ровно тот, ради кого шаг живёт в адресе, — уносил состояние шага 5
          и узнавал об этом, только открыв файл. Теперь шаг едет в `?step=`
          (routes/courses.ts → notebookOfStep): незнакомый номер там отвечает
          последним шагом, а не 404, так что ссылка не может сломаться.

          Выводы сервер вычищает всегда: файл задуман как «код, чтобы запустить
          у себя», и без выводов он открывается везде и весит килобайты. Это
          обещание тоже написано рядом, а не выясняется после скачивания.
        -->
        <div class="mt-10 border-t border-line pt-5">
          <p class="flex items-center gap-2 text-ui text-muted">
            <Icon name="download" size={13} />
            <a
              class="font-semibold text-accent-text"
              href={`/api/p/${seminar.id}/notebook.ipynb${current === null ? '' : `?step=${current}`}`}
            >
              Скачать тетрадь (.ipynb)
            </a>
          </p>
          <p class="mt-1.5 text-ui text-muted">
            {!railed
              ? 'Код без выводов'
              : onLast
                ? 'Код последнего шага, без выводов'
                : 'Код этого шага, без выводов'} — чтобы запустить у себя.
          </p>
        </div>
      </main>
    </div>
  </div>
{:else}
  <!--
    Пусто здесь бывает по двум причинам, и они разные: страница ещё едет — или
    не доехала. Пустой белый экран стоял на обе, и на второй читался как «этого
    курса больше нет»: ни слова, ни кнопки, а единственный выход — перезагрузка,
    о которой на странице не сказано ничего.
  -->
  <div class="flex min-h-screen items-center justify-center bg-canvas px-6">
    {#if failure}
      <div class="max-w-md text-center">
        <p class="text-title font-semibold text-ink">Страница не открылась</p>
        <p class="mt-2 text-ui text-muted">{failure}</p>
        <button
          class="mt-3 text-ui font-semibold text-accent-text"
          onclick={() => (attempt += 1)}
        >
          Повторить
        </button>
      </div>
    {:else}
      <p class="text-ui text-muted">Загружается…</p>
    {/if}
  </div>
{/if}

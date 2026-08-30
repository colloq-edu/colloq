<!--
  Лекция: три экрана из одного компонента.

  ПРОЕКЦИЯ — то, что видит зал: страница на весь экран, чёрный фон, ничего
  больше. Живёт на компьютере у проектора, и всё, что на ней происходит, приходит
  по сети от планшета в руках преподавателя. Никакой трансляции экрана: по
  проводу едут номер страницы и точки, а не картинка.

  ПУЛЬТ — то, что видит ведущий: та же страница, следующая рядом, часы и
  инструменты. Отсюда листают, отсюда рисуют.

  ЗАЛ — то, что видит студент у себя: та же страница и те же чернила, но без
  пульта. Он может уйти в тетрадь и вернуться — лекция его не держит.

  Один компонент, а не три, по той же причине, по которой чернила рисует один
  код: разойдясь, они покажут ведущему одно, а залу другое, и заметить это можно
  будет только в аудитории.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { fullscreenNow, fullscreenPossible, goFullscreen } from '@/lib/fullscreen'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import type { LectureState } from '@shared/lecture'
  import { baseOf } from '@shared/paths'
  import ConsoleLink from './ConsoleLink.svelte'
  import InkLayer from './InkLayer.svelte'
  import LecturePage from './LecturePage.svelte'
  import NotesPad from './NotesPad.svelte'

  interface Props {
    /*
     * Не `state`: рядом живут руны, а `$state` в теле компонента, где есть
     * переменная с таким именем, читается как подписка на хранилище `$state`.
     * Компилятор скажет об этом невнятно, а имя всё равно было хуже.
     */
    lecture: LectureState
    /** Кем этот экран смотрит на лекцию. */
    role: 'presenter' | 'audience' | 'projection'
    /** Выйти из проекции обратно в комнату. */
    onleave?: () => void
    /** Отправить ЭТОТ экран на проектор. */
    onproject?: () => void
    /** Выйти из общей страницы в свою читалку. Ведущему не предлагается. */
    onsolo?: () => void
  }

  let { lecture, role, onleave, onproject, onsolo }: Props = $props()

  const session = getSessionState()

  let doc = $state<PDFDocumentProxy | null>(null)
  let failure = $state<string | null>(null)
  let pages = $state(0)

  /**
   * Путь документа — ОТДЕЛЬНЫМ значением, а не чтением из `lecture` внутри
   * эффекта.
   *
   * `lecture` приезжает с сервера целым объектом и подменяется на каждое
   * изменение состояния — на каждое перелистывание в том числе. Эффект,
   * читавший `lecture.file` у себя внутри, подписывался тем самым на весь
   * объект: страница сменилась — эффект перезапущен, прежний документ
   * уничтожен (`loadingTask.destroy()`), новый качается с нуля. То есть каждое
   * нажатие «вперёд» заново скачивало и разбирало ВСЮ колоду, и до самой
   * страницы дело доходило через полсекунды на пустом стенде — а на живой
   * лекции с тридцатью мегабайтами через ретранслятор это и есть те самые
   * «пять секунд или не догоняет вообще».
   *
   * `$derived` от строки пути пропускает дальше только настоящую смену
   * документа: значение сравнивается, а не ссылка.
   */
  const file = $derived(lecture.file)

  $effect(() => {
    const path = file
    let dropped = false
    doc = null
    void loadPdf()
      .then((pdf) => pdf.open(api.fileRaw(session.session.id, path), session.token))
      .then((opened) => {
        if (dropped) return
        doc = opened
        pages = opened.numPages
      })
      .catch(() => {
        if (!dropped) failure = 'Не удалось открыть документ лекции.'
      })
    return () => {
      dropped = true
      void doc?.loadingTask.destroy()
    }
  })

  /* ------------------------------------------------------------ пульт */

  /** Цвета пера: четыре, и все читаются на белом слайде и на проекторе. */
  const INKS = [
    { color: '#d4162f', name: 'красный' },
    { color: '#0f2d69', name: 'синий' },
    { color: '#0c7a64', name: 'зелёный' },
    { color: '#101a33', name: 'чёрный' },
  ]

  let tool = $state<'pen' | 'laser' | 'off'>('off')
  let ink = $state(INKS[0].color)

  const presenting = $derived(role === 'presenter')
  const page = $derived(lecture.page)

  /**
   * Куда мы уже попросили уйти.
   *
   * Считать следующую страницу от `lecture.page` — то есть от того, что УЖЕ
   * подтвердил сервер, — можно ровно при одном условии: между двумя нажатиями
   * успевает обернуться сокет. На стенде семь нажатий стрелкой давали одну
   * страницу вместо семи: все семь долетали до окна, все семь считали «текущая
   * плюс один» от одной и той же текущей, и сервер, которому шестью подряд
   * назвали одно и то же число, честно отвечал «я уже там». На паре это
   * выглядит как залипшая стрелка: жмёшь десять раз, проектор двигается на
   * одну.
   *
   * Поэтому шаг считается от СВОЕГО намерения, а не от чужого подтверждения.
   * Намерение живёт до тех пор, пока сервер его не догонит или пока страницу
   * не сменит кто-то другой, — за этим следит эффект ниже.
   */
  let wanted = $state<number | null>(null)
  /**
   * Страницы, которые мы успели попросить, пока намерение не сбылось.
   *
   * Без этого списка «сервер встал не на ту страницу, что мы хотим» читается
   * как «листает кто-то другой» — а это чаще всего наш же собственный шаг по
   * дороге: два нажатия подряд просят шестую и седьмую, эхо шестой приходит
   * первым, и намерение на седьмую пришлось бы выбросить, не дождавшись. Не
   * руна: её никто не рисует, она только сверяется.
   */
  let asked = new Set<number>()

  /*
   * Намерение снимается, когда сервер его подтвердил — и когда страницу увёл
   * кто-то другой. Второе важнее первого: если ведущий листает с планшета, а
   * это окно помнит своё старое «хочу на шестую», то следующая стрелка уедет
   * от шестой, а не от той, что видит зал, — и два экрана разойдутся молча.
   * Чужой ход всегда главнее нашего намерения.
   */
  $effect(() => {
    const at = lecture.page
    untrack(() => {
      if (wanted === null) return
      if (at === wanted) {
        // Догнал: намерение сбылось.
        wanted = null
        asked.clear()
      } else if (!asked.has(at)) {
        /*
         * Страница, которой мы не просили, — значит листает кто-то другой:
         * второй преподаватель или планшет того же человека. Чужой ход всегда
         * главнее нашего намерения; иначе следующая стрелка уедет от нашей
         * забытой седьмой, а не от той, что видит зал, и два экрана разойдутся
         * молча — то есть случится ровно то, чего в лекции быть не должно.
         */
        wanted = null
        asked.clear()
      }
    })
  })

  function turn(step: -1 | 1): void {
    const from = wanted ?? page
    const next = from + step
    if (next < 1 || (pages > 0 && next > pages)) return
    wanted = next
    asked.add(next)
    session.send({ t: 'lecture:page', page: next })
  }

  /*
   * Клавиатура пульта: стрелки и пробел листают, B гасит экран, E стирает.
   * Ровно то, что нажимают, не глядя, — и то, что шлёт презентационная
   * кликалка, если её воткнуть в компьютер у проектора.
   */
  /**
   * Свои ли это слайды. Проекция стоит на компьютере у проектора, и обычно это
   * тот же преподаватель, что ведёт с планшета (планшет входит по ключу тем же
   * участником), — тогда клавиатура и кликер, воткнутые в этот компьютер,
   * листают лекцию. Чужую лекцию проекция не листает: сервер такое отбросит, а
   * молчаливое нажатие лучше, чем перелистывание чужого слайда.
   */
  const mine = $derived(lecture.by === session.me.id)

  /* Полный экран проекции — по первому жесту в её окне, см. SessionScreen. */
  let full = $state(fullscreenNow())
  $effect(() => {
    const sync = () => (full = fullscreenNow())
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  })

  function fillScreen(): void {
    if (fullscreenPossible() && !fullscreenNow()) void goFullscreen(document.documentElement)
  }

  function onkeydown(event: KeyboardEvent): void {
    if (role === 'projection' && event.code === 'KeyF') {
      event.preventDefault()
      fillScreen()
      return
    }
    if (!presenting && !(role === 'projection' && mine)) return
    // Цель бывает и не элементом (документ, окно): у них нет `closest`.
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('input, textarea, [contenteditable]')) return
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault()
      turn(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault()
      turn(-1)
    } else if (event.code === 'KeyB') {
      event.preventDefault()
      session.send({ t: 'lecture:blank', on: !lecture.blank })
    }
  }

  /*
   * Трекингов здесь ровно два, и разница между ними носит смысл: 0.14em
   * (`tracking-label`) называет ДЕЙСТВИЕ — то, что нажимают, — а 0.2em
   * (`tracking-section`) называет МЕСТО: «дальше», «пауза». Стояли на одном и
   * том же 11-пиксельном капсе четыре разных трекинга (0.08 на кнопках, 0.16 на
   * состоянии проекции, 0.2 на именах областей); различить их читатель не может,
   * а удержать согласованными не может никто, и через месяц они разъезжаются.
   */
  const TOOL =
    'flex h-8 items-center gap-1.5 px-2.5 text-2xs font-bold uppercase tracking-label ' +
    'transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'
</script>

<svelte:window {onkeydown} />

{#if role === 'projection'}
  <!--
    Проекция. Чёрный фон, ничего кроме страницы — и ни одной кнопки: всё, что
    может понадобиться в аудитории, уже есть в руках у ведущего. Выход спрятан
    под Escape и под щелчок в углу: случайное нажатие мышью по проекции не
    должно прерывать лекцию.
  -->
  <!--
    Щелчок по проекции — полный экран. Проекция теперь открывается отдельным
    окном, а полный экран в чужом окне не попросить: браузер даёт его только
    по жесту в самом окне. Первое, что делают с новым окном, — щёлкают в него,
    и этого достаточно. Кнопки нет намеренно: любая кнопка на проекции —
    кнопка, которую видит зал.
  -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="fixed inset-0 z-[100] flex flex-col bg-black" onclick={fillScreen}>
    {#if lecture.blank}
      <div class="flex flex-1 items-center justify-center">
        <span class="text-2xs uppercase tracking-section text-white/30">пауза</span>
      </div>
    {:else if failure}
      <div class="flex flex-1 items-center justify-center px-8 text-center text-ui text-white/70">
        {failure}
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 p-4">
        <LecturePage {doc} {page}>
          {#snippet over(size)}
            <InkLayer
              {page}
              live={false}
              tool="off"
              color={lecture.color}
              width={0.004}
              w={size.w}
              h={size.h}
            />
          {/snippet}
        </LecturePage>
      </div>
    {/if}
    <button
      type="button"
      class="absolute right-0 top-0 h-12 w-12 text-white/0 transition-colors duration-100 hover:text-white/40 focus-visible:outline-none"
      title="Выйти из проекции — Escape"
      aria-label="Выйти из проекции"
      onclick={(event) => {
        event.stopPropagation()
        onleave?.()
      }}
    >
      <Icon name="x" size={16} />
    </button>
    {#if !full && fullscreenPossible()}
      <!--
        Подсказка живёт только ПОКА окно не во весь экран — то есть пока
        проекцию ещё настраивают, а не показывают залу. Стрелки названы
        только тому, чьи это слайды: чужие она не листает.
      -->
      <p class="pointer-events-none absolute bottom-4 right-5 text-2xs uppercase tracking-label text-white/35">
        {mine ? '← → листать · ' : ''}щелчок или F — во весь экран
      </p>
    {/if}
  </div>
{:else}
  <section class="flex min-h-0 flex-1 flex-col bg-surface">
    {#if presenting}
      <!--
        Пульт. Полоса под вкладками — там же, где у тетради Run All: у каждой
        вкладки своя, и она всегда под ней.
      -->
      <div class="flex h-[34px] shrink-0 items-stretch border-b border-line bg-canvas">
        <button
          type="button"
          class="{TOOL} w-10 justify-center text-muted hover:text-ink disabled:opacity-30"
          disabled={page <= 1}
          aria-label="Предыдущая страница"
          onclick={() => turn(-1)}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <span class="flex items-center px-1 font-mono text-2xs tabular-nums text-ink">
          {#if page < 0}лист{:else}{page} / {pages || '—'}{/if}
        </span>
        <button
          type="button"
          class="{TOOL} w-10 justify-center text-muted hover:text-ink disabled:opacity-30"
          disabled={pages > 0 && page >= pages}
          aria-label="Следующая страница"
          onclick={() => turn(1)}
        >
          <Icon name="chevron-right" size={14} />
        </button>

        <span class="my-2 w-px bg-line" aria-hidden="true"></span>

        <!-- Перо. Цвет выбирается тем же нажатием, что и само перо: два
             отдельных переключателя ради четырёх цветов — это два вопроса там,
             где человек задаёт один. -->
        {#each INKS as choice (choice.color)}
          <button
            type="button"
            class="flex w-8 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            title={`Перо, ${choice.name}`}
            aria-label={`Перо, ${choice.name}`}
            aria-pressed={tool === 'pen' && ink === choice.color}
            onclick={() => {
              tool = 'pen'
              ink = choice.color
            }}
          >
            <span
              class="h-4 w-4 rounded-full border-2 transition-transform duration-100 {tool ===
                'pen' && ink === choice.color
                ? 'scale-110 border-ink'
                : 'border-transparent'}"
              style={`background:${choice.color}`}
            ></span>
          </button>
        {/each}

        <button
          type="button"
          class="{TOOL} {tool === 'laser' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}"
          aria-pressed={tool === 'laser'}
          title="Указка — ведите пальцем или пером"
          onclick={() => (tool = tool === 'laser' ? 'off' : 'laser')}
        >
          <Icon name="bolt" size={12} />
          Указка
        </button>
        <button
          type="button"
          class="{TOOL} {tool === 'off' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}"
          aria-pressed={tool === 'off'}
          title="Убрать перо: страница снова листается пальцем"
          onclick={() => (tool = 'off')}
        >
          Рука
        </button>

        <span class="my-2 w-px bg-line" aria-hidden="true"></span>

        <button
          type="button"
          class="{TOOL} text-muted hover:text-ink"
          title="Стереть чернила с этой страницы"
          onclick={() => session.send({ t: 'ink:clear', page })}
        >
          <Icon name="eraser" size={12} />
          Стереть
        </button>
        <button
          type="button"
          class="{TOOL} {lecture.blank ? 'bg-ink text-canvas' : 'text-muted hover:text-ink'}"
          aria-pressed={lecture.blank}
          title="Погасить проекцию — B. У вас страница останется"
          onclick={() => session.send({ t: 'lecture:blank', on: !lecture.blank })}
        >
          Пауза
        </button>

        <span class="flex-1"></span>

        <ConsoleLink class="{TOOL} text-muted hover:text-ink" />
        {@render projectButton()}
        <button
          type="button"
          class="{TOOL} text-danger hover:bg-danger/10"
          title="Закончить лекцию: проекция погаснет, чернила сотрутся"
          onclick={() => session.send({ t: 'lecture:stop' })}
        >
          Закончить
        </button>
      </div>
    {:else}
      <!-- Залу — одна строка: кто ведёт и что идёт. Управления нет вовсе. -->
      <div
        class="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-canvas px-4 text-2xs text-muted"
      >
        <span class="h-1.5 w-1.5 rounded-full" style={`background:${lecture.color}`}></span>
        Лекцию ведёт {lecture.byName}
        <span class="text-faint">·</span>
        <span class="font-mono">{baseOf(lecture.file)}</span>
        <span class="flex-1"></span>
        <span class="font-mono tabular-nums">
          {#if page < 0}чистый лист{:else}{page} / {pages || '—'}{/if}
        </span>
        {#if onsolo}
          <!--
            Отойти от общей страницы — и вернуться. За преподавателем в этом
            продукте ИДУТ, а не привязаны к нему: студент, которому нужно
            перечитать предыдущий слайд, не должен для этого ждать конца лекции.
          -->
          <button
            type="button"
            class="{TOOL} -my-2 text-muted hover:text-ink"
            title="Листать документ самому. Вернуться к лекции можно одним нажатием"
            onclick={() => onsolo?.()}
          >
            Читать самому
          </button>
        {/if}
        {@render projectButton()}
      </div>
    {/if}

    {#if failure}
      <!--
        Документ не открылся — У НАС: истёк токен, лопнула сеть, битый кэш. У
        проектора он при этом, скорее всего, открыт, и лекцию можно довести по
        кнопкам и по заметкам. Отнимать у ведущего то, что ещё работает,
        из-за собственной неудачи — худшее, что этот экран может сделать.
      -->
      <div class="flex min-h-0 flex-1 gap-3 p-3">
        <p class="min-w-0 flex-1 text-ui text-muted">{failure}</p>
        {#if presenting}
          <aside class="hidden w-[28%] shrink-0 flex-col lg:flex">
            <NotesPad file={lecture.file} {page} compact />
          </aside>
        {/if}
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 gap-3 p-3">
        <LecturePage {doc} {page}>
          {#snippet over(size)}
            <InkLayer
              {page}
              live={presenting}
              tool={presenting ? tool : 'off'}
              color={ink}
              width={0.004}
              w={size.w}
              h={size.h}
            />
          {/snippet}
        </LecturePage>

        {#if presenting}
          <!--
            Колонка ведущего — и есть Speaker View: что будет дальше и что про
            это сказать. Знать это, не заглядывая вперёд на проекторе.

            «Дальше» показывается, только когда следующая страница есть, а
            заметки — всегда: на последнем слайде говорить ещё нужно, и лента,
            исчезнувшая именно там, читалась бы как поломка. Заметкам отдана
            нижняя, большая половина колонки: их читают, подняв голову от
            экрана, а на эскиз смотрят краем глаза.

            Ни залу, ни проекции заметки не достаются ни в каком виде — ни
            пустыми, ни свёрнутыми: то, что «просто пустое», однажды окажется
            непустым, и увидит это вся аудитория.
          -->
          <aside class="hidden w-[28%] shrink-0 flex-col gap-2 lg:flex">
            {#if pages > page}
              <span class="text-micro font-bold uppercase tracking-section text-muted">
                дальше
              </span>
              <div class="flex min-h-0 basis-[42%]">
                <LecturePage {doc} page={page + 1} dim />
              </div>
            {/if}
            <NotesPad file={lecture.file} {page} compact />
          </aside>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<!--
  «На проектор» — одна кнопка на два места: она есть и у ведущего, и у зала, и
  это не щедрость. Проекцию открывают на ЧУЖОЙ машине — той, что воткнута в
  проектор, — и человек за ней чаще всего не ведущий: лаборант, студент,
  кто угодно, кто вошёл в комнату по той же ссылке. Требовать для этого пульт
  значило бы требовать, чтобы преподаватель шёл к кафедральному ноутбуку.
-->
{#snippet projectButton()}
  {#if onproject}
    <button
      type="button"
      class="{TOOL} text-muted hover:text-ink"
      title="Развернуть этот экран во весь монитор — для вывода на проектор"
      onclick={() => onproject?.()}
    >
      <Icon name="board" size={12} />
      На проектор
    </button>
  {/if}
{/snippet}

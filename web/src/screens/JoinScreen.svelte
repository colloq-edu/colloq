<script lang="ts">
  /**
   * The thirty seconds before a student is in the room.
   *
   * Everything on it is one question — what should the room call you — and one
   * answer it makes for you: a mark nobody in this room was wearing when you
   * knocked. There is no account to make and nothing to confirm; the link is
   * the seminar, which is why the poster beside the form names the seminar the
   * link opened.
   *
   * «Когда постучали» — не «никогда»: сорок меток на класс из тридцати, и две
   * вкладки, постучавшие в одну секунду, друг друга не видят. Ростер читается
   * перед входом и при открытии подборщика, а последнее слово — за сервером:
   * выданную нами метку он подменит свободной, если её успели занять, а
   * выбранную руками оставит как есть (`picked` в теле /join). Обещать на
   * экране больше этого нельзя.
   *
   * Who is "in the room" here is presence, not the participants table: that
   * table remembers every name that ever joined, and a poster announcing "148
   * people are already inside" a room holding one is worse than saying nothing.
   */
  import { onDestroy, onMount } from 'svelte'
  import BannedScreen from '@/components/BannedScreen.svelte'
  import MarkPicker from '@/components/join/MarkPicker.svelte'
  import AvatarStack from '@/components/ui/AvatarStack.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import Poster from '@/components/ui/Poster.svelte'
  import { api, ApiError } from '@/lib/api'
  import { CROWD_NOTICE, retryJoinIn } from '@/lib/crowd'
  import { plural } from '@/lib/plural'
  import { publicationAddress } from '@shared/publish'
  import { MARKS, freeMark, markName } from '@/lib/marks'
  import { markToClaim, takenMarks } from '@/components/join/pick'
  import { staffName } from '@/screens/staff'
  import {
    loadIdentity,
    loadProfile,
    mightBeStaff,
    saveIdentity,
    type StoredIdentity,
  } from '@/lib/identity'
  import type { Participant, SessionInfo } from '@shared/protocol'

  interface Props {
    session: SessionInfo
    /**
     * Почему человек снова видит эту форму, если он тут уже был.
     *
     * Пусто в обычном случае: студент, открывший ссылку впервые, ничего не
     * терял и объяснять ему нечего. Строка появляется, когда сохранённое место
     * в комнате перестало работать (см. App): без неё форма имени посреди
     * занятия читается как «всё сломалось».
     */
    notice?: string | null
    onjoined: (identity: StoredIdentity) => void
  }

  let { session, notice = null, onjoined }: Props = $props()

  const profile = loadProfile()
  // Derived, not read once: App hands this screen a fresh session object when
  // the room's name arrives, and the identity belongs to the room, not to the
  // first render of it.
  const mine = $derived(loadIdentity(session.id))

  let name = $state(profile.name)
  // Provisional: the room has not answered yet and the card has to paint now.
  // The roster corrects it below if this one turns out to be spoken for.
  let mark = $state(freeMark(new Map(), profile.avatar))
  let picked = $state(false)
  let picking = $state(false)
  let roster = $state<Participant[]>([])
  /*
   * Who is in the room this second. The participants table remembers every name
   * that ever joined, so the poster once announced "148 people are already
   * inside" a room holding one, and the picker greyed out marks whose owners
   * left weeks ago. Presence is a different question and the server answers it
   * separately.
   */
  let onlineIds = $state<ReadonlySet<string>>(new Set())
  const present = $derived(roster.filter((person) => onlineIds.has(person.id)))
  let busy = $state(false)
  /**
   * Вкладка ждёт и войдёт ещё раз сама.
   *
   * Отдельно от `error`, потому что это не отказ: отказ — это то, с чем человек
   * остаётся, а здесь ему остаётся только подождать несколько секунд.
   */
  let retrying = $state(false)
  let error = $state<string | null>(null)
  /**
   * Нас не пустили: момент конца бана.
   *
   * Отдельно от `error` по той же причине, по какой отдельно `retrying`: это не
   * поломка, которую человек может обойти, попробовав ещё раз. Форма после
   * этого не нужна вовсе — назваться иначе и войти было бы ровно тем, чего бан
   * не позволяет, — поэтому экран заменяется целиком.
   */
  let bannedUntil = $state<number | null>(null)
  let nameInput = $state<HTMLInputElement | null>(null)

  /*
   * mark → colour of whoever is wearing it, minus the id the join below is about
   * to re-use. Whatever participantId we send cannot be the participant standing
   * in our way; App only routes a browser with no identity here, so this is the
   * guard on that pair agreeing rather than a path a student walks every day.
   */
  const taken = $derived(takenMarks(roster, onlineIds, mine?.participantId ?? null))
  const host = $derived(roster.find((person) => person.role === 'host') ?? null)

  /*
   * The only timestamp a seminar has is when its room was opened — there is no
   * scheduled start in the product yet. It is written the way the artboard
   * draws it, in mono, and deliberately not localised: "25.08 · 18:10" is a
   * blackboard note, not a date field.
   */
  function stampOf(ms: number): string {
    const at = new Date(ms)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${pad(at.getDate())}.${pad(at.getMonth() + 1)} · ${pad(at.getHours())}:${pad(at.getMinutes())}`
  }
  const stamp = $derived(stampOf(session.createdAt))
  /** Когда занятие закончили — теми же цифрами, что и час его начала. */
  const finishedStamp = $derived(session.finishedAt === null ? null : stampOf(session.finishedAt))

  /*
   * The button names the person only while the picker is open. That is the
   * artboard's own logic and it is the right one: with forty marks on screen
   * the button has to say which of them is about to become you.
   */
  const label = $derived(picking && name.trim() ? `Join as ${name.trim()}` : 'Join the seminar')

  onMount(() => {
    nameInput?.focus()
    // A returning student can overwrite the remembered name with one keystroke.
    if (name) nameInput?.select()

    /*
     * Who is already here — for the stack on the poster, and for the mark. The
     * form is complete before this lands and stays usable if it never does: a
     * room you cannot count is still a room you can walk into.
     */
    void readRoom().catch(() => {
      /* offline or slow; the poster simply says nothing about the room */
    })
  })

  /*
   * A teacher who has already signed in to the panel should not be asked who
   * they are a second time. The marker in localStorage only says "worth
   * asking"; the staff cookie is HttpOnly, so the server is what actually
   * answers, and it also decides the role — this screen never claims one.
   *
   * Students have no marker and make no request, so the join path they walk is
   * exactly as short as it was.
   */
  let signingIn = $state(mightBeStaff())

  onMount(() => {
    if (!signingIn) return
    void (async () => {
      // Один помощник на оба экрана — см. screens/staff.ts. Он же решает
      // судьбу местной метки: снимает её отказ сервера, а не оборванный вайфай.
      const staff = await staffName()
      if (!staff) {
        // Печенье протухло, этот браузер никогда не был штатом — или сервера
        // не слышно. В любом случае человеку нужна обычная форма, а не тупик.
        signingIn = false
        return
      }
      name = staff
      await join()
    })()
  })

  function pick(next: string): void {
    mark = next
    picked = true
  }

  /**
   * Экран ушёл, а ожидание осталось.
   *
   * Между отказом и повтором проходят секунды, и за них человек успевает
   * закрыть вкладку или уйти по ссылке в другую комнату. Впустить его туда,
   * откуда он ушёл, — худший вид опоздавшего ответа: он не виден, он меняет
   * маршрут.
   */
  let alive = true
  onDestroy(() => (alive = false))

  /**
   * Кто в комнате прямо сейчас — и метка по этому ответу.
   *
   * Одно чтение на три места: при монтировании (карточка и постер), при
   * открытии подборщика (занятые метки должны быть сегодняшними, иначе плитка
   * зовёт нажать на зверя, которого уже носят) и перед стуком. Правило выбора
   * при этом одно — `markToClaim`: выданную нами метку пересчитываем по свежей
   * занятости, выбранную руками не трогаем.
   */
  async function readRoom(): Promise<void> {
    const body = await api.listParticipants(session.id)
    if (!alive) return
    roster = body.participants
    onlineIds = new Set(body.online)
    mark = markToClaim(mark, picked, taken, profile.avatar)
  }

  /**
   * Подборщик открывают — комнату перечитывают.
   *
   * Ростер, прочитанный при монтировании, к этой минуте уже старый: студент
   * читал постер, печатал имя, а класс всё это время входил. Подборщик рисует
   * занятые метки занятыми и нажать на них не даёт — но только по тому
   * списку, который у него есть, и без этого чтения список был минутной
   * давности: человек жал на свободного с виду ежа и входил вторым ежом.
   *
   * Открывается он сразу, не дожидаясь ответа: сетка нужна сейчас, а серые
   * плитки доедут через круг сети. Неудача чтения ничего не меняет — выбирают
   * из того, что известно.
   */
  function openPicker(): void {
    picking = true
    void readRoom().catch(() => {
      /* offline or slow; the grid greys out only whom we already know about */
    })
  }

  /**
   * Ростер — ещё раз, прямо перед входом, и метка по нему.
   *
   * Читать его один раз при монтировании было ровно бесполезно в единственном
   * случае, ради которого он и читается: класс открывает ссылку в одну минуту,
   * у всех тридцати комната пуста, и каждый выбирает из полного списка
   * независимо. Сорок меток на тридцать человек дают около одиннадцати пар с
   * одним и тем же зверем — то есть с одним и тем же курсором в тетради, а
   * цвет их тоже не различает (он минтуется из id).
   *
   * Своя метка, выбранная руками, не трогается никогда (см. `markToClaim`) —
   * ни здесь, ни на сервере, который узнаёт об этом по `picked`, — и поэтому
   * запрос для неё не нужен вовсе. Неудача запроса ничего не меняет: входим с
   * тем, что есть, — закрытая дверь хуже двух ежей.
   */
  async function freshenMark(): Promise<void> {
    if (picked) return
    try {
      await readRoom()
    } catch {
      /* offline or slow; the mark we already have is the one we knock with */
    }
  }

  /** Одна попытка войти: если она удалась, человек уже в комнате. */
  async function knock(who: string): Promise<void> {
    const result = await api.join(session.id, {
      name: who,
      avatar: mark,
      /*
       * Выбрана руками — сервер её не подменит.
       *
       * Судья уникальности он: занятую метку он меняет на свободную, и без
       * этого поля отличить выданную экраном от ткнутой пальцем ему нечем —
       * подменялись обе. Человек жал на ежа и оказывался выдрой, а объяснения
       * этому нет ни на одном экране: карточка к тому моменту уже уехала.
       * Плитки занятых зверей нажать нельзя, так что совпасть выбранная может
       * только в круге сети, и два ежа там дешевле молчаливой подмены.
       */
      picked,
      // What keeps a refresh from turning one person into two — and the
      // token beside it is what proves the claim is ours to make.
      participantId: mine?.participantId ?? null,
      token: mine?.token ?? null,
    })
    const identity: StoredIdentity = {
      sessionId: session.id,
      participantId: result.participant.id,
      token: result.token,
      name: result.participant.name,
      avatar: result.participant.avatar,
      color: result.participant.color,
      role: result.participant.role,
    }
    saveIdentity(identity)
    onjoined(identity)
  }

  async function join(event?: SubmitEvent): Promise<void> {
    event?.preventDefault()
    const who = name.trim()
    if (!who) {
      error = 'Enter a name so the room knows who you are'
      nameInput?.focus()
      return
    }
    if (busy) return

    busy = true
    error = null
    // Один раз на весь вход, а не на каждую попытку: в толпе, где повторов
    // четыре, это были бы четыре лишних запроса с каждой из пятисот вкладок.
    await freshenMark()
    if (!alive) return
    /*
     * Толпа на входе — не отказ, а очередь: вкладка стучится ещё раз сама.
     *
     * Сколько раз и через сколько, решает lib/crowd.ts, и решение там ровно
     * одно на весь продукт. Здесь — то, что человек в это время видит: кнопка
     * так и говорит «Joining…», а строка под именем объясняет, чего ждут.
     * Прежний отказ с кнопкой никуда не делся, он просто наступает позже — и
     * только когда ждать уже нечего.
     */
    for (let tried = 1; alive; tried += 1) {
      try {
        await knock(who)
        retrying = false
        return
      } catch (cause: unknown) {
        // Бан приезжает сроком в теле отказа: спорить с ним нечем, и повторять
        // нечего — экран меняется на объяснение.
        if (cause instanceof ApiError && cause.status === 403 && cause.until !== null) {
          bannedUntil = cause.until
          retrying = false
          busy = false
          signingIn = false
          return
        }
        const wait = retryJoinIn(cause, tried)
        if (wait === null) {
          error = cause instanceof Error ? cause.message : 'Could not join the seminar'
          retrying = false
          busy = false
          signingIn = false
          return
        }
        retrying = true
        await new Promise((done) => window.setTimeout(done, wait))
      }
    }
  }
</script>

{#snippet meta()}
  <span class="font-mono">{stamp}</span>
  {#if host}
    <span class="h-4 w-px shrink-0 bg-brand-2" aria-hidden="true"></span>
    <span>{host.name}</span>
  {/if}
{/snippet}

{#snippet inside()}
  <!--
    The box is here whether or not there is anyone to put in it, and that half
    is not motion at all. The poster holds its headline between two flex
    spacers, so a footer that appears when the roster lands redistributes them
    and lifts the seminar name by about half the footer's height — at the exact
    instant the stack appears. Reserving the strip first is what makes the fade
    below legible: a fade laid over a reflow is two stutters, not one.

    28px is the size AvatarStack is drawn at below, so a full slot measures
    exactly what an empty one reserved. min-h rather than h: at the narrow end
    of `lg` the sentence wraps to a second line, and a fixed height would let it
    out of the box instead of growing with it.

    The price is that the masthead sits ~14px lower than it used to over an
    empty room, including for the first person in — nobody ever sees both states
    in one life of the page, so this is a trade, not an invisible win.
  -->
  <div class="flex min-h-7 items-center">
    {#if present.length > 0}
      <!--
        Until now this row was painted onto the poster the frame the request
        answered, which is the "appears out of nowhere" the method exists to
        stop. animate-fade-up is the product's existing "content has arrived"
        entrance — 160ms, 4px of rise, --ease-out — and it is right here for the
        same reason it is right everywhere else: 160ms sits in the small-entrance
        tier, and a curve that spends its travel in the first third means the
        row is legible almost as soon as it is asked for, which matters on a
        screen a student is trying to leave.

        Once per person per seminar: roster and onlineIds are assigned once in
        onMount and never touched again on this screen, so this can play a
        second time only if the student reloads the door. It also cannot fire at
        page load — `present` is empty on the first frame by construction — so
        nobody pays for it while the poster is painting.

        One fade for one fact: the four faces are deliberately NOT staggered.
        The stack says "the room is not empty", which is a single statement, and
        a cascade would turn a 28px strip into an event.

        Reduced motion needs nothing here: index.css swaps this keyframe for its
        travel-free twin, so the row still fades at full duration and simply
        does not rise.
      -->
      <div class="flex animate-fade-up items-center gap-3.5">
        <!-- Sliced to four rather than capped at four: the count is spelled out in
             words right beside the stack, and a "+13" chip would say it twice. -->
        <AvatarStack
          people={present.slice(0, 4)}
          max={4}
          size={28}
          ring="rgb(var(--brand))"
          tone="onDark"
        />
        <span>
          {present.length}
          {present.length === 1 ? 'person is' : 'people are'} already inside
        </span>
      </div>
    {/if}
  </div>
{/snippet}

{#if bannedUntil !== null}
  <!-- Ни афиши, ни формы: обе обещали бы вход, которого сейчас нет. -->
  <div class="flex h-full items-center justify-center px-6">
    <BannedScreen until={bannedUntil} />
  </div>
{:else}
<div class="flex h-full">
  <!--
    The poster is the seminar; the column beside it is the paperwork. It leaves
    on a narrow window rather than squeezing — a phone that gets half a poster
    and half a form gets neither.

    The footer is handed over unconditionally: the snippet itself decides
    whether there is anything to show, so the poster reserves its strip on the
    first frame and the headline never moves. Passing `undefined` until the
    roster landed is what made the masthead jump.
  -->
  <Poster
    eyebrow="You’re joining"
    title={session.name || '\u00a0'}
    {meta}
    footer={inside}
    width="hidden w-3/5 lg:flex"
    institution={session.institution}
  />

  <!-- main, not a div: the form is what this page is for, and a screen reader
       needs somewhere for "skip to content" to land. The poster beside it is
       already a complementary landmark. -->
  <main class="min-w-0 flex-1 overflow-y-auto px-6 sm:px-10 lg:px-14">
    <!--
      A teacher arriving from the panel has already said who they are. Showing
      them the form for the half-second the answer takes, then snatching it
      away, would read as a glitch — so the column simply says what is
      happening. It falls back to the real form if the cookie turns out to be
      stale.
    -->
    {#if signingIn}
      <div class="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-3 py-12">
        <p class="text-2xs font-bold uppercase tracking-label text-muted">Signing you in</p>
        <!--
          «Straight away» — пока это правда.

          Вход штата идёт через тот же `join`, что и у всех, а он в толпе
          получает 429 и стучится ещё раз сам (lib/crowd.ts). Строка про
          очередь стояла ВНУТРИ формы, а формы в этой ветке нет — и экран
          четыре с лишним секунды обещал мгновенный вход и молчал. Теперь
          обещание уступает место объяснению на том же месте.
        -->
        <p class="text-ui-lg text-muted">
          {#if retrying}
            {CROWD_NOTICE}
          {:else}
            You are already signed in to the teaching side, so this seminar opens straight away.
          {/if}
        </p>
      </div>
    {:else}
    <form
      class="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 py-12"
      onsubmit={join}
    >
      <!-- The poster is gone at this width and the seminar it names is not
           allowed to go with it: a student on a phone still has to see which
           room the link opened. Same content, re-set at a size that fits. -->
      <div class="flex flex-col gap-2 lg:hidden">
        <p class="text-2xs font-bold uppercase tracking-label text-muted">You’re joining</p>
        <h1 class="text-balance text-display font-black text-ink">
          {session.name || '\u00a0'}
        </h1>
        <div class="flex flex-wrap items-center gap-3.5 text-ui text-muted">
          <span class="font-mono">{stamp}</span>
          {#if host}
            <span class="h-4 w-px shrink-0 bg-line" aria-hidden="true"></span>
            <span>{host.name}</span>
          {/if}
        </div>
      </div>

      {#if notice}
        <!-- Спокойной строкой, не красной: место в комнате истекает само, и
             человек, который сюда попал, ничего не сделал неправильно. -->
        <p class="border border-line bg-surface px-4 py-3 text-ui text-muted" role="status">
          {notice}
        </p>
      {/if}

      {#if finishedStamp}
        <!--
          Сказать до входа, а не после.

          Иначе человек называет имя, заходит и упирается в тетрадь, где не
          нажимается ничего, — а это ровно то, что читается как сломанная
          комната. Форма остаётся рабочей: комната открыта на чтение, и войти в
          неё за разбором — обычное дело.
        -->
        <div
          class="flex flex-col gap-2 border border-line bg-surface px-4 py-3 text-ui text-muted"
          role="status"
        >
          <p>
            Занятие закончено {finishedStamp}. Войти можно — тетрадь, файлы и ответы оракула на
            месте, но здесь теперь только читают.
          </p>
          {#if session.published}
            <!--
              И куда идти вместо комнаты.

              Ссылка в чате ведёт сюда, и это единственный адрес, который у
              студента есть: без этой строки он через неделю называет имя,
              заводит ещё одну строку участника, будит ядро и оказывается один
              в живой тетради, где ничто не говорит, что разбор давно
              опубликован.

              Адрес — через `publicationAddress`: страницы живут по имени,
              которое дали классу, а `/p/<id>` — запасной вход для тех, у кого
              имени нет.
            -->
            <p>
              Есть <a
                class="font-semibold text-accent-text hover:underline"
                href="/p/{publicationAddress(session.published)}"
                >опубликованная версия</a
              >
              — {session.published.steps}
              {plural(session.published.steps, 'шаг', 'шага', 'шагов')}{#if session.course}, в
                курсе <a
                  class="font-semibold text-accent-text hover:underline"
                  href="/c/{session.course.id}">{session.course.name}</a
                >{/if}.
            </p>
          {/if}
        </div>
      {/if}

      <div class="flex flex-col gap-2.5">
        <label
          for="join-name"
          class="text-2xs font-bold uppercase tracking-label text-muted"
        >
          Your name
        </label>
        <!-- A ruled box on the page's own ground, not a filled surface: on this
             screen the field is the only thing the student has to fill in.
             Через `.field`, а не своей рамкой: фокусный язык на продукт один —
             акцентная рамка и кольцо 4px вместо системного контура, — и это
             первое поле, которое видит каждый студент. Своим набором классов
             оно давало рамку И глобальный `:focus-visible` outline разом, то
             есть выглядело иначе, чем все остальные поля Colloq. Размеры и
             грунт переопределены утилитами: `.field` лежит в слое компонентов,
             утилиты — выше. -->
        <input
          id="join-name"
          bind:this={nameInput}
          bind:value={name}
          class="field bg-canvas px-4 py-3 text-head font-semibold placeholder:font-normal"
          placeholder="Alex"
          maxlength={40}
          autocomplete="name"
          aria-invalid={error ? 'true' : undefined}
          oninput={() => (error = null)}
        />
        {#if error}
          <p class="text-ui text-danger" role="alert">{error}</p>
        {:else if retrying}
          <!-- Спокойной строкой, не красной, и на том же месте, где стоял бы
               отказ: человек ничего не сделал неправильно, а знать, чего он
               ждёт, всё равно должен. -->
          <p class="text-ui text-muted" role="status">{CROWD_NOTICE}</p>
        {/if}
      </div>

      <div class="flex flex-col gap-2.5">
        <div class="flex items-baseline gap-2.5">
          <span class="text-2xs font-bold uppercase tracking-label text-muted">Your mark</span>
          {#if picking}
            <span class="ml-auto text-2xs text-muted">
              {MARKS.length} marks{taken.size > 0 ? ` · ${taken.size} taken` : ''}
            </span>
          {/if}
        </div>

        {#if picking}
          <MarkPicker value={mark} {taken} onpick={pick} onclose={() => (picking = false)} />
        {:else}
          <!--
            Wraps below ~360px. The avatar and Change both hold their width, so
            on a 320-360px phone the sentence between them was left about 185px
            and broke into five lines — "Picked from the / ones nobody in this /
            room has taken, so / your cursor is / always yours." Letting Change
            drop to its own row gives the sentence the full column back.
          -->
          <div class="flex flex-wrap items-center gap-3.5 border border-line bg-surface p-3">
            <!-- The one saturated thing in the column. The colour a person
                 actually gets is minted with their id at join time, so this
                 stands in with the brand's own signal colour rather than
                 guessing at one. The glyph is sized for the circle, not for a
                 box — see text-mark in tailwind.config.js, where the reasoning
                 and the emoji that forced it are written down. -->
            <span
              class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full
                     bg-accent text-mark leading-none"
              aria-hidden="true"
            >
              {mark}
            </span>
            <div class="flex min-w-[11rem] flex-1 flex-col gap-0.5">
              <p class="text-ui-lg font-semibold text-ink">The {markName(mark)} is yours</p>
              <!-- Обещание ровно на то, что делается: ростер читается перед
                   входом, а не при монтировании, — но сорок меток на класс и
                   две вкладки, постучавшие в одну секунду, всё ещё могут
                   сойтись. «Always yours» было обещанием сервера, которого
                   сервер не даёт. -->
              <p class="text-2xs text-muted">
                Picked from the ones nobody in this room is wearing right now. Change it if you
                spot a twin.
              </p>
            </div>
            <!-- `press` is the house helper for a control that does not route
                 through .btn: transform only, --speed-press (120ms, the middle
                 of the press tier) on --ease-out, and scale(0.97) while the
                 finger is down. It is opted into by name rather than copied,
                 so the door presses exactly like the rest of the product. -->
            <button
              type="button"
              class="press flex h-9 shrink-0 flex-1 items-center justify-center gap-2 border
                     border-line bg-canvas px-3 text-ui font-semibold text-ink hover:border-faint
                     sm:flex-none sm:justify-start"
              onclick={openPicker}
            >
              <Icon name="restart" size={13} />
              Change
            </button>
          </div>
        {/if}
      </div>

      <!--
        The one press on this screen that has to answer instantly. Until now the
        only thing that changed when it was pushed was the label — and only once
        the request had already come back, so for the whole round trip a student
        on a slow room had no proof the interface had heard them. scale(0.97) is
        bound to the finger rather than to a state, so it can never arrive late.

        Values are the ones `.press` carries (--speed-press, --ease-out, 0.97):
        120ms sits in the middle of the 100-160ms press tier, and --ease-out
        spends its travel in the first third, so the release reads as a release
        rather than as a delay. The helper class itself cannot be used here,
        because this button also fades its opacity on hover and any Tailwind
        `transition-*` utility would replace the helper's shorthand and leave
        the transform snapping — so the two properties are listed together and
        the curve is named out loud. `ease-out` is the token, not the browser
        keyword: tailwind.config.js points that utility at --ease-out precisely
        so the weak built-in is unreachable.

        `enabled:` is belt-and-braces — no browser matches :active on a disabled
        button — but it documents the intent and guards the aria-disabled shape
        this control may grow. A control that shrinks under the finger while it
        is refusing the click would be a lie. Once per student per seminar, so
        this is nowhere near the frequency tier that disqualifies motion, and
        under reduced motion index.css deliberately keeps the press: 3% that
        never travels is feedback, not decoration.
      -->
      <button
        class="flex h-14 w-full items-center justify-center gap-2.5 bg-primary text-ui-lg
               font-bold uppercase tracking-label text-primary-ink
               transition-[opacity,transform] duration-press ease-out
               enabled:active:scale-[0.97] hover:opacity-90 disabled:opacity-40"
        type="submit"
        disabled={busy || !name.trim()}
      >
        {#if picking && name.trim()}
          <!-- The button's own ink, thinned: accent on this button would be the
               accent it is already painted with in dark. -->
          <span
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full
                   bg-primary-ink/20 text-ui-lg leading-none"
            aria-hidden="true"
          >
            {mark}
          </span>
        {/if}
        <span class="min-w-0 truncate">{busy ? 'Joining…' : label}</span>
        {#if busy}
          <Icon name="spinner" size={16} class="shrink-0 animate-spin" />
        {:else}
          <Icon name="arrow-right" size={16} strokeWidth={2.4} class="shrink-0" />
        {/if}
      </button>

      {#if !picking}
        <p class="text-ui text-muted">
          No account, no email. The link is the seminar — close the tab and the same link
          brings you back.
        </p>
      {/if}
    </form>
    {/if}
  </main>
</div>
{/if}

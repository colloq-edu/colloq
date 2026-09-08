<script lang="ts">
  /**
   * Кто в комнате — и, у преподавателя, кого в неё не пускают.
   *
   * Два списка в одной панели, потому что это один и тот же вопрос, заданный с
   * двух сторон: удаляют человека отсюда же, правой кнопкой по его строке, и
   * возвращают строкой ниже. Разносить их по разным местам значило бы прятать
   * снятие бана от того, кто его поставил, — а ошибиться строкой в списке имён
   * легко, лиц там нет.
   */
  import type { Ban } from '@shared/protocol'
  import { getSessionState } from '@/lib/session.svelte'
  import { peopleInRoom, whereabouts, type Person } from '@/lib/room'
  import { reveal, revealCell, type RevealTarget } from '@/lib/reveal'
  import { watchCell, watchCellNumbers, watchCellMeta, watchNotebookMeta } from '@/lib/yreactive.svelte'
  import {
    activeBans,
    askToBan,
    BANS_CHANGED_EVENT,
    mayBan,
    personNotes,
    untilWords,
    type PersonMark,
  } from '@/lib/bans'
  import { api } from '@/lib/api'
  import Avatar from '@/components/ui/Avatar.svelte'
  import { cn } from '@/lib/utils'

  /** Faces before the rest fold into "+N more"; the rail is a glance, not a roster. */
  const CAP = 6

  const session = getSessionState()
  const cellNumbers = watchCellNumbers(session.doc)
  const meta = watchNotebookMeta(session.doc)
  // The one cell the kernel is inside, if any — the difference between someone
  // sitting in a cell and someone waiting on it.
  const running = watchCell(session.doc, () => meta.current.runningCellId ?? '')
  const runningMeta = watchCellMeta(() => running.current)

  let expanded = $state(false)

  // One rule for "who is here", shared with the header's avatar row — they used
  // to count differently and the bar contradicted itself.
  const people = $derived(peopleInRoom(session.peers))

  const shown = $derived(expanded ? people : people.slice(0, CAP))
  const rest = $derived(people.length - shown.length)

  /* ------------------------------------------------------------------ баны */

  const isHost = $derived(session.me.role === 'host')

  let bans = $state.raw<Ban[]>([])
  /**
   * Пометки про браузеры — только те, что прислал сервер.
   *
   * Пусто у всех, пока он о них не знает: список людей от этого выглядит ровно
   * так, как выглядел, — пометка по догадке хуже отсутствующей.
   */
  let marks = $state.raw<Record<string, PersonMark>>({})
  /**
   * Час, по которому считаются сроки и свежесть пометок.
   *
   * Переставляется вместе с перечитыванием списка: «впервые, только что»
   * перестаёт быть правдой через пять минут, а бан кончается сам — и строка
   * «до 18:40», висящая в семь вечера, предлагает снять снятое.
   */
  let now = $state(Date.now())
  let lifting = $state<string | null>(null)

  const live = $derived(activeBans(bans, now))

  async function refresh(): Promise<void> {
    try {
      const body = await api.bans(session.session.id, session.token)
      bans = body.bans
      marks = body.marks ?? {}
    } catch {
      /* сеть моргнула; следующий круг перечитает — на списке людей это не сказывается */
    }
    now = Date.now()
  }

  /*
   * Раз в минуту, и только у преподавателя. Запрос дешёвый — десяток строк на
   * комнату, — а платит за него один человек в комнате; студенту эта панель не
   * задаёт ни одного вопроса, которого не задавала раньше.
   */
  $effect(() => {
    if (!isHost) return
    void refresh()
    const again = () => void refresh()
    const timer = window.setInterval(again, 60_000)
    window.addEventListener(BANS_CHANGED_EVENT, again)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(BANS_CHANGED_EVENT, again)
    }
  })

  /**
   * Правая кнопка по строке — единственный вход в меню отсюда.
   *
   * Не значок в строке: удаление с занятия нажимают раз в семестр, а строку
   * списка людей — по десять раз за пару, чтобы дойти до чужой ячейки. Кнопка
   * рядом с этим маршрутом попадала бы под палец у того, кто целился в имя.
   */
  function offerBan(event: MouseEvent, person: Person): void {
    if (!mayBan(session.me.role, person.user.role)) return
    event.preventDefault()
    askToBan({
      id: person.user.id,
      name: person.user.name,
      color: person.user.color,
      avatar: person.user.avatar,
      x: event.clientX,
      y: event.clientY,
    })
  }

  async function lift(ban: Ban): Promise<void> {
    lifting = ban.id
    try {
      await api.liftBan(session.session.id, session.token, ban.id)
      // Строка уходит сразу: сервер ответил, и ждать следующего круга опроса
      // значит держать под нажатой кнопкой того, кого уже вернули.
      bans = bans.filter((other) => other.id !== ban.id)
    } catch (cause) {
      session.showError(cause instanceof Error ? cause.message : 'Не удалось снять ограничение доступа.')
    } finally {
      lifting = null
    }
  }

  /** Ячейки, запуск и кто его нажал — всё, из чего считается «где кто». */
  const view = $derived({
    numbers: cellNumbers.current,
    runningCellId: meta.current.runningCellId,
    runBy: (runningMeta.current.runBy as string | null) ?? null,
  })

  /**
   * Подпись на наведение: куда именно уведёт нажатие.
   *
   * По-русски, как и всё вокруг: список удалённых под этой же панелью, окно
   * бана, пульт правил и дерево файлов — русские, и английская подсказка среди
   * них читалась бы как чужая вставка. (Здесь долго стоял обратный довод — он
   * был верен, когда по-русски в приложении было четыре строки, и перестал
   * быть верным, когда русской стала половина интерфейса.)
   */
  function hintFor(person: Person, place: RevealTarget): string {
    const who = person.isSelf ? 'вам' : person.user.name
    if (place.where === 'terminal') return `К ${who} в терминал`
    if (place.where === 'oracle') return `К ${who} в ленту оракула`
    const number = view.numbers.get(place.cellId)
    return number === undefined ? 'К ячейке' : `К ячейке ${String(number).padStart(2, '0')}`
  }

  function go(place: RevealTarget): void {
    if (place.where === 'cell') revealCell(session, place.cellId)
    else reveal(place)
  }

  /** Кто человек — вместо строки о том, что он делает; и метка преподавателя. */
  function badgeFor(person: Person): string | null {
    const host = person.user.role === 'host'
    if (person.isSelf) return host ? 'Преподаватель · вы' : 'вы'
    return host ? 'Преподаватель' : null
  }
</script>

<section class="flex shrink-0 flex-col gap-0.5 px-4 pb-5 pt-5" aria-label="Кто в комнате">
  <div class="flex items-center gap-2 pb-2">
    <h2 class="text-2xs font-bold uppercase tracking-section text-muted">Люди</h2>
    <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
    <span class="font-mono text-micro tabular-nums text-muted">{people.length}</span>
  </div>

  {#if people.length === 0}
    <p class="px-2 text-2xs text-muted">Подключаемся к комнате…</p>
  {/if}

  {#each shown as person (person.user.id)}
    {@const seen = whereabouts(person, view)}
    {@const activity = seen.line}
    {@const badge = badgeFor(person)}
    {@const place = seen.place}
    {@const notes = isHost
      ? personNotes(marks[person.user.id], { bansActive: live.length > 0, now })
      : []}
    <!--
      Строка становится кнопкой ровно тогда, когда ей есть куда вести. Про
      человека, о котором нечего сказать, и показать нечего: он в комнате, но
      не в каком-то её месте — и подсветка под курсором на такой строке
      обещала бы переход, которого не будет.

      svelte:element, а не два одинаковых блока разметки: у ряда семь
      вложенных элементов, и вторая копия разошлась бы с первой на первой же
      правке отступа.
    -->
    <svelte:element
      this={place ? 'button' : 'div'}
      role={place ? 'button' : undefined}
      type={place ? 'button' : undefined}
      title={place ? hintFor(person, place) : undefined}
      onclick={place ? () => go(place) : undefined}
      oncontextmenu={(event: MouseEvent) => offerBan(event, person)}
      class={cn(
        'flex min-h-[34px] w-full items-center gap-2.5 px-2 text-left',
        place &&
          'transition-colors duration-[var(--speed-quick)] hover:bg-line ' +
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
      )}
    >
      <Avatar
        name={person.user.name}
        color={person.user.color}
        avatar={person.user.avatar}
        size="sm"
      />

      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-ui text-ink {person.isSelf ? 'font-semibold' : ''}">
          {person.user.name}
        </span>
        <!-- Who you are outranks what you are doing: your own row and a host's
             carry the label, everyone else's carries the live line. -->
        {#if badge && (person.isSelf || !activity)}
          <span class="truncate text-2xs font-bold uppercase tracking-label text-accent-text">
            {badge}
          </span>
        {:else if activity}
          <span class="truncate text-2xs tracking-caps text-muted">{activity}</span>
        {/if}
        <!--
          Пометки — третьей строкой и тем же тихим цветом, что и всё
          остальное здесь. Они ничего не запрещают и могут ошибаться, поэтому
          не спорят за внимание ни с именем, ни с тем, что человек делает: за
          что именно комната зацепилась, написано под курсором.
        -->
        {#if notes.length > 0}
          <span class="flex flex-wrap items-center gap-x-1 text-micro leading-snug text-muted">
            {#each notes as note, index (note.text)}
              {#if index > 0}<span aria-hidden="true">·</span>{/if}
              <span title={note.why} class="cursor-help">{note.text}</span>
            {/each}
          </span>
        {/if}
      </div>

      <!-- The square is the same colour as this person's cursor in the editor;
           that tie is the whole reason it is a square and not a status dot. -->
      <span class="flex w-3.5 shrink-0 justify-end">
        <span
          class="h-2 w-2"
          style="background-color: {person.user.color}"
          aria-hidden="true"
        ></span>
      </span>
    </svelte:element>
  {/each}

  {#if rest > 0 || expanded}
    <!-- The design stops the list at a glance; nobody in the room is actually
         unreachable, so the count opens the rest instead of hiding them. -->
    <button
      type="button"
      class="flex h-[30px] shrink-0 items-center gap-2.5 px-2 text-left text-2xs text-muted transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      onclick={() => (expanded = !expanded)}
    >
      <span class="w-6 shrink-0" aria-hidden="true"></span>
      <span>{expanded ? 'Свернуть' : `ещё ${rest}`}</span>
    </button>
  {/if}
</section>

<!--
  Кого не пускают — и одна кнопка, которая это отменяет.

  Списка нет вовсе, пока никого не удаляли: пустой раздел «Удалены» в каждой
  комнате рассказывал бы про наказание всем преподавателям, включая тех, кому
  оно никогда не понадобится.
-->
{#if isHost && live.length > 0}
  <section class="flex shrink-0 flex-col gap-0.5 px-4 pb-5" aria-label="Удалённые с занятия">
    <div class="flex items-center gap-2 pb-2">
      <h2 class="text-2xs font-bold uppercase tracking-section text-muted">Удалены</h2>
      <span class="h-px flex-1 bg-line" aria-hidden="true"></span>
      <span class="font-mono text-micro tabular-nums text-muted">{live.length}</span>
    </div>

    {#each live as ban (ban.id)}
      <div
        class="flex min-h-[34px] items-center gap-2.5 px-2"
        title={ban.byTeacher ? `Удалил ${ban.byTeacher}` : undefined}
      >
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-ui text-ink">{ban.name}</span>
          <span class="truncate text-2xs tracking-caps text-muted">
            до {untilWords(ban.until, now)}{ban.mine ? ' · это ваш браузер' : ''}
          </span>
        </div>
        <button
          type="button"
          class="btn-ghost h-6 shrink-0 px-2 text-2xs font-bold uppercase tracking-label"
          disabled={lifting === ban.id}
          onclick={() => void lift(ban)}
        >
          {lifting === ban.id ? 'Снимаем…' : 'Вернуть'}
        </button>
      </div>
    {/each}

    <!--
      Здесь стояло «их возвращает восстановление версии в истории» — обещание,
      которого продукт не выполняет: история хранит ячейки тетради (`cellsOf` в
      collab/history.ts), и возврат версии ленту вопросов не трогает вовсе.
      Преподаватель, прочитавший это, нажимал «Restore all» на чекпоинте «до
      бана» и получал нетронутую тетрадь и ту же пустую ленту. Пока возврат не
      умеет ленту, сказано то, что есть.
    -->
    <p class="px-2 pt-1.5 text-micro leading-snug text-muted">
      Снятие ограничения не восстанавливает удалённые вопросы и ответы оракула. История версий хранит только ячейки тетради.
    </p>
  </section>
{/if}

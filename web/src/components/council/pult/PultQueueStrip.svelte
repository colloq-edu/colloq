<script lang="ts">
  import { tr } from '@shared/i18n'
  import Avatar from '@/components/ui/Avatar.svelte'
  import type { CouncilAttempt } from '@shared/protocol'
  import type { CouncilSettings } from '@shared/notebook'
  import ContextMenu, { type ContextMenuItem } from '@/components/ui/ContextMenu.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { kernelIsBusy, pultClock, pultDuration, queuedInBook, requestReason, timedOutAttempts, timedOutLimit, type KernelView } from '@/lib/council-pult'
  import { spell } from '@/lib/utils'

  interface Props {
    kernel: KernelView
    /** Регламент ячейки: отсюда очередь знает предел запуска. Меняют его в листе. */
    settings: CouncilSettings
    /** Вся стопка — ради секции «Остановлены сами»: её работы уже не в очереди. */
    attempts: readonly CouncilAttempt[]
    names: boolean
    now: number
    /** Retained for callers; global navigation now controls this view. */
    open: boolean
    disabled: boolean
    ontoggle: () => void
    oninterrupt: () => void
    /** Перезапуск ядра ТЕТРАДИ — последнее средство, когда ядро глухо к сигналу. */
    onrestart: () => void
    onapprove: (attempt: CouncilAttempt) => void
    ondecline: (attempt: CouncilAttempt) => void
    onapproveall: () => void
    onopen: (participantId: string) => void
    /** Снять ждущий запуск с очереди — не трогая человека. */
    ondrop: (attempt: CouncilAttempt) => void
    onremove: (attempt: CouncilAttempt, event: MouseEvent) => void
  }

  let { kernel, settings, attempts, names, now, disabled, oninterrupt, onrestart, onapprove, ondecline, onapproveall, onopen, ondrop, onremove }: Props = $props()
  const running = $derived(kernel.running)
  /**
   * Чужая работа, которая держит очередь, — и `null`, когда её нет.
   *
   * «Чужая» — это либо обычная ячейка тетради, либо попытка СОСЕДНЕЙ ячейки
   * консилиума. Своя попытка (`here`) сюда не попадает: её рисует карточка
   * ниже, со всеми подробностями стопки.
   */
  const elsewhere = $derived(kernel.book?.busy && !kernel.book.busy.here ? kernel.book.busy : null)
  const busy = $derived(kernelIsBusy(kernel))
  /** Два сигнала ушли, а работа считается: очередь стоит, и её не сдвинуть. */
  const stuck = $derived(kernel.book?.busy?.stuck === true)
  const startedAt = $derived(running?.run?.startedAt ?? kernel.book?.busy?.startedAt ?? 0)
  const elapsed = $derived(busy ? Math.max(now - startedAt, 0) : 0)
  /**
   * Под каким пределом идёт то, что считается.
   *
   * У своей попытки — регламент ячейки, у чужой работы — то, что приехало с
   * кадром ядра: у соседней ячейки консилиума свой регламент, у обычной ячейки
   * — предел комнаты (rules.ts · cellLimitSec), и оба могут отличаться от
   * здешнего. Показывать чужому запуску наш предел значило бы рисовать полосу,
   * которая ничего не сторожит.
   */
  const limitSec = $derived(elsewhere ? elsewhere.limitSec : settings.runLimitSec)
  const limitMs = $derived(limitSec === null ? null : limitSec * 1000)
  /** Предел вышел, а запуск идёт: SIGINT не взял, и дальше — только руками. */
  const overLimit = $derived(limitMs !== null && elapsed >= limitMs)
  const stopped = $derived(timedOutAttempts(attempts))
  const who = (attempt: CouncilAttempt): string => names ? attempt.name : tr('room.pult.v2.queue.anonymous')
  /** Имя из кадра ядра — под той же ручкой имён, что и строки стопки. */
  const whoBusy = (name: string): string => names ? name : tr('room.pult.v2.queue.anonymous')
  const firstLine = (text: string): string => text.split('\n').find((line) => line.trim()) ?? ''

  /**
   * Меню строки очереди — и повод, ради которого оно заведено.
   *
   * В строке стояла одна кнопка, и та — «убрать с занятия». То есть
   * единственным, что преподаватель мог сделать с чужим запуском, было выгнать
   * автора: несоразмерно настолько, что этим не пользовались. Теперь строка —
   * кнопка, открывающая работу, а опасное действие ушло под «⋯» и стоит рядом
   * со своим соразмерным соседом — «снять запуск».
   *
   * Общее меню комнаты (components/ui/ContextMenu.svelte), а не своё: оно уже
   * умеет клавиатуру, кромки окна и нижний лист на пальце, и вторая копия
   * этого разошлась бы с первой.
   */
  let menuAt = $state<{ x: number; y: number } | null>(null)
  let menuFor = $state<CouncilAttempt | null>(null)
  let menuBack: HTMLElement | null = null

  function openMenu(attempt: CouncilAttempt, event: MouseEvent): void {
    event.stopPropagation()
    menuBack = event.currentTarget as HTMLElement
    menuFor = attempt
    menuAt = { x: event.clientX, y: event.clientY }
  }

  const menuItems = $derived<ContextMenuItem[]>(
    menuFor === null
      ? []
      : [
          {
            label: tr('room.pult.v3.queue.drop'),
            icon: 'x',
            // Считающуюся отсюда не достать: строка ушла в ядро, и останавливает
            // её «Прервать». Пункт при этом остаётся видимым и говорит почему —
            // погашенный без причины читается как поломка.
            disabled: disabled || menuFor.run?.state !== 'queued',
            why: menuFor.run?.state === 'running' ? tr('room.pult.v3.queue.dropRunning') : undefined,
            run: () => menuFor && ondrop(menuFor),
          },
          {
            gap: true,
            label: tr('room.ui.78'),
            icon: 'trash',
            danger: true,
            disabled,
            run: () => {
              const attempt = menuFor
              if (!attempt || !menuBack) return
              // Меню бана встаёт у той же кнопки «⋯», по которой нажали:
              // координаты нужны ему настоящие, а события к этому моменту уже нет.
              const box = menuBack.getBoundingClientRect()
              onremove(attempt, new MouseEvent('click', { clientX: box.left, clientY: box.bottom }))
            },
          },
        ],
  )
</script>

<div class="queue-view" data-pult-queue>
  <div class="queue-content">
    <header class="queue-heading">
      <div>
        <h2>{tr('room.pult.v2.queue.title')}</h2>
        <!-- Очередь — у ТЕТРАДИ, а не у ячейки, и подпись обязана это сказать:
             иначе «в очереди 3» читается как три минуты ожидания, когда впереди
             стоит десяток чужих ячеек. -->
        <p>{tr(kernel.book ? 'room.pult.v3.queue.scopeBook' : 'room.pult.v2.queue.scope')}</p>
      </div>
      <p class="queue-counts">
        {#if kernel.book}
          {tr('room.pult.v3.queue.countsBook', { running: busy ? 1 : 0, queued: queuedInBook(kernel) })}
        {:else}
          {tr('room.pult.v2.queue.counts', { running: running ? 1 : 0, queued: kernel.queued.length })}
        {/if}
      </p>
    </header>

    <section class="running-card" class:is-running={busy} class:is-stuck={stuck} aria-label={tr('room.pult.v2.queue.current')}>
      {#if busy}
        <span class="running-icon" aria-hidden="true">▶</span>
        <div class="running-copy">
          <span class="running-label">
            {#if running}
              {tr('room.pult.v2.queue.current')}
            {:else if elsewhere}
              <!--
                Чужая работа названа тем, что она есть: номером ячейки или
                соседней ячейкой консилиума. Раньше на этом месте стояло «в этой
                ячейке ничего не выполняется» — правда про ячейку и ложь про
                очередь, из-за которой преподаватель ждал непонятно чего.
              -->
              {elsewhere.kind === 'cell'
                ? (elsewhere.index === null
                    ? tr('room.pult.v3.queue.busyCellPlain')
                    : tr('room.pult.v3.queue.busyCell', { index: elsewhere.index }))
                : (elsewhere.index === null
                    ? tr('room.pult.v3.queue.busyOtherPlain')
                    : tr('room.pult.v3.queue.busyOther', { index: elsewhere.index }))}
            {/if}
          </span>
          <div class="running-author">
            {#if running && names}<Avatar name={running.name} color={running.color} avatar={running.avatar} size="md" />{/if}
            <!-- Час запуска с секундами: за минуту их бывает три, и «17:24» у
                 всех трёх не отличает их друг от друга. -->
            <strong>{running ? who(running) : whoBusy(elsewhere?.name ?? '')}</strong><span class="running-time">{tr('room.pult.v3.queueRunning', { time: pultClock(startedAt, true), duration: spell(elapsed) })}</span>
          </div>
          {#if elsewhere}
            <p class="running-hold">{tr('room.pult.v3.queue.holds')}</p>
          {/if}
          <!--
            Предел — там, где он срабатывает.
            Полоса отвечает на единственный вопрос к чужому запуску, идущему
            перед всем классом: ждать его или прерывать. Она же и ловит случай,
            когда ждать бессмысленно: время вышло, а запуск идёт — значит
            остановка не взяла, и дальше поможет только рука.
          -->
          {#if limitMs !== null}
            <div class="running-limit">
              <span class="limit-track" aria-hidden="true">
                <span class="limit-fill" class:over={overLimit} style:width={`${Math.min(100, (elapsed / limitMs) * 100)}%`}></span>
              </span>
              <!-- Когда ниже стоит панель «ядро не отвечает», подпись у полосы
                   молчит: она говорила бы то же самое вдвое короче и вдвое
                   слабее, а два предупреждения об одном читаются как два. -->
              {#if !stuck}
                <span class="limit-note" class:over={overLimit}>
                  {overLimit
                    ? tr('room.pult.v2.queue.limitStuck')
                    : tr('room.pult.v2.queue.limitStops', { duration: pultDuration(limitSec!) })}
                </span>
              {/if}
            </div>
          {/if}
          <!--
            Ядро глухо к прерыванию — и это говорится словами, а не полосой.

            Сервер шлёт два сигнала и замолкает: SIGINT в тугом цикле раз в
            секунду — шторм запросов к Jupyter без единого шанса помочь. С этой
            секунды очередь тетради стоит намертво, и до сих пор об этом не
            узнавал никто. Цена перезапуска названа рядом с кнопкой, а не в
            подтверждении: решение принимают до нажатия.
          -->
          {#if stuck}
            <div class="running-stuck" data-pult-stuck>
              <p class="stuck-title">{tr('room.pult.v3.queue.stuck')}</p>
              <p class="stuck-why">{tr('room.pult.v3.queue.stuckWhy')} {tr('room.pult.v3.queue.restartCost')}</p>
            </div>
          {/if}
        </div>
        <div class="running-actions">
          <!-- Кнопка есть в ЛЮБОМ занятом состоянии: прерывает то, что держит
               очередь сейчас, — свою попытку, чужую попытку или ячейку. Раньше
               она жила внутри ветки своей попытки, то есть пропадала ровно
               тогда, когда была нужна. -->
          <button type="button" class="pult-button pult-button--danger" {disabled} onclick={oninterrupt}>{tr('room.pult.v2.queue.interrupt')}</button>
          {#if stuck}
            <button type="button" class="pult-button pult-button--danger" {disabled} data-pult-restart
              onclick={onrestart}>{tr('room.pult.v3.queue.restart')}</button>
          {/if}
          <!--
            «Удалить с занятия» отсюда ушло вместе с такой же кнопкой из строк
            очереди: снять человека с пары и остановить его запуск — разные по
            весу вещи, и стоять рядом одинаковыми кнопками они не должны.
            Остановка — слева, а человек снимается из меню строки, где рядом
            лежит соразмерное «снять запуск».
          -->
        </div>
      {:else}
        <span class="running-icon" aria-hidden="true">○</span>
        <p class="idle-copy">{tr(kernel.book ? 'room.pult.v3.queue.idleBook' : 'room.pult.v2.queue.idle')}</p>
      {/if}
    </section>

    <section class="pending-section" aria-label={tr('room.pult.v2.queue.pendingTitle', { count: kernel.pending.length })}>
      <div class="section-heading">
        <h3 class="pending-title">{tr('room.pult.v2.queue.pendingTitle', { count: kernel.pending.length })}</h3>
        {#if kernel.pending.length > 0}
          <button type="button" class="pult-button" {disabled} onclick={onapproveall}>{tr('room.pult.v2.queue.allowAll', { count: kernel.pending.length })}</button>
        {/if}
      </div>
      {#if kernel.pending.length === 0}
        <p class="empty-copy">{tr('room.pult.v2.queue.noRequests')}</p>
      {:else}
        <ul class="attempt-list">
          {#each kernel.pending as attempt (attempt.participantId)}
            {@const reason = requestReason(attempt)}
            <li class="pending-row">
              <span class="avatar-slot" aria-hidden="true">
                {#if names}<Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="md" />{:else}<span class="anonymous-avatar"></span>{/if}
              </span>
              <div class="attempt-copy">
                <strong>{who(attempt)}</strong>
                <!-- С какого времени ждёт — словом, а не только в подсказке:
                     по нему решают, кого пускать первым. -->
                <span class="request-time">{tr('room.pult.v2.queue.waiting', { duration: spell(Math.max(now - attempt.runRequest!.requestedAt, 0)) })} · {tr('room.pult.v3.queueSince', { time: pultClock(attempt.runRequest!.requestedAt) })}</span>
              </div>
              {#if reason}<span class="request-reason pult-meta">{reason}</span>{/if}
              <div class="row-actions">
                <button type="button" class="pult-button pult-button--primary" {disabled} onclick={() => onapprove(attempt)}>{tr('room.pult.v2.queue.allow')}</button>
                <button type="button" class="pult-button" {disabled} onclick={() => ondecline(attempt)}>{tr('room.pult.v2.queue.decline')}</button>
                <!-- «Удалить с занятия» ушло под «⋯» тем же доводом, что и в
                     строках очереди: рядом с «Разрешить» и «Отклонить» оно
                     читалось как третий равный ответ на просьбу. -->
                <button type="button" class="pult-icon-button" {disabled} data-menu-button data-pult-more
                  aria-label={tr('room.pult.v3.queue.rowMenu')} onclick={(event) => openMenu(attempt, event)}>
                  <Icon name="more" size={16} />
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="queued-section" aria-label={tr('room.pult.v2.queue.queuedTitle', { count: kernel.queued.length })}>
      <div class="section-heading"><h3>{tr('room.pult.v2.queue.queuedTitle', { count: kernel.queued.length })}</h3></div>
      {#if kernel.queued.length === 0}
        <p class="empty-copy">{tr(kernel.book && queuedInBook(kernel) === 0 ? 'room.pult.v3.queue.noQueuedBook' : 'room.pult.v2.queue.noQueued')}</p>
      {:else}
        <ol class="attempt-list">
          {#each kernel.queued as attempt, at (attempt.participantId)}
            <li class="queued-row">
              <!--
                Строка — кнопка, открывающая работу.

                До этого по чужому запуску нельзя было нажать вовсе: видны были
                первые строки кода, а единственное доступное действие — удалить
                автора с занятия. Решать по трём строкам, кого выгнать, —
                несоразмерно, и преподаватель на паре сказал об этом прямо.
                Теперь нажатие ведёт на вкладку «Работы» с курсором на этом
                человеке, то есть к полному тексту и выводу.
              -->
              <button type="button" class="queued-open" data-pult-queued-open
                aria-label={tr('room.pult.v3.queue.openRow', { name: who(attempt) })}
                onclick={() => onopen(attempt.participantId)}>
                <span class="queue-position" aria-hidden="true">{String(at + 1).padStart(2, '0')}</span>
                <span class="avatar-slot" aria-hidden="true">
                  {#if names}<Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="md" />{:else}<span class="anonymous-avatar"></span>{/if}
                </span>
                <span class="queued-copy">
                  <strong class="queued-author">{who(attempt)}</strong>
                  <!-- Сколько ждёт — числом, а не только часом постановки: «в
                       очереди 4» без движения не отвечает, идёт ли она вообще. -->
                  <span class="pult-meta queued-since">{tr('room.pult.v3.queue.waitingFor', { duration: spell(Math.max(now - attempt.run!.startedAt, 0)) })} · {tr('room.pult.v3.queueSince', { time: pultClock(attempt.run!.startedAt) })}</span>
                </span>
                <code>{firstLine(attempt.text)}</code>
              </button>
              <button type="button" class="pult-icon-button" {disabled} data-menu-button data-pult-more
                aria-label={tr('room.pult.v3.queue.rowMenu')} onclick={(event) => openMenu(attempt, event)}>
                <Icon name="more" size={16} />
              </button>
            </li>
          {/each}
        </ol>
        <p class="queue-order pult-meta">{tr('room.pult.v2.queue.order')}</p>
      {/if}
    </section>

    <!--
      Последняя секция — те, кого очередь обогнала.
      Их в очереди уже нет, и в ленте работ они стоят обычными строками, но
      вопрос «почему у половины класса нет вывода» задают именно здесь, глядя
      на очередь. Слева — предел, который сработал: он мог с тех пор
      поменяться, и число говорит про СВОЙ запуск, а не про сегодняшнее
      правило.
    -->
    {#if stopped.length > 0}
      <section class="stopped-section" aria-label={tr('room.pult.v2.queue.stoppedTitle', { count: stopped.length })}>
        <div class="section-heading">
          <h3 class="stopped-title">{tr('room.pult.v2.queue.stoppedTitle', { count: stopped.length })}</h3>
          <p class="pult-meta">{tr('room.pult.v2.queue.stoppedNote')}</p>
        </div>
        <ul class="attempt-list">
          {#each stopped as attempt (attempt.participantId)}
            <li>
              <button type="button" class="stopped-row" onclick={() => onopen(attempt.participantId)}
                aria-label={tr('room.pult.v2.queue.stoppedOpen', { name: who(attempt) })}>
                <span class="stopped-limit">{pultDuration(timedOutLimit(attempt)!)}</span>
                <span class="avatar-slot" aria-hidden="true">
                  {#if names}<Avatar name={attempt.name} color={attempt.color} avatar={attempt.avatar} size="md" />{:else}<span class="anonymous-avatar"></span>{/if}
                </span>
                <strong class="queued-author">{who(attempt)}</strong>
                <code>{firstLine(attempt.text)}</code>
                <time class="pult-meta stopped-time" datetime={new Date(attempt.run!.startedAt).toISOString()}>{pultClock(attempt.run!.startedAt)}</time>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
</div>

<!-- Меню строки: общее на всю комнату, чтобы клавиатура, кромки окна и нижний
     лист на пальце были здесь те же, что в дереве файлов. -->
<ContextMenu
  at={menuAt}
  label={tr('room.pult.v3.queue.rowMenu')}
  title={menuFor ? who(menuFor) : null}
  items={menuItems}
  opener={menuBack}
  onclose={() => { menuAt = null; menuFor = null }}
/>

<style>
  .queue-view { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; color: rgb(var(--ink)); }
  .queue-content { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 28px; }
  .queue-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  h2 { font-size: 24px; line-height: 30px; font-weight: 700; }
  .queue-heading p { margin-top: 6px; color: rgb(var(--muted)); font-size: 14px; line-height: 20px; }
  .queue-counts { flex-shrink: 0; }
  .running-card { display: flex; align-items: center; gap: 16px; margin: 20px 0 24px; padding: 18px 20px; border-left: 4px solid rgb(var(--line)); background: rgb(var(--raised)); }
  .running-card.is-running { border-left-color: rgb(var(--accent)); }
  /* Значок у ВЕРХНЕЙ строки карточки, а не по её середине: карточка растёт
     полосой предела и панелью «ядро не отвечает», и центрированный треугольник
     уезжал к ним, будто относится к ним, а не к имени. */
  .running-icon { flex-shrink: 0; align-self: flex-start; width: 32px; color: rgb(var(--accent-text)); font-size: 26px; line-height: 32px; }
  .running-copy { flex: 1; min-width: 0; }
  .running-label { color: rgb(var(--accent-text)); font-size: 14px; line-height: 20px; font-weight: 600; }
  .running-author { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 6px; font-size: 18px; line-height: 24px; }
  .running-author strong { overflow-wrap: anywhere; }
  .running-time { color: rgb(var(--muted)); font-size: 16px; font-variant-numeric: tabular-nums; }
  .running-actions { display: flex; flex-shrink: 0; flex-wrap: wrap; gap: 8px; }
  .idle-copy { font-size: 16px; line-height: 24px; color: rgb(var(--muted)); }
  h3 { font-size: 18px; line-height: 26px; font-weight: 700; }
  .pending-title { color: rgb(var(--warning)); font-size: 20px; }
  .section-heading { margin-bottom: 12px; }
  .attempt-list { padding: 0; margin: 0; list-style: none; }
  .pending-row { display: flex; align-items: center; gap: 16px; padding: 14px 0; border-top: 1px solid rgb(var(--line)); }
  .avatar-slot, .anonymous-avatar { display: block; width: 32px; height: 32px; flex-shrink: 0; }
  .anonymous-avatar { border-radius: 50%; background: rgb(var(--line)); }
  .attempt-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 5px; }
  .attempt-copy strong, .queued-author { font-size: 16px; line-height: 20px; font-weight: 700; overflow-wrap: anywhere; }
  .request-time { color: rgb(var(--muted)); font-size: 14px; line-height: 20px; }
  .request-reason { max-width: 180px; color: rgb(var(--danger)); overflow-wrap: anywhere; }
  .row-actions { display: flex; flex-shrink: 0; gap: 8px; }
  .empty-copy { color: rgb(var(--muted)); font-size: 14px; line-height: 20px; }
  .queued-section { margin-top: 24px; }
  .queued-row { display: flex; align-items: center; gap: 8px; padding: 0; border-top: 1px solid rgb(var(--line)); }
  /* Строка-кнопка занимает всю ширину, кроме слота «⋯»: нажатие мимо текста —
     тоже нажатие по работе, и промахнуться некуда. */
  .queued-open { display: flex; flex: 1; align-items: center; gap: 16px; min-width: 0; padding: 12px 0; text-align: left; cursor: pointer; }
  .queued-open:hover { background: rgb(var(--surface)); }
  .queued-copy { display: flex; min-width: 0; flex-direction: column; gap: 4px; width: 210px; flex-shrink: 0; }
  .pult-icon-button { display: flex; flex-shrink: 0; align-items: center; justify-content: center; width: 32px; height: 32px; color: rgb(var(--muted)); }
  .pult-icon-button:hover:not(:disabled) { background: rgb(var(--raised)); color: rgb(var(--ink)); }
  .pult-icon-button:disabled { opacity: .45; }
  .running-hold { margin-top: 6px; color: rgb(var(--muted)); font-size: 13px; line-height: 18px; }
  .running-card.is-stuck { border-left-color: rgb(var(--danger)); }
  .running-stuck { margin-top: 10px; padding: 10px 12px; background: rgb(var(--canvas)); border-left: 3px solid rgb(var(--danger)); }
  .stuck-title { color: rgb(var(--danger)); font-size: 14px; line-height: 20px; font-weight: 700; }
  .stuck-why { margin-top: 2px; color: rgb(var(--muted)); font-size: 13px; line-height: 18px; }
  .queue-position { width: 24px; flex-shrink: 0; color: rgb(var(--muted)); font-size: 15px; font-variant-numeric: tabular-nums; }
  /* Имя внутри своего столбика: ширину держит `.queued-copy`, где под ним
     стоит вторая строка со сроком ожидания. */
  .queued-author { width: 100%; }
  .queued-since { display: block; }
  code { min-width: 0; color: rgb(var(--muted)); font-family: var(--font-mono); font-size: 14px; line-height: 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .queue-order { margin-top: 8px; color: rgb(var(--muted)); }
  .running-limit { display: flex; align-items: center; gap: 12px; padding-top: 7px; }
  .limit-track { flex: 1; min-width: 0; height: 4px; background: rgb(var(--canvas)); }
  .limit-fill { display: block; height: 100%; background: rgb(var(--accent)); }
  .limit-fill.over { background: rgb(var(--danger)); }
  .limit-note { flex-shrink: 0; color: rgb(var(--muted)); font-size: 13px; line-height: 18px; }
  .limit-note.over { color: rgb(var(--danger)); }
  .stopped-section { margin-top: 24px; }
  .stopped-title { color: rgb(var(--muted)); line-height: 22px; }
  .stopped-row { display: flex; align-items: center; gap: 16px; width: 100%; padding: 12px 0; border-top: 1px solid rgb(var(--line)); text-align: left; cursor: pointer; }
  .stopped-row:hover { background: rgb(var(--surface)); }
  .stopped-limit { width: 36px; flex-shrink: 0; color: rgb(var(--danger)); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stopped-time { flex-shrink: 0; }
  .queued-since { font-variant-numeric: tabular-nums; }
  @media (max-width: 850px) {
    .queue-content { padding: 20px; }
    .pending-row { flex-wrap: wrap; gap: 12px; }
    .attempt-copy { min-width: 180px; }
    .request-reason { max-width: none; flex-basis: 100%; padding-left: 44px; order: 1; }
    .queued-copy { width: 150px; }
  }
  @media (max-width: 540px) {
    .running-card { flex-wrap: wrap; }
    .row-actions { margin-left: 44px; }
    .queued-open { flex-wrap: wrap; gap: 10px; }
    .queued-open code { flex-basis: 100%; margin-left: 34px; }
  }
</style>

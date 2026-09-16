<script lang="ts">
  import { tr } from '@shared/i18n'
  import ActivityHistory from './ActivityHistory.svelte'
  /**
   * What the room did to its notebook, and how to put any of it back.
   *
   * Two columns, because the two questions are asked together: the timeline on
   * the left says who changed something and when, the panel on the right says
   * what they changed. Clicking a row never leaves the notebook — the drawer is
   * over it, and the sheet above stays where the reader left it.
   *
   * Список перечитывается целиком — на открытии и потом на каждое затишье
   * документа (эффект ниже): версия пишется на сервере после паузы, и лента,
   * прочитанная один раз, показывала бы правку получасовой давности как
   * последнюю. Содержимое версии загружается по нажатию и остаётся в памяти,
   * так что возврат на уже открытую строку бесплатен. Этого хватает: история
   * семинара — десятки строк, не тысячи.
   */
  import { BURST_IDLE_MS, type Version } from '@shared/history'
  import { CELLS_KEY } from '@shared/notebook'
  import { baseOf } from '@shared/paths'
  import Icon from '@/components/ui/Icon.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { watchBooks } from '@/lib/yreactive.svelte'
  import {
    clock,
    initialsOf,
    listVersions,
    readVersion,
    restoreVersion,
    setCheckpoint,
    type VersionDetail,
  } from '@/lib/history'

  const session = getSessionState()
  const isHost = $derived(session.me.role === 'host')
  let view = $state<'activity' | 'versions'>('activity')
  const showActivity = $derived(isHost && view === 'activity')

  /**
   * История — про одну тетрадь, и панель обязана назвать какую.
   *
   * `collab/history` читает, описывает и возвращает ровно корень `cells` — там
   * это названо прибитым намеренно. У комнаты тетрадей может быть несколько, и
   * кнопка без имени правит не тот лист, который человек видит на экране.
   * Тетради с корнем `cells` может уже не быть (её убрали) — тогда возврат
   * заведёт её заново, и назвать её заранее нечем.
   */
  const books = watchBooks(session.doc)
  const versioned = $derived(books.current.find((book) => book.root === CELLS_KEY) ?? null)
  const versionedName = $derived(versioned ? baseOf(versioned.path) : tr('room.ui.651'))
  const otherBooks = $derived(books.current.length - (versioned ? 1 : 0))

  let versions = $state<Version[]>([])
  /**
   * Начало ленты не сохранилось: комната переросла потолок объёма истории.
   *
   * Считает сервер (db.ts · `historyTrimmed`) и везёт вместе со строками —
   * по самим строкам этого не видно, они выглядят как полная история короткой
   * пары. Не путать с окном ленты: `MAX_VERSIONS` тоже отдаёт не всё, но те
   * версии в базе есть, и говорить о них надо не этими словами.
   */
  let trimmed = $state(false)
  let loading = $state(true)
  let errorRender = $state<() => string | null>(() => null)
  const error = $derived(errorRender())
  let openSeq = $state<number | null>(null)
  let detail = $state<VersionDetail | null>(null)
  let busy = $state(false)
  let naming = $state(false)
  let label = $state('')

  /** Versions already fetched. A second visit to a row is free. */
  const seen = new Map<number, VersionDetail>()

  async function load(): Promise<void> {
    loading = true
    errorRender = () => (null)
    try {
      const body = await listVersions(session.session.id, session.token)
      versions = body.versions
      trimmed = body.trimmed
      /*
       * Only auto-open when nothing is open. A refresh arriving while somebody
       * is reading an old version must not yank them to the newest row — the
       * list moves under them constantly during a live seminar, and that is the
       * one moment they are looking at something on purpose.
       */
      if (openSeq === null && versions.length > 0) void open(versions[0].seq)
    } catch (cause) {
      errorRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.652'))
    } finally {
      loading = false
    }
  }

  async function open(seq: number): Promise<void> {
    openSeq = seq
    /*
     * Ошибка принадлежит попытке, а не панели.
     *
     * Правая колонка рисует ошибку вместо содержимого, а обнулялась она только
     * в `load()` — то есть от правки в документе. В тихой комнате (лекция,
     * никто не печатает) одна моргнувшая сеть закрывала диффы всех следующих
     * версий до конца пары.
     */
    errorRender = () => (null)
    const cached = seen.get(seq)
    if (cached) {
      detail = cached
      return
    }
    detail = null
    try {
      const body = await readVersion(session.session.id, seq, session.token)
      seen.set(seq, body)
      // The reader may have clicked on down the list while this was in flight.
      if (openSeq === seq) detail = body
    } catch (cause) {
      errorRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.653'))
    }
  }

  async function restore(cellId?: string): Promise<void> {
    if (openSeq === null || busy) return
    busy = true
    try {
      await restoreVersion(session.session.id, openSeq, session.token, cellId)
      // The restore is itself a version, so the list is now one longer.
      seen.clear()
      openSeq = null
      await load()
    } catch (cause) {
      errorRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.654'))
    } finally {
      busy = false
    }
  }

  async function checkpoint(): Promise<void> {
    const name = label.trim()
    if (!name || busy) return
    busy = true
    try {
      await setCheckpoint(session.session.id, name, session.token)
      label = ''
      naming = false
      seen.clear()
      await load()
    } catch (cause) {
      errorRender = () => (cause instanceof Error ? tr(cause.message) : tr('room.ui.655'))
    } finally {
      busy = false
    }
  }

  /*
   * The panel follows the room instead of being a snapshot of the moment it
   * opened. Somebody deletes a cell, and the row for it appears here without
   * anybody closing and reopening the drawer.
   *
   * Driven by the document rather than by a clock: a room where nothing is
   * happening asks the server nothing at all, and a room where a lot is
   * happening asks once per lull rather than once per keystroke. The wait is
   * deliberate and generous — the server groups a burst of typing into one
   * version, so refreshing faster would only redraw the same list.
   */
  const SETTLE_MS = 1200

  /**
   * И ещё раз — когда сервер закроет всплеск.
   *
   * Быстрое обновление ловит всё, что уже записано, и в тихой комнате не ловит
   * ничего: сервер собирает набранное в одну версию и пишет её через
   * BURST_IDLE_MS молчания. Человек печатал, панель обновилась через секунду и
   * ничего не нашла, обновлений больше нет — и строка правки не появлялась
   * никогда, хотя в базе она лежала с двенадцатой секунды. Полсекунды сверху —
   * на дорогу и на запись.
   */
  const BURST_SETTLED_MS = BURST_IDLE_MS + 500

  $effect(() => {
    if (showActivity) return
    void load()

    let soon: ReturnType<typeof setTimeout> | null = null
    let settled: ReturnType<typeof setTimeout> | null = null
    const onChange = () => {
      if (soon) clearTimeout(soon)
      if (settled) clearTimeout(settled)
      soon = setTimeout(() => {
        soon = null
        void load()
      }, SETTLE_MS)
      settled = setTimeout(() => {
        settled = null
        void load()
      }, BURST_SETTLED_MS)
    }
    session.doc.on('update', onChange)
    return () => {
      if (soon) clearTimeout(soon)
      if (settled) clearTimeout(settled)
      session.doc.off('update', onChange)
    }
  })

  /**
   * The row's own words: a checkpoint says its name, everything else its summary.
   *
   * Время возвращённой версии дописывает браузер, а не сервер: сервер шлёт
   * адрес (`targetSeq`), потому что часы у него свои — в контейнере UTC, — и
   * собранное там «вернул версию от 15:04» указывало бы в аудитории UTC+3 на
   * строку, которой в списке нет. Здесь оно берётся из той же строки, теми же
   * часами, что рисуют всю ленту. Строки может и не быть: список обрезан или
   * версия приехала раньше — тогда подпись остаётся как есть.
   *
   * «от 15:04», а не «с 15:04»: версия — датированная вещь, как письмо, а «с»
   * читается началом отрезка, которого у неё нет.
   */
  function saying(v: Version): string {
    if (v.kind === 'checkpoint') return v.label ?? tr('room.ui.631')
    if (v.kind === 'restore' && v.targetSeq !== null) {
      const target = versions.find((row) => row.seq === v.targetSeq)
      if (target) return tr('room.ui.656', { p0: v.summary, p1: clock(target.createdAt) })
    }
    return v.summary
  }
</script>

<div class="history-panel">
  {#if isHost}
    <nav class="history-views" aria-label={tr('activity.views')}>
      <button type="button" aria-pressed={showActivity} class:on={showActivity} onclick={() => (view = 'activity')}>{tr('activity.title')}</button>
      <button type="button" aria-pressed={!showActivity} class:on={!showActivity} onclick={() => (view = 'versions')}>{tr('activity.versions')}</button>
    </nav>
  {/if}
  {#if showActivity}
    <ActivityHistory />
  {:else}
<div class="hist">
  <div class="hist-list">
    <!-- Лента не про всю комнату, а про одну тетрадь. Сказать это надо до
         первого клика: в комнате с двумя тетрадями «ничего не записалось»
         читается как пропажа правок, а не как границы истории. -->
    {#if otherBooks > 0}
      <p class="hist-note hist-note--aside"> {tr('room.ui.624')} {versionedName}{tr('room.ui.625')} {otherBooks === 1
          ? tr('room.ui.626')
          : tr('room.ui.627')} {tr('room.ui.628')} </p>
    {/if}
    {#if loading && versions.length === 0}
      <p class="hist-note">{tr('room.ui.629')}</p>
    {:else if versions.length === 0}
      <p class="hist-note">{tr('room.ui.630')}</p>
    {:else}
      {#each versions as v (v.seq)}
        <button
          type="button"
          aria-pressed={openSeq === v.seq}
          class="hist-row"
          class:on={openSeq === v.seq}
          class:mark={v.kind === 'checkpoint'}
          onclick={() => open(v.seq)}
        >
          <span class="hist-time">{clock(v.createdAt)}</span>
          <span class="hist-rail">
            <i class="hist-dot" class:accent={v.kind === 'restore'} class:keep={v.kind === 'checkpoint'}
            ></i>
          </span>
          {#if v.authorName}
            <span class="hist-face" style="background: {v.authorColor ?? '#5d6b8a'}">
              {initialsOf(v.authorName)}
            </span>
          {:else}
            <span class="hist-face hist-face--none" aria-hidden="true"></span>
          {/if}
          <span class="hist-what">
            <b>{v.kind === 'checkpoint' ? (v.label ?? tr('room.ui.631')) : (v.authorName ?? tr('room.ui.632'))}</b>
            <em>{v.kind === 'checkpoint' ? tr('room.ui.633', { p0: v.authorName ?? tr('room.extra.284') }) : saying(v)}</em>
          </span>
          <span class="hist-count">
            {#if v.added > 0}<i class="plus">+{v.added}</i>{/if}
            {#if v.removed > 0}<i class="minus">−{v.removed}</i>{/if}
          </span>
        </button>
      {/each}
      <!-- Конец ленты — не обязательно начало комнаты. Строка стоит последней,
           потому что список идёт от свежего к старому: под самой ранней
           уцелевшей правкой и проходит граница того, что сохранилось. -->
      {#if trimmed}
        <p class="hist-note hist-note--aside hist-note--tail"> {tr('room.ui.634')} </p>
      {/if}
    {/if}
  </div>

  <div class="hist-change">
    {#if error}
      <p class="hist-note hist-note--bad" role="alert">{error}</p>
    {:else if openSeq === null}
      <p class="hist-note">{tr('room.ui.635')}</p>
    {:else if !detail}
      <p class="hist-note">{tr('room.ui.636')}</p>
    {:else if detail.diffs.length === 0}
      <!--
        Чекпоинт и «opened» ничего не правят: список затронутых ячеек у них
        пуст по построению, и одной фразы вместо содержимого хватало ровно до
        первого «вернуть» — кнопку возврата нажимали вслепую. Тетрадь этой
        версии сервер и так присылает целиком, каждым нажатием.
      -->
      <div class="hist-diffs">
        <p class="hist-note">
          {detail.version.kind === 'opened'
            ? tr('room.ui.637')
            : tr('room.ui.638')}
        </p>
        {#each detail.cells as c, at (c.id)}
          <div class="hist-diff">
            <div class="hist-diff-head">
              <b>{c.type === 'markdown' ? tr('room.ui.639') : tr('room.ui.549')} {at + 1}</b>
            </div>
            <pre class="hist-lines hist-source">{c.source}</pre>
          </div>
        {/each}
      </div>
    {:else}
      <div class="hist-diffs">
        {#each detail.diffs as d (d.cellId)}
          <div class="hist-diff">
            <div class="hist-diff-head">
              <b>{d.before === null ? tr('room.ui.640') : d.after === null ? tr('room.ui.641') : tr('room.ui.642')}</b>
              {#if isHost && d.after !== null}
                <button
                  type="button"
                  class="hist-mini"
                  disabled={busy}
                  onclick={() => restore(d.cellId)}
                > {tr('room.ui.643')} </button>
              {/if}
            </div>
            <pre class="hist-lines">{#each d.lines as line}<span
                  class="hist-line"
                  class:add={line.kind === 'added'}
                  class:del={line.kind === 'removed'}
                ><i>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</i>{line.text}
</span>{/each}</pre>
          </div>
        {/each}
      </div>
    {/if}

    <div class="hist-actions">
      <p id="history-versioned-notebook" class="hist-target" title={versionedName}>{tr('activity.notebook')}: <strong>{versionedName}</strong></p>
      <div class="hist-buttons">
      {#if naming}
        <input
          class="hist-name"
          bind:value={label}
          aria-label={tr('activity.checkpointName')}
          placeholder={tr('room.ui.644')}
          maxlength="80"
          onkeydown={(e) => {
            if (e.key === 'Enter') void checkpoint()
            // Escape закрывает поле — и только его: тот же ключ у окна закрывает
            // весь ящик, если никто не сказал, что он уже занят делом, а ящик
            // уносит с собой и открытую версию, и место в списке.
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              naming = false
            }
          }}
        />
        <button type="button" class="hist-go" disabled={busy || !label.trim()} onclick={checkpoint}> {tr('room.ui.645')} </button>
      {:else}
        {#if isHost && openSeq !== null && detail}
          <button
            type="button"
            class="hist-go"
            disabled={busy}
            title={tr('room.ui.646')}
            aria-describedby="history-versioned-notebook"
            onclick={() => restore()}
          >
            <Icon name="restart" size={14} /> {tr('activity.restoreWhole')} </button>
        {/if}
        {#if isHost}
          <button type="button" class="hist-mini" onclick={() => (naming = true)}> {tr('room.ui.648')} </button>
        {/if}
      {/if}
      </div>
      <span class="hist-foot">
        {#if isHost}{tr('room.ui.649')}{:else}{tr('room.ui.650')}{/if}
      </span>
    </div>
  </div>
</div>
  {/if}
</div>

<style>
  .history-panel { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
  .history-views { display: flex; flex: none; gap: 4px; padding: 7px 14px; border-bottom: 1px solid var(--tm-edge); }
  .history-views button { min-height: 32px; padding: 5px 12px; border: 1px solid transparent; background: transparent; color: var(--tm-muted); font: inherit; font-size: 13px; cursor: pointer; }
  .history-views button.on { border-color: var(--tm-edge); background: #0e1a3d; color: var(--tm-accent); }
  .history-views button:focus-visible { outline: 2px solid var(--tm-accent); outline-offset: 2px; }

  /*
   * Палитра ящика — ОДНА, и берётся она отсюда переменными, а не второй копией
   * тех же чисел. Копия успела разойтись: подчёркивание вкладки History стояло
   * на #2eb4e8, а выбранная строка под ней — на #4fc3f0, и тише всех был
   * #5f6e92 — ровно тот оттенок, который терминалу однажды подняли за то, что
   * он не проходит AA. `--tm-*` объявлены на `.term`, а история живёт внутри
   * неё, так что переменные доезжают наследованием.
   *
   * Два фона строки (наведение и выбранная) своих переменных не имеют: это
   * единственное, что здесь остаётся местным, и оно набрано от --tm-bg.
   */
  .hist {
    --hist-hover: #0c1631;
    --hist-on: #0e1a3d;
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    color: var(--tm-muted);
  }

  .hist-list {
    display: flex;
    flex-direction: column;
    width: 318px;
    flex: none;
    overflow-y: auto;
    border-right: 1px solid var(--tm-edge);
    padding-block: 8px;
  }

  .hist-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 14px;
    background: none;
    border: 0;
    /* Transparent rather than absent: the marker on the selected row must not
       shift the four lanes beside it by two pixels. */
    border-left: 2px solid transparent;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  .hist-row:hover {
    background: var(--hist-hover);
  }

  .hist-row.on {
    background: var(--hist-on);
    border-left-color: var(--tm-accent);
  }

  .hist-row:focus-visible {
    outline: 2px solid var(--tm-accent);
    outline-offset: -2px;
  }

  .hist-time {
    width: 32px;
    flex: none;
    /* Тот же моношрифт, что и у расшифровки над ней: `--font-mono` в проекте
       не объявлен нигде, и время истории уезжало в системный SF Mono рядом с
       JetBrains Mono терминала. Время остаётся на компактной ступени, но уже
       не мельче читаемого метатекста. */
    font-family: var(--tm-mono);
    font-size: 12px;
    color: var(--tm-muted);
  }

  .hist-rail {
    width: 8px;
    flex: none;
    display: flex;
    justify-content: center;
  }

  .hist-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--tm-edge);
  }

  .hist-dot.accent {
    background: var(--tm-accent);
  }

  .hist-dot.keep {
    background: var(--tm-live);
  }

  .hist-face {
    width: 20px;
    height: 20px;
    flex: none;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
    font-weight: 800;
    color: #fff;
  }

  .hist-face--none {
    background: var(--tm-edge);
  }

  .hist-what {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1 1 auto;
    min-width: 0;
  }

  .hist-what b {
    font-size: 13px;
    font-weight: 600;
    color: var(--tm-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hist-what em {
    font-size: 13px;
    font-style: normal;
    color: var(--tm-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hist-count {
    display: flex;
    gap: 6px;
    flex: none;
    font-family: var(--tm-mono);
    font-size: 13px;
  }

  .hist-count .plus {
    color: var(--tm-live);
    font-style: normal;
  }

  .hist-count .minus {
    /* Розовый убранного: своей переменной у ящика нет — она нужна только
       здесь и в двух строках диффа ниже. */
    color: #e8899a;
    font-style: normal;
  }

  .hist-change {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  .hist-diffs {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 0;
  }

  .hist-diff-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px 6px;
    font-size: 13px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--tm-muted);
  }

  .hist-diff-head b {
    font-weight: 700;
    color: var(--tm-muted);
  }

  .hist-lines {
    margin: 0 0 12px;
    font-family: var(--tm-mono);
    font-size: 13px;
    line-height: 19px;
    white-space: pre;
    overflow-x: auto;
  }

  /* Содержимое версии без правок: та же лесенка, что у диффа, но без колонки
     под плюс и минус — менять здесь нечего. */
  .hist-source {
    padding-left: 26px;
    color: var(--tm-muted);
  }

  .hist-line {
    display: block;
    color: var(--tm-muted);
  }

  .hist-line i {
    display: inline-block;
    width: 26px;
    text-align: center;
    font-style: normal;
  }

  .hist-line.add {
    background: #0e2a22;
    color: #9fe8cf;
  }

  .hist-line.del {
    background: #2a1119;
    color: #e8a3b1;
  }

  .hist-actions {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    flex: none;
    margin-top: auto;
    padding: 10px 14px;
    border-top: 1px solid var(--tm-edge);
  }

  .hist-target { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--tm-muted); }
  .hist-target strong { font-weight: 500; color: var(--tm-ink); }
  .hist-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .hist-buttons .hist-go, .hist-buttons .hist-mini { box-sizing: border-box; height: 36px; flex: 0 0 auto; justify-content: center; white-space: nowrap; letter-spacing: 0.06em; }
  .hist-buttons .hist-name { box-sizing: border-box; height: 36px; min-width: 100px; }

  .hist-go,
  .hist-mini {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 12px;
    font: inherit;
    /* Это две кнопки, которыми возвращают тетрадь всей комнате, поэтому они
       стоят на обычной ступени управляющего текста. */
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    cursor: pointer;
    /* Bound to the finger, not to a state, so it cannot arrive late. */
    transition:
      background-color var(--speed-quick, 0.1s) ease,
      transform var(--speed-press, 0.12s) var(--ease-out, ease-out);
  }

  .hist-go {
    /* Тот же голубой, что у подчёркивания вкладки: --tm-accent на тёмном
       читается как «здесь», и второй его оттенок рядом читался как другой
       элемент. Текст — сам фон ящика, самый тёмный, что у него есть. */
    background: var(--tm-accent);
    color: var(--tm-bg);
    border: 0;
  }

  .hist-mini {
    background: none;
    color: var(--tm-muted);
    border: 1px solid var(--tm-edge);
  }

  .hist-go:active,
  .hist-mini:active {
    transform: scale(0.97);
  }

  .hist-go:disabled,
  .hist-mini:disabled {
    opacity: 0.4;
    cursor: default;
    transform: none;
  }

  .hist-go:focus-visible,
  .hist-mini:focus-visible,
  .hist-name:focus-visible {
    outline: 2px solid var(--tm-accent);
    outline-offset: 2px;
  }

  .hist-name {
    height: 26px;
    flex: 1 1 auto;
    max-width: 260px;
    padding: 0 10px;
    font: inherit;
    font-size: 13px;
    color: var(--tm-ink);
    background: var(--hist-hover);
    border: 1px solid var(--tm-edge);
  }

  .hist-foot {
    font-size: 13px;
    color: var(--tm-muted);
  }

  .hist-note {
    margin: 0;
    padding: 14px;
    font-size: 14px;
    color: var(--tm-muted);
  }

  .hist-note--bad {
    color: #e8a3b1;
  }

  /* Границы истории, а не событие в ней: тише строк и отделено от них. */
  .hist-note--aside {
    padding: 10px 14px;
    font-size: 13px;
    line-height: 1.45;
    border-bottom: 1px solid var(--tm-edge);
  }

  /* Та же оговорка, но снизу: черта отделяет её от последней строки, а не от
     пустоты под ней. */
  .hist-note--tail {
    border-bottom: 0;
    border-top: 1px solid var(--tm-edge);
  }

  /*
   * On a phone there is no room for two columns: 318px of timeline would leave
   * the diff about eighty, which is not a diff. The list keeps the width it
   * needs and the change goes underneath it, so both are readable one at a time
   * — which is how a narrow screen is read anyway.
   */
  @media (max-width: 720px) {
    .hist {
      flex-direction: column;
      overflow-y: auto;
    }

    .hist-change {
      flex: 1 0 200px;
    }

    .hist-list {
      width: 100%;
      flex: 0 0 auto;
      max-height: 140px;
      border-right: 0;
      border-bottom: 1px solid var(--tm-edge);
    }

    .hist-foot {
      display: none;
    }
  }

  /*
   * Блока `prefers-reduced-motion` здесь нет намеренно.
   *
   * Он снимал transform из списка переходов и оставлял сам scale(0.97): нажатие
   * щёлкало туда и обратно без перехода — рывок вместо движения, то есть ровно
   * то, от чего это правило защищает. Правило продукта (index.css) прямо
   * оставляет прессу его 120 мс и 3%: он никуда не едет и он единственное
   * доказательство, что нажатие услышали.
   */
</style>

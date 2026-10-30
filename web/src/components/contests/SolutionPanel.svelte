<!--
  The solution column (K1) and its phone form (K5): the language, the editor,
  a file dropped or picked, and «ОТПРАВИТЬ» (or ⌘↵).

  THE DRAFT is the browser's, one per contest, problem and language
  (contest-words · draftKey): a reload in the middle of a class test must not
  cost the solution typed so far, and switching C++ → Python → C++ must give
  the C++ back. A language with no draft of its own takes the text as it is —
  the usual reason to switch is «I wrote it in the wrong mode», not «start
  over». Storage that throws (a private window) costs nothing but the promise
  «черновик сохранён», which is then not made.

  A FILE replaces the editor's text, never adds to it: CodeMirror inserts a
  dropped file at the cursor by itself, and «my solution plus my solution»
  is not something anyone sends on purpose. So the drop is caught before the
  editor sees it (capture phase). The file's extension picks the language;
  nothing is sent until «ОТПРАВИТЬ» — what goes to the judge is always what
  is on screen.

  On a phone the editor is folded behind «РЕДАКТОР» and «ФАЙЛ» (K5) and opens
  as a sheet over the page: a 390 px screen fits either the statement or the
  code, and the statement comes first.

  Keyed by the problem in the parent: another problem is another draft and
  another editor, not this one with its text swapped under the cursor.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { tr } from '@shared/i18n'
  import { SOURCE_BYTES, type ContestAccepting, type ContestLanguage } from '@shared/contests'
  import type { EntrantProblem, LanguageOption } from '@shared/contests-entrant'
  import CodeEditor from './CodeEditor.svelte'
  import {
    draftKey,
    fileChoice,
    languageKey,
    pickLanguage,
    readStored,
    sendShortcut,
    sourceBytes,
    SOURCE_ACCEPT,
    writeStored,
  } from '@/lib/contest-words'

  interface Props {
    contestId: string
    problem: EntrantProblem
    /** The languages the contest offers, with whether the image runs them. */
    languages: LanguageOption[]
    /** Whether a submission is taken now, by the server's clock (submissionsOpenFor). */
    accepting: ContestAccepting
    /** The person takes part: without it the join step stands where «ОТПРАВИТЬ» does. */
    joined: boolean
    sending: boolean
    /** The door's refusal of the last send of this problem, in its words. */
    refusal: string | null
    phone?: boolean
    onsend: (language: ContestLanguage, source: string) => void
    /** A refusal of the page's own (a file that is not a source); null clears it. */
    onrefuse: (message: string | null) => void
    /** The join step, in place of the send row. */
    join?: Snippet
  }

  const {
    contestId,
    problem,
    languages,
    accepting,
    joined,
    sending,
    refusal,
    phone = false,
    onsend,
    onrefuse,
    join,
  }: Props = $props()

  /* -------------------------------------------------------- the language */

  /*
   * The last one used for this problem, then in this contest, then the first
   * the image runs — and when it runs none of them, the first the contest
   * offers anyway: the editor still opens, and the note under it says why
   * «ОТПРАВИТЬ» is grey.
   */
  function initialLanguage(): ContestLanguage | null {
    const remembered = [readStored(languageKey(contestId, problem.id)), readStored(languageKey(contestId))]
    return pickLanguage(languages, remembered) ?? languages[0]?.id ?? null
  }

  let language = $state<ContestLanguage | null>(initialLanguage())
  /* The page reloaded with another set of languages (the teacher changed it): keep to what is offered. */
  $effect(() => {
    if (language === null || !languages.some((option) => option.id === language)) language = initialLanguage()
  })
  const chosen = $derived(languages.find((option) => option.id === language) ?? null)

  /* ----------------------------------------------------------- the draft */

  // svelte-ignore state_referenced_locally
  let text = $state(language ? (readStored(draftKey(contestId, problem.id, language)) ?? '') : '')
  /** `saved` — the last edit is in storage; `failed` — storage refused it; `idle` — nothing typed yet. */
  let draft = $state<'idle' | 'saved' | 'failed'>('idle')
  let editor = $state<ReturnType<typeof CodeEditor> | null>(null)
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function store(value: string, under: ContestLanguage | null = language): void {
    if (!under) return
    draft = writeStored(draftKey(contestId, problem.id, under), value) ? (value ? 'saved' : 'idle') : 'failed'
  }

  function edited(value: string): void {
    text = value
    if (saveTimer) clearTimeout(saveTimer)
    // A keystroke is not a write: storage is synchronous, and a page of code
    // written on every key would make the editor lag on a slow laptop.
    saveTimer = setTimeout(() => {
      saveTimer = null
      store(value)
    }, 400)
  }

  /** What the editor holds right now — the source of truth over `text`, which trails the debounce. */
  function current(): string {
    return editor?.current() ?? text
  }

  /** Flush the pending write for the language being left, so its draft is the text it had. */
  function flush(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    store(current())
  }

  $effect(() => () => {
    // Leaving the problem: the last keystrokes are not lost to the debounce.
    if (saveTimer) {
      clearTimeout(saveTimer)
      store(text)
    }
  })

  function switchLanguage(next: ContestLanguage): void {
    if (next === language) return
    flush()
    const own = readStored(draftKey(contestId, problem.id, next))
    language = next
    writeStored(languageKey(contestId, problem.id), next)
    writeStored(languageKey(contestId), next)
    if (own !== null && own !== '') {
      text = own
      editor?.load(own)
      draft = 'saved'
    } else {
      // No draft in that language: the text goes with the switch.
      store(text, next)
    }
  }

  /* ------------------------------------------------------------- the file */

  let picker = $state<HTMLInputElement | null>(null)
  let dragging = $state(false)

  async function take(file: File): Promise<void> {
    const choice = fileChoice(file, languages, SOURCE_BYTES)
    if ('refusal' in choice) {
      onrefuse(choice.refusal)
      return
    }
    let content: string
    try {
      content = await file.text()
    } catch {
      onrefuse(tr('contests.p.fileUnreadable'))
      return
    }
    onrefuse(null)
    if (choice.language !== language) {
      flush()
      language = choice.language
      writeStored(languageKey(contestId, problem.id), choice.language)
      writeStored(languageKey(contestId), choice.language)
    }
    text = content
    editor?.load(content)
    store(content)
    if (phone) sheet = true
    editor?.focus()
  }

  function picked(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    // Reset, so that picking the same file again after an edit still reads it.
    input.value = ''
    if (file) void take(file)
  }

  const carriesFiles = (event: DragEvent): boolean => [...(event.dataTransfer?.types ?? [])].includes('Files')

  function over(event: DragEvent): void {
    if (!carriesFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    dragging = true
  }

  function dropped(event: DragEvent): void {
    if (!carriesFiles(event)) return
    // Before CodeMirror: it would insert the file at the cursor instead of replacing the text.
    event.preventDefault()
    event.stopPropagation()
    dragging = false
    const file = event.dataTransfer?.files?.[0]
    if (file) void take(file)
  }

  function left(event: DragEvent): void {
    const into = event.relatedTarget as Node | null
    if (into && (event.currentTarget as HTMLElement).contains(into)) return
    dragging = false
  }

  /* ------------------------------------------------------------- sending */

  const open = $derived(accepting === 'open' || accepting === 'late')
  const bytes = $derived(sourceBytes(text))
  const tooBig = $derived(bytes > SOURCE_BYTES)
  const spent = $derived(problem.mine?.attemptsLeft === 0)
  const canSend = $derived(
    joined && open && !sending && !spent && !tooBig && chosen?.available === true && text.trim() !== '',
  )
  const shortcut = typeof navigator === 'undefined' ? '⌘ ↵' : sendShortcut(navigator.platform || navigator.userAgent)

  function send(): void {
    const source = current()
    if (!joined || !open || sending || spent || !language || chosen?.available !== true) return
    if (!source.trim() || sourceBytes(source) > SOURCE_BYTES) return
    if (saveTimer) flush()
    onsend(language, source)
  }

  /* ---------------------------------------------------------------- phone */

  /** The phone's editor sheet (K5) is open. */
  let sheet = $state(false)
  let sheetBox = $state<HTMLElement | null>(null)
  $effect(() => {
    if (!sheet || !sheetBox) return
    const box = sheetBox
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') sheet = false
    }
    box.addEventListener('keydown', close)
    return () => box.removeEventListener('keydown', close)
  })
</script>

{#snippet languagePicker()}
  <label class="flex items-center">
    <span class="sr-only">{tr('contests.p.language')}</span>
    <select
      class="max-w-[220px] border border-line bg-canvas py-[5px] pl-2.5 pr-7 font-mono text-[13px] font-semibold leading-4 text-ink"
      value={language ?? ''}
      onchange={(event) => switchLanguage((event.currentTarget as HTMLSelectElement).value as ContestLanguage)}
    >
      {#each languages as option (option.id)}
        <option value={option.id} disabled={!option.available}>
          {option.available ? option.label : tr('contests.p.languageUnavailable', { language: option.label })}
        </option>
      {/each}
    </select>
  </label>
{/snippet}

{#snippet draftNote()}
  {#if draft === 'saved' && text}
    <span class="text-micro leading-4 text-muted" role="status">{tr('contests.p.draftSaved')}</span>
  {:else if draft === 'failed'}
    <span class="text-micro leading-4 text-warning" role="status">{tr('contests.p.draftNotSaved')}</span>
  {/if}
{/snippet}

{#snippet notes()}
  {#if chosen && !chosen.available}
    <p class="text-micro leading-[18px] text-warning">{tr('contests.p.languageMissing', { language: chosen.label })}</p>
  {/if}
  {#if tooBig}
    <p class="text-micro leading-[18px] text-danger">{tr('contests.p.sourceTooBig', { size: Math.round(SOURCE_BYTES / 1024) })}</p>
  {/if}
  {#if refusal}
    <p class="text-micro leading-[18px] text-danger" role="alert">{refusal}</p>
  {/if}
  {#if joined && open && problem.mine?.attemptsLeft !== null && problem.mine?.attemptsLeft !== undefined}
    <p class="text-micro leading-[18px] {spent ? 'text-danger' : 'text-muted'}">
      {spent ? tr('contests.p.attemptsSpent') : tr('contests.p.attemptsLeft', { count: problem.mine.attemptsLeft })}
    </p>
  {/if}
  {#if accepting === 'late'}
    <p class="text-micro leading-[18px] text-muted">{tr('contests.p.upsolvingNote')}</p>
  {/if}
{/snippet}

{#snippet sendRow()}
  {#if !joined && join}
    {@render join()}
  {:else if accepting === 'closed' || accepting === 'not_open'}
    <p class="border-t border-line pt-3 text-ui text-muted">
      {tr(accepting === 'closed' ? 'contests.p.closedSend' : 'contests.p.notOpenSend')}
    </p>
  {:else}
    <div class="flex items-center justify-between gap-4">
      {#if !phone}
        <p class="min-w-0 text-2xs leading-[18px] text-muted">
          {tr('contests.p.dropBefore')}
          <span class="font-mono text-[12px] text-ink">.py</span>,
          <span class="font-mono text-[12px] text-ink">.cpp</span>,
          <span class="font-mono text-[12px] text-ink">.c</span>
          {tr('contests.p.dropAfter')} ·
          <button class="text-accent-text hover:underline" type="button" onclick={() => picker?.click()}>
            {tr('contests.p.pickFile')}
          </button>
        </p>
      {/if}
      <div class="flex shrink-0 items-center gap-3 {phone ? 'w-full justify-end' : ''}">
        <span class="font-mono text-[12px] leading-4 text-faint" aria-hidden="true">{shortcut}</span>
        <button
          class="bg-primary px-[26px] py-3 text-micro font-black uppercase leading-4 tracking-label text-primary-ink hover:brightness-110 disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted disabled:hover:brightness-100"
          type="button"
          disabled={!canSend}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          onclick={send}
        >
          {sending ? tr('contests.p.sending') : tr('contests.p.send')}
        </button>
      </div>
    </div>
  {/if}
{/snippet}

<input
  bind:this={picker}
  class="hidden"
  type="file"
  accept={SOURCE_ACCEPT}
  tabindex="-1"
  aria-hidden="true"
  onchange={picked}
/>

{#if phone}
  <!-- K5: the editor folded behind two buttons at the bottom of the screen. -->
  <div class="sticky bottom-0 z-20 flex gap-2 border-t border-line bg-canvas px-4 py-3">
    <button
      class="flex-1 border border-primary py-[13px] text-micro font-black uppercase leading-4 tracking-label text-primary"
      type="button"
      onclick={() => (sheet = true)}
    >
      {tr('contests.p.editor')}
    </button>
    <button
      class="flex-1 bg-primary py-[13px] text-micro font-black uppercase leading-4 tracking-label text-primary-ink"
      type="button"
      onclick={() => picker?.click()}
    >
      {tr('contests.p.file')}
    </button>
  </div>
  {#if !sheet && (refusal || tooBig)}
    <div class="px-4 pb-3">{@render notes()}</div>
  {/if}
  {#if sheet}
    <div
      bind:this={sheetBox}
      class="competition-ui fixed inset-0 z-40 flex flex-col gap-3 overflow-y-auto bg-canvas px-4 py-3"
      role="dialog"
      aria-modal="true"
      aria-label={tr('contests.p.editorLabel', { letter: problem.letter })}
    >
      <div class="flex items-center justify-between gap-3 border-b border-ink pb-2.5">
        <span class="text-micro font-black uppercase leading-5 tracking-label text-muted">
          {tr('contests.p.solution')} · {problem.letter}
        </span>
        <button class="text-2xs text-accent-text" type="button" onclick={() => (sheet = false)}>
          {tr('contests.p.closeEditor')}
        </button>
      </div>
      <div class="flex items-center justify-between gap-3">
        {@render draftNote()}
        {@render languagePicker()}
      </div>
      {#if language}
        <CodeEditor
          bind:this={editor}
          initial={text}
          {language}
          label={tr('contests.p.editorLabel', { letter: problem.letter })}
          placeholder={tr('contests.p.editorPlaceholder')}
          onchange={edited}
          onsubmit={send}
          height="min(60vh, 520px)"
        />
      {/if}
      {@render notes()}
      {@render sendRow()}
    </div>
  {/if}
{:else}
  <section
    class="relative flex flex-col gap-3.5"
    aria-label={tr('contests.p.editorLabel', { letter: problem.letter })}
    ondragovercapture={over}
    ondragentercapture={over}
    ondragleave={left}
    ondropcapture={dropped}
  >
    <div class="flex items-center justify-between gap-3 border-b border-ink pb-2.5">
      <h2 class="text-micro font-black uppercase leading-5 tracking-label text-muted">{tr('contests.p.solution')}</h2>
      <div class="flex items-center gap-3.5">
        {@render draftNote()}
        {@render languagePicker()}
      </div>
    </div>
    <div class="relative">
      {#if language}
        <CodeEditor
          bind:this={editor}
          initial={text}
          {language}
          label={tr('contests.p.editorLabel', { letter: problem.letter })}
          placeholder={tr('contests.p.editorPlaceholder')}
          onchange={edited}
          onsubmit={send}
        />
      {/if}
      {#if dragging}
        <div
          class="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-accent bg-canvas/90 px-6 text-center text-ui font-bold text-accent-text"
        >
          {tr('contests.p.dropHere')}
        </div>
      {/if}
    </div>
    {@render sendRow()}
    {@render notes()}
  </section>
{/if}

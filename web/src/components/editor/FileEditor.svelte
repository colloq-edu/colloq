<script lang="ts" module>
  import { tr, getLocale } from '@shared/i18n'
  import { editorPhrases } from '@/lib/editor-locale'
  /*
   * Редактор файла — тот же CodeMirror, что и в ячейках, собранный по-другому.
   *
   * У ячейки нет высоты: она ровно такая, как её текст, а прокручивается
   * страница. У файла высота есть — он занимает центр целиком и прокручивается
   * сам, — и отсюда все различия: свой скроллер, номера строк, поиск и то, что
   * клавиши тут не про соседнюю ячейку, а про сам файл.
   *
   * Грамматика грузится отдельным куском на язык, а не все сразу: комната, где
   * открыли один .py, не платит за разбор YAML и HTML. Ядро — общее с
   * ячейками, и Vite складывает его в один кусок на обоих.
   */
  import type { Highlight } from '@shared/paths'

  async function importCore() {
    const [autocomplete, commands, language, search, state, view, collab, theme] =
      await Promise.all([
        import('@codemirror/autocomplete').then(
          ({ autocompletion, closeBrackets, closeBracketsKeymap }) => ({
            autocompletion,
            closeBrackets,
            closeBracketsKeymap,
          }),
        ),
        import('@codemirror/commands').then(({ defaultKeymap, indentLess, indentMore }) => ({
          defaultKeymap,
          indentLess,
          indentMore,
        })),
        import('@codemirror/language').then(
          ({ bracketMatching, foldGutter, indentOnInput, indentUnit }) => ({
            bracketMatching,
            foldGutter,
            indentOnInput,
            indentUnit,
          }),
        ),
        import('@codemirror/search').then(({ highlightSelectionMatches, search, searchKeymap, closeSearchPanel, openSearchPanel, searchPanelOpen }) => ({
          highlightSelectionMatches,
          closeSearchPanel, openSearchPanel, searchPanelOpen,
          search,
          searchKeymap,
        })),
        import('@codemirror/state').then(({ Compartment, EditorSelection, EditorState, Prec }) => ({
          Compartment,
          EditorSelection,
          EditorState,
          Prec,
        })),
        import('@codemirror/view').then(
          ({ EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers }) => ({
            EditorView,
            highlightActiveLine,
            highlightActiveLineGutter,
            keymap,
            lineNumbers,
          }),
        ),
        import('y-codemirror.next').then(({ yCollab }) => ({ yCollab })),
        import('./editor-theme').then(({ fileTheme }) => ({ fileTheme })),
      ])
    return { autocomplete, commands, language, search, state, view, collab, theme }
  }

  type Core = Awaited<ReturnType<typeof importCore>>

  /** Обе стороны «можно ли печатать» — одним куском, чтобы их нельзя было развести. */
  function writableExtensions(cm: Core, editable: boolean) {
    return [cm.state.EditorState.readOnly.of(!editable), cm.view.EditorView.editable.of(editable)]
  }

  let coreInFlight: Promise<Core> | null = null
  function loadCore(): Promise<Core> {
    return (coreInFlight ??= importCore())
  }

  /**
   * Грамматика для языка — или ничего.
   *
   * JSON и YAML разбираются своими грамматиками, а не JavaScript «примерно
   * похоже»: в тетради `.ipynb` кавычки внутри строк и запятые в конце — ровно
   * то, ради чего в неё вообще заглядывают руками.
   */
  const grammars: Record<Highlight, () => Promise<{ extension: unknown }>> = {
    python: () => import('@codemirror/lang-python').then(({ python }) => python()),
    markdown: () => import('@codemirror/lang-markdown').then(({ markdown }) => markdown()),
    json: () => import('@codemirror/lang-json').then(({ json }) => json()),
    yaml: () => import('@codemirror/lang-yaml').then(({ yaml }) => yaml()),
    javascript: () => import('@codemirror/lang-javascript').then(({ javascript }) => javascript()),
    css: () => import('@codemirror/lang-css').then(({ css }) => css()),
    html: () => import('@codemirror/lang-html').then(({ html }) => html()),
  }

  const grammarCache = new Map<Highlight, Promise<{ extension: unknown }>>()
  function loadGrammar(name: Highlight | null): Promise<{ extension: unknown } | null> {
    if (!name) return Promise.resolve(null)
    const cached = grammarCache.get(name)
    if (cached) return cached
    const made = grammars[name]()
    grammarCache.set(name, made)
    return made
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import type { EditorView } from '@codemirror/view'
  import type { FileDoc } from '@/lib/filedoc.svelte'
  import { baseOf, highlightFor } from '@shared/paths'
  import { INDENT, tabKey } from '@/lib/indent'
  import { getSessionState } from '@/lib/session.svelte'

  interface Props {
    file: FileDoc
    /** Правит ли этот человек, или только читает. */
    readOnly: boolean
    /** Запустить файл — Cmd+Enter. Ничего, если файл нечем запускать. */
    onrun?: (() => void) | null
  }

  let { file, readOnly, onrun }: Props = $props()

  const session = getSessionState()

  let host = $state<HTMLDivElement | null>(null)
  let ready = $state(false)

  /*
   * Кто здесь я — для чужих курсоров в этом файле.
   *
   * Присутствие файла своё, отдельное от комнатного: в нём живут курсоры внутри
   * текста, и до комнаты они не доходят вовсе. Имя и цвет берутся те же самые,
   * иначе один человек оказался бы двумя разными людьми в двух местах экрана.
   */
  $effect(() => {
    const me = session.me
    file.setUser({
      id: me.id,
      name: me.name,
      avatar: me.avatar,
      color: me.color,
      role: me.role,
    })
  })

  /*
   * Обработчики живут в держателе, а не читаются раскладкой напрямую: иначе
   * редактор оказался бы зависимым от них, и пересборка на каждое нажатие
   * родителя выбрасывала бы курсор и историю отмен.
   */
  const handlers: { onrun?: (() => void) | null } = {}
  $effect(() => {
    handlers.onrun = onrun
  })

  let view: EditorView | null = null
  /**
   * Переключить правило в живом редакторе. `null`, пока редактора нет.
   *
   * `$state.raw`, потому что второй эффект должен проснуться и когда редактор
   * построился заново (другой файл), а не только когда правило поменялось.
   */
  let setWritable = $state.raw<((editable: boolean) => void) | null>(null)
  /** Что стоит в живом редакторе сейчас — чтобы не переконфигурировать впустую. */
  let writableNow = true
  let setLabels = $state.raw<(() => void) | null>(null)

  $effect(() => {
    const parent = host
    const doc = file
    /*
     * `readOnly` здесь НЕ отслеживается, и это несущее решение.
     *
     * Пока отслеживался, преподаватель, поменявший правило `files` посреди
     * пары, разбирал редактор у всех: `destroy` уносит сфокусированный
     * `.cm-content` вместе с курсором, выделением и прокруткой, и человек,
     * писавший в файл, оказывался в никуда прокрученном чужом тексте. Теперь
     * правило живёт в отсеке и меняется на месте — см. эффект ниже; так же
     * сделано в ячейках (CodeEditor.svelte).
     */
    const editable = untrack(() => !readOnly)
    if (!parent) return

    let disposed = false
    let made: EditorView | null = null

    void Promise.all([loadCore(), loadGrammar(highlightFor(doc.path))]).then(([cm, grammar]) => {
      if (disposed) return
      const { autocompletion, closeBrackets, closeBracketsKeymap } = cm.autocomplete
      const { bracketMatching, foldGutter, indentOnInput, indentUnit } = cm.language
      const { highlightSelectionMatches, search, searchKeymap } = cm.search
      const { EditorState, Prec } = cm.state
      const { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } =
        cm.view

      const fileKeys = Prec.highest(
        keymap.of([
          {
            /*
             * Ctrl+S ничего не сохраняет — файл и так лежит на диске через
             * секунду после последнего нажатия. Перехвачен ради того, чтобы не
             * открылось окно «сохранить страницу»: человек, нажавший его по
             * привычке, не должен получить в ответ диалог браузера.
             */
            key: 'Mod-s',
            preventDefault: true,
            run: () => true,
          },
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              if (!handlers.onrun) return false
              handlers.onrun()
              return true
            },
          },
        ]),
      )

      const writable = new cm.state.Compartment()
      const localeSlot = new cm.state.Compartment()
      made = new EditorView({
        state: EditorState.create({
          doc: doc.text.toString(),
          extensions: [
            localeSlot.of(EditorState.phrases.of(editorPhrases())),
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            foldGutter(),
            bracketMatching(),
            closeBrackets(),
            indentOnInput(),
            // Четыре пробела: файлы на семинаре — это Python, а Python в этом
            // продукте пишут в ячейках, где отступ уже такой (lib/indent.ts).
            indentUnit.of(INDENT),
            autocompletion({ activateOnTyping: true, icons: false }),
            highlightSelectionMatches(),
            search({ top: true }),
            EditorView.lineWrapping,
            writable.of(writableExtensions(cm, editable)),
            cm.theme.fileTheme,
            grammar ? (grammar.extension as never) : [],
            // Общий текст — источник правды; своей истории у редактора нет,
            // Mod-Z принадлежит общему UndoManager.
            cm.collab.yCollab(doc.text, doc.awareness, { undoManager: doc.undoManager }),
            fileKeys,
            keymap.of([...closeBracketsKeymap, ...searchKeymap, ...cm.commands.defaultKeymap]),
            /*
             * Tab — отступ, а не переход по фокусу.
             *
             * Мягкий: пробелы встают В КУРСОР, до следующей отметки, а строки
             * целиком двигают выделение и Shift-Tab. Правило общее с ячейкой —
             * lib/indent.ts, там же доводы.
             *
             * Стоит последним и потому проигрывает всем, кто уже занял Tab, —
             * подсказчику в первую очередь. Ценой ловушки для клавиатуры: выйти
             * из редактора Tab'ом нельзя, для этого есть Escape. Для поля, в
             * котором пишут отступами, это правильный размен.
             */
            keymap.of([
              tabKey({
                EditorSelection: cm.state.EditorSelection,
                indentMore: cm.commands.indentMore,
                indentLess: cm.commands.indentLess,
              }),
            ]),
          ],
        }),
        parent,
      })
      view = made
      const built = made
      setLabels = () => {
        const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const field = focused instanceof HTMLInputElement && focused.closest('.cm-search') ? focused : null
        const name = field?.name
        const start = field?.selectionStart ?? null
        const end = field?.selectionEnd ?? null
        const open = cm.search.searchPanelOpen(built.state)
        built.dispatch({ effects: localeSlot.reconfigure(EditorState.phrases.of(editorPhrases())) })
        // CodeMirror reads panel phrases on creation. Its search query lives in
        // editor state, so renewing just this panel preserves both query and editor.
        if (open) {
          cm.search.closeSearchPanel(built)
          cm.search.openSearchPanel(built)
          const next = name ? built.dom.querySelector<HTMLInputElement>(`.cm-search input[name="${name}"]`) : null
          if (next) {
            next.focus()
            if (start !== null && end !== null) next.setSelectionRange(start, end)
          } else focused?.focus()
        }
      }
      writableNow = editable
      setWritable = (next) =>
        built.dispatch({ effects: writable.reconfigure(writableExtensions(cm, next)) })
      ready = true
    })

    return () => {
      disposed = true
      setWritable = null
      setLabels = null
      made?.destroy()
      if (view === made) view = null
      ready = false
    }
  })

  /*
   * Правило `files` меняется посреди пары, и редактор его переживает: меняется
   * один отсек, а фокус, курсор и прокрутка остаются на месте. Строится
   * редактор уже с верным значением, так что первый прогон — холостой.
   */
  $effect(() => {
    getLocale()
    setLabels?.()
  })

  $effect(() => {
    const apply = setWritable
    const editable = !readOnly
    if (!apply || editable === writableNow) return
    writableNow = editable
    apply(editable)
  })

  /* Первый показ файла ставит курсор в редактор: человек его открыл, чтобы читать
     и править, и лишнее нажатие мышью здесь ничего не решает. */
  $effect(() => {
    if (!ready) return
    untrack(() => view)?.focus()
  })
</script>

<div class="flex min-h-0 flex-1 flex-col bg-canvas">
  {#if file.ready}
    <div bind:this={host} class="cm-file min-h-0 flex-1 overflow-hidden"></div>
  {:else}
    <!--
      До прихода текста редактора нет вовсе.

      Пустой документ до `sync` значит «ещё не прочитан», а не «файл пуст», —
      и редактор, показавший пустоту, приглашает в неё печатать, тем более что
      сам ставит в неё курсор. Напечатанное не пропадало, а сливалось с
      приехавшим файлом и через секунду уезжало на диск ко всей комнате.
    -->
    <div class="flex min-h-0 flex-1 items-center justify-center text-ui text-muted"> {tr('room.ui.107')} {baseOf(file.path)}…
    </div>
  {/if}
</div>

<style>
  /* Редактор занимает колонку целиком и прокручивается сам: страница под ним
     не двигается, потому что двигать её значило бы уводить из вида строку
     вкладок и панель файлов. */
  .cm-file :global(.cm-editor) {
    height: 100%;
  }
  .cm-file :global(.cm-scroller) {
    overflow: auto;
  }
</style>

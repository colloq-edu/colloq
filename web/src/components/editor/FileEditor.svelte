<script lang="ts" module>
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
        import('@codemirror/commands').then(({ defaultKeymap, indentWithTab }) => ({
          defaultKeymap,
          indentWithTab,
        })),
        import('@codemirror/language').then(
          ({ bracketMatching, foldGutter, indentOnInput, indentUnit }) => ({
            bracketMatching,
            foldGutter,
            indentOnInput,
            indentUnit,
          }),
        ),
        import('@codemirror/search').then(({ highlightSelectionMatches, search, searchKeymap }) => ({
          highlightSelectionMatches,
          search,
          searchKeymap,
        })),
        import('@codemirror/state').then(({ EditorState, Prec }) => ({ EditorState, Prec })),
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
  import { highlightFor } from '@shared/paths'
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

  $effect(() => {
    const parent = host
    const doc = file
    const editable = !readOnly
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

      made = new EditorView({
        state: EditorState.create({
          doc: doc.text.toString(),
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            foldGutter(),
            bracketMatching(),
            closeBrackets(),
            indentOnInput(),
            // Четыре пробела: файлы на семинаре — это Python, а Python в этом
            // продукте пишут в ячейках, где отступ уже такой.
            indentUnit.of('    '),
            autocompletion({ activateOnTyping: true, icons: false }),
            highlightSelectionMatches(),
            search({ top: true }),
            EditorView.lineWrapping,
            EditorState.readOnly.of(!editable),
            EditorView.editable.of(editable),
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
             * Стоит последним и потому проигрывает всем, кто уже занял Tab, —
             * подсказчику в первую очередь. Ценой ловушки для клавиатуры: выйти
             * из редактора Tab'ом нельзя, для этого есть Escape. Для поля, в
             * котором пишут отступами, это правильный размен, и он же сделан в
             * ячейках.
             */
            keymap.of([cm.commands.indentWithTab]),
          ],
        }),
        parent,
      })
      view = made
      ready = true
    })

    return () => {
      disposed = true
      made?.destroy()
      if (view === made) view = null
      ready = false
    }
  })

  /* Первый показ файла ставит курсор в редактор: человек его открыл, чтобы читать
     и править, и лишнее нажатие мышью здесь ничего не решает. */
  $effect(() => {
    if (!ready) return
    untrack(() => view)?.focus()
  })
</script>

<div class="flex min-h-0 flex-1 flex-col bg-canvas">
  <div bind:this={host} class="cm-file min-h-0 flex-1 overflow-hidden"></div>
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

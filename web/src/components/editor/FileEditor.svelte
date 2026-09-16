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
  import type { DecorationSet, EditorView } from '@codemirror/view'
  import { questionAt } from '@shared/python-defs'
  import { isJumpClick } from '@/lib/utils'

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
        import('@codemirror/state').then(
          ({ Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField }) => ({
            Compartment,
            EditorSelection,
            EditorState,
            Prec,
            StateEffect,
            StateField,
          }),
        ),
        import('@codemirror/view').then(
          ({
            Decoration,
            EditorView,
            highlightActiveLine,
            highlightActiveLineGutter,
            keymap,
            lineNumbers,
            ViewPlugin,
          }) => ({
            Decoration,
            EditorView,
            highlightActiveLine,
            highlightActiveLineGutter,
            keymap,
            lineNumbers,
            ViewPlugin,
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

  /** Сколько горит полоса под строкой, к которой привёл переход. */
  const LANDED_MS = 2000

  /**
   * Номер последнего применённого приземления — на весь модуль, а не на экземпляр.
   *
   * SessionScreen держит этот редактор под `{#key activePath}`: уход на соседнюю
   * вкладку и возврат — это НОВЫЙ CodeMirror и новый прогон эффекта, а метка в
   * lib/goto.svelte.ts всё ещё лежит и всё ещё про этот файл (она состояние, а
   * не событие, — почему, написано там же). Счётчик, живущий в экземпляре,
   * обнулялся бы вместе с ним, и каждое возвращение на вкладку заново уносило
   * бы каретку к определению — хоть через час после самого перехода.
   */
  let appliedSeq = 0

  /**
   * Переход к определению: подчёркивание под зажатым модификатором и сам жест.
   *
   * Вторая копия того, что стоит в ячейке (notebook/CodeEditor.svelte), и по
   * той же причине, по которой копией живёт весь этот редактор: набор
   * расширений у файла свой. Общее — там, где оно и должно быть: разбор в
   * shared/python-defs.ts, ответ на «куда вести» на сервере, а решение, что
   * делать с ответом, — в lib/goto.svelte.ts.
   *
   * Ставится ТОЛЬКО на Python (см. место сборки): `questionAt` разбирает
   * Python, и подчёркнутое имя в YAML обещало бы переход, которого не будет.
   */
  function gotoGesture(cm: Core, jump: (code: string, cursor: number) => void) {
    const { Decoration, ViewPlugin } = cm.view
    const { Prec, StateEffect, StateField } = cm.state

    const mark = Decoration.mark({ class: 'cm-goto' })
    const setGoto = StateEffect.define<{ from: number; to: number } | null>()
    const underline = StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update(deco, tr) {
        // Звено зовётся `sent`, а не `effect`: svelte2tsx роняет разбор ВСЕГО
        // файла на локальном имени `effect` рядом с рунами (проверено —
        // 34 ошибки на пустом месте, начиная с `of` в этой строке).
        for (const sent of tr.effects) {
          if (sent.is(setGoto)) {
            const at = sent.value
            return at ? Decoration.set([mark.range(at.from, at.to)]) : Decoration.none
          }
        }
        // Текст поехал под указателем — сосед печатает выше по файлу, и
        // подчёркнуто уже не то имя. Следующее движение мыши поставит заново.
        return tr.docChanged ? Decoration.none : deco
      },
      provide: (self) => cm.view.EditorView.decorations.from(self),
    })

    /*
     * Текст файла целиком — но не на каждое движение мыши.
     *
     * `questionAt` читает исходник от начала: состояние тройных кавычек к
     * щёлкнутой строке иначе не узнать. В редактор пускают файлы до 1,5 МБ
     * (server/src/workspace.ts · MAX_TEXT_BYTES), и `doc.toString()` на каждый
     * пиксель — это мегабайт мусора в секунду. Документ CodeMirror неизменяем,
     * значит его можно сверить по ссылке и не собирать строку заново.
     */
    let lastDoc: unknown = null
    let lastText = ''
    const textOf = (view: EditorView): string => {
      if (view.state.doc !== lastDoc) {
        lastDoc = view.state.doc
        lastText = view.state.doc.toString()
      }
      return lastText
    }

    /** Что подчёркнуто прямо сейчас — чтобы не слать кадр на каждый пиксель. */
    const shown = (view: EditorView): { from: number; to: number } | null => {
      const at = view.state.field(underline, false)?.iter()
      return at?.value ? { from: at.from, to: at.to } : null
    }

    const put = (view: EditorView, at: { from: number; to: number } | null): void => {
      const now = shown(view)
      if (!now && !at) return
      if (now && at && now.from === at.from && now.to === at.to) return
      view.dispatch({ effects: setGoto.of(at) })
    }

    const nameAt = (view: EditorView, event: MouseEvent) => {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos === null) return null
      const question = questionAt(textOf(view), pos)
      return question ? { from: question.from, to: question.to, pos } : null
    }

    const handlers = cm.view.EditorView.domEventHandlers({
      mousemove(event, view) {
        /*
         * Разбор — только пока модификатор зажат, и это не экономия ради
         * экономии: `questionAt` на полуторамегабайтном файле стоит миллисекунд,
         * а движений мыши в секунду бывает сотня. Под зажатой клавишей их
         * считанные единицы, да и кадр уходит только когда имя правда сменилось.
         */
        if (!isJumpClick(event)) {
          put(view, null)
          return false
        }
        put(view, nameAt(view, event))
        return false
      },
      mouseleave(_event, view) {
        put(view, null)
        return false
      },
      keyup(_event, view) {
        // Модификатор отпустили — подчёркивания быть не должно, даже если мышь
        // с тех пор не двигалась.
        put(view, null)
        return false
      },
      mousedown(event, view) {
        if (event.button !== 0 || !isJumpClick(event)) return false
        const found = nameAt(view, event)
        // Под указателем не имя — щелчок остаётся обычным щелчком.
        if (!found) return false
        /*
         * Своё же поведение и перехватываем: без этого CodeMirror поставит по
         * щелчку каретку, и человек, вернувшийся назад, найдёт её не там, где
         * оставил. Возврат `true` говорит редактору то же самое.
         */
        event.preventDefault()
        put(view, null)
        jump(textOf(view), found.pos)
        return true
      },
    })

    /*
     * Cmd+Tab уносит `keyup` с собой: модификатор отпускают уже в другом окне,
     * и подчёркивание осталось бы висеть до следующего движения мыши — а
     * вернувшийся человек щёлкнул бы по нему, ожидая обычного щелчка. Поэтому
     * гасим ещё и по уходу окна из фокуса и по уходу вкладки.
     */
    const watch = ViewPlugin.fromClass(
      class {
        view: EditorView
        constructor(view: EditorView) {
          this.view = view
          window.addEventListener('blur', this.drop)
          document.addEventListener('visibilitychange', this.drop)
        }
        drop = () => {
          put(this.view, null)
        }
        destroy() {
          window.removeEventListener('blur', this.drop)
          document.removeEventListener('visibilitychange', this.drop)
        }
      },
    )

    return [underline, watch, Prec.highest(handlers)]
  }

  /**
   * Полоса под строкой, к которой привёл переход, — и то, чем её зажигают.
   *
   * Отдельная от подчёркивания вещь: подчёркивание — про «сюда можно уйти», а
   * это — про «вот куда я тебя привёл», и живёт оно секунды, а не пока держат
   * клавишу.
   */
  function landingMark(cm: Core) {
    const { Decoration } = cm.view
    const { StateEffect, StateField } = cm.state
    const show = StateEffect.define<number>()
    const hide = StateEffect.define<null>()
    const row = Decoration.line({ class: 'cm-landed' })
    const field = StateField.define<DecorationSet>({
      create: () => Decoration.none,
      update(deco, tr) {
        for (const sent of tr.effects) {
          if (sent.is(show)) {
            return Decoration.set([row.range(tr.state.doc.lineAt(sent.value).from)])
          }
          if (sent.is(hide)) return Decoration.none
        }
        /*
         * Первое же собственное движение каретки гасит полосу: она отвечает на
         * вопрос «куда меня привели», и после того, как человек поставил
         * каретку сам, остаётся непонятной полосой посреди кода. Кадр самого
         * приземления сюда не доходит — он несёт `show`, и цикл выше выходит
         * раньше, хотя каретку двигает тоже он.
         */
        if (deco.size && (tr.selection || tr.docChanged)) return Decoration.none
        return deco.map(tr.changes)
      },
      provide: (self) => cm.view.EditorView.decorations.from(self),
    })
    return { field, show, hide }
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import type { FileDoc } from '@/lib/filedoc.svelte'
  import { baseOf, highlightFor } from '@shared/paths'
  import { INDENT, tabKey } from '@/lib/indent'
  import { jumpToDefinition, landingInFile } from '@/lib/goto.svelte'
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
  /**
   * Поставить каретку туда, куда привёл переход, и подсветить строку.
   *
   * `null`, пока редактора нет вовсе, — и это не мелочь: до прихода текста
   * здесь стоит заглушка «читаем файл…», а метка перехода может лежать уже
   * сейчас. `$state.raw`, по тому же доводу, что и у соседей выше: эффект
   * приземления должен проснуться и когда редактор построился заново.
   */
  let landOn = $state.raw<((line: number, column: number) => void) | null>(null)

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
    /** Таймер, гасящий полосу приземления. Снимается вместе с редактором. */
    let fade: number | undefined

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

      /*
       * Переход к определению — только по Python.
       *
       * Язык здесь тот же, по которому выбрана грамматика: .py и .pyi. В
       * остальных файлах жеста нет вовсе — ни подчёркивания, ни перехвата
       * щелчка, — и Cmd+клик по .md остаётся обычным щелчком.
       */
      const goto =
        highlightFor(doc.path) === 'python'
          ? gotoGesture(cm, (code, cursor) => {
              void jumpToDefinition(session, code, cursor, { path: doc.path })
            })
          : []
      const landed = landingMark(cm)

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
            goto,
            landed.field,
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
      landOn = (line, column) => {
        const text = built.state.doc
        /*
         * Номер строки приехал от сервера и про ТОТ текст, который был у него
         * на руках: файл с тех пор мог укоротить сосед, правящий его рядом.
         * Промахнуться в конец файла честнее, чем уронить редактор исключением
         * на несуществующей строке.
         */
        const row = text.line(Math.min(Math.max(1, line), text.lines))
        const pos = Math.min(row.from + column, row.to)
        built.dispatch({
          selection: cm.state.EditorSelection.cursor(pos),
          /*
           * Везёт сам редактор, а не экран комнаты, и это ровно то, чем файл
           * отличается от ячейки: у него свой скроллер (`.cm-scroller` ниже),
           * снаружи его двигать нечем. Ячейку, наоборот, везёт тетрадь — см.
           * lib/goto.svelte.ts.
           */
          effects: [EditorView.scrollIntoView(pos, { y: 'center' }), landed.show.of(pos)],
        })
        built.focus()
        window.clearTimeout(fade)
        fade = window.setTimeout(
          () => built.dispatch({ effects: landed.hide.of(null) }),
          LANDED_MS,
        )
      }
      ready = true
    })

    return () => {
      disposed = true
      window.clearTimeout(fade)
      setWritable = null
      setLabels = null
      landOn = null
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

  /** Метка «сюда привёл переход» — или ничего. Живёт в lib/goto.svelte.ts. */
  const landing = $derived(landingInFile(file.path))

  /*
   * Приземление.
   *
   * Стоит ПОСЛЕ эффекта с фокусом нарочно: `view.focus()` возвращает браузер к
   * каретке, а в только что построенном редакторе она в начале файла, — и,
   * случись фокус вторым, он увёз бы экран от найденной строки обратно наверх.
   *
   * Ждёт `landOn`, а не `ready`: пока текст не приехал, вместо редактора стоит
   * заглушка, и приземляться попросту некуда. Метка это переживает — она
   * состояние, а не событие, и дождётся построенного редактора сама.
   */
  $effect(() => {
    const land = landOn
    const mark = landing
    if (!land || !mark || !file.ready) return
    if (mark.seq <= appliedSeq) return
    appliedSeq = mark.seq
    land(mark.line, mark.column)
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

  /*
   * Одежда перехода к определению — здесь, а не в теме.
   *
   * Тема файла (editor-theme.ts) собрана из общей одежды редактора и того, что
   * есть только у файла, и обе половины — общие с ячейкой. Эти два класса
   * ставит расширение, объявленное прямо в этом компоненте, и держать их в
   * третьем месте значило бы разводить жест и его вид по разным файлам.
   */
  .cm-file :global(.cm-goto) {
    text-decoration: underline;
    text-decoration-color: rgb(var(--accent-text));
    text-underline-offset: 3px;
    cursor: pointer;
  }
  /* Полоса перебивает фон активной строки: каретка после перехода стоит ровно
     на ней, и без `!important` видно было бы только обычную подсветку строки
     под курсором — тем же приёмом и по тому же поводу, что в editor-theme.ts. */
  .cm-file :global(.cm-landed) {
    background-color: rgb(var(--accent) / 0.14) !important;
    box-shadow: inset 2px 0 0 rgb(var(--accent-text));
  }
</style>

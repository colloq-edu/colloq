<script lang="ts" module>
  import { tr, getLocale } from '@shared/i18n'
  import { editorPhrases } from '@/lib/editor-locale'
  /*
   * CodeMirror, its two language modes and the Yjs binding are the largest
   * thing Colloq ships, and no screen before the notebook can use a line of it.
   * It is fetched the first time a cell mounts, never at app start, and one
   * shared promise means a notebook with forty cells still fetches it once.
   *
   * Every import narrows inside the .then PARAMETER rather than after the fact.
   * That is the only shape Rollup can follow into a dynamic namespace: hand it
   * the module object whole — and `.then((m) => m.EditorView)` counts as whole
   * — and every export of every package has to be assumed live, which measured
   * 28 KB of CodeMirror this editor never calls.
   */
  async function importCodeMirror() {
    const [autocomplete, commands, md, py, language, state, view, collab, theme] = await Promise.all(
      [
        import('@codemirror/autocomplete').then(
          ({
            acceptCompletion,
            autocompletion,
            closeBrackets,
            closeBracketsKeymap,
            completionStatus,
            startCompletion,
          }) => ({
            acceptCompletion,
            autocompletion,
            closeBrackets,
            closeBracketsKeymap,
            completionStatus,
            startCompletion,
          }),
        ),
        import('@codemirror/commands').then(({ defaultKeymap, indentLess, indentMore }) => ({
          defaultKeymap,
          indentLess,
          indentMore,
        })),
        import('@codemirror/lang-markdown').then(({ markdown }) => ({ markdown })),
        /*
         * Разбор текста самой ячейки — как запасной источник дополнения.
         *
         * `localCompletionSource` знает ровно одно: слова, которые в этой
         * ячейке уже написаны. Против ядра это ничто — оно знает настоящие
         * методы настоящего DataFrame, — но ядра может не быть вовсе (никто
         * ещё не нажимал «запустить»), оно может считать чужую ячейку и не
         * ответить, а правило комнаты может не дать спросить. Во всех трёх
         * случаях список из собственных слов лучше пустоты.
         */
        import('@codemirror/lang-python').then(({ localCompletionSource, python }) => ({
          localCompletionSource,
          python,
        })),
        import('@codemirror/language').then(({ bracketMatching, indentOnInput, indentUnit }) => ({
          bracketMatching,
          indentOnInput,
          indentUnit,
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
            closeHoverTooltips,
            Decoration,
            EditorView,
            highlightActiveLine,
            hoverTooltip,
            keymap,
            placeholder,
            ViewPlugin,
          }) => ({
            closeHoverTooltips,
            Decoration,
            EditorView,
            highlightActiveLine,
            hoverTooltip,
            keymap,
            placeholder,
            ViewPlugin,
          }),
        ),
        import('y-codemirror.next').then(({ yCollab }) => ({ yCollab })),
        import('./cm-theme').then(({ colloqTheme }) => ({ colloqTheme })),
      ],
    )
    return { autocomplete, commands, md, py, language, state, view, collab, theme }
  }

  type CodeMirror = Awaited<ReturnType<typeof importCodeMirror>>

  let inFlight: Promise<CodeMirror> | null = null

  function loadCodeMirror(): Promise<CodeMirror> {
    return (inFlight ??= importCodeMirror())
  }
</script>

<script lang="ts">
  import { flushSync, untrack } from 'svelte'
  import type * as Y from 'yjs'
  import type { Awareness } from 'y-protocols/awareness'
  import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
  import type { Compartment } from '@codemirror/state'
  import type { Decoration as Deco, DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
  import { questionAt, type Question } from '@shared/python-defs'
  import { INDENT, tabKey } from '@/lib/indent'
  import { isJumpClick } from '@/lib/utils'
  import { backspaceRemovesCell } from './cell-keys'
  import { changeFits } from './cell-paste'
  import { cellAwareness, type CellAwareness } from './cell-awareness'

  /**
   * Что ответило ядро на «что тут можно дописать».
   *
   * Форма нарочно повторяет кадр протокола (`complete:reply`), а не заводит
   * свою: между сокетом и редактором и так стоит один вызов, и лишний перевод
   * из одной записи в другую — лишнее место, где однажды потеряется `start`.
   */
  interface KernelCompletions {
    matches: Array<{ text: string; type?: string }>
    /** Границы куска, который замена заменяет собой, — знаками от начала кода. */
    start: number
    end: number
  }

  interface KernelSignature {
    found: boolean
    text?: string
  }

  interface Props {
    text: Y.Text
    awareness: Awareness
    /**
     * Чью каретку этот редактор рисует — имя ячейки, если он ячейкин.
     *
     * Без него в `yCollab` уходит присутствие комнаты целиком, и один чужой
     * курсор стоит транзакции в КАЖДОМ смонтированном редакторе с обходом всех
     * состояний (см. cell-awareness.ts). Свой лист консилиума и файл имени не
     * дают: у первого присутствие своё и пустое, у второго — своё на документ.
     */
    cellId?: string | null
    undoManager: Y.UndoManager
    language: 'python' | 'markdown'
    readOnly?: boolean
    autoFocus?: boolean
    onfocus?: () => void
    onrun?: () => void
    /** Run, then move on — Shift+Enter. See CellView.runAndStep. */
    onrunstep?: () => void
    onrunandadd?: () => void
    /**
     * Сдать написанное — ⌘⇧↵, и только оно.
     *
     * Стоит на листе консилиума: ⇧↵ там СЧИТАЕТ, как в любой тетради, а сдача
     * — движение, после которого текст уходит преподавателю и обратно уже не
     * берётся. Пальцам, привыкшим к «выполнить и дальше», оно не должно
     * попадаться по дороге, поэтому сочетание нарочно неудобное: три клавиши
     * против двух у запуска. Единственное, которое сдаёт.
     */
    onsubmit?: () => void
    onescape?: () => void
    ondeleteempty?: () => void
    onarrowout?: (direction: -1 | 1) => void
    /**
     * Потолок знаков, выше которого редактор не принимает ВСТАВКУ, — или null.
     *
     * Стоит на своём листе консилиума: снимок сверх `MAX_ATTEMPT_CHARS` сервер
     * не принимает, и вставка двенадцати тысяч знаков из IDE — одно движение,
     * после которого лист перестаёт уезжать. Набор руками потолок не
     * запрещает: про него говорит счётчик под листом, и человек сам решает,
     * что резать.
     */
    maxChars?: number | null
    /** Вставку не приняли: сколько знаков в ней было — для слов об отказе. */
    onoverflow?: (chars: number) => void
    placeholder?: string
    /**
     * Спросить у ядра, что дописать в этом месте кода, — или ничего.
     *
     * Прокинуто сюда вызовом, а не взято из глобального состояния комнаты, и
     * это несущее решение. Этот же компонент рисует лист консилиума и
     * черновик — тексты, которые в ядре комнаты не значат ничего, — и
     * редактор файлов (FileEditor) живёт вовсе без комнаты. Кто хочет
     * подсказок от ядра, тот их и передаёт; остальные молчат и получают
     * дополнение по словам самой ячейки.
     */
    complete?: ((code: string, cursor: number) => Promise<KernelCompletions | null>) | null
    /** Справка о том, что стоит под кареткой, — для подсказки над скобкой. */
    inspect?: ((code: string, cursor: number) => Promise<KernelSignature | null>) | null
    /**
     * Уйти туда, где это имя определено, — ⌘/Ctrl-клик по нему. Или ничего.
     *
     * Прокинуто вызовом по тому же доводу, что `complete` и `inspect`: искать
     * определение умеет сервер комнаты, а этим же компонентом нарисованы лист
     * консилиума, черновик и редактор файлов, где искать негде и не у кого. Кто
     * может увести — тот и передаёт; у остальных ⌘-клик остаётся тем, чем был у
     * CodeMirror, то есть второй кареткой.
     *
     * Ответа сюда не возвращают: кто спросил, тот и везёт экран к найденному
     * (lib/goto.svelte.ts), а обратно приезжает `mark`.
     */
    jump?: ((code: string, cursor: number) => void) | null
    /**
     * Куда привели: строка (с единицы), колонка (с нуля) и номер перехода.
     *
     * Состояние, а не событие, и это не вкусовщина: ячейку, к которой ведут,
     * тетрадь может ещё не построить — вместо далёких она держит заглушку
     * (Notebook.svelte · data-cell-deferred), — и событие, посланное такой
     * ячейке, слушать некому. Метка просто лежит, а редактор читает её, как
     * только построится сам.
     *
     * `seq` — почему это не просто пара чисел: второй переход НА ТУ ЖЕ строку
     * иначе не виден вовсе, а уйти, вернуться и щёлкнуть снова — обычное дело.
     */
    mark?: { line: number; column: number; seq: number } | null
    /**
     * What a screen reader announces on arriving here.
     *
     * CodeMirror's editable surface is a bare contenteditable: in the
     * accessibility tree it was the one interactive node on the whole screen
     * with no name at all, so somebody tabbing through a notebook was told
     * "edit text, multiline" thirty times with nothing to tell the cells apart.
     */
    label?: string
  }

  let {
    text,
    awareness,
    cellId = null,
    undoManager,
    language,
    readOnly = false,
    autoFocus = false,
    onfocus,
    onrun,
    onrunstep,
    onrunandadd,
    onsubmit,
    onescape,
    ondeleteempty,
    onarrowout,
    maxChars = null,
    onoverflow,
    complete = null,
    inspect = null,
    jump = null,
    mark = null,
    placeholder = '',
    label = '',
  }: Props = $props()

  let host = $state<HTMLDivElement | null>(null)

  /*
   * The name has to follow the cell as the notebook is reordered around it, and
   * rebuilding a CodeMirror to change one attribute would throw away focus, the
   * cursor and the undo history — so it is set on the node instead. The facet
   * above covers the first paint; this covers every move after it.
   */
  $effect(() => {
    const node = host?.querySelector('.cm-content')
    if (node && label) node.setAttribute('aria-label', label)
  })
  let ready = $state(false)
  /* Seeded here rather than left to the effect below: the shim has to be right
     in the very first render pass, not one flush later. The effect is what
     keeps it current afterwards, so the initial read is deliberately untracked. */
  let shimText = $state(untrack(() => text.toString()))

  const shimLines = $derived(shimText.split('\n'))

  /*
   * Callbacks are fresh closures on nearly every render of the parent. If the
   * keymap read them directly the editor would be a dependency of them, and
   * rebuilding CodeMirror mid-keystroke would throw away focus, the cursor and
   * any open completion. The keymap closes over this holder instead, and a
   * separate effect keeps the holder current.
   */
  const handlers: Pick<
    Props,
    | 'onfocus'
    | 'onrun'
    | 'onrunstep'
    | 'onrunandadd'
    | 'onsubmit'
    | 'onescape'
    | 'ondeleteempty'
    | 'onarrowout'
    | 'onoverflow'
    | 'complete'
    | 'inspect'
    | 'jump'
  > = {}

  $effect(() => {
    handlers.onfocus = onfocus
    handlers.onrun = onrun
    handlers.onrunstep = onrunstep
    handlers.onrunandadd = onrunandadd
    handlers.onsubmit = onsubmit
    handlers.onescape = onescape
    handlers.ondeleteempty = ondeleteempty
    handlers.onarrowout = onarrowout
    handlers.onoverflow = onoverflow
    handlers.complete = complete
    handlers.inspect = inspect
    handlers.jump = jump
  })

  function fire(callback: (() => void) | undefined): boolean {
    if (!callback) return false
    callback()
    return true
  }

  /**
   * Автоповтор Backspace — и почему он тут отдельным флагом.
   *
   * Биндинг `Backspace` срабатывает на каждом keydown, включая повторы при
   * удержании. Стоило документу опустеть — следующий повтор (через ~30 мс)
   * звал `ondeleteempty`, ячейка уходила из общей тетради, фокус синхронно
   * переезжал в предыдущую, и оставшиеся повторы принимались стирать ЕЁ хвост,
   * а опустошив — удаляли и её. Человек, зажавший Backspace, чтобы стереть
   * `print(x)`, терял одну-две чужие ячейки вместе с выводом и не понимал, что
   * случилось.
   *
   * Слушатель в фазе перехвата на обёртке: он приходит раньше обработчиков
   * CodeMirror на `.cm-content`, поэтому к моменту биндинга флаг уже верен, и
   * при этом ничего не надо знать о порядке расширений редактора.
   */
  let repeating = false

  interface ViewOptions {
    parent: HTMLElement
    ytext: Y.Text
    peers: Awareness | CellAwareness
    undo: Y.UndoManager
    lang: Props['language']
    editable: boolean
    hint: string
    /** Потолок знаков для вставки — или null, если его тут нет. */
    ceiling: number | null
    /** Отсек, через который правило edit меняют, не разбирая редактор. */
    hintSlot: Compartment
    localeSlot: Compartment
    writable: Compartment
    /** Поле подсветки «вот куда привели» и эффект, которым её ставят. */
    landing: ReturnType<typeof makeLanding>
  }

  /**
   * Чем jedi называет найденное — и чем это же называет CodeMirror.
   *
   * Два словаря, и переводить приходится вручную: ipykernel отдаёт слова
   * Python («instance», «statement», «param»), а значки и цвета в списке
   * нарисованы под словарь редактора. Незнакомое — «text»: безымянная строка
   * в списке лучше, чем список, который не построился из-за одного слова,
   * которого мы не предусмотрели.
   */
  const COMPLETION_TYPE: Record<string, string> = {
    function: 'function',
    method: 'function',
    class: 'class',
    module: 'namespace',
    instance: 'variable',
    statement: 'variable',
    param: 'variable',
    keyword: 'keyword',
  }

  /** Сколько строк справки показываем: сигнатура и начало docstring. */
  const SIGNATURE_LINES = 6
  /**
   * Сколько указатель должен постоять на имени, прежде чем спросить ядро.
   *
   * Треть секунды — это «человек остановился и смотрит», а не «мышь проехала
   * по строке». Без задержки один проход указателем вдоль `df.groupby('a').sum()`
   * стоил бы комнате пяти запросов к общему ядру подряд.
   */
  const HOVER_MS = 300
  /**
   * Сколько держится подсветка строки, на которую привёл переход.
   *
   * Две секунды — это «успел поднять глаза», а не «теперь тут всегда жёлтая
   * полоса»: метка отвечает на вопрос «куда меня привели» и после ответа
   * мешает читать. Столько же длится угасание в cm-theme.ts (`colloq-landed`),
   * и числа обязаны совпадать: здесь украшение снимается, там оно гаснет.
   */
  const LANDING_MS = 2000
  /**
   * Насколько правее конца строки указатель ещё считается стоящим НА строке.
   *
   * Полузнак с запасом: `posAtCoords` и так приводит указатель к ближайшей
   * позиции с точностью до половины знака, и допуск меньше гасил бы
   * подчёркивание на последней букве строки.
   */
  const PAST_LINE = 6

  /** Шапка справки: сигнатура и начало docstring, без пустых строк сверху. */
  function signatureHead(text: string): string {
    const lines = text.replace(/\r/g, '').split('\n')
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
    return lines.slice(0, SIGNATURE_LINES).join('\n').trimEnd()
  }

  /**
   * Имя под указателем — целиком, вместе с тем, чьё оно.
   *
   * Наведя на `head` в `df.head()`, человек спрашивает не про абстрактный
   * `head`, а про метод ЭТОГО DataFrame — и ядро ответит правильно только
   * если спросить его о `df.head`. Поэтому слово под указателем сначала
   * находится целиком, а потом влево дотягивается вся цепочка через точки.
   *
   * Скобки в середине цепочки (`df.groupby('a').sum`) намеренно не
   * разбираются: до них тут нет ни дерева разбора, ни нужды — вызов внутри
   * цепочки ядро всё равно выполнять не станет, и ответом был бы «не найдено».
   */
  function nameAround(line: string, at: number): { from: number; to: number } | null {
    const word = /[A-Za-z0-9_]/
    if (at > line.length) return null
    let to = at
    while (to < line.length && word.test(line[to])) to++
    let from = at
    while (from > 0 && word.test(line[from - 1])) from--
    // Указатель стоит не на слове, а на пробеле или скобке — спрашивать не о чем.
    if (from === to) return null
    const chain = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(line.slice(0, to))
    if (!chain) return null
    return { from: chain.index, to }
  }

  /**
   * Имя под экранной точкой — ровно то, о котором спросят сервер.
   *
   * Одно на два жеста, и это не экономия строк: подчёркивает и открывает один
   * и тот же ответ. Разойдись они — и однажды подчёркнутое имя не откроется, а
   * откроется соседнее, то есть человек уедет читать не тот код, на который
   * целился.
   *
   * Проверка на конец строки — про то, что `posAtCoords` подтягивает указатель,
   * ушедший ПРАВЕЕ текста, к последнему знаку строки: без неё пустое поле
   * справа от `import numpy as np` подчёркивало бы `np` на всю ширину ячейки.
   */
  function questionAtPoint(view: EditorView, x: number, y: number): Question | null {
    const pos = view.posAtCoords({ x, y })
    if (pos === null) return null
    const line = view.state.doc.lineAt(pos)
    if (pos === line.to) {
      const end = view.coordsAtPos(line.to)
      if (end && x > end.right + PAST_LINE) return null
    }
    return questionAt(view.state.doc.toString(), pos)
  }

  /**
   * Пока модификатор зажат, имя под указателем подчёркнуто, а указатель — рука.
   *
   * Разрешения при этом НЕ спрашиваем: подчёркивается ЛЮБОЕ имя, а есть ли за
   * ним определение, выясняет только клик. Довод замерен и записан рядом с
   * самим разбором (shared/python-defs.ts): тетрадь из восьмидесяти ячеек
   * разбирается 17 мс, и вешать эти миллисекунды на каждое движение мыши
   * нельзя — а спрашивать о том же сервер тем более. Цена честности —
   * подчёркнутое имя, которое иногда отвечает «не нашёл»; она дешевле, чем
   * редактор, спотыкающийся под указателем.
   *
   * Клавиши слушаются на `view.dom`, а не на окне, и это тоже размен: в тетради
   * сорок редакторов, и сорок слушателей keyup на окне — это сорок вызовов на
   * КАЖДОЕ нажатие при наборе. На своём узле обработчик просыпается только у
   * того редактора, в котором сейчас работают; остальным про модификатор
   * рассказывает движение мыши, у которого он записан в событии.
   *
   * `Decoration` приезжает в конструкторе, а не берётся из модуля: CodeMirror
   * тут грузится лениво, и на верхнем уровне файла его ещё нет.
   */
  class JumpHint {
    view: EditorView
    deco: typeof Deco
    /** Само подчёркивание — одно на редактор. */
    underline: Deco
    marks: DecorationSet
    /** Что подчёркнуто сейчас — чтобы не будить редактор одним и тем же. */
    at: { from: number; to: number } | null = null
    /** Где последний раз видели указатель; `null` — мыши тут нет. */
    x: number | null = null
    y = 0

    constructor(view: EditorView, deco: typeof Deco) {
      this.view = view
      this.deco = deco
      this.underline = deco.mark({ class: 'cm-goto' })
      this.marks = deco.none
      view.dom.addEventListener('mousemove', this.onMove)
      view.dom.addEventListener('mouseleave', this.onOff)
      view.dom.addEventListener('keydown', this.onKey)
      view.dom.addEventListener('keyup', this.onKey)
      /*
       * И третья причина снять подчёркивание — окно, у которого забрали фокус.
       * ⌘+Tab уносит keyup вместе с ним: клавишу отпускают уже в другом
       * приложении, сюда не приходит ни keyup, ни движение мыши, и
       * подчёркивание остаётся висеть навсегда — до следующего случайного
       * захода мышью в эту же ячейку. Тем же лечится удержание кнопки
       * перезапуска (Notebook.svelte · visibilitychange): вкладка, ушедшая в
       * фон, обязана отпустить то, что держала.
       */
      window.addEventListener('blur', this.onOff)
      document.addEventListener('visibilitychange', this.onOff)
    }

    /** Показать или снять подчёркивание — и разбудить редактор, если оно сменилось. */
    show(question: Question | null): void {
      const now = question ? { from: question.from, to: question.to } : null
      if (now?.from === this.at?.from && now?.to === this.at?.to) return
      this.at = now
      this.marks = now ? this.deco.set([this.underline.range(now.from, now.to)]) : this.deco.none
      /*
       * Пустая транзакция — единственный способ показать украшение, которое
       * плагин держит САМ: свои украшения редактор перечитывает только в такте
       * обновления, а такт заводит транзакция.
       *
       * Она поэтому и стоит за проверкой выше. Пока указатель едет вдоль одного
       * имени, не уходит ни одной: каждая будит и чужие каретки из
       * y-codemirror, которые пересчитываются на любое обновление вида.
       */
      this.view.dispatch({})
    }

    onMove = (event: MouseEvent): void => {
      this.x = event.clientX
      this.y = event.clientY
      const live = handlers.jump && isJumpClick(event)
      this.show(live ? questionAtPoint(this.view, event.clientX, event.clientY) : null)
    }

    onKey = (event: KeyboardEvent): void => {
      if (this.x === null) return
      const live = handlers.jump && isJumpClick(event)
      this.show(live ? questionAtPoint(this.view, this.x, this.y) : null)
    }

    /** Мышь ушла, окно потеряло фокус, вкладку убрали — держать нечего. */
    onOff = (): void => {
      this.x = null
      this.show(null)
    }

    update(update: ViewUpdate): void {
      // Текст поехал — границы имени больше не те. Снимаем молча, БЕЗ
      // транзакции: мы внутри такта обновления, и заводить отсюда ещё один
      // нельзя.
      if (update.docChanged && this.at) {
        this.at = null
        this.marks = this.deco.none
      }
    }

    destroy(): void {
      const dom = this.view.dom
      dom.removeEventListener('mousemove', this.onMove)
      dom.removeEventListener('mouseleave', this.onOff)
      dom.removeEventListener('keydown', this.onKey)
      dom.removeEventListener('keyup', this.onKey)
      window.removeEventListener('blur', this.onOff)
      document.removeEventListener('visibilitychange', this.onOff)
    }
  }

  /** Обе стороны «можно ли печатать» — одним куском, чтобы их нельзя было развести. */
  function writableExtensions(cm: CodeMirror, editable: boolean) {
    return [cm.state.EditorState.readOnly.of(!editable), cm.view.EditorView.editable.of(editable)]
  }

  /**
   * Подсветка строки, на которую привёл переход: поле состояния и эффект к нему.
   *
   * Поле хранит ПОЗИЦИЮ, а украшение считается из неё на месте. Готовый набор
   * украшений хранить нельзя: линейное украшение живёт только в начале строки,
   * а правка соседа выше по ячейке двигает под ним текст — перенесённая метка
   * оказалась бы посреди строки, где ей стоять негде. Позиция же переносится
   * и снова приводится к началу своей строки.
   */
  function makeLanding(cm: CodeMirror) {
    const { Decoration, EditorView } = cm.view
    const { StateEffect, StateField } = cm.state
    /** Куда привели — позиция в документе; `null` гасит подсветку. */
    const landed = StateEffect.define<number | null>()
    const row = Decoration.line({ class: 'cm-landed' })
    const field = StateField.define<number | null>({
      create: () => null,
      update(at, tr) {
        for (const effect of tr.effects) if (effect.is(landed)) return effect.value
        if (at === null) return null
        /*
         * Гаснет от первого же СОБСТВЕННОГО движения: человек поставил каретку
         * или начал печатать — и подсветка из «вот куда я тебя привёл»
         * превращается в непонятную полосу посреди кода. Набор сюда попадает
         * тоже: у транзакции набора селекция задана.
         *
         * Чужая правка в этой же ячейке подсветку НЕ гасит: позиция едет вместе
         * с текстом, и сосед, дописавший строку выше через секунду, не должен
         * стирать ответ на чужой вопрос.
         */
        if (tr.selection) return null
        return tr.changes.mapPos(at)
      },
      provide: (f) =>
        EditorView.decorations.compute([f], (state) => {
          const at = state.field(f)
          if (at === null) return Decoration.none
          return Decoration.set([row.range(state.doc.lineAt(at).from)])
        }),
    })
    return { landed, field }
  }

  function createView(cm: CodeMirror, options: ViewOptions): EditorView {
    const { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionStatus, startCompletion } =
      cm.autocomplete
    const { bracketMatching, indentOnInput, indentUnit } = cm.language
    const { EditorState, Prec } = cm.state
    const { Decoration, highlightActiveLine, keymap, placeholder: placeholderExt, ViewPlugin } = cm.view
    const { parent, ytext, peers, undo, lang, editable, hint, writable, ceiling, hintSlot, localeSlot, landing } = options

    /**
     * Дополнение глазами ядра комнаты.
     *
     * Спрашивается не на каждое нажатие, а там, где человек действительно
     * чего-то ждёт: после буквы или точки. Иначе `complete_request` уходил бы
     * и на пробел, и на скобку, и на перевод строки — по десятку в секунду на
     * каждого в комнате, в одно на всех ядро. `validFor` доканчивает начатое
     * здесь же, на клиенте: пока человек дописывает `he` к `head`, список
     * фильтруется на месте и ядро не спрашивается вовсе.
     */
    async function kernelCompletions(context: CompletionContext): Promise<CompletionResult | null> {
      const ask = handlers.complete
      // Ячейка, в которой не печатают, не дополняется: чужой лист под замком
      // и закончившееся занятие — это чтение, а не набор.
      if (!ask || context.state.readOnly) return null
      const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos)
      if (!context.explicit && !/[\w.]/.test(before)) return null
      const answer = await ask(context.state.doc.toString(), context.pos)
      if (!answer || answer.matches.length === 0) return null
      const from = Math.max(0, Math.min(answer.start, context.pos))
      /*
       * `df.head` или просто `head` — решает то, ОТКУДА ядро велело заменять.
       *
       * Ядра отвечают по-разному: одни возвращают имя целиком с приставкой,
       * другие — только хвост, и `cursor_start` у них при этом одинаково
       * стоит за точкой. Показать первое как есть значило бы нарисовать в
       * списке `df.head` и вставить в текст `df.df.head`.
       */
      const dotted = from > 0 && context.state.sliceDoc(from - 1, from) === '.'
      const options: Completion[] = []
      const seen = new Set<string>()
      for (const match of answer.matches) {
        const label =
          dotted && match.text.includes('.')
            ? match.text.slice(match.text.lastIndexOf('.') + 1)
            : match.text
        if (label === '' || seen.has(label)) continue
        seen.add(label)
        options.push({
          label,
          detail: match.type ?? undefined,
          type: match.type ? (COMPLETION_TYPE[match.type] ?? 'text') : 'text',
        })
      }
      if (options.length === 0) return null
      return { from, options, validFor: /^[\w]*$/ }
    }

    /* -------------------------------------- справка по наведению мыши */

    /**
     * Навёл на имя — увидел сигнатуру. И ничего на нажатие клавиши.
     *
     * Раньше подсказка выскакивала на набранную `(`. Это ошибка в самой
     * задумке: скобку печатают, ЗНАЯ, что пишут, и выехавшая в этот момент
     * панель закрывает собой строку, которую человек в эту секунду набирает.
     * Наведение — противоположный жест: его делают, когда чего-то НЕ знают, и
     * делают намеренно.
     *
     * `hoverTime` — та самая треть секунды, которая отличает «смотрю сюда» от
     * «веду мышь мимо»; закрывает подсказку сам CodeMirror, как только
     * указатель ушёл.
     */
    const signatureHover = cm.view.hoverTooltip(
      async (view, pos) => {
        const ask = handlers.inspect
        // В ячейке, которую не дают править, справки нет: чужой лист под
        // замком и закончившееся занятие — это чтение, и читать через них
        // состояние общего ядра нельзя (то же правило, что у дополнения).
        if (!ask || view.state.readOnly) return null
        const line = view.state.doc.lineAt(pos)
        const found = nameAround(line.text, pos - line.from)
        if (!found) return null
        const from = line.from + found.from
        const to = line.from + found.to
        /*
         * Каретка для ядра ставится в КОНЕЦ имени: `inspect_request` отвечает
         * о том, что стоит перед ней. Посреди слова он ответил бы о `he`.
         */
        const answer = await ask(view.state.doc.toString(), to)
        if (!answer?.found || !answer.text) return null
        const text = signatureHead(answer.text)
        if (text === '') return null
        return {
          pos: from,
          end: to,
          /*
           * ПОД строкой, а не над ней.
           *
           * Над строкой висит тулбар ячейки — «запустить», «остановить»,
           * «форматировать», — и подсказка, выехавшая вверх, закрывала его
           * собой ровно тогда, когда человек тянется к кнопке. Стопка слоёв
           * доводит то же правило до конца: у подсказки z-index ниже
           * тулбарного, так что даже снизу она не может его перекрыть (см.
           * cm-theme.ts · .cm-tooltip.cm-signature).
           */
          above: false,
          create: () => {
            const dom = document.createElement('div')
            dom.className = 'cm-signature'
            dom.textContent = text
            return { dom }
          },
        }
      },
      { hoverTime: HOVER_MS },
    )

    /* -------------------------------------- переход к определению */

    /**
     * ⌘/Ctrl-клик по имени — уйти туда, где оно определено.
     *
     * `Prec.highest`, чтобы опередить собственный mousedown CodeMirror: у него
     * клик с модификатором добавляет ВТОРУЮ каретку, и без старшинства жест
     * сначала рвал бы выделение надвое, а потом уводил из ячейки.
     *
     * Под указателем не имя — обработчик отказывается, и нажатие достаётся
     * редактору целиком: ⌘-клик по пустому месту по-прежнему ставит вторую
     * каретку, как ставил. Ровно так же он отказывается там, где уводить
     * некому (`jump` не передали): подчёркивания в такой ячейке нет, и обещать
     * клику нечего.
     *
     * Кареткой уезжает КОНЕЦ найденного звена, а не та позиция, куда попали
     * пикселем. Ответ от этого не меняется — `questionAt` из любой точки
     * внутри имени отвечает одно и то же, — зато сервер получает ровно то
     * имя, которое было подчёркнуто, а не то, во что округлится координата,
     * пока вопрос едет.
     */
    const jumpClick = Prec.highest(
      cm.view.EditorView.domEventHandlers({
        mousedown(event, view) {
          const go = handlers.jump
          // Только левая кнопка: ⌘ с правой на маке — это ещё и контекстное
          // меню, и уводить из ячейки вместе с ним нельзя.
          if (!go || event.button !== 0 || !isJumpClick(event)) return false
          const question = questionAtPoint(view, event.clientX, event.clientY)
          if (!question) return false
          event.preventDefault()
          go(view.state.doc.toString(), question.to)
          return true
        },
      }),
    )

    /*
     * Подчёркивание под зажатым модификатором держит `JumpHint` — он живёт на
     * верхнем уровне файла, потому что классу, объявленному внутри функции,
     * пришлось бы рождаться заново на каждую постройку редактора. Всё, что ему
     * нужно от лениво загруженного CodeMirror, он получает в конструкторе.
     */
    const jumpHint = ViewPlugin.define((view) => new JumpHint(view, Decoration), {
      decorations: (plugin) => plugin.marks,
    })

    /** Leave the cell only from its outer edge, and never out from under a popup. */
    /*
     * Край — ВИДИМЫЙ, а не логический.
     *
     * Считали по номеру строки (`line.number === 1`), а редактор переносит
     * длинные строки: в заметке с абзацем на три экранные строки ArrowUp со
     * второй из них выпрыгивал в предыдущую ячейку вместо подъёма на строку
     * выше. Для markdown это почти каждый абзац.
     *
     * Спрашиваем координаты: каретка на верхней ЭКРАННОЙ строке — та, что стоит
     * на одной высоте с началом документа. Пиксель допуска — на округление
     * подпикселей при масштабе экрана. Пока редактор не измерен, координат нет
     * вовсе, и тогда остаётся прежнее правило по номеру строки: одно нажатие в
     * первую же миллисекунду важнее точности.
     */
    function atVisualEdge(view: EditorView, direction: -1 | 1): boolean {
      const range = view.state.selection.main
      const here = view.coordsAtPos(range.head)
      const edge = view.coordsAtPos(direction === -1 ? 0 : view.state.doc.length)
      if (!here || !edge) {
        const line = view.state.doc.lineAt(range.head)
        return direction === -1 ? line.number === 1 : line.number === view.state.doc.lines
      }
      return direction === -1 ? here.top <= edge.top + 1 : here.bottom >= edge.bottom - 1
    }

    function arrowOut(view: EditorView, direction: -1 | 1): boolean {
      if (!handlers.onarrowout) return false
      if (completionStatus(view.state) === 'active') return false
      const range = view.state.selection.main
      if (!range.empty) return false
      if (!atVisualEdge(view, direction)) return false
      handlers.onarrowout(direction)
      return true
    }

    const cellKeymap = Prec.highest(
      keymap.of([
        /*
         * ⌘⇧↵ стоит ПЕРЕД ⇧↵ и ⌘↵ только для чтения: набор модификаторов у
         * биндинга полный, и «Shift-Enter» с зажатым Cmd не совпадает ни с
         * чем, кроме этой строки. Порядок здесь — порядок рассказа: сначала
         * то, что сдаёт, потом то, что считает.
         */
        { key: 'Mod-Shift-Enter', preventDefault: true, run: () => fire(handlers.onsubmit) },
        { key: 'Shift-Enter', preventDefault: true, run: () => fire(handlers.onrunstep) },
        { key: 'Mod-Enter', preventDefault: true, run: () => fire(handlers.onrun) },
        { key: 'Alt-Enter', preventDefault: true, run: () => fire(handlers.onrunandadd) },
        {
          key: 'Escape',
          run: (view) => {
            // Let the completion popup have Escape first.
            if (completionStatus(view.state) === 'active') return false
            /*
             * Потом — справка по наведению, и только потом командный режим.
             *
             * Порядок читается как «убрать самое ближнее»: сначала список,
             * потом справка, и лишь когда на экране не осталось ничего
             * лишнего, Escape уводит из ячейки. Иначе один и тот же Escape
             * выбрасывал бы человека из набора вместе с закрытием подсказки.
             *
             * Открыта ли она — спрашиваем у DOM, а не у состояния: подсказки
             * по наведению живут в своём плагине, и наружу он показывает
             * только сам узел. Ошибиться тут нечем — узел наш и назван нами.
             */
            if (view.dom.querySelector('.cm-signature')) {
              view.dispatch({ effects: cm.view.closeHoverTooltips })
              return true
            }
            return fire(handlers.onescape)
          },
        },
        {
          // Удерживаемый Backspace не удаляет ячейку: см. `repeating` выше и
          // cell-keys.ts, где это правило проверяется тестом.
          key: 'Backspace',
          run: (view) =>
            backspaceRemovesCell({ empty: view.state.doc.length === 0, repeat: repeating })
              ? fire(handlers.ondeleteempty)
              : false,
        },
        { key: 'ArrowUp', run: (view) => arrowOut(view, -1) },
        { key: 'ArrowDown', run: (view) => arrowOut(view, 1) },
      ]),
    )

    return new cm.view.EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lang === 'python' ? cm.py.python() : cm.md.markdown(),
          bracketMatching(),
          closeBrackets(),
          /*
           * Дополнение: сперва ядро, следом слова самой ячейки.
           *
           * `override` — весь список источников целиком, и в нём намеренно
           * нет разбора дерева языка: в Python дерево знает только ключевые
           * слова, а имя переменной, лежащей в ядре, не знает вовсе. Зато
           * ядро знает и `df.head`, и `df.описание`, если человек так назвал
           * столбец, — это и есть разница между подсказкой по тексту и
           * подсказкой по тому, что в комнате действительно посчитано.
           *
           * В markdown-ячейке ни того, ни другого: там пишут прозой, и список
           * слов, выскакивающий на каждую букву, мешает.
           */
          lang === 'python'
            ? [
                autocompletion({
                  override: [kernelCompletions, cm.py.localCompletionSource],
                  activateOnTyping: true,
                  icons: false,
                }),
                signatureHover,
                /*
                 * Переход к определению — только в коде. В заметке определений
                 * нет вовсе, а подчёркивать слова в прозе значит обещать жест,
                 * которого там не бывает.
                 */
                jumpClick,
                jumpHint,
              ]
            : autocompletion({ activateOnTyping: true, icons: false }),
          indentOnInput(),
          /*
           * Четыре пробела — размер отступа в ячейке.
           *
           * Без этой строки CodeMirror берёт свои два, и Python в тетради
           * набирается не так, как везде: Enter после `def f():` отбивал два
           * пробела, а вставленный из файла или из чужого ответа код приходил
           * на четырёх — в одной функции получалось два разных отступа, и
           * ядро отвечало IndentationError на месте, которое глазами не
           * отличить. Столько же ставит редактор файлов (FileEditor).
           */
          indentUnit.of(INDENT),
          highlightActiveLine(),
          /*
           * Подсветка строки, на которую привёл переход, — в обоих языках, хотя
           * ведут переходы только в код: поле пустое ничего не стоит, а ветка
           * по языку тут была бы ещё одним местом, где однажды разойдутся
           * правило и жест.
           */
          landing.field,
          cm.view.EditorView.lineWrapping,
          writable.of(writableExtensions(cm, editable)),
          hintSlot.of(hint ? placeholderExt(hint) : []),
          localeSlot.of(EditorState.phrases.of(editorPhrases())),
          cm.theme.colloqTheme,
          cm.view.EditorView.contentAttributes.of({ 'aria-label': label }),
          /*
           * Потолок листа: вставка, которая не влезает, не принимается целиком
           * и со словами; набор руками при этом не запрещён — правило и его
           * доводы в cell-paste.ts.
           *
           * Вставкой считаются ровно два пользовательских события — ⌘V и
           * перенос мышью. У транзакций, которыми y-codemirror применяет
           * правки Y.Text (чужие и наши SEED), userEvent нет вовсе, так что
           * `pasted` у них false и отказать им нечем: отказ развёл бы редактор
           * с документом.
           */
          ceiling === null
            ? []
            : EditorState.changeFilter.of((tr) => {
                if (!tr.docChanged) return true
                const pasted = tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop')
                if (changeFits({ chars: tr.newDoc.length, ceiling, pasted })) return true
                handlers.onoverflow?.(tr.newDoc.length)
                return false
              }),
          // Yjs is the single source of truth for the text; no local history
          // extension, because the shared UndoManager already owns Mod-Z.
          cm.collab.yCollab(ytext, peers, { undoManager: undo }),
          cellKeymap,
          keymap.of([...closeBracketsKeymap, ...cm.commands.defaultKeymap]),
          /*
           * Tab принимает подсказку — и только когда она открыта.
           *
           * Стоит ВЫШЕ отступа намеренно: ниже он не сработал бы никогда,
           * потому что `tabKey` обрабатывает нажатие всегда и дальше его не
           * пускает. Когда списка на экране нет, `acceptCompletion` отвечает
           * false, нажатие идёт дальше и отбивает пробелы, как отбивало.
           *
           * Ctrl-Space — тот же список по требованию, даже посреди пустой
           * строки. Он есть и в наборе клавиш самого `autocompletion`; назван
           * здесь ещё раз, чтобы обещание «подсказку можно позвать руками» не
           * зависело от умолчания чужого пакета.
           */
          keymap.of([
            { key: 'Tab', run: acceptCompletion },
            { key: 'Mod-Space', preventDefault: true, run: startCompletion },
            { key: 'Ctrl-Space', preventDefault: true, run: startCompletion },
          ]),
          /*
           * Tab — отступ, а не переход по фокусу.
           *
           * Своего Tab у CodeMirror нет: нажатие уходит браузеру, и фокус
           * уезжает из ячейки — в тетради, где пишут Python, это значит, что
           * отступ набрать нечем, кроме пробелов вручную.
           *
           * Мягкий, а не сдвиг строки: пробелы встают В КУРСОР, до следующей
           * отметки. Готовый `indentWithTab` двигает строку целиком, и Tab
           * посреди набранного уносил вправо всё, что уже написано, — правило
           * и его доводы в lib/indent.ts.
           *
           * Стоит последним и потому проигрывает всем, кто уже занял Tab.
           * Ценой ловушки для клавиатуры: выйти из ячейки Tab'ом нельзя — для
           * этого Escape, он же увод в командный режим, и он же выше по
           * старшинству. У ячейки, которую не дают править (чужая под замком,
           * закончившееся занятие), Tab по-прежнему уводит фокус: правило
           * отказывает на readOnly, и нажатие достаётся браузеру.
           *
           * Тот же размен и та же строка — в редакторе файлов (FileEditor).
           */
          keymap.of([
            tabKey({
              EditorSelection: cm.state.EditorSelection,
              indentMore: cm.commands.indentMore,
              indentLess: cm.commands.indentLess,
            }),
          ]),
          cm.view.EditorView.updateListener.of((update) => {
            if (update.focusChanged && update.view.hasFocus) handlers.onfocus?.()
          }),
        ],
      }),
      parent,
    })
  }

  /*
   * The shim tracks the document rather than snapshotting it, so a cell whose
   * text arrives from the server while the chunk is still in flight is already
   * showing the right lines when CodeMirror takes over.
   */
  $effect(() => {
    if (ready) return
    const ytext = text
    const sync = () => (shimText = ytext.toString())
    sync()
    ytext.observe(sync)
    return () => ytext.unobserve(sync)
  })

  /**
   * Переконфигурировать живой редактор под новое правило edit — или null, пока
   * редактора нет.
   *
   * `$state.raw`, потому что второй эффект должен проснуться, когда редактор
   * построился заново (другая тетрадь, другой язык), а не только когда правило
   * поменялось.
   */
  let setWritable = $state.raw<((editable: boolean) => void) | null>(null)
  /** Что стоит в живом редакторе сейчас — чтобы не переконфигурировать впустую. */
  let writableNow = true
  let setLabels = $state.raw<((hint: string) => void) | null>(null)
  /**
   * Показать в живом редакторе, куда привёл переход, — или null, пока его нет.
   *
   * `$state.raw` по тому же доводу, что у `setWritable`: эффект с меткой обязан
   * проснуться и тогда, когда редактор ТОЛЬКО ЧТО построился. Для перехода это
   * не редкий случай, а обычный: далёкую ячейку тетрадь держит заглушкой и
   * строит уже после прокрутки, то есть позже, чем пришёл ответ.
   */
  let setLanding = $state.raw<((spot: { line: number; column: number }) => void) | null>(null)
  /** Номер последнего показанного перехода — чтобы не показывать его дважды. */
  let landedSeq = 0
  /**
   * Живой редактор — не для перерисовки, а чтобы спросить про фокус.
   *
   * Обычный `let`, не `$state`: читают его только обработчики, и реактивным он
   * бы означал пересборку эффекта на каждую сборку редактора.
   */
  let live: EditorView | null = null

  $effect(() => {
    const parent = host
    const ytext = text
    const scope = cellId
    /*
     * Ячейкин редактор видит присутствие только своей ячейки — иначе один чужой
     * курсор будит все смонтированные редакторы разом (см. cell-awareness.ts).
     * Свой курсор при этом по-прежнему объявляется в настоящее присутствие:
     * вид только читает.
     */
    const scoped = scope ? cellAwareness(awareness, scope) : null
    const peers = scoped ?? awareness
    const undo = undoManager
    const lang = language
    if (!parent) {
      scoped?.destroy()
      return
    }

    const hint = untrack(() => placeholder)
    const focusOnReady = untrack(() => autoFocus)
    // Потолок у своего листа один на всё время его жизни — как и подсказка:
    // отслеживать его значило бы разбирать редактор под пальцами ради числа,
    // которое не меняется.
    const ceiling = untrack(() => maxChars)
    /*
     * `readOnly` здесь НЕ отслеживается, и это несущее решение.
     *
     * Пока отслеживался, преподаватель, переключивший «Печатать в ячейках» на
     * «только преподаватель» посреди пары, разбирал редактор у всех: destroy
     * уносит сфокусированный .cm-content, `holdingFocus` считается уже после
     * него и врёт, autoFocus у кодовой ячейки нет — фокус не возвращался
     * никому. Следующие буквы уходили в командный режим тетради, где «a»
     * вставляет ячейку всей комнате, а «d d» удаляет выбранную. Теперь правило
     * живёт в отсеке и меняется на месте — см. эффект ниже.
     */
    const editable = untrack(() => !readOnly)

    let view: EditorView | null = null
    let disposed = false
    /** Часы угасания подсветки — один на редактор, переход их перезаводит. */
    let fading: ReturnType<typeof setTimeout> | null = null

    void loadCodeMirror().then((cm) => {
      if (disposed) return
      // Asked at the last moment rather than tracked: whatever the shim did
      // with focus, this is the one question that matters.
      const holdingFocus = parent.contains(document.activeElement)
      const writable = new cm.state.Compartment()
      const hintSlot = new cm.state.Compartment()
      const localeSlot = new cm.state.Compartment()
      const landing = makeLanding(cm)
      view = createView(cm, { parent, ytext, peers, undo, lang, editable, hint, writable, ceiling, hintSlot, localeSlot, landing })
      /*
       * Order matters, and nothing paints between these three statements. The
       * editor goes in first so focus can move straight from the shim into it:
       * a note commits itself the moment focus leaves the cell, and a moment
       * with nothing focused at all counts as leaving.
       */
      if (focusOnReady || holdingFocus) view.focus()
      ready = true
      const built = view
      live = built
      setLabels = (nextHint) => built.dispatch({ effects: [
        hintSlot.reconfigure(nextHint ? cm.view.placeholder(nextHint) : []),
        localeSlot.reconfigure(cm.state.EditorState.phrases.of(editorPhrases())),
      ] })
      writableNow = editable
      setWritable = (next) =>
        built.dispatch({ effects: writable.reconfigure(writableExtensions(cm, next)) })
      /**
       * Показать, куда привели: подсветить строку и — если тут дают печатать —
       * поставить в неё каретку.
       *
       * Порядок именно такой, и подсветка тут главная, а каретка второстепенная.
       * В ячейке, которую не дают править, `focus()` не делает НИЧЕГО: у
       * закрытого редактора `contenteditable=false`, а такой узел фокуса не
       * берёт вовсе — это записано по живому отказу в CellView.svelte (заметка
       * под замком, из которой нечем было выйти, потому что выход висел на
       * уходе фокуса). Переход же обязан работать и там: чужую тетрадь и
       * закончившееся занятие читают чаще, чем правят. Поэтому «куда привели»
       * говорит украшение строки, а не каретка.
       *
       * Прокрутки здесь нет намеренно. `EditorView.scrollIntoView` пошёл бы
       * искать скроллер вверх по предкам — своего у ячейки нет
       * (`.cm-scroller { overflow: visible }` ниже в этом файле), — то есть
       * подвинул бы `<main>` посреди плавного хода тетради, а браузер считает
       * такую правку `scrollTop` чужим вмешательством и ход обрывает
       * (Notebook.svelte · steering). К ячейке везёт тетрадь; редактор только
       * подсвечивает строку.
       */
      setLanding = (spot) => {
        const doc = built.state.doc
        // Строка могла уехать: ответ считали по тексту, который с тех пор
        // успели поправить. Промах внутрь документа лучше исключения.
        const row = doc.line(Math.min(Math.max(1, Math.round(spot.line)), doc.lines))
        const pos = Math.min(row.from + Math.max(0, spot.column), row.to)
        const mayType = !built.state.readOnly
        built.dispatch({
          effects: landing.landed.of(row.from),
          selection: mayType ? cm.state.EditorSelection.cursor(pos) : undefined,
        })
        if (mayType) built.focus()
        if (fading !== null) clearTimeout(fading)
        fading = setTimeout(() => built.dispatch({ effects: landing.landed.of(null) }), LANDING_MS)
      }
      flushSync()
    })

    return () => {
      disposed = true
      setWritable = null
      setLabels = null
      setLanding = null
      if (fading !== null) clearTimeout(fading)
      if (live === view) live = null
      view?.destroy()
      view = null
      // После редактора: `destroy` плагина ещё снимет с вида свой слушатель.
      scoped?.destroy()
      ready = false
    }
  })

  /*
   * Правило edit меняется посреди пары, и редактор его переживает: меняется
   * один отсек, фокус, курсор, прокрутка и открытая подсказка остаются на
   * месте. Строится редактор уже с верным значением, так что первый прогон
   * этого эффекта — обычно холостой.
   */
  // Display language changes reconfigure labels in place; the editor, undo, and selection survive.
  $effect(() => {
    getLocale()
    setLabels?.(placeholder)
  })

  $effect(() => {
    const apply = setWritable
    const editable = !readOnly
    if (!apply || editable === writableNow) return
    writableNow = editable
    /*
     * Право печатать отняли из-под курсора — забрать и курсор.
     *
     * `yCollab` объявляет положение курсора всей комнате, пока редактор в
     * фокусе, и это правильно ровно до того мгновения, когда преподаватель
     * закрывает ячейку. Дальше поле `cursor` в присутствии остаётся стоять в
     * ней: у соседей до конца пары висит каретка с именем человека там, где
     * он уже ничего не печатает. Само оно не уйдёт — `yCollab` чистит поле
     * только у редактора В ФОКУСЕ, а закрытый фокуса не берёт вовсе
     * (`contenteditable=false`).
     *
     * Спрашиваем ДО переконфигурации, пока фокус ещё здесь: это и есть
     * доказательство, что в присутствии стоит наш курсор, а не чужой ячейки.
     */
    if (!editable && live?.hasFocus) awareness.setLocalStateField('cursor', null)
    apply(editable)
  })

  /*
   * Переход приехал — показать его в ЖИВОМ редакторе, не разбирая его.
   *
   * Тот же приём, что у правила edit и у языка подписей выше: метка никогда не
   * читается при постройке вида, потому что дойти она может и раньше неё, и
   * много позже. Раньше — когда ячейку ещё строит тетрадь; позже — когда
   * человек вернулся и щёлкнул по тому же имени второй раз, а по полям метки
   * это тот же самый переход. Различает их `seq`, и сравнение с ним — ровно
   * то, что не даёт одному переходу показаться дважды.
   */
  $effect(() => {
    const show = setLanding
    const spot = mark
    if (!show || !spot || spot.seq === landedSeq) return
    landedSeq = spot.seq
    show(spot)
  })
</script>

<!-- No height, no overflow: the editor is as tall as its content and the page scrolls. -->
<div
  bind:this={host}
  class="cm-cell text-ink"
  onkeydowncapture={(event) => (repeating = event.repeat)}
>
  {#if !ready}
    <!--
      Stands in for CodeMirror at CodeMirror's own metrics. It wears two of
      CodeMirror's class names deliberately: .cm-content is what the cell's
      focus handling reaches for, and .cm-editor is both where index.css keeps
      the type scale and what the notebook checks before deciding a keystroke
      belongs to it and not to the cell — without it, typing here would move the
      selection or delete the cell. Read-only on purpose: replaying keystrokes
      into a CRDT after the fact is a good way to lose one, so focus follows the
      user into the real editor instead.
    -->
    <div
      class="cm-shim cm-editor cm-content"
      role="textbox"
      tabindex="0"
      aria-multiline="true"
      aria-readonly="true"
      aria-busy="true"
      aria-label={tr('room.ui.435')}
      onpointerdown={(event) => event.currentTarget.focus()}
    >
      {#each shimLines as line, index}
        <span class="cm-shim-line"
          >{line}{#if index === 0 && placeholder && shimText === ''}<span class="cm-placeholder"
              >{placeholder}</span
            >{/if}</span
        >
      {/each}
    </div>
  {/if}
</div>

<style>
  .cm-cell :global(.cm-editor) {
    height: auto;
  }
  /*
   * Ячейка ничего не прокручивает и ничего не режет.
   *
   * Высота у редактора по содержимому, прокручивается страница, — но
   * `overflow-x: auto` из index.css делал скроллер обрезающим и по вертикали
   * (у `overflow-x: auto` вторая ось не бывает `visible`), а `overflow-y:
   * hidden` здесь это закрепляло. Резалось при этом единственное, что вообще
   * выходит за строку: плашка с именем соседа — она висит НАД строкой, и на
   * первой строке ячейки от неё оставалось девять пикселей из четырнадцати,
   * то есть срезанные по горизонту буквы.
   *
   * Прокрутке это ничего не стоит: строки в ячейке переносятся
   * (`EditorView.lineWrapping`), горизонтальной полосе тут взяться неоткуда.
   */
  .cm-cell :global(.cm-scroller) {
    overflow: visible;
  }

  /*
   * Every number below is CodeMirror's own, verified by measuring both against
   * each other: the swap moves no pixel and wraps at the same columns. The type
   * scale arrives with .cm-editor from index.css; the rest is CodeMirror's base
   * theme and cm-theme.ts. Grid rather than two columns because a wrapped line
   * has to push its own line number down, which is what CodeMirror does by
   * measuring every block — and what a grid row does for free.
   */
  .cm-shim {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    /* CodeMirror's base theme pads .cm-content by 4px and outranks index.css's
       rule for the real editor, so 4px is what the swap has to land on. */
    padding: 4px 0;
    outline: none;
  }
  .cm-shim-line {
    /* An empty line has no text to give it height; one line box, as in the editor. */
    min-height: 1.65em;
    padding: 0 8px 0 4px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
  }
</style>

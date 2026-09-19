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
        import('@codemirror/language').then(
          ({ bracketMatching, indentOnInput, indentUnit, syntaxTree }) => ({
            bracketMatching,
            indentOnInput,
            indentUnit,
            syntaxTree,
          }),
        ),
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
            showTooltip,
            ViewPlugin,
          }) => ({
            closeHoverTooltips,
            Decoration,
            EditorView,
            highlightActiveLine,
            hoverTooltip,
            keymap,
            placeholder,
            showTooltip,
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
  import type {
    Decoration as Deco,
    DecorationSet,
    EditorView,
    Tooltip,
    ViewUpdate,
  } from '@codemirror/view'
  import type { InspectMiss } from '@shared/protocol'
  import { questionAt, type Question } from '@shared/python-defs'
  import { INDENT, tabKey } from '@/lib/indent'
  import { caretTarget, hoverTarget, moduleAliases } from '@/lib/hover-target'
  import {
    helpIsEmpty,
    helpKey,
    parseSignatureHelp,
    rememberHelp,
    rememberedHelp,
    safeLink,
    splitPackage,
    splitSignature,
    SIGNATURE_ONE_LINE,
    type SignatureHelp,
    type SignatureParts,
  } from '@/lib/signature-help'
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

  /**
   * Что ответило ядро на «что это такое». Та же форма, что у `inspect:reply`.
   *
   * `reason` — почему справки нет: ядро ещё поднимается, ядро занято, имя не
   * найдено (protocol.ts · `InspectMiss`). Поле необязательное, потому что
   * необязательно оно и на проводе: старый сервер его не шлёт, и тогда отказ
   * молчит, как молчал.
   */
  interface KernelSignature {
    found: boolean
    text?: string
    reason?: InspectMiss
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
     * Тексты ячеек кода ЭТОЙ тетради — чтобы знать, что здесь импортировали.
     *
     * По ним справка решает, спрашивать ли про `px` в `px.scatter(` (да: это
     * псевдоним импорта) и про `df` в `df.groupby(` (нет: что такое `df`,
     * знает только ядро, а наводятся на него чаще всего мимоходом) — см.
     * lib/hover-target.ts. Вызовом, а не списком: читать восемьдесят ячеек на
     * каждую перерисовку незачем, спрашивают их только на наведении, то есть
     * не чаще раза в треть секунды и только там, где справка вообще возможна.
     *
     * Не передали — правило работает без третьего пункта: импорты и вызовы
     * спрашиваются по-прежнему, а обращения через точку молчат. Так и нужно
     * листу консилиума и редактору файлов, у которых тетради нет.
     */
    sources?: (() => readonly string[]) | null
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
    sources = null,
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
    | 'sources'
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
    handlers.sources = sources
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

  /**
   * Насколько длинный параметр перестаёт быть неразрывным.
   *
   * Неразрывность параметра — вся суть раскладки: `x_estimator=None` не должен
   * разрываться посреди имени. Но параметр шире окна неразрывным быть не
   * может: он вылез бы за край и завёл ВТОРУЮ полосу прокрутки,
   * горизонтальную, — то самое, от чего вся эта раскладка и заведена. Семьдесят
   * два знака — это ширина окна (640 px моноширинным тринадцатым) с запасом;
   * всё длиннее переносится внутри себя, как обычный текст.
   */
  /** Тетради нет — третье правило просто не срабатывает; см. `sources`. */
  const EMPTY_ALIASES: ReadonlySet<string> = new Set<string>()

  const PARAM_NOWRAP = 72

  /**
   * Причины, на которых подсказка НЕ успокаивается, — и как часто переспрашивает.
   *
   * Все три временные: ядро поднимается, ядро занято чужой ячейкой, jedi не
   * успел разобрать библиотеку в свой бюджет. Ответ по ним будет — вопрос
   * только когда, — и заставлять человека отводить и снова наводить мышь ради
   * этого стыдно: он уже сделал жест и смотрит на окно. Поэтому спрашивает
   * сама подсказка и заменяет строку-причину справкой на месте.
   *
   * Секунда у подъёма и у разбора, две у занятого ядра: занятая ячейка считается
   * секундами и минутами, и частить к ней незачем — тем более что каждый вопрос
   * к занятому ядру всё равно отвечает отказом сразу. Ведру на сервере (десять
   * вопросов в секунду на сокет) один вопрос в секунду не мешает.
   */
  const WAITING = new Map<InspectMiss, number>([
    ['starting', 1000],
    ['thinking', 1000],
    ['busy', 2000],
  ])

  /**
   * Сколько всего ждать, прежде чем оставить строку-причину как есть.
   *
   * У подъёма ядра — полторы минуты: столько стоит холодный контейнер, и это
   * измеренное число, а не круглое (server/src/kernel/index.ts · подъём
   * окружения). У остальных двадцать секунд: занятая ячейка может считаться
   * час, и окно, переспрашивающее час, — это уже не подсказка, а фоновая
   * работа, о которой никто не просил. Отчаявшись, подсказка просто перестаёт
   * спрашивать; наведите снова — начнёт заново.
   */
  const WAIT_CEILING_MS: Record<string, number> = { starting: 90_000 }
  const WAIT_CEILING_DEFAULT_MS = 20_000

  /**
   * Сигнатура потоком: параметры через запятую, перенос только МЕЖДУ ними.
   *
   * IPython печатает длинную сигнатуру столбиком, по параметру на строку. У
   * `sns.lmplot` это сорок три строки — всё окно справки целиком, и
   * документация оказывается за тремя экранами прокрутки. Между тем в
   * сигнатуре ищут одно: есть ли такой параметр и как он пишется. Потоком те
   * же сорок два параметра занимают семь строк, и docstring виден сразу, без
   * единого движения колеса.
   *
   * Каждый параметр — свой `<span>` с `nowrap`: перенос возможен только по
   * пробелу МЕЖДУ параметрами, и `x_estimator=None` никогда не разрывается
   * пополам. Запятая лежит ВНУТРИ параметра, а разделителем стоит обычный
   * пробел — тогда выделенное мышью и скопированное остаётся нормальной
   * строкой `sns.lmplot(data, *, x=None, …)`, а не набором кусков.
   *
   * Имя параметра — цветом текста, аннотация и умолчание — приглушённым: см.
   * `SignatureParam`. Висячий отступ перенесённых строк — в теме.
   */
  function signatureFlow(parts: SignatureParts): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-signature-sig cm-signature-flow'
    box.appendChild(document.createTextNode(parts.head))
    parts.params.forEach((param, index) => {
      const last = index === parts.params.length - 1
      const span = document.createElement('span')
      // Длинный параметр неразрывным не делаем — см. PARAM_NOWRAP.
      if (param.name.length + param.rest.length <= PARAM_NOWRAP) {
        span.className = 'cm-signature-param'
      }
      span.appendChild(document.createTextNode(param.name))
      if (param.rest !== '') {
        const rest = document.createElement('span')
        rest.className = 'cm-signature-default'
        rest.textContent = param.rest
        span.appendChild(rest)
      }
      if (!last) span.appendChild(document.createTextNode(','))
      box.appendChild(span)
      // Пробел-разделитель — единственное место, где строка может перенестись.
      if (!last) box.appendChild(document.createTextNode(' '))
    })
    box.appendChild(document.createTextNode(parts.tail))
    return box
  }

  /**
   * Сигнатура для окна: потоком, одной строкой или дословно.
   *
   * Три случая и ровно три. Разобрали и она длинная — поток. Разобрали и она
   * короткая — одна строка, уже склеенная из частей (у `df.head` ядро и так
   * отвечает одной строкой, а у класса — тремя, и склеить их честнее, чем
   * оставить лесенку на двадцать знаков). Не разобрали — дословно: скобки не
   * сошлись, это чужое ядро или вовсе не сигнатура, и перестраивать текст по
   * догадке нельзя.
   */
  function signatureBlock(signature: string): HTMLElement {
    const parts = splitSignature(signature)
    if (parts && parts.flat.length > SIGNATURE_ONE_LINE) return signatureFlow(parts)
    const pre = document.createElement('pre')
    pre.className = 'cm-signature-sig'
    pre.textContent = parts ? parts.flat : signature
    return pre
  }

  /**
   * Окно справки — сигнатура сверху, документация под ней, одна прокрутка на обе.
   *
   * ОДНА, и это несущее решение. Разложить их по двум отсекам было бы красивее
   * на макете и хуже в жизни: у `sns.lmplot` сорок с лишним параметров, то есть
   * сигнатура сама по себе длиннее всего окна, и собственный скролл сделал бы
   * документацию недосягаемой — чтобы до неё добраться, пришлось бы сперва
   * докрутить сигнатуру, а потом найти вторую полосу. Общая прокрутка
   * превращает справку в то, чем она и является: один текст сверху вниз.
   *
   * `<pre>` у сигнатуры — с переносом (`pre-wrap` в cm-theme.ts): длинная
   * строка у pandas шире монитора, и горизонтальная полоса тут была бы второй
   * прокруткой, которой мы только что избежали.
   *
   * Градиент внизу — единственная подсказка о том, что текст не кончился.
   * Полосы прокрутки в macOS не видно, пока её не трогают, и без этой тени
   * окно выглядело бы законченным ровно там, где его обрезали.
   */
  function signatureDom(help: SignatureHelp): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-signature'
    const body = document.createElement('div')
    body.className = 'cm-signature-body'
    if (help.raw !== '') {
      const pre = document.createElement('pre')
      pre.className = 'cm-signature-sig'
      pre.textContent = help.raw
      body.appendChild(pre)
    } else if (help.module !== '' || help.pkg !== '') {
      /*
       * Карточка модуля — только когда про модуль есть что сказать. Голое
       * «Type: module» от IPython (приписка про пакет не доехала: ядро занялось,
       * пакета нет на диске) рисуется прежним путём: мелкая пометка и
       * документация, если она есть.
       */
      body.appendChild(moduleHead(help))
    } else {
      if (help.signature !== '') body.appendChild(signatureBlock(help.signature))
      const notes = [help.type, help.length === '' ? '' : `len ${help.length}`, help.form]
        .filter((note) => note !== '')
        .join(' · ')
      if (notes !== '') {
        const row = document.createElement('div')
        row.className = 'cm-signature-note'
        row.textContent = notes
        body.appendChild(row)
      }
      if (help.doc !== '') {
        const pre = document.createElement('pre')
        pre.className = 'cm-signature-doc'
        pre.textContent = help.doc
        body.appendChild(pre)
      }
    }
    root.appendChild(body)
    const more = document.createElement('div')
    more.className = 'cm-signature-more'
    root.appendChild(more)
    /*
     * Признак «есть ещё» живёт на самом узле, а не в состоянии редактора:
     * прокрутка внутри подсказки — не изменение документа, и будить ею
     * CodeMirror (а с ним и чужие каретки) было бы дорого и незачем.
     */
    const mark = () => {
      const left = body.scrollHeight - body.scrollTop - body.clientHeight
      root.classList.toggle('cm-signature-cut', left > 2)
    }
    body.addEventListener('scroll', mark)
    // Высота узнаётся только после того, как его вставили в документ.
    requestAnimationFrame(mark)
    return root
  }

  /**
   * Шапка модуля: чем он является, а не где лежит.
   *
   * «module · <module pandas>» — то, что человек увидел 21.09, наведясь на
   * `pd`: род и адрес, из которых не следует ничего. У модуля есть ответ
   * получше, и лежит он в метаданных пакета рядом с ним на диске: под каким
   * именем его ставят, какой он версии, что делает и где документация
   * (server/src/kernel/inspect-static.ts · `_package`).
   *
   * Подмодуль называется полностью и рядом с пакетом, из которого он взят:
   * «matplotlib.pyplot · модуль пакета matplotlib 3.11.1». Человек наводится
   * на `plt`, а ставил `matplotlib`, и связать одно с другим — часть ответа.
   */
  function moduleHead(help: SignatureHelp): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-signature-module'
    const { name, version } = splitPackage(help.pkg)
    const title = document.createElement('div')
    title.className = 'cm-signature-title'
    const shown = help.module !== '' ? help.module : name
    const strong = document.createElement('b')
    strong.textContent = shown
    title.appendChild(strong)
    const note = document.createElement('span')
    note.className = 'cm-signature-kind'
    if (name !== '' && shown !== name) {
      // Подмодуль: имя пакета в приписке, потому что ставят именно его.
      note.textContent = ` · ${tr('room.signature.submodule', { p0: name, p1: version })}`
    } else if (version !== '') {
      strong.textContent = `${shown} ${version}`
      note.textContent = ` · ${tr('room.signature.module')}`
    } else {
      note.textContent = ` · ${tr('room.signature.module')}`
    }
    title.appendChild(note)
    box.appendChild(title)
    if (help.summary !== '') {
      const line = document.createElement('div')
      line.className = 'cm-signature-summary'
      line.textContent = help.summary
      box.appendChild(line)
    }
    if (help.docs !== '') {
      const line = document.createElement('div')
      line.className = 'cm-signature-docs'
      line.append(document.createTextNode(`${tr('room.signature.docs')} `))
      /*
       * Ссылка приезжает из метаданных ЧУЖОГО пакета, то есть это чужой текст
       * в атрибуте `href`. Щёлкнуть дают только по http(s) — `javascript:` в
       * строке, которую человек читает как «Документация», это исполнение
       * чужого кода по клику в справке. Не прошло проверку — остаётся текстом.
       */
      const safe = safeLink(help.docs)
      if (safe === null) {
        line.append(document.createTextNode(help.docs))
      } else {
        const link = document.createElement('a')
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.textContent = safe
        link.href = safe
        line.appendChild(link)
      }
      box.appendChild(line)
    }
    if (help.doc !== '') {
      const pre = document.createElement('pre')
      pre.className = 'cm-signature-doc'
      pre.textContent = help.doc
      box.appendChild(pre)
    }
    return box
  }

  /**
   * Почему справки нет — одной приглушённой строкой.
   *
   * Молчание тут не работает: наведение — жест осознанный, и ответ «ничего»
   * читается как поломка. Три из четырёх причин временные («сейчас
   * поднимется», «сейчас досчитает»), и человеку важно знать, что ждать имеет
   * смысл. `refused` — единственная, о которой не говорят: там, где сервер
   * отказал по ведру вопросов, жест был правильный и объяснять нечего.
   */
  function signatureMiss(reason: InspectMiss | undefined): HTMLElement | null {
    if (!reason || reason === 'refused') return null
    const words: Record<Exclude<InspectMiss, 'refused'>, string> = {
      'no-kernel': tr('room.signature.noKernel'),
      starting: tr('room.signature.starting'),
      busy: tr('room.signature.busy'),
      thinking: tr('room.signature.thinking'),
      unknown: tr('room.signature.unknown'),
    }
    const dom = document.createElement('div')
    dom.className = 'cm-signature cm-signature-miss'
    dom.append(document.createTextNode(words[reason]))
    /*
     * У временной причины — признак ожидания, у окончательной его нет.
     *
     * Три точки, и они дышат прозрачностью: остановленный указатель — ложь о
     * системе (та же политика, что у спиннеров продукта, index.css), а
     * прозрачность — ровно то, что правило `prefers-reduced-motion` этого
     * продукта оставляет нетронутым: убираются ПЕРЕЕЗДЫ, не цвет и не
     * прозрачность. Точки и есть обещание: «вернусь с ответом, ждать имеет
     * смысл».
     */
    if (WAITING.has(reason)) {
      const wait = document.createElement('span')
      wait.className = 'cm-signature-wait'
      wait.setAttribute('aria-hidden', 'true')
      for (let i = 0; i < 3; i++) wait.appendChild(document.createElement('i'))
      dom.appendChild(wait)
    }
    return dom
  }

  /**
   * Имена, связанные импортом в этой тетради, — с памятью до следующей правки.
   *
   * Считается по тексту ячеек (lib/hover-target.ts · `moduleAliases`), а не по
   * ядру: правило должно работать и до первого запуска — там, где справка
   * нужнее всего. Ячейки без слова `import` не читаются вовсе, так что обычная
   * тетрадь — это три-четыре коротких строки на разбор.
   *
   * Память — по отпечатку: сколько ячеек и сколько в них знаков. Правка текста
   * его меняет, и список пересобирается; замена знака на знак в той же длине
   * (переименовали `np` в `nq`) отпечаток не двигает, и до следующей правки
   * список останется вчерашним. Цена этой неточности — одно лишнее или одно
   * недостающее имя в списке разрешённых, то есть окно, которое на секунду
   * появилось или не появилось там, где могло бы.
   */
  let aliasMemo: { stamp: string; names: Set<string> } | null = null

  function aliasesNow(): ReadonlySet<string> {
    const read = handlers.sources
    if (!read) return EMPTY_ALIASES
    let sources: readonly string[]
    try {
      sources = read()
    } catch {
      // Тетрадь могли закрыть между наведением и ответом — молчим.
      return EMPTY_ALIASES
    }
    let chars = 0
    for (const one of sources) chars += one.length
    const stamp = `${sources.length}:${chars}`
    if (aliasMemo?.stamp === stamp) return aliasMemo.names
    const names = moduleAliases(sources)
    aliasMemo = { stamp, names }
    return names
  }

  /**
   * О чём справка, а о чём нет, — решает ДЕРЕВО РАЗБОРА, а не соседние знаки.
   *
   * Правило и его доводы целиком в lib/hover-target.ts; здесь только дорога к
   * нему. Раньше на этом месте стояла регулярка по строке — «любое слово под
   * указателем», — и на занятии 21.09 это оказалось невыносимо: окно
   * выскакивало над именем колонки в кавычках, над `x=` в списке аргументов,
   * над собственной переменной и над словом в комментарии. Причём каждое такое
   * наведение стоило кадра в сокете и вопроса к общему ядру комнаты.
   *
   * `syntaxTree` отдаёт то, что редактор уже разобрал для подсветки: своего
   * разбора здесь нет и не заводится.
   */
  function hoverSpot(
    cm: CodeMirror,
    view: EditorView,
    at: number,
  ): { from: number; to: number; ask: string } | null {
    const answer = cm.language.syntaxTree(view.state)
    return hoverTarget({
      tree: answer,
      doc: view.state.doc.toString(),
      at,
      aliases: aliasesNow(),
    }).target
  }

  /**
   * О чём спрашивает Shift+Tab у каретки — или `null`, и тогда он отступ.
   *
   * Шире наведения, и намеренно: клавишу нажимают осознанно и один раз.
   * Кроме разрешённых наведению имён сюда добавлен главный случай Jupyter —
   * каретка ВНУТРИ скобок вызова (`px.scatter(apartments, x=|`) показывает
   * сигнатуру того, что вызывают (lib/hover-target.ts · `caretTarget`).
   *
   * `null` — нажатие достаётся тому, кто занял Shift+Tab раньше (lib/indent.ts
   * · снятие отступа). Это и есть цена привычки: клавишу пришлось делить, и
   * делится она по тому, есть ли под кареткой о чём спросить. В пустой строке,
   * в середине отступа и на выделении Shift+Tab работает как работал.
   */
  function caretSpot(
    cm: CodeMirror,
    view: EditorView,
    at: number,
  ): { from: number; to: number; ask: string } | null {
    return caretTarget({
      tree: cm.language.syntaxTree(view.state),
      doc: view.state.doc.toString(),
      at,
      aliases: aliasesNow(),
    }).target
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

    /* -------------------------------------- справка о том, что под указателем */

    /**
     * Спросить ядро об одном имени — и собрать то, что покажем.
     *
     * Одна дорога на оба жеста: наведение мышью и Shift+Tab у каретки. Второй
     * такой же функции здесь быть не должно — разойдясь, они дали бы разный
     * ответ на один и тот же вопрос, и объяснить это было бы нечем.
     *
     * Память (lib/signature-help.ts) стоит ПЕРЕД вопросом: второе наведение на
     * то же имя обязано открываться мгновенно, а не ходить в общее ядро за
     * тем, что уже знает. Помнится только найденное; причины отказа не
     * помнятся никогда — они живут секунду, и вчерашнее «ядро запускается»
     * было бы враньём ровно тогда, когда ответ наконец есть.
     */
    async function askSignature(view: EditorView, at: number, name: string): Promise<HTMLElement | null> {
      const ask = handlers.inspect
      if (!ask) return null
      const key = helpKey(cellId, name)
      const kept = rememberedHelp(key)
      if (kept !== null) {
        const help = parseSignatureHelp(kept)
        return helpIsEmpty(help) ? null : signatureDom(help)
      }
      /*
       * Каретка для ядра ставится в КОНЕЦ имени: `inspect_request` отвечает
       * о том, что стоит перед ней. Посреди слова он ответил бы о `he`.
       */
      const answer = await ask(view.state.doc.toString(), at)
      // `null` — сокет закрыт или три секунды вышли: сказать нечего, и это
      // единственный случай, когда справка по-прежнему молчит.
      if (!answer) return null
      if (!answer.found || !answer.text) {
        const dom = signatureMiss(answer.reason)
        // Причина временная — ждём ответа сами, не отправляя человека водить
        // мышью туда-обратно (см. `keepAsking`).
        if (dom && answer.reason && WAITING.has(answer.reason)) {
          keepAsking(view, at, key, dom, answer.reason)
        }
        return dom
      }
      const help = parseSignatureHelp(answer.text)
      if (helpIsEmpty(help)) return signatureMiss('unknown')
      rememberHelp(key, answer.text)
      return signatureDom(help)
    }

    /**
     * Переспрашивать, пока окно открыто, и заменить причину справкой на месте.
     *
     * «Неясно, зачем мне отводить и снова наводить курсор, чтобы появилась
     * сигнатура» — жалоба с занятия 20.09, и она справедлива: ответ «ядро
     * запускается» человек прочитал, ядро через две секунды поднялось, а окно
     * продолжало показывать вчерашнюю новость, потому что спрашивает его
     * только наведение.
     *
     * Останавливается по трём признакам, и все три значат «окна больше нет или
     * оно уже не про это место»: узел отцепили (мышь ушла, Escape, каретка
     * уехала с закреплённой), текст ячейки изменился (спрашивали про другое),
     * вышел потолок ожидания. Никаких таймеров при этом не остаётся: следующий
     * такт заводится только из предыдущего и только после проверок.
     *
     * Ответ вставляется В ТОТ ЖЕ узел, а не рядом: он принадлежит CodeMirror
     * (`create: () => ({ dom })`), и подменить его значило бы оставить
     * подсказку без содержимого. Меняются класс и дети — и CodeMirror просят
     * перемерить: окно из одной строки превращается в шестисотпиксельное, и
     * без пересчёта оно осталось бы стоять по старому размеру, залезая на
     * строку или вися в воздухе.
     */
    function keepAsking(
      view: EditorView,
      at: number,
      key: string,
      dom: HTMLElement,
      first: InspectMiss,
    ): void {
      const ask = handlers.inspect
      if (!ask) return
      const doc = view.state.doc
      const until = Date.now() + (WAIT_CEILING_MS[first] ?? WAIT_CEILING_DEFAULT_MS)
      let reason: InspectMiss = first
      const again = () => {
        const wait = WAITING.get(reason)
        if (wait === undefined) return
        const timer = setTimeout(tick, wait)
        // Вопрос о подсказке не имеет права держать вкладку живой.
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }
      const tick = async () => {
        if (!dom.isConnected || view.state.doc !== doc || Date.now() > until) return
        const answer = await ask(view.state.doc.toString(), at)
        // Пока ходили, окно могли закрыть или текст переписать.
        if (!dom.isConnected || view.state.doc !== doc) return
        if (!answer) return
        if (!answer.found || !answer.text) {
          const next = answer.reason
          if (!next || !WAITING.has(next)) {
            // Причина стала окончательной («не нашлось»): говорим её и молчим.
            const said = signatureMiss(next)
            if (said) {
              dom.className = said.className
              dom.replaceChildren(...said.childNodes)
              view.requestMeasure()
            }
            return
          }
          if (next !== reason) {
            const said = signatureMiss(next)
            if (said) dom.replaceChildren(...said.childNodes)
            reason = next
          }
          again()
          return
        }
        const help = parseSignatureHelp(answer.text)
        if (helpIsEmpty(help)) return
        rememberHelp(key, answer.text)
        const built = signatureDom(help)
        dom.className = built.className
        dom.replaceChildren(...built.childNodes)
        view.requestMeasure()
      }
      again()
    }

    /**
     * Где висеть окну справки — правило, общее для обоих жестов.
     *
     * ПОД строкой, а не над ней. Над строкой висит тулбар ячейки —
     * «запустить», «остановить», «форматировать», — и подсказка, выехавшая
     * вверх, закрывала его собой ровно тогда, когда человек тянется к кнопке.
     * Стопка слоёв доводит то же правило до конца: у подсказки z-index ниже
     * тулбарного, так что даже снизу она не может его перекрыть (см.
     * cm-theme.ts · .cm-tooltip.cm-signature).
     */
    function signatureTooltip(from: number, to: number, dom: HTMLElement): Tooltip {
      return {
        pos: from,
        end: to,
        above: false,
        create: (view) => {
          /*
           * Escape закрывает справку и тогда, когда в редакторе уже не печатают.
           *
           * Выделив мышью строку ВНУТРИ окна, человек уводит фокус из ячейки —
           * и с ним уходит набор клавиш редактора, то есть Escape перестаёт
           * доходить куда бы то ни было. Замерено на стенде: окно оставалось
           * висеть, пока не увести указатель.
           *
           * Только когда фокуса в редакторе НЕТ: пока он там, Escape разбирает
           * свой порядок — список дополнения, потом справка, потом командный
           * режим, — и вмешиваться в него отсюда значило бы этот порядок
           * сломать.
           */
          const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || view.hasFocus) return
            closeSignature(view)
          }
          document.addEventListener('keydown', onKey, true)
          return { dom, destroy: () => document.removeEventListener('keydown', onKey, true) }
        },
      }
    }

    /** Убрать справку — обе разом, какая бы сейчас ни висела. */
    function closeSignature(view: EditorView): void {
      view.dispatch({ effects: [cm.view.closeHoverTooltips, pinned.of(null)] })
    }

    /**
     * Та же справка, вызванная Shift+Tab, — и она не гаснет, пока не уйдут.
     *
     * Клавиша та же, что в Jupyter, и это единственный довод в её пользу: люди
     * приходят в тетрадь с уже готовой привычкой. Но Shift+Tab в этом
     * редакторе занят — он снимает отступ, — поэтому справка отвечает на него
     * ТОЛЬКО там, где отступ снимать не о чем: каретка стоит на имени или
     * где угодно внутри скобок вызова, выделения нет (см. `caretSpot` и
     * lib/hover-target.ts). Во всех прочих случаях нажатие идёт дальше и
     * снимает отступ, как снимало.
     *
     * Своё поле, а не `hoverTooltip`: у наведения окно живёт, пока над ним
     * мышь, а у клавиши мыши нет вовсе. Закрепление снимают три вещи — Escape,
     * уехавшая каретка и любая правка текста: после каждой из них справка
     * рассказывает про место, где человека уже нет.
     */
    const pinned = cm.state.StateEffect.define<Tooltip | null>()
    const pinnedField = cm.state.StateField.define<Tooltip | null>({
      create: () => null,
      update(value, tr) {
        for (const effect of tr.effects) if (effect.is(pinned)) return effect.value
        if (value && (tr.docChanged || tr.selection)) return null
        return value
      },
      provide: (field) => cm.view.showTooltip.from(field),
    })

    async function openPinned(
      view: EditorView,
      spot: { from: number; to: number; ask: string },
    ): Promise<void> {
      const head = view.state.selection.main.head
      const dom = await askSignature(view, spot.to, spot.ask)
      // Пока ходили к ядру, каретка могла уехать — тогда закреплять нечего:
      // окно встало бы у имени, на которое человек уже не смотрит.
      if (!dom || view.state.selection.main.head !== head) return
      // И заодно убираем ту, что уже выехала по наведению: пока мы ходили к
      // ядру, указатель стоял на том же имени и успел позвать свою.
      view.dispatch({
        effects: [cm.view.closeHoverTooltips, pinned.of(signatureTooltip(spot.from, spot.to, dom))],
      })
    }

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
     * «веду мышь мимо». Закрывает подсказку сам CodeMirror, когда указатель
     * ушёл И с имени, и с окна: пока мышь над окном, оно живо, и справку можно
     * крутить колесом и выделять — это и значит «досягаемая».
     */
    const signatureHover = cm.view.hoverTooltip(
      async (view, pos) => {
        const ask = handlers.inspect
        // В ячейке, которую не дают править, справки нет: чужой лист под
        // замком и закончившееся занятие — это чтение, и читать через них
        // состояние общего ядра нельзя (то же правило, что у дополнения).
        if (!ask || view.state.readOnly) return null
        /*
         * Одна справка на экран.
         *
         * Пока висит закреплённая (Shift+Tab), наведение молчит. Иначе
         * получалось две: нажав Shift+Tab, человек не убирает руку с мыши, и
         * через треть секунды под закреплённым окном выезжало второе — с тем
         * же текстом, но своим. Снято со стенда, не придумано. Закреплённая
         * уходит по Escape, по уехавшей каретке и по первой же правке, и
         * наведение тут же работает снова.
         */
        if (view.state.field(pinnedField, false)) return null
        /*
         * И ничего, если под указателем не то, о чём спрашивают: строка,
         * комментарий, аргумент, собственная переменная. Отказ здесь стоит
         * ровно ноль — ни кадра в сокете, ни вопроса к ядру комнаты (правило и
         * его доводы: lib/hover-target.ts).
         */
        const spot = hoverSpot(cm, view, pos)
        if (!spot) return null
        const dom = await askSignature(view, spot.to, spot.ask)
        return dom ? signatureTooltip(spot.from, spot.to, dom) : null
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
              // Оба вида разом: по наведению и закреплённая Shift+Tab. Какая из
              // них сейчас на экране, Escape не разбирает — он убирает лишнее.
              closeSignature(view)
              return true
            }
            return fire(handlers.onescape)
          },
        },
        {
          /*
           * Shift+Tab — справка у каретки. Или отступ, если справки тут нет.
           *
           * Отказ здесь (`false`) — не отказ от жеста, а пропуск нажатия
           * дальше: ниже по старшинству стоит снятие отступа (lib/indent.ts), и
           * ровно оно и должно срабатывать в строке, где под кареткой не имя.
           * Правило и его цена — у `caretSpot`.
           */
          key: 'Shift-Tab',
          run: (view) => {
            if (!handlers.inspect || view.state.readOnly) return false
            const range = view.state.selection.main
            // Выделение — это про строки целиком: там Shift+Tab сдвигает их, и
            // отнимать у него этот случай нельзя.
            if (!range.empty) return false
            const spot = caretSpot(cm, view, range.head)
            if (!spot) return false
            void openPinned(view, spot)
            return true
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
                // Закреплённая справка (Shift+Tab) — своим полем, рядом: см.
                // `pinnedField`.
                pinnedField,
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

<!--
  Лекция: три экрана из одного компонента.

  ПРОЕКЦИЯ — то, что видит зал: страница на весь экран, чёрный фон, ничего
  больше. Живёт на компьютере у проектора, и всё, что на ней происходит, приходит
  по сети от планшета в руках преподавателя. Никакой трансляции экрана: по
  проводу едут номер страницы и точки, а не картинка.

  ПУЛЬТ — то, что видит ведущий: та же страница, следующая рядом, часы и
  инструменты. Отсюда листают, отсюда рисуют.

  ЗАЛ — то, что видит студент у себя: та же страница и те же чернила, но без
  пульта. Он может уйти в тетрадь и вернуться — лекция его не держит.

  Один компонент, а не три, по той же причине, по которой чернила рисует один
  код: разойдясь, они покажут ведущему одно, а залу другое, и заметить это можно
  будет только в аудитории.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import { untrack } from 'svelte'
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  import Icon from '@/components/ui/Icon.svelte'
  import { api } from '@/lib/api'
  import { fullscreenNow, fullscreenPossible, goFullscreen } from '@/lib/fullscreen'
  import { loadPdf } from '@/lib/pdf.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import type { LectureState } from '@shared/lecture'
  import { baseOf } from '@shared/paths'
  import { actsAfterClass } from '@shared/rules'
  import ConsoleLink from './ConsoleLink.svelte'
  import InkLayer from './InkLayer.svelte'
  import LecturePage from './LecturePage.svelte'
  import NotesPad from './NotesPad.svelte'
  import { INKS } from './pult'

  interface Props {
    /*
     * Не `state`: рядом живут руны, а `$state` в теле компонента, где есть
     * переменная с таким именем, читается как подписка на хранилище `$state`.
     * Компилятор скажет об этом невнятно, а имя всё равно было хуже.
     */
    lecture: LectureState
    /** Кем этот экран смотрит на лекцию. */
    role: 'presenter' | 'audience' | 'projection'
    /** Выйти из проекции обратно в комнату. */
    onleave?: () => void
    /** Отправить ЭТОТ экран на проектор. */
    onproject?: () => void
    /** Выйти из общей страницы в свою читалку. Ведущему не предлагается. */
    onsolo?: () => void
  }

  let { lecture, role, onleave, onproject, onsolo }: Props = $props()

  const session = getSessionState()

  let doc = $state<PDFDocumentProxy | null>(null)
  let failureRender = $state<() => string | null>(() => null)
  const failure = $derived(failureRender())
  let pages = $state(0)

  /**
   * Путь документа — ОТДЕЛЬНЫМ значением, а не чтением из `lecture` внутри
   * эффекта.
   *
   * `lecture` приезжает с сервера целым объектом и подменяется на каждое
   * изменение состояния — на каждое перелистывание в том числе. Эффект,
   * читавший `lecture.file` у себя внутри, подписывался тем самым на весь
   * объект: страница сменилась — эффект перезапущен, прежний документ
   * уничтожен (`loadingTask.destroy()`), новый качается с нуля. То есть каждое
   * нажатие «вперёд» заново скачивало и разбирало ВСЮ колоду, и до самой
   * страницы дело доходило через полсекунды на пустом стенде — а на живой
   * лекции с тридцатью мегабайтами через ретранслятор это и есть те самые
   * «пять секунд или не догоняет вообще».
   *
   * `$derived` от строки пути пропускает дальше только настоящую смену
   * документа: значение сравнивается, а не ссылка.
   */
  const file = $derived(lecture.file)

  /** Счётчик попыток открыть: «Попробовать снова» и повтор на проекции. */
  let attempt = $state(0)

  $effect(() => {
    const path = file
    void attempt
    /*
     * Сбрасываем ВСЁ, а не один `doc`.
     *
     * `failure` не снимался нигде и ни от чего: одна неудачная загрузка
     * прибивала экран к ветке ошибки навсегда — даже смена документа лекции не
     * возвращала картинку, потому что новый PDF приезжал в `doc`, а разметка
     * всё равно показывала ошибку. Больнее всего на проекции: там кнопок нет
     * намеренно, и зал до конца пары читает «Не удалось открыть документ
     * лекции» вместо слайдов. `pages` от прошлой колоды к тому же держал
     * неверную верхнюю границу шага.
     */
    doc = null
    pages = 0
    failureRender = () => (null)
    let dropped = false
    let opened: PDFDocumentProxy | null = null
    void loadPdf()
      .then((pdf) => pdf.open(api.fileRaw(session.session.id, path), session.token))
      .then((ready) => {
        opened = ready
        // Документ, доехавший после ухода, уносит с собой воркер pdf.js и его
        // буферы: без `destroy` каждый уход посреди загрузки — живой воркер до
        // конца пары.
        if (dropped) {
          void ready.loadingTask.destroy()
          return
        }
        doc = ready
        pages = ready.numPages
      })
      .catch(() => {
        if (!dropped) failureRender = () => (tr('room.ui.303'))
      })
    return () => {
      dropped = true
      void opened?.loadingTask.destroy()
    }
  })

  /**
   * Проекция пробует снова сама.
   *
   * У неё нет ни одной кнопки — и это решение, а не упущение: кнопку на
   * проекции видит зал. Значит и повторять за неё некому: ноутбук у проектора
   * стоит открытым до пары, сеть моргает в момент старта, и без этого таймера
   * лекция идёт с пульта, а зал сорок минут смотрит на строку ошибки.
   */
  const RETRY_MS = 5000
  $effect(() => {
    if (failure === null || role !== 'projection') return
    const again = window.setTimeout(() => (attempt += 1), RETRY_MS)
    return () => window.clearTimeout(again)
  })

  /* ------------------------------------------------------------ пульт */

  /*
   * Цвета пера — те же четыре, что и на пульте, и из одного места (`./pult`).
   * Копия здесь уже разошлась с пультом однажды: там синее пера объясняли
   * измеренными числами и убирали, здесь оно стояло вторым кружком. Зал при
   * этом один и тот же, и проектор один и тот же.
   */
  let tool = $state<'pen' | 'laser' | 'off'>('off')
  let ink = $state(INKS[0].color)

  const presenting = $derived(role === 'presenter')
  const page = $derived(lecture.page)
  /** Хостовое здесь только заметки и ссылка-ключ: лекцию может вести и студент. */
  const host = $derived(session.me.role === 'host')

  /**
   * Занятие кончилось — пульт стал преподавательским.
   *
   * Лекцию звонок НЕ гасит: сорок минут разметки живут только в памяти сервера,
   * истории у них нет, и стирать их концом пары нельзя. Но управлять ею
   * студент, который её вёл, больше не может — страницу, чернила и паузу сервер
   * от него теперь не примет (control.ts), — поэтому здесь гаснет весь пульт
   * разом: и полоса, и перо, и клавиатура. Кнопка, которая молчит, читается как
   * поломка, а мазок, которого не видит зал, — как поломка вдвойне.
   *
   * Правилом `board` это не выражается: оно про то, кто ставит документ на
   * общий экран, а не про то, кто ведёт уже начатую лекцию. Значит, та же
   * `actsAfterClass`, что и у сервера.
   */
  const acts = $derived(actsAfterClass(session.finished, session.me.role))
  const pult = $derived(presenting && acts)

  /**
   * «Стереть» и «Закончить» спросили и ждут второго нажатия.
   *
   * Снимаются сменой страницы: вопрос, оставшийся висеть на следующем слайде,
   * превращает первое же нажатие в стирание без вопроса.
   *
   * Два вопроса разом не висят: горящих красным кнопки в полосе тогда две, и
   * «да» уходит не в ту.
   */
  let wipeAsked = $state(false)
  let stopAsked = $state(false)
  $effect(() => {
    void page
    untrack(() => {
      wipeAsked = false
      stopAsked = false
    })
  })

  /**
   * РАЗРУШАЮЩЕЕ БЕЗ СВЯЗИ НЕ УХОДИТ В ОЧЕРЕДЬ.
   *
   * `session.send` на закрытом сокете кладёт кадр в очередь управления, и он
   * доедет — через полминуты, когда вернётся вайфай. Для «Отменить», «Стереть»
   * и «Закончить» это худший из исходов: на экране всё осталось на месте,
   * человек пошёл дальше, а посреди следующего слайда чернила у зала пропали
   * сами, без единого нажатия. Отложенное разрушение хуже отказа — тем же
   * доводом от этого защищён пульт (см. `undoStroke` в ConsoleView).
   */
  function destructive(): boolean {
    if (session.connected) return true
    refuse(tr('room.ui.304'))
    return false
  }

  function askWipe(): void {
    if (!destructive()) {
      wipeAsked = false
      return
    }
    if (!wipeAsked) {
      stopAsked = false
      wipeAsked = true
      return
    }
    wipeAsked = false
    session.send({ t: 'ink:clear', page })
  }

  function undoStroke(): void {
    if (!destructive()) return
    session.send({ t: 'ink:undo', page })
  }

  /**
   * «Закончить» — второе нажатие, как у «Стереть», и по той же причине.
   *
   * Сервер на `lecture:stop` удаляет комнату лекции целиком: проекция гаснет,
   * а чернила ВСЕХ страниц стираются у всех и безвозвратно — истории у них
   * нет. Кнопка при этом стояла вплотную к «На проектор», то есть к той, что
   * ведущий с ноутбука нажимает в начале пары: промах на одну кнопку уносил
   * сорок минут разметки. На пульте тот же поступок спрашивает отдельной
   * строкой в листе «Ещё».
   */
  function askStop(): void {
    if (!session.connected) {
      // Своими словами: «ничего не стёрлось» здесь сказало бы не о том.
      stopAsked = false
      refuse(tr('room.ui.255'))
      return
    }
    if (!stopAsked) {
      wipeAsked = false
      stopAsked = true
      return
    }
    stopAsked = false
    session.send({ t: 'lecture:stop' })
  }

  /**
   * Куда мы уже попросили уйти.
   *
   * Считать следующую страницу от `lecture.page` — то есть от того, что УЖЕ
   * подтвердил сервер, — можно ровно при одном условии: между двумя нажатиями
   * успевает обернуться сокет. На стенде семь нажатий стрелкой давали одну
   * страницу вместо семи: все семь долетали до окна, все семь считали «текущая
   * плюс один» от одной и той же текущей, и сервер, которому шестью подряд
   * назвали одно и то же число, честно отвечал «я уже там». На паре это
   * выглядит как залипшая стрелка: жмёшь десять раз, проектор двигается на
   * одну.
   *
   * Поэтому шаг считается от СВОЕГО намерения, а не от чужого подтверждения.
   * Намерение живёт до тех пор, пока сервер его не догонит или пока страницу
   * не сменит кто-то другой, — за этим следит эффект ниже.
   */
  let wanted = $state<number | null>(null)
  /**
   * Страницы, которые мы успели попросить, пока намерение не сбылось.
   *
   * Без этого списка «сервер встал не на ту страницу, что мы хотим» читается
   * как «листает кто-то другой» — а это чаще всего наш же собственный шаг по
   * дороге: два нажатия подряд просят шестую и седьмую, эхо шестой приходит
   * первым, и намерение на седьмую пришлось бы выбросить, не дождавшись. Не
   * руна: её никто не рисует, она только сверяется.
   */
  let asked = new Set<number>()

  /*
   * Намерение снимается, когда сервер его подтвердил — и когда страницу увёл
   * кто-то другой. Второе важнее первого: если ведущий листает с планшета, а
   * это окно помнит своё старое «хочу на шестую», то следующая стрелка уедет
   * от шестой, а не от той, что видит зал, — и два экрана разойдутся молча.
   * Чужой ход всегда главнее нашего намерения.
   */
  $effect(() => {
    const at = lecture.page
    untrack(() => {
      if (wanted === null) return
      if (at === wanted) {
        // Догнал: намерение сбылось.
        wanted = null
        asked.clear()
      } else if (!asked.has(at)) {
        /*
         * Страница, которой мы не просили, — значит листает кто-то другой:
         * второй преподаватель или планшет того же человека. Чужой ход всегда
         * главнее нашего намерения; иначе следующая стрелка уедет от нашей
         * забытой седьмой, а не от той, что видит зал, и два экрана разойдутся
         * молча — то есть случится ровно то, чего в лекции быть не должно.
         */
        wanted = null
        asked.clear()
      }
    })
  })

  /**
   * НАМЕРЕНИЕ НЕ ВЕЧНО: повторяем просьбу и сдаёмся.
   *
   * Эффект выше снимает `wanted` только эхом сервера, а эхо может не прийти
   * вовсе: сокет закрылся сразу после `send` (он проверяет лишь readyState),
   * или сервер отверг кадр в окно между звонком и приходом «занятие
   * закончено». Тогда намерение висит навсегда, `turn()` считает от него, и
   * следующая стрелка просит `wanted + 1` — зал прыгает через слайд.
   *
   * Поэтому здесь то же, что у пульта (ConsoleView): раз в 600 мс повторяем
   * просьбу — `lecture:page` идемпотентен, сервер, уже стоящий на этой
   * странице, просто промолчит, — а после пяти безответных попыток намерение
   * снимается и шаг снова считается от того, что видит зал. Без связи
   * попытки не считаются и не уходят: тратить их на закрытый сокет значило бы
   * сдаться ровно тогда, когда сдаваться не за что.
   *
   * `wanted` читается ЗДЕСЬ отслеживаемо (в отличие от эффекта выше): таймер
   * обязан завестись на само намерение, а не только на ответ сервера.
   */
  const AGAIN_MS = 600
  const AGAIN_MAX = 5
  $effect(() => {
    const at = lecture.page
    const mine = wanted
    if (mine === null || mine === at) return
    let tries = 0
    const again = window.setInterval(() => {
      if (!session.connected) return
      tries += 1
      if (tries > AGAIN_MAX) {
        wanted = null
        asked.clear()
        return
      }
      session.send({ t: 'lecture:page', page: mine })
    }, AGAIN_MS)
    return () => window.clearInterval(again)
  })

  /**
   * Слайд, на который возвращаемся с чистого листа: последний, что видел зал.
   *
   * Своего счёта листам здесь нет (его ведёт пульт), поэтому «куда вернуться»
   * помнится по самой лекции: единица — на случай, когда этот экран открыли
   * уже на листе.
   */
  let lastSlide = $state(1)
  $effect(() => {
    const at = lecture.page
    untrack(() => {
      if (at > 0) lastSlide = at
    })
  })

  /**
   * Шаг вперёд-назад. Знает про чистые листы — страницы с ОТРИЦАТЕЛЬНЫМ
   * номером (см. shared/lecture.ts).
   *
   * Арифметика «±1» на них мертва в обе стороны: с листа −1 «вперёд» даёт 0,
   * «назад» даёт −2, и то и другое отбрасывалось молча — вместе со стрелками,
   * пробелом и презентационной кликалкой, воткнутой в компьютер у проектора.
   * Вернуть зал на слайды из комнаты было нечем вовсе.
   *
   * Порядок листов — по заведению (−1 первый), как в ленте пульта. «Вперёд» с
   * любого листа возвращает к слайду: сколько листов заведено, знает только
   * пульт, а заводить новый молча — это белое поле у зала посреди фразы.
   */
  function turn(step: -1 | 1): void {
    const from = wanted ?? page
    if (from < 0) {
      go(step === -1 && from < -1 ? from + 1 : lastSlide)
      return
    }
    const next = from + step
    /*
     * Верхняя граница, когда своя копия не открылась (`pages === 0`): на одну
     * страницу дальше той, что зал УЖЕ показывает. Без неё зажатая стрелка
     * гнала залу номера за конец колоды — сервер принимает любой
     * положительный, — и обратно возвращались шестьюдесятью нажатиями. Та же
     * граница и по той же причине стоит в пульте (ConsoleView.goTo).
     */
    const top = pages > 0 ? pages : Math.max(page, 1) + 1
    if (next < 1 || next > top) return
    go(next)
  }

  function go(next: number): void {
    if (next === (wanted ?? page)) return
    wanted = next
    asked.add(next)
    session.send({ t: 'lecture:page', page: next })
  }

  /*
   * Клавиатура пульта: стрелки и пробел листают, B гасит экран, Z убирает
   * последний штрих, E спрашивает про стирание страницы. Ровно то, что
   * нажимают, не глядя, — и то, что шлёт презентационная кликалка, если её
   * воткнуть в компьютер у проектора.
   *
   * Z и E — те же буквы, что на пульте (ConsoleView), и по `code`, а не по
   * `key`: на русской раскладке `key` — это «я» и «у». Раньше их здесь не
   * было вовсе, а комментарий и подпись кнопки про них говорили: человек с
   * ноутбука читал «— Z на пульте», жал Z на этом же экране и не получал
   * ничего.
   */
  /**
   * Свои ли это слайды. Проекция стоит на компьютере у проектора, и обычно это
   * тот же преподаватель, что ведёт с планшета (планшет входит по ключу тем же
   * участником), — тогда клавиатура и кликер, воткнутые в этот компьютер,
   * листают лекцию. Чужую лекцию проекция не листает: сервер такое отбросит, а
   * молчаливое нажатие лучше, чем перелистывание чужого слайда.
   */
  const mine = $derived(lecture.by === session.me.id)

  /* Полный экран проекции — по первому жесту в её окне, см. SessionScreen. */
  let full = $state(fullscreenNow())
  $effect(() => {
    const sync = () => (full = fullscreenNow())
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  })

  function fillScreen(): void {
    if (fullscreenPossible() && !fullscreenNow()) void goFullscreen(document.documentElement)
  }

  /**
   * Отказ слоя чернил — одной строкой на шесть секунд.
   *
   * Отказ бывает один: страница набрала свои шестьсот штрихов, и сервер
   * следующий не примет. Раньше об этом не говорил никто: линия появлялась,
   * четыре секунды жила на досылках и пропадала, а у зала её не было вовсе.
   * Плашки комнаты сюда не годятся — они про сеть и ядро, а это ответ на
   * штрих, и стоять он должен там, где штрих: у листа.
   */
  let refusal = $state<string | null>(null)
  let refusalTimer: number | undefined
  function refuse(says: string): void {
    refusal = says
    window.clearTimeout(refusalTimer)
    refusalTimer = window.setTimeout(() => (refusal = null), 6000)
  }
  $effect(() => () => window.clearTimeout(refusalTimer))

  function onkeydown(event: KeyboardEvent): void {
    if (role === 'projection' && event.code === 'KeyF') {
      event.preventDefault()
      fillScreen()
      return
    }
    // `acts` и на проекции: клавиатура у проектора листает лекцию так же, как
    // пульт, и после звонка сервер её так же не послушает.
    if (!pult && !(role === 'projection' && mine && acts)) return
    // Цель бывает и не элементом (документ, окно): у них нет `closest`.
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('input, textarea, [contenteditable]')) return
    if (event.key === 'Escape' && (wipeAsked || stopAsked)) {
      // Заданный вопрос снимается тем же, чем снимают любой вопрос.
      event.preventDefault()
      wipeAsked = false
      stopAsked = false
      return
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault()
      turn(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault()
      turn(-1)
    } else if (event.code === 'KeyB') {
      event.preventDefault()
      session.send({ t: 'lecture:blank', on: !lecture.blank })
    } else if (event.code === 'KeyZ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Только с пульта: чернила рисует планшет, а клавиатура у проектора
      // листает. Отменять чужой штрих оттуда незачем.
      if (!pult) return
      event.preventDefault()
      undoStroke()
    } else if (event.code === 'KeyE' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (!pult) return
      event.preventDefault()
      /*
       * Автоповтор сюда приходит десятками, и без этой строки зажатая E
       * задавала вопрос и сама же на него отвечала — то есть стирала страницу
       * удержанием клавиши.
       */
      if (event.repeat) return
      askWipe()
    }
  }

  /*
   * Трекингов здесь ровно два, и разница между ними носит смысл: 0.14em
   * (`tracking-label`) называет ДЕЙСТВИЕ — то, что нажимают, — а 0.2em
   * (`tracking-section`) называет МЕСТО: «дальше», «пауза». Стояли на одном и
   * том же 11-пиксельном капсе четыре разных трекинга (0.08 на кнопках, 0.16 на
   * состоянии проекции, 0.2 на именах областей); различить их читатель не может,
   * а удержать согласованными не может никто, и через месяц они разъезжаются.
   */
  /*
   * Нажатие выписано свойствами, а не помощником `.press`: утилита
   * `transition-*` переписывает `transition-property` целиком, и transform из
   * помощника в этот список бы не попал — та же ловушка, что у замка ячейки и
   * у клавиш пульта. Полоса лекции — единственный орган управления ведущего с
   * ноутбука, «Дальше» на ней нажимают полсотни раз за пару, а страница
   * приезжает не мгновенно: 3 % под пальцем — то самое подтверждение, что
   * нажатие услышано, которого у неё не было, пока она держала один
   * `transition-colors`.
   */
  const TOOL =
    'flex h-8 items-center gap-1.5 px-2.5 text-2xs font-bold uppercase tracking-label ' +
    'transition-[color,background-color,border-color,transform] duration-press ease-out ' +
    'enabled:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-inset focus-visible:ring-accent/40'
</script>

<svelte:window {onkeydown} />

{#if role === 'projection'}
  <!--
    Проекция. Чёрный фон, ничего кроме страницы — и ни одной кнопки: всё, что
    может понадобиться в аудитории, уже есть в руках у ведущего. Выход спрятан
    под Escape и под щелчок в углу: случайное нажатие мышью по проекции не
    должно прерывать лекцию.
  -->
  <!--
    Щелчок по проекции — полный экран. Проекция теперь открывается отдельным
    окном, а полный экран в чужом окне не попросить: браузер даёт его только
    по жесту в самом окне. Первое, что делают с новым окном, — щёлкают в него,
    и этого достаточно. Кнопки нет намеренно: любая кнопка на проекции —
    кнопка, которую видит зал.
  -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="fixed inset-0 z-[100] flex flex-col bg-black" onclick={fillScreen}>
    {#if lecture.blank}
      <div class="flex flex-1 items-center justify-center">
        <span class="text-2xs uppercase tracking-section text-white/30">{tr('room.ui.276')}</span>
      </div>
    {:else if failure}
      <div class="flex flex-1 items-center justify-center px-8 text-center text-ui text-white/70">
        {failure}
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 p-4">
        <LecturePage {doc} {page}>
          {#snippet over(size)}
            <InkLayer
              {page}
              live={false}
              tool="off"
              color={lecture.color}
              width={0.004}
              w={size.w}
              h={size.h}
            />
          {/snippet}
        </LecturePage>
      </div>
    {/if}
    <button
      type="button"
      class="absolute right-0 top-0 h-12 w-12 text-white/0 transition-colors duration-100 hover:text-white/40 focus-visible:outline-none"
      title={tr('room.ui.277')}
      aria-label={tr('room.ui.278')}
      onclick={(event) => {
        event.stopPropagation()
        onleave?.()
      }}
    >
      <Icon name="x" size={16} />
    </button>
    {#if !full && fullscreenPossible()}
      <!--
        Подсказка живёт только ПОКА окно не во весь экран — то есть пока
        проекцию ещё настраивают, а не показывают залу. Стрелки названы
        только тому, чьи это слайды: чужие она не листает.
      -->
      <p class="pointer-events-none absolute bottom-4 right-5 text-2xs uppercase tracking-label text-white/35">
        {mine ? tr('room.ui.279') : ''}{tr('room.ui.280')} </p>
    {/if}
  </div>
{:else}
  <section class="flex min-h-0 flex-1 flex-col bg-surface">
    {#if pult}
      <!--
        Пульт. Полоса под вкладками — там же, где у тетради Run All: у каждой
        вкладки своя, и она всегда под ней.
      -->
      <div class="flex h-[34px] shrink-0 items-stretch border-b border-line bg-canvas">
        <button
          type="button"
          class="{TOOL} w-10 justify-center text-muted hover:text-ink disabled:opacity-30"
          disabled={page > 0 && page <= 1}
          aria-label={tr('room.ui.174')}
          onclick={() => turn(-1)}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <span class="flex items-center px-1 font-mono text-2xs tabular-nums text-ink">
          {#if page < 0}{tr('room.ui.159')}{:else}{page} / {pages || '—'}{/if}
        </span>
        <button
          type="button"
          class="{TOOL} w-10 justify-center text-muted hover:text-ink disabled:opacity-30"
          disabled={page > 0 && pages > 0 && page >= pages}
          aria-label={tr('room.ui.175')}
          onclick={() => turn(1)}
        >
          <Icon name="chevron-right" size={14} />
        </button>

        <span class="my-2 w-px bg-line" aria-hidden="true"></span>

        <!-- Перо. Цвет выбирается тем же нажатием, что и само перо: два
             отдельных переключателя ради четырёх цветов — это два вопроса там,
             где человек задаёт один. -->
        {#each INKS as choice (choice.color)}
          <button
            type="button"
            class="press flex w-8 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            title={tr('room.extra.83', { p0: choice.short })}
            aria-label={tr('room.extra.83', { p0: choice.short })}
            aria-pressed={tool === 'pen' && ink === choice.color}
            onclick={() => {
              tool = 'pen'
              ink = choice.color
            }}
          >
            <!--
              Кружок растёт от СОСТОЯНИЯ, и растёт мгновенно: состояние
              приходит само, и анимировать его — значит рисовать его позже, чем
              оно случилось (та же причина, по которой не анимируется полоса
              «включено» на клавише пульта). Transform отдан пальцу: `press` на
              самой кнопке, взятый именем — других утилит перехода на ней нет,
              и переписывать `transition-property` некому.
            -->
            <span
              class="h-4 w-4 rounded-full border-2 {tool === 'pen' && ink === choice.color
                ? 'scale-110 border-ink'
                : 'border-transparent'}"
              style={`background:${choice.color}`}
            ></span>
          </button>
        {/each}

        <button
          type="button"
          class="{TOOL} {tool === 'laser' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}"
          aria-pressed={tool === 'laser'}
          title={tr('room.ui.282')}
          onclick={() => (tool = tool === 'laser' ? 'off' : 'laser')}
        >
          <Icon name="bolt" size={12} /> {tr('room.ui.165')} </button>
        <button
          type="button"
          class="{TOOL} {tool === 'off' ? 'bg-raised text-ink' : 'text-muted hover:text-ink'}"
          aria-pressed={tool === 'off'}
          title={tr('room.ui.283')}
          onclick={() => (tool = 'off')}
        > {tr('room.ui.284')} </button>

        <span class="my-2 w-px bg-line" aria-hidden="true"></span>

        <button
          type="button"
          class="{TOOL} text-muted hover:text-ink"
          title={tr('room.ui.285')}
          aria-label={tr('room.ui.166')}
          onclick={undoStroke}
        >
          <Icon name="undo" size={12} /> {tr('room.ui.286')} </button>
        <!--
          «Стереть» спрашивает, и это не вежливость: она стоит в одном ряду с
          «Пауза», а промах мышью на одну кнопку влево уносил всю разметку
          слайда у зала и на проекторе мгновенно и безвозвратно — чернила лекции
          живут только в памяти сервера, истории у них нет. На пульте ту же
          операцию защищают удержанием ластика и отдельным вопросом.
        -->
        <button
          type="button"
          class="{TOOL} {wipeAsked ? 'bg-danger/10 text-danger' : 'text-muted hover:text-ink'}"
          title={tr('room.ui.287')}
          onclick={askWipe}
          onblur={() => (wipeAsked = false)}
        >
          <Icon name="eraser" size={12} />
          {wipeAsked ? tr('room.ui.288') : tr('room.ui.221')}
        </button>
        <button
          type="button"
          class="{TOOL} {lecture.blank ? 'bg-ink text-canvas' : 'text-muted hover:text-ink'}"
          aria-pressed={lecture.blank}
          title={tr('room.ui.290')}
          onclick={() => session.send({ t: 'lecture:blank', on: !lecture.blank })}
        > {tr('room.ui.291')} </button>

        <span class="flex-1"></span>

        <!--
          Пульт передаёт ПРЕПОДАВАТЕЛЬ. Вести лекцию может и студент — правило
          `board: 'room'` это разрешает, — но `/handoff` ему отвечает 403, и
          кнопка, у которой один исход и тот отказ, здесь не стоит.
        -->
        {#if host}
          <ConsoleLink class="{TOOL} text-muted hover:text-ink" />
        {/if}
        {@render projectButton()}
        <!--
          Волосок между «На проектор» и «Закончить» — не украшение: это две
          соседние кнопки, из которых первую нажимают в начале пары, а вторая
          необратима. Вопрос вторым нажатием держит основную защиту, разрыв
          держит палец.
        -->
        <span class="my-2 w-px bg-line" aria-hidden="true"></span>
        <button
          type="button"
          class="{TOOL} {stopAsked ? 'bg-danger/10 text-danger' : 'text-danger hover:bg-danger/10'}"
          title={tr('room.ui.293')}
          onclick={askStop}
          onblur={() => (stopAsked = false)}
        >
          {stopAsked ? tr('room.ui.294') : tr('room.ui.230')}
        </button>
      </div>
    {:else if presenting}
      <!--
        Лекцию вёл он, а звонок уже был. Одна строка вместо полосы: лекция на
        экране осталась — и страница, и чернила, — а пульт стал
        преподавательским. Молча снятые клавиши читались бы как поломка
        планшета посреди аудитории.
      -->
      <div
        class="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-canvas px-4 text-2xs text-muted"
      >
        <!-- Спокойная точка, не тревожная: это решение преподавателя, а не
             поломка, и лекция на экране как стояла, так и стоит. -->
        <span class="h-1.5 w-1.5 rounded-full bg-accent"></span> {tr('room.ui.295')} <span class="flex-1"></span>
        <span class="font-mono tabular-nums">
          {#if page < 0}{tr('room.ui.296')}{:else}{page} / {pages || '—'}{/if}
        </span>
        {@render projectButton()}
      </div>
    {:else}
      <!-- Залу — одна строка: кто ведёт и что идёт. Управления нет вовсе. -->
      <div
        class="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-canvas px-4 text-2xs text-muted"
      >
        <span class="h-1.5 w-1.5 rounded-full" style={`background:${lecture.color}`}></span> {tr('room.ui.297')} {lecture.byName}
        <span class="text-faint">·</span>
        <span class="font-mono">{baseOf(lecture.file)}</span>
        <span class="flex-1"></span>
        <span class="font-mono tabular-nums">
          {#if page < 0}{tr('room.ui.296')}{:else}{page} / {pages || '—'}{/if}
        </span>
        {#if onsolo}
          <!--
            Отойти от общей страницы — и вернуться. За преподавателем в этом
            продукте ИДУТ, а не привязаны к нему: студент, которому нужно
            перечитать предыдущий слайд, не должен для этого ждать конца лекции.
          -->
          <button
            type="button"
            class="{TOOL} -my-2 text-muted hover:text-ink"
            title={tr('room.ui.298')}
            onclick={() => onsolo?.()}
          > {tr('room.ui.299')} </button>
        {/if}
        {@render projectButton()}
      </div>
    {/if}

    {#if failure}
      <!--
        Документ не открылся — У НАС: истёк токен, лопнула сеть, битый кэш. У
        проектора он при этом, скорее всего, открыт, и лекцию можно довести по
        кнопкам и по заметкам. Отнимать у ведущего то, что ещё работает,
        из-за собственной неудачи — худшее, что этот экран может сделать.
      -->
      <div class="flex min-h-0 flex-1 gap-3 p-3">
        <div class="flex min-w-0 flex-1 flex-col items-start gap-3">
          <p class="text-ui text-muted">{failure}</p>
          <!-- Повтор руками: сеть, моргнувшая в момент старта, не повод
               доводить пару без слайдов у себя на экране. -->
          <button type="button" class="btn-outline h-8 px-3 text-2xs" onclick={() => (attempt += 1)}> {tr('room.ui.191')} </button>
        </div>
        {#if presenting && host}
          <aside class="hidden w-[28%] shrink-0 flex-col lg:flex">
            <NotesPad file={lecture.file} {page} compact />
          </aside>
        {/if}
      </div>
    {:else}
      <div class="relative flex min-h-0 flex-1 gap-3 p-3">
        <LecturePage {doc} {page}>
          {#snippet over(size)}
            <InkLayer
              {page}
              live={pult}
              tool={pult ? tool : 'off'}
              color={ink}
              width={0.004}
              w={size.w}
              h={size.h}
              onrefuse={refuse}
            />
          {/snippet}
        </LecturePage>
        {#if refusal}
          <!-- У нижней кромки слева: туда не смотрят, пока рисуют, и туда
               смотрят, когда рисование не получилось. -->
          <div
            class="pointer-events-none absolute bottom-4 left-4 z-10 flex h-7 items-center bg-ink px-3"
            aria-live="polite"
          >
            <span class="text-2xs font-bold uppercase tracking-label text-canvas">{refusal}</span>
          </div>
        {/if}

        {#if pult && (host || (page > 0 && pages > page))}
          <!--
            Колонка ведущего — и есть Speaker View: что будет дальше и что про
            это сказать. Знать это, не заглядывая вперёд на проекторе.

            «Дальше» показывается, только когда следующая страница есть, а
            заметки — всегда: на последнем слайде говорить ещё нужно, и лента,
            исчезнувшая именно там, читалась бы как поломка. Заметкам отдана
            нижняя, большая половина колонки: их читают, подняв голову от
            экрана, а на эскиз смотрят краем глаза.

            Ни залу, ни проекции заметки не достаются ни в каком виде — ни
            пустыми, ни свёрнутыми: то, что «просто пустое», однажды окажется
            непустым, и увидит это вся аудитория.
          -->
          <aside class="hidden w-[28%] shrink-0 flex-col gap-2 lg:flex">
            {#if page > 0 && pages > page}
              <span class="text-micro font-bold uppercase tracking-section text-muted"> {tr('room.ui.197')} </span>
              <div class="flex min-h-0 basis-[42%]">
                <LecturePage {doc} page={page + 1} dim />
              </div>
            {/if}
            <NotesPad file={lecture.file} {page} compact />
          </aside>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<!--
  «На проектор» — одна кнопка на два места: она есть и у ведущего, и у зала, и
  это не щедрость. Проекцию открывают на ЧУЖОЙ машине — той, что воткнута в
  проектор, — и человек за ней чаще всего не ведущий: лаборант, студент,
  кто угодно, кто вошёл в комнату по той же ссылке. Требовать для этого пульт
  значило бы требовать, чтобы преподаватель шёл к кафедральному ноутбуку.
-->
{#snippet projectButton()}
  {#if onproject}
    <button
      type="button"
      class="{TOOL} text-muted hover:text-ink"
      title={tr('room.ui.300')}
      onclick={() => onproject?.()}
    >
      <Icon name="board" size={12} /> {tr('room.ui.301')} </button>
  {/if}
{/snippet}

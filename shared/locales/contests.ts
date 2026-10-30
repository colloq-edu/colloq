import type { MessageCatalog } from '../i18n-types.js'
import { contestServerMessages } from './contests-server.js'

/**
 * Words of the contests — the participant's pages (`/a/<slug>`, the contests
 * on the `/k` list) and the words both sides share (verdicts, phases, rules).
 *
 * Spread into the competitions catalog rather than an area of its own: the
 * `/k` chunk, the panel, the server and the tests get them with no new
 * wiring, the way the packages' words travel (dependencies.ts). The panel's
 * own words are in contests-admin.ts, the doors' refusals in
 * contests-server.ts.
 *
 * The Russian lines follow the mockups (Paper «19 · Контесты»), including «ё».
 * The two-letter verdict codes (OK, WA, TL…) are never translated: they are
 * the judge's international vocabulary, and a student searches for «WA on
 * test 3», not for its translation.
 */
export const contestMessages: MessageCatalog = {
  ...contestServerMessages,

  /* A verdict in words, beside its code (K1, K2, A4). */
  'contests.verdict.OK': { ru: 'Принято', en: 'Accepted' },
  'contests.verdict.WA': { ru: 'Неправильный ответ', en: 'Wrong answer' },
  'contests.verdict.TL': { ru: 'Превышено время', en: 'Time limit exceeded' },
  'contests.verdict.ML': { ru: 'Превышена память', en: 'Memory limit exceeded' },
  'contests.verdict.RE': { ru: 'Ошибка выполнения', en: 'Runtime error' },
  'contests.verdict.OL': { ru: 'Слишком большой вывод', en: 'Output limit exceeded' },
  'contests.verdict.CE': { ru: 'Ошибка компиляции', en: 'Compilation error' },
  'contests.verdict.SE': { ru: 'Ошибка проверки', en: 'Judge error' },

  /* The phase of a contest — the badge in the list and the header. */
  'contests.phase.draft': { ru: 'ЧЕРНОВИК', en: 'DRAFT' },
  'contests.phase.soon': { ru: 'СКОРО', en: 'SOON' },
  'contests.phase.open': { ru: 'ИДЁТ', en: 'LIVE' },
  'contests.phase.over': { ru: 'ЗАВЕРШЕНО', en: 'FINISHED' },

  /* The rules, as the header's line and the editor's choice say them. */
  'contests.rules.icpc': { ru: 'правила ICPC', en: 'ICPC rules' },
  'contests.rules.ioi': { ru: 'правила IOI', en: 'IOI rules' },

  'contests.title': { ru: 'Контесты', en: 'Contests' },

  /* ------------------------------------------------- header (K1–K3, K5) */

  'contests.p.kind': { ru: 'Контест', en: 'Contest' },
  'contests.p.problemsCount': {
    ru: { one: '{count} задача', few: '{count} задачи', many: '{count} задач', other: '{count} задачи' },
    en: { one: '{count} problem', other: '{count} problems' },
  },
  'contests.p.entrants': {
    ru: { one: '{count} участник', few: '{count} участника', many: '{count} участников', other: '{count} участника' },
    en: { one: '{count} participant', other: '{count} participants' },
  },
  'contests.p.penaltyLine': { ru: 'штраф {minutes} мин за попытку', en: '{minutes} min penalty per attempt' },
  'contests.p.of': { ru: '{value} из {total}', en: '{value} of {total}' },
  'contests.p.toStart': { ru: 'ДО НАЧАЛА', en: 'STARTS IN' },
  'contests.p.toEnd': { ru: 'ДО КОНЦА', en: 'ENDS IN' },
  'contests.p.solvedLabel': { ru: 'РЕШЕНО', en: 'SOLVED' },
  'contests.p.pointsLabel': { ru: 'БАЛЛЫ', en: 'POINTS' },
  'contests.p.placeLabel': { ru: 'ВАШЕ МЕСТО', en: 'YOUR PLACE' },
  'contests.p.upsolving': { ru: 'ДОРЕШИВАНИЕ', en: 'UPSOLVING' },
  'contests.p.back': { ru: '‹ Соревнования', en: '‹ Competitions' },
  'contests.p.tabProblems': { ru: 'Задачи', en: 'Problems' },
  'contests.p.tabSubmissions': { ru: 'Посылки', en: 'Submissions' },
  'contests.p.tabLeaderboard': { ru: 'Лидерборд', en: 'Leaderboard' },
  'contests.p.tabQuestions': { ru: 'Вопросы', en: 'Questions' },
  'contests.p.tabsLabel': { ru: 'Разделы контеста', en: 'Contest sections' },
  // Said by the dot beside «Вопросы» to a screen reader: the dot itself says nothing.
  'contests.p.unread': { ru: 'есть новые ответы', en: 'new answers' },
  'contests.p.streamLost': {
    ru: 'Живое обновление прервалось — страница обновляется раз в несколько секунд.',
    en: 'Live updates broke off — the page refreshes every few seconds.',
  },

  /* --------------------------------------------- rail of letters (K1, K5) */

  'contests.p.railTitle': { ru: 'ЗАДАЧИ', en: 'PROBLEMS' },
  'contests.p.intro': { ru: 'О контесте', en: 'About' },
  'contests.p.railLegendIcpc': {
    ru: 'Зелёная буква — решено, число — сколько попыток не прошло до этого.',
    en: 'A green letter is solved; the number is how many attempts failed before it.',
  },
  'contests.p.railLegendIoi': {
    ru: 'Число — лучшие баллы по задаче, зелёная буква — полный балл.',
    en: 'The number is your best score on the problem; a green letter is the full score.',
  },
  'contests.p.railSolved': { ru: 'решено', en: 'solved' },
  'contests.p.railPending': { ru: 'проверяется', en: 'being judged' },
  'contests.p.railUntried': { ru: 'ещё не отправляли', en: 'not tried yet' },
  'contests.p.problemName': { ru: 'Задача {letter}: {title}', en: 'Problem {letter}: {title}' },
  'contests.p.testN': { ru: 'тест {n}', en: 'test {n}' },

  /* ---------------------------------------------------- statement (K1, K5) */

  'contests.p.limitTime': { ru: 'Время', en: 'Time' },
  'contests.p.limitMemory': { ru: 'Память', en: 'Memory' },
  'contests.p.limitIo': { ru: 'Ввод и вывод', en: 'Input and output' },
  'contests.p.ioStandard': { ru: 'стандартные', en: 'standard' },
  'contests.p.limitChecker': { ru: 'Проверка', en: 'Checking' },
  'contests.p.checker.tokens': { ru: 'по словам', en: 'word by word' },
  'contests.p.checker.lines': { ru: 'по строкам', en: 'line by line' },
  'contests.p.checker.float': { ru: 'числа ± {epsilon}', en: 'numbers ± {epsilon}' },
  'contests.p.checker.custom': { ru: 'программой преподавателя', en: "by the teacher's checker" },
  'contests.p.secondsUnit': { ru: '{value} с', en: '{value} s' },
  'contests.p.mbUnit': { ru: '{value} МБ', en: '{value} MB' },
  'contests.p.kbUnit': { ru: '{value} КБ', en: '{value} KB' },
  'contests.p.noStatement': { ru: 'Условие пока не написано.', en: 'The statement has not been written yet.' },
  'contests.p.examples': { ru: 'Примеры', en: 'Examples' },
  'contests.p.input': { ru: 'ВВОД', en: 'INPUT' },
  'contests.p.output': { ru: 'ВЫВОД', en: 'OUTPUT' },
  'contests.p.exampleInput': { ru: 'ПРИМЕР {n} · ВВОД', en: 'EXAMPLE {n} · INPUT' },
  'contests.p.copy': { ru: 'копировать', en: 'copy' },
  'contests.p.copyPart': { ru: 'копировать начало', en: 'copy the start' },
  'contests.p.copied': { ru: 'скопировано', en: 'copied' },
  'contests.p.copyFailed': { ru: 'не скопировалось', en: 'not copied' },
  'contests.p.copyInput': { ru: 'Скопировать ввод примера {n}', en: 'Copy the input of example {n}' },
  'contests.p.copyOutput': { ru: 'Скопировать вывод примера {n}', en: 'Copy the output of example {n}' },
  'contests.p.truncated': {
    ru: 'Пример длинный: здесь и в буфере обмена — только его начало.',
    en: 'A long example: only its start is shown here and copied.',
  },
  'contests.p.samplesFirst': {
    ru: 'Примеры — первые тесты проверки. Если решение ошибётся на примере, в посылке будет видно, что оно вывело.',
    en: 'The examples are the first tests. If a solution fails an example, its submission shows what it printed.',
  },
  'contests.p.samplesAmong': {
    ru: 'Примеры входят в тесты проверки. Если решение ошибётся на примере, в посылке будет видно, что оно вывело.',
    en: 'The examples are among the tests. If a solution fails an example, its submission shows what it printed.',
  },

  /* ----------------------------------------------- solution column (K1, K5) */

  'contests.p.solution': { ru: 'РЕШЕНИЕ', en: 'SOLUTION' },
  'contests.p.draftSaved': { ru: 'черновик сохранён', en: 'draft saved' },
  'contests.p.draftNotSaved': {
    ru: 'черновик не сохраняется в этом браузере',
    en: 'drafts are not kept in this browser',
  },
  'contests.p.language': { ru: 'Язык решения', en: 'Language' },
  'contests.p.languageUnavailable': { ru: '{language} — нет в образе', en: '{language} — not in the image' },
  'contests.p.languageMissing': {
    ru: '{language} нет в образе проверки — выберите другой язык.',
    en: "{language} is missing from the judge's image — choose another language.",
  },
  'contests.p.editorLabel': { ru: 'Решение задачи {letter}', en: 'Solution to problem {letter}' },
  'contests.p.editorPlaceholder': {
    ru: 'Напишите решение здесь или перетащите файл',
    en: 'Write the solution here or drop a file',
  },
  'contests.p.dropBefore': { ru: 'или перетащите файл', en: 'or drop a' },
  'contests.p.dropAfter': { ru: 'сюда', en: 'file here' },
  'contests.p.pickFile': { ru: 'выбрать файл', en: 'choose a file' },
  'contests.p.dropHere': {
    ru: 'Отпустите — файл заменит текст в редакторе',
    en: 'Drop it — the file replaces the text in the editor',
  },
  'contests.p.fileKind': {
    ru: 'Нужен файл с решением: .py, .cpp или .c.',
    en: 'A solution file is needed: .py, .cpp or .c.',
  },
  'contests.p.fileTooBig': {
    ru: 'Файл больше {size} КБ — решение столько не весит.',
    en: 'The file is over {size} KB — a solution is never that large.',
  },
  'contests.p.fileLanguage': { ru: 'Этот контест не принимает {language}.', en: 'This contest does not take {language}.' },
  'contests.p.fileUnreadable': { ru: 'Файл не прочитался.', en: 'The file could not be read.' },
  'contests.p.sourceTooBig': {
    ru: 'Решение больше {size} КБ — столько проверка не примет.',
    en: 'The solution is over {size} KB — the judge will not take it.',
  },
  'contests.p.send': { ru: 'ОТПРАВИТЬ', en: 'SEND' },
  'contests.p.sending': { ru: 'ОТПРАВЛЯЕМ…', en: 'SENDING…' },
  'contests.p.sendShortcut': { ru: 'Отправить: {keys}', en: 'Send: {keys}' },
  'contests.p.attemptsLeft': {
    ru: {
      one: 'осталась {count} попытка',
      few: 'осталось {count} попытки',
      many: 'осталось {count} попыток',
      other: 'осталось {count} попытки',
    },
    en: { one: '{count} attempt left', other: '{count} attempts left' },
  },
  'contests.p.attemptsSpent': { ru: 'Попытки по этой задаче закончились.', en: 'No attempts left for this problem.' },
  'contests.p.closedSend': { ru: 'Приём закрыт: контест завершён.', en: 'Submissions are closed: the contest is over.' },
  'contests.p.notOpenSend': { ru: 'Контест ещё не начался.', en: 'The contest has not started yet.' },
  'contests.p.upsolvingNote': {
    ru: 'Дорешивание: решения проверяются как обычно, но в таблицу и места не идут.',
    en: 'Upsolving: solutions are judged as usual but do not reach the board or the places.',
  },
  'contests.p.problemSubmissions': { ru: 'ПОСЫЛКИ ПО ЗАДАЧЕ {letter}', en: 'SUBMISSIONS FOR {letter}' },
  'contests.p.mySubmissions': { ru: 'МОИ ПОСЫЛКИ ПО {letter}', en: 'MY SUBMISSIONS FOR {letter}' },
  'contests.p.allSubmissions': { ru: 'все посылки', en: 'all submissions' },
  'contests.p.noProblemSubmissions': { ru: 'Посылок по задаче пока нет.', en: 'No submissions for this problem yet.' },
  'contests.p.editor': { ru: 'РЕДАКТОР', en: 'EDITOR' },
  'contests.p.file': { ru: 'ФАЙЛ', en: 'FILE' },
  'contests.p.closeEditor': { ru: 'Свернуть', en: 'Collapse' },

  /* --------------------------------------------------- joining (JoinStep) */

  'contests.p.joinTitle': { ru: 'Вступите в контест', en: 'Join the contest' },
  'contests.p.joinHint': {
    ru: 'Имя видно в таблице — по нему вас узнают одногруппники.',
    en: 'The name shows on the board — it is how classmates recognise you.',
  },
  'contests.p.joinLateHint': {
    ru: 'Контест завершён, идёт дорешивание: решения проверят как обычно, но в таблицу и места они не попадут.',
    en: 'The contest is over and upsolving is on: solutions are judged as usual but never reach the board or the places.',
  },

  /* ---------------------------------------------------- submissions (K2) */

  'contests.p.allProblems': { ru: 'Все задачи', en: 'All problems' },
  'contests.p.allVerdicts': { ru: 'Все вердикты', en: 'All verdicts' },
  'contests.p.filterProblem': { ru: 'Задача', en: 'Problem' },
  'contests.p.filterVerdict': { ru: 'Вердикт', en: 'Verdict' },
  'contests.p.filterRunning': { ru: 'Проверяются', en: 'Being judged' },
  'contests.p.inFlightCount': { ru: 'Проверяется {count}', en: 'Judging {count}' },
  'contests.p.maxNote': {
    ru: 'время и память — наибольшие по тестам',
    en: 'time and memory are the largest over the tests',
  },
  'contests.p.colNumber': { ru: '№', en: '#' },
  'contests.p.colTime': { ru: 'ВРЕМЯ', en: 'TIME' },
  'contests.p.colProblem': { ru: 'ЗАДАЧА', en: 'PROBLEM' },
  'contests.p.colLanguage': { ru: 'ЯЗЫК', en: 'LANGUAGE' },
  'contests.p.colVerdict': { ru: 'ВЕРДИКТ', en: 'VERDICT' },
  'contests.p.colTest': { ru: 'ТЕСТ', en: 'TEST' },
  'contests.p.colSeconds': { ru: 'СЕКУНДЫ', en: 'SECONDS' },
  'contests.p.colMemory': { ru: 'ПАМЯТЬ', en: 'MEMORY' },
  'contests.p.code': { ru: 'Код', en: 'Code' },
  'contests.p.more': { ru: 'Подробнее', en: 'Details' },
  'contests.p.collapse': { ru: 'Свернуть', en: 'Collapse' },
  'contests.p.hideCode': { ru: 'Скрыть код', en: 'Hide the code' },
  'contests.p.codeOf': { ru: 'Код посылки {number}', en: 'The code of submission {number}' },
  'contests.p.queued': { ru: 'В очереди', en: 'Queued' },
  'contests.p.running': { ru: 'Проверяется', en: 'Judging' },
  'contests.p.runningTest': { ru: 'Проверяется · тест {n}', en: 'Judging · test {n}' },
  'contests.p.runningTestOf': { ru: 'Проверяется · тест {n} из {total}', en: 'Judging · test {n} of {total}' },
  'contests.p.noPenalty': { ru: 'без штрафа', en: 'no penalty' },
  'contests.p.lateMark': { ru: 'дорешивание', en: 'upsolving' },
  'contests.p.sampleWord': { ru: 'пример', en: 'example' },
  'contests.p.testsCount': {
    ru: { one: '{count} тест', few: '{count} теста', many: '{count} тестов', other: '{count} теста' },
    en: { one: '{count} test', other: '{count} tests' },
  },
  'contests.p.points': {
    ru: { one: '{count} балл', few: '{count} балла', many: '{count} баллов', other: '{count} балла' },
    en: { one: '{count} point', other: '{count} points' },
  },
  'contests.p.passedOf': {
    ru: {
      one: '{count} из {total} пройден',
      few: '{count} из {total} пройдено',
      many: '{count} из {total} пройдено',
      other: '{count} из {total} пройдено',
    },
    en: { one: '{count} of {total} passed', other: '{count} of {total} passed' },
  },
  'contests.p.stoppedAfter': { ru: 'дальше проверка остановилась', en: 'judging stopped there' },
  'contests.p.sampleFailed': {
    ru: 'Тест {n} — пример {k} из условия, поэтому видно, что вывело решение.',
    en: "Test {n} is example {k} from the statement, so the solution's output is shown.",
  },
  'contests.p.hiddenFailed': {
    ru: 'Тест {n} закрытый: что на нём вывело решение, не показывается.',
    en: "Test {n} is a hidden one: the solution's output on it is not shown.",
  },
  'contests.p.expected': { ru: 'ОЖИДАЛОСЬ', en: 'EXPECTED' },
  'contests.p.solutionOutput': { ru: 'ВЫВОД РЕШЕНИЯ', en: 'SOLUTION OUTPUT' },
  'contests.p.emptyOutput': { ru: '(пусто)', en: '(empty)' },
  'contests.p.compilerOutput': { ru: 'ВЫВОД КОМПИЛЯТОРА', en: 'COMPILER OUTPUT' },
  'contests.p.openAtLine': { ru: 'открыть код на строке {line}', en: 'open the code at line {line}' },
  'contests.p.showMoreSubmissions': {
    ru: {
      one: 'Показать ещё {count} посылку',
      few: 'Показать ещё {count} посылки',
      many: 'Показать ещё {count} посылок',
      other: 'Показать ещё {count} посылки',
    },
    en: { one: 'Show {count} more submission', other: 'Show {count} more submissions' },
  },
  'contests.p.noSubmissions': {
    ru: 'Посылок пока нет. Решение отправляется со страницы задачи.',
    en: "No submissions yet. A solution is sent from a problem's page.",
  },
  'contests.p.noMatches': { ru: 'Под фильтр ничего не подходит.', en: 'Nothing matches the filter.' },
  'contests.p.loadingDetail': { ru: 'Открываем посылку…', en: 'Opening the submission…' },

  /* ------------------------------------------------ the board (K3, K4, K6) */

  'contests.p.viewAll': { ru: 'Все · {count}', en: 'All · {count}' },
  'contests.p.viewNear': { ru: 'Рядом со мной', en: 'Near me' },
  'contests.p.frozenBold': { ru: 'Таблица заморожена с {time}.', en: 'The board is frozen since {time}.' },
  'contests.p.frozenRest': {
    ru: 'Чужие попытки после этого — «?», свои вы видите. Разморозит преподаватель после конца.',
    en: "Others' attempts after that show as «?», your own you see. The teacher unfreezes it after the end.",
  },
  'contests.p.colPlace': { ru: 'МЕСТО', en: 'PLACE' },
  'contests.p.colEntrant': { ru: 'УЧАСТНИК', en: 'PARTICIPANT' },
  'contests.p.colSolved': { ru: 'РЕШЕНО', en: 'SOLVED' },
  'contests.p.colPenalty': { ru: 'ШТРАФ', en: 'PENALTY' },
  'contests.p.colSum': { ru: 'СУММА', en: 'TOTAL' },
  'contests.p.outOf': { ru: 'из {max}', en: 'of {max}' },
  'contests.p.you': { ru: 'ВЫ', en: 'YOU' },
  'contests.p.showMoreRows': {
    ru: {
      one: 'Показать ещё {count} участника',
      few: 'Показать ещё {count} участников',
      many: 'Показать ещё {count} участников',
      other: 'Показать ещё {count} участника',
    },
    en: { one: 'Show {count} more participant', other: 'Show {count} more participants' },
  },
  'contests.p.totals': { ru: 'РЕШИЛИ / ПОПЫТОК', en: 'SOLVED / ATTEMPTS' },
  'contests.p.totalsCell': {
    ru: 'решили {solved}, попыток {attempts}',
    en: '{solved} solved, {attempts} attempts',
  },
  'contests.p.legendFirst': { ru: 'первым решил задачу', en: 'first to solve the problem' },
  'contests.p.legendSolved': {
    ru: 'решено: «+2» — две попытки до верной, время от старта',
    en: 'solved: «+2» is two attempts before the right one, the time is from the start',
  },
  'contests.p.legendFailed': { ru: 'не решено', en: 'not solved' },
  'contests.p.legendFrozen': { ru: 'заморожено', en: 'frozen' },
  'contests.p.legendFull': { ru: 'полный балл', en: 'full score' },
  'contests.p.legendPartial': {
    ru: 'часть баллов — полоска показывает долю',
    en: 'part of the points — the bar shows the share',
  },
  'contests.p.legendZero': { ru: 'ноль баллов', en: 'zero points' },
  'contests.p.tieIcpc': {
    ru: 'Штраф — минуты до каждой решённой задачи плюс {penalty} за каждую неверную попытку до неё; ошибка компиляции не штрафуется. При равенстве выше тот, кто раньше получил последнее «принято».',
    en: 'The penalty is the minutes to each solved problem plus {penalty} for every wrong attempt before it; a compilation error costs nothing. On a tie, whoever got their last «accepted» earlier ranks higher.',
  },
  'contests.p.tieIoi': {
    ru: 'Группа тестов приносит свои баллы, только если пройдены все её тесты. При равной сумме выше тот, кто набрал её раньше.',
    en: 'A group of tests gives its points only when all of its tests pass. On an equal total, whoever reached it earlier ranks higher.',
  },
  'contests.p.cellSolved': {
    ru: 'решено, {time}, неудачных попыток до этого: {count}',
    en: 'solved, {time}, failed attempts before: {count}',
  },
  'contests.p.cellFirst': { ru: 'первым', en: 'first to solve' },
  'contests.p.cellFailed': {
    ru: 'не решено, неудачных попыток: {count}',
    en: 'not solved, failed attempts: {count}',
  },
  'contests.p.cellFrozen': { ru: 'заморожено, попыток: {count}', en: 'frozen, attempts: {count}' },
  'contests.p.cellPending': { ru: 'проверяется', en: 'being judged' },
  'contests.p.cellPoints': { ru: '{score} из {max}', en: '{score} of {max}' },
  'contests.p.triesShort': {
    ru: { one: '{count} поп.', few: '{count} поп.', many: '{count} поп.', other: '{count} поп.' },
    en: { one: '{count} try', other: '{count} tries' },
  },
  'contests.p.boardEmpty': {
    ru: 'В таблице пока никого: она заполнится, когда участники вступят в контест.',
    en: 'Nobody on the board yet: it fills as people join the contest.',
  },
  'contests.p.boardClosedTitle': { ru: 'Таблица видна только участникам', en: 'The board is for participants only' },
  'contests.p.boardClosedText': {
    ru: 'Вступите в контест, чтобы видеть таблицу.',
    en: 'Join the contest to see the board.',
  },
  'contests.p.notOnBoard': {
    ru: 'Вас нет в таблице: вы ещё не вступили в контест.',
    en: 'You are not on the board: you have not joined the contest.',
  },
  'contests.p.screenTitle': { ru: 'Лидерборд', en: 'Leaderboard' },
  'contests.p.frozenSince': { ru: 'заморожено с {time}', en: 'frozen since {time}' },
  'contests.p.firstSolvers': { ru: 'Первыми решили: {list}', en: 'First to solve: {list}' },
  'contests.p.moreBelow': {
    ru: {
      one: 'и ещё {count} участник ниже',
      few: 'и ещё {count} участника ниже',
      many: 'и ещё {count} участников ниже',
      other: 'и ещё {count} участника ниже',
    },
    en: { one: 'and {count} more participant below', other: 'and {count} more participants below' },
  },

  /* ------------------------------------------------------------ questions */

  'contests.p.questionsTitle': { ru: 'Вопросы и объявления', en: 'Questions and announcements' },
  'contests.p.askTitle': { ru: 'Задать вопрос', en: 'Ask a question' },
  'contests.p.askHint': {
    ru: 'Вопрос увидит только преподаватель. Ответ придёт сюда, а если он важен всем — его покажут всем.',
    en: 'Only the teacher sees the question. The answer comes here, and if it matters to everyone, everyone sees it.',
  },
  'contests.p.askAbout': { ru: 'О чём вопрос', en: 'About' },
  'contests.p.askGeneral': { ru: 'Общий вопрос', en: 'General question' },
  'contests.p.askText': { ru: 'Вопрос', en: 'Question' },
  'contests.p.askPlaceholder': { ru: 'Что непонятно в условии?', en: 'What is unclear in the statement?' },
  'contests.p.ask': { ru: 'СПРОСИТЬ', en: 'ASK' },
  'contests.p.asking': { ru: 'ОТПРАВЛЯЕМ…', en: 'SENDING…' },
  'contests.p.askJoin': {
    ru: 'Задавать вопросы могут участники контеста.',
    en: 'Participants of the contest can ask questions.',
  },
  'contests.p.announcement': { ru: 'ОБЪЯВЛЕНИЕ', en: 'ANNOUNCEMENT' },
  'contests.p.yourQuestion': { ru: 'ВАШ ВОПРОС', en: 'YOUR QUESTION' },
  'contests.p.question': { ru: 'ВОПРОС', en: 'QUESTION' },
  'contests.p.answer': { ru: 'Ответ', en: 'Answer' },
  'contests.p.answerToAll': { ru: 'ответ для всех', en: 'answered to everyone' },
  'contests.p.waiting': { ru: 'Ждёт ответа', en: 'Waiting for an answer' },
  'contests.p.noQuestions': { ru: 'Пока нет ни вопросов, ни объявлений.', en: 'No questions or announcements yet.' },
  'contests.p.aboutProblem': { ru: 'задача {letter}', en: 'problem {letter}' },

  /* ----------------------------------------------------- the first page */

  'contests.p.startsIn': { ru: 'Контест начнётся через', en: 'The contest starts in' },
  'contests.p.startsAt': { ru: 'Начало: {date}', en: 'Starts: {date}' },
  'contests.p.problemsHidden': {
    ru: 'Задачи появятся здесь в момент старта.',
    en: 'The problems appear here at the start.',
  },
  'contests.p.toProblem': { ru: 'К задаче {letter} →', en: 'To problem {letter} →' },
  'contests.p.noProblems': { ru: 'В контесте пока нет задач.', en: 'The contest has no problems yet.' },
  'contests.p.noSuchProblem': { ru: 'В контесте нет задачи {letter}.', en: 'The contest has no problem {letter}.' },

  /* ------------------------------------------------------- the /k list */

  'contests.p.listTitle': { ru: 'Контесты', en: 'Contests' },
  'contests.p.listOpen': { ru: 'ОТКРЫТЬ', en: 'OPEN' },
  'contests.p.listNotJoined': { ru: 'ещё не участвуете', en: 'not taking part yet' },
  'contests.p.endedLabel': { ru: 'ЗАВЕРШЁН', en: 'ENDED' },
  'contests.p.listSolved': { ru: 'решено {value} из {total}', en: '{value} of {total} solved' },
  'contests.p.listPlace': { ru: 'место {place}', en: 'place {place}' },
}

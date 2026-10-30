import type { MessageCatalog } from '../i18n-types.js'

/**
 * What the contest doors say: refusals, the judge's notes that reach a
 * person, the readiness list of «Открыть контест», the CSV's header, the
 * audit log's labels of contest actions. Read by the server and sent already
 * translated; kept in a file of its own so the doors and the pages can grow
 * their words apart. Spread into contests.ts (and with it into the
 * competitions' catalogue the server, the panel and the `/k` chunk load).
 *
 * Two voices, as in the competitions' refusals: a participant is told the
 * RULE («не чаще одной посылки в пять секунд»), a teacher the FIELD or the
 * missing piece — they broke no rule, they have not finished building the
 * contest yet.
 */
export const contestServerMessages: MessageCatalog = {
  /*
   * A builtin checker's note (judge/docker-judge.ts · noteText): the first
   * place the output and the answer part, counted in words or in lines.
   */
  'contests.note.word.differ': {
    ru: 'слово {n}: ожидалось «{expected}», получено «{got}»',
    en: 'word {n}: expected “{expected}”, got “{got}”',
  },
  'contests.note.word.long': {
    ru: 'вывод длиннее ответа: лишнее слово {n} — «{got}»',
    en: 'the output is longer than the answer: extra word {n} — “{got}”',
  },
  'contests.note.word.short': {
    ru: 'вывод короче ответа: нет слова {n} — ожидалось «{expected}»',
    en: 'the output is shorter than the answer: word {n} is missing — expected “{expected}”',
  },
  'contests.note.line.differ': {
    ru: 'строка {n}: ожидалось «{expected}», получено «{got}»',
    en: 'line {n}: expected “{expected}”, got “{got}”',
  },
  'contests.note.line.long': {
    ru: 'вывод длиннее ответа: лишняя строка {n} — «{got}»',
    en: 'the output is longer than the answer: extra line {n} — “{got}”',
  },
  'contests.note.line.short': {
    ru: 'вывод короче ответа: нет строки {n} — ожидалось «{expected}»',
    en: 'the output is shorter than the answer: line {n} is missing — expected “{expected}”',
  },

  /* ------------------------------------------------ the participant's doors */
  'contests.refusal.notFound': { ru: 'Такого контеста нет.', en: 'No such contest.' },
  'contests.refusal.signIn': {
    ru: 'Войдите по ключу или вступите в контест.',
    en: 'Sign in with your key, or join the contest.',
  },
  'contests.refusal.notOpen': { ru: 'Контест ещё не начался.', en: 'The contest has not started yet.' },
  'contests.refusal.closed': {
    ru: 'Приём решений закрыт: контест закончился.',
    en: 'Submissions are closed: the contest is over.',
  },
  'contests.refusal.joinClosed': {
    ru: 'Контест закончился — вступить в него уже нельзя.',
    en: 'The contest is over — it can no longer be joined.',
  },
  /* A name is a Telegram username or an email (shared/competitions.ts · entrantHandle), as in competitions. */
  'contests.refusal.nameNotHandle': {
    ru: 'Укажите логин Telegram (например, @ivan_petrov) или почту.',
    en: 'Enter your Telegram username (for example @ivan_petrov) or your email.',
  },
  /* The likeliest namesake at the door is the same person on a new device: the way back is the key. */
  'contests.refusal.nameTaken': {
    ru: 'В этом контесте уже есть участник с таким логином или почтой. Если это вы — войдите по своему ключу.',
    en: 'This contest already has a participant with this username or email. If that is you, sign in with your key.',
  },
  'contests.refusal.tooOftenJoin': {
    ru: 'Слишком часто. Подождите минуту и повторите.',
    en: 'Too often. Wait a minute and try again.',
  },
  'contests.refusal.notJoined': { ru: 'Сначала вступите в контест.', en: 'Join the contest first.' },
  'contests.refusal.unavailable': {
    ru: 'На этом сервере проверять решения негде.',
    en: 'This server has nowhere to judge solutions.',
  },
  'contests.refusal.imageUnavailable': {
    ru: 'Проверка сейчас не отвечает. Подождите минуту и отправьте ещё раз.',
    en: 'The judge is not answering right now. Wait a minute and send again.',
  },
  'contests.refusal.noProblem': { ru: 'Такой задачи в контесте нет.', en: 'The contest has no such problem.' },
  'contests.refusal.languageNotTaken': {
    ru: 'Этот язык в контесте не принимается.',
    en: 'This contest does not take that language.',
  },
  'contests.refusal.languageMissing': {
    ru: '{language} сейчас нет на сервере проверки — выберите другой язык.',
    en: '{language} is not on the judge right now — choose another language.',
  },
  'contests.refusal.emptySource': {
    ru: 'Решение пустое: вставьте код или перетащите файл.',
    en: 'The solution is empty: paste the code or drop a file.',
  },
  'contests.refusal.tooBig': {
    ru: 'Решение больше {count} КБ — проверьте, что прислали исходник, а не данные.',
    en: 'The solution is over {count} KB — check that you sent the source, not data.',
  },
  'contests.refusal.inFlight': {
    ru: 'Две ваши посылки ещё проверяются. Дождитесь вердикта одной из них.',
    en: 'Two of your submissions are still being judged. Wait for a verdict on one of them.',
  },
  /* The per-problem limit; a compilation error and the judge's own failure do not spend it. */
  'contests.refusal.attempts': {
    ru: {
      one: 'Попытки по этой задаче закончились: {count} на задачу. Ошибки компиляции попыток не тратят.',
      few: 'Попытки по этой задаче закончились: {count} на задачу. Ошибки компиляции попыток не тратят.',
      many: 'Попытки по этой задаче закончились: {count} на задачу. Ошибки компиляции попыток не тратят.',
      other: 'Попытки по этой задаче закончились: {count} на задачу. Ошибки компиляции попыток не тратят.',
    },
    en: {
      one: 'No attempts left for this problem: {count} per problem. Compilation errors spend none.',
      other: 'No attempts left for this problem: {count} per problem. Compilation errors spend none.',
    },
  },
  'contests.refusal.tooOften': {
    ru: 'Не чаще одной посылки в пять секунд. Подождите немного.',
    en: 'At most one submission every five seconds. Wait a moment.',
  },
  'contests.refusal.boardClosed': {
    ru: 'Таблицу результатов видят только участники контеста.',
    en: "Only the contest's participants see its standings.",
  },
  'contests.refusal.noSubmission': { ru: 'Такой посылки нет.', en: 'No such submission.' },
  'contests.refusal.questionEmpty': { ru: 'Напишите вопрос.', en: 'Write the question.' },
  'contests.refusal.questionTooLong': {
    ru: {
      one: 'Вопрос длиннее {count} знака.',
      few: 'Вопрос длиннее {count} знаков.',
      many: 'Вопрос длиннее {count} знаков.',
      other: 'Вопрос длиннее {count} знака.',
    },
    en: { one: 'The question is over {count} character.', other: 'The question is over {count} characters.' },
  },
  'contests.refusal.askTooOften': {
    ru: 'Не чаще одного вопроса в десять секунд.',
    en: 'At most one question every ten seconds.',
  },

  /* ------------------------------------------------------ the panel's doors */
  'contests.refusal.title': {
    ru: 'Назовите контест: название видно участникам в списке.',
    en: 'Give the contest a name: participants see it in the list.',
  },
  'contests.refusal.languages': { ru: 'Выберите хотя бы один язык.', en: 'Choose at least one language.' },
  'contests.refusal.slug.chars': {
    ru: 'В адресе — строчные латинские буквы, цифры и дефис, от 3 до 64 знаков: его диктуют вслух и пишут на доске.',
    en: 'An address takes lowercase Latin letters, digits and dashes, 3 to 64 of them: it gets dictated aloud and written on the board.',
  },
  'contests.refusal.slug.reserved': {
    ru: 'Этот адрес занят самим Colloq. Возьмите другой.',
    en: 'That address belongs to Colloq itself. Pick another one.',
  },
  'contests.refusal.slug.taken': {
    ru: 'Этот адрес уже занят другим контестом.',
    en: 'Another contest already has that address.',
  },
  'contests.refusal.range': { ru: '{field}: допустимо от {min} до {max}.', en: '{field}: allowed from {min} to {max}.' },
  'contests.refusal.value': { ru: '{field}: такого значения нет.', en: '{field}: no such value.' },
  'contests.refusal.tooLong': { ru: '{field}: слишком длинно — не больше {max}.', en: '{field}: too long — at most {max}.' },
  'contests.refusal.dates': {
    ru: 'Конец контеста должен быть позже начала.',
    en: 'The contest must end after it starts.',
  },
  'contests.refusal.courseNotFound': { ru: 'Такого курса нет.', en: 'No such course.' },
  'contests.refusal.courseWouldHide': {
    ru: 'После этого контест пропадёт из вашей панели: вы не автор и не ведёте выбранный курс. Выберите свой курс.',
    en: 'The contest would vanish from your panel: you are not its author and do not teach that course. Choose one of your courses.',
  },
  'contests.refusal.rulesLocked': {
    ru: 'Правила не меняются, когда посылки уже есть: таблицу пришлось бы пересчитать задним числом по вердиктам, вынесенным по другим правилам.',
    en: 'The rules cannot change once there are submissions: the standings would be recounted after the fact from verdicts given under other rules.',
  },
  'contests.refusal.notReady': {
    ru: 'Контест ещё не готов к открытию.',
    en: 'The contest is not ready to open yet.',
  },
  'contests.refusal.notDraft': {
    ru: 'Открыть можно только черновик: этот контест уже открывали.',
    en: 'Only a draft can be opened: this contest has been opened before.',
  },
  'contests.refusal.notFinished': {
    ru: 'Открыть заново можно только завершённый контест.',
    en: 'Only a finished contest can be opened again.',
  },
  'contests.refusal.notLive': {
    ru: 'Контест не идёт — завершать нечего.',
    en: 'The contest is not running — there is nothing to finish.',
  },
  'contests.refusal.notFrozen': { ru: 'Таблица сейчас не заморожена.', en: 'The standings are not frozen now.' },
  'contests.refusal.draftHide': {
    ru: 'Черновик и так не виден участникам.',
    en: 'A draft is not shown to participants anyway.',
  },
  'contests.refusal.alreadyHidden': { ru: 'Контест уже снят с публикации.', en: 'The contest is already off publication.' },
  'contests.refusal.notHidden': { ru: 'Контест и так опубликован.', en: 'The contest is published already.' },
  'contests.refusal.deleteForbidden': {
    ru: 'Удалить контест может его автор или владелец.',
    en: "Only the contest's author or an owner can delete it.",
  },
  'contests.refusal.running': {
    ru: 'Решение этого контеста сейчас проверяется. Повторите через минуту.',
    en: 'A solution of this contest is being judged right now. Try again in a minute.',
  },
  'contests.refusal.problemsFull': {
    ru: 'В контесте уже 26 задач — по одной на каждую букву.',
    en: 'The contest already has 26 problems — one for every letter.',
  },
  'contests.refusal.order': {
    ru: 'Порядок должен назвать каждую задачу контеста ровно один раз.',
    en: 'The order must name every problem of the contest exactly once.',
  },
  'contests.refusal.noTest': { ru: 'Такого теста нет.', en: 'No such test.' },
  'contests.refusal.testsTooMany': {
    ru: {
      one: 'В задаче не больше {count} теста.',
      few: 'В задаче не больше {count} тестов.',
      many: 'В задаче не больше {count} тестов.',
      other: 'В задаче не больше {count} теста.',
    },
    en: { one: 'A problem has at most {count} test.', other: 'A problem has at most {count} tests.' },
  },
  'contests.refusal.testTooBig': { ru: 'Тест {test} больше {count} МБ.', en: 'Test {test} is over {count} MB.' },
  'contests.refusal.testsTooBig': {
    ru: 'Все тесты задачи вместе — не больше {count} МБ.',
    en: "All of a problem's tests together are at most {count} MB.",
  },
  'contests.refusal.testsMoved': {
    ru: 'Тесты задачи изменились, пока шла загрузка. Обновите страницу и повторите.',
    en: "The problem's tests changed while this was uploading. Refresh the page and try again.",
  },
  'contests.refusal.notMultipart': { ru: 'Ожидалась загрузка файла.', en: 'A file upload was expected.' },
  'contests.refusal.uploadCutOff': {
    ru: 'Загрузка оборвалась на середине. Ничего не сохранено — попробуйте ещё раз.',
    en: 'The upload was cut off halfway. Nothing was saved — try again.',
  },
  'contests.refusal.noFile': {
    ru: 'Файл не пришёл. Выберите архив .zip и повторите.',
    en: 'No file arrived. Pick a .zip archive and try again.',
  },
  'contests.refusal.archiveTooBig': { ru: 'Архив больше {count} МБ.', en: 'The archive is over {count} MB.' },
  'contests.refusal.zip.malformed': {
    ru: 'Это не zip-архив, или он повреждён.',
    en: 'This is not a zip archive, or it is damaged.',
  },
  'contests.refusal.zip.encrypted': {
    ru: 'Архив защищён паролем — загрузите архив без пароля.',
    en: 'The archive is password-protected — upload one without a password.',
  },
  'contests.refusal.zip.method': {
    ru: 'Файл {name} сжат способом, который сервер не читает. Пересожмите архив обычным zip.',
    en: 'The file {name} is compressed in a way the server does not read. Re-pack the archive as an ordinary zip.',
  },
  'contests.refusal.zip.multidisk': {
    ru: 'Архив разбит на части — соберите его в один файл.',
    en: 'The archive is split into parts — join it into one file.',
  },
  'contests.refusal.zip.tooManyEntries': {
    ru: {
      one: 'В архиве больше {count} файла.',
      few: 'В архиве больше {count} файлов.',
      many: 'В архиве больше {count} файлов.',
      other: 'В архиве больше {count} файла.',
    },
    en: { one: 'The archive holds over {count} file.', other: 'The archive holds over {count} files.' },
  },
  'contests.refusal.zip.fileTooBig': { ru: 'Файл {name} больше {count} МБ.', en: 'The file {name} is over {count} MB.' },
  'contests.refusal.zip.totalTooBig': {
    ru: 'Распакованный архив больше {count} МБ.',
    en: 'The unpacked archive is over {count} MB.',
  },
  'contests.refusal.zip.checksum': {
    ru: 'Файл {name} в архиве повреждён: не сходится контрольная сумма.',
    en: 'The file {name} in the archive is damaged: its checksum does not match.',
  },
  'contests.refusal.noTestsInArchive': {
    ru: 'В архиве не нашлось тестов. Ожидаются пары вроде tests/01 и tests/01.a, 1.in и 1.out или input/input1.txt и output/output1.txt.',
    en: 'No tests were found in the archive. Expected pairs like tests/01 and tests/01.a, 1.in and 1.out, or input/input1.txt and output/output1.txt.',
  },
  'contests.refusal.problemArchive.json': {
    ru: '{field} не читается как JSON-объект.',
    en: '{field} does not read as a JSON object.',
  },
  'contests.refusal.problemArchive.value': { ru: '{field}: такого значения нет.', en: '{field}: no such value.' },
  'contests.refusal.problemArchive.range': {
    ru: '{field}: допустимо от {min} до {max}.',
    en: '{field}: allowed from {min} to {max}.',
  },
  'contests.refusal.problemArchive.tooLong': { ru: '{field}: слишком длинный.', en: '{field}: too long.' },
  'contests.refusal.problemArchive.notText': { ru: '{field}: это не текст в UTF-8.', en: '{field}: not UTF-8 text.' },
  'contests.refusal.noReference': { ru: 'У задачи нет эталонного решения.', en: 'The problem has no reference solution.' },
  'contests.refusal.noTestsYet': { ru: 'У задачи ещё нет тестов.', en: 'The problem has no tests yet.' },
  'contests.refusal.answersFirst': {
    ru: {
      one: 'У {count} теста нет ответа — сначала загрузите ответы или запишите их эталоном.',
      few: 'У {count} тестов нет ответа — сначала загрузите ответы или запишите их эталоном.',
      many: 'У {count} тестов нет ответа — сначала загрузите ответы или запишите их эталоном.',
      other: 'У {count} теста нет ответа — сначала загрузите ответы или запишите их эталоном.',
    },
    en: {
      one: '{count} test has no answer yet — upload the answers or have the reference write them first.',
      other: '{count} tests have no answer yet — upload the answers or have the reference write them first.',
    },
  },
  'contests.refusal.beingJudged': {
    ru: 'Посылка сейчас проверяется — дождитесь вердикта.',
    en: 'The submission is being judged right now — wait for its verdict.',
  },
  'contests.refusal.noEntrant': { ru: 'Такого участника в контесте нет.', en: 'The contest has no such participant.' },
  'contests.refusal.noQuestion': { ru: 'Такого вопроса нет.', en: 'No such question.' },
  'contests.refusal.answerEmpty': { ru: 'Напишите ответ.', en: 'Write the answer.' },
  'contests.refusal.announcementEmpty': { ru: 'Напишите объявление.', en: 'Write the announcement.' },
  'contests.refusal.slots': {
    ru: 'Посылок одновременно — от {min} до {max} или «авто».',
    en: 'Submissions at once: from {min} to {max}, or “auto”.',
  },

  /* What only an owner may do (server.ownerOnly: «Только владелец может {action}»). */
  'contests.owner.settings': {
    ru: 'менять настройки проверки контестов — она одна на все курсы',
    en: "change the contests' judge settings — there is one judge for every course",
  },
  'contests.owner.pause': {
    ru: 'приостанавливать проверку контестов — она одна на все курсы',
    en: "pause the contests' judge — there is one for every course",
  },

  /* ------------------------------------------- the judge's words, for staff */
  'contests.judge.restartAbandoned': {
    ru: {
      one: 'Проверку {count} раз подряд прервал перезапуск сервера — посылку нужно перепроверить.',
      few: 'Проверку {count} раза подряд прерывал перезапуск сервера — посылку нужно перепроверить.',
      many: 'Проверку {count} раз подряд прерывал перезапуск сервера — посылку нужно перепроверить.',
      other: 'Проверку {count} раза подряд прерывал перезапуск сервера — посылку нужно перепроверить.',
    },
    en: {
      one: 'A server restart cut the judging short {count} time in a row — the submission needs a rejudge.',
      other: 'A server restart cut the judging short {count} times in a row — the submission needs a rejudge.',
    },
  },
  'contests.judge.contestGone': {
    ru: 'Контест или задачу удалили во время проверки.',
    en: 'The contest or the problem was deleted during the judging.',
  },
  'contests.judge.noTests': {
    ru: 'У задачи нет тестов — проверять не на чем.',
    en: 'The problem has no tests — there is nothing to judge on.',
  },
  'contests.judge.noAnswer': {
    ru: 'У теста {test} нет ответа — сравнивать не с чем.',
    en: 'Test {test} has no answer — there is nothing to compare with.',
  },
  'contests.judge.failed': { ru: 'Проверка не удалась: {detail}', en: 'The judging failed: {detail}' },
  'contests.judge.stopped': { ru: 'Проверку остановили.', en: 'The judging was stopped.' },
  'contests.judge.unknown': {
    ru: 'Проверка не удалась, причина неизвестна.',
    en: 'The judging failed for an unknown reason.',
  },
  'contests.judge.answersMissing': {
    ru: 'Эталон отработал, но ответов не вернул.',
    en: 'The reference ran but returned no answers.',
  },
  'contests.judge.answersStale': {
    ru: 'Тесты изменились, пока эталон писал ответы, — ответы не записаны. Запустите ещё раз.',
    en: 'The tests changed while the reference was writing answers — none were written. Run it again.',
  },
  'contests.judge.answersRefused.tooMany': {
    ru: 'Ответы эталона не записаны: в задаче слишком много тестов.',
    en: "The reference's answers were not written: the problem has too many tests.",
  },
  'contests.judge.answersRefused.fileTooBig': {
    ru: 'Ответы эталона не записаны: один из них слишком большой.',
    en: "The reference's answers were not written: one of them is too large.",
  },
  'contests.judge.answersRefused.totalTooBig': {
    ru: 'Ответы эталона не записаны: вместе с ними тесты задачи превысили бы предел.',
    en: "The reference's answers were not written: with them the problem's tests would go over the limit.",
  },

  /* ------------------------------------- why «Открыть контест» is refused */
  'contests.readiness.noProblems': { ru: 'Добавьте хотя бы одну задачу.', en: 'Add at least one problem.' },
  'contests.readiness.noTests': { ru: 'Задача {letter}: нет тестов.', en: 'Problem {letter}: no tests.' },
  'contests.readiness.missingAnswers': {
    ru: {
      one: 'Задача {letter}: у {count} теста нет ответа.',
      few: 'Задача {letter}: у {count} тестов нет ответа.',
      many: 'Задача {letter}: у {count} тестов нет ответа.',
      other: 'Задача {letter}: у {count} теста нет ответа.',
    },
    en: {
      one: 'Problem {letter}: {count} test has no answer.',
      other: 'Problem {letter}: {count} tests have no answer.',
    },
  },
  'contests.readiness.noPoints': {
    ru: 'Задача {letter}: группы не дают ни одного балла.',
    en: 'Problem {letter}: its groups give no points.',
  },
  'contests.readiness.noReference': {
    ru: 'Задача {letter}: нет эталонного решения.',
    en: 'Problem {letter}: no reference solution.',
  },
  'contests.readiness.referenceUnchecked': {
    ru: 'Задача {letter}: эталон не проверен на текущих тестах и ограничениях.',
    en: 'Problem {letter}: the reference has not been checked on the current tests and limits.',
  },
  'contests.readiness.referenceRunning': {
    ru: 'Задача {letter}: эталон ещё проверяется.',
    en: 'Problem {letter}: the reference is still being checked.',
  },
  'contests.readiness.referenceFails': {
    ru: 'Задача {letter}: эталон не проходит — {verdict}.',
    en: 'Problem {letter}: the reference fails — {verdict}.',
  },
  'contests.readiness.referenceFailsOn': {
    ru: 'Задача {letter}: эталон не проходит — {verdict} на тесте {test}.',
    en: 'Problem {letter}: the reference fails — {verdict} on test {test}.',
  },
  'contests.readiness.noJudge': {
    ru: 'На этом сервере проверять решения негде.',
    en: 'This server has nowhere to judge solutions.',
  },
  'contests.readiness.imageUnknown': {
    ru: 'Не удалось спросить образ {image}, какие языки он запускает: проверьте, что окружение собрано.',
    en: 'The image {image} could not be asked which languages it runs: check that the environment is built.',
  },
  'contests.readiness.noLanguage': {
    ru: 'Ни один язык контеста не запускается в образе {image}.',
    en: "None of the contest's languages runs in the image {image}.",
  },
  'contests.readiness.freezeWithoutEnd': {
    ru: 'Заморозка отсчитывается от конца контеста: задайте конец или выключите заморозку.',
    en: 'The freeze is counted back from the end of the contest: set an end or turn the freeze off.',
  },
  'contests.readiness.endBeforeStart': { ru: 'Конец контеста раньше его начала.', en: 'The contest ends before it starts.' },
  'contests.readiness.endPassed': {
    ru: 'Время окончания уже прошло — перенесите его.',
    en: 'The end time has already passed — move it.',
  },

  /* A problem made without a title is named by its letter. */
  'contests.problem.defaultTitle': { ru: 'Задача {letter}', en: 'Problem {letter}' },

  /* The CSV of the standings: its header. */
  'contests.csv.place': { ru: 'Место', en: 'Place' },
  'contests.csv.name': { ru: 'Участник', en: 'Participant' },
  'contests.csv.solved': { ru: 'Решено', en: 'Solved' },
  'contests.csv.penalty': { ru: 'Штраф', en: 'Penalty' },
  'contests.csv.score': { ru: 'Баллы', en: 'Score' },

  /* ------------------------------------------------ the audit log (owners) */
  'admin.audit.action.contest.created': { ru: 'Создан контест', en: 'Contest created' },
  'admin.audit.action.contest.updated': { ru: 'Изменён контест', en: 'Contest edited' },
  'admin.audit.action.contest.opened': { ru: 'Контест открыт', en: 'Contest opened' },
  'admin.audit.action.contest.finished': { ru: 'Контест завершён', en: 'Contest finished' },
  'admin.audit.action.contest.deleted': { ru: 'Удалён контест', en: 'Contest deleted' },
  'admin.audit.action.contest.unfrozen': { ru: 'Таблица контеста разморожена', en: 'Contest standings unfrozen' },
  'admin.audit.action.contest.hidden': { ru: 'Контест снят с публикации', en: 'Contest taken off publication' },
  'admin.audit.action.contest.shown': { ru: 'Контест снова опубликован', en: 'Contest published again' },
  'admin.audit.action.contest.problem.tests': { ru: 'Изменены тесты задачи', en: 'Problem tests changed' },
  'admin.audit.action.contest.rejudged': { ru: 'Посылки отправлены на перепроверку', en: 'Submissions rejudged' },
  'admin.audit.action.contest.entrant.removed': { ru: 'Удалён участник контеста', en: 'Contest participant removed' },
  /* The details of those, as one line each (web/src/admin/audit.ts). */
  'admin.audit.contestTests.archive': { ru: 'задача {problem}: тесты заменены архивом', en: 'problem {problem}: tests replaced from an archive' },
  'admin.audit.contestTests.archive-append': { ru: 'задача {problem}: тесты из архива добавлены к прежним', en: 'problem {problem}: tests from an archive added to the old ones' },
  'admin.audit.contestTests.add': { ru: 'задача {problem}: добавлен тест', en: 'problem {problem}: a test added' },
  'admin.audit.contestTests.edit': { ru: 'задача {problem}: изменён тест {test}', en: 'problem {problem}: test {test} changed' },
  'admin.audit.contestTests.delete': { ru: 'задача {problem}: удалён тест {test}', en: 'problem {problem}: test {test} deleted' },
  'admin.audit.contestTests.clear': { ru: 'задача {problem}: удалены все тесты', en: 'problem {problem}: every test deleted' },
  'admin.audit.contestTests.import': { ru: 'задача {problem} загружена архивом', en: 'problem {problem} imported from an archive' },
  'admin.audit.contestTests.copy': { ru: 'задача {problem} скопирована с тестами', en: 'problem {problem} copied with its tests' },
  'admin.audit.contestTests.answers': { ru: 'задача {problem}: ответы пишет эталон', en: 'problem {problem}: the reference writes the answers' },
  'admin.audit.contestRejudged': {
    ru: {
      one: 'на перепроверку: {count} посылка',
      few: 'на перепроверку: {count} посылки',
      many: 'на перепроверку: {count} посылок',
      other: 'на перепроверку: {count} посылки',
    },
    en: { one: 'rejudged: {count} submission', other: 'rejudged: {count} submissions' },
  },
}

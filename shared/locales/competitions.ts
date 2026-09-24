import type { MessageCatalog } from '../i18n-types.js'
import { dependencyMessages } from './dependencies.js'

/**
 * Слова соревнований — одни на панель преподавателя и на страницы участника.
 *
 * Своим каталогом, а не в `common`: у `/k/**` свой набор экранов, и каталог
 * — единица, которую браузер грузит целиком (web/src/lib/messages/*). Держать
 * эти двадцать ключей в общем куске значило бы возить их в каждую комнату,
 * где соревнований нет вовсе.
 *
 * Русские строки — ДОСЛОВНО из макета (Paper 07 · Соревнования); владелец их
 * вычитал сам, и менять их нельзя, включая «ё» в «ИДЁТ» и строчные буквы в
 * «в зачёт». Английский — настоящий перевод, а не транслитерация: плашка, где
 * вместо «NOTEBOOK FAILED» стоит «UPALA TETRAD», хуже отсутствия перевода.
 */
export const competitionsMessages: MessageCatalog = {
  ...dependencyMessages,
  /* Состояние соревнования — плашка в списке (A1) и в шапке участника (P2, P3). */
  'competitions.state.draft': { ru: 'ЧЕРНОВИК', en: 'DRAFT' },
  'competitions.state.live': { ru: 'ИДЁТ', en: 'LIVE' },
  'competitions.state.finished': { ru: 'ЗАВЕРШЕНО', en: 'FINISHED' },

  /*
   * Исход посылки СЛОВАМИ УЧАСТНИКА (P2, P4). Второй набор ниже — те же
   * исходы словами преподавателя, и расходятся они намеренно: «ОШИБКА В
   * ТЕТРАДИ» обращено к тому, кто её писал, «УПАЛА ТЕТРАДЬ» — к тому, кто
   * смотрит на сто чужих.
   */
  'competitions.entrant.running': { ru: 'ВЫПОЛНЯЕТСЯ', en: 'RUNNING' },
  'competitions.entrant.queued': { ru: 'В ОЧЕРЕДИ', en: 'IN QUEUE' },
  'competitions.runtime.resourcesWaiting': {
    ru: 'Сейчас не хватает ресурсов для запуска. Посылка остаётся в очереди и запустится автоматически.',
    en: 'There are not enough resources to start yet. Your submission remains queued and will retry automatically.',
  },
  'competitions.runtime.retrying': { ru: 'ЖДЁТ РЕСУРСЫ', en: 'WAITING FOR RESOURCES' },
  'competitions.entrant.scored': { ru: 'ГОТОВО', en: 'DONE' },
  'competitions.entrant.notebookFailed': { ru: 'ОШИБКА В ТЕТРАДИ', en: 'NOTEBOOK ERROR' },
  'competitions.entrant.rejected': { ru: 'ОТВЕТ НЕ ПРИНЯТ', en: 'ANSWER REJECTED' },
  'competitions.entrant.timedOut': { ru: 'ЛИМИТ ВРЕМЕНИ', en: 'TIME LIMIT' },
  'competitions.entrant.outOfMemory': { ru: 'НЕ ХВАТИЛО ПАМЯТИ', en: 'OUT OF MEMORY' },
  'competitions.entrant.cancelled': { ru: 'ОТМЕНЕНА', en: 'CANCELLED' },

  /* Те же исходы словами преподавателя (A3). */
  'competitions.teacher.scored': { ru: 'ГОТОВО', en: 'DONE' },
  'competitions.teacher.notebookFailed': { ru: 'УПАЛА ТЕТРАДЬ', en: 'NOTEBOOK FAILED' },
  'competitions.teacher.rejected': { ru: 'ОТВЕТ НЕ ПРИНЯТ', en: 'ANSWER REJECTED' },
  'competitions.teacher.timedOut': { ru: 'ВЫШЛО ВРЕМЯ', en: 'OUT OF TIME' },
  'competitions.teacher.outOfMemory': { ru: 'НЕ ХВАТИЛО ПАМЯТИ', en: 'OUT OF MEMORY' },
  'competitions.teacher.metricFailed': { ru: 'УПАЛА МЕТРИКА', en: 'METRIC FAILED' },
  'competitions.teacher.cancelled': { ru: 'ОТМЕНЕНА', en: 'CANCELLED' },

  /*
   * Упавший код метрики — ошибка преподавателя, и участнику показывают не
   * плашку, а фразу: плашка называла бы виноватым его.
   */
  'competitions.metricFailedNote': {
    ru: 'Проверяющий код упал. Преподаватель уже знает, посылка будет пересчитана',
    en: 'The scoring code failed. The teacher already knows; this submission will be rescored',
  },

  /* Полоса этапов под идущей посылкой (P2). */
  'competitions.stage.accepted': { ru: 'ПРИНЯТА', en: 'ACCEPTED' },
  'competitions.stage.queue': { ru: 'ОЧЕРЕДЬ', en: 'QUEUE' },
  'competitions.stage.notebook': { ru: 'ЗАПУСК ТЕТРАДИ', en: 'RUNNING NOTEBOOK' },
  'competitions.stage.check': { ru: 'ПРОВЕРКА CSV', en: 'CHECKING CSV' },
  'competitions.stage.score': { ru: 'ОЦЕНКА', en: 'SCORING' },

  /* Направление метрики словами (A1, A2, P2, P3); стрелка ↑↓ — не перевод, а знак. */
  'competitions.direction.lower': { ru: 'меньше — лучше', en: 'lower is better' },
  'competitions.direction.higher': { ru: 'больше — лучше', en: 'higher is better' },

  /* Пометка выбранной посылки — строчными и с галочкой, так в макете. */
  'competitions.counted': { ru: 'в зачёт', en: 'counted' },

  /* Заголовок публичных страниц: «COLLOQ | Соревнования» в верхней полосе (P1). */
  'competitions.title': { ru: 'Соревнования', en: 'Competitions' },
  'competitions.loading': { ru: 'Открываем соревнования…', en: 'Opening competitions…' },

  /*
   * ОТКАЗЫ ДВЕРЕЙ `/api/k`.
   *
   * Каждый говорит, ЧТО СДЕЛАТЬ, а не какая проверка не прошла: эти строки
   * читает студент за минуту до дедлайна, и «forbidden» ему не поможет.
   * Отдельно разведены «такого ключа нет» и «ключ отключён»: в первом случае
   * человек ошибся буквой, во втором — ему уже выдали новый, и идти надо к
   * разным людям.
   */
  'competitions.refusal.notJson': {
    ru: 'Это не тетрадь: файл не читается как .ipynb. Сохраните тетрадь из Jupyter и пришлите её целиком.',
    en: 'This is not a notebook: the file does not read as .ipynb. Save the notebook from Jupyter and send the whole file.',
  },
  'competitions.refusal.notNotebook': {
    ru: 'В файле нет ячеек. Нужна тетрадь .ipynb, а не другой файл с тем же расширением.',
    en: 'The file has no cells. A notebook .ipynb is needed, not another file with the same extension.',
  },
  'competitions.refusal.brokenCell': {
    ru: 'Тетрадь повреждена: у одной из ячеек нет типа. Откройте её в Jupyter, сохраните заново и пришлите.',
    en: 'The notebook is damaged: one of the cells has no type. Open it in Jupyter, save it again and send it.',
  },
  'competitions.refusal.notIpynb': {
    ru: 'Принимается только тетрадь .ipynb.',
    en: 'Only an .ipynb notebook is accepted.',
  },
  'competitions.refusal.noFile': {
    ru: 'Файл не приехал. Выберите тетрадь .ipynb и попробуйте ещё раз.',
    en: 'No file arrived. Pick an .ipynb notebook and try again.',
  },
  'competitions.refusal.tooBig': {
    ru: 'Тетрадь больше {count} МБ. Очистите вывод ячеек и пришлите заново.',
    en: 'The notebook is over {count} MB. Clear the cell output and send it again.',
  },
  'competitions.refusal.keyUnknown': {
    ru: 'Такого ключа нет. Проверьте, что переписали его целиком: три группы по три знака.',
    en: 'No such key. Check that you copied all of it: three groups of three characters.',
  },
  'competitions.refusal.keyDisabled': {
    ru: 'Этот ключ отключён — вам выдали новый. Войдите по нему.',
    en: 'This key has been turned off — a new one was issued to you. Sign in with that one.',
  },
  'competitions.refusal.signIn': {
    ru: 'Войдите по ключу или вступите в соревнование.',
    en: 'Sign in with your key, or join the competition.',
  },
  'competitions.refusal.nameEmpty': {
    ru: 'Назовитесь: имя видно в лидерборде.',
    en: 'Enter your name: it is shown on the leaderboard.',
  },
  'competitions.refusal.nameTaken': {
    ru: 'В этом соревновании уже есть участник с таким именем. Добавьте фамилию или инициал — в лидерборде вас должны различать.',
    en: 'This competition already has someone with that name. Add a surname or an initial — the leaderboard has to tell you apart.',
  },
  'competitions.refusal.notFound': {
    ru: 'Такого соревнования нет.',
    en: 'No such competition.',
  },
  'competitions.refusal.notOpen': {
    ru: 'Соревнование ещё не открыто.',
    en: 'The competition has not opened yet.',
  },
  'competitions.refusal.closed': {
    ru: 'Приём посылок закрыт: дедлайн прошёл.',
    en: 'Submissions are closed: the deadline has passed.',
  },
  'competitions.refusal.notJoined': {
    ru: 'Сначала вступите в соревнование.',
    en: 'Join the competition first.',
  },
  'competitions.refusal.inFlight': {
    ru: 'Ваша прошлая посылка ещё исполняется. Дождитесь её — по одной за раз.',
    en: 'Your previous submission is still running. Wait for it — one at a time.',
  },
  'competitions.refusal.dailyQuota': {
    ru: {
      one: 'На сегодня посылки кончились: {count} в день на участника.',
      few: 'На сегодня посылки кончились: {count} в день на участника.',
      many: 'На сегодня посылки кончились: {count} в день на участника.',
      other: 'На сегодня посылки кончились: {count} в день на участника.',
    },
    en: {
      one: 'No submissions left today: {count} per day per participant.',
      other: 'No submissions left today: {count} per day per participant.',
    },
  },
  'competitions.refusal.tooOften': {
    ru: 'Слишком часто. Подождите минуту и повторите.',
    en: 'Too often. Wait a minute and try again.',
  },
  'competitions.refusal.privateClosed': {
    ru: 'Итоговый лидерборд откроется после дедлайна.',
    en: 'The final leaderboard opens after the deadline.',
  },
  'competitions.refusal.notYours': {
    ru: 'Это не ваша посылка.',
    en: 'That submission is not yours.',
  },
  'competitions.refusal.notScored': {
    ru: 'В зачёт идёт только посылка, дошедшая до числа.',
    en: 'Only a submission that reached a score can be counted.',
  },
  'competitions.refusal.chooseAutomatic': {
    ru: 'В этом соревновании зачётная посылка выбирается автоматически.',
    en: 'This competition selects the counted submission automatically.',
  },
  'competitions.refusal.chooseClosed': {
    ru: 'Выбор зачётной посылки закрылся вместе с приёмом: после дедлайна его не поменять.',
    en: 'Picking the counted submission closed together with intake: it cannot be changed after the deadline.',
  },
  'competitions.refusal.fileMissing': {
    ru: 'Такого файла у соревнования нет.',
    en: 'The competition has no such file.',
  },

  /*
   * Отказы ПАНЕЛИ — их читает преподаватель, и написаны они иначе.
   *
   * Участнику отказ объясняет правило («по одной за раз»), преподавателю —
   * называет поле или недостающий кусок: он не нарушил правило, он ещё не
   * дособрал соревнование. Ни один из них в макете не нарисован (их там нет
   * вовсе), поэтому слова здесь новые, а не вычитанные владельцем.
   */
  'competitions.refusal.noSubmission': {
    ru: 'Такой посылки нет.',
    en: 'No such submission.',
  },
  'competitions.refusal.noEntrant': {
    ru: 'Такого участника нет.',
    en: 'No such participant.',
  },
  'competitions.refusal.slug.empty': {
    ru: 'Адрес пустой. Это то, что участник наберёт после /k/.',
    en: 'The address is empty. It is what a participant types after /k/.',
  },
  'competitions.refusal.slug.chars': {
    ru: 'В адресе можно только строчные латинские буквы, цифры и дефис: его диктуют вслух и пишут на доске.',
    en: 'An address takes lowercase Latin letters, digits and dashes only: it gets dictated aloud and written on the board.',
  },
  'competitions.refusal.slug.reserved': {
    ru: 'Этот адрес занят самим Colloq. Возьмите другой.',
    en: 'That address belongs to Colloq itself. Pick another one.',
  },
  'competitions.refusal.slug.taken': {
    ru: 'Этот адрес уже занят другим соревнованием.',
    en: 'Another competition already has that address.',
  },
  'competitions.refusal.title': {
    ru: 'Назовите соревнование: название видно участнику в списке.',
    en: 'Give the competition a name: participants see it in the list.',
  },
  'competitions.refusal.environment': {
    ru: 'Имя окружения — строчные буквы, цифры и дефисы.',
    en: 'An environment name takes lowercase letters, digits and dashes.',
  },
  'competitions.refusal.range': {
    ru: '{field}: допустимо от {min} до {max}.',
    en: '{field}: allowed from {min} to {max}.',
  },
  'competitions.refusal.value': {
    ru: '{field}: такого значения нет.',
    en: '{field}: no such value.',
  },
  'competitions.refusal.notMultipart': {
    ru: 'Ожидалась загрузка файла.',
    en: 'A file upload was expected.',
  },
  'competitions.refusal.uploadCutOff': {
    ru: 'Загрузка оборвалась на середине. Файл не сохранён — попробуйте ещё раз.',
    en: 'The upload was cut off. Nothing was saved — try again.',
  },
  'competitions.refusal.badName': {
    ru: '{name}: такое имя файла не годится. Без путей и без точки в начале.',
    en: '{name}: that file name will not do. No paths, no leading dot.',
  },
  'competitions.refusal.dataFull': {
    ru: 'Данных у соревнования может быть до {mb} МБ. Удалите лишние файлы или уменьшите таблицу.',
    en: 'A competition holds up to {mb} MB of data. Drop the spare files or shrink the table.',
  },
  'competitions.refusal.tooManyFiles': {
    ru: 'Файлов данных может быть до {max}.',
    en: 'A competition holds up to {max} data files.',
  },
  'competitions.refusal.noBaselineFile': {
    ru: 'Сэмпл-тетрадь ещё не загружена.',
    en: 'The sample notebook has not been uploaded yet.',
  },
  'competitions.refusal.noBaselineRun': {
    ru: 'Метрику не на чем проверять: базовое решение ещё не оставило ответа. Проверьте сэмпл-тетрадь целиком.',
    en: 'There is nothing to score: the baseline has not produced an answer yet. Run the whole sample notebook first.',
  },

  /* Почему соревнование ещё нельзя открыть — по секциям редактора, сверху вниз. */
  'competitions.refusal.open.noData': {
    ru: 'Открыть нечего: нет ни одного файла данных.',
    en: 'Nothing to open: there is not a single data file.',
  },
  'competitions.refusal.open.noSolution': {
    ru: 'Нет файла ответов — считать посылки будет не по чему.',
    en: 'There is no answer file — there would be nothing to score against.',
  },
  'competitions.refusal.open.noMetric': {
    ru: 'Код метрики пуст.',
    en: 'The metric code is empty.',
  },
  'competitions.refusal.open.noBaseline': {
    ru: 'Нет сэмпл-тетради: участнику не с чего начать.',
    en: 'There is no sample notebook: a participant has nothing to start from.',
  },
  'competitions.refusal.open.baselineNotChecked': {
    ru: 'Сэмпл-тетрадь ещё не прошла весь путь до числа. Задачу, которая не решается даже у автора, открывать нечего.',
    en: 'The sample notebook has not gone all the way to a score yet. A task that does not solve even for its author is not ready to open.',
  },
  'competitions.refusal.open.noDeadline': {
    ru: 'Приватный лидерборд открывает дедлайн, а дедлайна нет. Назначьте дату или откройте его вручную.',
    en: 'The deadline is what opens the private leaderboard, and there is no deadline. Set a date, or open it by hand.',
  },

  'competitions.refusal.notDraft': {
    ru: 'Соревнование уже открыто.',
    en: 'The competition is already open.',
  },
  'competitions.refusal.notLive': {
    ru: 'Завершать нечего: соревнование не идёт.',
    en: 'Nothing to finish: the competition is not running.',
  },
  'competitions.refusal.notRunning': {
    ru: 'Этот прогон уже не идёт.',
    en: 'That run is no longer going.',
  },
  'competitions.refusal.killRefused': {
    ru: 'Прогон убить не вышло: исполнителя в этом процессе нет или контейнер уже закончился.',
    en: 'The run could not be killed: this process has no runner, or the container had already finished.',
  },
  'competitions.refusal.notRescorable': {
    ru: 'Пересчитывать нечего: эта посылка не оставила ответа.',
    en: 'Nothing to rescore: this submission left no answer.',
  },
  'competitions.refusal.cannotRerun': {
    ru: 'Исполнить заново нечего: посылка ещё идёт или её тетрадь уже убрана с диска.',
    en: 'Nothing to run again: the submission is still going, or its notebook has been swept from disk.',
  },

  /* Что именно отказано не-владельцу — подставляется в «Только владелец может …». */
  'competitions.owner.delete': {
    ru: 'удалить соревнование',
    en: 'delete a competition',
  },
  'competitions.owner.finish': {
    ru: 'завершить соревнование',
    en: 'finish a competition',
  },
  'competitions.owner.dropSolution': {
    ru: 'удалить файл ответов',
    en: 'delete the answer file',
  },
  'competitions.owner.rotateKey': {
    ru: 'выдать участнику новый ключ',
    en: 'issue a participant a new key',
  },
  'competitions.owner.dropSubmission': {
    ru: 'снять посылку с зачёта',
    en: 'drop a submission from the standings',
  },

  /** Служебный участник, на которого записана сэмпл-тетрадь. */
  'competitions.baselineEntrant': {
    ru: 'Базовое решение',
    en: 'Baseline',
  },
  'competitions.note.droppedByTeacher': {
    ru: 'Преподаватель снял эту посылку с зачёта.',
    en: 'The teacher dropped this submission from the standings.',
  },

  /*
   * ЧТО ЧИТАЕТ УЧАСТНИК ПРО СВОЮ ПОСЫЛКУ.
   *
   * Плашка называет исход одним словом («ЛИМИТ ВРЕМЕНИ»), а эти строки —
   * числом: «не уложилась в 10 минут, шла ячейка 6 из 50». Слово без числа
   * отправляет человека к преподавателю, число отправляет его в свою тетрадь.
   *
   * Трассировка упавшей ячейки сюда не попадает: она приезжает из контейнера и
   * уезжает участнику дословно — он её и писал.
   */
  'competitions.answer.cellFailed': {
    ru: 'Тетрадь упала на ячейке {cell} из {cells}.',
    en: 'The notebook failed at cell {cell} of {cells}.',
  },
  'competitions.answer.timeout': {
    ru: {
      one: 'Тетрадь не уложилась в {count} минуту: прогон остановлен на ячейке {cell} из {cells}.',
      few: 'Тетрадь не уложилась в {count} минуты: прогон остановлен на ячейке {cell} из {cells}.',
      many: 'Тетрадь не уложилась в {count} минут: прогон остановлен на ячейке {cell} из {cells}.',
      other: 'Тетрадь не уложилась в {count} минуты: прогон остановлен на ячейке {cell} из {cells}.',
    },
    en: {
      one: 'The notebook did not finish within {count} minute: it was stopped at cell {cell} of {cells}.',
      other: 'The notebook did not finish within {count} minutes: it was stopped at cell {cell} of {cells}.',
    },
  },
  'competitions.answer.outOfMemory': {
    ru: 'Тетрадь заняла больше {count} ГБ и была остановлена на ячейке {cell}.',
    en: 'The notebook used more than {count} GB and was stopped at cell {cell}.',
  },
  'competitions.answer.kernelDied': {
    ru: 'Ядро умерло на ячейке {cell}. Так бывает от os._exit(), от падения в си и от нехватки памяти внутри самой ячейки.',
    en: 'The kernel died at cell {cell}. That happens with os._exit(), with a crash inside a C extension, and when a single cell runs out of memory.',
  },
  'competitions.answer.exited': {
    ru: 'Тетрадь завершила работу сама на ячейке {cell}, не дойдя до конца.',
    en: 'The notebook exited on its own at cell {cell}, before reaching the end.',
  },
  'competitions.answer.tooMuchOutput': {
    ru: 'Тетрадь напечатала больше {count} МБ и была остановлена на ячейке {cell}. Уберите печать из циклов.',
    en: 'The notebook printed more than {count} MB and was stopped at cell {cell}. Remove printing from your loops.',
  },
  'competitions.answer.noFile': {
    ru: 'Тетрадь дошла до конца, но файла {file} не оставила. Запишите ответ в текущую папку — именно его забирает проверка.',
    en: 'The notebook finished but left no {file}. Write your answer into the working directory — that file is what the check picks up.',
  },
  'competitions.answer.tooLarge': {
    ru: 'Файл {file} больше {count} МБ — такой ответ не принимается.',
    en: 'The file {file} is over {count} MB — an answer that size is not accepted.',
  },
  'competitions.answer.unreadable': {
    ru: 'Файл {file} не удалось прочитать.',
    en: 'The file {file} could not be read.',
  },

  /*
   * Проверки САМОЙ ПРОВЕРКИ — то, что не сошлось между ответом и ответами.
   *
   * Приезжают из контейнера кодом, а не фразой, и переводятся здесь: страница
   * участника бывает на двух языках, а контейнер о языке инстанса не знает и
   * знать не должен. Ошибка, которую поднял сам преподаватель
   * (ParticipantVisibleError), сюда не заходит — она уезжает его словами.
   */
  'competitions.answer.noIdColumn': {
    ru: 'В ответе нет колонки «{column}». Есть: {columns}.',
    en: 'The answer has no column “{column}”. It has: {columns}.',
  },
  'competitions.answer.duplicateId': {
    ru: 'Колонка «{column}» повторяется, например {example}. На каждую строку теста нужен ровно один прогноз.',
    en: 'Column “{column}” repeats, for example {example}. Each test row needs exactly one prediction.',
  },
  'competitions.answer.missingRows': {
    ru: {
      one: 'В ответе нет {count} строки, например {column}={example}.',
      few: 'В ответе нет {count} строк, например {column}={example}.',
      many: 'В ответе нет {count} строк, например {column}={example}.',
      other: 'В ответе нет {count} строк, например {column}={example}.',
    },
    en: {
      one: 'The answer is missing {count} row, for example {column}={example}.',
      other: 'The answer is missing {count} rows, for example {column}={example}.',
    },
  },
  'competitions.answer.unparsable': {
    ru: 'Файл ответа не читается как таблица: {reason}',
    en: 'The answer file does not read as a table: {reason}',
  },

  /*
   * ЧТО ЧИТАЕТ ПРЕПОДАВАТЕЛЬ И ТОЛЬКО ОН.
   *
   * Эти строки описывают его собственную ошибку: не залитые ответы, пустую
   * метрику, снятый прогон. Участник на их месте видит фразу про упавший
   * проверяющий код — виноватого надо называть правильно.
   */
  'competitions.answer.noMetric': {
    ru: 'Код метрики пуст: считать посылку нечем. Заполните score(solution, submission) в настройках соревнования.',
    en: 'The metric code is empty: there is nothing to score with. Fill in score(solution, submission) in the competition settings.',
  },
  'competitions.answer.noSolution': {
    ru: 'Файла ответов {file} нет на диске — посылку не по чему проверять.',
    en: 'The answer file {file} is not on disk — there is nothing to check the submission against.',
  },
  'competitions.answer.gone': {
    ru: 'Пересчитать нечего: файл {file} этой посылки уже убран с диска.',
    en: 'Nothing to rescore: this submission’s {file} has already been swept from disk.',
  },
  // The teacher's column when a server restart cut a run off for the last time
  // (server/src/competitions/store.ts · reclaimQueue).
  'competitions.answer.restartAbandoned': {
    ru: 'Прогон оборван перезапуском сервера (попыток: {attempts}).',
    en: 'The run was cut off by a server restart (attempts: {attempts}).',
  },
  'competitions.answer.killedByTeacher': {
    ru: 'Прогон прерван преподавателем.',
    en: 'The run was killed by the teacher.',
  },
  'competitions.answer.killedByEntrant': {
    ru: 'Посылку снял сам участник.',
    en: 'The participant cancelled the submission.',
  },
  'competitions.refusal.tooLateToCancel': {
    ru: 'Отменять уже нечего: посылка закончилась, пока ехал запрос.',
    en: 'Nothing left to cancel: the submission finished while the request was on its way.',
  },

  /*
   * СТРАНИЦЫ УЧАСТНИКА (P1–P4).
   *
   * Русские строки — дословно из макетов `MC0-0`, `M1U-0`, `M7X-0`, `MK8-0`;
   * там, где макет молчит (пустые списки, отказы, телефон в тех местах, где он
   * не нарисован), слова новые и написаны в том же тоне: что сделать, а не что
   * не сошлось.
   *
   * Префикс `p.` — «participant»: тот же каталог грузит и панель, и эти
   * страницы, и по префиксу видно, чьё слово правят. Расхождения между
   * десктопом и телефоном («ВЫБРАТЬ ФАЙЛ» против «ВЫБРАТЬ ФАЙЛ .IPYNB») — это
   * РАЗНЫЕ ключи, а не одна строка с оговоркой: владелец вычитал обе.
   */
  'competitions.p.keyLink': { ru: 'ключ входа', en: 'sign-in key' },
  'competitions.p.back': { ru: '‹ Соревнования', en: '‹ Competitions' },

  /* P1 · выбор соревнования */
  'competitions.p.lead': {
    ru: 'Выберите соревнование, изучите задачу и отправьте решение.\nРезультаты проверки появятся в лидерборде.',
    en: 'Pick a competition, study the task and send a solution.\nThe results of the check appear on the leaderboard.',
  },
  'competitions.p.sectionRunning': { ru: 'ИДУТ СЕЙЧАС', en: 'RUNNING NOW' },
  'competitions.p.sectionFinished': { ru: 'ЗАВЕРШЁННЫЕ', en: 'FINISHED' },
  'competitions.p.left': { ru: 'ОСТАЛОСЬ', en: 'TIME LEFT' },
  'competitions.p.you': { ru: 'ВЫ', en: 'YOU' },
  'competitions.p.openCompetition': { ru: 'ОТКРЫТЬ', en: 'OPEN' },
  'competitions.p.join': { ru: 'УЧАСТВОВАТЬ', en: 'JOIN' },
  'competitions.p.notJoined': { ru: 'ещё не участвуете', en: 'not taking part yet' },
  'competitions.p.entrants': {
    ru: {
      one: '{count} участник',
      few: '{count} участника',
      many: '{count} участников',
      other: '{count} участников',
    },
    en: { one: '{count} participant', other: '{count} participants' },
  },
  'competitions.p.submissionsCount': {
    ru: {
      one: '{count} посылка',
      few: '{count} посылки',
      many: '{count} посылок',
      other: '{count} посылок',
    },
    en: { one: '{count} submission', other: '{count} submissions' },
  },
  'competitions.p.inFlight': { ru: '{count} в работе', en: '{count} in flight' },
  'competitions.p.leader': { ru: 'лидер {score}', en: 'leader {score}' },
  'competitions.p.baseline': { ru: 'бейзлайн {score}', en: 'baseline {score}' },
  'competitions.p.untilDate': { ru: 'до {date}', en: 'until {date}' },
  'competitions.p.untilToday': { ru: 'сегодня до {time}', en: 'today until {time}' },
  'competitions.p.noDeadline': { ru: 'без дедлайна', en: 'no deadline' },
  'competitions.p.closedNow': { ru: 'приём закрыт', en: 'submissions closed' },
  'competitions.p.finishedAt': { ru: 'завершено {date}', en: 'finished {date}' },
  'competitions.p.resultsOpen': { ru: 'итоги опубликованы', en: 'final results published' },
  'competitions.p.resultsClosed': {
    ru: 'итоги ещё не опубликованы',
    en: 'final results not published yet',
  },
  'competitions.p.results': { ru: 'Итоги и разбор', en: 'Results and review' },
  'competitions.p.emptyRunning': { ru: 'Сейчас ничего не идёт.', en: 'Nothing is running right now.' },
  'competitions.p.emptyFinished': {
    ru: 'Завершённых соревнований пока нет.',
    en: 'No competitions have finished yet.',
  },
  'competitions.p.emptyAll': {
    ru: 'Соревнований пока нет. Преподаватель откроет их, когда задача будет готова.',
    en: 'No competitions yet. The teacher opens one once the task is ready.',
  },

  /* P1 · карточка ключа и вход по сохранённому ключу */
  'competitions.p.keyTitle': { ru: 'ВАШ КЛЮЧ ВХОДА', en: 'YOUR SIGN-IN KEY' },
  'competitions.p.keyExplain': {
    ru: 'Сохраните ключ, чтобы войти с другого устройства или после очистки браузера. Ваши посылки и результаты сохранятся.',
    en: 'Save the key to sign in from another device, or after clearing the browser. Your submissions and results stay with you.',
  },
  'competitions.p.keyCopy': { ru: 'Скопировать', en: 'Copy' },
  'competitions.p.keyLinkButton': { ru: 'Ссылка для входа', en: 'Sign-in link' },
  'competitions.p.copied': { ru: 'Скопировано', en: 'Copied' },
  'competitions.p.keyFootnote': {
    ru: 'Если потеряете ключ, попросите новый у преподавателя. Старый ключ будет отключён.',
    en: 'If you lose the key, ask the teacher for a new one. The old key stops working.',
  },
  'competitions.p.signInTitle': {
    ru: 'ВОЙТИ С СОХРАНЁННЫМ КЛЮЧОМ',
    en: 'SIGN IN WITH A SAVED KEY',
  },
  'competitions.p.keyPlaceholder': { ru: 'Введите ключ', en: 'Enter the key' },
  'competitions.p.signIn': { ru: 'Войти', en: 'Sign in' },
  'competitions.p.signOut': { ru: 'Выйти', en: 'Sign out' },
  'competitions.p.noKey': {
    ru: 'Ключ появится, когда вы вступите в первое соревнование.',
    en: 'Your key appears once you join your first competition.',
  },
  'competitions.p.keyShape': {
    ru: 'Ключ — три группы по три знака, например K7Q-M2X-9FD.',
    en: 'A key is three groups of three characters, for example K7Q-M2X-9FD.',
  },

  /* Вступление: в макете кнопка одна, а имя спросить всё равно надо. */
  'competitions.p.joinTitle': { ru: 'Как вас зовут?', en: 'What is your name?' },
  'competitions.p.joinHint': {
    ru: 'Имя видно в лидерборде — по нему вас узнают одногруппники.',
    en: 'The name shows on the leaderboard — it is how classmates recognise you.',
  },
  'competitions.p.namePlaceholder': { ru: 'Имя и фамилия', en: 'First and last name' },
  'competitions.p.cancel': { ru: 'Отмена', en: 'Cancel' },

  /* Шапка соревнования (P2, P3, P4) */
  'competitions.p.toDeadline': { ru: 'ДО ДЕДЛАЙНА', en: 'TO THE DEADLINE' },
  'competitions.p.yourPlace': { ru: 'ВАШЕ МЕСТО', en: 'YOUR PLACE' },
  'competitions.p.finalPlace': { ru: 'ИТОГОВОЕ МЕСТО', en: 'FINAL PLACE' },
  'competitions.p.placeShort': { ru: 'МЕСТО', en: 'PLACE' },
  'competitions.p.placeOf': { ru: '{place} из {total}', en: '{place} of {total}' },
  'competitions.p.shiftUp': { ru: 'ВЫШЕ НА', en: 'UP BY' },
  'competitions.p.shiftDown': { ru: 'НИЖЕ НА', en: 'DOWN BY' },
  'competitions.p.shiftNone': { ru: 'МЕСТО ТО ЖЕ', en: 'SAME PLACE' },
  'competitions.p.places': {
    ru: { one: '{count} место', few: '{count} места', many: '{count} мест', other: '{count} мест' },
    en: { one: '{count} place', other: '{count} places' },
  },
  'competitions.p.tabTask': { ru: 'Задача и данные', en: 'Task and data' },
  'competitions.p.tabTaskShort': { ru: 'Задача', en: 'Task' },
  'competitions.p.tabSubmissions': { ru: 'Посылки', en: 'Submissions' },
  'competitions.p.tabLeaderboard': { ru: 'Лидерборд', en: 'Leaderboard' },

  /* Вкладка «Задача и данные» — её в макете нет вовсе. */
  'competitions.p.dataTitle': { ru: 'ОТКРЫТЫЕ ДАННЫЕ', en: 'OPEN DATA' },
  'competitions.p.dataNote': {
    ru: 'В контейнере эти файлы лежат в папке data/ и доступны только на чтение.',
    en: 'Inside the container these files sit in data/ and are read-only.',
  },
  /* `{n}` — число с пробелами по-человечески («7 340»), `{count}` выбирает форму. */
  'competitions.p.rows': {
    ru: { one: '{n} строка', few: '{n} строки', many: '{n} строк', other: '{n} строк' },
    en: { one: '{n} row', other: '{n} rows' },
  },
  'competitions.p.noFiles': { ru: 'Файлов данных нет.', en: 'There are no data files.' },
  'competitions.p.sizeBytes': { ru: '{count} Б', en: '{count} B' },
  'competitions.p.sizeKb': { ru: '{size} КБ', en: '{size} KB' },
  'competitions.p.sizeMb': { ru: '{size} МБ', en: '{size} MB' },
  'competitions.p.noDescription': {
    ru: 'Условие ещё не написано.',
    en: 'The task text has not been written yet.',
  },

  /* Зона отправки (P2) и кнопка телефона (P4) */
  'competitions.p.dropTitle': { ru: 'Перетащите тетрадь .ipynb', en: 'Drop an .ipynb notebook' },
  'competitions.p.dropHere': { ru: 'Отпустите тетрадь здесь', en: 'Let the notebook go here' },
  'competitions.p.dropNeedsCsv': {
    ru: 'Для проверки тетрадь должна создать файл submission.csv.',
    en: 'To be checked, the notebook has to create the file submission.csv.',
  },
  'competitions.p.dropLeftToday': {
    ru: {
      one: 'Сегодня можно отправить ещё {count} посылку из {perDay}.',
      few: 'Сегодня можно отправить ещё {count} посылки из {perDay}.',
      many: 'Сегодня можно отправить ещё {count} посылок из {perDay}.',
      other: 'Сегодня можно отправить ещё {count} посылок из {perDay}.',
    },
    en: {
      one: 'You can send {count} more submission today, out of {perDay}.',
      other: 'You can send {count} more submissions today, out of {perDay}.',
    },
  },
  'competitions.p.dropNoLimit': {
    ru: 'Число посылок в день не ограничено.',
    en: 'There is no daily limit on submissions.',
  },
  'competitions.p.pickFile': { ru: 'ВЫБРАТЬ ФАЙЛ', en: 'CHOOSE A FILE' },
  'competitions.p.pickFilePhone': { ru: 'ВЫБРАТЬ ФАЙЛ .IPYNB', en: 'CHOOSE AN .IPYNB FILE' },
  'competitions.p.sending': { ru: 'Отправляем тетрадь…', en: 'Sending the notebook…' },
  'competitions.p.phoneNeedsCsv': {
    ru: 'Тетрадь должна создать submission.csv.',
    en: 'The notebook has to create submission.csv.',
  },
  'competitions.p.phoneLeftToday': {
    ru: {
      one: 'Сегодня осталась {count} посылка из {perDay}.',
      few: 'Сегодня осталось {count} посылки из {perDay}.',
      many: 'Сегодня осталось {count} посылок из {perDay}.',
      other: 'Сегодня осталось {count} посылок из {perDay}.',
    },
    en: {
      one: '{count} submission left today, out of {perDay}.',
      other: '{count} submissions left today, out of {perDay}.',
    },
  },
  'competitions.p.phoneLimits': {
    ru: {
      one: 'Проверка: до {count} минуты, без доступа к интернету.',
      few: 'Проверка: до {count} минут, без доступа к интернету.',
      many: 'Проверка: до {count} минут, без доступа к интернету.',
      other: 'Проверка: до {count} минут, без доступа к интернету.',
    },
    en: {
      one: 'The check: up to {count} minute, with no internet access.',
      other: 'The check: up to {count} minutes, with no internet access.',
    },
  },

  /* Список «Мои посылки» */
  'competitions.p.mine': { ru: 'Мои посылки', en: 'My submissions' },
  'competitions.p.chooseHint': {
    ru: 'Выберите посылку для итогового зачёта.\nБез выбора учтём лучшую по публичному результату.',
    en: 'Pick the submission that counts.\nWith no pick we take your best public result.',
  },
  'competitions.p.cancelRun': { ru: 'Отменить', en: 'Cancel' },
  'competitions.p.more': { ru: 'Подробнее', en: 'Details' },
  'competitions.p.less': { ru: 'Свернуть', en: 'Hide' },
  'competitions.p.phoneMore': { ru: 'Открыть подробности ошибки', en: 'Open the error details' },
  'competitions.p.chooseIt': { ru: 'Выбрать в зачёт', en: 'Count this one' },
  'competitions.p.publicPart': { ru: 'публичная часть', en: 'public part' },
  'competitions.p.best': { ru: 'лучший результат', en: 'best result' },
  'competitions.p.showMore': {
    ru: {
      one: 'Показать ещё {count} посылку',
      few: 'Показать ещё {count} посылки',
      many: 'Показать ещё {count} посылок',
      other: 'Показать ещё {count} посылок',
    },
    en: {
      one: 'Show {count} more submission',
      other: 'Show {count} more submissions',
    },
  },
  'competitions.p.downloadRun': {
    ru: 'Скачать тетрадь с выводом',
    en: 'Download the notebook with its output',
  },
  'competitions.p.noSubmissions': {
    ru: 'Посылок пока нет. Отправьте тетрадь — результат появится здесь.',
    en: 'No submissions yet. Send a notebook and the result shows up here.',
  },
  'competitions.p.joinFirst': {
    ru: 'Вы ещё не вступили в это соревнование.',
    en: 'You have not joined this competition yet.',
  },

  /* Что написано под именем файла у идущей и у законченной посылки */
  'competitions.p.cellOf': { ru: 'Ячейка {cell} из {cells}', en: 'Cell {cell} of {cells}' },
  'competitions.p.cellRunning': {
    ru: 'Выполняется ячейка {cell} из {cells}',
    en: 'Running cell {cell} of {cells}',
  },
  'competitions.p.sentAt': { ru: 'отправлена в {time}', en: 'sent at {time}' },
  'competitions.p.waited': { ru: 'ожидание {duration}', en: 'waited {duration}' },
  'competitions.p.queueAt': { ru: '{place} в очереди', en: '{place} in the queue' },
  'competitions.p.afterMine': {
    ru: 'запуск после завершения посылки #{number}',
    en: 'starts once submission #{number} finishes',
  },
  'competitions.p.afterMineShort': {
    ru: 'запуск после посылки #{number}',
    en: 'starts after submission #{number}',
  },
  'competitions.p.queuePaused': {
    ru: 'очередь приостановлена преподавателем',
    en: 'the queue is paused by the teacher',
  },
  'competitions.p.eta': { ru: '≈ {duration}', en: '≈ {duration}' },
  'competitions.p.ofLimit': { ru: '{elapsed} из {limit}', en: '{elapsed} of {limit}' },
  'competitions.p.doneIn': { ru: 'выполнена за {duration}', en: 'finished in {duration}' },
  'competitions.p.failedAtCell': {
    ru: 'ошибка в ячейке {cell} из {cells} через {duration}',
    en: 'failed at cell {cell} of {cells} after {duration}',
  },
  'competitions.p.stoppedAtCell': {
    ru: 'остановка на ячейке {cell} из {cells}',
    en: 'stopped at cell {cell} of {cells}',
  },
  'competitions.p.cancelledNote': { ru: 'снята вами', en: 'cancelled by you' },
  'competitions.p.todayAt': { ru: 'Сегодня в {time}', en: 'Today at {time}' },
  'competitions.p.yesterdayAt': { ru: 'Вчера в {time}', en: 'Yesterday at {time}' },
  'competitions.p.dateAt': { ru: '{date} в {time}', en: '{date} at {time}' },

  /*
   * Порядковое место в очереди словом: «Третья в очереди».
   *
   * Словами до десятого и числом дальше — так это и читается вслух. Числом с
   * первого («1-я в очереди») макет не пишет, а словом до сотого не пишет
   * никто.
   */
  'competitions.p.ordinal.1': { ru: 'Первая', en: 'First' },
  'competitions.p.ordinal.2': { ru: 'Вторая', en: 'Second' },
  'competitions.p.ordinal.3': { ru: 'Третья', en: 'Third' },
  'competitions.p.ordinal.4': { ru: 'Четвёртая', en: 'Fourth' },
  'competitions.p.ordinal.5': { ru: 'Пятая', en: 'Fifth' },
  'competitions.p.ordinal.6': { ru: 'Шестая', en: 'Sixth' },
  'competitions.p.ordinal.7': { ru: 'Седьмая', en: 'Seventh' },
  'competitions.p.ordinal.8': { ru: 'Восьмая', en: 'Eighth' },
  'competitions.p.ordinal.9': { ru: 'Девятая', en: 'Ninth' },
  'competitions.p.ordinal.10': { ru: 'Десятая', en: 'Tenth' },
  'competitions.p.ordinalN': { ru: '{count}-я', en: '{count}th' },

  /*
   * Длительности — свои, а не общие с комнатой.
   *
   * У комнаты они живут в каталоге `room`, а страницы соревнований его не
   * грузят вовсе (web/src/lib/messages/competitions-*.ts): позвать оттуда
   * `spell()` значит показать на экране голый ключ `room.ui.1193`.
   */
  'competitions.p.durSeconds': { ru: '{count} с', en: '{count} s' },
  'competitions.p.durMinutesSeconds': { ru: '{minutes} мин {seconds} с', en: '{minutes} min {seconds} s' },
  'competitions.p.durMinutes': { ru: '{count} мин', en: '{count} min' },
  'competitions.p.durHoursMinutes': { ru: '{hours} ч {minutes} мин', en: '{hours} h {minutes} min' },
  'competitions.p.durDaysHours': { ru: '{days} дн {hours} ч', en: '{days} d {hours} h' },
  'competitions.p.durClockDays': { ru: '{days} дн {clock}', en: '{days} d {clock}' },
  'competitions.p.durInstant': { ru: 'меньше минуты', en: 'under a minute' },

  /* Правая колонка P2 · условия проверки */
  'competitions.p.conditions': { ru: 'УСЛОВИЯ ПРОВЕРКИ', en: 'CHECK CONDITIONS' },
  'competitions.p.condTime': { ru: 'Время', en: 'Time' },
  'competitions.p.condTimeValue': { ru: 'до {count} мин', en: 'up to {count} min' },
  'competitions.p.condMachine': { ru: 'Память · процессор', en: 'Memory · CPU' },
  'competitions.p.condMachineValue': { ru: '{memory} · {cores}', en: '{memory} · {cores}' },
  'competitions.p.gigabytes': { ru: '{count} ГБ', en: '{count} GB' },
  'competitions.p.cores': {
    ru: { one: '{count} ядро', few: '{count} ядра', many: '{count} ядер', other: '{count} ядер' },
    en: { one: '{count} core', other: '{count} cores' },
  },
  'competitions.p.condInternet': { ru: 'Интернет', en: 'Internet' },
  'competitions.p.condNo': { ru: 'нет', en: 'no' },
  'competitions.p.condEnvironment': { ru: 'Окружение', en: 'Environment' },
  'competitions.p.condData': { ru: 'Данные', en: 'Data' },
  'competitions.p.condDataValue': { ru: 'data/ · только чтение', en: 'data/ · read-only' },
  'competitions.p.condAnswer': { ru: 'Файл с прогнозами', en: 'Predictions file' },
  'competitions.p.conditionsNote': {
    ru: 'Проверка запускает все ячейки по порядку, без сохранённых переменных. Перед отправкой перезапустите ядро и выполните тетрадь целиком.',
    en: 'The check runs every cell in order, with no variables carried over. Before sending, restart the kernel and run the whole notebook.',
  },

  /* Лидерборд (P2 · мини-таблица, P3 · таблица) */
  'competitions.p.publicBoard': { ru: 'ПУБЛИЧНЫЙ ЛИДЕРБОРД', en: 'PUBLIC LEADERBOARD' },
  'competitions.p.openBoard': { ru: 'Открыть', en: 'Open' },
  'competitions.p.baselineRow': { ru: 'Базовое решение', en: 'Baseline' },
  'competitions.p.youRow': { ru: 'Вы', en: 'You' },
  'competitions.p.segmentPublic': { ru: 'Публичный · {percent} % теста', en: 'Public · {percent}% of the test' },
  'competitions.p.segmentFinal': { ru: 'Итоговый · {percent} % теста', en: 'Final · {percent}% of the test' },
  'competitions.p.finalNote': {
    ru: 'Итоговые места определены по скрытой части теста. Стрелки показывают изменение места относительно публичного лидерборда.',
    en: 'The final places come from the hidden part of the test. The arrows show how each place moved against the public leaderboard.',
  },
  'competitions.p.publicNote': {
    ru: 'Публичный лидерборд считается по открытой части теста. Итоговые места определит скрытая часть — она откроется после дедлайна.',
    en: 'The public leaderboard is scored on the open part of the test. The hidden part decides the final places and opens after the deadline.',
  },
  'competitions.p.colPlace': { ru: 'МЕСТО', en: 'PLACE' },
  'competitions.p.colShift': { ru: 'СДВИГ', en: 'SHIFT' },
  'competitions.p.colEntrant': { ru: 'УЧАСТНИК', en: 'PARTICIPANT' },
  'competitions.p.colFinalMetric': { ru: 'ИТОГОВЫЙ {metric}', en: 'FINAL {metric}' },
  'competitions.p.colPublicMetric': { ru: 'ПУБЛИЧНЫЙ {metric}', en: 'PUBLIC {metric}' },
  'competitions.p.colSubmissions': { ru: 'ПОСЫЛОК', en: 'SUBMISSIONS' },
  'competitions.p.colCounted': { ru: 'ПОСЫЛКА В ЗАЧЁТ', en: 'SUBMISSION THAT COUNTS' },
  'competitions.p.countedChosen': { ru: '#{number} · выбор участника', en: '#{number} · participant’s pick' },
  'competitions.p.countedYours': { ru: '#{number} · ваш выбор', en: '#{number} · your pick' },
  'competitions.p.countedLast': {
    ru: '#{number} · последняя посылка',
    en: '#{number} · latest submission',
  },
  'competitions.p.countedBest': {
    ru: '#{number} · лучший публичный результат',
    en: '#{number} · best public result',
  },
  'competitions.p.showMoreEntrants': {
    ru: {
      one: 'Показать ещё {count} участника',
      few: 'Показать ещё {count} участников',
      many: 'Показать ещё {count} участников',
      other: 'Показать ещё {count} участников',
    },
    en: { one: 'Show {count} more participant', other: 'Show {count} more participants' },
  },
  'competitions.p.tieNote': {
    ru: 'При одинаковом результате выше посылка, отправленная раньше.',
    en: 'On equal results the submission sent earlier ranks higher.',
  },
  'competitions.p.boardEmpty': {
    ru: 'Пока никто не дошёл до числа.',
    en: 'Nobody has reached a score yet.',
  },

  /* Живое обновление и отказы сети */
  'competitions.p.streamLost': {
    ru: 'Живое обновление прервалось — числа могут отстать.',
    en: 'The live updates broke off — the numbers may be behind.',
  },
  'competitions.p.retry': { ru: 'Повторить', en: 'Try again' },
}

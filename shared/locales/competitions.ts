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
  /* Live, but before its start date (shared/competitions.ts · competitionPhase). */
  'competitions.phase.soon': { ru: 'СКОРО', en: 'SOON' },

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
  // A waiting submission the participant replaced with a newer notebook before
  // it started (server/src/competitions/store.ts · acceptSubmission).
  'competitions.entrant.replaced': { ru: 'ЗАМЕНЕНА', en: 'REPLACED' },

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
  // A real notebook with an empty `cells` list — usually saved before the
  // work was (@shared/competitions · whyNotebookRefused).
  'competitions.refusal.noCells': {
    ru: 'В тетради нет ни одной ячейки: сохраните её из Jupyter после работы и пришлите заново.',
    en: 'The notebook has no cells at all: save it from Jupyter after your work and send it again.',
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
  /*
   * A name is a Telegram username or an email address (shared/competitions.ts ·
   * entrantHandle). The same words for an empty field: it is the same fix.
   */
  'competitions.refusal.nameNotHandle': {
    ru: 'Укажите логин Telegram (например, @ivan_petrov) или почту.',
    en: 'Enter your Telegram username (for example @ivan_petrov) or your email.',
  },
  /*
   * A handle belongs to one person, so the likeliest clash at the door is that
   * person on a new device without their cookie: the way back is the key, not
   * another name. "Add a surname or an initial" was the advice while names
   * were free text, and a username cannot take one.
   */
  'competitions.refusal.nameTaken': {
    ru: 'В этом соревновании уже есть участник с таким логином или почтой. Если это вы — войдите по своему ключу.',
    en: 'This competition already has a participant with this username or email. If that is you, sign in with your key.',
  },
  /* The teacher's rename (admin): the clash may be in any of the person's competitions. */
  'competitions.refusal.renameTaken': {
    ru: 'В одном из соревнований этого участника уже есть другой с таким логином или почтой.',
    en: "Another participant in one of this person's competitions already has this username or email.",
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
  /*
   * The ceiling on FAILED submissions (shared/competitions.ts ·
   * failedAttemptsCeiling). Never called "the limit": failures do not spend the
   * limit, and a refusal that said "limit" here would read as the old rule.
   */
  'competitions.refusal.dailyAttempts': {
    ru: {
      one: 'Сегодня у вас уже {count} упавшая посылка — больше за день проверка не берёт. Это не лимит посылок: упавшие его не тратят, но и бесконечно запускать их нельзя. Проверьте тетрадь у себя.',
      few: 'Сегодня у вас уже {count} упавшие посылки — больше за день проверка не берёт. Это не лимит посылок: упавшие его не тратят, но и бесконечно запускать их нельзя. Проверьте тетрадь у себя.',
      many: 'Сегодня у вас уже {count} упавших посылок — больше за день проверка не берёт. Это не лимит посылок: упавшие его не тратят, но и бесконечно запускать их нельзя. Проверьте тетрадь у себя.',
      other: 'Сегодня у вас уже {count} упавшей посылки — больше за день проверка не берёт. Это не лимит посылок: упавшие его не тратят, но и бесконечно запускать их нельзя. Проверьте тетрадь у себя.',
    },
    en: {
      one: '{count} of your submissions failed today — the most the check takes in a day. This is not the submission limit: failed ones do not spend it, but they cannot run endlessly either. Check the notebook on your own machine.',
      other: '{count} of your submissions failed today — the most the check takes in a day. This is not the submission limit: failed ones do not spend it, but they cannot run endlessly either. Check the notebook on your own machine.',
    },
  },
  /*
   * A late upload while the person's ON-TIME submission still waits: replacing
   * it would cancel a notebook that was in the standings with one that is not
   * (store.ts · intakePlan).
   */
  'competitions.refusal.inFlightOnTime': {
    ru: 'Ваша посылка, отправленная до дедлайна, ещё ждёт проверки. Поздняя посылка её не заменит — дождитесь результата.',
    en: 'Your submission sent before the deadline is still waiting for its check. A late one cannot take its place — wait for its result.',
  },
  'competitions.refusal.lateNotCounted': {
    ru: 'Поздняя посылка вне зачёта: выбрать её нельзя.',
    en: 'A late submission is outside the standings: it cannot be picked.',
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
  /* The hidden test's own budget (LIMITS.sealedBytes, LIMITS.sealedFiles). */
  'competitions.refusal.sealedFull': {
    ru: 'Скрытый тест может весить до {mb} МБ. Удалите лишние файлы или уменьшите таблицу.',
    en: 'The hidden test holds up to {mb} MB. Drop the spare files or shrink the table.',
  },
  'competitions.refusal.tooManySealed': {
    ru: 'Файлов скрытого теста может быть не больше {max}.',
    en: 'The hidden test takes at most {max} files.',
  },
  // A target name sent with more than one file: each file would land on it.
  'competitions.refusal.sealedOneName': {
    ru: 'Имя в data/ задаётся для одного файла. Загрузите файлы по одному или без имени — тогда каждый ляжет под своим.',
    en: 'A name in data/ is given for one file. Upload the files one by one, or without a name, and each keeps its own.',
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
  'competitions.owner.settings': {
    ru: 'менять настройки соревнований',
    en: 'change the competition settings',
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
  /*
   * After the traceback of a cell that died on `No module named 'X'`
   * (server/src/competitions/runner.ts · missingPackageHint). The traceback
   * names the module; only we know that the check has no network and where
   * packages come from instead. {name} is the package to install, one per
   * case: the competition takes participants' own package sets and none was
   * attached; a set was attached without it; own sets are turned off.
   */
  'competitions.answer.missingPackage.attach': {
    ru: 'Пакета {name} нет на сервере. Сети при проверке нет, поэтому `pip install` в тетради не сработает: добавьте {name} во вкладке «Пакеты» и прикрепите набор к посылке.',
    en: 'Package {name} is not on the server. The check runs without network, so `pip install` in the notebook will not work: add {name} on the Packages tab and attach the set to your submission.',
  },
  'competitions.answer.missingPackage.notInSet': {
    ru: '{name} нет в прикреплённом наборе пакетов: добавьте его во вкладке «Пакеты» и пришлите тетрадь с новым набором.',
    en: '{name} is not in the attached package set: add it on the Packages tab and send the notebook with the new set.',
  },
  'competitions.answer.missingPackage.askTeacher': {
    ru: 'Пакета {name} нет в окружении соревнования, а сети при проверке нет, поэтому `pip install` в тетради не сработает. Напишите преподавателю.',
    en: 'Package {name} is not in the competition environment, and the check runs without network, so `pip install` in the notebook will not work. Contact your teacher.',
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
  // The harness stops a late notebook a few seconds before the host's deadline
  // to save what it printed (harness.ts · STOP_EARLY), and that comes back as
  // cell_timeout. Unsaid, a run stopped at 118 s of 120 read as a limit shorter
  // than the one stated. A kill by the host at the deadline itself keeps the
  // words above: nothing was stopped early there.
  'competitions.answer.timeoutEarly': {
    ru: {
      one: 'Тетрадь не уложилась в {count} минуту: прогон остановлен на ячейке {cell} из {cells} за несколько секунд до лимита, чтобы успеть сохранить её вывод.',
      few: 'Тетрадь не уложилась в {count} минуты: прогон остановлен на ячейке {cell} из {cells} за несколько секунд до лимита, чтобы успеть сохранить её вывод.',
      many: 'Тетрадь не уложилась в {count} минут: прогон остановлен на ячейке {cell} из {cells} за несколько секунд до лимита, чтобы успеть сохранить её вывод.',
      other: 'Тетрадь не уложилась в {count} минуты: прогон остановлен на ячейке {cell} из {cells} за несколько секунд до лимита, чтобы успеть сохранить её вывод.',
    },
    en: {
      one: 'The notebook did not finish within {count} minute: it was stopped at cell {cell} of {cells} a few seconds before the limit, so that its output could still be saved.',
      other: 'The notebook did not finish within {count} minutes: it was stopped at cell {cell} of {cells} a few seconds before the limit, so that its output could still be saved.',
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
  // A column with an empty header, which pandas reads back as "Unnamed: 0",
  // that the answer key does not have: the index to_csv() writes without
  // index=False (harness.ts · align). {file} is the answer's file name.
  'competitions.answer.indexColumn': {
    ru: "В ответе лишняя колонка «{column}» — это индекс таблицы. Запишите ответ так: sub.to_csv('{file}', index=False).",
    en: "The answer has an extra column “{column}” — the DataFrame index. Write the answer like this: sub.to_csv('{file}', index=False).",
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
  // The rows are missing only because their ids are written in another form:
  // case, hyphens, spaces around, a number's leading zeros or ".0" (harness.ts
  // · align). {example} is an id as the answer writes it, {expected} the same
  // id as the test has it.
  'competitions.answer.idForm': {
    ru: '{column} в ответе записаны в другом виде, чем в тесте: например «{example}» вместо «{expected}» — сохраните {column} как в файле, строкой.',
    en: 'The answer writes {column} differently from the test: for example “{example}” instead of “{expected}”. Keep the {column} values exactly as in the file, as strings.',
  },
  // Every row is there, but a prediction column has blanks where the answer
  // key has values (harness.ts · align). {column} is the prediction column,
  // {idColumn}={example} the first such row.
  'competitions.answer.emptyPredictions': {
    ru: {
      one: 'В колонке {column} {count} пустой прогноз, например {idColumn}={example}.',
      few: 'В колонке {column} {count} пустых прогноза, например {idColumn}={example}.',
      many: 'В колонке {column} {count} пустых прогнозов, например {idColumn}={example}.',
      other: 'В колонке {column} {count} пустого прогноза, например {idColumn}={example}.',
    },
    en: {
      one: 'Column {column} has {count} empty prediction, for example {idColumn}={example}.',
      other: 'Column {column} has {count} empty predictions, for example {idColumn}={example}.',
    },
  },
  // Text in a prediction column where the answer key holds numbers (harness.ts
  // · align). {value} is one such value and {idColumn}={example} its row. The
  // separator is named only when a value is a number with a decimal comma,
  // and then {value} is that one.
  'competitions.answer.nonNumeric': {
    ru: 'В колонке {column} нечисловые значения, например «{value}» ({idColumn}={example}).',
    en: 'Column {column} has non-numeric values, for example “{value}” ({idColumn}={example}).',
  },
  'competitions.answer.decimalComma': {
    ru: 'В колонке {column} нечисловые значения, например «{value}» ({idColumn}={example}). Десятичный разделитель — точка.',
    en: 'Column {column} has non-numeric values, for example “{value}” ({idColumn}={example}). Use a dot as the decimal separator.',
  },
  // Infinity in a prediction column where the answer key holds numbers
  // (harness.ts · align): it reads as a number, and the metric crashes on it.
  'competitions.answer.infinitePredictions': {
    ru: {
      one: 'В колонке {column} {count} бесконечное значение (inf), например {idColumn}={example}.',
      few: 'В колонке {column} {count} бесконечных значения (inf), например {idColumn}={example}.',
      many: 'В колонке {column} {count} бесконечных значений (inf), например {idColumn}={example}.',
      other: 'В колонке {column} {count} бесконечного значения (inf), например {idColumn}={example}.',
    },
    en: {
      one: 'Column {column} has {count} infinite value (inf), for example {idColumn}={example}.',
      other: 'Column {column} has {count} infinite values (inf), for example {idColumn}={example}.',
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
  // The teacher's column of a waiting submission a newer upload replaced.
  'competitions.answer.replaced': {
    ru: 'Заменена посылкой #{number}, пока ждала в очереди.',
    en: 'Replaced by #{number} while it waited in the queue.',
  },

  /*
   * A run on the HIDDEN TEST, briefly (Competition.outputPolicy 'brief').
   *
   * Only our own words and numbers we can vouch for: the cell (clamped to the
   * cells the sent notebook has), the class of the exception from a short
   * list, the limits. Nothing the notebook printed or raised and nothing the
   * metric quoted from the answer: the notebook had the hidden rows in memory,
   * and any of those texts could carry them out (runner.ts · briefNote).
   */
  'competitions.answer.sealed.cellFailed': {
    ru: 'Тетрадь упала на ячейке {cell} из {cells}: {type}. Текст ошибки и вывод скрыты — проверка шла на скрытом тесте.',
    en: 'The notebook failed at cell {cell} of {cells}: {type}. The error text and outputs are hidden: the check ran on the hidden test.',
  },
  'competitions.answer.sealed.cellFailedUntyped': {
    ru: 'Тетрадь упала на ячейке {cell} из {cells}. Текст ошибки и вывод скрыты — проверка шла на скрытом тесте.',
    en: 'The notebook failed at cell {cell} of {cells}. The error text and outputs are hidden: the check ran on the hidden test.',
  },
  'competitions.answer.sealed.tooMuchOutput': {
    ru: 'Тетрадь печатала слишком много и была остановлена на ячейке {cell}. Уберите печать из циклов.',
    en: 'The notebook printed too much and was stopped at cell {cell}. Remove printing from your loops.',
  },
  'competitions.answer.sealed.metricRejected': {
    ru: 'Метрика не приняла ответ. Подробности скрыты — проверка шла на скрытом тесте.',
    en: 'The metric did not accept the answer. The details are hidden: the check ran on the hidden test.',
  },
  'competitions.answer.sealed.noIdColumn': {
    ru: 'В ответе нет колонки «{column}».',
    en: 'The answer has no column “{column}”.',
  },
  'competitions.answer.sealed.indexColumn': {
    ru: "В ответе лишняя колонка — индекс таблицы. Запишите ответ так: sub.to_csv('{file}', index=False).",
    en: "The answer has an extra column — the DataFrame index. Write the answer like this: sub.to_csv('{file}', index=False).",
  },
  'competitions.answer.sealed.duplicateId': {
    ru: 'Колонка «{column}» повторяется. На каждую строку теста нужен ровно один прогноз.',
    en: 'Column “{column}” repeats. Each test row needs exactly one prediction.',
  },
  'competitions.answer.sealed.missingRows': {
    ru: 'В ответе есть не все строки теста. Стройте ответ по строкам data/, а не по номерам из примера.',
    en: 'The answer does not have every test row. Build it from the rows in data/, not from the ids of the example.',
  },
  'competitions.answer.sealed.idForm': {
    ru: '{column} в ответе записаны в другом виде, чем в тесте — сохраните {column} как в файле, строкой.',
    en: 'The answer writes {column} differently from the test. Keep the {column} values exactly as in the file, as strings.',
  },
  'competitions.answer.sealed.emptyPredictions': {
    ru: 'В колонке {column} есть пустые прогнозы.',
    en: 'Column {column} has empty predictions.',
  },
  'competitions.answer.sealed.nonNumeric': {
    ru: 'В колонке {column} нечисловые значения.',
    en: 'Column {column} has non-numeric values.',
  },
  'competitions.answer.sealed.decimalComma': {
    ru: 'В колонке {column} нечисловые значения. Десятичный разделитель — точка.',
    en: 'Column {column} has non-numeric values. Use a dot as the decimal separator.',
  },
  'competitions.answer.sealed.infinitePredictions': {
    ru: 'В колонке {column} есть бесконечные значения (inf).',
    en: 'Column {column} has infinite values (inf).',
  },
  'competitions.answer.sealed.unparsable': {
    ru: 'Файл ответа не читается как таблица.',
    en: 'The answer file does not read as a table.',
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
  /* P1 by phase (D1, D4): «Идут сейчас» holds only what takes on-time submissions. */
  'competitions.p.emptyRunningLate': {
    ru: 'Сейчас ничего не идёт. В завершённые ниже ещё можно отправить решение вне зачёта.',
    en: 'Nothing is running right now. Some finished competitions below still take a solution outside the standings.',
  },
  'competitions.p.startsIn': { ru: 'ДО СТАРТА', en: 'STARTS IN' },
  'competitions.p.startsAt': { ru: 'старт {date}', en: 'starts {date}' },
  'competitions.p.bestCounted': { ru: 'лучший в зачёте {score}', en: 'best counted {score}' },
  'competitions.p.notJoinedOver': { ru: 'не участвовали', en: 'did not take part' },
  'competitions.p.lateJoinHint': { ru: 'можно решить вне зачёта', en: 'can still be solved, outside the standings' },

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
  'competitions.p.joinHint': {
    ru: 'Имя видно в лидерборде — по нему вас узнают одногруппники.',
    en: 'The name shows on the leaderboard — it is how classmates recognise you.',
  },
  'competitions.p.cancel': { ru: 'Отмена', en: 'Cancel' },

  /*
   * The name field wherever an entrant's name is typed: the join form here and
   * the teacher's add and rename on the Participants tab. Not `p.`: the words
   * are one for both sides, and the rule behind them is one
   * (shared/competitions.ts · entrantHandle).
   */
  'competitions.handle.label': { ru: 'Telegram или почта', en: 'Telegram or email' },
  'competitions.handle.placeholder': {
    ru: '@login или name@mail.ru',
    en: '@login or name@mail.com',
  },

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
  'competitions.p.sizeGb': { ru: '{size} ГБ', en: '{size} GB' },
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
  // After a send: the person's own count first, the competition-wide "#28" after it.
  'competitions.p.sentOk': { ru: 'Принята ваша {ordinal} посылка', en: 'Accepted: your {ordinal} submission' },
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
  // A row's own ordinal ("3-я", "3rd" from submissionOrdinal) ahead of the competition-wide "#28".
  'competitions.p.ownOrdinal': { ru: '{ordinal} посылка', en: '{ordinal} submission' },
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
  // The run reached no cell, so there is no executed copy: the link hands out the file as it was sent.
  'competitions.p.downloadSent': {
    ru: 'Скачать отправленную тетрадь',
    en: 'Download the notebook you sent',
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
  /*
   * A waiting submission is replaced by a newer upload instead of refusing it:
   * the row says by which one, and the send box says so before the click.
   */
  'competitions.p.dropReplaceTitle': {
    ru: 'Перетащите новую версию — она встанет вместо #{number}',
    en: 'Drop a new version — it takes the place of #{number}',
  },
  'competitions.p.dropReplaceNote': {
    ru: '#{number} ещё ждёт очереди и не начала исполняться. Новая посылка займёт её место и не потратит попытку дня. Засчитывается момент, когда вы начали отправку, — даже если файл догрузится уже после дедлайна.',
    en: '#{number} is still waiting and has not started. The new submission takes its place and does not use an attempt of the day. What counts is when you started sending — even if the file finishes uploading after the deadline.',
  },
  'competitions.p.replaceButton': { ru: 'ЗАМЕНИТЬ #{number}', en: 'REPLACE #{number}' },
  'competitions.p.sendReplacing': { ru: 'Отправить вместо #{number}', en: 'Send in place of #{number}' },
  /*
   * Scoring "last": a new notebook that reaches a number takes the counted
   * one's place even when it is worse. Said before the click, not discovered
   * on the leaderboard.
   */
  'competitions.p.lastReplaces': {
    ru: 'Если эта посылка дойдёт до числа, в зачёт пойдёт она, а не #{number} ({score}).',
    en: 'If this submission gets a score, it counts instead of #{number} ({score}).',
  },
  'competitions.p.countingTitle': {
    ru: 'Приём закрыт. Досчитываем посылки, отправленные до дедлайна',
    en: 'Intake is closed. Counting the submissions sent before the deadline',
  },
  'competitions.p.countingNote': {
    ru: 'Приватный лидерборд откроется сам, когда досчитается последняя. Пока таблица не меняется ни у кого.',
    en: 'The private leaderboard opens by itself when the last one is counted. Until then the table does not change for anyone.',
  },
  'competitions.p.countingLeft': {
    ru: { one: 'осталась {count}', few: 'осталось {count}', many: 'осталось {count}', other: 'осталось {count}' },
    en: { one: '{count} left', other: '{count} left' },
  },
  'competitions.p.replacedNote': { ru: 'заменена посылкой #{number}', en: 'replaced by #{number}' },
  'competitions.p.replacesHint': {
    ru: 'Посылка #{number} ещё ждёт в очереди: новая тетрадь займёт её место и не потратит ещё одну попытку.',
    en: 'Submission #{number} is still waiting in the queue: a new notebook takes its place and does not use another submission.',
  },
  /*
   * Intake is over, but the final results wait for submissions accepted
   * before it: opening the private board now would show numbers that are
   * still changing.
   */
  'competitions.p.resultsCounting': {
    ru: {
      one: 'Итоги ещё считаются: осталась {count} посылка.',
      few: 'Итоги ещё считаются: осталось {count} посылки.',
      many: 'Итоги ещё считаются: осталось {count} посылок.',
      other: 'Итоги ещё считаются: осталось {count} посылки.',
    },
    en: {
      one: 'Results are still being counted: {count} submission left.',
      other: 'Results are still being counted: {count} submissions left.',
    },
  },
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
  // Every writable folder of a submission is memory-backed, and so is a package set's room.
  'competitions.p.conditionsMemoryNote': {
    ru: 'Память посылки — на всё сразу: тетрадь, файлы её рабочей папки и пакеты выбранного набора.',
    en: 'A submission’s memory covers everything at once: the notebook, the files in its working folder and the packages of the chosen set.',
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
  'competitions.p.colEntrant': { ru: 'УЧАСТНИК', en: 'PARTICIPANT' },
  'competitions.p.colFinalMetric': { ru: 'ИТОГОВЫЙ {metric}', en: 'FINAL {metric}' },
  'competitions.p.colPublicMetric': { ru: 'ПУБЛИЧНЫЙ {metric}', en: 'PUBLIC {metric}' },
  'competitions.p.colSubmissions': { ru: 'ПОСЫЛОК', en: 'SUBMISSIONS' },
  'competitions.p.showMoreEntrants': {
    ru: {
      one: 'Показать ещё {count} участника',
      few: 'Показать ещё {count} участников',
      many: 'Показать ещё {count} участников',
      other: 'Показать ещё {count} участников',
    },
    en: { one: 'Show {count} more participant', other: 'Show {count} more participants' },
  },
  // A place per row; between equal scores time decides it (shared/competitions.ts · placesByScore).
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

  /*
   * Who sees the leaderboard (shared/competitions.ts · BoardVisibility) and
   * what a visitor the board is closed to reads instead of it.
   */
  'competitions.refusal.boardEntrantsOnly': {
    ru: 'Лидерборд этого соревнования видят только его участники.',
    en: "Only this competition's participants can see its leaderboard.",
  },
  'competitions.p.boardClosedTitle': {
    ru: 'Лидерборд открыт только участникам',
    en: 'The leaderboard is open to participants only',
  },
  'competitions.p.boardClosedJoin': {
    ru: 'Вступите в соревнование, чтобы увидеть места.',
    en: 'Join the competition to see the places.',
  },
  'competitions.p.boardClosedShort': {
    ru: 'Лидерборд видят только участники.',
    en: 'Only participants see the leaderboard.',
  },
  // Under the table: why other rows read "iva…@hse.ru" (maskEntrantName).
  'competitions.p.maskedNote': {
    ru: 'Почты других участников показаны сокращённо.',
    en: "Other participants' email addresses are shortened.",
  },
  // After the day's limit, with the zone named: "The limit resets at 00:00 GMT+3."
  'competitions.p.quotaResets': {
    ru: 'Лимит обновится в {time}.',
    en: 'The limit resets at {time}.',
  },
  // After the failed-attempts refusal: its own count, not the limit.
  'competitions.p.attemptsResets': {
    ru: 'Счёт упавших начнётся заново в {time}.',
    en: 'The count of failed ones starts over at {time}.',
  },

  /*
   * The send box's quota strip (C1). The rule leads and the number follows:
   * since 4 Oct 2026 only a score spends the limit, and a count that stays put
   * after a crash has to be explained in the same breath. Russian picks
   * "осталась" for one, "осталось" for the rest.
   */
  'competitions.p.quotaLead': {
    ru: {
      one: 'Лимит тратят только посылки с оценкой — сегодня осталась {count} из {perDay}.',
      few: 'Лимит тратят только посылки с оценкой — сегодня осталось {count} из {perDay}.',
      many: 'Лимит тратят только посылки с оценкой — сегодня осталось {count} из {perDay}.',
      other: 'Лимит тратят только посылки с оценкой — сегодня осталось {count} из {perDay}.',
    },
    en: {
      one: 'Only scored submissions spend the limit: {count} of {perDay} left today.',
      other: 'Only scored submissions spend the limit: {count} of {perDay} left today.',
    },
  },
  'competitions.p.quotaLeadResets': {
    ru: {
      one: 'Лимит тратят только посылки с оценкой — сегодня осталась {count} из {perDay}, обновится в {time}.',
      few: 'Лимит тратят только посылки с оценкой — сегодня осталось {count} из {perDay}, обновится в {time}.',
      many: 'Лимит тратят только посылки с оценкой — сегодня осталось {count} из {perDay}, обновится в {time}.',
      other: 'Лимит тратят только посылки с оценкой — сегодня осталось {count} из {perDay}, обновится в {time}.',
    },
    en: {
      one: 'Only scored submissions spend the limit: {count} of {perDay} left today, resets at {time}.',
      other: 'Only scored submissions spend the limit: {count} of {perDay} left today, resets at {time}.',
    },
  },
  // What is free, named by what happened (shared/competitions.ts · countsTowardDailyQuota).
  'competitions.p.quotaFree': {
    ru: 'Упавшие не считаются: ошибка в тетради, нехватка времени или памяти, ответ не принят, сбой проверки. Посылка в работе держит место и вернёт его, если упадёт.',
    en: 'Failed ones are free: a notebook error, running out of time or memory, a rejected answer, a failed check. A submission in progress holds a place and gives it back if it fails.',
  },
  // The phone's box has room for one paragraph: the rule shortened to its point (C3).
  'competitions.p.quotaShort': {
    ru: 'Лимит тратят только посылки с оценкой.',
    en: 'Only scored submissions spend the limit.',
  },
  'competitions.p.quotaMeter': {
    ru: { one: 'осталась {count} из {perDay}', few: 'осталось {count} из {perDay}', many: 'осталось {count} из {perDay}', other: 'осталось {count} из {perDay}' },
    en: { one: '{count} of {perDay} left', other: '{count} of {perDay} left' },
  },
  /*
   * The ceiling on failed submissions, quietly (failedAttemptsCeiling). "Failed
   * attempts", never "the limit": the two stand side by side in the box.
   */
  'competitions.p.attemptsNote': {
    ru: 'Неудачных попыток — не больше {ceiling} в день.',
    en: 'Failed attempts: at most {ceiling} a day.',
  },
  'competitions.p.attemptsNoteUsed': {
    ru: 'Неудачных попыток — не больше {ceiling} в день; сегодня {used}.',
    en: 'Failed attempts: at most {ceiling} a day; {used} today.',
  },
  // Under a failed run's details, where the person decides whether to try again.
  'competitions.p.attemptFree': { ru: 'Попытка лимит не потратила', en: 'This attempt did not spend the limit' },
  'competitions.p.attemptFreeLeft': {
    ru: {
      one: 'Попытка лимит не потратила — сегодня осталась {count} из {perDay}',
      few: 'Попытка лимит не потратила — сегодня осталось {count} из {perDay}',
      many: 'Попытка лимит не потратила — сегодня осталось {count} из {perDay}',
      other: 'Попытка лимит не потратила — сегодня осталось {count} из {perDay}',
    },
    en: {
      one: 'This attempt did not spend the limit: {count} of {perDay} left today',
      other: 'This attempt did not spend the limit: {count} of {perDay} left today',
    },
  },
  // Beside the number of a finished submission that cost nothing (competition-words · outsideQuota).
  'competitions.p.limitNotSpent': { ru: 'лимит не потрачен', en: 'limit not spent' },

  /*
   * «Поздние посылки» on the participant's side (C1, C3): intake for the
   * standings is over, the door still takes notebooks, and every place they
   * show up says they are outside the standings.
   */
  'competitions.p.lateOpen': { ru: 'приём поздних посылок открыт', en: 'late submissions open' },
  'competitions.p.lateOpenShort': { ru: 'поздние посылки открыты', en: 'late submissions open' },
  'competitions.p.deadlinePassedLabel': { ru: 'ДЕДЛАЙН ПРОШЁЛ', en: 'DEADLINE PASSED' },
  'competitions.p.publicPlace': { ru: 'ПУБЛИЧНОЕ МЕСТО', en: 'PUBLIC PLACE' },
  'competitions.p.countedScore': { ru: 'В ЗАЧЁТЕ', en: 'COUNTED' },
  'competitions.p.dayToday': { ru: 'сегодня', en: 'today' },
  'competitions.p.dayYesterday': { ru: 'вчера', en: 'yesterday' },
  'competitions.p.lateDropNote': {
    ru: 'Посылка после дедлайна будет проверена, но в зачёт и места не пойдёт. Оценку увидите только вы.',
    en: 'A submission after the deadline is checked, but it does not count and takes no place. Only you see its score.',
  },
  'competitions.p.lateTitle': { ru: 'Поздняя посылка — вне зачёта', en: 'A late submission does not count' },
  'competitions.p.deadlinePassed': {
    ru: 'Дедлайн прошёл {day} в {time}.',
    en: 'The deadline passed {day} at {time}.',
  },
  'competitions.p.lateNotePhone': {
    ru: 'Тетрадь проверят как обычно, оценку увидите только вы — в лидерборд и места поздние посылки не попадают.',
    en: 'The notebook is checked as usual and only you see the score: late submissions never reach the leaderboard or the places.',
  },
  'competitions.p.lateChip': { ru: 'ПОСЛЕ ДЕДЛАЙНА · ВНЕ ЗАЧЁТА', en: 'AFTER THE DEADLINE · NOT COUNTED' },
  'competitions.p.lateBadge': { ru: 'ПОЗДНЯЯ', en: 'LATE' },
  'competitions.p.afterDeadline': { ru: 'после дедлайна', en: 'after the deadline' },
  'competitions.p.notCounted': { ru: 'вне зачёта', en: 'not counted' },
  'competitions.p.lateBetter': {
    ru: 'Лучше зачётной #{number} на {delta}, но место и зачёт не меняет.',
    en: 'Better than the counted #{number} by {delta}, but it changes neither the place nor what counts.',
  },
  'competitions.p.deadlineDivider': { ru: 'ДЕДЛАЙН · {when}', en: 'DEADLINE · {when}' },
  'competitions.p.deadlineDividerBare': { ru: 'ДЕДЛАЙН', en: 'DEADLINE' },
  'competitions.p.deadlineDividerNote': {
    ru: 'Выше — поздние посылки: проверены, но вне зачёта. Ниже — отправленные вовремя.',
    en: 'Above: late submissions, checked but not counted. Below: the ones sent on time.',
  },
  'competitions.p.deadlineDividerNoteShort': {
    ru: 'выше — поздние, вне зачёта; ниже — в зачёте',
    en: 'above: late, not counted; below: on time',
  },
  // The pick froze with the deadline (routes/competitions.ts · choose): which one counts, said above the list.
  'competitions.p.chooseClosed': {
    ru: 'Выбор для зачёта закрыт с дедлайном: в зачёте посылка #{number}.',
    en: 'The pick closed with the deadline: #{number} counts.',
  },
  'competitions.p.chooseClosedNone': {
    ru: 'Выбор для зачёта закрыт с дедлайном.',
    en: 'The pick closed with the deadline.',
  },
  'competitions.p.finalLater': {
    ru: 'Итоговая оценка откроется вместе с итогами.',
    en: 'The final score opens with the results.',
  },
  'competitions.p.lateFootnote': {
    ru: 'Итоговые оценки — и у поздних посылок — откроются вместе с итогами. Места считаются только по посылкам до дедлайна.',
    en: 'Final scores, late submissions’ included, open with the results. Places count only submissions sent before the deadline.',
  },
  'competitions.p.lateFootnoteOpen': {
    ru: 'Места считаются только по посылкам до дедлайна.',
    en: 'Places count only submissions sent before the deadline.',
  },
  'competitions.p.boardLateNote': {
    ru: 'Места считаются только по посылкам до дедлайна. Ваша лучшая поздняя — {score} — сюда не входит.',
    en: 'Places count only submissions sent before the deadline. Your best late one, {score}, is not in it.',
  },

  /*
   * The hidden test as the participant meets it (C1, C3): its rows and path,
   * never its contents, and why a failure on it shows so little. The
   * exception class comes from the server's allow-list; a cell number from
   * the run itself.
   */
  'competitions.p.sealedAtCheck': {
    ru: { one: 'При проверке {files} — скрытый тест.', few: 'При проверке {files} — скрытый тест.', many: 'При проверке {files} — скрытый тест.', other: 'При проверке {files} — скрытый тест.' },
    en: { one: 'During the check, {files} is the hidden test.', other: 'During the check, {files} are the hidden test.' },
  },
  'competitions.p.blindHead': {
    ru: 'Проверка на скрытом тесте · вывод скрыт',
    en: 'Checked on the hidden test · output hidden',
  },
  'competitions.p.blindHeadAt': {
    ru: 'Проверка на скрытом тесте: {where} · вывод скрыт',
    en: 'Checked on the hidden test: {where} · output hidden',
  },
  'competitions.p.blindCell': { ru: 'ячейка {cell}', en: 'cell {cell}' },
  'competitions.p.blindCellOf': { ru: 'ячейка {cell} из {cells}', en: 'cell {cell} of {cells}' },
  'competitions.p.blindWhy': {
    ru: 'Тетрадь работала со скрытым тестом, поэтому текст ошибки, трассировка и вывод ячеек не показываются.',
    en: 'The notebook worked with the hidden test, so the error text, the traceback and the cell outputs are not shown.',
  },
  'competitions.p.blindWhyFile': {
    ru: 'Тетрадь работала с настоящим {file}, поэтому текст ошибки, трассировка и вывод ячеек не показываются.',
    en: 'The notebook worked with the real {file}, so the error text, the traceback and the cell outputs are not shown.',
  },
  'competitions.p.blindWhyRows': {
    ru: 'Тетрадь работала с настоящим {file} — {rows} вместо {example} в примере, — поэтому текст ошибки, трассировка и вывод ячеек не показываются.',
    en: 'The notebook worked with the real {file} — {rows} instead of {example} in the example — so the error text, the traceback and the cell outputs are not shown.',
  },
  'competitions.p.blindHint': {
    ru: 'Если на примере ячейка {cell} проходит, проверьте, не рассчитан ли код на число строк, конкретные id или значения из примера.',
    en: 'If cell {cell} passes on the example, check whether the code relies on the number of rows, particular ids or values from the example.',
  },
  'competitions.p.blindShort': {
    ru: 'Вывод скрыт: тетрадь исполнялась на скрытом тесте.',
    en: 'Output hidden: the notebook ran on the hidden test.',
  },
  'competitions.p.sealedExample': { ru: 'ПРИМЕР', en: 'EXAMPLE' },
  'competitions.p.sealedSwap': {
    ru: 'при проверке заменяется скрытым тестом ({rows}) по тому же пути',
    en: 'during the check it is swapped for the hidden test ({rows}) at the same path',
  },
  'competitions.p.sealedSwapBare': {
    ru: 'при проверке заменяется скрытым тестом по тому же пути',
    en: 'during the check it is swapped for the hidden test at the same path',
  },
  'competitions.p.sealedColumns': {
    ru: { one: '{count} столбец: {names}', few: '{count} столбца: {names}', many: '{count} столбцов: {names}', other: '{count} столбца: {names}' },
    en: { one: '{count} column: {names}', other: '{count} columns: {names}' },
  },
  'competitions.p.sealedNotListed': {
    ru: 'Скрытого теста в списке нет — его не скачать.',
    en: 'The hidden test is not in the list: it cannot be downloaded.',
  },
  'competitions.p.howTitle': { ru: 'Как проверяется посылка', en: 'How a submission is checked' },
  'competitions.p.howRun': {
    ru: {
      one: 'Тетрадь запускается заново, все ячейки по порядку, в контейнере без интернета: до {count} минуты, {memory} памяти.',
      few: 'Тетрадь запускается заново, все ячейки по порядку, в контейнере без интернета: до {count} минут, {memory} памяти.',
      many: 'Тетрадь запускается заново, все ячейки по порядку, в контейнере без интернета: до {count} минут, {memory} памяти.',
      other: 'Тетрадь запускается заново, все ячейки по порядку, в контейнере без интернета: до {count} минуты, {memory} памяти.',
    },
    en: {
      one: 'The notebook starts from scratch and runs every cell in order, in a container with no internet: up to {count} minute, {memory} of memory.',
      other: 'The notebook starts from scratch and runs every cell in order, in a container with no internet: up to {count} minutes, {memory} of memory.',
    },
  },
  'competitions.p.howSwap': {
    ru: 'В data/ лежат те же файлы, что выше, но на месте {file} — скрытый тест: те же столбцы, {rows}, другие строки. Читайте файл по этому пути и не рассчитывайте на число строк или конкретные id.',
    en: 'data/ holds the same files as above, but in place of {file} sits the hidden test: the same columns, {rows}, different rows. Read the file by this path and do not count on the number of rows or particular ids.',
  },
  'competitions.p.howSwapBare': {
    ru: 'В data/ лежат те же файлы, что выше, но на месте {file} — скрытый тест: те же столбцы, другие строки. Читайте файл по этому пути и не рассчитывайте на число строк или конкретные id.',
    en: 'data/ holds the same files as above, but in place of {file} sits the hidden test: the same columns, different rows. Read the file by this path and do not count on the number of rows or particular ids.',
  },
  'competitions.p.howAdd': {
    ru: 'В data/ лежат те же файлы, что выше, и ещё {file} — скрытый тест, которого нет в списке. Читайте его по этому пути и не рассчитывайте на число строк или конкретные id.',
    en: 'data/ holds the same files as above and also {file}, the hidden test, which is not in the list. Read it by this path and do not count on the number of rows or particular ids.',
  },
  'competitions.p.howBrief': {
    ru: 'Если тетрадь упадёт, вы увидите номер ячейки и тип ошибки — без вывода и traceback: тетрадь работала со скрытым тестом.',
    en: 'If the notebook fails, you see the cell number and the error type, with no output or traceback: the notebook worked with the hidden test.',
  },
  'competitions.p.howFull': {
    ru: 'Если тетрадь упадёт, вы увидите ошибку и вывод ячеек, как обычно.',
    en: 'If the notebook fails, you see the error and the cell outputs, as usual.',
  },
  'competitions.p.howFree': {
    ru: 'Упавшая посылка дневной лимит не тратит.',
    en: 'A failed submission does not spend the daily limit.',
  },
  'competitions.p.howExampleCheck': {
    ru: 'Проверьте ячейку {cell} на примере {file}.',
    en: 'Check cell {cell} on the example {file}.',
  },
  'competitions.p.condSealed': { ru: 'скрытый · {rows}', en: 'hidden · {rows}' },
  'competitions.p.condSealedBare': { ru: 'скрытый', en: 'hidden' },
  'competitions.p.condOutput': { ru: 'Вывод при ошибке', en: 'Output on failure' },
  'competitions.p.condOutputBrief': { ru: 'ячейка и тип', en: 'cell and type' },
  'competitions.p.condOutputFull': { ru: 'полный', en: 'full' },
  'competitions.p.condPerDay': { ru: 'Лимит в день', en: 'Daily limit' },
  'competitions.p.condPerDayValue': { ru: '{count} с оценкой', en: '{count} scored' },
  'competitions.p.conditionsSealedSwap': {
    ru: 'Проверка запускает все ячейки по порядку и кладёт скрытый тест на место {file}.',
    en: 'The check runs every cell in order and puts the hidden test in place of {file}.',
  },
  'competitions.p.conditionsSealedAdd': {
    ru: 'Проверка запускает все ячейки по порядку и добавляет в data/ скрытый тест {file}.',
    en: 'The check runs every cell in order and adds the hidden test {file} to data/.',
  },
  'competitions.p.conditionsSealedBrief': {
    ru: 'Его строки не попадают ни в вывод, ни в сообщения об ошибке — поэтому при падении видны только номер ячейки и тип исключения.',
    en: 'Its rows reach neither the output nor the error messages, so a failure shows only the cell number and the exception type.',
  },

  /* The teacher's side of the same setting, in the competition editor. */
  'competitions.visibility.head': { ru: 'КТО ВИДИТ ЛИДЕРБОРД', en: 'WHO SEES THE LEADERBOARD' },
  'competitions.visibility.public': { ru: 'все, у кого есть ссылка', en: 'anyone with the link' },
  'competitions.visibility.entrants': { ru: 'только участники', en: 'participants only' },
  'competitions.visibility.note': {
    ru: 'Почты участников в лидерборде сокращены (iva…@hse.ru) для всех, кроме самого участника и преподавателей; логины Telegram видны целиком.',
    en: 'On the leaderboard, email addresses are shortened (iva…@hse.ru) for everyone except the person themselves and teachers; Telegram usernames are shown in full.',
  },

  /* Removing a participant: the teacher's list of people (A3 · Participants). */
  'competitions.entrant.delete': { ru: 'Удалить', en: 'Delete' },
  'competitions.entrant.deleteLabel': { ru: 'Удалить участника {name}', en: 'Delete participant {name}' },
  'competitions.entrant.deleteHeading': { ru: 'Удалить участника {name}?', en: 'Delete participant {name}?' },
  'competitions.entrant.deleteSubmissions': {
    ru: {
      one: 'Вместе с ним удалится {count} посылка в этом соревновании: тетрадь, результат и ответ — из лидерборда и с диска сервера.',
      few: 'Вместе с ним удалятся {count} посылки в этом соревновании: тетради, результаты и ответы — из лидерборда и с диска сервера.',
      many: 'Вместе с ним удалятся {count} посылок в этом соревновании: тетради, результаты и ответы — из лидерборда и с диска сервера.',
      other: 'Вместе с ним удалятся {count} посылки в этом соревновании: тетради, результаты и ответы — из лидерборда и с диска сервера.',
    },
    en: {
      one: 'Their {count} submission in this competition goes with them: the notebook, the result and the answer, from the leaderboard and from the server’s disk.',
      other: 'Their {count} submissions in this competition go with them: notebooks, results and answers, from the leaderboard and from the server’s disk.',
    },
  },
  'competitions.entrant.deleteNoSubmissions': {
    ru: 'Посылок у него нет — удалится только участие.',
    en: 'They have no submissions; only their participation is removed.',
  },
  'competitions.entrant.deleteKeyGone': {
    ru: 'Его ключ входа перестанет работать.',
    en: 'Their sign-in key stops working.',
  },
  'competitions.entrant.deleteKeyStays': {
    ru: {
      one: 'Ключ входа продолжит работать в {count} другом соревновании, где он участвует.',
      few: 'Ключ входа продолжит работать в {count} других соревнованиях, где он участвует.',
      many: 'Ключ входа продолжит работать в {count} других соревнованиях, где он участвует.',
      other: 'Ключ входа продолжит работать в {count} других соревнованиях, где он участвует.',
    },
    en: {
      one: 'Their sign-in key keeps working in the {count} other competition they take part in.',
      other: 'Their sign-in key keeps working in the {count} other competitions they take part in.',
    },
  },
  'competitions.entrant.deleteFinal': {
    ru: 'Места остальных пересчитаются. Отменить удаление нельзя.',
    en: 'Everyone else’s places are recounted. This cannot be undone.',
  },
  'competitions.refusal.entrantRunning': {
    ru: 'Посылка этого участника ещё выполняется и не успела остановиться. Повторите через минуту.',
    en: 'One of this participant’s submissions is still running and has not stopped yet. Try again in a minute.',
  },
  'competitions.refusal.entrantBaseline': {
    ru: 'Это служебный участник сэмпл-тетради — его удалить нельзя.',
    en: 'This is the sample notebook’s service participant; it cannot be deleted.',
  },
}

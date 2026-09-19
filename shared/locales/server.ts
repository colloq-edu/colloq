import type { MessageCatalog } from '../i18n-types.js'

export const serverMessages: MessageCatalog = {
  "server.requestBlockedThisPageUsesADifferent.dd9b4b": {
    "ru": "Запрос отклонён: эта страница использует другой адрес сервера. Откройте Colloq напрямую и повторите попытку.",
    "en": "Request blocked: this page uses a different server address. Open Colloq directly and try again."
  },
  "server.signInToUseTheAdminPanel.301d28": {
    "ru": "Войдите, чтобы открыть панель преподавателя",
    "en": "sign in to use the admin panel"
  },
  "server.empty.9a3a4f": {
    "ru": "(пусто)",
    "en": "(empty)"
  },
  "server.added.f985c7": {
    "ru": "добавил {p0}",
    "en": "added {p0}"
  },
  "server.untitledSeminar.08a8f2": {
    "ru": "Занятие без названия",
    "en": "Untitled class"
  },
  "server.theTeacherHasBlockedYourAccessTo.5eba21": {
    "ru": "{p0}, преподаватель закрыл вам доступ на это занятие. Он откроется снова сам.",
    "en": "{p0}, the teacher has blocked your access to this class. Access will be restored automatically."
  },
  "server.isNotANotebook.084f7a": {
    "ru": "{p0} — не тетрадь.",
    "en": "{p0} is not a notebook."
  },
  "server.containsInvalidIpynbData.6292e4": {
    "ru": "{p0} содержит некорректные данные .ipynb.",
    "en": "{p0} contains invalid .ipynb data."
  },
  "server.containsCellsTheLimitIs.0fbfa5": {
    "ru": "В {p0} {p1} ячеек. Допустимо не более {p2}.",
    "en": "{p0} contains {p1} cells. The limit is {p2}."
  },
  "server.couldNotOpenTheNotebook.be7a27": {
    "ru": "Не удалось открыть тетрадь.",
    "en": "Could not open the notebook."
  },
  "server.couldNotBeReadAsANotebook.03f997": {
    "ru": "{p0} не читается как тетрадь.",
    "en": "{p0} could not be read as a notebook."
  },
  "server.isMbExceedingTheSizeLimit.72c414": {
    "ru": "{p0} — {p1} МБ. Превышен лимит размера ",
    "en": "{p0} is {p1} MB, exceeding the size limit "
  },
  "server.mbSaveTheNotebookWithoutOutputs.bf2200": {
    "ru": "({p0} МБ). Сохраните тетрадь без выводов.",
    "en": "({p0} MB). Save the notebook without outputs."
  },
  "server.alreadyExists.e348cc": {
    "ru": "{p0} уже есть.",
    "en": "{p0} already exists."
  },
  "server.couldNotCreate.0cfbaa": {
    "ru": "Не удалось создать {p0}.",
    "en": "Could not create {p0}."
  },
  "server.theFileExceedsTheSizeLimitAnd.2d3114": {
    "ru": "Файл больше потолка — дальше только чтение.",
    "en": "The file exceeds the size limit and is now read-only."
  },
  "server.theFileNoLongerExists.353e66": {
    "ru": "файла больше нет",
    "en": "the file no longer exists"
  },
  "server.theFileExceedsTheSizeLimit.59e6dd": {
    "ru": "файл больше потолка",
    "en": "the file exceeds the size limit"
  },
  "server.theFileCanNoLongerBeOpened.0fbdee": {
    "ru": "файл больше не открывается",
    "en": "the file can no longer be opened"
  },
  "server.onlyTheTeacherMayEditFilesIn.0ca25b": {
    "ru": "Файлы в этой комнате — преподавательские",
    "en": "Only the teacher may edit files in this room"
  },
  "server.theEditCouldNotBeReadAnd.fab4ce": {
    "ru": "Правку не удалось разобрать — она не отправлена.",
    "en": "The edit could not be read and was not sent."
  },
  "server.theFileCannotBeOpened.a0670d": {
    "ru": "файл не открывается",
    "en": "the file cannot be opened"
  },
  "server.bannedFromThisSeminar.234bce": {
    "ru": "Доступ к этому занятию закрыт",
    "en": "banned from this class"
  },
  "server.theRoomIsClosed.23a989": {
    "ru": "комната закрыта",
    "en": "the room is closed"
  },
  "server.theFrameIsTooLargeToRead.4cb416": {
    "ru": "кадр слишком велик для разбора",
    "en": "the frame is too large to read"
  },
  "server.referenceToContentThatIsNotIn.692803": {
    "ru": "ссылка на содержимое, которого у занятия нет",
    "en": "reference to content that is not in this class"
  },
  "server.writeToATypeOutsideTheDocument.85d447": {
    "ru": "запись в тип вне документа",
    "en": "write to a type outside the document"
  },
  "server.theParentCannotBeResolved.65a644": {
    "ru": "родитель не разрешается",
    "en": "the parent cannot be resolved"
  },
  "server.structureHasNeitherAParentNorA.62175e": {
    "ru": "структура без родителя и без соседа",
    "en": "structure has neither a parent nor a neighbor"
  },
  "server.writeToAnUnknownNotebookLocation.6e676f": {
    "ru": "запись в неизвестное место тетради",
    "en": "write to an unknown notebook location"
  },
  "server.onlyTheTeacherMayOpenACell.408fc1": {
    "ru": "ячейку открывает преподаватель, а не браузер",
    "en": "only the teacher may open a cell"
  },
  "server.thisFieldIsWrittenByTheServer.ea61b2": {
    "ru": "это поле пишет сервер, а не браузер",
    "en": "this field is written by the server"
  },
  "server.theCellIdentifierCannotBeChanged.ed6a4a": {
    "ru": "имя ячейки не меняется",
    "en": "the cell identifier cannot be changed"
  },
  "server.theEntireCellTextIsBeingReplaced.ef575f": {
    "ru": "текст ячейки заменяется целиком",
    "en": "the entire cell text is being replaced"
  },
  "server.unknownCellField.5417fd": {
    "ru": "неизвестный ключ ячейки",
    "en": "unknown cell field"
  },
  "server.thisSeminarFieldIsWrittenByThe.4b1639": {
    "ru": "это поле занятия пишет сервер",
    "en": "this class field is written by the server"
  },
  "server.thisThreadIsWrittenByTheServer.a453d6": {
    "ru": "эту ленту пишет сервер",
    "en": "this thread is written by the server"
  },
  "server.writeToASectionThatDoesNot.901f9e": {
    "ru": "запись в раздел, которого у документа нет",
    "en": "write to a section that does not exist in the document"
  },
  "server.theNewCellContainsAnUnexpectedField.0d2454": {
    "ru": "новая ячейка несёт лишнее поле «{p0}»",
    "en": "the new cell contains an unexpected field: “{p0}”"
  },
  "server.theNewCellHasNoIdentifier.6dfd8e": {
    "ru": "у новой ячейки нет имени",
    "en": "the new cell has no identifier"
  },
  "server.twoNewCellsShareTheSameIdentifier.844381": {
    "ru": "две новые ячейки с одним именем",
    "en": "two new cells share the same identifier"
  },
  "server.theNewCellHasNoType.fd1999": {
    "ru": "у новой ячейки нет вида",
    "en": "the new cell has no type"
  },
  "server.theNewCellSTextIsNot.21d144": {
    "ru": "текст новой ячейки не Y.Text",
    "en": "the new cell's text is not Y.Text"
  },
  "server.theNewCellSOutputIsNot.2d985e": {
    "ru": "вывод новой ячейки не Y.Array",
    "en": "the new cell's output is not Y.Array"
  },
  "server.theNewCellContainsPresetContent.c75536": {
    "ru": "новая ячейка несёт готовое содержимое",
    "en": "the new cell contains preset content"
  },
  "server.unknownCellType.df318b": {
    "ru": "такого вида ячейки не бывает",
    "en": "unknown cell type"
  },
  "server.theFrameHasAGapInEdits.6c7e40": {
    "ru": "кадр с пропуском в нажатиях",
    "en": "the frame has a gap in edits"
  },
  "server.theFrameContinuesEditsThatTheServer.1709af": {
    "ru": "кадр продолжает нажатия, которых сервер не видел",
    "en": "the frame continues edits that the server has not received"
  },
  "server.frameTooLarge.5693f1": {
    "ru": "слишком большой кадр",
    "en": "frame too large"
  },
  "server.theFrameCannotBeRead.c96480": {
    "ru": "кадр не разбирается",
    "en": "the frame cannot be read"
  },
  "server.onlyTheTeacherMayRenameTheSeminar.61046b": {
    "ru": "Имя занятия меняет преподаватель.",
    "en": "Only the teacher may rename the class."
  },
  "server.onlyTheTeacherMayEditThisSeminar.dfef31": {
    "ru": "На этом занятии тетрадь принадлежит преподавателю — написанное вами не отправлено.",
    "en": "Only the teacher may edit this class's notebook. Your changes were not sent."
  },
  "server.onlyTheTeacherMayAddCellsIn.9fb3e4": {
    "ru": "На этом занятии ячейки добавляет преподаватель.",
    "en": "Only the teacher may add cells in this class."
  },
  "server.onlyTheTeacherMayRemoveCellsIn.9a1ac0": {
    "ru": "На этом занятии ячейки убирает преподаватель.",
    "en": "Only the teacher may remove cells in this class."
  },
  "server.notebookAtThisPoint.ccc077": {
    "ru": "тетрадь на этот момент",
    "en": "notebook at this point"
  },
  "server.opened.e716b0": {
    "ru": "открылась",
    "en": "opened"
  },
  "server.addedACell.b6ba53": {
    "ru": "добавил ячейку",
    "en": "added a cell"
  },
  "server.deletedACell.e08aef": {
    "ru": "удалил ячейку",
    "en": "deleted a cell"
  },
  "server.deleted.9e3b01": {
    "ru": "удалил {p0}",
    "en": "deleted {p0}"
  },
  "server.editedCell.58cff0": {
    "ru": "правил ячейку {p0}",
    "en": "edited cell {p0}"
  },
  "server.edited.50f36f": {
    "ru": "правил {p0}",
    "en": "edited {p0}"
  },
  "server.reworkedTheNotebook.c8708b": {
    "ru": "переработал тетрадь",
    "en": "reworked the notebook"
  },
  "server.notebookIpynb.9616a7": {
    "ru": "Тетрадь {p0}.ipynb",
    "en": "Notebook {p0}.ipynb"
  },
  "server.restoredACell.0f74d0": {
    "ru": "вернул ячейку",
    "en": "restored a cell"
  },
  "server.restoredAVersion.80c38a": {
    "ru": "вернул версию",
    "en": "restored a version"
  },
  "server.thisEditWasNotAccepted.540727": {
    "ru": "Эта правка не принята: {p0}.",
    "en": "This edit was not accepted: {p0}."
  },
  "server.thisSeminarWasDeleted.daaaad": {
    "ru": "Это занятие удалено",
    "en": "this class was deleted"
  },
  "server.serverShuttingDown.0df697": {
    "ru": "Сервер останавливается",
    "en": "server shutting down"
  },
  "server.onlyTheTeacherMayEditTheNotebook.d8abb3": {
    "ru": "На этом занятии редактировать тетрадь может только преподаватель.",
    "en": "Only the teacher may edit the notebook in this class."
  },
  "server.onlyTheTeacherMayRunTheWhole.8359b5": {
    "ru": "На этом занятии весь лист запускает преподаватель — запускайте по одной ячейке.",
    "en": "Only the teacher may run the whole notebook. Run one cell at a time."
  },
  "server.aLectureIsUsingEndTheLecture.056f12": {
    "ru": "Идёт лекция по «{p0}» — сначала закончите её.",
    "en": "A lecture is using “{p0}”. End the lecture first."
  },
  "server.youMayRunOneCellAtA.35e7c7": {
    "ru": "На этом занятии можно запускать по одной ячейке. Ваша ячейка уже выполняется или стоит в очереди.",
    "en": "You may run one cell at a time in this class. Your cell is already running or queued."
  },
  "server.theNameCannotBeEmpty.fc2696": {
    "ru": "Имя не может быть пустым.",
    "en": "The name cannot be empty."
  },
  "server.alreadyExistsInThisFolder.3e8b1f": {
    "ru": "«{p0}» в этой папке уже есть.",
    "en": "“{p0}” already exists in this folder."
  },
  "server.alreadyExistsInFolder.2f1ace": {
    "ru": "«{p0}» в папке «{p1}» уже есть.",
    "en": "“{p0}” already exists in folder “{p1}”."
  },
  "server.alreadyExistsInTheRoomSRoot.229dba": {
    "ru": "«{p0}» в корне комнаты уже есть.",
    "en": "“{p0}” already exists in the room's root folder."
  },
  "server.isNoLongerInThisRoom.2ab165": {
    "ru": "«{p0}» в комнате больше нет.",
    "en": "“{p0}” is no longer in this room."
  },
  "server.cannotMoveANestedPathWouldExceed.541d8f": {
    "ru": "«{p0}» нельзя переместить: путь к содержимому превысит {p1} символов.",
    "en": "Cannot move “{p0}”: a nested path would exceed {p1} characters."
  },
  "server.isAFileChooseADestinationFolder.298ed2": {
    "ru": "«{p0}» — файл. Выберите папку для перемещения.",
    "en": "“{p0}” is a file. Choose a destination folder."
  },
  "server.isBusyTryAgainInAMoment.bb101a": {
    "ru": "«{p0}» сейчас занят — попробуйте ещё раз через секунду.",
    "en": "“{p0}” is busy. Try again in a moment."
  },
  "server.otherParticipantsHaveQueuedCellsStopYour.32a330": {
    "ru": "В очереди ячейки других — остановите свою, нажав на ней.",
    "en": "Other participants have queued cells. Stop your own cell using its button."
  },
  "server.onlyTheTeacherMayEraseTheWhole.56250d": {
    "ru": "Стирать всю доску здесь может преподаватель.",
    "en": "Only the teacher may erase the whole board."
  },
  "server.onlyTheTeacherMayPutADocument.482e0d": {
    "ru": "Ставить документ на общий экран на этом занятии может преподаватель.",
    "en": "Only the teacher may put a document on the shared screen."
  },
  "server.thisFileIsNotInTheRoom.f557d3": {
    "ru": "Такого файла в комнате нет.",
    "en": "This file is not in the room."
  },
  "server.onlyTheTeacherMayRemoveADocument.1b7a58": {
    "ru": "Убрать документ с общего экрана на этом занятии может преподаватель.",
    "en": "Only the teacher may remove a document from the shared screen."
  },
  "server.onlyTheTeacherMayFinishTheClass.84b1b4": {
    "ru": "Закончить занятие может преподаватель.",
    "en": "Only the teacher may finish the class."
  },
  "server.onlyTheTeacherMayResumeTheClass.d3e509": {
    "ru": "Открыть занятие обратно может преподаватель.",
    "en": "Only the teacher may resume the class."
  },
  "server.onlyTheTeacherMayLeadALecture.f44eb3": {
    "ru": "Вести лекцию на этом занятии может преподаватель.",
    "en": "Only the teacher may lead a lecture in this class."
  },
  "server.chooseAPdfDocumentForTheProjector.434426": {
    "ru": "На проектор выводится документ PDF.",
    "en": "Choose a PDF document for the projector."
  },
  "server.thisFileIsNoLongerInThe.b66e1e": {
    "ru": "Этого файла в комнате уже нет.",
    "en": "This file is no longer in the room."
  },
  "server.onlyTheTeacherMayTakeOverThe.31823b": {
    "ru": "Взять пульт у ведущего может преподаватель.",
    "en": "Only the teacher may take over the presenter controls."
  },
  "server.onlyTheTeacherMayEndTheLecture.f996c5": {
    "ru": "Закончить лекцию может преподаватель.",
    "en": "Only the teacher may end the lecture."
  },
  "server.onlyTheTeacherMayEndAnotherPerson.8212a2": {
    "ru": "Закончить чужую лекцию может преподаватель.",
    "en": "Only the teacher may end another person's lecture."
  },
  "server.onlyTheTeacherMayViewSpeakerNotes.8f7a4c": {
    "ru": "Заметки к лекции видит преподаватель.",
    "en": "Only the teacher may view speaker notes."
  },
  "server.onlyTheTeacherMayEditSpeakerNotes.729773": {
    "ru": "Заметки к лекции пишет преподаватель.",
    "en": "Only the teacher may edit speaker notes."
  },
  "server.aNoteMustBelongToADocument.783591": {
    "ru": "Заметка пишется к странице документа.",
    "en": "A note must belong to a document page."
  },
  "server.aPageNoteMayContainUpTo.86232c": {
    "ru": "Заметка к странице — не длиннее {p0} знаков.",
    "en": "A page note may contain up to {p0} characters."
  },
  "server.onlyTheTeacherMayCreateFilesIn.a33c2f": {
    "ru": "Создавать файлы на этом занятии может только преподаватель.",
    "en": "Only the teacher may create files in this class."
  },
  "server.onlyTheTeacherMayRenameFilesIn.e04cee": {
    "ru": "Переименовать файл в комнате может преподаватель.",
    "en": "Only the teacher may rename files in this room."
  },
  "server.cannotBePlacedInsideItself.de928c": {
    "ru": "«{p0}» нельзя положить внутрь себя.",
    "en": "“{p0}” cannot be placed inside itself."
  },
  "server.onlyTheTeacherMayRemoveAFile.77a4ef": {
    "ru": "Убрать файл из комнаты может преподаватель.",
    "en": "Only the teacher may remove a file from the room."
  },
  "server.onlyPyAndShFilesCanBe.fb990d": {
    "ru": "Запуск поддерживается только для файлов .py и .sh.",
    "en": "Only .py and .sh files can be run."
  },
  "server.onlyTheTeacherMayUndoAnOracle.a064cd": {
    "ru": "Отменять ход оракула здесь может преподаватель.",
    "en": "Only the teacher may undo an oracle action here."
  },
  "server.thisActionCanNoLongerBeUndone.29f138": {
    "ru": "Этот ход уже нельзя отменить: сервер помнит прежние файлы только до перезапуска.",
    "en": "This action can no longer be undone: previous file versions are retained only until the server restarts."
  },
  "server.onlyTheTeacherMayReorderCellsIn.601caf": {
    "ru": "На этом занятии порядок ячеек меняет преподаватель.",
    "en": "Only the teacher may reorder cells in this class."
  },
  "server.onlyTheTeacherMayOpenCells.27de8a": {
    "ru": "Открывает ячейки преподаватель.",
    "en": "Only the teacher may open cells."
  },
  "server.thisCellIsNoLongerInThe.3462ea": {
    "ru": "Этой ячейки в комнате уже нет.",
    "en": "This cell is no longer in the room."
  },
  "server.anAttemptMayContainUpToCharacters.ff604b": {
    "ru": "Попытка — не длиннее {p0} знаков; остальное вынесите в файл.",
    "en": "An attempt may contain up to {p0} characters. Put the rest in a file."
  },
  "server.theAttemptIsEmptyWriteYourSolution.f38771": {
    "ru": "Попытка пуста. Введите решение перед отправкой.",
    "en": "The attempt is empty. Write your solution before submitting."
  },
  "server.onlyTheTeacherMayLeadCouncil.745e70": {
    "ru": "Консилиум ведёт преподаватель.",
    "en": "Only the teacher may lead Council."
  },
  "server.thisAttemptNoLongerExists.b490bf": {
    "ru": "Этой попытки уже нет.",
    "en": "This attempt no longer exists."
  },
  "server.youCanRequestARunOnlyIn.dfdda0": {
    "ru": "Запросить запуск можно только в открытом консилиуме с режимом «По запросу».",
    "en": "You can request a run only in an open Council cell set to “On request”."
  },
  "server.writeYourSolutionFirst.b04f1e": {
    "ru": "Сначала напишите решение.",
    "en": "Write your solution first."
  },
  "server.theAttemptIsAlreadyRunningOrQueued.fc3fa7": {
    "ru": "Попытка уже выполняется или ждёт в очереди.",
    "en": "The attempt is already running or queued."
  },
  "server.onlyTheTeacherMayReviewRunRequests.630a48": {
    "ru": "Запросы на запуск рассматривает преподаватель.",
    "en": "Only the teacher may review run requests."
  },
  "server.theRequestHasChangedOrHasAlready.aa2b45": {
    "ru": "Запрос уже изменился или был рассмотрен.",
    "en": "The request has changed or has already been reviewed."
  },
  "server.onlyTheTeacherMayRunAnotherParticipant.982a38": {
    "ru": "Чужую попытку запускает преподаватель.",
    "en": "Only the teacher may run another participant's attempt."
  },
  "server.runRequestsAreNowClosed.f23dc6": {
    "ru": "Приём запросов на запуск уже закрыт.",
    "en": "Run requests are now closed."
  },
  "server.onlyTheTeacherMayRunAttemptsIn.fbe78a": {
    "ru": "В этом консилиуме попытки запускает преподаватель.",
    "en": "Only the teacher may run attempts in this Council cell."
  },
  "server.writeYourAttemptFirst.746013": {
    "ru": "Сначала напишите попытку.",
    "en": "Write your attempt first."
  },
  "server.theRequestHasChangedOrHasAlready.2ee147": {
    "ru": "Запрос уже изменился или был рассмотрен. Проверьте текущую версию решения.",
    "en": "The request has changed or has already been reviewed. Check the current solution."
  },
  "server.thisAttemptIsAlreadyRunning.0efa94": {
    "ru": "Эта попытка уже считается.",
    "en": "This attempt is already running."
  },
  "server.thisAttemptIsAlreadyQueuedAtPosition.0c6a86": {
    "ru": "Эта попытка уже в очереди — {p0}-я.",
    "en": "This attempt is already queued at position {p0}."
  },
  "server.aReplyMayContainUpToCharacters.1d0ef3": {
    "ru": "Ответ — не длиннее {p0} знаков.",
    "en": "A reply may contain up to {p0} characters."
  },
  "server.thereIsNobodyToReplyToThis.efbb65": {
    "ru": "Отвечать некому: этой попытки уже нет.",
    "en": "There is nobody to reply to: this attempt no longer exists."
  },
  "server.onlyTheTeacherMayApplyAnOracle.231855": {
    "ru": "Применить правку оракула здесь может преподаватель — спросить его можно по-прежнему.",
    "en": "Only the teacher may apply an oracle edit here. You can still ask questions."
  },
  "server.onlyTheParticipantWhoRanTheCell.d7ea88": {
    "ru": "Ввести ответ может участник, запустивший ячейку.",
    "en": "Only the participant who ran the cell may enter its input."
  },
  "server.theKernelIsNoLongerWaitingFor.e35793": {
    "ru": "Ядро уже не ждёт этого ввода — форма убрана.",
    "en": "The kernel is no longer waiting for this input. The form has been removed."
  },
  "server.couldNotOpenTheTerminal.b04b2c": {
    "ru": "Не удалось открыть терминал.",
    "en": "Could not open the terminal."
  },
  "server.onlyTheTeacherMayRunCellsAnd.1d861c": {
    "ru": "На этом занятии запускает преподаватель — и ячейки, и команды оболочки.",
    "en": "Only the teacher may run cells and shell commands in this class."
  },
  "server.theCommandExceedsBytes.4bc32c": {
    "ru": "Команда длиннее {p0} байт — ",
    "en": "The command exceeds {p0} bytes. "
  },
  "server.putItInAFileAndRun.5f2e18": {
    "ru": "положите её в файл и запустите файл.",
    "en": "Put it in a file and run the file."
  },
  "server.onlyTheTeacherOrTheParticipantWho.f9b6f0": {
    "ru": "Прервать команду может преподаватель или тот, кто её набрал.",
    "en": "Only the teacher or the participant who submitted the command may interrupt it."
  },
  "server.thisInstanceHasAlreadyBeenClaimed.585bbd": {
    "ru": "У этого сервера уже есть владелец",
    "en": "this instance has already been claimed"
  },
  "server.thatSetupTokenIsNotTheOne.cc477e": {
    "ru": "Этот токен установки не подходит к данному серверу",
    "en": "that setup token is not the one on this server"
  },
  "server.aNameIsRequired.d1287e": {
    "ru": "Введите имя",
    "en": "a name is required"
  },
  "server.nameMustBeCharactersOrFewer.f2480d": {
    "ru": "Имя должно содержать не более {p0} символов",
    "en": "name must be {p0} characters or fewer"
  },
  "server.aValidEmailAddressIsRequired.6f16a6": {
    "ru": "Введите корректный адрес электронной почты",
    "en": "a valid email address is required"
  },
  "server.thatEmailIsAlreadyOnTheStaff.cc750b": {
    "ru": "Этот адрес уже есть в списке преподавателей",
    "en": "that email is already on the staff list"
  },
  "server.thatAccountDisappearedMidClaim.c3a494": {
    "ru": "Учётная запись исчезла во время настройки",
    "en": "that account disappeared mid-claim"
  },
  "server.thisInstanceHasNotBeenClaimedYet.6bbdc7": {
    "ru": "У этого сервера ещё нет владельца",
    "en": "this instance has not been claimed yet"
  },
  "server.thatSignInLinkIsNoLonger.4fdb45": {
    "ru": "Эта ссылка входа больше не действует",
    "en": "that sign-in link is no longer valid"
  },
  "server.someoneWithThatEmailIsAlreadyOn.c19140": {
    "ru": "Преподаватель с этим адресом уже есть в списке",
    "en": "someone with that email is already on the staff list"
  },
  "server.thatAccountDisappearedMidCreate.591b74": {
    "ru": "Учётная запись исчезла во время создания",
    "en": "that account disappeared mid-create"
  },
  "server.noSuchTeacher.dc9e13": {
    "ru": "Такого преподавателя нет",
    "en": "no such teacher"
  },
  "server.thatPersonHasNoSignInLink.538ff7": {
    "ru": "У этого преподавателя пока нет ссылки входа — сначала создайте её",
    "en": "that person has no sign-in link yet — mint one first"
  },
  "server.roleMustBeOwnerOrTeacher.514175": {
    "ru": "Роль должна быть 'owner' или 'teacher'",
    "en": "role must be 'owner' or 'teacher'"
  },
  "server.theLastOwnerCannotBeDemoted.1782e0": {
    "ru": "Нельзя понизить роль последнего владельца",
    "en": "the last owner cannot be demoted"
  },
  "server.theLastOwnerCannotBeRemoved.d6e1d4": {
    "ru": "Нельзя удалить последнего владельца",
    "en": "the last owner cannot be removed"
  },
  "server.thatIsNotAnEnvironmentName.db085f": {
    "ru": "Недопустимое имя окружения",
    "en": "that is not an environment name"
  },
  "server.noSuchEnvironment.7ca461": {
    "ru": "Такого окружения нет",
    "en": "no such environment"
  },
  "server.imagesAreManagedByTheReleaseCatalog.14206b": {
    "ru": "Образы управляются каталогом выпусков. Соберите и импортируйте новую версию вне веб-приложения.",
    "en": "Images are managed by the release catalog. Build and import a new version outside the web application."
  },
  "server.useLowercaseLettersDigitsAndDashesFor.4f31ec": {
    "ru": "Используйте строчные латинские буквы, цифры и дефисы в имени окружения.",
    "en": "Use lowercase letters, digits and dashes for the environment name."
  },
  "server.couldNotWriteKernelEnvironmentsTxt.bd3f19": {
    "ru": "Не удалось записать kernel/environments/{p0}.txt: {p1}",
    "en": "Could not write kernel/environments/{p0}.txt: {p1}"
  },
  "server.thatIsTheEnvironmentTheRoomIs.c699b1": {
    "ru": "Комната использует это окружение. Сначала переключитесь на другое.",
    "en": "That is the environment the room is running. Switch to another one first."
  },
  "server.baseIsWhatEveryEnvironmentIsBuilt.1c36b7": {
    "ru": "Окружение base служит основой остальных окружений.",
    "en": "base is what every environment is built on top of."
  },
  "server.shipsWithColloqAndCannotBeDeletedHere.06a8ea": {
    "ru": "Окружение {p0} приехало вместе с colloq — удалить его нельзя. Правьте список пакетов: ваша копия ляжет рядом с настройками и переживёт обновление.",
    "en": "{p0} ships with colloq and cannot be deleted here. Edit its package list instead: your copy is saved beside your settings and survives an update."
  },
  "server.thisEnvironmentCannotBeDeletedWhileLinked.8047b8": {
    "ru": "Это окружение нельзя удалить, пока есть связанные занятия, в том числе архивные.",
    "en": "This environment cannot be deleted while linked classes exist, including archived classes."
  },
  "server.dockerIsUnavailable.6292c5": {
    "ru": "Docker недоступен",
    "en": "docker is unavailable"
  },
  "server.thatEnvironmentIsStillBuilding.d8f6a6": {
    "ru": "Это окружение ещё собирается.",
    "en": "That environment is still building."
  },
  "server.enterAGithubLinkToANotebook.110b0f": {
    "ru": "Введите ссылку GitHub на тетрадь или папку.",
    "en": "Enter a GitHub link to a notebook or folder."
  },
  "server.couldNotReadThatLink.6d642b": {
    "ru": "Не удалось прочитать эту ссылку.",
    "en": "Could not read that link."
  },
  "server.thatIsNotAGithubLink.d0476c": {
    "ru": "Это не ссылка GitHub.",
    "en": "That is not a GitHub link."
  },
  "server.thereIsNoEnvironmentCalled.a8903e": {
    "ru": "Окружения «{p0}» нет",
    "en": "there is no environment called \"{p0}\""
  },
  "server.thereIsNoNotebookWithAnyCells.5fa7bc": {
    "ru": "По этой ссылке нет тетради с ячейками.",
    "en": "There is no notebook with any cells at that link."
  },
  "server.noNotebookWasSent.4ec136": {
    "ru": "Тетрадь не была отправлена",
    "en": "no notebook was sent"
  },
  "server.couldNotReadThisFileAsA.ea3fc6": {
    "ru": "Не удалось прочитать файл как тетрадь. Загрузите корректный файл .ipynb.",
    "en": "Could not read this file as a notebook. Upload a valid .ipynb file."
  },
  "server.thisNotebookHasNoNonemptyCells.bc0428": {
    "ru": "В этой тетради нет непустых ячеек.",
    "en": "This notebook has no nonempty cells."
  },
  "server.thatLinkIsNotANotebookPoint.1d59ce": {
    "ru": "Эта ссылка не ведёт к тетради. Укажите файл .ipynb или папку.",
    "en": "That link is not a notebook. Point it at an .ipynb file or at a folder."
  },
  "server.thereIsNoIpynbInThatFolder.6299b2": {
    "ru": "В этой папке нет файлов .ipynb.",
    "en": "There is no .ipynb in that folder."
  },
  "server.thatSeminarNoLongerExists.b346fe": {
    "ru": "Этого занятия больше нет",
    "en": "that class no longer exists"
  },
  "server.aSeminarNameIsRequired.f10426": {
    "ru": "Введите название занятия",
    "en": "a class name is required"
  },
  "server.archivedMustBeTrueOrFalse.db6c12": {
    "ru": "Значение archived должно быть true или false",
    "en": "archived must be true or false"
  },
  "server.finishedMustBeTrueOrFalse.f9f3c0": {
    "ru": "Значение finished должно быть true или false",
    "en": "finished must be true or false"
  },
  "server.rulesMustBeAnObject.c2a9d1": {
    "ru": "Правила должны быть объектом",
    "en": "rules must be an object"
  },
  "server.theSeminarIsAlreadyStoppingTryAgain.ca0fd7": {
    "ru": "Занятие уже останавливается. Повторите попытку чуть позже.",
    "en": "The class is already stopping. Try again shortly."
  },
  "server.theTestCouldNotBeRunCheck.4fcf49": {
    "ru": "Не удалось выполнить проверку — посмотрите журнал сервера.",
    "en": "The test could not be run — check the server logs."
  },
  "server.joinTheSessionFirst.442dd6": {
    "ru": "Сначала войдите на занятие",
    "en": "join the session first"
  },
  "server.theOracleIsSwitchedOffForThis.2c2849": {
    "ru": "Оракул выключен на этом сервере.",
    "en": "The oracle is switched off for this instance."
  },
  "server.theOracleIsSwitchedOffForThis.9dc39a": {
    "ru": "Оракул выключен на этом занятии.",
    "en": "The oracle is switched off for this class."
  },
  "server.theOracleIsDisabledInThisColloq.e3d7f7": {
    "ru": "Оракул отключён на этом сервере Colloq.",
    "en": "The oracle is disabled in this Colloq instance."
  },
  "server.noModelIsSetUpOnThis.9957d2": {
    "ru": "На этом Colloq ещё не настроена модель — проверьте раздел «Оракул» в панели преподавателя.",
    "en": "No model is set up on this Colloq yet — add a key under Oracle in the teaching panel."
  },
  "server.noModelIsConfiguredForThisColloq.112833": {
    "ru": "На этом сервере Colloq не настроена модель. Попросите преподавателя проверить настройки.",
    "en": "No model is configured for this Colloq instance. Ask the teacher to check the settings."
  },
  "server.thatQuestionIsLongerThanCharactersShorten.a8c280": {
    "ru": "Вопрос длиннее {p0} символов. Сократите его.",
    "en": "That question is longer than {p0} characters. Shorten your question."
  },
  "server.nothingToAsk.d85713": {
    "ru": "Введите вопрос",
    "en": "nothing to ask"
  },
  "server.hintsModeIsEnabledAskForA.ec9c2a": {
    "ru": "Включён режим подсказок. Попросите подсказку.",
    "en": "Hints mode is enabled. Ask for a hint instead."
  },
  "server.fileEditsAreUnavailableInHintsMode.29ff63": {
    "ru": "В режиме подсказок правка файлов недоступна. Задайте вопрос оракулу.",
    "en": "File edits are unavailable in hints mode. Ask the oracle a question instead."
  },
  "server.oracleFileEditingIsDisabledInThis.9b1999": {
    "ru": "Правка файлов оракулом отключена на этом занятии.",
    "en": "Oracle file editing is disabled in this class."
  },
  "server.onlyTheTeacherMayAskTheOracle.441f53": {
    "ru": "Просить оракула править файлы здесь может преподаватель.",
    "en": "Only the teacher may ask the oracle to edit files here."
  },
  "server.thisSeminarHasUsedAllOracleQuestions.5ff314": {
    "ru": "Занятие использовало все {p0} вопросов оракулу за час. Повторите позже.",
    "en": "This class has used all {p0} oracle questions allowed per hour. Try again later."
  },
  "server.youHaveUsedYourOneOracleQuestion.61ab29": {
    "ru": "Вы использовали свой единственный вопрос оракулу за этот час на этом занятии",
    "en": "You have used your one oracle question for this hour in this class"
  },
  "server.waitBetweenQuestionsTryAgainIn.f64333": {
    "ru": "Между вопросами нужно подождать {p0}. Повторите через {p1}.",
    "en": "Wait {p0} between questions. Try again in {p1}."
  },
  "server.thereAreAlreadyOracleRequestsRunningIn.5ae3f8": {
    "ru": "В этой комнате уже выполняется {p0} запросов к оракулу. Повторите через {p1}.",
    "en": "There are already {p0} oracle requests running in this room. Try again in {p1}."
  },
  "server.entryidIsRequired.a5742a": {
    "ru": "Укажите entryId",
    "en": "entryId is required"
  },
  "server.youMayStopYourOwnQuestionOnly.9631c6": {
    "ru": "Остановить можно свой вопрос — чужой останавливает тот, кто его задал, или преподаватель.",
    "en": "You may stop your own question. Only its author or the teacher may stop another participant's question."
  },
  "server.onlyTheTeacherCanClearTheShared.684c21": {
    "ru": "Только преподаватель может очистить общую переписку с оракулом.",
    "en": "Only the teacher can clear the shared oracle conversation."
  },
  "server.onlyTheTeacherMayViewBlockedParticipants.5bc743": {
    "ru": "Список закрытых доступов видит преподаватель.",
    "en": "Only the teacher may view blocked participants."
  },
  "server.onlyTheTeacherMayBlockAccessTo.0508ad": {
    "ru": "Закрыть доступ на это занятие может преподаватель.",
    "en": "Only the teacher may block access to this class."
  },
  "server.participantidIsRequired.fc7d8c": {
    "ru": "Укажите participantId",
    "en": "participantId is required"
  },
  "server.participantNotFound.d59506": {
    "ru": "Участник не найден",
    "en": "participant not found"
  },
  "server.aTeacherCannotBeBlocked.ac6170": {
    "ru": "Нельзя закрыть доступ преподавателю.",
    "en": "A teacher cannot be blocked."
  },
  "server.onlyTheTeacherMayRestoreAccess.001a27": {
    "ru": "Восстановить доступ может только преподаватель.",
    "en": "Only the teacher may restore access."
  },
  "server.noSuchBan.55c3bd": {
    "ru": "Такой блокировки нет",
    "en": "no such ban"
  },
  "server.onlyTheTeacherMayLeadCouncil.9554ff": {
    "ru": "Консилиум ведёт преподаватель",
    "en": "Only the teacher may lead Council"
  },
  "server.theOracleIsDisabledOnThisColloq.e47e9a": {
    "ru": "Оракул отключён на этом Colloq.",
    "en": "The oracle is disabled on this Colloq instance."
  },
  "server.theOracleIsDisabledForThisSeminar.48f5c6": {
    "ru": "Оракул выключен на этом занятии — включите его в правилах комнаты.",
    "en": "The oracle is disabled for this class."
  },
  "server.theOracleIsDisabledOnThisColloq.395e3a": {
    "ru": "Оракул выключен на этом Colloq: вопросов в час — ноль.",
    "en": "The oracle is disabled on this Colloq instance: the hourly question limit is zero."
  },
  "server.noModelIsConfiguredOnThisColloq.c1d63b": {
    "ru": "На этом Colloq не настроена модель — добавьте ключ в разделе «Оракул» панели.",
    "en": "No model is configured on this Colloq instance. Check the Oracle settings in the teaching panel."
  },
  "server.thisCellIsNotInTheRoom.b481d9": {
    "ru": "Такой ячейки в комнате нет",
    "en": "This cell is not in the room"
  },
  "server.aSummaryIsAlreadyBeingPreparedWait.80427e": {
    "ru": "Сводка уже готовится. Дождитесь ответа или остановите запрос.",
    "en": "A summary is already being prepared. Wait for it or stop the request."
  },
  "server.thisSeminarHasReachedItsHourlyLimit.7638ce": {
    "ru": "Достигнут лимит занятия: {p0} вопросов к оракулу в час. Повторите позже.",
    "en": "This class has reached its hourly limit of {p0} oracle questions. Try again later."
  },
  "server.thereAreNoSubmittedAttemptsToSummarize.64f4fd": {
    "ru": "Нет сданных попыток для сводки.",
    "en": "There are no submitted attempts to summarize."
  },
  "server.aCourseNeedsAName.42dad0": {
    "ru": "Введите название курса",
    "en": "a course needs a name"
  },
  "server.courseNotFound.0429ec": {
    "ru": "Курс не найден",
    "en": "course not found"
  },
  "server.itemsMustBeAnArray.399a2e": {
    "ru": "Список элементов должен быть массивом",
    "en": "items must be an array"
  },
  "server.course.plannedNeedsTopic": {
    "ru": "У строки плана должна быть тема",
    "en": "A planned row needs a topic"
  },
  "server.thisCourseHasAlreadyBeenChanged.70c236": {
    "ru": "этот курс уже изменили",
    "en": "this course has already been changed"
  },
  "server.useLowercaseLatinLettersDigitsAndHyphens.f004a4": {
    "ru": "Используйте строчные латинские буквы, цифры и дефис.",
    "en": "Use lowercase Latin letters, digits, and hyphens."
  },
  "server.notFound.094b76": {
    "ru": "Не найдено",
    "en": "not found"
  },
  "server.course.7c69f0": {
    "ru": "курсом",
    "en": "course"
  },
  "server.page.356bb7": {
    "ru": "страницей",
    "en": "page"
  },
  "server.course.91f120": {
    "ru": "курса",
    "en": "course"
  },
  "server.page.3360a3": {
    "ru": "страницы",
    "en": "page"
  },
  "server.theAddressIsAlreadyInUse.795904": {
    "ru": "Адрес «{p0}» уже занят.",
    "en": "The address “{p0}” is already in use."
  },
  "server.theAddressIsAFormerNameOf.a5a2ca": {
    "ru": "Адрес «{p0}» — прежнее имя {p1} «{p2}».",
    "en": "The address “{p0}” is a former name of the {p1} “{p2}”."
  },
  "server.theAddressIsUsedByThe.3ffa25": {
    "ru": "Адрес «{p0}» занят {p1} «{p2}».",
    "en": "The address “{p0}” is used by the {p1} “{p2}”."
  },
  "server.stepsMustBeAnArray.62b083": {
    "ru": "Шаги должны быть массивом",
    "en": "steps must be an array"
  },
  "server.noMoreThanSteps.63addd": {
    "ru": "не больше {p0} шагов",
    "en": "no more than {p0} steps"
  },
  "server.chooseAVersionForTheStepA.ec311c": {
    "ru": "Укажите номер версии для шага: целое число больше нуля.",
    "en": "Choose a version for the step: a whole number greater than zero."
  },
  "server.notebookAtPublication.33f04f": {
    "ru": "Тетрадь на момент публикации",
    "en": "Notebook at publication"
  },
  "server.notPublished.61a0a5": {
    "ru": "Не опубликовано",
    "en": "not published"
  },
  "server.badStep.8811c6": {
    "ru": "Некорректный шаг",
    "en": "bad step"
  },
  "server.onlyTheTeacherMayAddFilesTo.2b4b09": {
    "ru": "Файлы в эту комнату добавляет преподаватель.",
    "en": "Only the teacher may add files to this room."
  },
  "server.expectedAMultipartFormDataUpload.ccb3d0": {
    "ru": "Ожидается загрузка multipart/form-data",
    "en": "expected a multipart/form-data upload"
  },
  "server.malformedUpload.084748": {
    "ru": "Некорректная загрузка",
    "en": "malformed upload"
  },
  "server.theUploadWasCutOff.7fff95": {
    "ru": "Загрузка прервалась",
    "en": "the upload was cut off"
  },
  "server.wasNotUploadedThePathIsToo.f1300d": {
    "ru": "{p0} не загружен: путь «{p1}» слишком длинный.",
    "en": "{p0} was not uploaded: the path “{p1}” is too long."
  },
  "server.isAFileNotAFolderIt.8e6810": {
    "ru": "«{p0}» — файл, а не папка: положить в него {p1} нельзя.",
    "en": "“{p0}” is a file, not a folder. It cannot contain {p1}."
  },
  "server.couldNotCreateFolderFor.1dcce8": {
    "ru": "Не удалось создать папку «{p0}» для {p1}.",
    "en": "Could not create folder “{p0}” for {p1}."
  },
  "server.uploadDirectoryChangedOrIsNotWritable.3c0d96": {
    "ru": "Каталог загрузки изменился или недоступен для записи",
    "en": "Upload directory changed or is not writable"
  },
  "server.couldNotWrite.2758e3": {
    "ru": "Не удалось записать {p0}",
    "en": "could not write {p0}"
  },
  "server.isLargerThanMb.28d7e5": {
    "ru": "Размер {p0} превышает {p1} МБ",
    "en": "{p0} is larger than {p1} MB"
  },
  "server.isAnOpenRoomNotebookEditIts.eaabdd": {
    "ru": "{p0} — открытая тетрадь комнаты. Редактируйте её ячейки или загрузите файл под другим именем.",
    "en": "{p0} is an open room notebook. Edit its cells or upload the file under another name."
  },
  "server.alreadyExistsInThisRoomOnlyThe.2ac397": {
    "ru": "{p0} уже есть в этой комнате — заменить его может преподаватель.",
    "en": "{p0} already exists in this room. Only the teacher may replace it."
  },
  "server.upToFilesPerUploadUploadThe.0987d4": {
    "ru": "Можно загрузить до {p0} файлов за раз. Загрузите остальные отдельно.",
    "en": "Up to {p0} files per upload. Upload the remaining files separately."
  },
  "server.badPath.95c1aa": {
    "ru": "Некорректный путь",
    "en": "bad path"
  },
  "server.fileNotFound.3e2256": {
    "ru": "Файл не найден",
    "en": "file not found"
  },
  "server.onlyTheTeacherCanRemoveAFile.289f45": {
    "ru": "Только преподаватель может удалить файл из комнаты.",
    "en": "Only the teacher can remove a file from the room."
  },
  "server.thisHistoryBelongsToASeminarYou.5112cc": {
    "ru": "Эта история принадлежит занятию, на которое вы не вошли",
    "en": "this history belongs to a class you are not in"
  },
  "server.onlyTheTeacherCanViewThisSeminar.4c05e0": {
    "ru": "Просматривать историю версий на этом занятии может только преподаватель.",
    "en": "Only the teacher can view this class's version history."
  },
  "server.badVersion.a29edb": {
    "ru": "Некорректная версия",
    "en": "bad version"
  },
  "server.noSuchVersion.57ccc9": {
    "ru": "Такой версии нет",
    "en": "no such version"
  },
  "server.onlyTheHostCanRestoreAVersion.0540c5": {
    "ru": "Только преподаватель может восстановить версию",
    "en": "only the host can restore a version"
  },
  "server.onlyTheHostCanSetACheckpoint.e8860a": {
    "ru": "Только преподаватель может сохранить именованную версию",
    "en": "only the host can set a checkpoint"
  },
  "server.aCheckpointNeedsAName.845b89": {
    "ru": "Введите название версии",
    "en": "a checkpoint needs a name"
  },
  "server.theSeminarIsStoppingTryAgainShortly.b8256e": {
    "ru": "Занятие останавливается. Повторите чуть позже.",
    "en": "The class is stopping. Try again shortly."
  },
  "server.onlyStaffCanCreateASeminarOn.eb0b8c": {
    "ru": "На этом сервере занятия создают только преподаватели. Попросите ссылку на нужное занятие.",
    "en": "Only staff can create a class on this instance. Ask for a link to the one you are joining."
  },
  "server.aSessionNameIsRequired.15da74": {
    "ru": "Введите название занятия",
    "en": "a session name is required"
  },
  "server.sessionNameMustBeCharactersOrFewer.a4c426": {
    "ru": "Название занятия должно содержать не более {p0} символов",
    "en": "session name must be {p0} characters or fewer"
  },
  "server.tooManyPeopleAreJoiningThisSeminar.11739b": {
    "ru": "Сейчас слишком много людей входят на занятие — повторите через минуту",
    "en": "too many people are joining this class at once — try again in a minute"
  },
  "server.onlyTheTeacherMaySharePresenterControls.d098fa": {
    "ru": "Пульт лекции передаёт преподаватель.",
    "en": "Only the teacher may share presenter controls."
  },
  "server.thisPresenterLinkIsInvalidOrHas.0f5b09": {
    "ru": "Ссылка на пульт недействительна или уже использована. Создайте новую ссылку на устройстве преподавателя.",
    "en": "This presenter link is invalid or has already been used. Create a new link on the teacher's device."
  },
  "server.onlyTheTeacherMayChangeThisSeminar.a9e299": {
    "ru": "Правила этого занятия задаёт преподаватель.",
    "en": "Only the teacher may change this class's rules."
  },
  "server.thePageHasReachedItsStrokeLimit.748194": {
    "ru": "Достигнут лимит штрихов на странице. Добавьте чистый лист",
    "en": "The page has reached its stroke limit. Add a blank page."
  },
  "server.theLimitOfAnnotatedPagesHasBeen.8ca2af": {
    "ru": "Достигнут лимит страниц с разметкой. Удалите ненужную разметку",
    "en": "The limit of annotated pages has been reached. Remove unused annotations."
  },
  "server.theStrokeLengthLimitHasBeenReached.2f95b5": {
    "ru": "Достигнут лимит длины штриха. Поднимите перо и продолжите новым штрихом",
    "en": "The stroke length limit has been reached. Lift the pen and start a new stroke."
  },
  "server.theNamesAndAreReservedChooseAnother.d0854b": {
    "ru": "Имена «.» и «..» зарезервированы. Выберите другое имя.",
    "en": "The names “.” and “..” are reserved. Choose another name."
  },
  "server.containsASlashUseNewFolderTo.b86a22": {
    "ru": "В «{p0}» есть косая черта. Чтобы создать папку, используйте кнопку «Новая папка».",
    "en": "“{p0}” contains a slash. Use “New folder” to create a folder."
  },
  "server.containsUnsupportedCharacters.7b05cf": {
    "ru": "В «{p0}» есть недопустимые символы.",
    "en": "“{p0}” contains unsupported characters."
  },
  "server.startsWithADotTheFilesPanel.864c22": {
    "ru": "«{p0}» начинается с точки. Скрытые файлы не поддерживаются в панели.",
    "en": "“{p0}” starts with a dot. The Files panel does not support hidden files."
  },
  "server.startsOrEndsWithASpaceRemove.32f39c": {
    "ru": "У «{p0}» есть пробел в начале или конце. Удалите его.",
    "en": "“{p0}” starts or ends with a space. Remove it."
  },
  "server.theNameContainsCharactersShortenItTo.b0c9e9": {
    "ru": "Имя длиной {p0} символов — оставьте {p1}.",
    "en": "The name contains {p0} characters. Shorten it to {p1}."
  },
  "server.cannotBeUsedAsAName.67c58f": {
    "ru": "«{p0}» не годится в качестве имени.",
    "en": "“{p0}” cannot be used as a name."
  },
  "server.noModelIsSetUpOnThis.7014ab": {
    "ru": "На этом Colloq ещё не настроена модель. Владелец сервера может добавить её в разделе «Оракул» панели преподавателя.",
    "en": "No model is set up on this Colloq yet. Whoever runs it can add one under Oracle in the teaching panel."
  },
  "server.theModelStoppedSendingItsResponseTry.3aa75a": {
    "ru": "Модель перестала отправлять ответ. Повторите попытку.",
    "en": "The model stopped sending its response. Try again."
  },
  "server.theModelDidNotRespondWithinThe.be1746": {
    "ru": "Модель не ответила за отведённое время. Повторите попытку.",
    "en": "The model did not respond within the time limit. Try again."
  },
  "server.askWhoeverRunsThisColloqToCheck.43c560": {
    "ru": "Попросите владельца Colloq проверить модель.",
    "en": "Ask whoever runs this Colloq to check the model."
  },
  "server.theOracleIsUnavailableTryAgainOr.c900e7": {
    "ru": "Оракул недоступен. Повторите попытку или попросите преподавателя проверить соединение.",
    "en": "The oracle is unavailable. Try again or ask the teacher to check the connection."
  },
  "server.explainThisCell.f897a5": {
    "ru": "Объясни эту ячейку",
    "en": "Explain this cell"
  },
  "server.fixThisCell.0e43d1": {
    "ru": "Исправь эту ячейку",
    "en": "Fix this cell"
  },
  "server.whyIsThisWrong.50358d": {
    "ru": "Почему это неверно?",
    "en": "Why is this wrong?"
  },
  "server.improveThisCell.16130e": {
    "ru": "Улучши эту ячейку",
    "en": "Improve this cell"
  },
  "server.rewriteThisCell.fe2d4a": {
    "ru": "Перепиши эту ячейку",
    "en": "Rewrite this cell"
  },
  "server.giveMeAHint.f2629c": {
    "ru": "Дай подсказку",
    "en": "Give me a hint"
  },
  "server.helpMeWithThis.05371a": {
    "ru": "Помоги с этим",
    "en": "Help me with this"
  },
  "server.noModelIsSetUpOnThis.1152ef": {
    "ru": "На этом Colloq ещё не настроена модель.",
    "en": "No model is set up on this Colloq yet."
  },
  "server.theModelRejectedTheRequestWithTools.c6fde5": {
    "ru": "Модель отклонила запрос с инструментами. ",
    "en": "The model rejected the request with tools. "
  },
  "server.tryAskingAQuestionInstead.a2a998": {
    "ru": "Попробуйте режим вопроса.",
    "en": "Try asking a question instead."
  },
  "server.noEndpointAddressIsSetChooseA.93a30c": {
    "ru": "Не задан адрес API — выберите провайдера или введите базовый URL.",
    "en": "No endpoint address is set — choose a provider or type a base URL."
  },
  "server.noModelIsSetTypeTheName.dce34d": {
    "ru": "Модель не задана — введите имя, которое принимает endpoint, например gpt-4o-mini.",
    "en": "No model is set — type the name the endpoint expects, e.g. gpt-4o-mini."
  },
  "server.noApiKeyIsSetPasteOne.d5a86a": {
    "ru": "API-ключ не задан — вставьте ключ или выберите локальный провайдер, которому ключ не нужен.",
    "en": "No API key is set — paste one, or switch the provider to a local runtime that does not need one."
  },
  "server.theEndpointReturnedHttpCheckTheAccount.346fd1": {
    "ru": "Endpoint вернул HTTP 429. Проверьте квоту аккаунта и ограничения запросов.",
    "en": "The endpoint returned HTTP 429. Check the account quota and request limits."
  },
  "server.theModelDeclinedThisRequest.5e72c3": {
    "ru": "Модель отклонила этот запрос.",
    "en": "The model declined this request."
  },
  "server.theAiProviderDeniedAccessAskThe.31dbd6": {
    "ru": "Провайдер ИИ отказал в доступе. Попросите администратора Colloq проверить API-ключ и права аккаунта.",
    "en": "The AI provider denied access. Ask the Colloq administrator to check the API key and account permissions."
  },
  "server.theAiProviderReturnedHttpItsRequest.7a3832": {
    "ru": "Провайдер ИИ вернул HTTP 429. Возможно, достигнут лимит запросов или квота аккаунта. Повторите позже или попросите администратора проверить настройки.",
    "en": "The AI provider returned HTTP 429. Its request limit or account quota may have been reached. Try later or ask the Colloq administrator to check."
  },
  "server.theAiEndpointReturnedAServerError.c7d0c1": {
    "ru": "Сервер провайдера ИИ вернул ошибку.",
    "en": "The AI endpoint returned a server error."
  },
  "server.theModelResponseWasInterruptedTryAgain.b5ba0f": {
    "ru": "Ответ модели прервался. Повторите попытку.",
    "en": "The model response was interrupted. Try again."
  },
  "server.couldNotReachTheAiEndpointWhoever.5a0409": {
    "ru": "Не удалось подключиться к провайдеру ИИ. Владелец Colloq может проверить адрес и ключ.",
    "en": "Could not reach the AI endpoint. Whoever runs this Colloq can check its address and key."
  },
  "server.environmentsReferToEachOtherInA.0d5bfa": {
    "ru": "окружения ссылаются друг на друга по кругу: {p0}",
    "en": "environments refer to each other in a cycle: {p0}"
  },
  "server.cannotBeAnEnvironmentFilenameOrImage.0ea5d5": {
    "ru": "«{p0}» не может быть именем окружения — ни файлом, ни тегом образа",
    "en": "“{p0}” cannot be an environment filename or image tag"
  },
  "server.environmentDoesNotExist.8a7fc4": {
    "ru": "нет окружения «{p0}»",
    "en": "environment “{p0}” does not exist"
  },
  "server.environmentIsBasedOnWhichDoesNot.3611b2": {
    "ru": "окружение «{p0}» строится поверх «{p1}», а такого нет",
    "en": "environment “{p0}” is based on “{p1}”, which does not exist"
  },
  "server.theEnvironmentChainExceedsLevels.8f1ecf": {
    "ru": "цепочка окружений длиннее {p0} звеньев: {p1}",
    "en": "the environment chain exceeds {p0} levels: {p1}"
  },
  "server.publishedEnvironmentsAreManagedByTheRelease.8ff51e": {
    "ru": "Опубликованные окружения управляются каталогом выпусков. Собирайте и импортируйте образы вне веб-приложения.",
    "en": "Published environments are managed by the release catalog. Build and import images outside the web application."
  },
  "server.dockerIsNotReachableFromTheServer.ffa886": {
    "ru": "Сервер не видит Docker. При запуске в контейнере нужны /var/run/docker.sock ",
    "en": "Docker is not reachable from the server. Running in a container? It needs /var/run/docker.sock "
  },
  "server.andDockerGidTheGroupThatOwns.6ee275": {
    "ru": "и DOCKER_GID — группа владельца сокета. `make up` задаёт оба значения. ",
    "en": "and DOCKER_GID, the group that owns it — `make up` sets both. "
  },
  "server.theKernelDirectoryIsNotInThis.3ff129": {
    "ru": "В контейнере нет каталога kernel, необходимого для сборки: ",
    "en": "The kernel directory is not in this container, and a build needs it as its context: "
  },
  "server.kernelDockerfileAndThePackageListsBeside.7f2949": {
    "ru": "kernel/Dockerfile и списков пакетов рядом. docker-compose.yml монтирует ./kernel — ",
    "en": "kernel/Dockerfile and the package lists beside it. docker-compose.yml mounts ./kernel — "
  },
  "server.updateItAndRestartOrBuildOn.25c277": {
    "ru": "обновите его и перезапустите либо соберите на хосте через `make env-build NAME=<name>`.",
    "en": "update it and restart, or build on the host with `make env-build NAME=<name>`."
  },
  "server.makingAnEnvironmentTheDefaultWritesKernel.40527e": {
    "ru": "Выбор окружения по умолчанию записывает KERNEL_ENV в .env рядом с docker-compose.yml, ",
    "en": "Making an environment the default writes KERNEL_ENV to the .env beside docker-compose.yml, "
  },
  "server.andThatFileIsTheHostS.d583a8": {
    "ru": "а этот файл находится на хосте: выполните там `make env-use NAME=<name>`.",
    "en": "and that file is the host’s: run `make env-use NAME=<name>` there."
  },
  "server.buildingAnImageNeedsNeitherAndWorks.0701a2": {
    "ru": " Для сборки образа это не требуется, её можно запустить отсюда.",
    "en": " Building an image needs neither, and works from here."
  },
  "server.imagesArePublishedOutsideTheWebApplication.d2806b": {
    "ru": "Образы публикуются вне веб-приложения. Соберите образ окружения и импортируйте digest инструментами выпуска.",
    "en": "Images are published outside the web application. Build an environment image and import its digest through the release tooling."
  },
  "server.publishedEnvironmentsAreBuiltOutsideTheWeb.538ec6": {
    "ru": "Опубликованные окружения собираются вне веб-приложения и импортируются через каталог выпусков",
    "en": "Published environments are built outside the web application and imported through the release catalog"
  },
  "server.environmentInThisChainIsAlreadyBuilding.166f94": {
    "ru": "окружение «{p0}» из этой цепочки уже собирается — дождитесь конца",
    "en": "environment “{p0}” in this chain is already building. Wait for it to finish"
  },
  "server.environmentAsksForPythonButTheChain.7b21ac": {
    "ru": "окружение «{p0}» просит Python {p1}, но версию выбирает корень цепочки — «{p2}» с Python {p3}. Уберите строку либо соберите «{p0}» отдельно, без `# colloq: from`",
    "en": "environment “{p0}” asks for Python {p1}, but the chain root decides the version — “{p2}” with Python {p3}. Drop the line, or build “{p0}” on its own, without `# colloq: from`"
  },
  "server.kernelParentIsSetInTheServers.4c1d90": {
    "ru": "— KERNEL_PARENT={p0} задан в окружении сервера и сильнее директивы: собираем на нём, а не на {p1}",
    "en": "— KERNEL_PARENT={p0} is set in the server’s environment and outranks the directive: building on it, not on {p1}"
  },
  "server.buildFinished.ce23d0": {
    "ru": "— сборка завершена",
    "en": "— build finished"
  },
  "server.githubHasNothingAtThatAddressOr.e7b0f0": {
    "ru": "По этому адресу на GitHub ничего нет либо репозиторий закрытый. ",
    "en": "GitHub has nothing at that address — or the repository is private. "
  },
  "server.thisServerReadsGithubAnonymouslySoA.6f5e7a": {
    "ru": "Сервер обращается к GitHub анонимно, поэтому не отличает закрытый репозиторий от отсутствующего. ",
    "en": "This server reads GitHub anonymously, so a private repository looks exactly like a missing one. "
  },
  "server.checkTheLinkAndIfItIs.53f905": {
    "ru": "Проверьте ссылку; если репозиторий закрытый, загрузите файлы напрямую.",
    "en": "Check the link, and if it is private, upload the files instead."
  },
  "server.githubIsRateLimitingThisServerSixty.13314c": {
    "ru": "GitHub ограничил запросы этого сервера: для анонимного доступа доступно 60 запросов в час. Повторите позже.",
    "en": "GitHub is rate-limiting this server (sixty anonymous requests an hour). Try again shortly."
  },
  "server.thatLinkPointsAtAFileNot.906633": {
    "ru": "Эта ссылка ведёт к файлу, а не папке.",
    "en": "That link points at a file, not a folder."
  },
  "server.theKernelCouldNotRunTheFormatter.007883": {
    "ru": "Ядро не смогло запустить форматирование.",
    "en": "The kernel could not run the formatter."
  },
  "server.theFormatterDidNotAnswer.610402": {
    "ru": "Форматирование не вернуло ответ.",
    "en": "The formatter did not answer."
  },
  "server.theKernelHadStoppedStartingAFresh.65e2e2": {
    "ru": "Ядро остановилось. Запускается новое — прежние переменные потеряны.",
    "en": "The kernel had stopped. Starting a fresh one — variables from before are gone."
  },
  "server.theKernelRestartedUnexpectedlyVariablesWereReset.f87dd9": {
    "ru": "Ядро неожиданно перезапустилось. Переменные сброшены, очередь ячеек очищена.",
    "en": "The kernel restarted unexpectedly. Variables were reset and queued cells were removed."
  },
  "server.theKernelRestartedUnexpectedlyVariablesWereReset.a76c88": {
    "ru": "Ядро неожиданно перезапустилось. Переменные сброшены.",
    "en": "The kernel restarted unexpectedly. Variables were reset."
  },
  "server.theKernelStoppedDuringExecutionQueuedCells.74ec64": {
    "ru": "Ядро остановилось во время выполнения. Очередь ячеек очищена. Перезапустите ядро, чтобы продолжить.",
    "en": "The kernel stopped during execution. Queued cells were removed. Restart the kernel to continue."
  },
  "server.theContainerWasKilledByMemoryLimit.6ab1f2": {
    "ru": "Контейнер комнаты убит по памяти: лимит {p0}, занято {p1}. Поднимите KERNEL_MEM в .env этой машины или считайте меньшими порциями.",
    "en": "The room's container was killed by memory: the limit is {p0} and {p1} was in use. Raise KERNEL_MEM in this machine's .env, or work in smaller batches."
  },
  "server.theContainerWasKilledByMemoryOnCell.0d3c74": {
    "ru": "Контейнер комнаты убит по памяти: лимит {p0}, занято {p1} на ячейке {p2}. Поднимите KERNEL_MEM в .env этой машины или считайте меньшими порциями.",
    "en": "The room's container was killed by memory: the limit is {p0} and {p1} was in use on cell {p2}. Raise KERNEL_MEM in this machine's .env, or work in smaller batches."
  },
  "server.theRoomContainerStoppedWithCode.b72e19": {
    "ru": "Контейнер комнаты остановился, код выхода {p0}. Последнее в его журнале: {p1}",
    "en": "The room's container stopped with exit code {p0}. The last thing in its log: {p1}"
  },
  "server.theKernelProcessEndedWithoutRunningOut.4fd8a1": {
    "ru": "Процесс ядра завершился не по памяти: в контейнере занято {p0} из {p1}. Последнее в журнале контейнера: {p2}",
    "en": "The kernel process ended without running out of memory: the container was using {p0} of {p1}. The last thing in its log: {p2}"
  },
  "server.theKernelStoppedRestartItToRun.911803": {
    "ru": "Ядро остановилось. Перезапустите его для выполнения кода.",
    "en": "The kernel stopped. Restart it to run anything."
  },
  "server.theInterruptAlsoDroppedTheOneCell.612a37": {
    "ru": "При остановке удалена и следующая ячейка из очереди.",
    "en": "The interrupt also dropped the one cell queued behind it."
  },
  "server.aCellFailedSoTheOneQueued.6d932d": {
    "ru": "В ячейке возникла ошибка, поэтому следующая ячейка из очереди не запущена.",
    "en": "A cell failed, so the one queued behind it was not run."
  },
  "server.theAttemptWasInterrupted.4f4edf": {
    "ru": "Запуск попытки прервали.",
    "en": "The attempt was interrupted."
  },
  "server.thePythonKernelStoppedRespondingRestartIt.09f400": {
    "ru": "Ядро Python перестало отвечать. Перезапустите его, чтобы продолжить.",
    "en": "The Python kernel stopped responding. Restart it to continue."
  },
  "server.theCellThatWasRunningWasDeleted.ec6ea8": {
    "ru": "Выполнявшаяся ячейка удалена, поэтому ядро остановлено. Уже внесённые изменения остались в памяти.",
    "en": "The cell that was running was deleted, so the kernel was interrupted — whatever it had already changed is still in memory."
  },
  "server.theKernelRestartedDuringExecutionThisCell.e72a65": {
    "ru": "Ядро перезапустилось во время выполнения. Ячейка прервана, переменные сброшены. Ядро снова доступно.",
    "en": "The kernel restarted during execution. This cell was interrupted and variables were reset. The kernel is available again."
  },
  "server.theKernelIsNotRunning.2a9152": {
    "ru": "Ядро не запущено.",
    "en": "The kernel is not running."
  },
  "server.aCellIsWaitingForInputAnswer.370e11": {
    "ru": "Ячейка ждёт input() — введите ответ или остановите её, затем снова нажмите «Форматировать».",
    "en": "a cell is waiting for input() — answer it (or stop it) and press Format again."
  },
  "server.theKernelIsBusyRunningACell.9452d9": {
    "ru": "Ядро выполняет ячейку — нажмите «Форматировать» после завершения.",
    "en": "the kernel is busy running a cell — press Format again when it finishes."
  },
  "server.cellsAreQueuedToRunPressFormat.204e75": {
    "ru": "В очереди есть ячейки — нажмите «Форматировать», когда очередь опустеет.",
    "en": "cells are queued to run — press Format again when the queue is empty."
  },
  "server.jupyterIsUnreachable.372559": {
    "ru": "Jupyter недоступен",
    "en": "Jupyter is unreachable"
  },
  "server.noResponse.187241": {
    "ru": "Нет ответа",
    "en": "no response"
  },
  "server.jupyterReturnedASessionWithNoKernel.29a99e": {
    "ru": "Jupyter вернул сессию без ядра",
    "en": "Jupyter returned a session with no kernel"
  },
  "server.thePythonKernelIsNotRunning.a9cde2": {
    "ru": "Ядро Python не запущено",
    "en": "the Python kernel is not running"
  },
  "server.channelClosedBeforeItOpened.7a0657": {
    "ru": "Канал закрылся до открытия",
    "en": "channel closed before it opened"
  },
  "server.theKernelConnectionWasClosed.e0bdcf": {
    "ru": "Соединение с ядром закрыто",
    "en": "the kernel connection was closed"
  },
  "server.lostTheConnectionToThePythonKernel.c46ec2": {
    "ru": "Связь с ядром Python потеряна",
    "en": "lost the connection to the Python kernel"
  },
  "server.environmentRequiresAGpuButNoneIs.53af19": {
    "ru": "Окружению «{p0}» нужен GPU, а этой машине он не выделен. Назовите срезы в KERNEL_GPUS в .env (`KERNEL_GPUS=0` или `KERNEL_GPUS=MIG-…`, как их зовёт docker) и перезапустите сервер — или откройте занятие на окружении без GPU: на процессоре это окружение не поедет.",
    "en": "Environment “{p0}” requires a GPU, but none is allocated to this machine. Set device IDs in KERNEL_GPUS in .env (`KERNEL_GPUS=0` or `KERNEL_GPUS=MIG-…`, as named by Docker) and restart the server, or use a CPU environment. This environment cannot run on CPU alone."
  },
  "server.environmentRequiresAGpuButAllAvailable.f3d4d9": {
    "ru": "Окружению «{p0}» нужен GPU, а свободных срезов нет: их {p1}, и все заняты другими занятиями. Подождите, пока освободится — срез уходит вместе с ядром комнаты, — или откройте занятие на окружении без GPU: на процессоре это окружение не поедет.",
    "en": "Environment “{p0}” requires a GPU, but all {p1} available devices are in use by other classes. Wait for a room kernel to release one, or use a CPU environment. This environment cannot run on CPU alone."
  },
  "server.couldNotStartTheRoomContainer.cf7398": {
    "ru": "контейнер комнаты не удалось поднять: {p0}",
    "en": "could not start the room container: {p0}"
  },
  "server.theContainerIsInAStateThat.d95d79": {
    "ru": "контейнер в состоянии, из которого docker start его не поднимает",
    "en": "the container is in a state that docker start cannot recover"
  },
  "server.theEnvironmentImageWasRebuilt.229a9d": {
    "ru": "образ окружения пересобран",
    "en": "the environment image was rebuilt"
  },
  "server.theServerChangedNetworks.08933e": {
    "ru": "сервер сменил сеть",
    "en": "the server changed networks"
  },
  "server.roomPerimeter.migrated": {
    "ru": "контейнер поднят до укреплённого профиля (без привилегий и без доступа к локальной сети) и пересоздаётся уже с ним",
    "en": "the container predates the hardened profile (no privileges, no access to the local network) and is recreated with it"
  },
  "server.roomPerimeter.refused": {
    "ru": "Комнату не запустить: не удалось закрыть ей доступ к локальным адресам этой машины ({p0}). Без этого запрета код студента дотянулся бы до роутера, до самого компьютера и до его сервисов, поэтому ядро не поднимается. Нужно, чтобы Docker мог запустить привилегированный служебный контейнер в сети хоста: в Docker Desktop выключите Enhanced Container Isolation, а rootless Docker и podman этого не умеют. Если машина и класс доверенные, допишите в .env строку COLLOQ_ROOM_NETWORK=open и перезапустите Colloq — комнаты пойдут без запрета.",
    "en": "The room cannot start: blocking its access to this machine's local addresses failed ({p0}). Without that block, student code could reach the router, this computer and its services, so the kernel is not started. Docker has to be able to run a privileged helper container on the host network: turn off Enhanced Container Isolation in Docker Desktop; rootless Docker and podman cannot do this. If the machine and the class are trusted, add the line COLLOQ_ROOM_NETWORK=open to .env and restart Colloq — rooms then start without the block."
  },
  "server.theContainerWasStartedWithADifferent.bc4d7d": {
    "ru": "контейнер поднят не с тем срезом GPU",
    "en": "the container was started with a different GPU device"
  },
  "server.environmentHasNotBeenBuiltBuildIt.cf54f5": {
    "ru": "Окружение «{p0}» ни разу не собиралось. Соберите его: в панели, в разделе «Окружения», или `make env-build NAME={p1}` на хосте — и откройте занятие заново.",
    "en": "Environment “{p0}” has not been built. Build it under Environments in the panel or run `make env-build NAME={p1}` on the host, then reopen the class."
  },
  "server.theHostMayBeMissingNvidiaContainer.f5c0df": {
    "ru": " Похоже, на хосте нет nvidia-container-toolkit: проверьте `docker run --rm --gpus all ubuntu nvidia-smi`.",
    "en": " The host may be missing nvidia-container-toolkit. Check `docker run --rm --gpus all ubuntu nvidia-smi`."
  },
  "server.theRoomKernelRejectedItsTokenHttp.c7ea0c": {
    "ru": "ядро комнаты не приняло токен (HTTP {p0})",
    "en": "the room kernel rejected its token (HTTP {p0})"
  },
  "server.theRoomKernelDidNotRespondWithin.1324d5": {
    "ru": "ядро комнаты не ответило за 90 с ({p0})",
    "en": "the room kernel did not respond within 90 seconds ({p0})"
  },
  "server.kernel.unschedulable": {
    "ru": "Python в этой комнате сейчас не запускается: на сервере нет для неё места. Преподаватель видит причину и может это исправить.",
    "en": "Python can’t start in this room right now: the server has no capacity left for it. Your teacher can see why and can fix it."
  },
  "server.cannotStartKernelSeminarIsStopping.9820e1": {
    "ru": "Не удалось запустить ядро: занятие останавливается",
    "en": "Cannot start kernel: class is stopping"
  },
  "server.cannotStartKernelSeminarDoesNotExist.4f72c5": {
    "ru": "Не удалось запустить ядро: занятия нет",
    "en": "Cannot start kernel: class does not exist"
  },
  "server.invalidKernelRuntimeResponse.110f37": {
    "ru": "Некорректный ответ runtime ядра",
    "en": "Invalid kernel runtime response"
  },
  "server.invalidKernelRuntimeUrl.e0bb3b": {
    "ru": "Некорректный URL runtime ядра",
    "en": "Invalid kernel runtime URL"
  },
  "server.invalidKernelRuntimeUrlCredentialsQueryStrings.b2ea18": {
    "ru": "Некорректный URL runtime ядра: данные входа, параметры запроса и префиксы пути запрещены",
    "en": "Invalid kernel runtime URL: credentials, query strings and path prefixes are not allowed"
  },
  "server.cannotReadTheKernelRuntimeCredential.01bb5b": {
    "ru": "Не удалось прочитать ключ runtime ядра",
    "en": "Cannot read the kernel runtime credential"
  },
  "server.aValidKernelRuntimeCredentialIsRequired.bf5c2f": {
    "ru": "Нужен корректный ключ runtime ядра",
    "en": "A valid kernel runtime credential is required"
  },
  "server.kernelRuntimeResponseExceedsTheSizeLimit.3c5ab1": {
    "ru": "Ответ runtime ядра превышает ограничение размера",
    "en": "Kernel runtime response exceeds the size limit"
  },
  "server.kernelRuntimeReturnedInvalidJson.c52e11": {
    "ru": "Runtime ядра вернул некорректный JSON",
    "en": "Kernel runtime returned invalid JSON"
  },
  "server.kernelRuntimeIsUnreachableOrDidNot.86406b": {
    "ru": "Runtime ядра недоступен или не ответил вовремя",
    "en": "Kernel runtime is unreachable or did not respond in time"
  },
  "server.invalidSessionIdentifier.0f97c4": {
    "ru": "Некорректный идентификатор занятия",
    "en": "Invalid session identifier"
  },
  "server.invalidKernelRuntimeEndpointOrInstanceIdentity.a63d8b": {
    "ru": "Некорректный адрес runtime или идентификатор ядра",
    "en": "Invalid kernel runtime endpoint or instance identity"
  },
  "server.kernelRuntimeReturnedADifferentEnvironmentRevision.8f728c": {
    "ru": "Runtime ядра вернул другую ревизию окружения",
    "en": "Kernel runtime returned a different environment revision"
  },
  "server.invalidJupyterEndpointUrl.edef18": {
    "ru": "Некорректный адрес Jupyter",
    "en": "Invalid Jupyter endpoint URL"
  },
  "server.kernelRuntimeDidNotConfirmRoomTermination.eed974": {
    "ru": "Runtime не подтвердил остановку комнаты",
    "en": "Kernel runtime did not confirm room termination"
  },
  "server.invalidKernelRuntimeHealthResponse.dc255b": {
    "ru": "Некорректный ответ проверки runtime ядра",
    "en": "Invalid kernel runtime health response"
  },
  "server.kernelRuntimeIsUnavailable.44455e": {
    "ru": "Runtime ядра недоступен",
    "en": "Kernel runtime is unavailable"
  },
  "server.invalidRuntimeRoomList.9cdcda": {
    "ru": "Некорректный список комнат runtime",
    "en": "Invalid runtime room list"
  },
  "server.kernelRuntimeIsNotConfiguredSetKernel.4598c3": {
    "ru": "Runtime ядра не настроен: задайте KERNEL_RUNTIME_URL",
    "en": "Kernel runtime is not configured: set KERNEL_RUNTIME_URL"
  },
  "server.productionRequiresKernelRuntimeTokenFile.6f556a": {
    "ru": "В production требуется KERNEL_RUNTIME_TOKEN_FILE",
    "en": "Production requires KERNEL_RUNTIME_TOKEN_FILE"
  },
  "server.kernelImageCatalogIsNotConfiguredSet.60170e": {
    "ru": "Каталог образов ядра не настроен: задайте KERNEL_CATALOG_FILE",
    "en": "Kernel image catalog is not configured: set KERNEL_CATALOG_FILE"
  },
  "server.theSavedDefaultKernelEnvironmentIsInvalid.c7c72c": {
    "ru": "Сохранённое окружение ядра по умолчанию некорректно",
    "en": "The saved default kernel environment is invalid"
  },
  "server.colloqTheCommandWasRemovedFromThe.7c25e4": {
    "ru": "[colloq] {p0} — команда снята из очереди: {p1}.",
    "en": "[colloq] {p0}: the command was removed from the queue: {p1}."
  },
  "server.colloqRemovedFromTheQueue.649577": {
    "ru": "[colloq] из очереди снято {p0} {p1}: {p2}.",
    "en": "[colloq] removed {p0} {p1} from the queue: {p2}."
  },
  "server.jupyterRejectedTheServerCredentialsHttpCheck.9d96c8": {
    "ru": "Jupyter отверг учётные данные сервера (HTTP {p0}). JUPYTER_TOKEN должен совпадать с токеном, с которым поднят контейнер ядра.",
    "en": "Jupyter rejected the server credentials (HTTP {p0}). Check that the configured token matches the room kernel token."
  },
  "server.jupyterCouldNotCreateTheShellHttp.1a2d57": {
    "ru": "Jupyter не завёл оболочку (HTTP {p0}).",
    "en": "Jupyter could not create the shell (HTTP {p0})."
  },
  "server.jupyterCreatedAShellWithoutAName.f86302": {
    "ru": "Jupyter завёл оболочку без имени.",
    "en": "Jupyter created a shell without a name."
  },
  "server.jupyterCouldNotCloseTheShellHttp.2aef51": {
    "ru": "Jupyter не закрыл оболочку (HTTP {p0}).",
    "en": "Jupyter could not close the shell (HTTP {p0})."
  },
  "server.openingTheTerminalWasCancelledBecauseIt.783698": {
    "ru": "Открытие терминала отменено: терминал закрыли.",
    "en": "Opening the terminal was cancelled because it was closed."
  },
  "server.cannotConnectTheShellHasNoName.f64bd7": {
    "ru": "подключаться не к чему — у оболочки нет имени",
    "en": "cannot connect: the shell has no name"
  },
  "server.theShellChannelDidNotOpenWithin.dcc3b4": {
    "ru": "канал оболочки не открылся за {p0} с",
    "en": "the shell channel did not open within {p0} seconds"
  },
  "server.theShellChannelClosedBeforeOpening.45e62d": {
    "ru": "канал оболочки закрылся, не открывшись",
    "en": "the shell channel closed before opening"
  },
  "server.theShellExited.3948b2": {
    "ru": "оболочка вышла",
    "en": "the shell exited"
  },
  "server.colloqTheShellExitedSelectRestartShell.bc74b5": {
    "ru": "[colloq] Оболочка завершила работу. Нажмите «Перезапустить оболочку», чтобы создать новую.",
    "en": "[colloq] The shell exited. Select “Restart shell” to create a new one."
  },
  "server.theTerminalNoLongerExists.fe4ae0": {
    "ru": "терминала больше нет",
    "en": "the terminal no longer exists"
  },
  "server.theConnectionToTheSharedShellWas.94c77c": {
    "ru": "Связь с общей оболочкой потеряна. Нажмите «Перезапустить оболочку», чтобы создать новую.",
    "en": "The connection to the shared shell was lost. Select “Restart shell” to create a new one."
  },
  "server.couldNotOpenTheSharedShell.c33160": {
    "ru": "не удалось открыть общую оболочку — {p0}",
    "en": "could not open the shared shell: {p0}"
  },
  "server.couldNotConnectToTheSharedShell.5b8c9e": {
    "ru": "Не удалось подключиться к общей оболочке. Создайте новую оболочку.",
    "en": "Could not connect to the shared shell. Create a new shell."
  },
  "server.colloqTheCommandIsTooLongPut.50c546": {
    "ru": "[colloq] команда слишком длинная — положите её в файл и запустите файл.",
    "en": "[colloq] The command is too long. Put it in a file and run the file."
  },
  "server.colloqTooManyCommandsAreQueuedTry.76db34": {
    "ru": "[colloq] в очереди уже слишком много команд — повторите, когда оболочка освободится.",
    "en": "[colloq] Too many commands are queued. Try again when the shell is free."
  },
  "server.colloqTheCommandIsWaitingForThe.0e6b42": {
    "ru": "[colloq] {p0} — команда ждёт свободной оболочки.",
    "en": "[colloq] {p0}: the command is waiting for the shell."
  },
  "server.colloqTheCommandWasRemovedFromThe.1c9d79": {
    "ru": "[colloq] {p0} — команда снята из очереди.",
    "en": "[colloq] {p0}: the command was removed from the queue."
  },
  "server.colloqRemovedFromTheQueue.9a6da6": {
    "ru": "[colloq] из очереди снято {p0} {p1}.",
    "en": "[colloq] removed {p0} {p1} from the queue."
  },
  "server.colloqCtrlCIsStoppingTheCommand.3aead4": {
    "ru": "[colloq] Ctrl+C — команду останавливает {p0}.",
    "en": "[colloq] Ctrl+C: {p0} is stopping the command."
  },
  "server.colloqTheShellIsDisconnectedSoCtrl.885614": {
    "ru": "[colloq] связи с оболочкой сейчас нет, и Ctrl+C до неё ещё не дошёл — ",
    "en": "[colloq] The shell is disconnected, so Ctrl+C has not reached it yet. "
  },
  "server.itWillBeSentWhenTheTerminal.bdfcc3": {
    "ru": "он уйдёт, как только терминал переподключится.",
    "en": "It will be sent when the terminal reconnects."
  },
  "server.theTerminalWasClosed.5a818b": {
    "ru": "терминал закрыли",
    "en": "the terminal was closed"
  },
  "server.colloqTheTerminalIsClosed.9cf9fb": {
    "ru": "[colloq] терминал закрыт.",
    "en": "[colloq] The terminal is closed."
  },
  "server.theServerIsShuttingDown.79c391": {
    "ru": "сервер останавливается",
    "en": "the server is shutting down"
  },
  "server.truncated.fdb0c3": {
    "ru": "\n…(обрезано)",
    "en": "\n…(truncated)"
  },
  "server.notRestored.7d302f": {
    "ru": "{p0}Не восстановлены: {p1} — ",
    "en": "{p0}Not restored: {p1}. "
  },
  "server.theFilesWereChangedOrDeletedAfter.0aad9d": {
    "ru": "после действий оракула файлы были изменены или удалены.",
    "en": "The files were changed or deleted after the oracle's actions."
  },
  "server.couldNotReadTheArguments.375da2": {
    "ru": "не разобрал аргументы",
    "en": "could not read the arguments"
  },
  "server.theArgumentsAreNotValidJsonRetry.a91ada": {
    "ru": "Аргументы пришли не как JSON. Повторите вызов.",
    "en": "The arguments are not valid JSON. Retry the call."
  },
  "server.seminarFolder.8c9abd": {
    "ru": "папка занятия",
    "en": "class folder"
  },
  "server.invalidPath.4b91a9": {
    "ru": "путь не годится",
    "en": "invalid path"
  },
  "server.thisPathIsNotAllowedPathsAre.47da6e": {
    "ru": "Такой путь в этой комнате невозможен. Пути идут от корня папки занятия, без «..».",
    "en": "This path is not allowed. Paths are relative to the class folder and cannot contain “..”."
  },
  "server.notATextFile.51f9b2": {
    "ru": "это не текстовый файл",
    "en": "not a text file"
  },
  "server.isNotATextFileAndCannot.e4e032": {
    "ru": "{p0} — не текстовый файл, прочитать его нельзя.",
    "en": "{p0} is not a text file and cannot be read."
  },
  "server.onlyTheBeginning.cac2a9": {
    "ru": "только начало",
    "en": "only the beginning"
  },
  "server.theRestWasNotRead.2d3e0c": {
    "ru": "{p0}\n…(дальше не читал)\n\n{p1}",
    "en": "{p0}\n…(the rest was not read)\n\n{p1}"
  },
  "server.nothingToRead.8741a9": {
    "ru": "нечего читать",
    "en": "nothing to read"
  },
  "server.doesNotExistOrIsNotA.e25c4a": {
    "ru": "Файла {p0} нет или он не текст.",
    "en": "{p0} does not exist or is not a text file."
  },
  "server.lines.d3c334": {
    "ru": "{p0} строк",
    "en": "{p0} lines"
  },
  "server.onlyTheTeacherMayEditFilesHere.7af6f1": {
    "ru": "файлы здесь правит преподаватель",
    "en": "only the teacher may edit files here"
  },
  "server.onlyTheTeacherMayEditFilesIn.067d2a": {
    "ru": "На этом занятии файлы правит преподаватель, а ход идёт вашими руками — записать {p0} я не могу. ",
    "en": "Only the teacher may edit files in this class. This action uses your permissions, so I cannot write {p0}. "
  },
  "server.explainWhatShouldBeChangedInIt.b5147e": {
    "ru": "Скажите словами, что в нём поменять.",
    "en": "Explain what should be changed in it."
  },
  "server.thisIsARoomNotebook.50864d": {
    "ru": "это тетрадь комнаты",
    "en": "this is a room notebook"
  },
  "server.isARoomNotebookItsCellsLive.c322d1": {
    "ru": "{p0} — тетрадь комнаты: её ячейки живут в комнате, а файл только их отпечаток, ",
    "en": "{p0} is a room notebook: its cells live in the room and the file is only their projection, "
  },
  "server.soOverwritingItWouldBeLostShortly.f6c799": {
    "ru": "и запись поверх него пропала бы через полторы секунды. Скриптом — ровно то же самое: ",
    "en": "so overwriting it would be lost shortly. This also applies to scripts: "
  },
  "server.theRoomDoesNotReadChangesFrom.df48b1": {
    "ru": "комната файлы тетрадей не читает. ",
    "en": "the room does not read changes from notebook files. "
  },
  "server.editTheCellsUseReadNotebookThen.e64989": {
    "ru": "Правьте ячейки: read_notebook, дальше edit_cell, add_cell, remove_cell.",
    "en": "Edit the cells: use read_notebook, then edit_cell, add_cell, or remove_cell."
  },
  "server.youCanViewItWithReadNotebook.a0da1e": {
    "ru": "Посмотреть её можно через read_notebook; править ячейки в этой комнате ",
    "en": "You can view it with read_notebook; editing cells in this room "
  },
  "server.isNotAllowedForYouExplainWhat.1333b4": {
    "ru": "вам нельзя — скажите словами, что в ней поменять.",
    "en": "is not allowed for you. Explain what should be changed."
  },
  "server.fileTooLarge.83ae5f": {
    "ru": "файл слишком большой",
    "en": "file too large"
  },
  "server.isNotATextFileAndCannot.c00c49": {
    "ru": "{p0} — не текстовый файл, править его нельзя.",
    "en": "{p0} is not a text file and cannot be edited."
  },
  "server.theFileChangedDuringTheOperation.ea0571": {
    "ru": "файл изменился под руками",
    "en": "the file changed during the operation"
  },
  "server.canNoLongerBeReadInFull.90290a": {
    "ru": "{p0} только что перестал читаться целиком — похоже, в него пишет кто-то ещё. ",
    "en": "{p0} can no longer be read in full; another writer may be changing it. "
  },
  "server.readItAgainOrExplainWhatShould.5109a7": {
    "ru": "Посмотрите его заново или скажите словами, что в нём поменять.",
    "en": "Read it again or explain what should be changed."
  },
  "server.nothingToWrite.bee7a2": {
    "ru": "нечего записывать",
    "en": "nothing to write"
  },
  "server.contentMustBeAString.4670e8": {
    "ru": "`content` должен быть строкой.",
    "en": "`content` must be a string."
  },
  "server.nothingToEdit.1a3cb2": {
    "ru": "нечего править",
    "en": "nothing to edit"
  },
  "server.emptySearch.b04728": {
    "ru": "пустой поиск",
    "en": "empty search"
  },
  "server.findCannotBeEmpty.7314f5": {
    "ru": "`find` не может быть пустым.",
    "en": "`find` cannot be empty."
  },
  "server.textNotFound.0daf2b": {
    "ru": "не нашёл этот кусок",
    "en": "text not found"
  },
  "server.thatTextIsNotInReadThe.0f7d35": {
    "ru": "В {p0} нет такого текста. Прочитайте файл и повторите с точным куском.",
    "en": "That text is not in {p0}. Read the file and retry with an exact match."
  },
  "server.textAppearsMoreThanOnce.cb7a0e": {
    "ru": "кусок встречается дважды",
    "en": "text appears more than once"
  },
  "server.thatTextAppearsMoreThanOnceIn.3d90f9": {
    "ru": "Такой текст встречается в {p0} больше одного раза — непонятно, какой менять. ",
    "en": "That text appears more than once in {p0}; the intended occurrence is ambiguous. "
  },
  "server.useALongerMatchingFragment.48a5a8": {
    "ru": "Возьмите кусок подлиннее.",
    "en": "Use a longer matching fragment."
  },
  "server.tooMuchContentToSave.c88960": {
    "ru": "столько не сохранится",
    "en": "too much content to save"
  },
  "server.cannotWriteMoreThanMbToThe.236b64": {
    "ru": "В {p0} нельзя записать больше полутора мегабайт: такой файл ни открыть, ни ",
    "en": "Cannot write more than 1.5 MB to {p0}: the file would be too large to open or "
  },
  "server.editReduceItsSizeOrWriteIt.287901": {
    "ru": "поправить. Оставьте в нём меньше — или пусть его пишет скрипт.",
    "en": "edit. Reduce its size or write it with a script."
  },
  "server.couldNotCreate.c6f8bf": {
    "ru": "не удалось завести",
    "en": "could not create"
  },
  "server.couldNotCreate.703abe": {
    "ru": "Не получилось создать {p0}.",
    "en": "Could not create {p0}."
  },
  "server.couldNotWrite.610d26": {
    "ru": "не удалось записать",
    "en": "could not write"
  },
  "server.couldNotWrite.09a8f1": {
    "ru": "Не получилось записать {p0}.",
    "en": "Could not write {p0}."
  },
  "server.done.97d5c8": {
    "ru": "Готово: {p0}, +{p1} −{p2}.",
    "en": "Done: {p0}, +{p1} −{p2}."
  },
  "server.onlyTheTeacherMayRunCode.59bbe2": {
    "ru": "запускает преподаватель",
    "en": "only the teacher may run code"
  },
  "server.onlyTheTeacherMayRunCodeIn.fbd734": {
    "ru": "На этом занятии запускает преподаватель, а ход идёт вашими руками — {p0} я не запущу. ",
    "en": "Only the teacher may run code in this class. This action uses your permissions, so I cannot run {p0}. "
  },
  "server.explainWhatShouldBeCheckedInYour.9855be": {
    "ru": "Скажите в ответе, что стоило бы проверить.",
    "en": "Explain what should be checked in your reply."
  },
  "server.cannotRunThisFile.94cb27": {
    "ru": "нечем запускать",
    "en": "cannot run this file"
  },
  "server.isNotAScriptOnlyPyAnd.9d1397": {
    "ru": "{p0} — не скрипт. Запускаются .py и .sh.",
    "en": "{p0} is not a script. Only .py and .sh files can run."
  },
  "server.fileNotFound.f1ab8a": {
    "ru": "нет такого файла",
    "en": "file not found"
  },
  "server.fileDoesNotExist.5febf3": {
    "ru": "Файла {p0} нет.",
    "en": "File {p0} does not exist."
  },
  "server.terminalBusy.97ab05": {
    "ru": "терминал занят",
    "en": "terminal busy"
  },
  "server.anotherCommandIsRunningInTheRoom.89c451": {
    "ru": "В терминале комнаты сейчас идёт другая команда — свой запуск я в очередь не ставлю. ",
    "en": "Another command is running in the room terminal. I will not queue this run. "
  },
  "server.mentionThisInYourReplyOrTry.a9d49e": {
    "ru": "Скажите об этом в ответе или попробуйте ещё раз позже.",
    "en": "Mention this in your reply or try again later."
  },
  "server.didNotStartTheShellIsRunning.93c619": {
    "ru": "не начался: оболочка занята чужой командой, команда снята из очереди",
    "en": "did not start: the shell is running another command; this command was removed from the queue"
  },
  "server.exceededSeconds.cfeb9f": {
    "ru": "не уложился в {p0} с; {p1}",
    "en": "exceeded {p0} seconds; {p1}"
  },
  "server.unknownTool.2e118e": {
    "ru": "неизвестный инструмент",
    "en": "unknown tool"
  },
  "server.toolDoesNotExist.cbeb28": {
    "ru": "Инструмента {p0} нет.",
    "en": "Tool {p0} does not exist."
  },
  "server.noNotebookWithThatName.c07b5d": {
    "ru": "тетради с таким именем нет",
    "en": "no notebook with that name"
  },
  "server.roomNotebook.05515c": {
    "ru": "тетрадь комнаты",
    "en": "room notebook"
  },
  "server.isNotANotebookInThisRoom.fe1f0a": {
    "ru": "{p0} — не тетрадь этой комнаты.",
    "en": "{p0} is not a notebook in this room."
  },
  "server.open.0c252d": {
    "ru": " Открыты: {p0}.",
    "en": " Open: {p0}."
  },
  "server.thereAreNoOpenNotebooksInIt.b3a67e": {
    "ru": " Открытых тетрадей в ней нет вовсе.",
    "en": " There are no open notebooks in it."
  },
  "server.thisRoomHasNoOpenNotebook.1f9148": {
    "ru": "В этой комнате нет открытой тетради.",
    "en": "This room has no open notebook."
  },
  "server.theRoomNoLongerExists.dd5d47": {
    "ru": "комнаты больше нет",
    "en": "the room no longer exists"
  },
  "server.notebook.02497c": {
    "ru": "тетрадь",
    "en": "notebook"
  },
  "server.thisRoomNoLongerExists.a43862": {
    "ru": "Этой комнаты больше нет.",
    "en": "This room no longer exists."
  },
  "server.editACellByItsIdentifierNot.d19277": {
    "ru": "Ячейку правят по её имени, а не по номеру: номер меняется, имя нет.",
    "en": "Edit a cell by its identifier, not its position: positions change, identifiers do not."
  },
  "server.hasOutput.113f1b": {
    "ru": "вывод есть",
    "en": "has output"
  },
  "server.openToTheRoom.467c85": {
    "ru": "открыта комнате",
    "en": "open to the room"
  },
  "server.otherNotebooksInTheRoomUseThe.e01136": {
    "ru": "Ещё тетради в комнате: {p0} — тот же инструмент, с путём.",
    "en": "Other notebooks in the room: {p0}. Use the same tool with a path."
  },
  "server.cell.4d4b88": {
    "ru": "ячейка",
    "en": "cell"
  },
  "server.sourceMustBeAString.88cd6f": {
    "ru": "`source` должен быть строкой.",
    "en": "`source` must be a string."
  },
  "server.onlyTheTeacherMayEditCells.9b2337": {
    "ru": "ячейки правит преподаватель",
    "en": "only the teacher may edit cells"
  },
  "server.onlyTheTeacherMayEditThisSeminar.91645c": {
    "ru": "На этом занятии тетрадь принадлежит преподавателю — ячейки правит он. ",
    "en": "Only the teacher may edit this class's notebook cells. "
  },
  "server.explainWhatShouldBeChangedInYour.c7378b": {
    "ru": "Скажите в ответе, что в ней поменять.",
    "en": "Explain what should be changed in your reply."
  },
  "server.cell.47aead": {
    "ru": "{p0} · ячейка {p1}",
    "en": "{p0} · cell {p1}"
  },
  "server.alreadyMatches.2ef8ba": {
    "ru": "и так уже так",
    "en": "already matches"
  },
  "server.alreadyContainsExactlyThisText.adb3e8": {
    "ru": "В {p0} уже ровно этот текст.",
    "en": "{p0} already contains exactly this text."
  },
  "server.edited.3ca212": {
    "ru": "правил",
    "en": "edited"
  },
  "server.itsExistingOutputIsNowStale.da45eb": {
    "ru": " Вывод у неё прежний — теперь устаревший.",
    "en": " Its existing output is now stale."
  },
  "server.done.ac3049": {
    "ru": "Готово: {p0}, +{p1} −{p2}.{p3}",
    "en": "Done: {p0}, +{p1} −{p2}.{p3}"
  },
  "server.chooseACellType.e7d810": {
    "ru": "какой вид ячейки",
    "en": "choose a cell type"
  },
  "server.typeMustBeCodeOrMarkdown.74ff56": {
    "ru": "`type` — «code» или «markdown».",
    "en": "`type` must be “code” or “markdown”."
  },
  "server.onlyTheTeacherMayAddCells.264967": {
    "ru": "ячейки добавляет преподаватель",
    "en": "only the teacher may add cells"
  },
  "server.onlyTheTeacherMayAddCellsIn.423ddc": {
    "ru": "На этом занятии ячейки добавляет преподаватель. Скажите в ответе, что дописать.",
    "en": "Only the teacher may add cells in this class. Explain what to add in your reply."
  },
  "server.added.bd3124": {
    "ru": "добавил",
    "en": "added"
  },
  "server.doneIdentifier.d397dc": {
    "ru": "Готово: {p0}, имя {p1}.",
    "en": "Done: {p0}, identifier {p1}."
  },
  "server.onlyTheTeacherMayRemoveCells.d98982": {
    "ru": "ячейки убирает преподаватель",
    "en": "only the teacher may remove cells"
  },
  "server.onlyTheTeacherMayRemoveCellsIn.6cf98f": {
    "ru": "На этом занятии ячейки убирает преподаватель. Скажите в ответе, какая лишняя.",
    "en": "Only the teacher may remove cells in this class. Explain which cell to remove."
  },
  "server.theCellIsRunning.ff6251": {
    "ru": "ячейка сейчас считается",
    "en": "the cell is running"
  },
  "server.isQueuedForTheKernelSoI.d94674": {
    "ru": "{p0} сейчас в очереди на ядро — на ходу я её не убираю. Скажите об этом в ответе.",
    "en": "{p0} is queued for the kernel, so I will not remove it now. Mention this in your reply."
  },
  "server.removed.5c90bd": {
    "ru": "убрал",
    "en": "removed"
  },
  "server.cellRemoved.d30a05": {
    "ru": "ячейка убрана",
    "en": "cell removed"
  },
  "server.removedFollowingCellPositionsChangedIdentifiersDid.365725": {
    "ru": "Убрал {p0}. Номера ячеек ниже сдвинулись — имена нет.",
    "en": "Removed {p0}. Following cell positions changed; identifiers did not."
  },
  "server.cellNotFound.418523": {
    "ru": "нет такой ячейки",
    "en": "cell not found"
  },
  "server.cellIsNotInTheRoomGet.861a57": {
    "ru": "Ячейки {p0} в комнате нет. Имена ячеек показывает read_notebook — ",
    "en": "Cell {p0} is not in the room. Get cell identifiers from read_notebook; "
  },
  "server.theNumberOnTheScreenIsNot.1bea60": {
    "ru": "возьмите оттуда, номер на экране именем не является.",
    "en": "the number on the screen is not an identifier."
  },
  "server.nothingToBackUp.06ac82": {
    "ru": "нечего отложить",
    "en": "nothing to back up"
  },
  "server.cannotBeReadAsANotebookSo.d3da28": {
    "ru": "{p0} не читается как тетрадь — отложить копию до правки не с чего, ",
    "en": "{p0} cannot be read as a notebook, so a backup before editing cannot be made. "
  },
  "server.iWillNotEditItWithoutA.3b0423": {
    "ru": "а без точки возврата я её не трогаю.",
    "en": "I will not edit it without a recovery point."
  },
  "server.couldNotSaveABackup.382cce": {
    "ru": "не отложил копию",
    "en": "could not save a backup"
  },
  "server.couldNotSaveABackupCopyOf.73e179": {
    "ru": "Не удалось положить рядом копию {p0}, а историей версий эта тетрадь не ",
    "en": "Could not save a backup copy of {p0}, and this notebook cannot be restored "
  },
  "server.throughVersionHistoryIWillNotEdit.292ce9": {
    "ru": "возвращается — без точки возврата я её не правлю. Скажите словами, что в ней поменять.",
    "en": "through version history. I will not edit it without a recovery point. Explain what should change."
  },
  "server.couldNotMarkHistory.6777c1": {
    "ru": "не отметил историю",
    "en": "could not mark history"
  },
  "server.couldNotCreateANotebookHistoryCheckpoint.1934aa": {
    "ru": "Не удалось отметить тетрадь в истории версий, а без точки возврата я её не правлю. ",
    "en": "Could not create a notebook history checkpoint. I will not edit it without a recovery point. "
  },
  "server.explainWhatShouldBeChanged.1d6c33": {
    "ru": "Скажите словами, что в ней поменять.",
    "en": "Explain what should be changed."
  },
  "server.fileWasChangedOutsideTheRoomThe.52b9a3": {
    "ru": "Файл {p0} переписан мимо комнаты, и комната его не читает: ячейки живут в ",
    "en": "File {p0} was changed outside the room. The room will not read it: cells live in "
  },
  "server.theRoomWhileTheIpynbFileIs.32a058": {
    "ru": "ней, а .ipynb — только их проекция, которую она перепишет своим через полторы секунды. ",
    "en": "the room, while the .ipynb file is a projection that will soon be overwritten. "
  },
  "server.noneOfTheFileEditsWereApplied.3184da": {
    "ru": "Ничего из записанного в файл не применилось. Применяется это единственным способом — ",
    "en": "None of the file edits were applied. The only supported way to edit cells is "
  },
  "server.editCellAddCellOrRemoveCell.377bc1": {
    "ru": "edit_cell, add_cell, remove_cell; если ими нельзя, скажите в ответе, что тетрадь осталась ",
    "en": "edit_cell, add_cell, or remove_cell. If those are unavailable, say that the notebook remains "
  },
  "server.unchanged.4b21b7": {
    "ru": "прежней.",
    "en": "unchanged."
  },
  "server.edited.002cbd": {
    "ru": "поправил {p0}",
    "en": "edited {p0}"
  },
  "server.removed.c6e6b3": {
    "ru": "убрал {p0} {p1}",
    "en": "removed {p0} {p1}"
  },
  "server.editedCellsRetainTheirPreviousOutputWhich.8ba614": {
    "ru": "Вывод у поправленных прежний и теперь устарел — перезапустите их. ",
    "en": "Edited cells retain their previous output, which is now stale. Run them again. "
  },
  "server.thisNotebookCannotBeRestoredThroughVersion.bae2c9": {
    "ru": "Историей версий эта тетрадь не возвращается — как было до хода, лежит рядом: {p0}.",
    "en": "This notebook cannot be restored through version history. Its previous copy is saved beside it: {p0}."
  },
  "server.thePreviousStateIsInVersionHistory.8a1cab": {
    "ru": "Как было до хода — в истории версий, отметка «{p0}».",
    "en": "The previous state is in version history under “{p0}”."
  },
  "server.fileWasOverwrittenByAScriptOutside.2bc573": {
    "ru": "Файл {p0} на ходу переписали мимо комнаты — скриптом. Комната файлы тетрадей не ",
    "en": "File {p0} was overwritten by a script outside the room. The room does not read notebook "
  },
  "server.filesSoNoCellsChangedTheNotebook.14b8b3": {
    "ru": "читает, и в ячейках от этой записи не изменилось ничего: тетрадь меняется только ",
    "en": "files, so no cells changed. The notebook can only be changed by "
  },
  "server.editingItsCells.2b51d4": {
    "ru": "правкой ячеек.",
    "en": "editing its cells."
  },
  "server.exceedsMbAndCannotBeReadIn.ca5347": {
    "ru": "{p0} больше полутора мегабайт: целиком он не читается, и переписывать его началом ",
    "en": "{p0} exceeds 1.5 MB and cannot be read in full. Overwriting it with only its beginning "
  },
  "server.wouldSilentlyLoseTheRestExplainWhat.e6b35a": {
    "ru": "нельзя — хвост пропал бы молча. Скажите словами, что с ним сделать, или обработайте его ",
    "en": "would silently lose the rest. Explain what to do or process it "
  },
  "server.withAScriptThroughRunFile.bc38de": {
    "ru": "скриптом через run_file.",
    "en": "with a script through run_file."
  },
  "server.theRunNeverStartedTheSharedShell.0e8c4b": {
    "ru": "Запуск так и не начался: оболочка комнаты всё это время была занята чужой командой, ",
    "en": "The run never started: the shared shell remained busy with another command, "
  },
  "server.whichIWillNotInterruptIRemoved.b5fa36": {
    "ru": "а прерывать её я не стану. Свою команду я снял из очереди — сама она не начнётся ни ",
    "en": "which I will not interrupt. I removed my command from the queue; it will not start "
  },
  "server.nowOrLaterExplainThatItCan.d2990b": {
    "ru": "сейчас, ни позже. Скажите об этом в ответе: запустить можно будет, когда оболочка ",
    "en": "now or later. Explain that it can be run when the shell is "
  },
  "server.free.f3ee5f": {
    "ru": "освободится.",
    "en": "free."
  },
  "server.runInterruptedTheActionWasStopped.e109df": {
    "ru": "Запуск прерван: ход остановили.",
    "en": "Run interrupted: the action was stopped."
  },
  "server.theRunExceededSecondsSoIInterrupted.8883fb": {
    "ru": "Не уложился в {p0} с — я прервал запуск (Ctrl+C). ",
    "en": "The run exceeded {p0} seconds, so I interrupted it with Ctrl+C. "
  },
  "server.outputReceivedSoFar.c13eff": {
    "ru": "Вывод до этого момента:\n{p0}",
    "en": "Output received so far:\n{p0}"
  },
  "server.exitCodeOutput.294a41": {
    "ru": "Код выхода {p0}. Вывод:\n{p1}",
    "en": "Exit code {p0}. Output:\n{p1}"
  },
  "server.theCommandDidNotFinishTheTerminal.ef4676": {
    "ru": "Команда не доработала — терминал закрыли или оболочка умерла.",
    "en": "The command did not finish: the terminal closed or the shell exited."
  },
  "server.moreInSpecifyThePathIfNeeded.f75344": {
    "ru": "… ещё {p0} в {p1} — скажите путь, если нужно",
    "en": "… {p0} more in {p1}; specify the path if needed"
  },
  "server.moreEntriesOmittedTheFolderIsToo.a62954": {
    "ru": "… и ещё {p0} записей ниже: папка слишком велика, чтобы показать её целиком",
    "en": "… {p0} more entries omitted: the folder is too large to show in full"
  },
  "server.theFolderIsEmpty.5c7445": {
    "ru": "Папка пуста.",
    "en": "The folder is empty."
  },
  "server.oracle.3156fd": {
    "ru": "оракул",
    "en": "oracle"
  },
  "server.stoppedCompletedActionsAreListedAboveStopping.2f9e57": {
    "ru": "Остановлено. Выполненные действия перечислены выше. Остановка не отменяет внесённые изменения.",
    "en": "Stopped. Completed actions are listed above. Stopping does not undo changes already made."
  },
  "server.theStepLimitWasReachedCompletedActions.6a7362": {
    "ru": "Достигнут лимит шагов. Выполненные действия перечислены выше. ",
    "en": "The step limit was reached. Completed actions are listed above. "
  },
  "server.sendANewRequestToContinue.960b90": {
    "ru": "Отправьте новый запрос, чтобы продолжить.",
    "en": "Send a new request to continue."
  },
  "server.theModelReturnedAnEmptyResponseTry.c365b1": {
    "ru": "Модель ответила пустым — попробуйте ещё раз.",
    "en": "The model returned an empty response. Try again."
  },
  "server.theOracleDidNotRespondCheckThe.e430c5": {
    "ru": "Оракул не ответил — смотрите журнал сервера.",
    "en": "The oracle did not respond. Check the server logs."
  },
  "server.classOver": {
    "ru": "Занятие закончено — здесь теперь только читают",
    "en": "The class is over. This room is now read-only"
  },
  "server.classOverPeriod": {
    "ru": "Занятие закончено — здесь теперь только читают.",
    "en": "The class is over. This room is now read-only."
  },
  "server.ownBooksAreOff": {
    "ru": "Личные тетради в этом занятии не разрешены — их включает преподаватель в правилах",
    "en": "Personal notebooks are not allowed in this class — the teacher turns them on in the rules"
  },
  "server.ownBooksLimit": {
    "ru": "Своих тетрадей можно завести не больше {p0}. Уберите одну из своих, чтобы завести новую",
    "en": "You may have at most {p0} personal notebooks. Remove one of yours to start another"
  },
  "server.bookIsPersonal": {
    "ru": "Это личная тетрадь: {p0}. Править её могут автор и преподаватель",
    "en": "This notebook is personal: {p0}. Only its author and the teacher may edit it"
  },
  "server.bookIsPersonalMine": {
    "ru": "Это ваша личная тетрадь: работать в ней можете вы и преподаватель",
    "en": "This is your personal notebook: you and the teacher work in it"
  },
  "server.bookIsTheTeachers": {
    "ru": "Эта тетрадь преподавательская: печатает и запускает в ней он",
    "en": "This notebook is the teacher’s: they are the one who types and runs in it"
  },
  "server.bookIsOpenToAll": {
    "ru": "Эта тетрадь открыта всем: печатать и запускать в ней может любой",
    "en": "This notebook is open to everyone: anyone may type and run in it"
  },
  "server.councilSharedKernel": {
    "ru": "Решения выполняются по очереди в ядре этой тетради — у каждой тетради оно своё, — но каждое получает личные копии данных: таблицы, массивы, тензоры и списки после него остаются прежними. Новые переменные, созданные решением, удаляются после запуска, ядро завершить нельзя, а память решения ограничена. Общими остаются файлы и то, что не удалось скопировать, — о последнем решение читает в своём выводе. Не используйте этот режим для задач, требующих изолированного выполнения.",
    "en": "Solutions run one at a time in this notebook's kernel — every notebook has its own — but each one gets personal copies of the data: tables, arrays, tensors and lists are left as they were. New variables created by a solution are removed after execution, a solution cannot shut the kernel down, and its memory is capped. Files and anything that could not be copied stay shared — a solution is told about the last of these in its own output. Do not use this mode for tasks requiring isolated execution."
  },
  "server.kernel.ownUnavailable": {
    "ru": "На этом инстансе личные тетради пока без своего ядра — запуск в них недоступен",
    "en": "On this instance personal notebooks have no kernel of their own yet — running in them is unavailable"
  },
  "server.kernel.ownFull": {
    "ru": "Личных ядер в занятии уже {p0} — закройте неиспользуемые тетради или попросите преподавателя",
    "en": "The class already has {p0} personal kernels — close the notebooks you are not using, or ask the teacher"
  },
  "server.rules.ownMemoryRefused": {
    "ru": "Столько памяти личным тетрадям эта машина не даст — выберите число из списка",
    "en": "This machine cannot give personal notebooks that much memory — pick a number from the list"
  },
  "server.rules.ownCpusRefused": {
    "ru": "Столько ядер личным тетрадям эта машина не даст — выберите число из списка",
    "en": "This machine cannot give personal notebooks that many cores — pick a number from the list"
  },
  "server.kernel.ownIdle": {
    "ru": "Ядро этой тетради остановлено после {p0} мин простоя — переменные сброшены. Запустите ячейку, чтобы поднять его снова.",
    "en": "This notebook\u2019s kernel was stopped after {p0} min of idling — its variables are gone. Run a cell to bring it back."
  },
  "server.kernel.bookAccessChanged": {
    "ru": "Доступ к тетради изменился — её ядро перезапущено, переменные сброшены.",
    "en": "This notebook’s access changed — its kernel was restarted and its variables are gone."
  },
  "server.kernel.ownRecreated": {
    "ru": "Контейнер личных тетрадей пришлось пересоздать ({p0}). Переменные в личных тетрадях сброшены; файлы в панели не тронуты, запустите ячейки заново.",
    "en": "The container for personal notebooks had to be recreated ({p0}). Variables in personal notebooks are gone; the files in the Files panel are untouched, run your cells again."
  },
  "server.defaultNotebook": {
    "ru": "Тетрадь.ipynb",
    "en": "Notebook.ipynb"
  },
  "server.welcomeNotebook": {
    "ru": "# Добро пожаловать\n\nЭта тетрадь общая для всей группы. Преподаватель определяет, кто может редактировать её и запускать код.",
    "en": "# Welcome\n\nThis notebook is shared with the group. Your teacher controls who can edit and run code."
  },
  "server.kernel_word.off": {
    "ru": "не запущено",
    "en": "not running"
  },
  "server.kernel_word.starting": {
    "ru": "запускается",
    "en": "starting"
  },
  "server.kernel_word.restarting": {
    "ru": "перезапускается",
    "en": "restarting"
  },
  "server.kernel_word.idle": {
    "ru": "свободно",
    "en": "idle"
  },
  "server.kernel_word.busy": {
    "ru": "считает",
    "en": "running"
  },
  "server.kernel_word.dead": {
    "ru": "остановилось",
    "en": "stopped"
  },
  "server.shell_word.closed": {
    "ru": "не запущена",
    "en": "not started"
  },
  "server.shell_word.starting": {
    "ru": "запускается",
    "en": "starting"
  },
  "server.shell_word.idle": {
    "ru": "свободна",
    "en": "idle"
  },
  "server.shell_word.busy": {
    "ru": "занята",
    "en": "busy"
  },
  "server.shell_word.dead": {
    "ru": "остановилась",
    "en": "stopped"
  },
  "server.skip_reason_text.empty": {
    "ru": "в тетради на этот момент не было ни одной ячейки",
    "en": "the notebook had no cells at that point"
  },
  "server.skip_reason_text.broken": {
    "ru": "запись этого момента не читается",
    "en": "this version cannot be read"
  },
  "server.skip_reason_text.unnamed": {
    "ru": "момент остался без имени",
    "en": "the version has no name"
  },
  "server.skip_reason_text.duplicate": {
    "ru": "этот момент уже есть в списке",
    "en": "this version is already in the list"
  },
  "server.seconds": {
    "ru": {
      "one": "{count} секунду",
      "few": "{count} секунды",
      "many": "{count} секунд",
      "other": "{count} секунды"
    },
    "en": {
      "one": "{count} second",
      "other": "{count} seconds"
    }
  },
  "server.people": {
    "ru": {
      "one": "{count} человек",
      "few": "{count} человека",
      "many": "{count} человек",
      "other": "{count} человека"
    },
    "en": {
      "one": "{count} person",
      "other": "{count} people"
    }
  },
  "server.groupsWord": {
    "ru": {
      "one": "группа",
      "few": "группы",
      "many": "групп",
      "other": "группы"
    },
    "en": {
      "one": "group",
      "other": "groups"
    }
  },
  "server.cellsWord": {
    "ru": {
      "one": "ячейка",
      "few": "ячейки",
      "many": "ячеек",
      "other": "ячейки"
    },
    "en": {
      "one": "cell",
      "other": "cells"
    }
  },
  "server.commandWord": {
    "ru": {
      "one": "команда",
      "few": "команды",
      "many": "команд",
      "other": "команды"
    },
    "en": {
      "one": "command",
      "other": "commands"
    }
  },
  "server.historyCells": {
    "ru": {
      "one": "{count} ячейку",
      "few": "{count} ячейки",
      "many": "{count} ячеек",
      "other": "{count} ячейки"
    },
    "en": {
      "one": "{count} cell",
      "other": "{count} cells"
    }
  },
  "server.steps": {
    "ru": {
      "one": "{count} шаг",
      "few": "{count} шага",
      "many": "{count} шагов",
      "other": "{count} шага"
    },
    "en": {
      "one": "{count} step",
      "other": "{count} steps"
    }
  },
  "server.terminal.flood": {
    "ru": "[colloq] Превышена скорость обновления вывода. В общей расшифровке остаются только последние строки. Для полного вывода перенаправьте его в файл.",
    "en": "[colloq] Output is arriving too quickly. The shared transcript keeps only the latest lines. Redirect output to a file to keep it all."
  },
  "server.terminal.screen": {
    "ru": "[colloq] Полноэкранные программы (vim, top и другие) отображаются некорректно: терминал поддерживает только построчный вывод. Попробуйте прервать команду через Ctrl+C.",
    "en": "[colloq] Full-screen programs such as vim and top are not supported: this terminal displays line-by-line output. Try interrupting the command with Ctrl+C."
  },
  "server.terminal.clear": {
    "ru": "[colloq] очистка экрана здесь ничего не меняет: расшифровка общая. Стереть её может преподаватель — кнопкой «Очистить».",
    "en": "[colloq] Clearing the shell screen does not clear the shared transcript. The teacher can clear it with “Clear”."
  },
  "server.ownerAction.0": {
    "ru": "менять список преподавателей",
    "en": "change the staff list"
  },
  "server.ownerAction.1": {
    "ru": "сменить токен установки",
    "en": "rotate the setup token"
  },
  "server.ownerAction.2": {
    "ru": "прочитать ссылку входа",
    "en": "read a sign-in link"
  },
  "server.ownerAction.3": {
    "ru": "удалить окружение",
    "en": "delete an environment"
  },
  "server.ownerAction.4": {
    "ru": "собрать окружение",
    "en": "build an environment"
  },
  "server.ownerAction.5": {
    "ru": "сменить окружение",
    "en": "switch the environment"
  },
  "server.ownerAction.6": {
    "ru": "менять настройки оракула",
    "en": "change the oracle settings"
  },
  "server.ownerAction.7": {
    "ru": "проверить соединение с оракулом",
    "en": "test the oracle connection"
  },
  "server.ownerOnly": {
    "ru": "Только владелец может {action}",
    "en": "Only an owner can {action}"
  },
  "server.council.hintNeedsError": {
    "ru": "Подсказка даётся по упавшему запуску: запустите свой код и попросите снова",
    "en": "A hint needs a failed run: run your code, then ask again"
  },
  "server.council.hintNotInCouncil": {
    "ru": "Консилиум в этой ячейке закрыт",
    "en": "The council is closed in this cell"
  },
  "server.council.copyFailed": {
    "ru": "Не удалось подготовить личные копии переменных: {p0} — запуск не выполнен",
    "en": "Could not prepare personal copies of the variables: {p0} — the run did not happen"
  },
  "server.council.copyNoAnswer": {
    "ru": "ядро не подтвердило подготовку",
    "en": "the kernel did not confirm them"
  },
  "server.council.copyTooBig": {
    "ru": "[Colloq] Переменная `{p0}` ({p1}) слишком велика для личной копии — попытка работает с общей. Меняйте копию: {p0} = {p0}.copy()",
    "en": "[Colloq] Variable `{p0}` ({p1}) is too large to copy for this attempt — it works on the shared one. Change a copy instead: {p0} = {p0}.copy()"
  },
  "server.council.copyShared": {
    "ru": "[Colloq] Переменную `{p0}` не удалось скопировать — попытка работает с общей. Меняйте копию: {p0} = {p0}.copy()",
    "en": "[Colloq] Variable `{p0}` could not be copied — this attempt works on the shared one. Change a copy instead: {p0} = {p0}.copy()"
  },
  "server.council.copyMore": {
    "ru": {
      "one": "[Colloq] …и ещё {count} такая переменная.",
      "few": "[Colloq] …и ещё {count} такие переменные.",
      "many": "[Colloq] …и ещё {count} таких переменных.",
      "other": "[Colloq] …и ещё {count} такой переменной."
    },
    "en": {
      "one": "[Colloq] …and {count} more variable like it.",
      "other": "[Colloq] …and {count} more variables like it."
    }
  },
  "server.council.noExit": {
    "ru": "В попытке нельзя завершать ядро: оно общее для всей комнаты. Уберите exit() или quit().",
    "en": "An attempt may not shut the kernel down: the whole room shares it. Remove exit() or quit()."
  },
  "server.council.outOfMemory": {
    "ru": "[Colloq] Попытке не хватило памяти: ей было отведено {p0}. Ядро и данные остальных целы — уменьшите объём или считайте по частям.",
    "en": "[Colloq] The attempt ran out of memory: it was given {p0}. The kernel and everyone else's data are intact — use less or work in chunks."
  },
  "server.council.outOfMemoryPlain": {
    "ru": "[Colloq] Попытке не хватило памяти. Ядро и данные остальных целы — уменьшите объём или считайте по частям.",
    "en": "[Colloq] The attempt ran out of memory. The kernel and everyone else's data are intact — use less or work in chunks."
  },
  "server.council.threadsLeft": {
    "ru": {
      "one": "[Colloq] После попытки остался работать {count} поток — остановить его нечем, он продолжает считать в общем ядре.",
      "few": "[Colloq] После попытки остались работать {count} потока — остановить их нечем, они продолжают считать в общем ядре.",
      "many": "[Colloq] После попытки остались работать {count} потоков — остановить их нечем, они продолжают считать в общем ядре.",
      "other": "[Colloq] После попытки остались работать {count} потока — остановить их нечем, они продолжают считать в общем ядре."
    },
    "en": {
      "one": "[Colloq] {count} thread the attempt started is still running — nothing can stop it, and it keeps working in the shared kernel.",
      "other": "[Colloq] {count} threads the attempt started are still running — nothing can stop them, and they keep working in the shared kernel."
    }
  },
  "server.council.processesKilled": {
    "ru": {
      "one": "[Colloq] Дочерний процесс, оставшийся после попытки, остановлен.",
      "few": "[Colloq] Дочерние процессы, оставшиеся после попытки ({count}), остановлены.",
      "many": "[Colloq] Дочерние процессы, оставшиеся после попытки ({count}), остановлены.",
      "other": "[Colloq] Дочерние процессы, оставшиеся после попытки ({count}), остановлены."
    },
    "en": {
      "one": "[Colloq] A child process left over by the attempt was stopped.",
      "other": "[Colloq] {count} child processes left over by the attempt were stopped."
    }
  },
  "server.council.sizeKb": {
    "ru": "{p0} КБ",
    "en": "{p0} kB"
  },
  "server.council.sizeMb": {
    "ru": "{p0} МБ",
    "en": "{p0} MB"
  },
  "server.council.sizeGb": {
    "ru": "{p0} ГБ",
    "en": "{p0} GB"
  },
  "server.stoppedTheRunTookLongerThanThe.87bfc0": {
    "ru": "Остановлено: запуск шёл дольше {p0}. Предел задаёт преподаватель — ядро одно на всю комнату.",
    "en": "Stopped: the run took longer than {p0}. The teacher sets the limit — the kernel is shared by the whole room."
  },
  "server.yourNextRunIsInTheTeacher.95d4f8": {
    "ru": "Следующий запуск — через {p0}. Паузу между запусками задаёт преподаватель.",
    "en": "Your next run is in {p0}. The teacher sets the pause between runs."
  },
  "server.duration.seconds": {
    "ru": "{p0} с",
    "en": "{p0} s"
  },
  "server.duration.minutes": {
    "ru": "{p0} мин",
    "en": "{p0} min"
  },
  "server.duration.minutesSeconds": {
    "ru": "{p0} мин {p1} с",
    "en": "{p0} min {p1} s"
  },
  "server.council.oracleName": {
    "ru": "Оракул",
    "en": "Oracle"
  },
  "server.council.noSheetsYet": {
    "ru": "В этой ячейке ещё никто ничего не написал — оракулу нечего читать.",
    "en": "Nobody has written anything in this cell yet — the oracle has nothing to read."
  },
  "server.council.statusQuestion": {
    "ru": "Как идут дела у класса: кто пишет, у кого падает запуск, кто застрял?",
    "en": "How is the class doing: who is writing, whose run is failing, who is stuck?"
  },
  "server.ai.linesWord": {
    "ru": {
      "one": "строка",
      "few": "строки",
      "many": "строк",
      "other": "строки"
    },
    "en": {
      "one": "line",
      "other": "lines"
    }
  },
  "server.ai.cellIsTheTeachers": {
    "ru": "В этой ячейке оракул только отвечает: менять её может преподаватель",
    "en": "In this cell the oracle only answers: the teacher changes it"
  },
  "server.ai.answerLanguage": {
    "ru": "По умолчанию отвечайте по-русски; если пользователь явно просит другой язык, используйте его.",
    "en": "Answer in English by default; if the user explicitly requests another language, use it."
  },
  "server.formatter.missing": {
    "ru": "В этом окружении не установлен black",
    "en": "black is not installed in this environment"
  },
  "server.image.49cd3c": {
    "ru": "картинка",
    "en": "image"
  },
  "server.onePage.d5f549": {
    "ru": "одна страница",
    "en": "one page"
  },
  "server.codeWithoutOutputs.e86524": {
    "ru": "Код без выводов",
    "en": "Code without outputs"
  },
  "server.codeFromTheLastStepWithoutOutputs.84324c": {
    "ru": "Код последнего шага, без выводов",
    "en": "Code from the last step, without outputs"
  },
  "server.codeFromThisStepWithoutOutputs.e310ab": {
    "ru": "Код этого шага, без выводов",
    "en": "Code from this step, without outputs"
  },
  "server.published.e49f01": {
    "ru": "опубликован {p0}",
    "en": "published {p0}"
  },
  "server.ssr.cellOutput": {
    "ru": "вывод ячейки",
    "en": "cell output"
  },
  "server.ssr.unsupportedOutput": {
    "ru": "вывод в формате {format} на странице не показывается",
    "en": "output in {format} format cannot be displayed on this page"
  },
  "server.ssr.notRun": {
    "ru": "не запускалась",
    "en": "not run"
  },
  "server.ssr.seminarDeleted": {
    "ru": "занятие удалено",
    "en": "class deleted"
  },
  "server.ssr.deletedReadable": {
    "ru": "занятие удалено, материалы доступны",
    "en": "class deleted; materials remain available"
  },
  "server.ssr.unpublished": {
    "ru": "ещё не опубликовано",
    "en": "not published yet"
  },
  "server.ssr.courseAbout": {
    "ru": "Здесь собраны занятия курса. Материалы доступны после публикации преподавателем.",
    "en": "This page collects the course classes. Materials become available when the teacher publishes them."
  },
  "server.ssr.moved": {
    "ru": "Страница переехала:",
    "en": "This page has moved:"
  },
  "server.ssr.withdrawn": {
    "ru": "Преподаватель снял эту страницу. Адрес остался прежним: если её вернут, ссылка снова заработает.",
    "en": "The teacher withdrew this page. Its address is unchanged: if it is republished, this link will work again."
  },
  "server.ssr.otherClasses": {
    "ru": "Остальные занятия курса:",
    "en": "Other classes in this course:"
  },
  "server.ssr.stepsHeading": {
    "ru": "Шаги занятия",
    "en": "Class steps"
  },
  "server.ssr.publishedNotebook": {
    "ru": "Опубликованные материалы тетради занятия.",
    "en": "Published materials from the class notebook."
  },
  "server.ssr.stepOutputs": {
    "ru": "Шаги выбрал преподаватель. Выводы сохранены на момент каждого шага и могут относиться к предыдущей версии кода.",
    "en": "The teacher selected these steps. Outputs are preserved as they were at each step and may belong to an earlier version of the code."
  },
  "server.ssr.privacy": {
    "ru": "Список участников не опубликован. Имена, указанные в ячейках и выводах, могут быть видны.",
    "en": "The participant list is not published. Names included in cells and outputs may still be visible."
  },
  "server.ssr.download": {
    "ru": "Скачать тетрадь (.ipynb)",
    "en": "Download notebook (.ipynb)"
  },
  "server.ssr.runLocally": {
    "ru": "{about} — чтобы запустить у себя.",
    "en": "{about}, ready to run locally."
  },
  "server.ownerAction.instanceLanguage": {
    "ru": "менять язык сервера",
    "en": "change the instance language"
  },
  "server.theModelReturnedAnEmptyResponse.826722": {
    "ru": "Модель вернула пустой ответ: «{p0}». ",
    "en": "The model returned an empty response: \"{p0}\". "
  },
  "server.answeredInMsAs.81b232": {
    "ru": "Получен ответ за {p0} мс от модели «{p1}».",
    "en": "Answered in {p0} ms as \"{p1}\"."
  },
  "server.deniedAccessCheckTheApiKeyAnd.302b39": {
    "ru": "{p0} отказал в доступе. Проверьте API-ключ и права аккаунта.",
    "en": "{p0} denied access. Check the API key and account permissions."
  },
  "server.answeredWithAServerErrorTryAgain.9430de": {
    "ru": "{p0} вернул ошибку сервера ({p1}). Повторите позже.",
    "en": "{p0} answered with a server error ({p1}). Try again later."
  },
  "server.refusedTheRequest.85f159": {
    "ru": "{p0} отклонил запрос ({p1}). {p2}",
    "en": "{p0} refused the request ({p1}). {p2}"
  },
  "server.returnedAModelRefusalForTheTest.74f8ac": {
    "ru": "{p0} вернул отказ модели на проверочный запрос.",
    "en": "{p0} returned a model refusal for the test request."
  },
  "server.didNotAnswerWithinSecondsIsIt.dcedf5": {
    "ru": "{p0} не ответил за {p1} с. Проверьте, запущен ли он и доступен ли из контейнера Colloq.",
    "en": "{p0} did not answer within {p1} seconds. Is it running, and reachable from the Colloq container?"
  },
  "server.couldNotReachCheckTheAddressA.a531ef": {
    "ru": "Не удалось подключиться к {p0}{p1}. Проверьте адрес: локальный провайдер должен быть доступен серверу, localhost внутри контейнера обычно не подходит.",
    "en": "Could not reach {p0}{p1}. Check the address — a local runtime needs a host the server can see, not localhost inside a container."
  },
  "server.returnedHttpForTheTestRequestAnd.2b8b64": {
    "ru": "{p0} вернул HTTP 404 на проверочный запрос; список моделей прочитать не удалось. Проверьте базовый URL и имя модели.",
    "en": "{p0} returned HTTP 404 for the test request, and the model list could not be read. Check the base URL and model name."
  },
  "server.refusedTheRequest.1dca50": {
    "ru": "{p0} отклонил запрос: {p1}",
    "en": "{p0} refused the request: {p1}"
  },
  "server.doesNotListListedModels.915980": {
    "ru": "В списке {p0} нет модели «{p1}». Доступные модели: {p2}{p3}.",
    "en": "{p0} does not list \"{p1}\". Listed models: {p2}{p3}."
  },
  "server.returnedAModelListButRejectedThe.2051f2": {
    "ru": "{p0} вернул список моделей, но отклонил проверочный запрос к «{p1}»{p2}. Успешный ответ модели не подтверждён.",
    "en": "{p0} returned a model list but rejected the test request for \"{p1}\"{p2}. A successful model response has not been verified."
  },
  "server.theAiEndpointReturnedHttpForAsk.56675a": {
    "ru": "Провайдер ИИ вернул HTTP 404 для «{p0}». Попросите администратора Colloq проверить адрес API и имя модели.",
    "en": "The AI endpoint returned HTTP 404 for \"{p0}\". Ask the Colloq administrator to check the endpoint address and model name."
  },
  "server.theAiEndpointRejectedTheRequestFor.2dad2f": {
    "ru": "Провайдер ИИ отклонил запрос к модели «{p0}»: {p1}",
    "en": "The AI endpoint rejected the request for model \"{p0}\": {p1}"
  },
  "server.theAiEndpointRejectedTheRequestFor.80fc8d": {
    "ru": "Провайдер ИИ отклонил запрос к модели «{p0}».",
    "en": "The AI endpoint rejected the request for model \"{p0}\"."
  },
  "server.theAiEndpointBrokeOffMidAnswer.d6573e": {
    "ru": "Ответ провайдера ИИ прервался: {p0}",
    "en": "The AI endpoint broke off mid-answer: {p0}"
  },
  "server.skippedBlackCouldNotParseTheCode.ba9c0d": {
    "ru": "Пропущено: {p0} — Black не смог разобрать код",
    "en": "{p0} skipped (Black could not parse the code)"
  },
  "server.skippedEditedWhileFormattingWasInProgress.6a01ab": {
    "ru": "Пропущено: {p0} — код изменился во время форматирования",
    "en": "{p0} skipped (edited while formatting was in progress)"
  },
  "server.formattedWithBlackColumns.105f9d": {
    "ru": "Форматирование Black, ширина {p0}: {p1}.",
    "en": "Formatted with black, {p0} columns: {p1}."
  },
  "server.anAttemptMayContainUpToCharacters.6a584e": {
    "ru": "Попытка — не длиннее {p0} знаков, ",
    "en": "An attempt may contain up to {p0} characters; "
  },
  "server.speakerNotesMayContainUpTo.bc3e46": {
    "ru": "речь к странице — {p0}.",
    "en": "speaker notes may contain up to {p0}."
  },
  "server.badEnvironmentName.cf94f0": {
    "ru": "Некорректное имя окружения: {p0}",
    "en": "bad environment name: {p0}"
  },
  "server.buildExited.e3b35b": {
    "ru": "Сборка завершилась с кодом {p0}",
    "en": "build exited {p0}"
  },
  "server.buildFailed.3e3a83": {
    "ru": "— сборка не удалась ({p0})",
    "en": "— build failed ({p0})"
  },
  "server.githubAnswered.ac167e": {
    "ru": "GitHub ответил {p0}.",
    "en": "GitHub answered {p0}."
  },
  "server.couldNotDownload.d09a9d": {
    "ru": "Не удалось скачать {p0} ({p1}).",
    "en": "Could not download {p0} ({p1})."
  },
  "server.thatFileIsLargerThanTheMb.1e9617": {
    "ru": "Размер файла превышает ограничение {p0} МБ.",
    "en": "That file is larger than the {p0} MB limit."
  },
  "server.colloqMoreCharactersCutHere.cfc854": {
    "ru": "{p0}… [colloq] здесь обрезано ещё {p1} символов",
    "en": "{p0}… [colloq] {p1} more characters cut here"
  },
  "server.colloqAttemptOutputStoppedAfterCharactersSave.97282a": {
    "ru": "\n[colloq] вывод попытки остановлен после {p0} знаков. Сохраните полный вывод в файл.\n",
    "en": "\n[colloq] Attempt output stopped after {p0} characters. Save the full output to a file.\n"
  },
  "server.colloqTheAttemptImageLimitWasReached.3d579d": {
    "ru": "\n[colloq] Достигнут лимит изображений для попытки. Остальные изображения не показаны.\n",
    "en": "\n[colloq] The attempt image limit was reached. Additional images are not shown.\n"
  },
  "server.moreFrames.6caf4c": {
    "ru": "... ещё {p0} кадров ...",
    "en": "... {p0} more frames ..."
  },
  "server.everyVariableIsGone.eff831": {
    "ru": "{p0} Все переменные сброшены{p1}.",
    "en": "{p0} Every variable is gone{p1}."
  },
  "server.runACellToStartAFresh.ffee95": {
    "ru": "{p0}{p1} Запустите ячейку, чтобы создать новое ядро.",
    "en": "{p0}{p1} Run a cell to start a fresh one."
  },
  "server.startingTheEnvironmentWaitingForTheKernel.df8f76": {
    "ru": "Запускается окружение {p0}. Ячейки выполнятся после готовности ядра.",
    "en": "Starting the {p0} environment. Waiting for the kernel before running cells."
  },
  "server.waitingForTheKernelAtCellsCannot.8019bf": {
    "ru": "Ожидание ядра по адресу {p0}. Ячейки не выполняются, пока оно не ответит.",
    "en": "Waiting for the kernel at {p0}. Cells cannot run until it responds."
  },
  "server.theRoomSPythonContainerHadTo.253b0b": {
    "ru": "Контейнер Python комнаты пришлось пересоздать ({p0}), поэтому все переменные потеряны. ",
    "en": "The room's Python container had to be rebuilt ({p0}), so every variable is gone. "
  },
  "server.theInterruptAlsoDroppedTheCellsQueued.cfbaff": {
    "ru": "При остановке из очереди также удалены ячейки: {p0}.",
    "en": "The interrupt also dropped the {p0} cells queued behind it."
  },
  "server.aCellFailedSoTheCellsQueued.bbcda8": {
    "ru": "В ячейке возникла ошибка. Не запущены следующие ячейки из очереди: {p0}.",
    "en": "A cell failed, so the {p0} cells queued behind it were not run."
  },
  "server.colloqInputIsNotSupportedInCouncil.fd07fb": {
    "ru": "[colloq] Ввод через input() в попытке консилиума не поддерживается. Подставлена пустая строка.\n",
    "en": "[colloq] input() is not supported in Council attempts. An empty string was supplied.\n"
  },
  "server.theCellRunningAtTheTimeWas.11ac96": {
    "ru": "{p0} Выполнявшаяся ячейка прервана, все переменные потеряны.",
    "en": "{p0} The cell running at the time was killed with it, and every variable is gone."
  },
  "server.formattingFailed.e1afc5": {
    "ru": "Форматирование не удалось: {p0}",
    "en": "Formatting failed: {p0}"
  },
  "server.jupyterAnswered.d1df44": {
    "ru": "Jupyter ответил {p0}",
    "en": "Jupyter answered {p0}"
  },
  "server.jupyterIsUnreachable.aa1e10": {
    "ru": "Jupyter недоступен: {p0}",
    "en": "Jupyter is unreachable: {p0}"
  },
  "server.jupyterRefusedThisServerSCredentialsHttp.d97e7c": {
    "ru": "Jupyter отклонил ключ сервера (HTTP {p0}). Проверьте соответствие настроенного ключа токену ядра комнаты.",
    "en": "Jupyter refused this server's credentials (HTTP {p0}). JUPYTER_TOKEN must match the token the Jupyter container was started with."
  },
  "server.noPythonKernelAfterSAtCheck.2f3e07": {
    "ru": "Ядро Python не ответило за {p0} с по адресу {p1} ({p2}). Проверьте запуск и доступность Jupyter.",
    "en": "No Python kernel after {p0}s at {p1} ({p2}). Check that the jupyter service is running and reachable."
  },
  "server.theKernelStartedButItsChannelAt.ec5fda": {
    "ru": "Ядро запустилось, но его канал по адресу {p0} не открылся ({p1}).",
    "en": "The kernel started but its channel at {p0} would not open ({p1})."
  },
  "server.couldNotSendTheCellToThe.b4abb1": {
    "ru": "Не удалось отправить ячейку ядру ({p0}).",
    "en": "Could not send the cell to the kernel ({p0})."
  },
  "server.jupyterRefusedTheInterruptHttp.5ac00f": {
    "ru": "Jupyter отклонил прерывание (HTTP {p0}).",
    "en": "Jupyter refused the interrupt (HTTP {p0})."
  },
  "server.jupyterRefusedTheRestartHttp.6b7f4a": {
    "ru": "Jupyter отклонил перезапуск (HTTP {p0}).",
    "en": "Jupyter refused the restart (HTTP {p0})."
  },
  "server.theKernelRestartedButItsChannelDid.4a7ee0": {
    "ru": "Ядро перезапустилось, но его канал не восстановился ({p0}).",
    "en": "The kernel restarted but its channel did not come back ({p0})."
  },
  "server.noChannelAfterS.203466": {
    "ru": "Канал не открылся за {p0} с",
    "en": "no channel after {p0}s"
  },
  "server.colloqOutputStoppedAfterCharactersSaveThe.cf6866": {
    "ru": "\n[colloq] Вывод остановлен после {p0} символов. Сохраните полный вывод в файл.\n",
    "en": "\n[colloq] output stopped after {p0} characters. Save the full output to a file.\n"
  },
  "server.colloqTheImageOutputLimitWasReached.a9f30a": {
    "ru": "\n[colloq] Достигнут лимит изображений {p0}. Остальные изображения не показаны. ",
    "en": "\n[colloq] The {p0} image output limit was reached. Additional images are not shown. "
  },
  "server.saveTheFigureToAFileOr.961b0e": {
    "ru": "Сохраните график в файл или уменьшите ",
    "en": "Save the figure to a file or reduce "
  },
  "server.itsSizeFigsizeDpi.24640a": {
    "ru": "его размер (figsize/dpi).\n",
    "en": "its size (figsize/dpi).\n"
  },
  "server.dockerStart.e0ac13": {
    "ru": "docker start: {p0}",
    "en": "docker start: {p0}"
  },
  "server.dockerRunFailed.0f4300": {
    "ru": "Запуск Docker не удался: {p0}{p1}",
    "en": "docker run failed: {p0}{p1}"
  },
  "server.couldNotReadThePublishedPortOf.07ca0a": {
    "ru": "Не удалось определить опубликованный порт {p0}",
    "en": "could not read the published port of {p0}"
  },
  "server.kernelRuntimeRefusedTheRequest.39c35d": {
    "ru": "Runtime ядра отклонил запрос ({p0})",
    "en": "Kernel runtime refused the request ({p0})"
  },
  "server.cannotReadTheKernelImageCatalog.c9c5bc": {
    "ru": "Не удалось прочитать каталог образов ядра: {p0}",
    "en": "Cannot read the kernel image catalog: {p0}"
  },
  "server.aPackageListIsAtMostKb.90ace1": {
    "ru": "Список пакетов должен быть не больше {p0} КБ.",
    "en": "A package list is at most {p0} KB."
  },
  "server.anEnvironmentCalledAlreadyExistsOpenIt.a64ba5": {
    "ru": "Окружение {p0} уже есть. Откройте его для изменения пакетов или выберите другое имя.",
    "en": "An environment called {p0} already exists. Open it to change its packages, or pick another name."
  },
  "server.theKernelDidNotComeBack.ffdde9": {
    "ru": "Ядро не запустилось: {p0}",
    "en": "The kernel did not come back: {p0}"
  },
  "server.aSeminarNameMustBeCharactersOr.c9d56a": {
    "ru": "Название занятия должно содержать не более {p0} символов",
    "en": "a class name must be {p0} characters or fewer"
  },
  "server.beforeBlocking.d2153d": {
    "ru": "до бана {p0}",
    "en": "before blocking {p0}"
  },
  "server.youHaveUsedAllOfYourOracle.7a4f7f": {
    "ru": {
      "one": "Вы использовали {count} вопрос оракулу за этот час на этом занятии",
      "few": "Вы использовали все {count} вопроса оракулу за этот час на этом занятии",
      "many": "Вы использовали все {count} вопросов оракулу за этот час на этом занятии",
      "other": "Вы использовали все {count} вопроса оракулу за этот час на этом занятии"
    },
    "en": {
      "one": "You have used your {count} oracle question for this hour in this class",
      "other": "You have used all {count} of your oracle questions for this hour in this class"
    }
  },
  "server.thisSeminarHasRoomForMbOf.66f8a7": {
    "ru": "Это занятие вмещает до {p0} МБ файлов, ",
    "en": "This class has room for {p0} MB of files "
  },
  "server.andExceedsThatLimitAskTheTeacher.1f472f": {
    "ru": "а {p0} превышает это ограничение. Попросите преподавателя освободить место.",
    "en": "and {p0} exceeds that limit. Ask the teacher to free up space."
  },
  "server.root.3f3351": {
    "ru": "корне",
    "en": "root"
  },
  "server.onlyTheTeacherMayClearTheTranscript.695583": {
    "ru": "Очистить расшифровку может преподаватель: она общая на всю комнату.",
    "en": "Only the teacher may clear the transcript: it is shared by the whole room."
  },
  "server.onlyTheTeacherMayCloseTheShared.c7ec17": {
    "ru": "Закрыть общую оболочку может преподаватель.",
    "en": "Only the teacher may close the shared shell."
  },
  "server.couldNotCloseTheTerminal.17d21d": {
    "ru": "Не удалось закрыть терминал.",
    "en": "Could not close the terminal."
  },
  "server.theMessageIsTooLongAndWas.e89d1c": {
    "ru": "Сообщение слишком длинное — оно не отправлено. ",
    "en": "The message is too long and was not sent. "
  },
  "server.theServerRestartedWhileTheAttemptWas.0dc824": {
    "ru": "Сервер перезапустился во время выполнения попытки. Вывод недоступен.",
    "en": "The server restarted while the attempt was running. Its output is unavailable."
  },
  "server.reconnectedToTheExistingKernelTheRunning.a20941": {
    "ru": "Подключение к прежнему ядру восстановлено. Выполнение ячейки прервано, потому что её вывод не удалось получить. Переменные сохранены.",
    "en": "Reconnected to the existing kernel. The running cell was interrupted because its output could not be received. Variables were not reset."
  },
  "server.kernelRestartedByEveryVariableIsGone.3322fd": {
    "ru": "Ядро перезапущено: {p0}. Все переменные сброшены, очередь очищена.",
    "en": "Kernel restarted by {p0}. Every variable is gone and the queue was dropped."
  },
  "server.kernelRestartedEveryVariableIsGoneAnd.38530e": {
    "ru": "Ядро перезапущено. Все переменные сброшены, очередь очищена.",
    "en": "Kernel restarted. Every variable is gone and the queue was dropped."
  },
  "server.theKernelDidNotComeBackAfter.cadaf5": {
    "ru": "Ядро не запустилось после перезапуска. Пока оно недоступно, код не выполняется.",
    "en": "The kernel did not come back after the restart. Nothing can run until it does."
  },
  "server.theSeminarKernelWasReplacedThePrevious.bacb22": {
    "ru": "Ядро занятия было пересоздано. Прежняя оболочка завершилась; откройте терминал заново.",
    "en": "The class kernel was replaced. The previous shell ended; open the terminal again."
  },
  "server.deletionCouldNotFinishBecauseTheKernel.c885fc": {
    "ru": "Не удалось завершить удаление: ядро не остановилось. Данные и файлы занятия сохранены. Повторите удаление.",
    "en": "Deletion could not finish because the kernel did not stop. The class data and files were kept. Retry deletion."
  },
  "server.deletionCouldNotFinishBecauseSomeFiles.81f721": {
    "ru": "Не удалось завершить удаление части файлов. Повторите удаление или попросите оператора проверить workspace.",
    "en": "Deletion could not finish because some files could not be removed. Retry deletion or ask the server operator to check the workspace."
  },
  "server.theSeminarCouldNotBeDeleted.e7f27d": {
    "ru": "Не удалось удалить занятие",
    "en": "the class could not be deleted"
  },
  "server.theServerRestartedCellsThatWereRunning.025fda": {
    "ru": "Сервер перезапустился. Выполнявшиеся и ожидавшие ячейки остановлены — запустите их снова, когда будете готовы.",
    "en": "The server restarted. Cells that were running or queued were put back to rest — run them again when you are ready."
  },
  "server.onlyTheHostOrWhoeverStartedThe.835184": {
    "ru": "Прервать ядро может преподаватель или тот, кто запустил выполняющуюся ячейку.",
    "en": "Only the host, or whoever started the running cell, can interrupt the kernel."
  },
  "server.couldNotInterruptTheKernel.ef82bf": {
    "ru": "Не удалось прервать ядро.",
    "en": "Could not interrupt the kernel."
  },
  "server.onlyTheHostCanRestartTheKernel.987dcb": {
    "ru": "Перезапустить ядро может только преподаватель.",
    "en": "Only the host can restart the kernel."
  },
  "server.couldNotRestartTheKernel.fc63d0": {
    "ru": "Не удалось перезапустить ядро.",
    "en": "Could not restart the kernel."
  },
  "server.couldNotSendThatToTheCell.b70cd9": {
    "ru": "Не удалось отправить ответ ячейке.",
    "en": "Could not send that to the cell."
  },
  "server.formattingCompleteNoChangesNeeded.0b35b3": {
    "ru": "Форматирование завершено. Изменения не нужны.",
    "en": "Formatting complete. No changes needed."
  },
  "server.couldNotFormatTheNotebook.a8322c": {
    "ru": "Не удалось отформатировать тетрадь.",
    "en": "Could not format the notebook."
  },
  "server.couldNotCompleteTheActionTryAgain.234540": {
    "ru": "Не удалось выполнить действие. Повторите попытку.",
    "en": "Could not complete the action. Try again."
  },
  "server.whateverWasQueuedWasDropped.752abc": {
    "ru": " Очередь очищена.",
    "en": " Whatever was queued was dropped."
  },
  "server.workspaceAccessRequiresAPathname.69ac15": {
    "ru": "Для доступа к workspace требуется путь",
    "en": "Workspace access requires a pathname"
  },
  "server.pathIsOutsideTheWorkspace.5d7c04": {
    "ru": "Путь находится вне workspace",
    "en": "Path is outside the workspace"
  },
  "server.invalidWorkspacePathname.e819a2": {
    "ru": "Некорректный путь workspace",
    "en": "Invalid workspace pathname"
  },
  "server.workspaceDescriptorTraversalIsUnavailable.be15fe": {
    "ru": "Защищённый доступ к workspace недоступен",
    "en": "Workspace descriptor traversal is unavailable"
  },
  "server.workspaceSymlinksAreForbidden.f2f20a": {
    "ru": "Символические ссылки в workspace запрещены",
    "en": "Workspace symlinks are forbidden"
  },
  "server.unsupportedWorkspaceOpenMode.1e9628": {
    "ru": "Неподдерживаемый режим открытия workspace",
    "en": "Unsupported workspace open mode"
  },
  "server.workspaceSpecialFilesAreForbidden.fc1802": {
    "ru": "Специальные файлы в workspace запрещены",
    "en": "Workspace special files are forbidden"
  },
  "server.expectedARegularWorkspaceFile.8a4343": {
    "ru": "Ожидается обычный файл workspace",
    "en": "Expected a regular workspace file"
  },
  "server.refusingToRemoveTheTrustedWorkspaceRoot.c003d1": {
    "ru": "Удалять корневой каталог workspace запрещено",
    "en": "Refusing to remove the trusted workspace root"
  },
  "server.theAnswerStoppedWhenTheServerRestarted.a8fefc": {
    "ru": "Ответ прервался при перезапуске сервера.",
    "en": "The answer stopped when the server restarted."
  },
  "server.private.wentWrong": {
    "ru": "Что-то пошло не так.",
    "en": "Something went wrong."
  },
  "server.private.omitted": {
    "ru": "(содержимое опущено, чтобы ход помещался в окно модели — прочитайте заново, если нужно)",
    "en": "(content omitted to fit the model context window; read it again if needed)"
  },
  "server.private.checkpoint": {
    "ru": "до правки оракула",
    "en": "before the oracle's edit"
  },
  "server.private.oracleRestart": {
    "ru": "Сервер перезапустился во время подготовки сводки. Повторите запрос.",
    "en": "The server restarted while preparing the summary. Try again."
  },
  /*
   * Имя копии файла. Отдельными ключами, а не одной строкой с подстановкой
   * всего имени: по-русски слово идёт в скобках после имени, по-английски —
   * без них, и собирать это условием в коде значит завести второе место, где
   * язык решают.
   */
  "server.files.copySuffix": {
    "ru": "(копия)",
    "en": "copy"
  },
  "server.files.copySuffixN": {
    "ru": "(копия {p0})",
    "en": "copy {p0}"
  },
  "server.files.copyFolder": {
    "ru": "Папки не дублируются — скопируйте нужные файлы по одному",
    "en": "Folders are not duplicated — copy the files you need one by one"
  },
  "server.files.copyTooBig": {
    "ru": "«{p0}» больше {p1} МБ — такой файл не дублируется",
    "en": "“{p0}” is larger than {p1} MB and cannot be duplicated"
  },
  "server.files.copyNoRoom": {
    "ru": "Это занятие вмещает до {p0} МБ файлов, и копия «{p1}» в них уже не помещается. Уберите лишнее или попросите преподавателя.",
    "en": "This class has room for {p0} MB of files, and a copy of “{p1}” no longer fits. Remove something or ask the teacher."
  },
  "server.askAgain": {
    "ru": {
      "one": "{spent}. Следующий вопрос можно задать через {count} минуту.",
      "few": "{spent}. Следующий вопрос можно задать через {count} минуты.",
      "many": "{spent}. Следующий вопрос можно задать через {count} минут.",
      "other": "{spent}. Следующий вопрос можно задать через {count} минуты."
    },
    "en": {
      "one": "{spent}. You can ask again in {count} minute.",
      "other": "{spent}. You can ask again in {count} minutes."
    }
  },
  "server.formattedCells": {
    "ru": {
      "one": "отформатирована {count} ячейка",
      "few": "отформатированы {count} ячейки",
      "many": "отформатировано {count} ячеек",
      "other": "отформатировано {count} ячейки"
    },
    "en": {
      "one": "{count} cell reformatted",
      "other": "{count} cells reformatted"
    }
  },
  "server.someOfThisTabSCachedChanges.47f300": {
    "ru": "Сервер не знает части того, что осталось в кэше этой вкладки, — она собирается заново.",
    "en": "Some of this tab's cached changes are unknown to the server. The document is being reloaded."
  },
  "server.councilIsClosedYourTextRemainsIn.b08319": {
    "ru": "Консилиум закрыт — текст остался у вас черновиком",
    "en": "Council is closed. Your text remains in your draft."
  },
  "server.pathsMayBeUpToLevelsDeep.8e0b25": {
    "ru": "Допустимая глубина пути — до {p0} уровней.",
    "en": "Paths may be up to {p0} levels deep."
  },
  "server.thisNotebookIsNoLongerInThe.513a76": {
    "ru": "Этой тетради в комнате больше нет.",
    "en": "This notebook is no longer in the room."
  },
  "server.somethingWentWrong.904441": {
    "ru": "Что-то пошло не так.",
    "en": "Something went wrong."
  },
  "server.contentOmittedToFitTheModelContext.ceca98": {
    "ru": "(содержимое опущено, чтобы ход помещался в окно модели — прочитайте заново, если нужно)",
    "en": "(content omitted to fit the model context window; read it again if needed)"
  },
  "server.beforeTheOracleSEdit.1570fe": {
    "ru": "до правки оракула",
    "en": "before the oracle's edit"
  },
  "server.theServerRestartedWhilePreparingTheSummary.fbc1f5": {
    "ru": "Сервер перезапустился во время подготовки сводки. Повторите запрос.",
    "en": "The server restarted while preparing the summary. Try again."
  },
  "server.youHaveUsedAllOracleQuestionsAllowed.3b66d9": {
    "ru": "Вы использовали все {p0} вопросов оракулу за час на этом занятии",
    "en": "You have used all {p0} oracle questions allowed per hour in this class"
  },
  "server.unknownError.af6321": {
    "ru": "Неизвестная ошибка",
    "en": "unknown error"
  },
  "server.onlyTheTeacherRunsCellsInThis.21ec54": {
    "ru": "На этом занятии ячейки запускает только преподаватель.",
    "en": "Only the teacher runs cells in this class."
  },
  "server.aiStopped": {
    "ru": "(остановлено)",
    "en": "(stopped)"
  },
  "server.agent.tool.listFiles": {
    "ru": "Показать все файлы и папки занятия с размерами.",
    "en": "List every file and folder of the class with sizes."
  },
  "server.agent.tool.readFile": {
    "ru": "Прочитать текстовый файл. Путь — от корня папки занятия. Большой файл читается страницами: offset — с какой строки, limit — сколько строк.",
    "en": "Read a text file. The path is relative to the class folder. A large file is read in pages: offset is the first line, limit is how many lines."
  },
  "server.agent.tool.writeFile": {
    "ru": "Записать файл целиком, заменив прежнее содержимое. Заводит файл, если его не было. Для точечной правки лучше edit_file: она не даёт случайно потерять то, чего вы не читали. Тетради (.ipynb) этим не пишут — для них create_notebook и инструменты ячеек.",
    "en": "Write a whole file, replacing what was there. Creates the file when it does not exist. For a small change prefer edit_file: it cannot quietly drop what you have not read. Notebooks (.ipynb) are not written this way — use create_notebook and the cell tools."
  },
  "server.agent.tool.editFile": {
    "ru": "Заменить один точный кусок текста в файле. `find` должен встречаться в файле ровно один раз.",
    "en": "Replace one exact piece of text in a file. `find` must appear in the file exactly once."
  },
  "server.agent.tool.runFile": {
    "ru": "Запустить скрипт (.py или .sh) в контейнере занятия и получить его вывод. Запуск виден всей комнате в терминале.",
    "en": "Run a script (.py or .sh) in the class container and get its output. The room sees the run in the terminal."
  },
  "server.agent.tool.createNotebook": {
    "ru": "Завести новую тетрадь комнаты по этому пути и открыть её всем. Единственный способ сделать тетрадь: файлом .ipynb она не заводится.",
    "en": "Create a new room notebook at this path and open it for everyone. This is the only way to make a notebook; writing an .ipynb file does not create one."
  },
  "server.agent.tool.readNotebook": {
    "ru": "Показать ячейки живой тетради: имя ячейки, вид, исходник, есть ли вывод. Правят тетрадь по этим именам, а не через файл .ipynb. Без пути — тетрадь комнаты; остальные её тетради названы в конце списка.",
    "en": "Show the cells of a live notebook: cell name, kind, source and whether it has output. Cells are edited by these names, not through the .ipynb file. Without a path this is the room notebook; the room's other notebooks are named at the end of the listing."
  },
  "server.agent.tool.runCell": {
    "ru": "Запустить одну ячейку кода на ядре комнаты и дождаться её вывода. Так проверяют код тетради; скрипты проверяют run_file.",
    "en": "Run one code cell on the room kernel and wait for its output. This is how notebook code is checked; scripts are checked with run_file."
  },
  "server.agent.tool.editCell": {
    "ru": "Заменить исходник ячейки целиком — в любой тетради комнаты. Имя ячейки — из read_notebook. Вывод остаётся прежним и становится устаревшим: назовите такие ячейки в ответе.",
    "en": "Replace a cell's source entirely, in any notebook of the room. The cell name comes from read_notebook. The existing output stays and becomes stale: name such cells in your reply."
  },
  "server.agent.tool.addCell": {
    "ru": "Добавить ячейку после указанной. Без `after` — в конец тетради по `path`, а без пути — в конец тетради комнаты.",
    "en": "Add a cell after the given one. Without `after` it goes to the end of the notebook named by `path`, and without a path to the end of the room notebook."
  },
  "server.agent.tool.removeCell": {
    "ru": "Убрать ячейку из тетради — из любой тетради комнаты.",
    "en": "Remove a cell from a notebook — from any notebook of the room."
  },
  "server.agent.arg.path": {
    "ru": "например src/model.py",
    "en": "for example src/model.py"
  },
  "server.agent.arg.offset": {
    "ru": "с какой строки читать, считая с нуля; отрицательное — с конца файла",
    "en": "the first line to read, counting from zero; a negative value reads from the end of the file"
  },
  "server.agent.arg.limit": {
    "ru": "сколько строк показать; без него — сколько поместится",
    "en": "how many lines to show; without it, as many as fit"
  },
  "server.agent.arg.find": {
    "ru": "текст, который надо заменить, дословно",
    "en": "the text to replace, verbatim"
  },
  "server.agent.arg.replace": {
    "ru": "чем заменить",
    "en": "what to replace it with"
  },
  "server.agent.arg.cellId": {
    "ru": "имя ячейки, например c_8f21ab3c",
    "en": "the cell name, for example c_8f21ab3c"
  },
  "server.agent.arg.source": {
    "ru": "весь новый исходник ячейки",
    "en": "the complete new source of the cell"
  },
  "server.agent.arg.after": {
    "ru": "имя ячейки, после которой встать",
    "en": "the name of the cell to stand after"
  },
  "server.agent.arg.bookPath": {
    "ru": "например Разбор.ipynb",
    "en": "for example Review.ipynb"
  },
  "server.agent.arg.newBookPath": {
    "ru": "путь новой тетради, например Разбор.ipynb; .ipynb допишется само",
    "en": "the path of the new notebook, for example Review.ipynb; the .ipynb suffix is added for you"
  },
  "server.agent.arg.from": {
    "ru": "с какой ячейки показывать, считая с единицы",
    "en": "the first cell to show, counting from one"
  },
  "server.agent.arg.count": {
    "ru": "сколько ячеек показать",
    "en": "how many cells to show"
  },
  "server.agent.arg.outputs": {
    "ru": "показать и выводы ячеек, а не только их наличие",
    "en": "show the cell outputs too, not only whether they exist"
  },
  "server.agent.linesShown": {
    "ru": "показаны строки {p0}–{p1} из {p2}",
    "en": "showing lines {p0}–{p1} of {p2}"
  },
  "server.agent.linesRest": {
    "ru": "дальше — read_file по {p0} с offset: {p1}",
    "en": "for the rest call read_file on {p0} with offset: {p1}"
  },
  "server.agent.cellsShown": {
    "ru": "Показаны ячейки {p0}–{p1} из {p2}. Дальше — read_notebook по {p3} с from: {p4}.",
    "en": "Showing cells {p0}–{p1} of {p2}. For the rest call read_notebook on {p3} with from: {p4}."
  },
  "server.agent.notebookIsNotAFile": {
    "ru": "{p0} — тетрадь, а тетрадь в этой комнате не файл: её ячейки живут в документе комнаты, и записанный .ipynb комната не прочитает. ",
    "en": "{p0} is a notebook, and in this room a notebook is not a file: its cells live in the room document, and an .ipynb written to disk is never read back. "
  },
  "server.agent.useCreateNotebook": {
    "ru": "Заведите её вызовом create_notebook по пути {p0}, а потом наполняйте ячейками.",
    "en": "Create it with create_notebook at the path {p0}, then fill it with cells."
  },
  "server.agent.askTeacherForNotebook": {
    "ru": "Заводить тетради в этой комнате может преподаватель — скажите словами, какая тетрадь нужна.",
    "en": "Only the teacher can create notebooks in this room — say in words which notebook is needed."
  },
  "server.agent.mayNotCreateNotebook": {
    "ru": "Заводить тетради здесь нельзя",
    "en": "Notebooks cannot be created here"
  },
  "server.agent.onlyTheTeacherCreatesNotebooks": {
    "ru": "Заводить тетради в этой комнате может только преподаватель. Опишите словами, какая тетрадь нужна и что в ней должно быть.",
    "en": "Only the teacher may create notebooks in this room. Describe in words which notebook is needed and what should be in it."
  },
  "server.agent.createNotebookFailed": {
    "ru": "Выберите другой путь или наполняйте ячейками ту тетрадь, что уже есть.",
    "en": "Choose another path, or fill the notebook that already exists."
  },
  "server.agent.notebookCreated": {
    "ru": "тетрадь заведена",
    "en": "notebook created"
  },
  "server.agent.createdNotebook": {
    "ru": "Готово: {p0} заведена и открыта всей комнате. Наполняйте её add_cell; убрать тетрадь может только преподаватель через дерево файлов.",
    "en": "Done: {p0} has been created and opened for the whole room. Fill it with add_cell; only the teacher can remove a notebook, through the file tree."
  },
  "server.agent.cellIsNotCode": {
    "ru": "ячейка не с кодом",
    "en": "not a code cell"
  },
  "server.agent.onlyCodeCellsRun": {
    "ru": "{p0} — не ячейка с кодом, запускать в ней нечего.",
    "en": "{p0} is not a code cell, so there is nothing to run."
  },
  "server.agent.cellAlreadyRunning": {
    "ru": "{p0} уже считается или стоит в очереди к ядру. Дождитесь её вывода — он появится в тетради — и не ставьте её второй раз.",
    "en": "{p0} is already running or queued for the kernel. Wait for its output — it appears in the notebook — and do not queue it again."
  },
  "server.agent.cellDidNotFinish": {
    "ru": "{p0} не досчиталась за {p1} с. Ячейка снята с очереди; посмотрите, нет ли в ней бесконечного цикла или ожидания ввода, и скажите об этом в ответе.",
    "en": "{p0} did not finish within {p1} s. The cell was taken out of the queue; check it for an endless loop or a wait for input, and say so in your reply."
  },
  "server.agent.cellRan": {
    "ru": "{p0} посчиталась.",
    "en": "{p0} finished."
  },
  "server.agent.cellFailed": {
    "ru": "{p0} упала — вывод ниже.",
    "en": "{p0} failed — its output is below."
  },
  "server.agent.noOutput": {
    "ru": "вывода нет",
    "en": "no output"
  },
  "server.agent.rerunWithRunCell": {
    "ru": " Перезапустить её можно вызовом run_cell.",
    "en": " You can re-run it with run_cell."
  },
  "server.agent.sameCall": {
    "ru": "Это тот же вызов с теми же аргументами — результат не изменится. Сделайте что-то другое или закончите ход итогом.",
    "en": "This is the same call with the same arguments, so the result will not change. Do something else or end the turn with a summary."
  },
  "server.agent.repeatedNote": {
    "ru": "повтор вызова",
    "en": "repeated call"
  },
  "server.agent.loopNote": {
    "ru": "вызов пошёл по кругу",
    "en": "the call went in circles"
  },
  "server.agent.loopStop": {
    "ru": "Один и тот же вызов с теми же аргументами повторился трижды подряд — ход остановлен, чтобы не ходить по кругу. Сделанное выше осталось сделанным. Отправьте новый запрос, уточнив, что нужно.",
    "en": "The same call with the same arguments repeated three times in a row, so the turn was stopped rather than looping. What was done above stands. Send a new request saying more precisely what is needed."
  },
  "server.agent.outOfTime": {
    "ru": "На один ход отведено {p0} мин, и они вышли. Сделанное выше осталось сделанным. Отправьте новый запрос, чтобы продолжить с этого места.",
    "en": "A single turn is allowed {p0} minutes and they have run out. What was done above stands. Send a new request to continue from here."
  },
  "server.agent.nudge": {
    "ru": "Продолжайте: вызовите инструмент или закончите ход итогом. Описание вызова словами ходом не считается.",
    "en": "Carry on: call a tool, or end the turn with a summary. Describing a call in prose does not count as making one."
  },
  "server.agent.saidNothing": {
    "ru": "Модель ничего не ответила: ни текста, ни вызова инструмента. Попробуйте повторить запрос; если повторяется — выберите другую модель в настройках Оракула.",
    "en": "The model answered with nothing at all: no text and no tool call. Try the request again; if it keeps happening, choose another model in the Oracle settings."
  },
  "server.agent.toolMissing": {
    "ru": "Инструмента {p0} нет. Есть эти: {p1}.",
    "en": "There is no tool called {p0}. These exist: {p1}."
  },
  "server.agent.badJsonArgs": {
    "ru": "Аргументы пришли не как JSON. У {p0} такая схема: {p1}. Повторите вызов, передав аргументы корректным JSON.",
    "en": "The arguments did not arrive as JSON. The schema of {p0} is: {p1}. Call it again with the arguments as valid JSON."
  },
  "server.agent.movedHead": {
    "ru": "Скрипт изменил файлы мимо инструментов: {p0}. Скажите об этом в ответе: комната видит такие правки только с ваших слов.",
    "en": "The script changed files outside the tools: {p0}. Say so in your reply: the room learns about such changes only from you."
  },
  "server.agent.movedDeleted": {
    "ru": "{p0} (удалён)",
    "en": "{p0} (deleted)"
  },
  "server.agent.movedRewritten": {
    "ru": "{p0} (переписан)",
    "en": "{p0} (rewritten)"
  },
  "server.agent.movedAdded": {
    "ru": "{p0} (заведён)",
    "en": "{p0} (created)"
  },
  "server.agent.andMore": {
    "ru": "и ещё {p0}",
    "en": "and {p0} more"
  },
  "server.agent.rewrotePastTheRoom": {
    "ru": "файл тетради переписан мимо комнаты",
    "en": "the notebook file was rewritten outside the room"
  },
  "server.agent.busyTurn": {
    "ru": "Оракул уже выполняет поручение в этой комнате. Дождитесь его конца или остановите его, а потом отправьте новое.",
    "en": "The oracle is already carrying out a request in this room. Wait for it to finish, or stop it, and then send a new one."
  },
  "server.agent.prompt.role": {
    "ru": "Вы — оракул Colloq, помощник на техническом занятии. Сейчас вас попросили не объяснить, а СДЕЛАТЬ.",
    "en": "You are the Colloq oracle, an assistant in a technical class. You have been asked not to explain, but to DO."
  },
  "server.agent.prompt.workFull": {
    "ru": "У вас есть папка занятия и инструменты к ней. Порядок работы обычный: посмотрите, что есть, прочитайте то, что собираетесь менять, поменяйте и проверьте.",
    "en": "You have the class folder and tools for it. Work in the usual order: look at what is there, read what you are about to change, change it and check it."
  },
  "server.agent.prompt.workNoRun": {
    "ru": "У вас есть папка занятия и инструменты к ней. Запускать в этой комнате вам нельзя — запускает преподаватель, — так что проверить написанное можно только чтением.",
    "en": "You have the class folder and tools for it. You may not run anything in this room — the teacher does that — so the only way to check your work is to read it."
  },
  "server.agent.prompt.workReadOnly": {
    "ru": "Папку занятия вам видно, но править файлы в этой комнате вам нельзя: это делает преподаватель. Читайте и говорите словами, что и где стоит поменять.",
    "en": "You can see the class folder, but you may not edit files in this room: the teacher does that. Read, and say in words what should change and where."
  },
  "server.agent.prompt.notebooksHead": {
    "ru": "Про тетради этой комнаты:",
    "en": "About this room's notebooks:"
  },
  "server.agent.prompt.notebooksAre": {
    "ru": "— Сейчас в комнате открыты: {p0}. Это живые тетради — то, что видит комната.",
    "en": "— Open in the room right now: {p0}. These are the live notebooks — what the room sees."
  },
  "server.agent.prompt.noNotebooks": {
    "ru": "— Открытых тетрадей в комнате сейчас нет.",
    "en": "— The room has no open notebooks right now."
  },
  "server.agent.prompt.cellsHaveNames": {
    "ru": "— У каждой ячейки есть имя (c_…), и адресуют ячейку только им: номер на экране меняется. Имена показывает read_notebook, он же — выводы, если попросить outputs.",
    "en": "— Every cell has a name (c_…) and a cell is addressed only by it: the number on screen shifts. read_notebook shows the names, and the outputs too when asked for them."
  },
  "server.agent.prompt.createNotebook": {
    "ru": "— Новая тетрадь заводится create_notebook: один вызов — файл, запись в комнате и открытая вкладка у всех.",
    "en": "— A new notebook is created with create_notebook: one call gives the file, the room record and an open tab for everyone."
  },
  "server.agent.prompt.askTeacherForNotebook": {
    "ru": "— Заводить тетради в этой комнате может преподаватель. Если нужна новая — скажите об этом словами.",
    "en": "— Only the teacher can create notebooks in this room. If a new one is needed, say so in words."
  },
  "server.agent.prompt.cellTools": {
    "ru": "— Править тетрадь можно этим: {p0} — и любую тетрадь комнаты, не только первую. Правки идут от имени того, кто попросил ход, и по его правам. Перед первой правкой тетради комнаты ход отмечает историю версий; у остальных тетрадей истории нет, и им ход кладёт рядом копию файла.",
    "en": "— The notebook is edited with these: {p0} — and any notebook of the room, not just the first. Edits are made in the name of whoever asked for the turn and under their rights. Before the first edit of the room notebook the turn marks version history; the other notebooks have no history, so the turn puts a copy of the file beside them."
  },
  "server.agent.prompt.staleOutput": {
    "ru": "— Вывод ячейки правка не стирает: он остаётся прежним и становится устаревшим. Назовите в ответе ячейки, которые поменяли, чтобы их перезапустили.",
    "en": "— Editing a cell does not clear its output: the output stays and becomes stale. Name the cells you changed in your reply so they get re-run."
  },
  "server.agent.prompt.noCellTools": {
    "ru": "— Ячейки в этой комнате правит человек: тому, кто попросил ход, менять тетрадь нельзя, и вам тем более. Если нужно поменять ячейку, скажите об этом словами в конце.",
    "en": "— In this room a person edits the cells: whoever asked for the turn may not change the notebook, and neither may you. If a cell should change, say so in words at the end."
  },
  "server.agent.prompt.howToCheck": {
    "ru": "— Код тетради проверяют ячейками (run_cell), скрипты — run_file. Не переписывайте код тетради в .py ради запуска: это вторая копия того же кода, и проверять её бессмысленно.",
    "en": "— Notebook code is checked by running cells (run_cell); scripts are checked with run_file. Do not copy notebook code into a .py file to run it: that is a second copy of the same code, and checking it proves nothing."
  },
  "server.agent.prompt.limitsHead": {
    "ru": "Границы, которые не обойти:",
    "en": "Limits that cannot be worked around:"
  },
  "server.agent.prompt.ipynbIsProjection": {
    "ru": "— Файл .ipynb — проекция тетради, а не тетрадь: запись в него НИЧЕГО не меняет в комнате, и через полторы секунды комната перепишет его своим. Это верно и для скрипта: json.dump, nbformat, open(...,\"w\") в run_file комната не прочитает.",
    "en": "— An .ipynb file is a projection of the notebook, not the notebook: writing to it changes NOTHING in the room, and a second and a half later the room overwrites it with its own. The same goes for scripts: json.dump, nbformat and open(...,\"w\") inside run_file are never read back."
  },
  "server.agent.prompt.noDelete": {
    "ru": "— Удалять файлы и папки нельзя. Совсем. Если файл лишний, скажите об этом.",
    "en": "— You may not delete files or folders. Not at all. If a file is in the way, say so."
  },
  "server.agent.prompt.runFiles": {
    "ru": "— Запускать можно только .py и .sh из папки занятия. Оболочки у вас нет.",
    "en": "— Only .py and .sh from the class folder can be run. You have no shell."
  },
  "server.agent.prompt.visible": {
    "ru": "— Всё, что вы делаете, видит вся комната; правки в файлах отменяются одной кнопкой под ходом.",
    "en": "— Everything you do is visible to the whole room; file edits are undone with one button under the turn."
  },
  "server.agent.prompt.howHead": {
    "ru": "Как делать ход:",
    "en": "How to take a turn:"
  },
  "server.agent.prompt.oneAtATime": {
    "ru": "— Один вызов за раз: сделайте вызов, прочитайте ответ, потом решайте, каким будет следующий.",
    "en": "— One call at a time: make the call, read the answer, then decide what the next one is."
  },
  "server.agent.prompt.doNotDescribe": {
    "ru": "— Не описывайте вызов прозой — делайте его. «Сейчас я заведу тетрадь» ходом не считается и не меняет ничего.",
    "en": "— Do not describe a call in prose — make it. \"Now I will create the notebook\" is not a turn and changes nothing."
  },
  "server.agent.prompt.stopRule": {
    "ru": "— Сделано — закончите итогом. Нельзя этими инструментами — закончите и скажите, чего не хватает. Отказавший вызов не повторяйте: тот же вызов с теми же аргументами ответит тем же.",
    "en": "— When it is done, end with a summary. When these tools cannot do it, end and say what is missing. Do not repeat a call that was refused: the same call with the same arguments gives the same answer."
  },
  "server.agent.prompt.houseRules": {
    "ru": "Правила этого занятия от преподавателя. Они про то, ЧТО делать и чего не касаться по существу, и не отменяют границ выше — те про устройство комнаты: {p0}",
    "en": "The teacher's rules for this class. They are about WHAT to do and what to leave alone on the merits, and they do not override the limits above, which are about how this room works: {p0}"
  },
  "server.agent.prompt.ending": {
    "ru": "Закончите коротким объяснением, что сделано и что это значит. Шаги не пересказывайте — они и так на экране. Три-четыре предложения.",
    "en": "End with a short explanation of what was done and what it means. Do not retell the steps: they are on screen already. Three or four sentences."
  },
  "server.agent.notebookIsNew": {
    "ru": "Этой тетради до хода не было — её завёл сам ход; возвращаться некуда, а убрать её может преподаватель через дерево файлов.",
    "en": "This notebook did not exist before the turn — the turn created it; there is nothing to restore, and the teacher can remove it through the file tree."
  },
  "server.agent.prompt.nowHead": {
    "ru": "Вот с чем работает комната прямо сейчас:",
    "en": "Here is what the room is working with right now:"
  },
  "server.tooManyParticipantsToPrune.7a1c2e": {
    "ru": "За один раз можно снять записи не больше чем {p0} участников.",
    "en": "At most {p0} participants can be pruned in one request."
  },
  "server.beforePruningTheThread.4b0d9f": {
    "ru": "до чистки треда оракула",
    "en": "before pruning the oracle thread"
  },
  "server.theOracleAnswersThoseWhoHaveBeen.91d4c0": {
    "ru": "Оракул отвечает тем, кто в комнате хотя бы пару минут. Попробуйте через {p0}.",
    "en": "The oracle answers people who have been in the room for a couple of minutes. Try again in {p0}."
  },
  "server.tooManyQuestionsFromYourAddress.5e2b8d": {
    "ru": "С вашего адреса за минуту задано слишком много вопросов. Подождите минуту.",
    "en": "Too many questions from your address in the last minute. Wait a minute."
  },
  "server.linkPreview.title": {
    "ru": "Colloq — одна ссылка на всё занятие",
    "en": "Colloq — one link for the whole class"
  },
  "server.linkPreview.description": {
    "ru": "Проводите лекции, пишите код вместе и разбирайте решения студентов. Ноутбук, слайды и задания — по одной ссылке, без регистрации для студентов.",
    "en": "Run lectures, write code together and review student work. Notebook, slides and tasks behind one link, no sign-up for students."
  },
  "server.linkPreview.roomDescription": {
    "ru": "Занятие в Colloq: общий ноутбук, слайды и задания по одной ссылке.",
    "en": "A class in Colloq: shared notebook, slides and tasks behind one link."
  },
  "server.memoryMustBeWholeMegabytes": {
    "ru": "Память комнаты задаётся целым числом мегабайт.",
    "en": "Room memory is set as a whole number of megabytes."
  },
  "server.memoryOutOfRange": {
    "ru": "Памяти комнате можно выдать от {p0} до {p1} МБ: меньше не поднимется ядро, больше не останется самой машине.",
    "en": "A room may be given between {p0} and {p1} MB: less and the kernel will not start, more and nothing is left for the machine itself."
  },
  "server.cpusMustBeWholeCores": {
    "ru": "Число ядер комнаты задаётся целым числом.",
    "en": "A room's core count is set as a whole number."
  },
  "server.cpusOutOfRange": {
    "ru": "Ядер комнате можно выдать от {p0} до {p1}: больше, чем есть на машине, не бывает.",
    "en": "A room may be given between {p0} and {p1} cores: there are no more on the machine."
  },
  "server.memoryIsStaffOnly": {
    "ru": "Память комнате назначает преподаватель.",
    "en": "Only staff can set a room's memory."
  },
  "server.linkPreview.imageAlt": {
    "ru": "Экран входа Colloq: «Вы входите в…», поле для имени и кнопка «Войти на занятие»",
    "en": "Colloq join screen: “You are entering…”, a name field and a “Join the class” button"
  }
}

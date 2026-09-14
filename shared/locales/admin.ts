import type {MessageCatalog} from '../i18n-types.js'

export const adminMessages: MessageCatalog = {
  "admin.resources.cpuLabel": {
    "ru": "Процессор, ядер",
    "en": "Processor, cores"
  },
  "admin.resources.cores": {
    "ru": "ядер",
    "en": "cores"
  },
  "admin.resources.useDefaultCpu": {
    "ru": "вернуть умолчание инстанса",
    "en": "back to the instance default"
  },
  "admin.resources.cpuHint": {
    "ru": "На машине {p0} ядер; по умолчанию {p1}. В Docker квота меняется сразу; в кластере — после перезапуска ядра. Перезапустите ядро, чтобы numpy и torch также использовали новое число потоков.",
    "en": "The machine has {p0} cores; the default is {p1}. Docker updates the quota immediately; the cluster applies it after a kernel restart. Restart the kernel so numpy and torch also use the new thread count."
  },
  "admin.seminar.settingsMenu": {
    "ru": "Настройки",
    "en": "Settings"
  },
  "admin.seminar.settingsSubtitle": {
    "ru": "права участников и ресурсы",
    "en": "participant permissions and resources"
  },
  "admin.resources.notSaved": {
    "ru": "Память не сохранилась.",
    "en": "The memory limit was not saved."
  },
  "admin.resources.notApplied": {
    "ru": "Занятие создано, но память осталась умолчанием окружения: изменить её можно в настройках занятия.",
    "en": "The class was created, but its memory stayed at the environment default: change it in the class settings."
  },
  "admin.resources.title": {
    "ru": "Ресурсы",
    "en": "Resources"
  },
  "admin.resources.description": {
    "ru": "Сколько машины достаётся ядру этой комнаты. Память можно поднять и во время занятия — ядро при этом не перезапускается.",
    "en": "How much of the machine this room's kernel gets. Memory can be raised mid-class; the kernel is not restarted."
  },
  "admin.resources.memoryLabel": {
    "ru": "Память ядра комнаты, ГБ",
    "en": "Memory for the room's kernel, GB"
  },
  "admin.resources.gb": {
    "ru": "ГБ",
    "en": "GB"
  },
  "admin.resources.useDefault": {
    "ru": "вернуть умолчание окружения",
    "en": "back to the environment default"
  },
  "admin.resources.hint": {
    "ru": "На машине {p0} ГБ, свободно {p1} ГБ; по умолчанию для окружения {p2} — {p3} ГБ.",
    "en": "The machine has {p0} GB, {p1} GB free; the default for environment {p2} is {p3} GB."
  },
  "admin.resources.thisEnvironment": {
    "ru": "этого окружения",
    "en": "this environment"
  },
  "admin.resources.overFree": {
    "ru": "Это больше, чем свободно на машине прямо сейчас. Ядро может не подняться — или поднимется, когда освободится соседняя комната.",
    "en": "That is more than the machine has free right now. The kernel may not start — or it will once a neighbouring room closes."
  },
  "admin.resources.envUsesGpu": {
    "ru": "выбранное окружение берёт карту",
    "en": "the chosen environment takes the card"
  },
  "admin.resources.envNoGpu": {
    "ru": "выбранное окружение карту не берёт",
    "en": "the chosen environment does not take the card"
  },
  "admin.resources.vramShared": {
    "ru": "Видеопамять делят все комнаты на карте, и она не ограничивается: задать её комнате нечем.",
    "en": "Video memory is shared by every room on the card and is not limited: there is nothing to set here."
  },
  "admin.resources.moreCards": {
    "ru": " и ещё {p0}",
    "en": " and {p0} more"
  },
  "admin.resources.reading": {
    "ru": "Читаем ресурсы машины",
    "en": "Reading the machine's resources"
  },
  "admin.resources.unreadable": {
    "ru": "Не удалось прочитать ресурсы машины.",
    "en": "Could not read the machine's resources."
  },
  "admin.resources.asDefault": {
    "ru": "по умолчанию",
    "en": "default"
  },
  "admin.teaching": {
    "ru": "Преподавание",
    "en": "Teaching"
  },
  "admin.instance": {
    "ru": "Инстанс",
    "en": "Instance"
  },
  "admin.sign.out": {
    "ru": "Выйти",
    "en": "Sign out"
  },
  "admin.seminars": {
    "ru": "Занятия",
    "en": "Classes"
  },
  "admin.courses": {
    "ru": "Курсы",
    "en": "Courses"
  },
  "admin.environments": {
    "ru": "Окружения",
    "en": "Environments"
  },
  "admin.oracle": {
    "ru": "Оракул",
    "en": "Oracle"
  },
  "admin.who.can.teach": {
    "ru": "Преподаватели",
    "en": "Who can teach"
  },
  "admin.the.server.did.not.respond": {
    "ru": "Сервер не ответил",
    "en": "The server did not respond"
  },
  "admin.your.sign.in.is.no.longer.valid.the.link.may.have.been.replaced.o": {
    "ru": "Сеанс входа больше не действителен. Возможно, ссылку заменили или аккаунт",
    "en": "Your sign-in is no longer valid. The link may have been replaced or the account"
  },
  "admin.removed.ask.an.owner.for.a.new.sign.in.link": {
    "ru": "удалили. Попросите владельца выдать новую ссылку для входа.",
    "en": "removed. Ask an owner for a new sign-in link."
  },
  "admin.you.removed.your.own.account.so.this.browser.is.signed.out.an.own": {
    "ru": "Вы удалили свой аккаунт и вышли из панели в этом браузере. Владелец может добавить вас снова.",
    "en": "You removed your own account, so this browser is signed out. An owner can add you back."
  },
  "admin.no.sign.in.session.was.received.from.this.browser.allow.cookies.f": {
    "ru": "Браузер не отправил сеанс входа. Разрешите cookies для этого",
    "en": "No sign-in session was received from this browser. Allow cookies for this"
  },
  "admin.address.or.open.the.panel.over.the.address.the.server.publishes.a": {
    "ru": "адреса или откройте панель по адресу, который публикует сервер, и войдите снова.",
    "en": "address, or open the panel over the address the server publishes, and sign in again."
  },
  "admin.could.not.save.the.rule.the.server.did.not.respond.try.again": {
    "ru": "Не удалось сохранить правило: сервер не ответил. Попробуйте ещё раз.",
    "en": "Could not save the rule: the server did not respond. Try again."
  },
  "admin.could.not.save.the.rule.your.sign.in.session.is.no.longer.valid.s": {
    "ru": "Не удалось сохранить правило: сеанс входа недействителен. Войдите заново.",
    "en": "Could not save the rule: your sign-in session is no longer valid. Sign in again."
  },
  "admin.could.not.save.the.rule.you.do.not.have.access.to.this.seminar": {
    "ru": "Не удалось сохранить правило: у вас нет прав на это занятие.",
    "en": "Could not save the rule: you do not have access to this class."
  },
  "admin.could.not.save.the.rule.seminar.not.found": {
    "ru": "Не удалось сохранить правило: занятие не найдено.",
    "en": "Could not save the rule: class not found."
  },
  "admin.could.not.save.the.rule.try.again": {
    "ru": "Не удалось сохранить правило. Попробуйте ещё раз.",
    "en": "Could not save the rule. Try again."
  },
  "admin.the.runtime.has.no.address.set": {
    "ru": "не задан адрес среды {p0}",
    "en": "the {p0} runtime has no address set"
  },
  "admin.no.model.key.is.set.for.this.instance": {
    "ru": "для этого инстанса не задан ключ модели",
    "en": "no model key is set for this instance"
  },
  "admin.the.instance.has.the.oracle.off": {
    "ru": "оракул отключён на уровне инстанса",
    "en": "the instance has the oracle off"
  },
  "admin.the.instance.allows.zero.questions.an.hour": {
    "ru": "на уровне инстанса разрешено ноль вопросов в час",
    "en": "the instance allows zero questions an hour"
  },
  "admin.the.instance.allows.hints.only": {
    "ru": "на уровне инстанса разрешены только подсказки",
    "en": "the instance allows hints only"
  },
  "admin.version": {
    "ru": "версия {p0}",
    "en": "version {p0}"
  },
  "admin.version.skipped": {
    "ru": "Версия «{p0}» пропущена: {p1}",
    "en": "Version “{p0}” skipped: {p1}"
  },
  "admin.just.now": {
    "ru": "только что",
    "en": "just now"
  },
  "admin.min.ago": {
    "ru": "{p0} мин назад",
    "en": "{p0} min ago"
  },
  "admin.h.ago": {
    "ru": "{p0} ч назад",
    "en": "{p0} h ago"
  },
  "admin.yesterday": {
    "ru": "вчера",
    "en": "yesterday"
  },
  "admin.days.ago": {
    "ru": "{p0} дн. назад",
    "en": "{p0} days ago"
  },
  "admin.1.person": {
    "ru": "1 человек",
    "en": "1 person"
  },
  "admin.people": {
    "ru": "{p0} чел.",
    "en": "{p0} people"
  },
  "admin.created": {
    "ru": "создан {p0}",
    "en": "created {p0}"
  },
  "admin.started": {
    "ru": "начался {p0}",
    "en": "started {p0}"
  },
  "admin.in.the.room": {
    "ru": "{p0} в комнате · {p1}",
    "en": "{p0} in the room · {p1}"
  },
  "admin.group.seminars.on.a.course.page.and.set.their.order": {
    "ru": "Объедините занятия на странице курса и задайте их порядок.",
    "en": "Group classes on a course page and set their order."
  },
  "admin.new.course": {
    "ru": "Новый курс",
    "en": "New course"
  },
  "admin.course.name": {
    "ru": "Название курса",
    "en": "Course name"
  },
  "admin.create": {
    "ru": "Создать",
    "en": "Create"
  },
  "admin.cancel": {
    "ru": "Отмена",
    "en": "Cancel"
  },
  "admin.no.courses.yet": {
    "ru": "Курсов пока нет",
    "en": "No courses yet"
  },
  "admin.create.a.course.and.add.seminars.students.will.see.the.list.and.l": {
    "ru": "Создайте курс и добавьте занятия. Студенты увидят список и ссылки на опубликованные материалы.",
    "en": "Create a course and add classes. Students will see the list and links to published materials."
  },
  "admin.published": {
    "ru": "опубликовано ·",
    "en": "published ·"
  },
  "admin.not.yet": {
    "ru": "ещё нет",
    "en": "not yet"
  },
  "admin.pages.without.a.room": {
    "ru": "Страницы без комнаты",
    "en": "Pages without a room"
  },
  "admin.the.seminar.was.deleted.but.its.publication.was.kept.you.can.with": {
    "ru": "После удаления занятия его публикация сохранена. Здесь можно снять её с публикации или вернуть доступ по ссылке.",
    "en": "The class was deleted but its publication was kept. You can withdraw it here or restore access by link."
  },
  "admin.step": {
    "ru": "шаг",
    "en": "step"
  },
  "admin.steps": {
    "ru": "шага",
    "en": "steps"
  },
  "admin.steps.143": {
    "ru": "шагов",
    "en": "steps"
  },
  "admin.withdrawn": {
    "ru": "· снята",
    "en": "· withdrawn"
  },
  "admin.open": {
    "ru": "Открыть",
    "en": "Open"
  },
  "admin.withdraw.page": {
    "ru": "Снять страницу",
    "en": "Withdraw page"
  },
  "admin.restore.page": {
    "ru": "Вернуть страницу",
    "en": "Restore page"
  },
  "admin.permanently.delete.page.p.it.cannot.be.restored.through.colloq": {
    "ru": "Удалить страницу /p/{p0} навсегда? Восстановить её через Colloq нельзя.",
    "en": "Permanently delete page /p/{p0}? It cannot be restored through Colloq."
  },
  "admin.delete.permanently": {
    "ru": "Удалить навсегда",
    "en": "Delete permanently"
  },
  "admin.copied": {
    "ru": "Скопировано",
    "en": "Copied"
  },
  "admin.copy.link": {
    "ru": "Копировать ссылку",
    "en": "Copy link"
  },
  "admin.open.course.page": {
    "ru": "Открыть страницу курса",
    "en": "Open course page"
  },
  "admin.add.seminar": {
    "ru": "+ Добавить занятие",
    "en": "+ Add class"
  },
  "admin.all.courses": {
    "ru": "← Все курсы",
    "en": "← All courses"
  },
  "admin.short.course.description.optional": {
    "ru": "Краткое описание курса (необязательно)",
    "en": "Short course description (optional)"
  },
  "admin.course.description": {
    "ru": "Подпись курса",
    "en": "Course description"
  },
  "admin.save.changes": {
    "ru": "Сохранить изменения",
    "en": "Save changes"
  },
  "admin.save.address": {
    "ru": "Сохранить адрес",
    "en": "Save address"
  },
  "admin.release.previous.address": {
    "ru": "Освободить прежний адрес",
    "en": "Release previous address"
  },
  "admin.the.old.address.c": {
    "ru": "старый адрес /c/",
    "en": "the old address /c/"
  },
  "admin.also.works": {
    "ru": "тоже работает",
    "en": "also works"
  },
  "admin.the.previous.address.of.the": {
    "ru": "— прежний адрес",
    "en": "— the previous address of the"
  },
  "admin.course": {
    "ru": "курса",
    "en": "course"
  },
  "admin.page": {
    "ru": "страницы",
    "en": "page"
  },
  "admin.after.transfer.this.link.will.open.the.current.course.instead.of": {
    "ru": ". После переноса эта ссылка будет открывать текущий курс вместо прежнего.",
    "en": ". After transfer, this link will open the current course instead of the previous one."
  },
  "admin.previous.addresses": {
    "ru": "Прежние адреса",
    "en": "Previous addresses"
  },
  "admin.these.links.open.the.current.course.releasing.an.address.stops.it": {
    "ru": "Эти ссылки открывают текущий курс. Если освободить адрес, он перестанет вести сюда и его сможет занять другой курс.",
    "en": "These links open the current course. Releasing an address stops it from leading here and makes it available to another course."
  },
  "admin.release": {
    "ru": "Освободить",
    "en": "Release"
  },
  "admin.what.students.see": {
    "ru": "Что видят студенты",
    "en": "What students see"
  },
  "admin.the.page.is.accessible.by.link.without.signing.in": {
    "ru": "Страница доступна по ссылке без входа.",
    "en": "The page is accessible by link without signing in."
  },
  "admin.the.course.page.shows.seminar.names.in.the.chosen.order.and.links": {
    "ru": "На странице курса показаны названия занятий в указанном порядке и ссылки на их публикации. У остальных занятий стоит «ещё не опубликовано». Ссылки для входа в комнаты на странице курса не размещаются.",
    "en": "The course page shows class names in the chosen order and links to their publications. Other classes are marked “not published yet”. Links to join rooms are not shown on the course page."
  },
  "admin.no.seminars.available.to.add": {
    "ru": "Нет доступных занятий для добавления.",
    "en": "No classes available to add."
  },
  "admin.seminar": {
    "ru": "Занятие",
    "en": "Class"
  },
  "admin.publication": {
    "ru": "Публикация",
    "en": "Publication"
  },
  "admin.planned": {
    "ru": "по плану ·",
    "en": "planned ·"
  },
  "admin.no.room.yet": {
    "ru": "комнаты ещё нет",
    "en": "no room yet"
  },
  "admin.remove.row": {
    "ru": "Убрать строку",
    "en": "Remove row"
  },
  "admin.seminar.deleted.position.in.list.kept": {
    "ru": "занятие удалено · позиция в списке сохранена",
    "en": "class deleted · position in list kept"
  },
  "admin.open.saved.publication": {
    "ru": "открыть сохранённую публикацию",
    "en": "open saved publication"
  },
  "admin.no.publication": {
    "ru": "публикации нет",
    "en": "no publication"
  },
  "admin.published.203": {
    "ru": "опубликован ·",
    "en": "published ·"
  },
  "admin.steps.206": {
    "ru": "шагов",
    "en": "steps"
  },
  "admin.not.published.yet": {
    "ru": "ещё не опубликовано",
    "en": "not published yet"
  },
  "admin.publish": {
    "ru": "Опубликовать…",
    "en": "Publish…"
  },
  "admin.move.up": {
    "ru": "Переместить выше",
    "en": "Move up"
  },
  "admin.move.down": {
    "ru": "Переместить ниже",
    "en": "Move down"
  },
  "admin.this.course.has.no.seminars.yet": {
    "ru": "В этом курсе пока нет занятий.",
    "en": "This course has no classes yet."
  },
  "admin.use.the.arrows.to.reorder.seminars.the.new.order.appears.when.the": {
    "ru": "Стрелки меняют порядок занятий. Новый порядок виден после загрузки страницы курса.",
    "en": "Use the arrows to reorder classes. The new order appears when the course page is loaded."
  },
  "admin.deleting.the.course.removes.the.seminar.list.its.order.and.the.ad": {
    "ru": "При удалении курса будут удалены список занятий, их порядок и адрес",
    "en": "Deleting the course removes the class list, its order and the address"
  },
  "admin.seminars.and.published.pages.will.be.kept": {
    "ru": ". Занятия и опубликованные страницы сохранятся.",
    "en": ". Classes and published pages will be kept."
  },
  "admin.delete.course": {
    "ru": "Удалить курс…",
    "en": "Delete course…"
  },
  "admin.course.218": {
    "ru": "Курс",
    "en": "Course"
  },
  "admin.opening.course": {
    "ru": "Открываем курс…",
    "en": "Opening course…"
  },
  "admin.could.not.open.course": {
    "ru": "Не удалось открыть курс",
    "en": "Could not open course"
  },
  "admin.check.the.address.or.return.to.the.course.list": {
    "ru": "Проверьте адрес или вернитесь к списку курсов.",
    "en": "Check the address or return to the course list."
  },
  "admin.delete.course.224": {
    "ru": "Удалить курс «",
    "en": "Delete course “"
  },
  "admin.the.link": {
    "ru": "Ссылка",
    "en": "The link"
  },
  "admin.will.no.longer.open.the.course.the.seminar.list.and.its.order.wil": {
    "ru": "перестанет открывать курс. Список занятий и его порядок будут удалены. Занятия и их публикации сохранятся.",
    "en": "will no longer open the course. The class list and its order will be deleted. Classes and their publications will be kept."
  },
  "admin.deleting": {
    "ru": "Удаляем…",
    "en": "Deleting…"
  },
  "admin.delete.course.230": {
    "ru": "Удалить курс",
    "en": "Delete course"
  },
  "admin.release.address.c": {
    "ru": "Освободить адрес /c/",
    "en": "Release address /c/"
  },
  "admin.it.currently.leads.to.the": {
    "ru": "Сейчас он ведёт на",
    "en": "It currently leads to the"
  },
  "admin.course.234": {
    "ru": "курс",
    "en": "course"
  },
  "admin.page.235": {
    "ru": "страницу",
    "en": "page"
  },
  "admin.transferring": {
    "ru": "Переносим…",
    "en": "Transferring…"
  },
  "admin.transfer.address": {
    "ru": "Перенести адрес",
    "en": "Transfer address"
  },
  "admin.this.link.will.stop.opening.the.current.course.another.course.may": {
    "ru": "Эта ссылка перестанет открывать текущий курс. Адрес сможет занять другой курс, и тогда ссылка будет вести на него.",
    "en": "This link will stop opening the current course. Another course may take this address, and the link will then lead to that course."
  },
  "admin.releasing": {
    "ru": "Освобождаем…",
    "en": "Releasing…"
  },
  "admin.release.address": {
    "ru": "Освободить адрес",
    "en": "Release address"
  },
  "admin.could.not.complete.the.request.try.again": {
    "ru": "Не удалось выполнить запрос. Попробуйте ещё раз.",
    "en": "Could not complete the request. Try again."
  },
  "admin.another.user.changed.the.course.the.current.version.will.load.ple": {
    "ru": "Курс изменён другим пользователем. Загрузим текущую версию; повторите изменение.",
    "en": "Another user changed the course. The current version will load; please repeat your change."
  },
  "admin.could.not.copy.the.link.copy.it.manually": {
    "ru": "Не удалось скопировать ссылку. Скопируйте её вручную: {p0}",
    "en": "Could not copy the link. Copy it manually: {p0}"
  },
  "admin.address.3.64.lowercase.latin.letters.digits.or.dashes.start.and.e": {
    "ru": "Адрес: 3–64 символа, строчные латинские буквы, цифры и дефис. Первый и последний символ — буква или цифра.",
    "en": "Address: 3–64 lowercase Latin letters, digits or dashes. Start and end with a letter or digit."
  },
  "admin.enter.a.course.name": {
    "ru": "Введите название курса.",
    "en": "Enter a course name."
  },
  "admin.build.container.images.with.the.python.packages.your.seminars.nee": {
    "ru": "Собирайте образы контейнеров с пакетами Python для ваших занятий.",
    "en": "Build container images with the Python packages your classes need."
  },
  "admin.env.pythonVersion": {
    "ru": "Версия Python",
    "en": "Python version"
  },
  "admin.env.pythonHint": {
    "ru": "Соберётся из официального образа python:{version}-slim-bookworm; кнопка пишет это строкой «# colloq: python» в шапку, а про умолчание не пишет ничего.",
    "en": "Built from the official python:{version}-slim-bookworm image; the button writes a “# colloq: python” line into the header, and writes nothing for the default."
  },
  "admin.env.pythonFromParent": {
    "ru": "Версию задаёт «{parent}» — Python {version}: слой поверх готового образа интерпретатор не меняет.",
    "en": "“{parent}” decides the version — Python {version}: a layer on top of a built image does not change the interpreter."
  },
  "admin.env.pythonFromParentUnknown": {
    "ru": "Версию задаёт «{parent}»: слой поверх готового образа интерпретатор не меняет.",
    "en": "“{parent}” decides the version: a layer on top of a built image does not change the interpreter."
  },
  "admin.env.pythonNotUnderstood": {
    "ru": "Строка «{line}» версией не считается: доступны {list}. Окружение соберётся на Python {version}.",
    "en": "The line “{line}” is not a version: {list} are available. The environment will be built on Python {version}."
  },
  "admin.env.pythonConflict": {
    "ru": "«{parent}» собран на Python {version}, и версию задаёт он: сборка со строкой про другую версию откажет.",
    "en": "“{parent}” is built on Python {version} and decides the version: a build asking for another one will be refused."
  },
  "admin.env.pythonNeedsRebuild": {
    "ru": "Файл просит Python {version}, а образ собран на {built} — пересоберите",
    "en": "The file asks for Python {version}; the image was built on {built}. Rebuild it"
  },
  "admin.new.environment": {
    "ru": "Новое окружение",
    "en": "New environment"
  },
  "admin.build.failed": {
    "ru": "сборка завершилась ошибкой",
    "en": "build failed"
  },
  "admin.build.finished": {
    "ru": "сборка завершена",
    "en": "build finished"
  },
  "admin.environments.come.from.the.release.catalog.each.seminar.keeps.its": {
    "ru": "Окружения загружаются из каталога релиза. Каждое занятие сохраняет свою версию образа. Собирайте и импортируйте новые образы с помощью инструментов развёртывания. Kubernetes выделяет GPU при запуске комнаты.",
    "en": "Environments come from the release catalog. Each class keeps its image revision. Build and import new images with the deployment tools. GPU allocation is handled by Kubernetes when a room starts."
  },
  "admin.gpu": {
    "ru": "GPU:",
    "en": "GPU:"
  },
  "admin.slice": {
    "ru": "срез",
    "en": "slice"
  },
  "admin.slices": {
    "ru": "срезов",
    "en": "slices"
  },
  "admin.free.a.room.on.a.gpu.environment.holds.its.slice.for.as.long.as.i": {
    "ru": "свободно. Комната с GPU-окружением занимает срез, пока работает её контейнер, даже если на занятии никого нет.",
    "en": "free. A room on a GPU environment holds its slice for as long as its container lives — a class nobody is in still holds one."
  },
  "admin.no.gpu.slices.are.configured.in.kernel.gpus.seminars.using.a.gpu": {
    "ru": "В KERNEL_GPUS не настроены срезы GPU. Занятия с GPU-окружением не смогут запустить ядро, пока срез GPU не станет доступен.",
    "en": "No GPU slices are configured in KERNEL_GPUS. Classes using a GPU environment cannot start a kernel until a GPU slice is available."
  },
  "admin.a.room.on.this.environment.holds.a.gpu.slice.for.as.long.as.its.c": {
    "ru": "Комната с этим окружением занимает срез GPU, пока работает её контейнер",
    "en": "A room on this environment holds a GPU slice for as long as its container lives"
  },
  "admin.packages.over": {
    "ru": "{p0} пакетов поверх {p1}",
    "en": "{p0} packages over {p1}"
  },
  "admin.the.base": {
    "ru": "базового образа",
    "en": "the base"
  },
  "admin.building": {
    "ru": "Сборка",
    "en": "Building"
  },
  "admin.ready": {
    "ru": "Готово",
    "en": "Ready"
  },
  "admin.build.failed.297": {
    "ru": "Ошибка сборки",
    "en": "Build failed"
  },
  "admin.the.package.list.changed.or.the.parent.image.was.rebuilt": {
    "ru": "Список пакетов изменился или родительский образ {p0} был пересобран",
    "en": "The package list changed or the parent image {p0} was rebuilt"
  },
  "admin.the.package.list.changed.after.the.build": {
    "ru": "Список пакетов изменился после сборки",
    "en": "The package list changed after the build"
  },
  "admin.needs.rebuild": {
    "ru": "Нужна пересборка",
    "en": "Needs rebuild"
  },
  "admin.not.built": {
    "ru": "Не собрано",
    "en": "Not built"
  },
  "admin.default": {
    "ru": "По умолчанию",
    "en": "Default"
  },
  "admin.new.seminars.will.be.created.on.this.environment": {
    "ru": "Новые занятия будут создаваться с этим окружением",
    "en": "New classes will be created on this environment"
  },
  "admin.make.default": {
    "ru": "Использовать по умолчанию",
    "en": "Make default"
  },
  "admin.build": {
    "ru": "Собрать",
    "en": "Build"
  },
  "admin.actions.for": {
    "ru": "Действия для",
    "en": "Actions for"
  },
  "admin.edit.packages": {
    "ru": "Изменить пакеты",
    "en": "Edit packages"
  },
  "admin.duplicate": {
    "ru": "Дублировать",
    "en": "Duplicate"
  },
  "admin.rebuild": {
    "ru": "Пересобрать",
    "en": "Rebuild"
  },
  "admin.build.log": {
    "ru": "Журнал сборки",
    "en": "Build log"
  },
  "admin.delete": {
    "ru": "Удалить…",
    "en": "Delete…"
  },
  "admin.more": {
    "ru": "ещё",
    "en": "more"
  },
  "admin.waiting.for.build.log": {
    "ru": "Ожидание журнала сборки…",
    "en": "Waiting for build log…"
  },
  "admin.full.log": {
    "ru": "Полный журнал",
    "en": "Full log"
  },
  "admin.no.environments.yet": {
    "ru": "Окружений пока нет.",
    "en": "No environments yet."
  },
  "admin.rooms.run.on.the.base.image.numpy.pandas.matplotlib.scikit.learn": {
    "ru": "Комнаты используют базовый образ: numpy, pandas, matplotlib, scikit-learn. Создайте окружение, чтобы добавить пакеты для вашего курса.",
    "en": "Rooms run on the base image: numpy, pandas, matplotlib, scikit-learn. Make one to add your course's own packages on top."
  },
  "admin.an.environment.is.a.container.image.each.seminar.runs.in.its.own": {
    "ru": "Окружение — это образ контейнера. Каждое занятие работает в своём контейнере с окружением, выбранным при создании. Изменение окружения по умолчанию применяется к",
    "en": "An environment is a container image. Each class runs in its own container using the environment selected at creation. Changing the default applies to"
  },
  "admin.new": {
    "ru": "новым",
    "en": "new"
  },
  "admin.seminars.330": {
    "ru": "занятиям.",
    "en": "classes."
  },
  "admin.existing.seminars.keep.their.pinned.image.revision": {
    "ru": "Существующие занятия сохраняют закреплённую версию образа.",
    "en": "Existing classes keep their pinned image revision."
  },
  "admin.environment": {
    "ru": "Окружение {p0}",
    "en": "Environment {p0}"
  },
  "admin.close": {
    "ru": "Закрыть",
    "en": "Close"
  },
  "admin.name": {
    "ru": "Название",
    "en": "Name"
  },
  "admin.already.exists.choose.another.name.or.use.edit.packages.on.the.ex": {
    "ru": "уже существует. Выберите другое название или нажмите «Изменить пакеты» у существующего окружения.",
    "en": "already exists. Choose another name or use Edit packages on the existing environment."
  },
  "admin.use.1.32.lowercase.letters.digits.or.dashes.start.and.end.with.a": {
    "ru": "От 1 до 32 строчных латинских букв, цифр или дефисов. Первый и последний символ — буква или цифра.",
    "en": "Use 1–32 lowercase letters, digits or dashes. Start and end with a letter or digit."
  },
  "admin.packages": {
    "ru": "Пакеты",
    "en": "Packages"
  },
  "admin.use.requirements.txt.syntax.one.package.per.line.packages.are.add": {
    "ru": "Используйте синтаксис requirements.txt, один пакет на строку. Пакеты добавляются к родительскому образу.",
    "en": "Use requirements.txt syntax, one package per line. Packages are added to the parent image."
  },
  "admin.save.the.package.list.then.build.the.environment.to.install.its.p": {
    "ru": "Сохраните список пакетов, затем соберите окружение, чтобы установить их.",
    "en": "Save the package list, then build the environment to install its packages."
  },
  "admin.save": {
    "ru": "Сохранить",
    "en": "Save"
  },
  "admin.delete.350": {
    "ru": "Удалить",
    "en": "Delete"
  },
  "admin.this.deletes.the.package.list.the.built.image.remains.in.docker.a": {
    "ru": "Будет удалён список пакетов. Собранный образ останется в Docker; его можно удалить отдельно.",
    "en": "This deletes the package list. The built image remains in Docker and can be removed separately."
  },
  "admin.delete.354": {
    "ru": "Удалить",
    "en": "Delete"
  },
  "admin.make": {
    "ru": "Сделать",
    "en": "Make"
  },
  "admin.the.default": {
    "ru": "окружением по умолчанию?",
    "en": "the default?"
  },
  "admin.seminars.created.from.now.on.get": {
    "ru": "Новые занятия будут использовать",
    "en": "Classes created from now on get"
  },
  "admin.existing.seminars.keep.their.selected.environment": {
    "ru": ". Существующие занятия сохранят выбранное окружение.",
    "en": ". Existing classes keep their selected environment."
  },
  "admin.switching": {
    "ru": "Переключаем…",
    "en": "Switching…"
  },
  "admin.could.not.read.the.environments": {
    "ru": "Не удалось прочитать список окружений.",
    "en": "Could not read the environments."
  },
  "admin.log.connection.lost.reopen.build.log.to.check.the.build.status": {
    "ru": "Соединение с журналом потеряно. Откройте «Журнал сборки» снова, чтобы проверить состояние сборки.",
    "en": "Log connection lost. Reopen Build log to check the build status."
  },
  "admin.could.not.update.the.environment.try.again": {
    "ru": "Не удалось обновить окружение. Попробуйте ещё раз.",
    "en": "Could not update the environment. Try again."
  },
  "admin.could.not.read": {
    "ru": "Не удалось прочитать {p0}.",
    "en": "Could not read {p0}."
  },
  "admin.installed.on.top.of.the.base.numpy.pandas.matplotlib.scikit.learn": {
    "ru": "# Устанавливается поверх базового образа (numpy, pandas, matplotlib, scikit-learn),",
    "en": "# Installed on top of the base (numpy, pandas, matplotlib, scikit-learn),"
  },
  "admin.so.there.is.no.need.to.list.those.one.package.per.line.transforme": {
    "ru": "# поэтому их перечислять не нужно. Один пакет на строку:\n#\n# transformers>=4.44",
    "en": "# so there is no need to list those. One package per line: # # transformers>=4.44"
  },
  "admin.environment.already.exists.open.it.with.edit.packages": {
    "ru": "Окружение {p0} уже существует. Откройте его через «Изменить пакеты».",
    "en": "Environment {p0} already exists. Open it with Edit packages."
  },
  "admin.could.not.save.the.package.list.try.again": {
    "ru": "Не удалось сохранить список пакетов. Попробуйте ещё раз.",
    "en": "Could not save the package list. Try again."
  },
  "admin.back.to.seminars": {
    "ru": "К списку занятий",
    "en": "Back to classes"
  },
  "admin.creating": {
    "ru": "Создаём…",
    "en": "Creating…"
  },
  "admin.create.seminar": {
    "ru": "Создать занятие",
    "en": "Create class"
  },
  "admin.new.seminar": {
    "ru": "Новое занятие",
    "en": "New class"
  },
  "admin.choose.a.notebook.environment.and.access.rules.then.create.the.se": {
    "ru": "Выберите тетрадь, окружение и правила доступа, затем создайте занятие.",
    "en": "Choose a notebook, environment and access rules, then create the class."
  },
  "admin.basics": {
    "ru": "Основное",
    "en": "Basics"
  },
  "admin.students.see.this.name.when.they.join.the.seminar": {
    "ru": "Студенты увидят это название при входе на занятие.",
    "en": "Students see this name when they join the class."
  },
  "admin.week.7.attention": {
    "ru": "Неделя 7 — Механизм внимания",
    "en": "Week 7 — Attention"
  },
  "admin.seminar.name": {
    "ru": "Название занятия",
    "en": "Class name"
  },
  "admin.blank": {
    "ru": "Пустая тетрадь",
    "en": "Blank"
  },
  "admin.welcome": {
    "ru": "# Добро пожаловать",
    "en": "# Welcome"
  },
  "admin.start.with.a.text.cell.and.a.code.cell": {
    "ru": "Начните с текстовой ячейки и ячейки кода.",
    "en": "Start with a text cell and a code cell."
  },
  "admin.from.a.file": {
    "ru": "Из файла",
    "en": "From a file"
  },
  "admin.cells.outputs.are.dropped": {
    "ru": "ячеек · результаты не импортируются",
    "en": "cells · outputs are dropped"
  },
  "admin.choose.a.ipynb.file.outputs.are.not.imported": {
    "ru": "Выберите файл .ipynb. Результаты выполнения не импортируются.",
    "en": "Choose a .ipynb file. Outputs are not imported."
  },
  "admin.from.github": {
    "ru": "Из GitHub",
    "en": "From GitHub"
  },
  "admin.public.repositories.only": {
    "ru": "Только публичные репозитории.",
    "en": "Public repositories only."
  },
  "admin.github.link.to.a.notebook.or.a.folder": {
    "ru": "Ссылка GitHub на тетрадь или папку",
    "en": "GitHub link to a notebook or a folder"
  },
  "admin.reading.the.repository": {
    "ru": "Читаем репозиторий…",
    "en": "Reading the repository…"
  },
  "admin.cells": {
    "ru": "ячеек",
    "en": "cells"
  },
  "admin.1.file.exceeds.the.import.limit.and.will.be.skipped": {
    "ru": "1 файл превышает лимит импорта и будет пропущен:",
    "en": "1 file exceeds the import limit and will be skipped:"
  },
  "admin.files.exceed.the.import.limit.and.will.be.skipped": {
    "ru": "{p0} файлов превышают лимит импорта и будут пропущены:",
    "en": "{p0} files exceed the import limit and will be skipped:"
  },
  "admin.environment.464": {
    "ru": "Окружение",
    "en": "Environment"
  },
  "admin.the.python.environment.for.this.seminar.it.is.selected.when.the.s": {
    "ru": "Окружение Python для этого занятия. Выбирается при создании занятия.",
    "en": "The Python environment for this class. It is selected when the class is created."
  },
  "admin.built": {
    "ru": "собрано",
    "en": "built"
  },
  "admin.python.environment": {
    "ru": "Окружение Python",
    "en": "Python environment"
  },
  "admin.or.choose": {
    "ru": "или выберите",
    "en": "or choose"
  },
  "admin.use": {
    "ru": "Использовать {p0}",
    "en": "Use {p0}"
  },
  "admin.has.not.been.built.a.room.cannot.open.on.it": {
    "ru": "Окружение {p0} не собрано — комнату нельзя открыть с ним",
    "en": "{p0} has not been built — a room cannot open on it"
  },
  "admin.not.built.483": {
    "ru": "не собрано",
    "en": "not built"
  },
  "admin.whatever.this.instance.runs": {
    "ru": "Окружение этого инстанса.",
    "en": "Whatever this instance runs."
  },
  "admin.gpu.is.not.configured": {
    "ru": "GPU не настроены.",
    "en": "GPU is not configured."
  },
  "admin.this.environment.needs.a.gpu.but.kernel.gpus.is.not.set.choose.an": {
    "ru": "Окружению нужен GPU, но KERNEL_GPUS не задана. Выберите другое окружение или попросите администратора настроить GPU.",
    "en": "This environment needs a GPU, but KERNEL_GPUS is not set. Choose another environment or ask the administrator to configure GPU access."
  },
  "admin.no.free.slices": {
    "ru": "Свободных срезов нет.",
    "en": "No free slices."
  },
  "admin.all.slices.are.held.by.containers.from.other.seminars.including.i": {
    "ru": "Все срезы заняты контейнерами других занятий, в том числе неактивных. Занятие можно создать, но для запуска ядра потребуется освободить срез.",
    "en": "All slices are held by containers from other classes, including inactive ones. You can create the class, but a slice must be freed before starting its kernel."
  },
  "admin.materials": {
    "ru": "Материалы",
    "en": "Materials"
  },
  "admin.add.files.to.the.seminar.workspace.participants.can.download.them": {
    "ru": "Добавьте файлы в рабочее пространство занятия. Участники смогут скачать их; для чтения из кода нужно разрешение на выполнение кода.",
    "en": "Add files to the class workspace. Participants can download them; reading them from code requires permission to run code."
  },
  "admin.file": {
    "ru": "файл",
    "en": "file"
  },
  "admin.role": {
    "ru": "роль",
    "en": "role"
  },
  "admin.size": {
    "ru": "размер",
    "en": "size"
  },
  "admin.cells.outputs.dropped": {
    "ru": "ячеек · без результатов выполнения",
    "en": "cells · outputs dropped"
  },
  "admin.live": {
    "ru": "совместная",
    "en": "live"
  },
  "admin.attached.notebook.file": {
    "ru": "Прикреплённый файл тетради",
    "en": "Attached notebook file"
  },
  "admin.read.from.code.with.open": {
    "ru": "Чтение из кода: open(\"",
    "en": "Read from code with open(\""
  },
  "admin.notebook": {
    "ru": "тетрадь",
    "en": "notebook"
  },
  "admin.data": {
    "ru": "данные",
    "en": "data"
  },
  "admin.remove.from.the.upload.list": {
    "ru": "Убрать {p0} из списка загрузки",
    "en": "Remove {p0} from the upload list"
  },
  "admin.drop.notebooks.data.or.slides.or": {
    "ru": "Перетащите тетради, данные или слайды — или",
    "en": "Drop notebooks, data or slides — or"
  },
  "admin.browse": {
    "ru": "выберите файлы",
    "en": "browse"
  },
  "admin.up.to": {
    "ru": "До",
    "en": "Up to"
  },
  "admin.mb.each": {
    "ru": "МБ на файл.",
    "en": "MB each."
  },
  "admin.material": {
    "ru": "материал",
    "en": "material"
  },
  "admin.materials.511": {
    "ru": "материалов",
    "en": "materials"
  },
  "admin.the.room": {
    "ru": "Комната",
    "en": "The room"
  },
  "admin.choose.a.mode.and.adjust.access.rules.you.can.change.them.during": {
    "ru": "Выберите режим и настройте правила доступа. Их можно менять во время занятия.",
    "en": "Choose a mode and adjust access rules. You can change them during the class."
  },
  "admin.you.can.change.the.mode.on.the.seminar.page": {
    "ru": "Режим можно изменить на странице занятия.",
    "en": "You can change the mode on the class page."
  },
  "admin.unavailable.controls": {
    "ru": "Недоступные настройки",
    "en": "Unavailable controls"
  },
  "admin.current.limitations": {
    "ru": "Текущие ограничения",
    "en": "Current limitations"
  },
  "admin.teacher.controls": {
    "ru": "Действия преподавателя",
    "en": "Teacher controls"
  },
  "admin.interrupting.a.cell.somebody.else.started.renaming.the.seminar.re": {
    "ru": "Остановка ячейки, запущенной другим участником · переименование занятия · восстановление старой версии и создание чекпоинта · удаление файлов из панели файлов · закрытие доступа участнику через панель «Участники», которое также удаляет его из комнаты.",
    "en": "Interrupting a cell somebody else started · renaming the class · restoring an old version and marking a checkpoint · deleting files from the file panel · closing somebody's access from the People panel, which also takes them out of the room."
  },
  "admin.choose.oracle.access.for.this.seminar.within.the.server.s.allowed": {
    "ru": "Выберите доступ к оракулу для занятия в пределах режима, разрешённого сервером.",
    "en": "Choose oracle access for this class within the server’s allowed mode."
  },
  "admin.the.server.allows.up.to.mode": {
    "ru": "Сервер разрешает режим до {p0}",
    "en": "The server allows up to {p0} mode"
  },
  "admin.above.what.the.instance.allows": {
    "ru": "выше ограничения инстанса ({p0})",
    "en": "above what the instance allows ({p0})"
  },
  "admin.the.server.s.mode.limits.this.seminar.you.can.further.restrict.th": {
    "ru": "Режим сервера ограничивает это занятие. Здесь можно дополнительно ограничить оракула.",
    "en": "The server’s mode limits this class. You can further restrict the oracle here."
  },
  "admin.the.oracle.is.unavailable": {
    "ru": "Оракул недоступен: {p0}.",
    "en": "The oracle is unavailable: {p0}."
  },
  "admin.server.limit": {
    "ru": "Ограничение сервера: {p0}.",
    "en": "Server limit: {p0}."
  },
  "admin.choose.a.ipynb.notebook.has.a.different.extension": {
    "ru": "Выберите тетрадь .ipynb. У файла {p0} другое расширение.",
    "en": "Choose a .ipynb notebook. {p0} has a different extension."
  },
  "admin.this.notebook.has.no.cells.choose.a.notebook.with.at.least.one.ce": {
    "ru": "В этой тетради нет ячеек. Выберите тетрадь хотя бы с одной ячейкой.",
    "en": "This notebook has no cells. Choose a notebook with at least one cell."
  },
  "admin.could.not.read.this.notebook.check.that.it.is.a.valid.ipynb.file": {
    "ru": "Не удалось прочитать тетрадь. Убедитесь, что это корректный файл .ipynb.",
    "en": "Could not read this notebook. Check that it is a valid .ipynb file."
  },
  "admin.exceed.the.mb.upload.limit.and.were.not.added": {
    "ru": "превышают лимит загрузки {p0} МБ и не были добавлены.",
    "en": "exceed the {p0} MB upload limit and were not added. "
  },
  "admin.choose.smaller.files.or.ask.the.server.administrator.to.increase": {
    "ru": "Выберите файлы поменьше или попросите администратора увеличить MAX_UPLOAD_MB.",
    "en": "Choose smaller files or ask the server administrator to increase MAX_UPLOAD_MB."
  },
  "admin.standard": {
    "ru": "Обычный",
    "en": "Standard"
  },
  "admin.participants.edit.the.notebook.together.run.cells.and.add.files": {
    "ru": "Участники вместе редактируют тетрадь, запускают ячейки и добавляют файлы.",
    "en": "Participants edit the notebook together, run cells and add files."
  },
  "admin.oracle.access.depends.on.its.settings": {
    "ru": "Доступ к оракулу зависит от его настроек.",
    "en": "Oracle access depends on its settings."
  },
  "admin.everyone.can.edit.and.run": {
    "ru": "редактирование и запуск — всем",
    "en": "everyone can edit and run"
  },
  "admin.everyone.can.add.files": {
    "ru": "добавление файлов — всем",
    "en": "everyone can add files"
  },
  "admin.lecture": {
    "ru": "Лекция",
    "en": "Lecture"
  },
  "admin.the.teacher.edits.the.notebook.and.runs.code.students.read.the.no": {
    "ru": "Преподаватель редактирует тетрадь и запускает код. Студенты читают тетрадь;",
    "en": "The teacher edits the notebook and runs code. Students read the notebook;"
  },
  "admin.the.teacher.can.open.individual.cells.for.them.to.work.on": {
    "ru": "преподаватель может открыть отдельные ячейки для работы.",
    "en": "the teacher can open individual cells for them to work on."
  },
  "admin.only.the.teacher.can.edit.and.run": {
    "ru": "редактирование и запуск — преподавателю",
    "en": "only the teacher can edit and run"
  },
  "admin.individual.cells.can.be.opened.to.students": {
    "ru": "отдельные ячейки можно открыть студентам",
    "en": "individual cells can be opened to students"
  },
  "admin.council": {
    "ru": "Консилиум",
    "en": "Council"
  },
  "admin.each.student.writes.a.separate.solution.in.the.open.cell.the.teac": {
    "ru": "В открытой ячейке каждый студент пишет отдельное решение. Преподаватель",
    "en": "Each student writes a separate solution in the open cell. The teacher"
  },
  "admin.reviews.attempts.shares.selected.ones.with.the.class.and.discusse": {
    "ru": "просматривает попытки, показывает выбранные классу и обсуждает их с оракулом.",
    "en": "reviews attempts, shares selected ones with the class and discusses them with the oracle."
  },
  "admin.the.teacher.controls.the.session": {
    "ru": "управление занятием — преподавателю",
    "en": "the teacher controls the session"
  },
  "admin.a.separate.attempt.for.every.student": {
    "ru": "отдельная попытка для каждого студента",
    "en": "a separate attempt for every student"
  },
  "admin.could.not.read.that.link": {
    "ru": "Не удалось прочитать ссылку",
    "en": "Could not read that link"
  },
  "admin.the.seminar.was.created.but": {
    "ru": "Занятие создано, но {p0}",
    "en": "The class was created, but {p0} "
  },
  "admin.one.file": {
    "ru": "один файл",
    "en": "one file"
  },
  "admin.files": {
    "ru": "файлы ({p0})",
    "en": "{p0} files"
  },
  "admin.did.not.upload.add.them.from.the.room": {
    "ru": "не загрузились: {p0}. Добавьте их из комнаты.",
    "en": "did not upload: {p0}. Add them from the room."
  },
  "admin.could.not.create.the.seminar": {
    "ru": "Не удалось создать занятие",
    "en": "Could not create the class"
  },
  "admin.as.set.for.the.instance": {
    "ru": "Как настроено для инстанса",
    "en": "As set for the instance"
  },
  "admin.use.the.server.default": {
    "ru": "использовать режим сервера по умолчанию",
    "en": "use the server default"
  },
  "admin.off": {
    "ru": "Выключен",
    "en": "Off"
  },
  "admin.disable.the.oracle.for.this.seminar": {
    "ru": "отключить оракула для этого занятия",
    "en": "disable the oracle for this class"
  },
  "admin.hints.only": {
    "ru": "Только подсказки",
    "en": "Hints only"
  },
  "admin.instructed.to.give.hints": {
    "ru": "получает инструкцию давать подсказки",
    "en": "instructed to give hints"
  },
  "admin.full.answers": {
    "ru": "Полные ответы",
    "en": "Full answers"
  },
  "admin.explains.and.writes.code": {
    "ru": "объясняет и пишет код",
    "en": "explains and writes code"
  },
  "admin.hide.notebook.cells": {
    "ru": "Скрыть ячейки тетради",
    "en": "Hide notebook cells"
  },
  "admin.participants.receive.the.whole.notebook": {
    "ru": "участники получают всю тетрадь",
    "en": "participants receive the whole notebook"
  },
  "admin.hide.terminal.history": {
    "ru": "Скрыть историю терминала",
    "en": "Hide terminal history"
  },
  "admin.participants.receive.the.terminal.history": {
    "ru": "участники получают историю терминала",
    "en": "participants receive the terminal history"
  },
  "admin.edit.your.own.answer.but.not.your.neighbour.s": {
    "ru": "Редактировать свой ответ, но не ответ соседа",
    "en": "Edit your own answer but not your neighbour's"
  },
  "admin.editing.access.applies.to.the.shared.cell": {
    "ru": "доступ к редактированию действует на общую ячейку",
    "en": "editing access applies to the shared cell"
  },
  "admin.keep.one.student.s.oracle.question.private": {
    "ru": "Скрыть вопрос студента к оракулу от остальных",
    "en": "Keep one student’s oracle question private"
  },
  "admin.questions.are.visible.to.the.room": {
    "ru": "вопросы видны всей комнате",
    "en": "questions are visible to the room"
  },
  "admin.a.model.for.this.room.only": {
    "ru": "Модель только для этой комнаты",
    "en": "A model for this room only"
  },
  "admin.the.model.is.configured.for.the.server": {
    "ru": "модель настраивается для всего сервера",
    "en": "the model is configured for the server"
  },
  "admin.students.can.edit.code.the.teacher.runs": {
    "ru": "Студенты могут менять код, который запускает преподаватель.",
    "en": "Students can edit code the teacher runs."
  },
  "admin.code.is.read.when.execution.starts.a.student.with.editing.access": {
    "ru": "Код считывается в момент запуска. Студент с доступом к редактированию может изменить ячейку в очереди",
    "en": "Code is read when execution starts. A student with editing access can change a queued"
  },
  "admin.cell.before.the.teacher.s.run.begins": {
    "ru": "до того, как начнётся её выполнение преподавателем.",
    "en": "cell before the teacher’s run begins."
  },
  "admin.running.code.also.gives.access.to.files": {
    "ru": "Запуск кода также даёт доступ к файлам.",
    "en": "Running code also gives access to files."
  },
  "admin.the.container.has.access.to.this.room.s.files": {
    "ru": "Контейнер имеет доступ к файлам этой комнаты.",
    "en": "The container has access to this room’s files."
  },
  "admin.anyone.allowed.to.run.code.can.list.read.and.delete.those.files.r": {
    "ru": "Любой участник, которому разрешён запуск кода, может просматривать, читать и удалять эти файлы независимо от",
    "en": "Anyone allowed to run code can list, read and delete those files, regardless of the"
  },
  "admin.file.panel.permissions": {
    "ru": "разрешений панели файлов.",
    "en": "file panel permissions."
  },
  "admin.suggests": {
    "ru": "предлагает",
    "en": "suggests"
  },
  "admin.use.it": {
    "ru": "Использовать",
    "en": "Use it"
  },
  "admin.keep.mine": {
    "ru": "Оставить моё",
    "en": "Keep mine"
  },
  "admin.saved": {
    "ru": "Сохранено",
    "en": "Saved"
  },
  "admin.unsaved": {
    "ru": "Не сохранено",
    "en": "Unsaved"
  },
  "admin.discard": {
    "ru": "Отменить изменения",
    "en": "Discard"
  },
  "admin.saving": {
    "ru": "Сохраняем…",
    "en": "Saving…"
  },
  "admin.configure.the.provider.model.and.limits.for.all.seminars": {
    "ru": "Настройте провайдера, модель и ограничения для всех занятий.",
    "en": "Configure the provider, model and limits for all classes."
  },
  "admin.could.not.load.the.settings.try.again.to.view.the.server.configur": {
    "ru": "Не удалось загрузить настройки. Попробуйте снова, чтобы увидеть конфигурацию сервера.",
    "en": "Could not load the settings. Try again to view the server configuration."
  },
  "admin.try.again": {
    "ru": "Повторить",
    "en": "Try again"
  },
  "admin.read.only": {
    "ru": "Только чтение.",
    "en": "Read-only."
  },
  "admin.only.an.owner.can.change.these.settings.contact.an.owner.to.updat": {
    "ru": "Эти настройки может менять только владелец. Обратитесь к нему, чтобы изменить провайдера, модель или ограничения.",
    "en": "Only an owner can change these settings. Contact an owner to update the provider, model or limits."
  },
  "admin.provider": {
    "ru": "Провайдер",
    "en": "Provider"
  },
  "admin.connect.an.openai.compatible.api.questions.and.notebook.context.a": {
    "ru": "Подключите API, совместимый с OpenAI. Вопросы и контекст тетради отправляются настроенному провайдеру.",
    "en": "Connect an OpenAI-compatible API. Questions and notebook context are sent to the configured provider."
  },
  "admin.base.url": {
    "ru": "Базовый URL",
    "en": "Base URL"
  },
  "admin.model": {
    "ru": "Модель",
    "en": "Model"
  },
  "admin.api.key": {
    "ru": "Ключ API",
    "en": "API key"
  },
  "admin.the.stored.key.will.be.removed.when.you.save": {
    "ru": "Сохранённый ключ будет удалён при сохранении настроек",
    "en": "The stored key will be removed when you save"
  },
  "admin.keep.it": {
    "ru": "Оставить ключ",
    "en": "Keep it"
  },
  "admin.no.key.set": {
    "ru": "Ключ не задан",
    "en": "No key set"
  },
  "admin.replace": {
    "ru": "Заменить",
    "en": "Replace"
  },
  "admin.add.a.key": {
    "ru": "Добавить ключ",
    "en": "Add a key"
  },
  "admin.remove": {
    "ru": "Убрать",
    "en": "Remove"
  },
  "admin.save.changes.and.send.a.test.request": {
    "ru": "Сохранить изменения и отправить тестовый запрос",
    "en": "Save changes and send a test request"
  },
  "admin.send.a.test.request.using.saved.settings": {
    "ru": "Отправить тестовый запрос с сохранёнными настройками",
    "en": "Send a test request using saved settings"
  },
  "admin.testing": {
    "ru": "Проверяем…",
    "en": "Testing…"
  },
  "admin.save.test": {
    "ru": "Сохранить и проверить",
    "en": "Save & test"
  },
  "admin.test.connection": {
    "ru": "Проверить соединение",
    "en": "Test connection"
  },
  "admin.the.new.key.is.stored.when.you.save.leaving.it.empty.changes.noth": {
    "ru": "Новый ключ сохраняется вместе с настройками. Пустое поле ничего не меняет —",
    "en": "The new key is stored when you save. Leaving it empty changes nothing —"
  },
  "admin.cancel.681": {
    "ru": "отмените ввод,",
    "en": "cancel"
  },
  "admin.to.keep.the.one.already.there": {
    "ru": "чтобы сохранить прежний ключ.",
    "en": "to keep the one already there."
  },
  "admin.the.server.will.use": {
    "ru": "Сервер будет использовать",
    "en": "The server will use"
  },
  "admin.if.it.is.set.providers.that.require.a.key.will.be.unavailable.wit": {
    "ru": ", если переменная задана. Провайдеры, которым нужен ключ, будут недоступны без него.",
    "en": "if it is set. Providers that require a key will be unavailable without one."
  },
  "admin.this.key.comes.from": {
    "ru": "Этот ключ получен из",
    "en": "This key comes from"
  },
  "admin.in.the.server.environment.a.key.saved.here.overrides.it.for.this": {
    "ru": "в окружении сервера. Сохранённый здесь ключ заменяет его для этого инстанса; удалите его, чтобы снова использовать ключ из окружения.",
    "en": "in the server environment. A key saved here overrides it for this instance; remove that one and the environment takes over again."
  },
  "admin.the.key.is.stored.on.the.server.and.masked.in.the.browser.the.ser": {
    "ru": "Ключ хранится на сервере и скрыт маской в браузере. Сервер использует его для запросов к провайдеру.",
    "en": "The key is stored on the server and masked in the browser. The server uses it for requests to the provider."
  },
  "admin.no.key.is.set.paste.one.here.or.point.the.base.url.at.a.local.run": {
    "ru": "Ключ не задан. Вставьте его здесь или укажите базовый URL локальной среды (Ollama, vLLM), которой не нужен ключ.",
    "en": "No key is set. Paste one here, or point the base URL at a local runtime (Ollama, vLLM) that does not ask for one."
  },
  "admin.saves.all.changes.on.this.page.before.sending.a.test.request": {
    "ru": "сохраняет все изменения на этой странице перед отправкой тестового запроса.",
    "en": "saves all changes on this page before sending a test request."
  },
  "admin.from.before.the.settings.changed": {
    "ru": "— получено до изменения настроек.",
    "en": "— from before the settings changed."
  },
  "admin.default.mode.and.limit": {
    "ru": "Режим по умолчанию и ограничение",
    "en": "Default mode and limit"
  },
  "admin.applies.to.all.seminars.each.seminar.can.further.restrict.the.ora": {
    "ru": "Применяется ко всем занятиям. Каждое занятие может дополнительно ограничить оракула подсказками или отключить его.",
    "en": "Applies to all classes. Each class can further restrict the oracle to hints or turn it off."
  },
  "admin.house.rules": {
    "ru": "Правила курса",
    "en": "House rules"
  },
  "admin.add.instructions.about.the.course.and.expected.answers.model.resp": {
    "ru": "Добавьте инструкции о курсе и ожидаемых ответах. Модель может следовать не всем инструкциям.",
    "en": "Add instructions about the course and expected answers. Model responses may not follow every instruction."
  },
  "admin.second.year.students.have.not.covered.autograd.explain.how.to.cal": {
    "ru": "Студенты второго курса ещё не проходили autograd. Объясняйте, как вычислять градиенты вручную.",
    "en": "Second-year students have not covered autograd. Explain how to calculate gradients by hand."
  },
  "admin.characters": {
    "ru": "символов",
    "en": "characters"
  },
  "admin.usage.limits": {
    "ru": "Ограничения использования",
    "en": "Usage limits"
  },
  "admin.limit.student.questions.and.request.size.teachers.are.exempt.from": {
    "ru": "Ограничьте число вопросов студентов и размер запросов. На преподавателей не действуют почасовой лимит и интервал, кроме случая, когда почасовой лимит равен нулю.",
    "en": "Limit student questions and request size. Teachers are exempt from the hourly and interval limits, except when the hourly limit is zero."
  },
  "admin.questions.per.student": {
    "ru": "Вопросов на студента",
    "en": "Questions per student"
  },
  "admin.per.hour": {
    "ru": "в час",
    "en": "per hour"
  },
  "admin.zero.switches.the.oracle.off.in.every.seminar": {
    "ru": "Ноль отключает оракула на всех занятиях.",
    "en": "Zero switches the oracle off in every class."
  },
  "admin.zero.switches.it.off": {
    "ru": ". Ноль отключает оракула.",
    "en": ". Zero switches it off."
  },
  "admin.between.questions": {
    "ru": "Между вопросами",
    "en": "Between questions"
  },
  "admin.seconds": {
    "ru": "секунд",
    "en": "seconds"
  },
  "admin.no.minimum.interval.between.questions": {
    "ru": "Минимальный интервал между вопросами не задан.",
    "en": "No minimum interval between questions."
  },
  "admin.a.student.waits.this.long.between.questions.the.teacher.does.not": {
    "ru": "Студент ждёт столько времени между вопросами. Преподавателю ждать не нужно.",
    "en": "A student waits this long between questions. The teacher does not."
  },
  "admin.notebook.context": {
    "ru": "Контекст тетради",
    "en": "Notebook context"
  },
  "admin.characters.of.notebook.context.may.be.included.with.a.question": {
    "ru": "символов контекста тетради может быть включено в вопрос.",
    "en": "characters of notebook context may be included with a question."
  },
  "admin.maximum.file.upload": {
    "ru": "Максимальный размер файла",
    "en": "Maximum file upload"
  },
  "admin.mb": {
    "ru": "{p0} МБ",
    "en": "{p0} MB"
  },
  "admin.in.the.server.environment.read.at.boot.change.it.in": {
    "ru": "в окружении сервера, считывается при запуске. Измените её в",
    "en": "in the server environment, read at boot. Change it in"
  },
  "admin.and.restart": {
    "ru": "и перезапустите сервер.",
    "en": "and restart."
  },
  "admin.usage": {
    "ru": "Использование",
    "en": "Usage"
  },
  "admin.request.counts.recorded.by.this.server.token.counts.depend.on.wha": {
    "ru": "Число запросов, записанное этим сервером. Число токенов зависит от данных, которые сообщает провайдер.",
    "en": "Request counts recorded by this server. Token counts depend on what the provider reports."
  },
  "admin.questions.asked": {
    "ru": "задано вопросов",
    "en": "questions asked"
  },
  "admin.tokens": {
    "ru": "токенов",
    "en": "tokens"
  },
  "admin.tokens.not.reported.by.this.endpoint": {
    "ru": "токены — этот API не сообщает их число",
    "en": "tokens — not reported by this endpoint"
  },
  "admin.seminars.with.questions": {
    "ru": "занятий с вопросами",
    "en": "classes with questions"
  },
  "admin.no.questions.recorded.in.this.period.the.breakdown.appears.after": {
    "ru": "За этот период вопросов не было. Разбивка появится после первого запроса.",
    "en": "No questions recorded in this period. The breakdown appears after the first request."
  },
  "admin.counted.since": {
    "ru": "Учёт с",
    "en": "Counted since"
  },
  "admin.oracle.disabled": {
    "ru": "Оракул отключён",
    "en": "Oracle disabled"
  },
  "admin.instructed.to.give.hints.761": {
    "ru": "Получает инструкцию давать подсказки",
    "en": "Instructed to give hints"
  },
  "admin.explains.and.writes.code.764": {
    "ru": "Объясняет и пишет код",
    "en": "Explains and writes code"
  },
  "admin.questions": {
    "ru": "Вопросы",
    "en": "Questions"
  },
  "admin.file.tasks": {
    "ru": "Задачи с файлами",
    "en": "File tasks"
  },
  "admin.explain": {
    "ru": "Объяснить",
    "en": "Explain"
  },
  "admin.fix.my.error": {
    "ru": "Исправить мою ошибку",
    "en": "Fix my error"
  },
  "admin.debug": {
    "ru": "Отладить",
    "en": "Debug"
  },
  "admin.improve": {
    "ru": "Улучшить",
    "en": "Improve"
  },
  "admin.hint": {
    "ru": "Подсказка",
    "en": "Hint"
  },
  "admin.m": {
    "ru": "{p0} млн",
    "en": "{p0}M"
  },
  "admin.k": {
    "ru": "{p0} тыс.",
    "en": "{p0}k"
  },
  "admin.not.tested": {
    "ru": "Не проверено",
    "en": "Not tested"
  },
  "admin.not.connected": {
    "ru": "Нет соединения",
    "en": "Not connected"
  },
  "admin.connected": {
    "ru": "Подключено",
    "en": "Connected"
  },
  "admin.connected.ms": {
    "ru": "Подключено · {p0} мс",
    "en": "Connected · {p0} ms"
  },
  "admin.the.server.did.not.answer": {
    "ru": "Сервер не ответил.",
    "en": "The server did not answer."
  },
  "admin.these.links.open.the.current.publication.releasing.an.address.sto": {
    "ru": "Эти ссылки открывают текущую публикацию. Если освободить адрес, он перестанет вести сюда и его сможет занять другая публикация.",
    "en": "These links open the current publication. Releasing an address stops it from leading here and makes it available to another publication."
  },
  "admin.published.795": {
    "ru": "Опубликовано",
    "en": "Published"
  },
  "admin.publish.796": {
    "ru": "Опубликовать — {p0}",
    "en": "Publish — {p0}"
  },
  "admin.publishing.again.updates.the.page.at.the.same.link": {
    "ru": "Повторная публикация обновляет страницу по той же ссылке.",
    "en": "Publishing again updates the page at the same link."
  },
  "admin.previously.published.p.publishing.again.keeps.the.same.link": {
    "ru": "Опубликован ранее — /p/{p0}. Публикуя снова, вы оставляете ту же ссылку.",
    "en": "Previously published — /p/{p0}. Publishing again keeps the same link."
  },
  "admin.choose.notebook.versions.to.publish": {
    "ru": "Выберите версии тетради для публикации.",
    "en": "Choose notebook versions to publish."
  },
  "admin.back.to.list": {
    "ru": "К списку",
    "en": "Back to list"
  },
  "admin.publish.803": {
    "ru": "Опубликовать",
    "en": "Publish"
  },
  "admin.published.page": {
    "ru": "Опубликованная страница:",
    "en": "Published page:"
  },
  "admin.change.address": {
    "ru": "Изменить адрес",
    "en": "Change address"
  },
  "admin.set.address": {
    "ru": "Задать адрес",
    "en": "Set address"
  },
  "admin.the.old.address.p": {
    "ru": "старый адрес /p/",
    "en": "the old address /p/"
  },
  "admin.the.previous.address.of.the.page": {
    "ru": "— прежний адрес страницы",
    "en": "— the previous address of the page"
  },
  "admin.after.transfer.this.link.will.open.the.current.publication.instea": {
    "ru": ". После переноса эта ссылка будет открывать текущую публикацию вместо прежней.",
    "en": ". After transfer, this link will open the current publication instead of the previous one."
  },
  "admin.moment": {
    "ru": "момент",
    "en": "moment"
  },
  "admin.moments": {
    "ru": "момента",
    "en": "moments"
  },
  "admin.moments.819": {
    "ru": "моментов",
    "en": "moments"
  },
  "admin.skipped": {
    "ru": "пропущен",
    "en": "skipped"
  },
  "admin.skipped.821": {
    "ru": "пропущены",
    "en": "skipped"
  },
  "admin.skipped.822": {
    "ru": "пропущены",
    "en": "skipped"
  },
  "admin.the.remaining.steps.were.published.once.the.issue.is.resolved.you": {
    "ru": "Остальные шаги опубликованы. После устранения причины можно повторить публикацию по той же ссылке.",
    "en": "The remaining steps were published. Once the issue is resolved, you can publish again at the same link."
  },
  "admin.steps.825": {
    "ru": "Шаги",
    "en": "Steps"
  },
  "admin.saved.notebook.versions.with.code.notes.and.cell.outputs": {
    "ru": "Сохранённые версии тетради с кодом, заметками и выводом ячеек.",
    "en": "Saved notebook versions with code, notes and cell outputs."
  },
  "admin.no.saved.versions.to.choose.from.the.current.notebook.will.be.pub": {
    "ru": "Нет сохранённых версий для выбора. Будет опубликована текущая тетрадь.",
    "en": "No saved versions to choose from. The current notebook will be published."
  },
  "admin.steps.come.from.checkpoints.click": {
    "ru": "Шаги берутся из чекпоинтов. Нажмите",
    "en": "Steps come from checkpoints. Click"
  },
  "admin.checkpoint": {
    "ru": "«Чекпоинт»",
    "en": "“Checkpoint”"
  },
  "admin.in.the.version.history.to.save.the.notebook.at.a.key.point.in.the": {
    "ru": "в ленте версий, чтобы сохранить тетрадь на нужном этапе занятия. Например, перед упражнением или после разбора решения.",
    "en": "in the version history to save the notebook at a key point in the session, such as before an exercise or after discussing a solution."
  },
  "admin.include.this.version.in.the.publication": {
    "ru": "Включить версию в публикацию",
    "en": "Include this version in the publication"
  },
  "admin.version.name": {
    "ru": "Название версии",
    "en": "Version name"
  },
  "admin.now": {
    "ru": "сейчас",
    "en": "now"
  },
  "admin.notebook.at.the.time.of.publishing": {
    "ru": "Тетрадь на момент публикации",
    "en": "Notebook at the time of publishing"
  },
  "admin.always.included.in.the.publication": {
    "ru": "всегда включается в публикацию",
    "en": "always included in the publication"
  },
  "admin.what.becomes.public": {
    "ru": "Что станет публичным",
    "en": "What becomes public"
  },
  "admin.names.and.personal.data.in.cell.text.or.outputs.will.be.kept.revi": {
    "ru": "Имена и личные данные в тексте ячеек или их выводе сохранятся. Проверьте их перед публикацией.",
    "en": "Names and personal data in cell text or outputs will be kept. Review them before publishing."
  },
  "admin.cells.code.and.notes": {
    "ru": "Ячейки, их код и заметки",
    "en": "Cells, code and notes"
  },
  "admin.as.they.were.at.each.step": {
    "ru": "такими, какими были на каждом шаге",
    "en": "as they were at each step"
  },
  "admin.everything.the.cells.printed": {
    "ru": "Всё, что ячейки напечатали",
    "en": "Everything the cells printed"
  },
  "admin.charts.tables.and.tracebacks": {
    "ru": "графики, таблицы, трейсбеки",
    "en": "charts, tables and tracebacks"
  },
  "admin.a.copy.button.for.each.cell.and.the.whole.notebook.as.an.ipynb.fi": {
    "ru": "Кнопка «скопировать» у каждой ячейки и вся тетрадь файлом .ipynb",
    "en": "A copy button for each cell and the whole notebook as an .ipynb file"
  },
  "admin.so.the.code.can.be.downloaded": {
    "ru": "чтобы код можно было забрать",
    "en": "so the code can be downloaded"
  },
  "admin.who.typed.or.ran.what": {
    "ru": "Кто что печатал и кто что запускал",
    "en": "Who typed or ran what"
  },
  "admin.action.authorship.is.not.published": {
    "ru": "авторство действий не публикуется",
    "en": "action authorship is not published"
  },
  "admin.oracle.question.history": {
    "ru": "Лента вопросов к оракулу",
    "en": "Oracle question history"
  },
  "admin.questions.and.answers.are.not.published": {
    "ru": "вопросы и ответы не публикуются",
    "en": "questions and answers are not published"
  },
  "admin.terminal": {
    "ru": "Терминал",
    "en": "Terminal"
  },
  "admin.command.history.is.not.published": {
    "ru": "история команд не публикуется",
    "en": "command history is not published"
  },
  "admin.room.files": {
    "ru": "Файлы комнаты",
    "en": "Room files"
  },
  "admin.files.are.not.included.in.the.publication": {
    "ru": "файлы не включаются в публикацию",
    "en": "files are not included in the publication"
  },
  "admin.share.the.link.with.your.students": {
    "ru": "Поделитесь ссылкой со студентами.",
    "en": "Share the link with your students."
  },
  "admin.publishing.again.keeps.the.link.after.withdrawal.the.link.display": {
    "ru": "Повторная публикация сохраняет ссылку. После снятия публикации по ней отображается сообщение об этом. Страница содержит запрет индексации для поисковых систем.",
    "en": "Publishing again keeps the link. After withdrawal, the link displays a notice. The page asks search engines not to index it."
  },
  "admin.room.access.stays.the.same": {
    "ru": "Доступ к комнате не меняется.",
    "en": "Room access stays the same."
  },
  "admin.publishing.and.archiving.do.not.change.access.through.the.link": {
    "ru": "Публикация и архивация не меняют доступ по ссылке",
    "en": "Publishing and archiving do not change access through the link"
  },
  "admin.entry.and.editing.depend.on.the.current.room.rules.and.class.stat": {
    "ru": ". Вход и редактирование зависят от действующих правил комнаты и статуса занятия.",
    "en": ". Entry and editing depend on the current room rules and class status."
  },
  "admin.release.address.p": {
    "ru": "Освободить адрес /p/",
    "en": "Release address /p/"
  },
  "admin.it.currently.leads.to.the.page": {
    "ru": "Сейчас он ведёт на страницу",
    "en": "It currently leads to the page"
  },
  "admin.this.link.will.stop.opening.the.current.publication.another.publi": {
    "ru": "Эта ссылка перестанет открывать текущую публикацию. Адрес сможет занять другая публикация, и тогда ссылка будет вести на неё.",
    "en": "This link will stop opening the current publication. Another publication may take this address, and the link will then lead to that publication."
  },
  "admin.could.not.load.the.seminar.history.try.reloading.the.page": {
    "ru": "Не удалось загрузить историю занятия. Попробуйте обновить страницу.",
    "en": "Could not load the class history. Try reloading the page."
  },
  "admin.could.not.publish.the.seminar.try.again": {
    "ru": "Не удалось опубликовать занятие. Попробуйте ещё раз.",
    "en": "Could not publish the class. Try again."
  },
  "admin.could.not.save.the.address.try.again": {
    "ru": "Не удалось сохранить адрес. Попробуйте ещё раз.",
    "en": "Could not save the address. Try again."
  },
  "admin.could.not.release.the.previous.address.try.again": {
    "ru": "Не удалось освободить прежний адрес. Попробуйте ещё раз.",
    "en": "Could not release the previous address. Try again."
  },
  "admin.search.seminars": {
    "ru": "Поиск занятий…",
    "en": "Search classes…"
  },
  "admin.search.seminars.by.name": {
    "ru": "Найти занятия по названию",
    "en": "Search classes by name"
  },
  "admin.active": {
    "ru": "активных ·",
    "en": "active ·"
  },
  "admin.archived": {
    "ru": "в архиве",
    "en": "archived"
  },
  "admin.archived.903": {
    "ru": "Архив",
    "en": "Archived"
  },
  "admin.running.now": {
    "ru": "Сейчас идут",
    "en": "Running now"
  },
  "admin.created.906": {
    "ru": "Создан",
    "en": "Created"
  },
  "admin.copy": {
    "ru": "Копировать",
    "en": "Copy"
  },
  "admin.could.not.load.seminars": {
    "ru": "Не удалось загрузить занятия:",
    "en": "Could not load classes:"
  },
  "admin.environment.919": {
    "ru": "Окружение",
    "en": "Environment"
  },
  "admin.date": {
    "ru": "Дата",
    "en": "Date"
  },
  "admin.joined": {
    "ru": "Входили",
    "en": "Joined"
  },
  "admin.status": {
    "ru": "Статус",
    "en": "Status"
  },
  "admin.actions": {
    "ru": "Действия",
    "en": "Actions"
  },
  "admin.importing": {
    "ru": "Импортируем…",
    "en": "Importing…"
  },
  "admin.import": {
    "ru": "Импортировать",
    "en": "Import"
  },
  "admin.name.filled.in.from.the.link": {
    "ru": "Название — заполнится по ссылке",
    "en": "Name — filled in from the link"
  },
  "admin.default.937": {
    "ru": "— по умолчанию",
    "en": "— default"
  },
  "admin.not.built.939": {
    "ru": "— не собрано",
    "en": "— not built"
  },
  "admin.outputs.not.imported": {
    "ru": "результаты не импортируются",
    "en": "outputs not imported"
  },
  "admin.computer.vision.seminar.25.08": {
    "ru": "Семинар по компьютерному зрению — 25.08",
    "en": "Computer Vision Seminar — 25.08"
  },
  "admin.name.of.the.new.seminar": {
    "ru": "Название нового занятия",
    "en": "Name of the new class"
  },
  "admin.python.environment.for.the.new.seminar": {
    "ru": "Окружение Python для нового занятия",
    "en": "Python environment for the new class"
  },
  "admin.rename": {
    "ru": "Переименовать",
    "en": "Rename"
  },
  "admin.link.not.shared.yet": {
    "ru": "ссылка ещё не передана",
    "en": "link not shared yet"
  },
  "admin.by": {
    "ru": "автор:",
    "en": "by"
  },
  "admin.published.978": {
    "ru": "· опубликован ·",
    "en": "· published ·"
  },
  "admin.page.taken.down": {
    "ru": "· страница снята с публикации",
    "en": "· page taken down"
  },
  "admin.selected.environment": {
    "ru": "Выбранное окружение:",
    "en": "Selected environment:"
  },
  "admin.no.environment.recorded.for.this.seminar": {
    "ru": "Окружение этого занятия не записано",
    "en": "No environment recorded for this class"
  },
  "admin.joined.in.total": {
    "ru": "всего входили",
    "en": "joined in total"
  },
  "admin.class.ended": {
    "ru": "Занятие завершено",
    "en": "Class ended"
  },
  "admin.student.editing.and.execution.are.disabled": {
    "ru": "— редактирование и выполнение кода студентами отключены",
    "en": "— student editing and execution are disabled"
  },
  "admin.in.the.room.right.now": {
    "ru": "сейчас в комнате",
    "en": "in the room right now"
  },
  "admin.finished": {
    "ru": "Завершён",
    "en": "Finished"
  },
  "admin.live.990": {
    "ru": "Идёт",
    "en": "Live"
  },
  "admin.draft": {
    "ru": "Черновик",
    "en": "Draft"
  },
  "admin.empty": {
    "ru": "Пусто",
    "en": "Empty"
  },
  "admin.open.seminar": {
    "ru": "Открыть занятие",
    "en": "Open class"
  },
  "admin.rules": {
    "ru": "Правила…",
    "en": "Rules…"
  },
  "admin.reopen.the.class": {
    "ru": "Продолжить занятие",
    "en": "Reopen the class"
  },
  "admin.end.the.class": {
    "ru": "Завершить занятие",
    "en": "End the class"
  },
  "admin.publish.again": {
    "ru": "Опубликовать снова…",
    "en": "Publish again…"
  },
  "admin.copy.public.link": {
    "ru": "Копировать ссылку на публикацию",
    "en": "Copy public link"
  },
  "admin.take.the.page.down": {
    "ru": "Снять страницу с публикации",
    "en": "Take the page down"
  },
  "admin.put.the.page.back": {
    "ru": "Вернуть страницу",
    "en": "Put the page back"
  },
  "admin.move.back.to.the.list": {
    "ru": "Вернуть в список",
    "en": "Move back to the list"
  },
  "admin.archive": {
    "ru": "В архив",
    "en": "Archive"
  },
  "admin.loading.seminars": {
    "ru": "Загружаем занятия…",
    "en": "Loading classes…"
  },
  "admin.no.seminars.match": {
    "ru": "Нет занятий по запросу «",
    "en": "No classes match “"
  },
  "admin.show.all": {
    "ru": "Показать все",
    "en": "Show all"
  },
  "admin.no.seminars.yet": {
    "ru": "Занятий пока нет.",
    "en": "No classes yet."
  },
  "admin.create.a.seminar.and.share.its.link.with.your.students": {
    "ru": "Создайте занятие и поделитесь ссылкой со студентами.",
    "en": "Create a class and share its link with your students."
  },
  "admin.showing": {
    "ru": "Показано",
    "en": "Showing"
  },
  "admin.of": {
    "ru": "из",
    "en": "of"
  },
  "admin.total": {
    "ru": "всего",
    "en": "total"
  },
  "admin.participant.permissions": {
    "ru": "права участников",
    "en": "participant permissions"
  },
  "admin.in.the.room.1023": {
    "ru": "В комнате",
    "en": "In the room"
  },
  "admin.person": {
    "ru": "человек",
    "en": "person"
  },
  "admin.people.1025": {
    "ru": "человека",
    "en": "people"
  },
  "admin.created.by": {
    "ru": ". Создатель:",
    "en": ". Created by:"
  },
  "admin.rule.changes.apply.immediately": {
    "ru": ". Изменения правил применяются сразу.",
    "en": ". Rule changes apply immediately."
  },
  "admin.changes.apply.immediately.participants.do.not.need.to.sign.in.aga": {
    "ru": "Изменения применяются сразу. Участникам не нужно входить заново.",
    "en": "Changes apply immediately. Participants do not need to sign in again."
  },
  "admin.the.class.has.ended.the.selected.student.permissions.will.take.ef": {
    "ru": "Занятие закончено. Выбранные права студентов начнут действовать, когда преподаватель продолжит занятие.",
    "en": "The class has ended. The selected student permissions will take effect when the teacher reopens the class."
  },
  "admin.done": {
    "ru": "Готово",
    "en": "Done"
  },
  "admin.delete.1035": {
    "ru": "Удалить «",
    "en": "Delete “"
  },
  "admin.this.deletes.the.notebook": {
    "ru": "Будут удалены тетрадь (",
    "en": "This deletes the notebook ("
  },
  "admin.and": {
    "ru": ") и",
    "en": ") and"
  },
  "admin.in.its.workspace": {
    "ru": "в её рабочем пространстве.",
    "en": "in its workspace."
  },
  "admin.you.cannot.restore.the.seminar.through.colloq.after.deletion": {
    "ru": "После удаления занятие нельзя восстановить через Colloq.",
    "en": "You cannot restore the class through Colloq after deletion."
  },
  "admin.delete.the.public.page.as.well": {
    "ru": "Также удалить опубликованную страницу —",
    "en": "Delete the public page as well —"
  },
  "admin.a.second.copy.of.the.notebook.in": {
    "ru": ", копию тетради с",
    "en": ", a second copy of the notebook in"
  },
  "admin.outputs.included": {
    "ru": ", включая результаты выполнения.",
    "en": ", outputs included."
  },
  "admin.the.link.the.class.was.given.stops.opening": {
    "ru": "Ссылка, переданная студентам, перестанет открываться.",
    "en": "The link the class was given stops opening."
  },
  "admin.the.publication.is.retained.with.its.current.visibility": {
    "ru": "Публикация сохранится с текущими настройками видимости.",
    "en": "The publication is retained with its current visibility."
  },
  "admin.someone.is.in.the.room.right.now": {
    "ru": "Сейчас в комнате есть участник",
    "en": "Someone is in the room right now"
  },
  "admin.people.are.in.the.room.right.now": {
    "ru": "Сейчас в комнате {p0} чел.",
    "en": "{p0} people are in the room right now"
  },
  "admin.deleting.the.seminar.will.disconnect.them": {
    "ru": "— удаление занятия отключит их.",
    "en": "— deleting the class will disconnect them."
  },
  "admin.archiving.removes.the.seminar.from.the.active.list.and.keeps.its": {
    "ru": "Архивация убирает занятие из активного списка и сохраняет тетрадь и файлы.",
    "en": "Archiving removes the class from the active list and keeps its notebook and files."
  },
  "admin.could.not.delete.the.seminar": {
    "ru": "Не удалось удалить занятие:",
    "en": "Could not delete the class:"
  },
  "admin.delete.seminar": {
    "ru": "Удалить занятие",
    "en": "Delete class"
  },
  "admin.could.not.update.the.publication": {
    "ru": "Не удалось обновить публикацию: {p0}",
    "en": "Could not update the publication: {p0}"
  },
  "admin.is.1.person": {
    "ru": "1 человек",
    "en": "is 1 person"
  },
  "admin.are.people": {
    "ru": "{p0} чел.",
    "en": "are {p0} people"
  },
  "admin.there.in.right.now.and.set.it.up": {
    "ru": "Сейчас на занятии «{p1}» {p0}. Автор занятия: {p2}",
    "en": "There {p0} in “{p1}” right now, and {p2} set it up"
  },
  "admin.the.new.name.appears.in.their.header.immediately": {
    "ru": "{p0}. Новое название сразу появится в заголовке у участников.",
    "en": "{p0}. The new name appears in their header immediately. "
  },
  "admin.rename.it.to": {
    "ru": "Переименовать в «{p0}»?",
    "en": "Rename it to “{p0}”?"
  },
  "admin.could.not.rename.the.seminar": {
    "ru": "Не удалось переименовать занятие: {p0}",
    "en": "Could not rename the class: {p0}"
  },
  "admin.ending.the.class.disables.editing.and.running.for.students": {
    "ru": "{p0}. Завершение занятия отключит редактирование и выполнение кода студентами.",
    "en": "{p0}. Ending the class disables editing and running for students. "
  },
  "admin.end.the.class.1110": {
    "ru": "Завершить занятие?",
    "en": "End the class?"
  },
  "admin.reopening.the.class.restores.its.configured.access.rules": {
    "ru": "{p0}. Продолжение занятия восстановит настроенные правила доступа.",
    "en": "{p0}. Reopening the class restores its configured access rules. "
  },
  "admin.reopen.the.class.1112": {
    "ru": "Продолжить занятие?",
    "en": "Reopen the class?"
  },
  "admin.could.not.end.the.class": {
    "ru": "Не удалось завершить занятие: {p0}",
    "en": "Could not end the class: {p0}"
  },
  "admin.could.not.reopen.the.class": {
    "ru": "Не удалось продолжить занятие: {p0}",
    "en": "Could not reopen the class: {p0}"
  },
  "admin.could.not.change.the.archive.status": {
    "ru": "Не удалось изменить статус архивации: {p0}",
    "en": "Could not change the archive status: {p0}"
  },
  "admin.add.a.teacher": {
    "ru": "Добавить преподавателя",
    "en": "Add a teacher"
  },
  "admin.manage.teacher.accounts.and.sign.in.links.teachers.can.create.sem": {
    "ru": "Управляйте аккаунтами преподавателей и ссылками для входа. Преподаватели могут создавать занятия и просматривать настройки оракула.",
    "en": "Manage teacher accounts and sign-in links. Teachers can create classes and view oracle settings."
  },
  "admin.ada.lovelace": {
    "ru": "Ада Лавлейс",
    "en": "Ada Lovelace"
  },
  "admin.email": {
    "ru": "Эл. почта",
    "en": "Email"
  },
  "admin.creating.a.link": {
    "ru": "Создаём ссылку…",
    "en": "Creating a link…"
  },
  "admin.add.teacher": {
    "ru": "Добавить преподавателя",
    "en": "Add teacher"
  },
  "admin.this.creates.a.teacher.account.and.a.sign.in.link.you.can.change": {
    "ru": "Будут созданы аккаунт преподавателя и ссылка для входа. Затем можно сменить его роль на владельца.",
    "en": "This creates a teacher account and a sign-in link. You can change their role to owner afterward."
  },
  "admin.person.1127": {
    "ru": "Участник",
    "en": "Person"
  },
  "admin.role.1128": {
    "ru": "Роль",
    "en": "Role"
  },
  "admin.sign.in.link": {
    "ru": "Ссылка для входа",
    "en": "Sign-in link"
  },
  "admin.last.seen": {
    "ru": "Последний вход",
    "en": "Last seen"
  },
  "admin.you": {
    "ru": "вы",
    "en": "you"
  },
  "admin.owner": {
    "ru": "Владелец",
    "en": "Owner"
  },
  "admin.last.owner.role.required": {
    "ru": "последний владелец · роль обязательна",
    "en": "last owner · role required"
  },
  "admin.role.for": {
    "ru": "Роль для",
    "en": "Role for"
  },
  "admin.teacher": {
    "ru": "Преподаватель",
    "en": "Teacher"
  },
  "admin.the.link.is.masked.here.copy.puts.the.full.sign.in.link.on.your.c": {
    "ru": "Здесь ссылка скрыта маской. Кнопка копирования помещает полную ссылку для входа в буфер обмена.",
    "en": "The link is masked here. Copy puts the full sign-in link on your clipboard."
  },
  "admin.s.sign.in.link": {
    "ru": "— ссылку для входа",
    "en": "’s sign-in link"
  },
  "admin.create.a.link": {
    "ru": "Создать ссылку",
    "en": "Create a link"
  },
  "admin.no.link.yet": {
    "ru": "Ссылки пока нет",
    "en": "No link yet"
  },
  "admin.never": {
    "ru": "никогда",
    "en": "never"
  },
  "admin.edit.name.and.email": {
    "ru": "Изменить имя и почту",
    "en": "Edit name and email"
  },
  "admin.rotate.sign.in.link": {
    "ru": "Заменить ссылку для входа",
    "en": "Rotate sign-in link"
  },
  "admin.create.a.sign.in.link": {
    "ru": "Создать ссылку для входа",
    "en": "Create a sign-in link"
  },
  "admin.remove.my.account": {
    "ru": "Удалить мой аккаунт",
    "en": "Remove my account"
  },
  "admin.remove.from.staff": {
    "ru": "Удалить из преподавателей",
    "en": "Remove from staff"
  },
  "admin.this.updates.their.name.and.email.their.sign.in.link.stays.the.sa": {
    "ru": "Изменятся имя и почта. Ссылка для входа останется прежней.",
    "en": "This updates their name and email. Their sign-in link stays the same."
  },
  "admin.rotate": {
    "ru": "Заменить",
    "en": "Rotate"
  },
  "admin.s.sign.in.link.1166": {
    "ru": "— ссылку для входа?",
    "en": "’s sign-in link?"
  },
  "admin.the.old.link.will.stop.working.and.their.signed.in.sessions.will": {
    "ru": "Прежняя ссылка перестанет работать, а активные сеансы входа завершатся",
    "en": "The old link will stop working and their signed-in sessions will end"
  },
  "admin.except.this.browser.session.which.will.be.renewed": {
    "ru": ", кроме текущего сеанса в этом браузере: он будет продлён",
    "en": ", except this browser session, which will be renewed"
  },
  "admin.a.new.link.will.appear.here.for.you.to.share": {
    "ru": ". Здесь появится новая ссылка, которой можно поделиться.",
    "en": ". A new link will appear here for you to share."
  },
  "admin.remove.your.own.account": {
    "ru": "Удалить свой аккаунт?",
    "en": "Remove your own account?"
  },
  "admin.remove.1171": {
    "ru": "Удалить {p0}?",
    "en": "Remove {p0}?"
  },
  "admin.their.sign.in.link.will.stop.working.and.their.signed.in.sessions": {
    "ru": "Ссылка для входа перестанет работать, а активные сеансы завершатся",
    "en": "Their sign-in link will stop working and their signed-in sessions will end"
  },
  "admin.including.this.one": {
    "ru": ", включая этот",
    "en": ", including this one"
  },
  "admin.their.seminars.will.remain.adding.them.again.creates.a.new.accoun": {
    "ru": ". Занятия сохранятся. При повторном добавлении будут созданы новый аккаунт и новая ссылка.",
    "en": ". Their classes will remain. Adding them again creates a new account and link."
  },
  "admin.working": {
    "ru": "Выполняем…",
    "en": "Working…"
  },
  "admin.rotate.the.link": {
    "ru": "Заменить ссылку",
    "en": "Rotate the link"
  },
  "admin.my.account": {
    "ru": "мой аккаунт",
    "en": "my account"
  },
  "admin.sign.in.link.for.shown.once": {
    "ru": "Ссылка для входа для {p0} · показана один раз",
    "en": "Sign-in link for {p0} · shown once"
  },
  "admin.is.on.the.staff.list.share.this.personal.sign.in.link.with.them": {
    "ru": "в списке преподавателей. Передайте этому человеку личную ссылку для входа.",
    "en": "is on the staff list. Share this personal sign-in link with them."
  },
  "admin.the.old.link.has.been.replaced.share.this.new.sign.in.link.with": {
    "ru": "Прежняя ссылка заменена. Передайте новую ссылку для входа:",
    "en": "The old link has been replaced. Share this new sign-in link with"
  },
  "admin.sign.in.link.for": {
    "ru": "Ссылка для входа для",
    "en": "Sign-in link for"
  },
  "admin.close.without.copying": {
    "ru": "Закрыть без копирования",
    "en": "Close without copying"
  },
  "admin.after.closing.this.message.use.the.copy.button.on.their.row.to.co": {
    "ru": "После закрытия сообщения ссылку можно снова скопировать кнопкой в строке преподавателя.",
    "en": "After closing this message, use the copy button on their row to copy the link again."
  },
  "admin.anyone.with.a.personal.link.can.sign.in.to.that.account.replace.a": {
    "ru": "Личная ссылка позволяет войти в соответствующий аккаунт. Замените её, если она стала доступна посторонним. Удалите аккаунт, если человеку больше не нужен доступ.",
    "en": "Anyone with a personal link can sign in to that account. Replace a shared or exposed link. Remove the account when the person should no longer have access."
  },
  "admin.anyone.with.a.personal.link.can.sign.in.to.that.account.contact.a": {
    "ru": "Личная ссылка позволяет войти в соответствующий аккаунт. Обратитесь к владельцу, чтобы добавить людей, заменить ссылки или удалить аккаунты.",
    "en": "Anyone with a personal link can sign in to that account. Contact an owner to add people, replace links or remove accounts."
  },
  "admin.setup.token": {
    "ru": "Токен настройки",
    "en": "Setup token"
  },
  "admin.the.setup.token.signs.anyone.holding.it.in.as.the.longest.standin": {
    "ru": "Токен настройки позволяет войти от имени самого давнего владельца. Замена токена делает прежний недействительным и сохраняет новый в",
    "en": "The setup token signs anyone holding it in as the longest-standing owner. Replacing it invalidates the old token and saves the new token in"
  },
  "admin.the.token.is.also.available.through": {
    "ru": "Токен также доступен через",
    "en": "The token is also available through"
  },
  "admin.which.reads.it.from": {
    "ru": ", который читает его из",
    "en": ", which reads it from"
  },
  "admin.the.server.logs.it.only.before.the.first.owner.is.created": {
    "ru": ". Сервер выводит его в журнал только до создания первого владельца.",
    "en": ". The server logs it only before the first owner is created."
  },
  "admin.rotating": {
    "ru": "Заменяем…",
    "en": "Rotating…"
  },
  "admin.rotate.setup.token": {
    "ru": "Заменить токен настройки",
    "en": "Rotate setup token"
  },
  "admin.masked.sign.in.links": {
    "ru": "Маскированные ссылки для входа",
    "en": "Masked sign-in links"
  },
  "admin.the.list.masks.sign.in.links.a.newly.created.or.replaced.link.is": {
    "ru": "В списке ссылки для входа скрыты маской. Новая или заменённая ссылка видна, пока вы не закроете сообщение. Используйте кнопку копирования в строке преподавателя, чтобы снова поделиться его текущей ссылкой.",
    "en": "The list masks sign-in links. A newly created or replaced link is shown until you close its message. Use the copy button on a teacher’s row to share their current link again."
  },
  "admin.lost.your.own.link": {
    "ru": "Если потеряли свою ссылку",
    "en": "Lost your own link"
  },
  "admin.lost.your.link": {
    "ru": "Если потеряли ссылку",
    "en": "Lost your link"
  },
  "admin.the.setup.token.in": {
    "ru": "Токен настройки в",
    "en": "The setup token in"
  },
  "admin.signs.you.in.as.the.longest.standing.current.owner": {
    "ru": "позволяет войти от имени самого давнего из текущих владельцев.",
    "en": "signs you in as the longest-standing current owner."
  },
  "admin.ask.an.owner.to.copy.and.share.your.current.link.if.it.may.have.r": {
    "ru": "Попросите владельца скопировать и передать вашу текущую ссылку. Если она могла попасть к посторонним, попросите заменить её.",
    "en": "Ask an owner to copy and share your current link. If it may have reached someone else, ask them to replace it."
  },
  "admin.a.name.is.required": {
    "ru": "Укажите имя.",
    "en": "A name is required."
  },
  "admin.enter.an.email.address": {
    "ru": "Введите адрес электронной почты.",
    "en": "Enter an email address."
  },
  "admin.could.not.copy.the.token.select.it.and.copy.it.manually": {
    "ru": "Не удалось скопировать токен. Выделите его и скопируйте вручную.",
    "en": "Could not copy the token. Select it and copy it manually."
  },
  "admin.could.not.copy.s.link.try.again.replacing.the.link.will.show.a.ne": {
    "ru": "Не удалось скопировать ссылку для {p0}. Попробуйте снова. Замена ссылки покажет новую и завершит остальные сеансы этого пользователя.",
    "en": "Could not copy {p0}’s link. Try again. Replacing the link will show a new one and sign out their other sessions."
  },
  "admin.could.not.copy.the.link.it.is.selected.copy.it.manually": {
    "ru": "Не удалось скопировать ссылку. Она выделена; скопируйте её вручную.",
    "en": "Could not copy the link. It is selected; copy it manually."
  },
  "admin.language.label": {
    "ru": "Язык интерфейса",
    "en": "Interface language"
  },
  "admin.language.scope": {
    "ru": "Изменится у всех участников.",
    "en": "Changes for everyone on this server."
  },
  "admin.language.current": {
    "ru": "Язык интерфейса: {language}",
    "en": "Interface language: {language}"
  },
  "admin.language.retry": {
    "ru": "Повторить",
    "en": "Try again"
  },
  "admin.language.saving": {
    "ru": "Сохраняем язык…",
    "en": "Saving language…"
  },
  "admin.language.failed": {
    "ru": "Не удалось подтвердить изменение языка. Повторите попытку.",
    "en": "Could not confirm the language change. Try again."
  },
  "admin.role.owner": {
    "ru": "Владелец",
    "en": "Owner"
  },
  "admin.role.teacher": {
    "ru": "Преподаватель",
    "en": "Teacher"
  },
  "admin.unknown.teacher": {
    "ru": "неизвестен",
    "en": "unknown"
  },
  "admin.custom.provider": {
    "ru": "Другой провайдер",
    "en": "Custom provider"
  },
  "admin.oracle.mode.off": {
    "ru": "выключен",
    "en": "off"
  },
  "admin.oracle.mode.hints": {
    "ru": "только подсказки",
    "en": "hints only"
  },
  "admin.oracle.mode.full": {
    "ru": "полные ответы",
    "en": "full answers"
  },
  "admin.count.seminar": {
    "ru": {
      "one": "{count} занятие",
      "few": "{count} занятия",
      "many": "{count} занятий",
      "other": "{count} занятия"
    },
    "en": {
      "one": "{count} class",
      "other": "{count} classes"
    }
  },
  "admin.count.cell": {
    "ru": {
      "one": "{count} ячейка",
      "few": "{count} ячейки",
      "many": "{count} ячеек",
      "other": "{count} ячейки"
    },
    "en": {
      "one": "{count} cell",
      "other": "{count} cells"
    }
  },
  "admin.count.file": {
    "ru": {
      "one": "{count} файл",
      "few": "{count} файла",
      "many": "{count} файлов",
      "other": "{count} файла"
    },
    "en": {
      "one": "{count} file",
      "other": "{count} files"
    }
  },
  "admin.count.step": {
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
  "admin.count.people": {
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
  "admin.count.material": {
    "ru": {
      "one": "{count} материал",
      "few": "{count} материала",
      "many": "{count} материалов",
      "other": "{count} материала"
    },
    "en": {
      "one": "{count} material",
      "other": "{count} materials"
    }
  },
  "admin.count.gpu": {
    "ru": {
      "one": "{count} срез",
      "few": "{count} среза",
      "many": "{count} срезов",
      "other": "{count} среза"
    },
    "en": {
      "one": "{count} slice",
      "other": "{count} slices"
    }
  },
  "admin.count.packages": {
    "ru": {
      "one": "{count} пакет поверх {parent}",
      "few": "{count} пакета поверх {parent}",
      "many": "{count} пакетов поверх {parent}",
      "other": "{count} пакета поверх {parent}"
    },
    "en": {
      "one": "{count} package over {parent}",
      "other": "{count} packages over {parent}"
    }
  },
  "admin.count.skippedFiles": {
    "ru": {
      "one": "{count} файл превышает лимит импорта и будет пропущен:",
      "few": "{count} файла превышают лимит импорта и будут пропущены:",
      "many": "{count} файлов превышают лимит импорта и будут пропущены:",
      "other": "{count} файла превышают лимит импорта и будут пропущены:"
    },
    "en": {
      "one": "{count} file exceeds the import limit and will be skipped:",
      "other": "{count} files exceed the import limit and will be skipped:"
    }
  },
  "admin.count.skippedMoments": {
    "ru": {
      "one": "{count} момент пропущен",
      "few": "{count} момента пропущены",
      "many": "{count} моментов пропущены",
      "other": "{count} момента пропущены"
    },
    "en": {
      "one": "{count} moment skipped",
      "other": "{count} moments skipped"
    }
  },
  "admin.course.deleteHeading": {
    "ru": "Удалить курс «{name}»?",
    "en": "Delete course “{name}”?"
  },
  "admin.seminar.deleteHeading": {
    "ru": "Удалить «{name}»?",
    "en": "Delete “{name}”?"
  },
  "admin.seminar.noMatch": {
    "ru": "Нет занятий по запросу «{query}».",
    "en": "No classes match “{query}”."
  },
  "admin.teacher.rotateHeading": {
    "ru": "Заменить ссылку для входа: {name}?",
    "en": "Rotate {name}’s sign-in link?"
  },
  "admin.teacher.copyLinkLabel": {
    "ru": "Копировать ссылку для входа: {name}",
    "en": "Copy {name}’s sign-in link"
  },
  "admin.course.releaseHeading": {
    "ru": "Освободить адрес /c/{address}?",
    "en": "Release address /c/{address}?"
  },
  "admin.publication.releaseHeading": {
    "ru": "Освободить адрес /p/{address}?",
    "en": "Release address /p/{address}?"
  }
}

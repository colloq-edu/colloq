import type { MessageCatalog } from '../i18n-types.js'

/** Explicit display-copy catalog for entry, room, lecture, and public readers. */
export const roomMessages: MessageCatalog = {
  "room.ui.0": {
    "ru": "Вас удалили с занятия",
    "en": "You were removed from the class"
  },
  "room.ui.1": {
    "ru": "Преподаватель закрыл вход в эту комнату до",
    "en": "The teacher has blocked access to this room until"
  },
  "room.ui.2": {
    "ru": ". После этого ограничение перестанет действовать.",
    "en": ". The restriction will expire after that."
  },
  "room.ui.3": {
    "ru": "Преподаватель может снять ограничение раньше. Обратитесь к нему, если это произошло по ошибке.",
    "en": "The teacher can lift the restriction sooner. Contact them if you think this was a mistake."
  },
  "room.ui.5": {
    "ru": "Настройка сервера:",
    "en": "Server setting:"
  },
  "room.ui.6": {
    "ru": "как на сервере",
    "en": "server default"
  },
  "room.ui.7": {
    "ru": "Оракул о решениях",
    "en": "Oracle review of solutions"
  },
  "room.ui.8": {
    "ru": "Оракул о",
    "en": "Oracle review of"
  },
  "room.ui.9": {
    "ru": "решении",
    "en": "solution"
  },
  "room.ui.10": {
    "ru": "решениях",
    "en": "solutions"
  },
  "room.ui.11": {
    "ru": "· сдано на момент запроса:",
    "en": "· submitted when requested:"
  },
  "room.ui.12": {
    "ru": "Готовит сводку…",
    "en": "Preparing a summary…"
  },
  "room.ui.13": {
    "ru": "Стоп",
    "en": "Stop"
  },
  "room.ui.14": {
    "ru": "с тех пор",
    "en": "since then"
  },
  "room.ui.15": {
    "ru": "сдал",
    "en": "submitted"
  },
  "room.ui.16": {
    "ru": "сдали",
    "en": "submitted"
  },
  "room.ui.17": {
    "ru": "ещё",
    "en": "more"
  },
  "room.ui.18": {
    "ru": "Обновить · 1 вопрос",
    "en": "Refresh · 1 question"
  },
  "room.ui.19": {
    "ru": "Спросить · 1 вопрос",
    "en": "Ask · 1 question"
  },
  "room.ui.20": {
    "ru": "Пока никто не сдал решение.",
    "en": "No solutions submitted yet."
  },
  "room.ui.21": {
    "ru": "Оракул предложит разбор решений и примеры для показа. Провайдеру ИИ передаются задание, контекст и примеры решений. Имена участников к ним не добавляются.",
    "en": "The oracle will suggest a review of solutions and examples to show. The AI provider receives the task, context and example solutions. Participant names are not included."
  },
  "room.ui.22": {
    "ru": "Имена участников не добавляются к запросу. Проверьте выводы оракула.",
    "en": "Participant names are not included in the request. Check the oracle’s conclusions."
  },
  "room.ui.23": {
    "ru": "Что верно",
    "en": "What is correct"
  },
  "room.ui.24": {
    "ru": "Типичная ошибка",
    "en": "Common mistake"
  },
  "room.ui.25": {
    "ru": "Что показать",
    "en": "What to show"
  },
  "room.ui.26": {
    "ru": "Ответ ·",
    "en": "Reply ·"
  },
  "room.ui.27": {
    "ru": "Напишите ответ…",
    "en": "Write a reply…"
  },
  "room.ui.28": {
    "ru": "Отправить",
    "en": "Send"
  },
  "room.ui.29": {
    "ru": "Отмена",
    "en": "Cancel"
  },
  "room.ui.30": {
    "ru": "Черновик оракула. Проверьте перед отправкой от своего имени.",
    "en": "Oracle draft. Review before sending under your name."
  },
  "room.ui.31": {
    "ru": "Ответ получат адресаты · Ctrl/⌘+Enter — отправить",
    "en": "Recipients will receive your reply · Ctrl/⌘+Enter to send"
  },
  "room.ui.34": {
    "ru": "Консилиум",
    "en": "Council"
  },
  "room.ui.35": {
    "ru": "Консилиум закрыт. Попытки доступны для просмотра.",
    "en": "Council is closed. Attempts are available to view."
  },
  "room.ui.36": {
    "ru": "Вид",
    "en": "View"
  },
  "room.ui.37": {
    "ru": "Стопка",
    "en": "Stack"
  },
  "room.ui.38": {
    "ru": "Сводка",
    "en": "Summary"
  },
  "room.ui.39": {
    "ru": "Запросы на запуск ·",
    "en": "Run requests ·"
  },
  "room.ui.40": {
    "ru": "Выберите запрос",
    "en": "Select a request"
  },
  "room.ui.41": {
    "ru": " · черновик",
    "en": " · draft"
  },
  "room.ui.42": {
    "ru": "Первый запрос",
    "en": "First request"
  },
  "room.ui.43": {
    "ru": "ещё никто не сдал —",
    "en": "no submissions yet —"
  },
  "room.ui.44": {
    "ru": "пишет",
    "en": "writing"
  },
  "room.ui.45": {
    "ru": "пишут",
    "en": "writing"
  },
  "room.ui.46": {
    "ru": "Попыток пока нет. Студенты могут написать свои решения.",
    "en": "No attempts yet. Students can write their solutions."
  },
  "room.ui.47": {
    "ru": "попыток не было",
    "en": "no attempts"
  },
  "room.ui.48": {
    "ru": "Предыдущая попытка",
    "en": "Previous attempt"
  },
  "room.ui.49": {
    "ru": "← предыдущая · Shift+← группа",
    "en": "← previous · Shift+← group"
  },
  "room.ui.50": {
    "ru": "сдано",
    "en": "submitted"
  },
  "room.ui.51": {
    "ru": "пишет ·",
    "en": "writing ·"
  },
  "room.ui.52": {
    "ru": "на экране",
    "en": "on screen"
  },
  "room.ui.53": {
    "ru": "так же ещё",
    "en": "same answer from"
  },
  "room.ui.54": {
    "ru": "группа",
    "en": "group"
  },
  "room.ui.55": {
    "ru": "из",
    "en": "of"
  },
  "room.ui.56": {
    "ru": "Следующая попытка",
    "en": "Next attempt"
  },
  "room.ui.57": {
    "ru": "→ следующая · Shift+→ группа",
    "en": "→ next · Shift+→ group"
  },
  "room.ui.58": {
    "ru": "пустой лист",
    "en": "blank page"
  },
  "room.ui.59": {
    "ru": "В очереди",
    "en": "Queued"
  },
  "room.ui.60": {
    "ru": "Выполняется",
    "en": "Running"
  },
  "room.ui.61": {
    "ru": "запускал преподаватель",
    "en": "run by the teacher"
  },
  "room.ui.62": {
    "ru": "запускал автор",
    "en": "run by the author"
  },
  "room.ui.63": {
    "ru": "Загружается результат…",
    "en": "Loading result…"
  },
  "room.ui.64": {
    "ru": "Результат не загружен.",
    "en": "Result not loaded."
  },
  "room.ui.65": {
    "ru": "Просит запустить ·",
    "en": "Requesting a run ·"
  },
  "room.ui.66": {
    "ru": "Отправляю…",
    "en": "Sending…"
  },
  "room.ui.67": {
    "ru": "Разрешить запуск",
    "en": "Allow run"
  },
  "room.ui.68": {
    "ru": "Отклонить",
    "en": "Decline"
  },
  "room.ui.69": {
    "ru": "Запрос на запуск отклонён",
    "en": "Run request declined"
  },
  "room.ui.70": {
    "ru": "· всей группе",
    "en": "· to the whole group"
  },
  "room.ui.71": {
    "ru": "Показать снова",
    "en": "Show again"
  },
  "room.ui.72": {
    "ru": "Показать классу",
    "en": "Show to class"
  },
  "room.ui.73": {
    "ru": "Запустить",
    "en": "Run"
  },
  "room.ui.74": {
    "ru": "Ответить",
    "en": "Reply"
  },
  "room.ui.75": {
    "ru": "Ответить всем",
    "en": "Reply to all"
  },
  "room.ui.76": {
    "ru": "Верно",
    "en": "Correct"
  },
  "room.ui.77": {
    "ru": "Неверно",
    "en": "Incorrect"
  },
  "room.ui.78": {
    "ru": "Удалить с занятия",
    "en": "Remove from class"
  },
  "room.ui.79": {
    "ru": "← → попытка · Shift+← → группа · Enter — показать классу · когда фокус в стопке",
    "en": "← → attempt · Shift+← → group · Enter to show to class · when the stack has focus"
  },
  "room.ui.86": {
    "ru": "Решение не подтвердилось. Проверьте связь и попробуйте ещё раз.",
    "en": "The decision was not confirmed. Check your connection and try again."
  },
  "room.ui.87": {
    "ru": "— ячейка {p0}",
    "en": "— cell {p0}"
  },
  "room.ui.90": {
    "ru": "Группы решений",
    "en": "Solution groups"
  },
  "room.ui.91": {
    "ru": {
      "one": "{count} ещё пишет",
      "few": "{count} ещё пишут",
      "many": "{count} ещё пишут",
      "other": "{count} ещё пишут"
    },
    "en": {
      "one": "{count} still writing",
      "other": "{count} still writing"
    }
  },
  "room.ui.92": {
    "ru": "человек",
    "en": "people"
  },
  "room.ui.93": {
    "ru": "человека",
    "en": "people"
  },
  "room.ui.94": {
    "ru": "попыток пока нет",
    "en": "no attempts yet"
  },
  "room.ui.95": {
    "ru": "так же",
    "en": "same answer"
  },
  "room.ui.96": {
    "ru": "На экране · показать снова",
    "en": "On screen · show again"
  },
  "room.ui.97": {
    "ru": "Открыть попытку",
    "en": "Open attempt"
  },
  "room.ui.98": {
    "ru": "Малые группы",
    "en": "Small groups"
  },
  "room.ui.99": {
    "ru": "группы",
    "en": "groups"
  },
  "room.ui.100": {
    "ru": "групп",
    "en": "groups"
  },
  "room.ui.104": {
    "ru": "Правка не сохранена. Файл открыт только для чтения",
    "en": "Edit not saved. This file is read-only"
  },
  "room.ui.105": {
    "ru": "сохранено ·",
    "en": "saved ·"
  },
  "room.ui.106": {
    "ru": "здесь",
    "en": "here"
  },
  "room.ui.107": {
    "ru": "Открываю",
    "en": "Opening"
  },
  "room.ui.120": {
    "ru": "лиса, кит, динозавр…",
    "en": "fox, whale, dinosaur…"
  },
  "room.ui.121": {
    "ru": "Поиск меток",
    "en": "Search marks"
  },
  "room.ui.122": {
    "ru": "Случайная метка",
    "en": "Surprise me"
  },
  "room.ui.123": {
    "ru": "Ваша метка",
    "en": "Your mark"
  },
  "room.ui.127": {
    "ru": "Такой метки нет. Попробуйте «сова» или выберите случайную.",
    "en": "No mark by that name. Try \"owl\", or take a surprise."
  },
  "room.ui.128": {
    "ru": "серые метки уже заняты участниками комнаты",
    "en": "greyed out means someone in the room already has it"
  },
  "room.ui.132": {
    "ru": "Открыть пульт на планшете",
    "en": "Open console on a tablet"
  },
  "room.ui.133": {
    "ru": "Пульт",
    "en": "Console"
  },
  "room.ui.134": {
    "ru": "Пульт на планшете",
    "en": "Console on a tablet"
  },
  "room.ui.135": {
    "ru": "Откройте ссылку на своём планшете для входа от вашего имени. Она действует",
    "en": "Open this link on your tablet to sign in as yourself. It is valid for"
  },
  "room.ui.136": {
    "ru": "минут и работает один раз. Не отправляйте её другим людям.",
    "en": "minutes and can only be used once. Do not share it with others."
  },
  "room.ui.137": {
    "ru": "Поделиться",
    "en": "Share"
  },
  "room.ui.138": {
    "ru": "Скопировано",
    "en": "Copied"
  },
  "room.ui.139": {
    "ru": "Скопировать",
    "en": "Copy"
  },
  "room.ui.140": {
    "ru": "Обновить",
    "en": "Refresh"
  },
  "room.ui.141": {
    "ru": "Закрыть",
    "en": "Close"
  },
  "room.ui.142": {
    "ru": "Не удалось создать ссылку.",
    "en": "Could not create the link."
  },
  "room.ui.143": {
    "ru": "Не удалось скопировать ссылку. Выделите её и скопируйте вручную.",
    "en": "Could not copy the link. Select it and copy it manually."
  },
  "room.ui.144": {
    "ru": "Пульт лекции",
    "en": "Lecture console"
  },
  "room.ui.145": {
    "ru": "Это занятие удалено",
    "en": "This class was deleted"
  },
  "room.ui.146": {
    "ru": "Файлы, история и чернила лекции удалены.",
    "en": "The files, history and lecture ink were deleted."
  },
  "room.ui.147": {
    "ru": "Пульт доступен преподавателю",
    "en": "The console is available to the teacher"
  },
  "room.ui.148": {
    "ru": "В комнату",
    "en": "Go to room"
  },
  "room.ui.149": {
    "ru": "Не удалось синхронизировать пульт",
    "en": "Could not sync the console"
  },
  "room.ui.150": {
    "ru": "Перезагрузка вкладки не удаляет страницу и чернила лекции на сервере.",
    "en": "Reloading the tab will not delete the lecture page or ink on the server."
  },
  "room.ui.151": {
    "ru": "Перезагрузить",
    "en": "Reload"
  },
  "room.ui.152": {
    "ru": "Страница лекции",
    "en": "Lecture page"
  },
  "room.ui.153": {
    "ru": "Яркость листа",
    "en": "Page brightness"
  },
  "room.ui.156": {
    "ru": "Выбрать страницу",
    "en": "Choose page"
  },
  "room.ui.157": {
    "ru": "Л{p0}",
    "en": "S{p0}"
  },
  "room.ui.158": {
    "ru": "Л{p0}",
    "en": "S{p0}"
  },
  "room.ui.159": {
    "ru": "лист",
    "en": "sheet"
  },
  "room.ui.160": {
    "ru": "подготовка",
    "en": "preparation"
  },
  "room.ui.161": {
    "ru": "Перо",
    "en": "Pen"
  },
  "room.ui.162": {
    "ru": "Маркер",
    "en": "Highlighter"
  },
  "room.ui.164": {
    "ru": "Ластик",
    "en": "Eraser"
  },
  "room.ui.165": {
    "ru": "Указка",
    "en": "Pointer"
  },
  "room.ui.166": {
    "ru": "Отменить последний штрих",
    "en": "Undo last stroke"
  },
  "room.ui.167": {
    "ru": "Слайд",
    "en": "Slide"
  },
  "room.ui.168": {
    "ru": "Лист",
    "en": "Sheet"
  },
  "room.ui.169": {
    "ru": "Вести",
    "en": "Present"
  },
  "room.ui.170": {
    "ru": "Вернуть",
    "en": "Restore"
  },
  "room.ui.171": {
    "ru": "Скрыть",
    "en": "Hide"
  },
  "room.ui.172": {
    "ru": "Взять пульт",
    "en": "Take control"
  },
  "room.ui.173": {
    "ru": "Заметки",
    "en": "Notes"
  },
  "room.ui.174": {
    "ru": "Предыдущая страница",
    "en": "Previous page"
  },
  "room.ui.175": {
    "ru": "Следующая страница",
    "en": "Next page"
  },
  "room.ui.176": {
    "ru": "К слайду",
    "en": "To slide"
  },
  "room.ui.177": {
    "ru": "Вперёд",
    "en": "Next"
  },
  "room.ui.178": {
    "ru": "Ведёт",
    "en": "Presenting"
  },
  "room.ui.180": {
    "ru": "Линия",
    "en": "Line"
  },
  "room.ui.181": {
    "ru": "обводить",
    "en": "trace"
  },
  "room.ui.182": {
    "ru": "Точка",
    "en": "Dot"
  },
  "room.ui.183": {
    "ru": "показывать",
    "en": "point"
  },
  "room.ui.184": {
    "ru": "Цвет пера",
    "en": "Pen color"
  },
  "room.ui.186": {
    "ru": "Толщина",
    "en": "Width"
  },
  "room.ui.188": {
    "ru": "Проекция затемнена",
    "en": "Projection dimmed"
  },
  "room.ui.189": {
    "ru": "Нажмите, чтобы вернуть",
    "en": "Tap to restore"
  },
  "room.ui.190": {
    "ru": "Не удалось открыть документ",
    "en": "Could not open document"
  },
  "room.ui.191": {
    "ru": "Попробовать снова",
    "en": "Try again"
  },
  "room.ui.192": {
    "ru": "Сменить документ",
    "en": "Change document"
  },
  "room.ui.193": {
    "ru": "Во весь экран",
    "en": "Fullscreen"
  },
  "room.ui.194": {
    "ru": "заметки",
    "en": "notes"
  },
  "room.ui.195": {
    "ru": "Что сказать на этой странице…",
    "en": "What to say on this page…"
  },
  "room.ui.196": {
    "ru": "Заметки загружаются",
    "en": "Loading notes"
  },
  "room.ui.197": {
    "ru": "дальше",
    "en": "next"
  },
  "room.ui.198": {
    "ru": "В комнате нет PDF для лекции. Загрузите файл с компьютера.",
    "en": "No lecture PDF in this room. Upload a file from your computer."
  },
  "room.ui.199": {
    "ru": "идёт сейчас",
    "en": "presenting now"
  },
  "room.ui.200": {
    "ru": "Выберите документ",
    "en": "Choose document"
  },
  "room.ui.201": {
    "ru": "Левая рука",
    "en": "Left hand"
  },
  "room.ui.202": {
    "ru": "вкл",
    "en": "on"
  },
  "room.ui.203": {
    "ru": "выкл",
    "en": "off"
  },
  "room.ui.204": {
    "ru": "Выйти из полного экрана",
    "en": "Exit fullscreen"
  },
  "room.ui.205": {
    "ru": "Яркость листа меняется под номером страницы.",
    "en": "Adjust page brightness below the page number."
  },
  "room.ui.206": {
    "ru": "Страницы",
    "en": "Pages"
  },
  "room.ui.207": {
    "ru": "Новый лист",
    "en": "New sheet"
  },
  "room.ui.208": {
    "ru": "Взять пульт у",
    "en": "Take control from"
  },
  "room.ui.209": {
    "ru": "? Управление проекцией перейдёт к вам. Страница и чернила сохранятся.",
    "en": "? You will control the projection. The page and ink will be preserved."
  },
  "room.ui.210": {
    "ru": "Начать лекцию по",
    "en": "Start a lecture using"
  },
  "room.ui.211": {
    "ru": "? Чернила текущей лекции сотрутся. Новый документ откроется с первой страницы, таймер начнёт отсчёт заново.",
    "en": "? Current lecture ink will be erased. The new document will open on page one and the timer will restart."
  },
  "room.ui.212": {
    "ru": "Начать заново",
    "en": "Start over"
  },
  "room.ui.213": {
    "ru": "Документ",
    "en": "Document"
  },
  "room.ui.214": {
    "ru": "лекция идёт",
    "en": "lecture in progress"
  },
  "room.ui.215": {
    "ru": "Рисовать пальцем",
    "en": "Draw with your finger"
  },
  "room.ui.216": {
    "ru": "Вернуться к слайду",
    "en": "Return to slide"
  },
  "room.ui.217": {
    "ru": "Чистый лист",
    "en": "Blank sheet"
  },
  "room.ui.218": {
    "ru": "листов:",
    "en": "sheets:"
  },
  "room.ui.219": {
    "ru": "Сменить документ…",
    "en": "Change document…"
  },
  "room.ui.220": {
    "ru": "Стереть чернила с этой страницы?",
    "en": "Erase ink on this page?"
  },
  "room.ui.221": {
    "ru": "Стереть",
    "en": "Erase"
  },
  "room.ui.222": {
    "ru": "Стереть чернила",
    "en": "Erase ink"
  },
  "room.ui.223": {
    "ru": "Автоблокировка экрана",
    "en": "Screen auto-lock"
  },
  "room.ui.224": {
    "ru": "Пульт удерживает экран включённым, пока вкладка видна.",
    "en": "The console keeps the screen on while the tab is visible."
  },
  "room.ui.225": {
    "ru": "Не удалось отключить автоблокировку.",
    "en": "Could not disable auto-lock."
  },
  "room.ui.226": {
    "ru": "Браузер не поддерживает отключение автоблокировки.",
    "en": "This browser cannot disable auto-lock."
  },
  "room.ui.227": {
    "ru": "Защита от случайного выхода",
    "en": "Prevent accidental exit"
  },
  "room.ui.228": {
    "ru": "Закончить лекцию? Проекция погаснет, чернила сотрутся.",
    "en": "End the lecture? The projection will turn off and ink will be erased."
  },
  "room.ui.229": {
    "ru": "Заметки останутся.",
    "en": "Notes will be preserved."
  },
  "room.ui.230": {
    "ru": "Закончить",
    "en": "End"
  },
  "room.ui.231": {
    "ru": "Закончить лекцию",
    "en": "End lecture"
  },
  "room.ui.232": {
    "ru": "Закончить подготовку",
    "en": "End preparation"
  },
  "room.ui.236": {
    "ru": "Очень тонкое",
    "en": "Extra fine"
  },
  "room.ui.237": {
    "ru": "Тонкое",
    "en": "Fine"
  },
  "room.ui.238": {
    "ru": "Среднее",
    "en": "Medium"
  },
  "room.ui.239": {
    "ru": "Толстое",
    "en": "Thick"
  },
  "room.ui.240": {
    "ru": "Очень толстое",
    "en": "Extra thick"
  },
  "room.ui.241": {
    "ru": "Нет связи. Не удалось отменить штрих.",
    "en": "Offline. Could not undo the stroke."
  },
  "room.ui.242": {
    "ru": "Нет связи. Не удалось стереть чернила.",
    "en": "Offline. Could not erase ink."
  },
  "room.ui.243": {
    "ru": "Страница очищена",
    "en": "Page cleared"
  },
  "room.ui.244": {
    "ru": "Рисование пальцем выключено: используется перо.",
    "en": "Finger drawing is off: pen in use."
  },
  "room.ui.245": {
    "ru": "Полный свет",
    "en": "Full light"
  },
  "room.ui.246": {
    "ru": "Свет зала",
    "en": "Room light"
  },
  "room.ui.247": {
    "ru": "Ночь",
    "en": "Night"
  },
  "room.ui.250": {
    "ru": "Настройки → Экран и яркость → Автоблокировка → Никогда.",
    "en": "Settings → Display & Brightness → Auto-Lock → Never."
  },
  "room.ui.251": {
    "ru": "На iPad включите «Гид-доступ» в настройках универсального доступа и запустите его для браузера.",
    "en": "On iPad, enable Guided Access in Accessibility settings and start it for the browser."
  },
  "room.ui.252": {
    "ru": "Нет связи. Команда отправится после подключения.",
    "en": "Offline. The command will be sent when connected."
  },
  "room.ui.253": {
    "ru": "Лекция закончена",
    "en": "Lecture ended"
  },
  "room.ui.254": {
    "ru": "Экран может погаснуть — см. «Ещё»",
    "en": "The screen may lock — see “More”"
  },
  "room.ui.255": {
    "ru": "Нет связи. Не удалось закончить лекцию.",
    "en": "Offline. Could not end the lecture."
  },
  "room.ui.273": {
    "ru": "Лист для рисования",
    "en": "Drawing sheet"
  },
  "room.ui.274": {
    "ru": "Нет связи. Не удалось стереть штрих.",
    "en": "Offline. Could not erase the stroke."
  },
  "room.ui.276": {
    "ru": "пауза",
    "en": "paused"
  },
  "room.ui.277": {
    "ru": "Выйти из проекции — Escape",
    "en": "Exit projection — Escape"
  },
  "room.ui.278": {
    "ru": "Выйти из проекции",
    "en": "Exit projection"
  },
  "room.ui.279": {
    "ru": "← → листать · ",
    "en": "← → turn pages · "
  },
  "room.ui.280": {
    "ru": "щелчок или F — во весь экран",
    "en": "click or F for fullscreen"
  },
  "room.ui.282": {
    "ru": "Указка — ведите пальцем или пером",
    "en": "Pointer — move your finger or pen"
  },
  "room.ui.283": {
    "ru": "Листать страницы пальцем",
    "en": "Turn pages with your finger"
  },
  "room.ui.284": {
    "ru": "Рука",
    "en": "Hand"
  },
  "room.ui.285": {
    "ru": "Убрать последний штрих — Z",
    "en": "Undo last stroke — Z"
  },
  "room.ui.286": {
    "ru": "Отменить",
    "en": "Undo"
  },
  "room.ui.287": {
    "ru": "Стереть чернила с этой страницы — E",
    "en": "Erase ink on this page — E"
  },
  "room.ui.288": {
    "ru": "Стереть всё?",
    "en": "Erase all?"
  },
  "room.ui.290": {
    "ru": "Погасить проекцию — B. У вас страница останется",
    "en": "Blank projection — B. Your page will stay visible"
  },
  "room.ui.291": {
    "ru": "Пауза",
    "en": "Pause"
  },
  "room.ui.293": {
    "ru": "Закончить лекцию: проекция погаснет, чернила сотрутся",
    "en": "End lecture: projection turns off and ink is erased"
  },
  "room.ui.294": {
    "ru": "Закончить лекцию?",
    "en": "End lecture?"
  },
  "room.ui.295": {
    "ru": "Занятие закончено. Управлять лекцией может преподаватель. Страница и чернила остаются доступны.",
    "en": "The class has ended. The teacher can control the lecture. The page and ink remain available."
  },
  "room.ui.296": {
    "ru": "чистый лист",
    "en": "blank sheet"
  },
  "room.ui.297": {
    "ru": "Лекцию ведёт",
    "en": "Lecture presented by"
  },
  "room.ui.298": {
    "ru": "Листать документ самостоятельно",
    "en": "Browse the document independently"
  },
  "room.ui.299": {
    "ru": "Читать самому",
    "en": "Read on my own"
  },
  "room.ui.300": {
    "ru": "Открыть проекцию во весь экран",
    "en": "Open projection in fullscreen"
  },
  "room.ui.301": {
    "ru": "На проектор",
    "en": "Project"
  },
  "room.ui.303": {
    "ru": "Не удалось открыть документ лекции.",
    "en": "Could not open the lecture document."
  },
  "room.ui.304": {
    "ru": "Нет связи. Не удалось изменить чернила.",
    "en": "Offline. Could not change ink."
  },
  "room.ui.307": {
    "ru": "У этой страницы есть заметка",
    "en": "This page has a note"
  },
  "room.ui.308": {
    "ru": "Идёт лекция",
    "en": "Lecture in progress"
  },
  "room.ui.309": {
    "ru": "Изменить размер текста заметок",
    "en": "Change note text size"
  },
  "room.ui.310": {
    "ru": "Переключить размер текста заметок",
    "en": "Switch note text size"
  },
  "room.ui.312": {
    "ru": "Ещё",
    "en": "More"
  },
  "room.ui.313": {
    "ru": "Ещё: во весь экран, левая рука, сменить документ, закончить",
    "en": "More: fullscreen, left hand, change document, end"
  },
  "room.ui.314": {
    "ru": "Заметки доступны только для страниц документа.",
    "en": "Notes are available for document pages only."
  },
  "room.ui.315": {
    "ru": "Заметок к этой странице нет.",
    "en": "No notes for this page."
  },
  "room.ui.316": {
    "ru": "осталось",
    "en": "remaining"
  },
  "room.ui.320": {
    "ru": "Перо, чёрное",
    "en": "Pen, black"
  },
  "room.ui.321": {
    "ru": "чёрный",
    "en": "black"
  },
  "room.ui.322": {
    "ru": "Перо, красное",
    "en": "Pen, red"
  },
  "room.ui.323": {
    "ru": "красный",
    "en": "red"
  },
  "room.ui.324": {
    "ru": "Перо, зелёное",
    "en": "Pen, green"
  },
  "room.ui.325": {
    "ru": "зелёный",
    "en": "green"
  },
  "room.ui.326": {
    "ru": "Перо, оранжевое",
    "en": "Pen, orange"
  },
  "room.ui.327": {
    "ru": "оранжевый",
    "en": "orange"
  },
  "room.ui.329": {
    "ru": "Вывод ячейки",
    "en": "Cell output"
  },
  "room.ui.330": {
    "ru": "Свернуть",
    "en": "Show less"
  },
  "room.ui.331": {
    "ru": "Показать больше",
    "en": "Show more"
  },
  "room.ui.333": {
    "ru": "Открыта для всех",
    "en": "Open to everyone"
  },
  "room.ui.334": {
    "ru": "Текст общей ячейки виден группе. Ответы студентов открываются отдельно.",
    "en": "The shared cell text is visible to the group. Student answers open separately."
  },
  "room.ui.335": {
    "ru": "Запуск студентам",
    "en": "Student runs"
  },
  "room.ui.336": {
    "ru": "Только преподаватель",
    "en": "Teacher only"
  },
  "room.ui.337": {
    "ru": "Студенты запускают сами",
    "en": "Students run independently"
  },
  "room.ui.338": {
    "ru": "По запросу преподавателю",
    "en": "Request teacher permission"
  },
  "room.ui.339": {
    "ru": "Настройка применяется в режиме «Консилиум».",
    "en": "This setting applies in Council mode."
  },
  "room.ui.340": {
    "ru": "Редактировать текстовую ячейку",
    "en": "Edit text cell"
  },
  "room.ui.341": {
    "ru": "Переместить ячейку вверх",
    "en": "Move cell up"
  },
  "room.ui.342": {
    "ru": "Переместить ячейку вниз",
    "en": "Move cell down"
  },
  "room.ui.343": {
    "ru": "Создать копию ячейки",
    "en": "Duplicate cell"
  },
  "room.ui.344": {
    "ru": "Попросить оракула изменить ячейку",
    "en": "Ask the oracle to change this cell"
  },
  "room.ui.345": {
    "ru": "Очистить вывод ячейки",
    "en": "Clear cell output"
  },
  "room.ui.346": {
    "ru": "Удалить ячейку",
    "en": "Delete cell"
  },
  "room.ui.349": {
    "ru": "На экране",
    "en": "On screen"
  },
  "room.ui.350": {
    "ru": "преподаватель показал ваш вариант классу",
    "en": "the teacher showed your answer to the class"
  },
  "room.ui.352": {
    "ru": "· доступно преподавателю",
    "en": "· available to the teacher"
  },
  "room.ui.353": {
    "ru": "ваш черновик отправляется преподавателю",
    "en": "your draft is being sent to the teacher"
  },
  "room.ui.354": {
    "ru": "Ваша версия…",
    "en": "Your version…"
  },
  "room.ui.355": {
    "ru": "превышен лимит символов — сократите ответ",
    "en": "character limit exceeded — shorten your answer"
  },
  "room.ui.356": {
    "ru": "Сдать",
    "en": "Submit"
  },
  "room.ui.357": {
    "ru": "⌘⇧↵ — сдать",
    "en": "⌘⇧↵ to submit"
  },
  "room.ui.358": {
    "ru": "Изменить",
    "en": "Edit"
  },
  "room.ui.360": {
    "ru": "Отменяю…",
    "en": "Cancelling…"
  },
  "room.ui.364": {
    "ru": "Преподаватель не запустил. Можно нажать снова.",
    "en": "The teacher did not run it. You can press again."
  },
  "room.ui.366": {
    "ru": "Пусто — дважды щёлкните, чтобы написать.",
    "en": "Empty — double-click to write."
  },
  "room.ui.367": {
    "ru": "Пусто.",
    "en": "Empty."
  },
  "room.ui.368": {
    "ru": "Консилиум — ячейка",
    "en": "Council — cell"
  },
  "room.ui.369": {
    "ru": "Здесь появятся ответы студентов. Черновики обновляются после паузы в наборе.",
    "en": "Student answers will appear here. Drafts update after a pause in typing."
  },
  "room.ui.370": {
    "ru": "Консилиум закрыт",
    "en": "Council closed"
  },
  "room.ui.371": {
    "ru": "Свернуть черновик",
    "en": "Hide draft"
  },
  "room.ui.372": {
    "ru": "Показать черновик",
    "en": "Show draft"
  },
  "room.ui.1222": {
    "ru": "у каждого свой лист · ваш текст видит только преподаватель",
    "en": "everyone writes their own sheet · only the teacher sees your text"
  },
  "room.ui.1224": {
    "ru": "Сдано {p0} · ждёт разбора",
    "en": "Submitted {p0} · awaiting review"
  },
  "room.ui.1225": {
    "ru": "✓ Верно",
    "en": "✓ Correct"
  },
  "room.ui.1226": {
    "ru": "✗ Есть ошибка",
    "en": "✗ Has an error"
  },
  "room.ui.1227": {
    "ru": "Ваш вариант на экране",
    "en": "Your answer is on screen"
  },
  "room.ui.1228": {
    "ru": "Есть правки",
    "en": "Unsent edits"
  },
  "room.ui.1229": {
    "ru": "Сдать заново",
    "en": "Submit again"
  },
  "room.ui.1230": {
    "ru": "запускает преподаватель",
    "en": "the teacher runs this one"
  },
  "room.ui.1231": {
    "ru": "В этой ячейке запускает преподаватель. Сдать — кнопкой справа.",
    "en": "In this cell the teacher runs the code. To submit, use the button on the right."
  },
  "room.ui.1232": {
    "ru": "Восстановить",
    "en": "Restore"
  },
  "room.ui.1233": {
    "ru": "Вернуть исходную ячейку?",
    "en": "Restore the original cell?"
  },
  "room.ui.1234": {
    "ru": "Вернуть",
    "en": "Restore"
  },
  "room.ui.1235": {
    "ru": "Отмена",
    "en": "Cancel"
  },
  "room.ui.1236": {
    "ru": "В очереди · вы {p0}-й",
    "en": "In queue · you are number {p0}"
  },
  "room.ui.1238": {
    "ru": "отменить",
    "en": "cancel"
  },
  "room.ui.1239": {
    "ru": "Ответ преподавателя",
    "en": "Teacher’s reply"
  },
  "room.ui.1240": {
    "ru": "Вернуть заготовку преподавателя — то, с чего лист начинался",
    "en": "Restore the teacher’s stub — the text this sheet started from"
  },
  "room.ui.1241": {
    "ru": "сдано · текст закрыт для правки",
    "en": "submitted · the text is locked"
  },
  "room.ui.1242": {
    "ru": "сдано {p0} · разобрано {p1}",
    "en": "submitted {p0} · reviewed {p1}"
  },
  "room.ui.1243": {
    "ru": "сдано {p0} · разобрано",
    "en": "submitted {p0} · reviewed"
  },
  "room.ui.1244": {
    "ru": "сдано · отметки пока нет",
    "en": "submitted · no mark yet"
  },
  "room.ui.1245": {
    "ru": "текст изменён после разбора",
    "en": "the text changed after the review"
  },
  "room.ui.1246": {
    "ru": "текст изменён после сдачи",
    "en": "the text changed after submission"
  },
  "room.ui.1247": {
    "ru": "было:",
    "en": "was:"
  },
  "room.ui.1248": {
    "ru": "Исправить",
    "en": "Fix"
  },
  "room.ui.1249": {
    "ru": "— уже исходная",
    "en": "— already the original"
  },
  "room.ui.1250": {
    "ru": "Ваш текст будет заменён заготовкой, вывод очистится.",
    "en": "Your text will be replaced by the stub, and the output cleared."
  },
  "room.ui.1251": {
    "ru": "преподаватель",
    "en": "teacher"
  },
  "room.ui.1252": {
    "ru": "Сдано {p0}",
    "en": "Submitted {p0}"
  },
  "room.ui.1260": {
    "ru": "В очереди",
    "en": "In queue"
  },
  "room.ui.1261": {
    "ru": "оракул",
    "en": "oracle"
  },
  "room.ui.1262": {
    "ru": "Подсказка оракула",
    "en": "Ask the oracle"
  },
  "room.ui.1263": {
    "ru": "Оракул думает…",
    "en": "The oracle is thinking…"
  },
  "room.ui.1264": {
    "ru": "Спросить оракула, почему упал ваш запуск. Ответ увидите вы и преподаватель",
    "en": "Ask the oracle why your run failed. Only you and the teacher see the answer"
  },
  "room.ui.1265": {
    "ru": "· подсказка оракула, попросил студент",
    "en": "· oracle hint, asked by the student"
  },
  "room.ui.1266": {
    "ru": "В этой ячейке оракул только отвечает: менять её может преподаватель",
    "en": "In this cell the oracle only answers: the teacher changes it"
  },
  "room.ui.1267": {
    "ru": "Скопировать",
    "en": "Copy"
  },
  "room.ui.1268": {
    "ru": "Скопировано",
    "en": "Copied"
  },
  "room.ui.1900": {
    "ru": "Скопировать текст ячейки",
    "en": "Copy the cell text"
  },
  "room.ui.373": {
    "ru": "Что должна делать эта ячейка?",
    "en": "What should this cell do instead?"
  },
  "room.ui.374": {
    "ru": "Спрашиваем…",
    "en": "Asking…"
  },
  "room.ui.375": {
    "ru": "Попросить переписать",
    "en": "Ask for a rewrite"
  },
  "room.ui.376": {
    "ru": "Отмена",
    "en": "Cancel"
  },
  "room.ui.377": {
    "ru": "Вопрос и ответ видит вся комната.",
    "en": "The whole room sees the question and the answer."
  },
  "room.ui.378": {
    "ru": "Предложение оракула",
    "en": "Proposed by the oracle"
  },
  "room.ui.379": {
    "ru": "Ячейку изменили после запроса. Применение предложения заменит её текущий текст.",
    "en": "The cell changed after this request. Applying the suggestion will replace its current text."
  },
  "room.ui.380": {
    "ru": "Отклонить",
    "en": "Discard"
  },
  "room.ui.381": {
    "ru": "Всё равно применить",
    "en": "Apply anyway"
  },
  "room.ui.382": {
    "ru": "Принять",
    "en": "Accept"
  },
  "room.ui.383": {
    "ru": "Изменение обновит общую ячейку. Автором будете указаны вы.",
    "en": "Applying updates the shared cell and records you as the author."
  },
  "room.ui.384": {
    "ru": "Сохранённый вывод прошлого запуска. Ядро перезапустилось или ячейку восстановили.",
    "en": "Saved output from an earlier run. The kernel restarted or the cell was restored."
  },
  "room.ui.385": {
    "ru": "Ввод",
    "en": "Input"
  },
  "room.ui.386": {
    "ru": "Отправить",
    "en": "Send"
  },
  "room.ui.387": {
    "ru": "Ядро ждёт вашего ответа.",
    "en": "The kernel is waiting for your answer."
  },
  "room.ui.388": {
    "ru": "Занятие закончено — на ввод отвечает преподаватель.",
    "en": "The class has ended — the teacher provides input."
  },
  "room.ui.389": {
    "ru": "Ядро ждёт —",
    "en": "The kernel is waiting —"
  },
  "room.ui.390": {
    "ru": "отвечает запустивший эту ячейку",
    "en": "whoever started this cell"
  },
  "room.ui.391": {
    "ru": "или преподаватель.",
    "en": "or the teacher answers."
  },
  "room.ui.392": {
    "ru": "Ожидание",
    "en": "Waiting"
  },
  "room.ui.393": {
    "ru": "Выполняется",
    "en": "Running"
  },
  "room.ui.394": {
    "ru": "запустил",
    "en": "started by"
  },
  "room.ui.395": {
    "ru": "Прервать",
    "en": "Interrupt"
  },
  "room.ui.396": {
    "ru": "Ожидает в очереди на запуск",
    "en": "Waiting in the run queue"
  },
  "room.ui.397": {
    "ru": "в очереди",
    "en": "in queue"
  },
  "room.ui.398": {
    "ru": "В очереди",
    "en": "Queued"
  },
  "room.ui.399": {
    "ru": "от",
    "en": "by"
  },
  "room.ui.400": {
    "ru": "Исправить с ИИ",
    "en": "Fix with AI"
  },
  "room.ui.401": {
    "ru": "передаёт ошибку, эту ячейку и тетрадь",
    "en": "sends the traceback, this cell and the notebook"
  },
  "room.ui.407": {
    "ru": "Сдача не подтвердилась — проверьте связь и нажмите ещё раз.",
    "en": "Submission was not confirmed — check your connection and try again."
  },
  "room.ui.408": {
    "ru": "Ответ не пришёл — проверьте связь и нажмите ещё раз.",
    "en": "No reply received — check your connection and try again."
  },
  "room.ui.409": {
    "ru": "Сдать нельзя: в попытке {p0} знаков. Сократите ответ до указанного лимита.",
    "en": "Cannot submit: your attempt has {p0} characters. Shorten it to the indicated limit."
  },
  "room.ui.410": {
    "ru": "Для запуска нужно разрешение преподавателя. Нажмите «Попросить запуск».",
    "en": "Teacher permission is required to run. Click “Request run”."
  },
  "room.ui.411": {
    "ru": "Запускать ответы может только преподаватель. Сдайте решение, чтобы передать его на проверку.",
    "en": "Only the teacher can run answers. Submit your solution for review."
  },
  "room.ui.412": {
    "ru": "Ответ на запрос запуска не пришёл. Проверьте связь и попробуйте ещё раз.",
    "en": "No reply to the run request. Check your connection and try again."
  },
  "room.ui.414": {
    "ru": "Оракул недоступен.",
    "en": "Oracle unavailable."
  },
  "room.ui.415": {
    "ru": "Закрыта",
    "en": "Closed"
  },
  "room.ui.416": {
    "ru": "редактирует и запускает преподаватель",
    "en": "only the teacher can edit and run"
  },
  "room.ui.417": {
    "ru": "Открыта всем",
    "en": "Open to all"
  },
  "room.ui.418": {
    "ru": "все редактируют общую ячейку",
    "en": "everyone edits the shared cell"
  },
  "room.ui.419": {
    "ru": "у каждого свой ответ, доступный преподавателю",
    "en": "each student has an answer available to the teacher"
  },
  "room.ui.421": {
    "ru": "Запустил(а): {p0}",
    "en": "Ran by {p0}"
  },
  "room.ui.422": {
    "ru": "{p0} редактирует здесь",
    "en": "{p0} is editing here"
  },
  "room.ui.423": {
    "ru": "{p0} и {p1} редактируют здесь",
    "en": "{p0} and {p1} are editing here"
  },
  "room.ui.424": {
    "ru": "{p0}, {p1} и ещё {p2} редактируют здесь",
    "en": "{p0}, {p1} and {p2} more are editing here"
  },
  "room.ui.425": {
    "ru": "Оракула на этом занятии нет",
    "en": "The oracle is not enabled for this class"
  },
  "room.ui.426": {
    "ru": "Здесь оракул подсказывает, но ячейку не переписывает",
    "en": "Here the oracle offers hints but does not rewrite cells"
  },
  "room.ui.427": {
    "ru": "Оракул сейчас недоступен",
    "en": "The oracle is currently unavailable"
  },
  "room.ui.428": {
    "ru": "В ячейке остался вывод. Для удаления нажмите корзину или дважды D.",
    "en": "The cell still has output. To delete it, click the trash icon or press D twice."
  },
  "room.ui.429": {
    "ru": "Не удалось связаться с оракулом",
    "en": "The oracle could not be reached"
  },
  "room.ui.435": {
    "ru": "Редактор ячейки загружается",
    "en": "Cell editor, loading"
  },
  "room.ui.440": {
    "ru": "Добавить ячейку с кодом",
    "en": "Insert code cell"
  },
  "room.ui.441": {
    "ru": "Код",
    "en": "Code"
  },
  "room.ui.442": {
    "ru": "Добавить текстовую ячейку — Markdown",
    "en": "Insert a text cell — markdown"
  },
  "room.ui.443": {
    "ru": "Текст",
    "en": "Text"
  },
  "room.ui.444": {
    "ru": "Лекция",
    "en": "Lecture"
  },
  "room.ui.445": {
    "ru": "— ячейки редактирует и запускает преподаватель. Открытые для группы ячейки помечены.",
    "en": "— the teacher edits and runs cells. Cells open to the group are marked."
  },
  "room.ui.446": {
    "ru": "Запустить всё",
    "en": "Run all"
  },
  "room.ui.447": {
    "ru": "Удерживайте, чтобы перезапустить ядро",
    "en": "Hold to restart the kernel"
  },
  "room.ui.448": {
    "ru": "Перезапустить",
    "en": "Restart"
  },
  "room.ui.449": {
    "ru": "Очистить",
    "en": "Clear"
  },
  "room.ui.450": {
    "ru": "Форматировать",
    "en": "Format"
  },
  "room.ui.451": {
    "ru": "ядро остановлено",
    "en": "kernel stopped"
  },
  "room.ui.452": {
    "ru": "Ячейки ожидают ядро",
    "en": "Cells waiting for the kernel"
  },
  "room.ui.453": {
    "ru": "в очереди",
    "en": "queued"
  },
  "room.ui.454": {
    "ru": "Тетрадь загружается…",
    "en": "Loading notebook…"
  },
  "room.ui.455": {
    "ru": "Добавить ячейку с кодом в конец",
    "en": "Add a code cell at the end"
  },
  "room.ui.456": {
    "ru": "Добавить текстовую ячейку в конец — Markdown",
    "en": "Add a text cell at the end — markdown"
  },
  "room.ui.457": {
    "ru": "A / B — добавить · ⇧↵ — запустить и перейти ·",
    "en": "A / B to insert · ⇧↵ run & next ·"
  },
  "room.ui.458": {
    "ru": "↵ — запустить на месте",
    "en": "↵ run in place"
  },
  "room.ui.488": {
    "ru": "Оракул",
    "en": "Oracle"
  },
  "room.ui.489": {
    "ru": "Вопросы и ответы доступны всем участникам",
    "en": "Questions and answers are visible to all participants"
  },
  "room.ui.490": {
    "ru": "общая ·",
    "en": "shared ·"
  },
  "room.ui.492": {
    "ru": "Очистить ленту комнаты",
    "en": "Clear the room feed"
  },
  "room.ui.493": {
    "ru": "Очистить?",
    "en": "Clear?"
  },
  "room.ui.494": {
    "ru": "Вопросов пока нет.",
    "en": "No questions yet."
  },
  "room.ui.495": {
    "ru": "Задайте вопрос по материалам занятия. Ваше имя, вопрос и ответ будут видны всей группе.",
    "en": "Ask about the class materials. Your name, question and answer will be visible to the whole group."
  },
  "room.ui.496": {
    "ru": "Оракул получает контекст тетрадей в пределах заданного лимита. Выделите ячейки, которым нужно уделить внимание.",
    "en": "The oracle receives notebook context within the configured limit. Select cells that need attention."
  },
  "room.ui.497": {
    "ru": "ваш ответ",
    "en": "your reply"
  },
  "room.ui.498": {
    "ru": "ответ · {p0}",
    "en": "reply · {p0}"
  },
  "room.ui.499": {
    "ru": "Убрать",
    "en": "Remove"
  },
  "room.ui.500": {
    "ru": "Не удалось проверить доступность оракула.",
    "en": "Could not check oracle availability."
  },
  "room.ui.501": {
    "ru": "Проверить ещё раз",
    "en": "Check again"
  },
  "room.ui.502": {
    "ru": "режим подсказок — модели задано направлять вас к решению",
    "en": "hint mode — the model is instructed to guide you toward a solution"
  },
  "room.ui.503": {
    "ru": "Оракул выключен на этом Colloq.",
    "en": "The oracle is disabled on this Colloq instance."
  },
  "room.ui.504": {
    "ru": "Оракул выключен на этом занятии.",
    "en": "The oracle is disabled for this class."
  },
  "room.ui.505": {
    "ru": "Проверьте настройки раздела",
    "en": "Check the"
  },
  "room.ui.506": {
    "ru": "в панели преподавателя: подключение к модели и лимит вопросов.",
    "en": "settings in the teacher panel: model connection and question limit."
  },
  "room.ui.507": {
    "ru": "Оракул недоступен. Обратитесь к преподавателю.",
    "en": "The oracle is unavailable. Contact the teacher."
  },
  "room.ui.508": {
    "ru": "Код и выводы ячеек, список файлов, состояние ядра и последние сообщения. Объём контекста ограничен.",
    "en": "Cell code and output, file list, kernel state and recent messages. Context size is limited."
  },
  "room.ui.509": {
    "ru": "Источники",
    "en": "Sources"
  },
  "room.ui.510": {
    "ru": "Выбранные ячейки и открытый файл добавляются к контексту. Остальные материалы из него не исключаются.",
    "en": "Selected cells and the open file are added to context. Other materials are still included."
  },
  "room.ui.511": {
    "ru": "В фокусе",
    "en": "Focus"
  },
  "room.ui.513": {
    "ru": "Спросить",
    "en": "Ask"
  },
  "room.ui.514": {
    "ru": "Сделать",
    "en": "Act"
  },
  "room.ui.515": {
    "ru": "Enter — отправить, Shift+Enter — новая строка",
    "en": "Enter to send, Shift+Enter for a new line"
  },
  "room.ui.516": {
    "ru": "Оракул может менять файлы и запускать код. Правки ячеек требуют принятия.",
    "en": "The oracle can change files and run code. Cell edits require acceptance."
  },
  "room.ui.517": {
    "ru": "Вопрос и ответ видит вся комната.",
    "en": "The whole room sees the question and answer."
  },
  "room.ui.519": {
    "ru": "{p0} печатает вопрос…",
    "en": "{p0} is typing a question…"
  },
  "room.ui.520": {
    "ru": "{p0} и {p1} печатают вопросы…",
    "en": "{p0} and {p1} are typing questions…"
  },
  "room.ui.521": {
    "ru": {
      "one": "{count} человек печатает вопрос…",
      "few": "{count} человека печатают вопросы…",
      "many": "{count} человек печатают вопросы…",
      "other": "{count} человек печатают вопросы…"
    },
    "en": {
      "one": "{count} person is typing a question…",
      "other": "{count} people are typing questions…"
    }
  },
  "room.ui.522": {
    "ru": "тетрадь",
    "en": "notebook"
  },
  "room.ui.523": {
    "ru": "тетради",
    "en": "notebooks"
  },
  "room.ui.524": {
    "ru": "тетрадей",
    "en": "notebooks"
  },
  "room.ui.525": {
    "ru": "· список файлов: {p0}",
    "en": "· file list: {p0}"
  },
  "room.ui.526": {
    "ru": "ячейка {p0}",
    "en": "cell {p0}"
  },
  "room.ui.527": {
    "ru": "ячейки {p0}",
    "en": "cells {p0}"
  },
  "room.ui.528": {
    "ru": "ячейку {p0}",
    "en": "cell {p0}"
  },
  "room.ui.529": {
    "ru": "Не удалось отправить вопрос. Попробуйте ещё раз.",
    "en": "Could not send the question. Try again."
  },
  "room.ui.530": {
    "ru": "Не удалось остановить ответ.",
    "en": "Could not stop the answer."
  },
  "room.ui.531": {
    "ru": "Не удалось очистить ленту.",
    "en": "Could not clear the feed."
  },
  "room.ui.532": {
    "ru": "Копировать",
    "en": "Copy"
  },
  "room.ui.533": {
    "ru": "Добавить код в новую ячейку",
    "en": "Add code to a new cell"
  },
  "room.ui.534": {
    "ru": "В ячейку",
    "en": "To cell"
  },
  "room.ui.540": {
    "ru": "Что сделать с участником",
    "en": "Participant actions"
  },
  "room.ui.541": {
    "ru": "Удалить с занятия…",
    "en": "Remove from class…"
  },
  "room.ui.542": {
    "ru": "Удаляем…",
    "en": "Removing…"
  },
  "room.ui.543": {
    "ru": "Не получилось удалить с занятия.",
    "en": "Could not remove the participant."
  },
  "room.ui.544": {
    "ru": "вы",
    "en": "you"
  },
  "room.ui.545": {
    "ru": "думает",
    "en": "thinking"
  },
  "room.ui.546": {
    "ru": "думал",
    "en": "thought for"
  },
  "room.ui.547": {
    "ru": "думает…",
    "en": "thinking…"
  },
  "room.ui.549": {
    "ru": "код",
    "en": "code"
  },
  "room.ui.550": {
    "ru": "готовит следующий шаг",
    "en": "preparing the next step"
  },
  "room.ui.551": {
    "ru": "Оракул не ответил.",
    "en": "The oracle did not answer."
  },
  "room.ui.552": {
    "ru": "Повторить",
    "en": "Retry"
  },
  "room.ui.553": {
    "ru": "Отмена вернёт прежний текст файлов, если после этого их не меняли. Созданные файлы останутся пустыми. Последствия запуска кода не отменяются.",
    "en": "Undo restores previous file text if it has not changed since. Created files will remain empty. Code execution effects cannot be undone."
  },
  "room.ui.554": {
    "ru": "Отменить правки файлов",
    "en": "Undo file changes"
  },
  "room.ui.555": {
    "ru": "Отмена завершена",
    "en": "Undo complete"
  },
  "room.ui.556": {
    "ru": ": восстановлены файлы, которые не менялись после действий оракула.",
    "en": ": restored files that have not changed since the oracle’s actions."
  },
  "room.ui.557": {
    "ru": "Применено",
    "en": "Applied"
  },
  "room.ui.558": {
    "ru": "Предложено",
    "en": "Suggested"
  },
  "room.ui.559": {
    "ru": "ячейку с тех пор поменяли",
    "en": "the cell has changed since"
  },
  "room.ui.560": {
    "ru": "применил",
    "en": "applied by"
  },
  "room.ui.561": {
    "ru": "кто-то",
    "en": "someone"
  },
  "room.ui.562": {
    "ru": "Ячейку изменили после запроса. Применение заменит её текущий текст целиком.",
    "en": "The cell changed after the request. Applying will replace its entire current text."
  },
  "room.ui.563": {
    "ru": "Всё равно применить",
    "en": "Apply anyway"
  },
  "room.ui.564": {
    "ru": "Применить",
    "en": "Apply"
  },
  "room.ui.565": {
    "ru": "Изменение увидит вся группа. Автором будете указаны вы.",
    "en": "The whole group will see the change. You will be recorded as the author."
  },
  "room.ui.566": {
    "ru": "отклонил",
    "en": "declined by"
  },
  "room.ui.568": {
    "ru": "прочитал",
    "en": "read"
  },
  "room.ui.569": {
    "ru": "изменил",
    "en": "changed"
  },
  "room.ui.570": {
    "ru": "завёл",
    "en": "created"
  },
  "room.ui.571": {
    "ru": "запустил",
    "en": "ran"
  },
  "room.ui.572": {
    "ru": "не вышло",
    "en": "failed"
  },
  "room.ui.573": {
    "ru": "Объяснить",
    "en": "Explain"
  },
  "room.ui.574": {
    "ru": "Починить",
    "en": "Fix"
  },
  "room.ui.575": {
    "ru": "Разобрать",
    "en": "Review"
  },
  "room.ui.576": {
    "ru": "Улучшить",
    "en": "Improve"
  },
  "room.ui.577": {
    "ru": "Подсказка",
    "en": "Hint"
  },
  "room.ui.578": {
    "ru": "Переписать",
    "en": "Rewrite"
  },
  "room.ui.585": {
    "ru": "Файлы занятия",
    "en": "Class files"
  },
  "room.ui.586": {
    "ru": "Файлы",
    "en": "Files"
  },
  "room.ui.587": {
    "ru": "Новый файл",
    "en": "New file"
  },
  "room.ui.588": {
    "ru": "Новая тетрадь",
    "en": "New notebook"
  },
  "room.ui.589": {
    "ru": "Новая папка",
    "en": "New folder"
  },
  "room.ui.590": {
    "ru": "Загрузить файлы",
    "en": "Upload files"
  },
  "room.ui.594": {
    "ru": "скопировано",
    "en": "copied"
  },
  "room.ui.596": {
    "ru": "Скопировать строку для ячейки",
    "en": "Copy a line for a cell"
  },
  "room.ui.597": {
    "ru": "Скачать",
    "en": "Download"
  },
  "room.ui.598": {
    "ru": "Удалить",
    "en": "Delete"
  },
  "room.ui.599": {
    "ru": "Удалить папку и всё её содержимое?",
    "en": "Delete this folder and everything inside?"
  },
  "room.ui.600": {
    "ru": "Удалить тетрадь и её ячейки для всей группы?",
    "en": "Delete this notebook and its cells for the whole group?"
  },
  "room.ui.601": {
    "ru": "Удалить файл?",
    "en": "Delete this file?"
  },
  "room.ui.602": {
    "ru": "Показаны не все файлы: достигнут лимит списка. Содержимое папок можно посмотреть из ячейки через",
    "en": "Not all files are shown: the list limit was reached. Inspect folder contents from a cell using"
  },
  "room.ui.607": {
    "ru": "Файлы — в папку {p0}",
    "en": "Files — into folder {p0}"
  },
  "room.ui.608": {
    "ru": "Файлы — в комнату",
    "en": "Files — into the room"
  },
  "room.ui.610": {
    "ru": "лимит глубины",
    "en": "depth limit"
  },
  "room.ui.611": {
    "ru": "пусто",
    "en": "empty"
  },
  "room.ui.612": {
    "ru": "Не удалось скачать файл.",
    "en": "Could not download the file."
  },
  "room.ui.613": {
    "ru": "«{p0}» в комнате больше нет.",
    "en": "“{p0}” is no longer in the room."
  },
  "room.ui.614": {
    "ru": "«{p0}» в этой папке уже есть.",
    "en": "“{p0}” already exists in this folder."
  },
  "room.ui.618": {
    "ru": "Не удалось загрузить",
    "en": "Upload failed"
  },
  "room.ui.619": {
    "ru": "Не удалось загрузить {p0}",
    "en": "Could not upload {p0}"
  },
  "room.ui.620": {
    "ru": "{p0} заменил существующий файл.",
    "en": "{p0} replaced an existing file."
  },
  "room.ui.621": {
    "ru": "Заменены существующие файлы: {p0}",
    "en": "Replaced existing files: {p0}"
  },
  "room.ui.622": {
    "ru": "Браузер не дал доступ к буферу обмена",
    "en": "The browser blocked clipboard access"
  },
  "room.ui.623": {
    "ru": "Файлы",
    "en": "Files"
  },
  "room.ui.624": {
    "ru": "Здесь только",
    "en": "Only"
  },
  "room.ui.625": {
    "ru": ": правки в",
    "en": "is shown here: changes in"
  },
  "room.ui.626": {
    "ru": "другой тетради комнаты",
    "en": "another room notebook"
  },
  "room.ui.627": {
    "ru": "других тетрадях комнаты",
    "en": "other room notebooks"
  },
  "room.ui.628": {
    "ru": "не показаны и не изменятся при восстановлении.",
    "en": "are not shown and will not change when restoring."
  },
  "room.ui.629": {
    "ru": "Читаем историю…",
    "en": "Loading history…"
  },
  "room.ui.630": {
    "ru": "У этой тетради пока нет сохранённых версий.",
    "en": "This notebook has no saved versions yet."
  },
  "room.ui.631": {
    "ru": "отметка",
    "en": "checkpoint"
  },
  "room.ui.632": {
    "ru": "комната",
    "en": "room"
  },
  "room.ui.633": {
    "ru": "отметил {p0}",
    "en": "marked by {p0}"
  },
  "room.ui.634": {
    "ru": "Более ранние версии не хранятся: история комнаты ограничена по объёму.",
    "en": "Older versions are not kept: room history has a size limit."
  },
  "room.ui.635": {
    "ru": "Выберите момент слева.",
    "en": "Choose a moment on the left."
  },
  "room.ui.636": {
    "ru": "Собираем эту версию…",
    "en": "Assembling this version…"
  },
  "room.ui.637": {
    "ru": "Начальная версия тетради.",
    "en": "Initial notebook version."
  },
  "room.ui.638": {
    "ru": "Это сохранённая отметка. В этот момент тетрадь не менялась.",
    "en": "This is a saved checkpoint. The notebook did not change at this moment."
  },
  "room.ui.639": {
    "ru": "текст",
    "en": "text"
  },
  "room.ui.640": {
    "ru": "новая ячейка",
    "en": "new cell"
  },
  "room.ui.641": {
    "ru": "удалённая ячейка",
    "en": "deleted cell"
  },
  "room.ui.642": {
    "ru": "ячейка",
    "en": "cell"
  },
  "room.ui.643": {
    "ru": "Вернуть эту ячейку",
    "en": "Restore this cell"
  },
  "room.ui.644": {
    "ru": "перед задачей",
    "en": "before the task"
  },
  "room.ui.645": {
    "ru": "Отметить",
    "en": "Mark"
  },
  "room.ui.646": {
    "ru": "Восстановить выбранную тетрадь. Остальные тетради не изменятся",
    "en": "Restore the selected notebook. Other notebooks will not change"
  },
  "room.ui.647": {
    "ru": "целиком",
    "en": "entire notebook"
  },
  "room.ui.648": {
    "ru": "Отметить момент",
    "en": "Mark a moment"
  },
  "room.ui.649": {
    "ru": "восстановление записывается в историю",
    "en": "restoring is recorded in history"
  },
  "room.ui.650": {
    "ru": "восстанавливать может только преподаватель",
    "en": "only the teacher can restore"
  },
  "room.ui.651": {
    "ru": "тетрадь комнаты",
    "en": "room notebook"
  },
  "room.ui.652": {
    "ru": "Не удалось прочитать историю",
    "en": "Could not read history"
  },
  "room.ui.653": {
    "ru": "Не удалось прочитать эту версию",
    "en": "Could not read this version"
  },
  "room.ui.654": {
    "ru": "Не удалось вернуть",
    "en": "Could not restore"
  },
  "room.ui.655": {
    "ru": "Не удалось поставить отметку",
    "en": "Could not create a checkpoint"
  },
  "room.ui.656": {
    "ru": "{p0} от {p1}",
    "en": "{p0} at {p1}"
  },
  "room.ui.657": {
    "ru": "Кто в комнате",
    "en": "Who is in the room"
  },
  "room.ui.658": {
    "ru": "Люди",
    "en": "People"
  },
  "room.ui.659": {
    "ru": "Подключаемся к комнате…",
    "en": "Connecting to the room…"
  },
  "room.ui.660": {
    "ru": "Свернуть",
    "en": "Collapse"
  },
  "room.ui.661": {
    "ru": "ещё {p0}",
    "en": "{p0} more"
  },
  "room.ui.662": {
    "ru": "Удалённые с занятия",
    "en": "Removed from the class"
  },
  "room.ui.663": {
    "ru": "Удалены",
    "en": "Removed"
  },
  "room.ui.664": {
    "ru": "до",
    "en": "until"
  },
  "room.ui.665": {
    "ru": " · это ваш браузер",
    "en": " · this is your browser"
  },
  "room.ui.666": {
    "ru": "Снимаем…",
    "en": "Lifting…"
  },
  "room.ui.667": {
    "ru": "Снятие ограничения не восстанавливает удалённые вопросы и ответы оракула. История версий хранит только ячейки тетради.",
    "en": "Lifting the restriction does not restore deleted oracle questions and answers. Version history only stores notebook cells."
  },
  "room.ui.668": {
    "ru": "Не удалось снять ограничение доступа.",
    "en": "Could not lift the access restriction."
  },
  "room.ui.669": {
    "ru": "вам",
    "en": "you"
  },
  "room.ui.670": {
    "ru": "К {p0} в терминал",
    "en": "Go to {p0} in the terminal"
  },
  "room.ui.671": {
    "ru": "К {p0} в ленту оракула",
    "en": "Go to {p0} in the oracle feed"
  },
  "room.ui.672": {
    "ru": "К ячейке",
    "en": "Go to cell"
  },
  "room.ui.673": {
    "ru": "К ячейке {p0}",
    "en": "Go to cell {p0}"
  },
  "room.ui.674": {
    "ru": "Преподаватель · вы",
    "en": "Teacher · you"
  },
  "room.ui.675": {
    "ru": "Преподаватель",
    "en": "Teacher"
  },
  "room.ui.676": {
    "ru": "Общий терминал",
    "en": "Shared terminal"
  },
  "room.ui.677": {
    "ru": "Высота терминала",
    "en": "Terminal height"
  },
  "room.ui.678": {
    "ru": "Потяните, чтобы изменить высоту",
    "en": "Drag to resize"
  },
  "room.ui.679": {
    "ru": "Терминал",
    "en": "Terminal"
  },
  "room.ui.680": {
    "ru": "Журнал ядра",
    "en": "Kernel log"
  },
  "room.ui.681": {
    "ru": "История",
    "en": "History"
  },
  "room.ui.682": {
    "ru": "Команды и вывод видят все участники",
    "en": "All participants see commands and output"
  },
  "room.ui.683": {
    "ru": "Общий на комнату",
    "en": "Shared by the room"
  },
  "room.ui.684": {
    "ru": "Очистить",
    "en": "Clear"
  },
  "room.ui.685": {
    "ru": "Свернуть терминал",
    "en": "Collapse terminal"
  },
  "room.ui.686": {
    "ru": "Свернуть терминал. Оболочка продолжит работать (Ctrl+`)",
    "en": "Collapse terminal. The shell will keep running (Ctrl+`)"
  },
  "room.ui.687": {
    "ru": "ядро python ·",
    "en": "python kernel ·"
  },
  "room.ui.688": {
    "ru": "— оболочка ·",
    "en": "— shell ·"
  },
  "room.ui.689": {
    "ru": "Терминал использует окружение занятия. Команда",
    "en": "The terminal uses the class environment. The command"
  },
  "room.ui.691": {
    "ru": "установит пакет для всех участников.",
    "en": "installs a package for all participants."
  },
  "room.ui.693": {
    "ru": "можно выполнить и в ячейке.",
    "en": "can also run in a cell."
  },
  "room.ui.694": {
    "ru": "Здесь появятся сообщения о запуске, перезапуске и ошибках ядра.",
    "en": "Kernel startup, restart and error messages will appear here."
  },
  "room.ui.695": {
    "ru": "Команда в общем терминале",
    "en": "Command in the shared terminal"
  },
  "room.ui.696": {
    "ru": "ctrl-c — прервать",
    "en": "ctrl-c to interrupt"
  },
  "room.ui.697": {
    "ru": "↑ история",
    "en": "↑ history"
  },
  "room.ui.698": {
    "ru": "Перезапустить оболочку",
    "en": "Restart shell"
  },
  "room.ui.699": {
    "ru": "оболочку запускает преподаватель",
    "en": "the teacher starts the shell"
  },
  "room.ui.700": {
    "ru": "оболочка",
    "en": "shell"
  },
  "room.ui.702": {
    "ru": "ждём связи…",
    "en": "waiting for connection…"
  },
  "room.ui.703": {
    "ru": "оболочка запускается…",
    "en": "shell is starting…"
  },
  "room.ui.704": {
    "ru": "оболочка остановилась",
    "en": "shell stopped"
  },
  "room.ui.705": {
    "ru": "оболочка не запущена",
    "en": "shell not started"
  },
  "room.ui.709": {
    "ru": "комната закрыта, страница осталась",
    "en": "room closed, page preserved"
  },
  "room.ui.710": {
    "ru": "занятие удалено",
    "en": "class deleted"
  },
  "room.ui.711": {
    "ru": "ещё не опубликовано",
    "en": "not published yet"
  },
  "room.ui.712": {
    "ru": "Здесь собраны занятия курса. Сохраните ссылку, чтобы вернуться к материалам.",
    "en": "This page collects the course classes. Save the link to return to the materials."
  },
  "room.ui.713": {
    "ru": "шаг",
    "en": "step"
  },
  "room.ui.714": {
    "ru": "шага",
    "en": "steps"
  },
  "room.ui.715": {
    "ru": "шагов",
    "en": "steps"
  },
  "room.ui.716": {
    "ru": "Загружается",
    "en": "Loading"
  },
  "room.ui.717": {
    "ru": "Не удалось открыть изображение.",
    "en": "Could not open the image."
  },
  "room.ui.720": {
    "ru": "Полоса страниц",
    "en": "Page strip"
  },
  "room.ui.721": {
    "ru": "Уменьшить масштаб",
    "en": "Zoom out"
  },
  "room.ui.722": {
    "ru": "По ширине",
    "en": "Fit width"
  },
  "room.ui.723": {
    "ru": "Увеличить масштаб",
    "en": "Zoom in"
  },
  "room.ui.724": {
    "ru": "Вернуться к странице, на которой ведущий",
    "en": "Return to the presenter’s page"
  },
  "room.ui.725": {
    "ru": "К лекции",
    "en": "To lecture"
  },
  "room.ui.726": {
    "ru": "Начать лекцию по этому документу",
    "en": "Start a lecture with this document"
  },
  "room.ui.727": {
    "ru": "самостоятельный просмотр",
    "en": "independent reading"
  },
  "room.ui.728": {
    "ru": "Открывается",
    "en": "Opening"
  },
  "room.ui.730": {
    "ru": "Не удалось открыть этот файл.",
    "en": "Could not open this file."
  },
  "room.ui.731": {
    "ru": "Не удалось скопировать. Выделите код и скопируйте вручную.",
    "en": "Could not copy. Select the code and copy it manually."
  },
  "room.ui.732": {
    "ru": "Скопировать ячейку",
    "en": "Copy cell"
  },
  "room.ui.736": {
    "ru": "не запускалась",
    "en": "not run"
  },
  "room.ui.737": {
    "ru": "на стр.",
    "en": "on p."
  },
  "room.ui.738": {
    "ru": "Перейти к",
    "en": "Go to"
  },
  "room.ui.739": {
    "ru": "· стр.",
    "en": "· p."
  },
  "room.ui.740": {
    "ru": "Ведущий:",
    "en": "Presenter:"
  },
  "room.ui.741": {
    "ru": "Ведущий отключился. Листайте документ самостоятельно.",
    "en": "The presenter disconnected. Browse the document independently."
  },
  "room.ui.745": {
    "ru": "Убрать документ с общего экрана",
    "en": "Remove document from the shared screen"
  },
  "room.ui.746": {
    "ru": "Вернуться в тетрадь. Общий экран не изменится.",
    "en": "Return to the notebook. The shared screen will not change."
  },
  "room.ui.751": {
    "ru": "Команды комнаты",
    "en": "Room commands"
  },
  "room.ui.752": {
    "ru": "Ячейка, файл или действие…",
    "en": "Cell, file or action…"
  },
  "room.ui.753": {
    "ru": "Что найти или сделать",
    "en": "What to find or do"
  },
  "room.ui.756": {
    "ru": "Ничего не нашлось.",
    "en": "No results."
  },
  "room.ui.820": {
    "ru": "Цветовая тема",
    "en": "Colour theme"
  },
  "room.ui.825": {
    "ru": "Светлая тема",
    "en": "Light theme"
  },
  "room.ui.826": {
    "ru": "Тёмная тема",
    "en": "Dark theme"
  },
  "room.ui.837": {
    "ru": "человек",
    "en": "person is"
  },
  "room.ui.838": {
    "ru": "человек",
    "en": "people are"
  },
  "room.ui.839": {
    "ru": "уже в комнате",
    "en": "already inside"
  },
  "room.ui.840": {
    "ru": "Вы входите в",
    "en": "You’re joining"
  },
  "room.ui.841": {
    "ru": "Входим в комнату",
    "en": "Signing you in"
  },
  "room.ui.842": {
    "ru": "Вы вошли как преподаватель. Открываем занятие…",
    "en": "You are signed in as a teacher. Opening the class…"
  },
  "room.ui.843": {
    "ru": "Занятие закончено",
    "en": "Class ended"
  },
  "room.ui.844": {
    "ru": ". Тетрадь, файлы и ответы оракула доступны для чтения.",
    "en": ". The notebook, files and oracle answers are available to read."
  },
  "room.ui.845": {
    "ru": "Есть",
    "en": "There is a"
  },
  "room.ui.846": {
    "ru": "опубликованная версия",
    "en": "published version"
  },
  "room.ui.847": {
    "ru": ", в курсе",
    "en": ", in the course"
  },
  "room.ui.848": {
    "ru": "Ваше имя",
    "en": "Your name"
  },
  "room.ui.849": {
    "ru": "Александр",
    "en": "Alex"
  },
  "room.ui.850": {
    "ru": "меток",
    "en": "marks"
  },
  "room.ui.851": {
    "ru": "Ваша метка —",
    "en": "The"
  },
  "room.ui.852": {
    "ru": ".",
    "en": "is yours"
  },
  "room.ui.853": {
    "ru": "Эта метка свободна в комнате. Можно выбрать другую.",
    "en": "This mark is available in the room. You can choose another one."
  },
  "room.ui.854": {
    "ru": "Сменить",
    "en": "Change"
  },
  "room.ui.855": {
    "ru": "Входим…",
    "en": "Joining…"
  },
  "room.ui.856": {
    "ru": "Учётная запись не нужна. По этой ссылке можно вернуться на занятие.",
    "en": "No account needed. Use this link to return to the class."
  },
  "room.ui.861": {
    "ru": "Войти как {p0}",
    "en": "Join as {p0}"
  },
  "room.ui.862": {
    "ru": "Войти на занятие",
    "en": "Join the class"
  },
  "room.ui.863": {
    "ru": "Введите имя, которое увидит группа",
    "en": "Enter the name the group will see"
  },
  "room.ui.864": {
    "ru": "Не удалось войти на занятие",
    "en": "Could not join the class"
  },
  "room.ui.865": {
    "ru": "Такой страницы здесь нет",
    "en": "This page does not exist"
  },
  "room.ui.866": {
    "ru": "Ссылка могла устареть или быть набрана с опечаткой.",
    "en": "The link may be outdated or contain a typo."
  },
  "room.ui.867": {
    "ru": "Публикация снята",
    "en": "Publication removed"
  },
  "room.ui.868": {
    "ru": "· опубликован",
    "en": "· published"
  },
  "room.ui.869": {
    "ru": "Шаги занятия",
    "en": "Class steps"
  },
  "room.ui.871": {
    "ru": "Опубликованная тетрадь занятия: код, текст и сохранённые результаты запусков.",
    "en": "Published class notebook: code, text and saved execution results."
  },
  "room.ui.872": {
    "ru": "Шаги соответствуют моментам, отмеченным преподавателем. Если код изменили после запуска, сохранённый результат может ему не соответствовать.",
    "en": "Steps correspond to checkpoints marked by the teacher. If code changed after execution, the saved result may not match it."
  },
  "room.ui.873": {
    "ru": "Список участников не публикуется. Имена в тексте ячеек и результатах сохраняются.",
    "en": "The participant list is not published. Names in cell text and outputs are preserved."
  },
  "room.ui.874": {
    "ru": "Загружается…",
    "en": "Loading…"
  },
  "room.ui.875": {
    "ru": "На этом занятии пока нет ни одной страницы.",
    "en": "This class has no pages yet."
  },
  "room.ui.876": {
    "ru": "Такой страницы у этого занятия нет. Ссылка могла устареть или быть набрана с опечаткой.",
    "en": "This class has no such page. The link may be outdated or contain a typo."
  },
  "room.ui.877": {
    "ru": "Открыть первую",
    "en": "Open first page"
  },
  "room.ui.878": {
    "ru": "Публикация снята.",
    "en": "Publication removed."
  },
  "room.ui.879": {
    "ru": "Скачать тетрадь (.ipynb)",
    "en": "Download notebook (.ipynb)"
  },
  "room.ui.880": {
    "ru": "Код без выводов",
    "en": "Code without output"
  },
  "room.ui.881": {
    "ru": "Код последнего шага, без выводов",
    "en": "Last step code, without output"
  },
  "room.ui.882": {
    "ru": "Код этого шага, без выводов",
    "en": "This step’s code, without output"
  },
  "room.ui.883": {
    "ru": "— чтобы запустить у себя.",
    "en": "— to run it yourself."
  },
  "room.ui.884": {
    "ru": "Страница не открылась",
    "en": "Could not open page"
  },
  "room.ui.887": {
    "ru": "Страница не открылась.",
    "en": "Could not open the page."
  },
  "room.ui.888": {
    "ru": "Шаг не открылся.",
    "en": "Could not open the step."
  },
  "room.ui.890": {
    "ru": "Связь восстанавливается",
    "en": "Reconnecting"
  },
  "room.ui.891": {
    "ru": "проекция",
    "en": "projection"
  },
  "room.ui.892": {
    "ru": "Экран готов. Он покажет документ, как только преподаватель начнёт лекцию.",
    "en": "The screen is ready. It will show the document when the teacher starts a lecture."
  },
  "room.ui.893": {
    "ru": "Вернуться в комнату",
    "en": "Return to room"
  },
  "room.ui.894": {
    "ru": "· ячейка {p0}",
    "en": "· cell {p0}"
  },
  "room.ui.895": {
    "ru": "Название занятия",
    "en": "Class title"
  },
  "room.ui.896": {
    "ru": "в комнате",
    "en": "in the room"
  },
  "room.ui.898": {
    "ru": "Нужна синхронизация",
    "en": "Sync required"
  },
  "room.ui.899": {
    "ru": "Восстанавливаем связь",
    "en": "Reconnecting"
  },
  "room.ui.900": {
    "ru": "Что можно делать в комнате",
    "en": "What you can do in this room"
  },
  "room.ui.901": {
    "ru": "Показать или скрыть файлы и участников",
    "en": "Toggle files and people"
  },
  "room.ui.902": {
    "ru": "Терминал, журнал ядра и история",
    "en": "Terminal, kernel log and history"
  },
  "room.ui.903": {
    "ru": "Показать или скрыть оракула",
    "en": "Toggle the AI oracle"
  },
  "room.ui.904": {
    "ru": "Скопировать ссылку на занятие",
    "en": "Copy the class link"
  },
  "room.ui.905": {
    "ru": "Скопировано",
    "en": "Copied"
  },
  "room.ui.906": {
    "ru": "Скопировать",
    "en": "Copy"
  },
  "room.ui.907": {
    "ru": "Участникам доступно только чтение. Вы можете продолжать редактировать и запускать код.",
    "en": "Participants have read-only access. You can continue editing and running code."
  },
  "room.ui.908": {
    "ru": "Вы можете читать тетрадь, файлы, историю терминала и ответы оракула.",
    "en": "You can read the notebook, files, terminal history and oracle answers."
  },
  "room.ui.909": {
    "ru": "Продолжить занятие",
    "en": "Resume class"
  },
  "room.ui.910": {
    "ru": "Ничего не открыто.",
    "en": "Nothing is open."
  },
  "room.ui.911": {
    "ru": "Файлы и тетради комнаты — в панели слева.",
    "en": "Room files and notebooks are in the left panel."
  },
  "room.ui.912": {
    "ru": "Показать этот документ всей комнате — вкладка откроется у каждого",
    "en": "Show this document to the room — the tab will open for everyone"
  },
  "room.ui.913": {
    "ru": "На общий экран",
    "en": "Share screen"
  },
  "room.ui.914": {
    "ru": "Сейчас комната смотрит",
    "en": "The room is viewing"
  },
  "room.ui.915": {
    "ru": "— больше полутора мегабайт.",
    "en": "— larger than one and a half megabytes."
  },
  "room.ui.916": {
    "ru": "Файл превышает лимит редактора. Скачайте его из панели файлов или прочитайте нужные данные из ячейки.",
    "en": "The file exceeds the editor limit. Download it from the files panel or read the data you need from a cell."
  },
  "room.ui.917": {
    "ru": "— этот формат не поддерживается редактором.",
    "en": "— this format is not supported by the editor."
  },
  "room.ui.918": {
    "ru": "Скачайте файл или откройте его из ячейки подходящей библиотекой.",
    "en": "Download the file or open it from a cell with a suitable library."
  },
  "room.ui.919": {
    "ru": "Закрыть панель файлов",
    "en": "Close the files panel"
  },
  "room.ui.920": {
    "ru": "Закрыть панель оракула",
    "en": "Close the AI panel"
  },
  "room.ui.921": {
    "ru": "Занятие удалено, и эта ссылка больше не работает. Запросите у преподавателя другую ссылку.",
    "en": "The class was deleted and this link no longer works. Ask the teacher for another link."
  },
  "room.ui.922": {
    "ru": "Правка не сохранена",
    "en": "Edit not saved"
  },
  "room.ui.923": {
    "ru": "Сервер отклонил правку после завершения занятия. Теперь доступно только чтение. Если ниже показан несохранённый текст, скопируйте его.",
    "en": "The server rejected an edit after the class ended. Access is now read-only. Copy any unsaved text shown below."
  },
  "room.ui.924": {
    "ru": "Проверяем, какой текст не сохранился…",
    "en": "Checking which text was not saved…"
  },
  "room.ui.925": {
    "ru": "Несохранённый текст ячейки",
    "en": "Unsaved cell text"
  },
  "room.ui.926": {
    "ru": "Несохранённый текст",
    "en": "Unsaved text"
  },
  "room.ui.927": {
    "ru": "Ячейка",
    "en": "Cell"
  },
  "room.ui.928": {
    "ru": "Скопировать всё",
    "en": "Copy all"
  },
  "room.ui.929": {
    "ru": "Понятно",
    "en": "Got it"
  },
  "room.ui.930": {
    "ru": "Занятие идёт",
    "en": "Class in progress"
  },
  "room.ui.931": {
    "ru": "Участникам доступно только чтение. При продолжении занятия восстановятся прежние правила доступа.",
    "en": "Participants have read-only access. Resuming the class will restore the previous access rules."
  },
  "room.ui.932": {
    "ru": "Участники смогут читать материалы, но не редактировать, запускать код или задавать вопросы оракулу. Тетрадь и файлы сохранятся.",
    "en": "Participants will be able to read materials, but cannot edit, run code or ask the oracle. The notebook and files will be preserved."
  },
  "room.ui.933": {
    "ru": "Закончить занятие",
    "en": "End class"
  },
  "room.ui.934": {
    "ru": "Новые правила применяются сразу. Если правка участника нарушает их, вкладка загрузит сохранённую версию и предложит скопировать несохранённый текст.",
    "en": "New rules apply immediately. If a participant’s edit violates them, the tab loads the saved version and offers to copy the unsaved text."
  },
  "room.ui.935": {
    "ru": "Пульт закрыт, лекция идёт.",
    "en": "Console closed, lecture continues."
  },
  "room.ui.936": {
    "ru": "Вернуться к пульту",
    "en": "Return to console"
  },
  "room.ui.937": {
    "ru": "Преподаватель изменил, что можно делать в этой комнате.",
    "en": "The teacher changed what you can do in this room."
  },
  "room.ui.938": {
    "ru": "Занятие закончено. Материалы доступны для чтения.",
    "en": "The class has ended. Materials are available to read."
  },
  "room.ui.939": {
    "ru": "Занятие продолжается. Прежние правила доступа восстановлены.",
    "en": "The class has resumed. Previous access rules were restored."
  },
  "room.ui.940": {
    "ru": "Загружена актуальная версия тетради с сервера.",
    "en": "The current notebook version was loaded from the server."
  },
  "room.ui.941": {
    "ru": "Закрыть",
    "en": "Dismiss"
  },
  "room.ui.957": {
    "ru": "Занятие закончено {p0} — комната открыта на чтение",
    "en": "Class ended {p0} — the room is read-only"
  },
  "room.ui.960": {
    "ru": "Комната",
    "en": "Room"
  },
  "room.ui.961": {
    "ru": "Запустить всю тетрадь",
    "en": "Run the whole notebook"
  },
  "room.ui.964": {
    "ru": "Остановить выполнение",
    "en": "Stop execution"
  },
  "room.ui.966": {
    "ru": "Стереть выводы",
    "en": "Clear outputs"
  },
  "room.ui.969": {
    "ru": "Форматировать тетрадь",
    "en": "Format notebook"
  },
  "room.ui.971": {
    "ru": "Панель файлов и людей",
    "en": "Files and people panel"
  },
  "room.ui.973": {
    "ru": "Спросить оракула",
    "en": "Ask the oracle"
  },
  "room.ui.976": {
    "ru": "Скопировать ссылку на занятие",
    "en": "Copy class link"
  },
  "room.ui.979": {
    "ru": "Открыть пульт",
    "en": "Open console"
  },
  "room.ui.982": {
    "ru": "Вкладки",
    "en": "Tabs"
  },
  "room.ui.984": {
    "ru": "Ячейки",
    "en": "Cells"
  },
  "room.ui.985": {
    "ru": "Пустая ячейка",
    "en": "Empty cell"
  },
  "room.ui.991": {
    "ru": "Браузер заблокировал буфер обмена. Ссылка: {p0}/s/{p1}",
    "en": "The browser blocked the clipboard. The link is {p0}/s/{p1}"
  },
  "room.ui.998": {
    "ru": "Преподавательская",
    "en": "Teaching workspace"
  },
  "room.ui.999": {
    "ru": "Создавайте занятия, управляйте доступом преподавателей и настраивайте оракула.",
    "en": "Create classes, manage teaching access and configure the oracle here."
  },
  "room.ui.1000": {
    "ru": "Студенты входят по ссылке на занятие и вводят имя. Учётная запись преподавателя им не нужна.",
    "en": "Students join from a class link and enter their name. They do not need a teacher account."
  },
  "room.ui.1001": {
    "ru": "Первый запуск",
    "en": "Initial setup"
  },
  "room.ui.1002": {
    "ru": "Настройте этот сервер",
    "en": "Set up this instance"
  },
  "room.ui.1003": {
    "ru": "Создайте первую учётную запись владельца с помощью токена настройки.",
    "en": "Use the setup token to create the first owner account for this server."
  },
  "room.ui.1004": {
    "ru": "Токен настройки",
    "en": "Setup token"
  },
  "room.ui.1005": {
    "ru": "вставьте токен настройки",
    "en": "paste the setup token"
  },
  "room.ui.1006": {
    "ru": "Ваша почта",
    "en": "Your email"
  },
  "room.ui.1008": {
    "ru": "Создаём…",
    "en": "Claiming…"
  },
  "room.ui.1009": {
    "ru": "Стать владельцем",
    "en": "Claim this instance"
  },
  "room.ui.1010": {
    "ru": "Выводится в журнал сервера при первом запуске и хранится в",
    "en": "Printed in the server log on first boot, and kept in"
  },
  "room.ui.1012": {
    "ru": "Ссылки для входа передаются вручную. Вход по почте и через университетские учётные записи не поддерживается.",
    "en": "Sign-in links are shared manually. Email sign-in and university accounts are not supported."
  },
  "room.ui.1013": {
    "ru": "После настройки добавьте преподавателей и передайте им личные ссылки для входа.",
    "en": "After setup, add teachers and share their personal sign-in links."
  },
  "room.ui.1014": {
    "ru": "Вход преподавателя",
    "en": "Teacher access"
  },
  "room.ui.1015": {
    "ru": "Войти",
    "en": "Sign in"
  },
  "room.ui.1016": {
    "ru": "Откройте личную ссылку, которую выдал владелец. Сохраните исходную ссылку для повторного входа. Она действует, пока владелец не заменит её или не удалит вашу учётную запись.",
    "en": "Open the personal sign-in link an owner gave you. Save the original link to use it again. It works until an owner replaces it or removes your account."
  },
  "room.ui.1018": {
    "ru": "Пример",
    "en": "Example"
  },
  "room.ui.1019": {
    "ru": "Войти по токену настройки",
    "en": "Sign in with the setup token"
  },
  "room.ui.1020": {
    "ru": "Вход от имени самого первого владельца.",
    "en": "This signs you in as the longest-standing owner."
  },
  "room.ui.1021": {
    "ru": "токен настройки",
    "en": "setup token"
  },
  "room.ui.1022": {
    "ru": "Входим…",
    "en": "Signing in…"
  },
  "room.ui.1023": {
    "ru": "Не удалось открыть панель",
    "en": "Could not reach the panel"
  },
  "room.ui.1024": {
    "ru": "Сервер не ответил.",
    "en": "The server did not answer."
  },
  "room.ui.1025": {
    "ru": "Проверьте подключение и попробуйте ещё раз. Если сервер остаётся недоступен, обратитесь к тому, кто им управляет.",
    "en": "Check your connection and try again. If the server remains unavailable, contact the person who runs it."
  },
  "room.ui.1026": {
    "ru": "Проверяем…",
    "en": "Trying…"
  },
  "room.ui.1027": {
    "ru": "Попробовать снова",
    "en": "Try again"
  },
  "room.ui.1029": {
    "ru": "сегодня в {p0}",
    "en": "today at {p0}"
  },
  "room.ui.1030": {
    "ru": "завтра в {p0}",
    "en": "tomorrow at {p0}"
  },
  "room.ui.1031": {
    "ru": "{p0}.{p1} в {p2}",
    "en": "{p0}.{p1} at {p2}"
  },
  "room.ui.1032": {
    "ru": "Доступ для {p0} будет закрыт на 24 часа.",
    "en": "Access for {p0} will be blocked for 24 hours."
  },
  "room.ui.1033": {
    "ru": "Вопросы участника и ответы оракула будут удалены без возможности восстановления через историю версий.",
    "en": "The participant’s questions and oracle answers will be deleted and cannot be restored through version history."
  },
  "room.ui.1034": {
    "ru": "Ограничение привязано к браузеру. Участник может обойти его через другой браузер или режим инкогнито.",
    "en": "The restriction is tied to the browser. The participant can bypass it using another browser or private mode."
  },
  "room.ui.1035": {
    "ru": "совпадает IP-адрес",
    "en": "matching IP address"
  },
  "room.ui.1036": {
    "ru": "IP-адрес совпадает с адресом заблокированного участника. ",
    "en": "The IP address matches a blocked participant. "
  },
  "room.ui.1037": {
    "ru": "Это не подтверждает, что вернулся тот же человек: общий адрес может быть у ",
    "en": "This does not confirm it is the same person: an address can be shared by "
  },
  "room.ui.1038": {
    "ru": "всей аудитории в одной сети.",
    "en": "the whole class on one network."
  },
  "room.ui.1039": {
    "ru": "браузер без метки",
    "en": "browser without a device mark"
  },
  "room.ui.1040": {
    "ru": "Браузер не сохранил метку устройства. Ограничение доступа может не сохраниться после повторного входа.",
    "en": "The browser did not store a device mark. The access restriction may not persist after signing in again."
  },
  "room.ui.1041": {
    "ru": "недавно вошёл",
    "en": "recently joined"
  },
  "room.ui.1042": {
    "ru": "Первый вход в эту комнату был менее пяти минут назад.",
    "en": "First joined this room less than five minutes ago."
  },
  "room.ui.1043": {
    "ru": "браузер заблокировал буфер обмена",
    "en": "the browser refused the clipboard"
  },
  "room.ui.1044": {
    "ru": "Нет связи с сервером. Повторите запуск после подключения",
    "en": "No connection to the server. Try running again after reconnecting"
  },
  "room.ui.1045": {
    "ru": "ещё пишут",
    "en": "still writing"
  },
  "room.ui.1046": {
    "ru": "верно",
    "en": "correct"
  },
  "room.ui.1047": {
    "ru": "неверно",
    "en": "incorrect"
  },
  "room.ui.1048": {
    "ru": "ошибка запуска",
    "en": "run error"
  },
  "room.ui.1049": {
    "ru": "выполнена",
    "en": "completed"
  },
  "room.ui.1050": {
    "ru": "не запускали",
    "en": "not run"
  },
  "room.ui.1051": {
    "ru": "(пусто)",
    "en": "(empty)"
  },
  "room.ui.1054": {
    "ru": {
      "one": "{count} попытка",
      "few": "{count} попытки",
      "many": "{count} попыток",
      "other": "{count} попыток"
    },
    "en": {
      "one": "{count} attempt",
      "other": "{count} attempts"
    }
  },
  "room.ui.1055": {
    "ru": {
      "one": "{count} сдал",
      "few": "{count} сдали",
      "many": "{count} сдали",
      "other": "{count} сдали"
    },
    "en": {
      "one": "{count} submitted",
      "other": "{count} submitted"
    }
  },
  "room.ui.1056": {
    "ru": {
      "one": "{count} ещё пишет",
      "few": "{count} ещё пишут",
      "many": "{count} ещё пишут",
      "other": "{count} ещё пишут"
    },
    "en": {
      "one": "{count} still writing",
      "other": "{count} still writing"
    }
  },
  "room.ui.1057": {
    "ru": {
      "one": "{count} разный ответ",
      "few": "{count} разных ответа",
      "many": "{count} разных ответов",
      "other": "{count} разных ответов"
    },
    "en": {
      "one": "{count} different answer",
      "other": "{count} different answers"
    }
  },
  "room.ui.1058": {
    "ru": {
      "one": "{count} сдал из {total}",
      "few": "{count} сдали из {total}",
      "many": "{count} сдали из {total}",
      "other": "{count} сдали из {total}"
    },
    "en": {
      "one": "{count} submitted out of {total}",
      "other": "{count} submitted out of {total}"
    }
  },
  "room.ui.1059": {
    "ru": "в очереди на запуск",
    "en": "queued to run"
  },
  "room.ui.1060": {
    "ru": "выполняется",
    "en": "running"
  },
  "room.ui.1061": {
    "ru": "запускали вы",
    "en": "run by you"
  },
  "room.ui.1063": {
    "ru": "вы {p0}-й в очереди",
    "en": "you are number {p0} in the queue"
  },
  "room.ui.1064": {
    "ru": "{p0} из {p1}",
    "en": "{p0} of {p1}"
  },
  "room.ui.1067": {
    "ru": "В комнату сейчас заходит много людей — пробую ещё раз…",
    "en": "Many people are joining the room — trying again…"
  },
  "room.ui.1076": {
    "ru": "комната",
    "en": "the room"
  },
  "room.ui.1078": {
    "ru": "Открыть консилиум в этой ячейке",
    "en": "Open council in this cell"
  },
  "room.ui.1079": {
    "ru": "Открыть ячейку для совместной работы",
    "en": "Open this cell for collaboration"
  },
  "room.ui.1080": {
    "ru": "Изменить доступ к ячейке",
    "en": "Change cell access"
  },
  "room.ui.1081": {
    "ru": "Закрыть ячейку",
    "en": "Close cell"
  },
  "room.ui.1082": {
    "ru": "Открыть консилиум в этой ячейке · удержать — выбрать доступ",
    "en": "Open council in this cell · hold to choose access"
  },
  "room.ui.1083": {
    "ru": "Закрыть ячейку · удержать — выбрать доступ",
    "en": "Close cell · hold to choose access"
  },
  "room.ui.1084": {
    "ru": "Открыть ячейку для совместной работы · удержать — выбрать доступ",
    "en": "Open this cell for collaboration · hold to choose access"
  },
  "room.ui.1085": {
    "ru": "Консилиум · щелчок — настроить доступ к ячейке",
    "en": "Council · click to configure cell access"
  },
  "room.ui.1091": {
    "ru": "На этом занятии это делает преподаватель",
    "en": "In this class, the teacher does this"
  },
  "room.ui.1092": {
    "ru": "Редактировать ячейки может только преподаватель",
    "en": "Only the teacher can edit cells"
  },
  "room.ui.1093": {
    "ru": "Запускать ячейки и команды терминала может только преподаватель",
    "en": "Only the teacher can run cells and terminal commands"
  },
  "room.ui.1094": {
    "ru": "Запускайте по одной ячейке",
    "en": "Run one cell at a time"
  },
  "room.ui.1095": {
    "ru": "Запускать всю тетрадь может только преподаватель",
    "en": "Only the teacher can run the whole notebook"
  },
  "room.ui.1096": {
    "ru": "Можно добавлять ячейки. Удалять и переставлять их может только преподаватель",
    "en": "You can add cells. Only the teacher can delete and reorder them"
  },
  "room.ui.1097": {
    "ru": "Добавлять, удалять и переставлять ячейки может только преподаватель",
    "en": "Only the teacher can add, delete and reorder cells"
  },
  "room.ui.1098": {
    "ru": "Очищать общие результаты и историю сообщений может только преподаватель",
    "en": "Only the teacher can clear shared output and message history"
  },
  "room.ui.1099": {
    "ru": "Перезапускать ядро может только преподаватель",
    "en": "Only the teacher can restart the kernel"
  },
  "room.ui.1100": {
    "ru": "Создавать и редактировать файлы может только преподаватель",
    "en": "Only the teacher can create and edit files"
  },
  "room.ui.1101": {
    "ru": "Режим работы оракула с файлами отключён",
    "en": "Oracle file editing mode is disabled"
  },
  "room.ui.1102": {
    "ru": "Режим работы оракула с файлами доступен только преподавателю",
    "en": "Oracle file editing mode is available only to the teacher"
  },
  "room.ui.1103": {
    "ru": "Показывать документ всей комнате может только преподаватель",
    "en": "Only the teacher can show a document to the room"
  },
  "room.ui.1104": {
    "ru": "Консилиум ведёт преподаватель",
    "en": "The teacher leads the council"
  },
  "room.ui.1105": {
    "ru": "Эту ячейку редактирует и запускает только преподаватель",
    "en": "Only the teacher can edit and run this cell"
  },
  "room.ui.1106": {
    "ru": "Консилиум закрыт. Ваш текст доступен в черновике",
    "en": "Council is closed. Your text is available in the draft"
  },
  "room.ui.1107": {
    "ru": "На этом занятии можно запускать по одной ячейке. Ваша ячейка уже выполняется или стоит в очереди.",
    "en": "This class allows one cell run at a time. Your cell is already running or queued."
  },
  "room.ui.1112": {
    "ru": "запускает ячейку {p0}",
    "en": "running cell {p0}"
  },
  "room.ui.1113": {
    "ru": "в терминале",
    "en": "in the terminal"
  },
  "room.ui.1114": {
    "ru": "спрашивает оракула",
    "en": "asking the oracle"
  },
  "room.ui.1115": {
    "ru": "правит ячейку {p0}",
    "en": "editing cell {p0}"
  },
  "room.ui.1116": {
    "ru": "вкладка",
    "en": "tab"
  },
  "room.ui.1117": {
    "ru": "вкладки",
    "en": "tabs"
  },
  "room.ui.1118": {
    "ru": "вкладок",
    "en": "tabs"
  },
  "room.ui.1119": {
    "ru": "Не удалось сохранить правило: нет связи с сервером.",
    "en": "Could not save the rule: no connection to the server."
  },
  "room.ui.1120": {
    "ru": "Не удалось сохранить правило: вас удалили с занятия.",
    "en": "Could not save the rule: you were removed from the class."
  },
  "room.ui.1121": {
    "ru": "Не удалось сохранить правило: изменять правила может только преподаватель.",
    "en": "Could not save the rule: only the teacher can change rules."
  },
  "room.ui.1122": {
    "ru": "Не удалось сохранить правило: войдите на занятие заново.",
    "en": "Could not save the rule: sign in to the class again."
  },
  "room.ui.1123": {
    "ru": "Не удалось сохранить правило: занятие не найдено.",
    "en": "Could not save the rule: class not found."
  },
  "room.ui.1124": {
    "ru": "Не удалось сохранить правило. Попробуйте ещё раз.",
    "en": "Could not save the rule. Try again."
  },
  "room.ui.1127": {
    "ru": "Все",
    "en": "Everyone"
  },
  "room.ui.1128": {
    "ru": "Открытая ячейка",
    "en": "Open cell"
  },
  "room.ui.1129": {
    "ru": "Действие кнопки замка: открыть общую ячейку для редактирования или включить Консилиум с отдельным ответом каждого студента.",
    "en": "Lock button action: open the shared cell for editing or enable Council with a separate answer for each student."
  },
  "room.ui.1130": {
    "ru": "Всем вместе",
    "en": "Work together"
  },
  "room.ui.1131": {
    "ru": "Каждому свой лист",
    "en": "A sheet for each student"
  },
  "room.ui.1132": {
    "ru": "Печатать в ячейках",
    "en": "Edit cells"
  },
  "room.ui.1133": {
    "ru": "Кто может редактировать текст ячеек. Преподаватель также может открыть отдельную ячейку для группы.",
    "en": "Who can edit cell text. The teacher can also open an individual cell to the group."
  },
  "room.ui.1134": {
    "ru": "Запускать код",
    "en": "Run code"
  },
  "room.ui.1135": {
    "ru": "Правило действует на ячейки, запуск файлов и команды терминала. «По одной» ограничивает участника одним запуском ячейки одновременно.",
    "en": "This rule covers cells, file execution and terminal commands. “One at a time” limits each participant to one running cell."
  },
  "room.ui.1136": {
    "ru": "По одной",
    "en": "One at a time"
  },
  "room.ui.1137": {
    "ru": "Менять состав тетради",
    "en": "Change notebook structure"
  },
  "room.ui.1138": {
    "ru": "«Только добавлять»: участники добавляют ячейки, а удаляет и переставляет их преподаватель.",
    "en": "“Add only”: participants add cells; the teacher deletes and reorders them."
  },
  "room.ui.1139": {
    "ru": "Только добавлять",
    "en": "Add only"
  },
  "room.ui.1140": {
    "ru": "Показывать документ комнате",
    "en": "Show documents to the room"
  },
  "room.ui.1141": {
    "ru": "Кто может открыть документ на общем экране. Участники по-прежнему могут просматривать документы у себя.",
    "en": "Who can open a document on the shared screen. Participants can still browse documents on their own."
  },
  "room.ui.1142": {
    "ru": "Создавать и редактировать файлы",
    "en": "Create and edit files"
  },
  "room.ui.1143": {
    "ru": "Правило не ограничивает скачивание. Удалять и переименовывать файлы может только преподаватель.",
    "en": "Downloads are not restricted. Only the teacher can delete and rename files."
  },
  "room.ui.1144": {
    "ru": "Оракул правит файлы сам",
    "en": "Oracle edits files directly"
  },
  "room.ui.1145": {
    "ru": "Режим «Сделать» позволяет оракулу читать, создавать и изменять файлы, запускать код. Отмена восстанавливает доступные версии файлов, но не последствия выполнения кода. Правки ячеек в этом режиме применяются сразу.",
    "en": "Act mode lets the oracle read, create and edit files and run code. Undo restores available file versions, but not the effects of running code. Cell edits are applied immediately in this mode."
  },
  "room.ui.1146": {
    "ru": "Никто",
    "en": "Nobody"
  },
  "room.ui.1147": {
    "ru": "Вопросов оракулу в час",
    "en": "Oracle questions per hour"
  },
  "room.ui.1148": {
    "ru": "Лимит на одного участника. Не выше общего лимита сервера; на преподавателя не распространяется. Пустое поле — использовать настройку сервера.",
    "en": "Limit per participant. Cannot exceed the server limit; does not apply to the teacher. Leave blank to use the server setting."
  },
  "room.ui.1149": {
    "ru": "в час",
    "en": "per hour"
  },
  "room.ui.1150": {
    "ru": "оракул выключен",
    "en": "oracle disabled"
  },
  "room.ui.1151": {
    "ru": "{p0} в час",
    "en": "{p0} per hour"
  },
  "room.ui.1152": {
    "ru": "Промежуток между вопросами",
    "en": "Time between questions"
  },
  "room.ui.1153": {
    "ru": "Минимальный интервал между вопросами одного участника. Не меньше интервала на сервере; на преподавателя не распространяется. Пустое поле — использовать настройку сервера.",
    "en": "Minimum interval between one participant’s questions. Cannot be less than the server interval; does not apply to the teacher. Leave blank to use the server setting."
  },
  "room.ui.1154": {
    "ru": "сек",
    "en": "sec"
  },
  "room.ui.1155": {
    "ru": "без промежутка",
    "en": "no interval"
  },
  "room.ui.1156": {
    "ru": "раз в {p0} сек",
    "en": "every {p0} sec"
  },
  "room.ui.1157": {
    "ru": "Смотреть ленту версий",
    "en": "View version history"
  },
  "room.ui.1158": {
    "ru": "Кто может просматривать предыдущие версии тетради и авторов изменений.",
    "en": "Who can view previous notebook versions and change authors."
  },
  "room.ui.1159": {
    "ru": "Перезапускать ядро",
    "en": "Restart kernel"
  },
  "room.ui.1160": {
    "ru": "Перезапуск сбрасывает переменные для всех участников. Текст ячеек и файлы сохраняются.",
    "en": "Restarting clears variables for all participants. Cell text and files are preserved."
  },
  "room.ui.1161": {
    "ru": "Очищать общие результаты",
    "en": "Clear shared output"
  },
  "room.ui.1162": {
    "ru": "Кто может очистить все выводы ячеек, историю терминала и ленту оракула. Очистка вывода отдельной ячейки зависит от права редактировать её.",
    "en": "Who can clear all cell outputs, terminal history and oracle feed. Clearing one cell’s output depends on permission to edit it."
  },
  "room.ui.1163": {
    "ru": "Остановить выполняющуюся ячейку",
    "en": "Stop the running cell"
  },
  "room.ui.1164": {
    "ru": "Остановить запуск может преподаватель или запустивший ячейку",
    "en": "Only the host, or whoever started it, can stop a run"
  },
  "room.ui.1165": {
    "ru": "Убрать эту ячейку из очереди на запуск",
    "en": "Take this cell out of the run queue"
  },
  "room.ui.1166": {
    "ru": "Убрать эту ячейку из очереди",
    "en": "Take this cell out of the queue"
  },
  "room.ui.1167": {
    "ru": "Убрать ячейку из очереди может преподаватель или поставивший её в очередь",
    "en": "Only the host, or whoever queued it, can take it out of the queue"
  },
  "room.ui.1168": {
    "ru": "Запустить ячейку",
    "en": "Run cell"
  },
  "room.ui.1169": {
    "ru": "На этом занятии ячейки запускает только преподаватель",
    "en": "This class is set so only the teacher runs cells"
  },
  "room.ui.1172": {
    "ru": "Занятие удалено. Запросите у преподавателя другую ссылку.",
    "en": "This class was deleted. Ask the teacher for another class link."
  },
  "room.ui.1173": {
    "ru": "Сервер не сохранил эту правку.",
    "en": "The server did not save this edit."
  },
  "room.ui.1174": {
    "ru": "Не удалось синхронизировать тетрадь после двух попыток. Закройте другие вкладки этой комнаты и перезагрузите страницу.",
    "en": "Could not sync the notebook after two attempts. Close other tabs for this room and reload the page."
  },
  "room.ui.1175": {
    "ru": "Сервер дважды отклонил изменения из этой вкладки. Закройте другие вкладки этой комнаты и перезагрузите страницу.",
    "en": "The server rejected changes from this tab twice. Close other tabs for this room and reload the page."
  },
  "room.ui.1177": {
    "ru": "«{p0}» нельзя переместить: путь к содержимому превысит {p1} символов.",
    "en": "Cannot move “{p0}”: a nested path would exceed {p1} characters."
  },
  "room.ui.1178": {
    "ru": "«{p0}» в комнате больше нет.",
    "en": "“{p0}” is no longer in the room."
  },
  "room.ui.1179": {
    "ru": "«{p0}» нельзя переместить внутрь себя.",
    "en": "Cannot move “{p0}” inside itself."
  },
  "room.ui.1180": {
    "ru": "«{p0}» в папке «{p1}» уже есть.",
    "en": "“{p0}” already exists in folder “{p1}”."
  },
  "room.ui.1181": {
    "ru": "«{p0}» в корне комнаты уже есть.",
    "en": "“{p0}” already exists in the room root."
  },
  "room.ui.1182": {
    "ru": "Допустимая глубина пути — до {p0} уровней.",
    "en": "Paths can be up to {p0} levels deep."
  },
  "room.ui.1183": {
    "ru": "Путь до «{p0}» длиннее {p1} символов.",
    "en": "The path to “{p0}” exceeds {p1} characters."
  },
  "room.ui.1184": {
    "ru": "{p0} КБ",
    "en": "{p0} KB"
  },
  "room.ui.1185": {
    "ru": "{p0} МБ",
    "en": "{p0} MB"
  },
  "room.ui.1186": {
    "ru": "только что",
    "en": "just now"
  },
  "room.ui.1187": {
    "ru": "{p0} мин назад",
    "en": "{p0}m ago"
  },
  "room.ui.1188": {
    "ru": "{p0} ч назад",
    "en": "{p0}h ago"
  },
  "room.ui.1190": {
    "ru": "{p0} с",
    "en": "{p0}s"
  },
  "room.ui.1191": {
    "ru": "{p0} мин {p1} с",
    "en": "{p0}m {p1}s"
  },
  "room.ui.1192": {
    "ru": "{p0} ч {p1} мин",
    "en": "{p0}h {p1}m"
  },
  "room.ui.1193": {
    "ru": "{p0} мин {p1} с",
    "en": "{p0}m {p1}s"
  },
  "room.ui.1194": {
    "ru": "{p0} ч {p1} мин",
    "en": "{p0}h {p1}m"
  },
  "room.ui.1195": {
    "ru": "{p0} ГБ",
    "en": "{p0} GB"
  },
  "room.ui.1196": {
    "ru": "{p0} МБ",
    "en": "{p0} MB"
  },
  "room.ui.1197": {
    "ru": "ещё не собрано",
    "en": "never built"
  },
  "room.ui.1198": {
    "ru": "собрано {p0} дн. назад",
    "en": "built {p0} days ago"
  },
  "room.ui.1199": {
    "ru": "собрано {p0} ч назад",
    "en": "built {p0}h ago"
  },
  "room.ui.1200": {
    "ru": "собрано только что",
    "en": "built just now"
  },
  "room.ui.1210": {
    "ru": "Недействительная ссылка на занятие",
    "en": "This class link is not valid"
  },
  "room.ui.1211": {
    "ru": "Не удалось открыть занятие",
    "en": "Could not open this class"
  },
  "room.ui.1212": {
    "ru": "Проверьте, что ссылка скопирована целиком, или запросите у преподавателя действующую ссылку.",
    "en": "Check that you copied the full link, or ask the teacher for the current class link."
  },
  "room.ui.1213": {
    "ru": "Вернуться в Colloq",
    "en": "Back to Colloq"
  },
  "room.ui.1214": {
    "ru": "Входим в комнату…",
    "en": "Joining the room…"
  },
  "room.ui.1219": {
    "ru": "Ваш сеанс истёк. Введите имя, чтобы вернуться на занятие.",
    "en": "Your sign-in expired. Enter your name to rejoin the class."
  },
  "room.ui.1220": {
    "ru": "Сервер не ответил",
    "en": "The server did not respond"
  },
  "room.ui.1221": {
    "ru": "Ссылка на пульт недействительна. Создайте новую ссылку в комнате.",
    "en": "The console link is invalid. Create a new link in the room."
  },
  "room.extra.26": {
    "ru": "пишет",
    "en": "writing"
  },
  "room.extra.27": {
    "ru": "пишут",
    "en": "writing"
  },
  "room.extra.31": {
    "ru": "{p0} {p1} — вывод в терминале",
    "en": "{p0} {p1} — output in the terminal"
  },
  "room.extra.53": {
    "ru": "Вернуться к слайду",
    "en": "Return to slide"
  },
  "room.extra.54": {
    "ru": "Чистый лист",
    "en": "Blank sheet"
  },
  "room.extra.55": {
    "ru": "Вернуть проекцию",
    "en": "Restore projection"
  },
  "room.extra.56": {
    "ru": "Затемнить проекцию",
    "en": "Dim projection"
  },
  "room.extra.83": {
    "ru": "Перо, {p0}",
    "en": "Pen, {p0}"
  },
  "room.extra.89": {
    "ru": "Развернуть заметки",
    "en": "Expand notes"
  },
  "room.extra.90": {
    "ru": "Свернуть заметки",
    "en": "Collapse notes"
  },
  "room.extra.98": {
    "ru": "Ячейка {p0}, выделена",
    "en": "Cell {p0}, selected"
  },
  "room.extra.99": {
    "ru": "Ячейка {p0}",
    "en": "Cell {p0}"
  },
  "room.extra.109": {
    "ru": "Консилиум: у каждого свой ответ. Преподаватель может выбрать ответ для общего разбора.",
    "en": "Council: each student has their own answer. The teacher can choose an answer to discuss with the class."
  },
  "room.extra.110": {
    "ru": "Эта ячейка открыта комнате",
    "en": "This cell is open to the room"
  },
  "room.extra.111": {
    "ru": "Закрыта — открыть её может преподаватель",
    "en": "Closed — the teacher can open it"
  },
  "room.extra.112": {
    "ru": "Ещё не запускалась",
    "en": "Not run yet"
  },
  "room.extra.113": {
    "ru": "Предыдущий запуск. Ядро было перезапущено",
    "en": "Previous run. The kernel was restarted"
  },
  "room.extra.114": {
    "ru": "Запуск {p0}",
    "en": "Run {p0}"
  },
  "room.extra.120": {
    "ru": "Редактировать текстовую ячейку",
    "en": "Edit this text cell"
  },
  "room.extra.121": {
    "ru": "Вверх",
    "en": "Move up"
  },
  "room.extra.122": {
    "ru": "Вниз",
    "en": "Move down"
  },
  "room.extra.123": {
    "ru": "Создать копию",
    "en": "Duplicate"
  },
  "room.extra.124": {
    "ru": "Преобразовать в текст — M",
    "en": "Convert to text — M"
  },
  "room.extra.125": {
    "ru": "Преобразовать в код — Y",
    "en": "Convert to code — Y"
  },
  "room.extra.126": {
    "ru": "Преобразовать в Markdown",
    "en": "Convert to markdown"
  },
  "room.extra.127": {
    "ru": "Преобразовать в код",
    "en": "Convert to code"
  },
  "room.extra.128": {
    "ru": "Попросить оракула изменить ячейку",
    "en": "Ask the oracle to change this cell"
  },
  "room.extra.129": {
    "ru": "Очистить вывод ячейки",
    "en": "Clear this cell’s output"
  },
  "room.extra.131": {
    "ru": "Удалить ячейку",
    "en": "Delete cell"
  },
  "room.extra.132": {
    "ru": "Своя попытка, ячейка {p0}",
    "en": "Your attempt, cell {p0}"
  },
  "room.extra.133": {
    "ru": "Вставка не поместилась: в попытке не больше {p0} знаков, а с ней вышло бы {p1}.",
    "en": "Paste exceeds the limit: an attempt allows {p0} characters, but this would make {p1}."
  },
  "room.extra.135": {
    "ru": "Сдать — ⌘⇧↵",
    "en": "Submit — ⌘⇧↵"
  },
  "room.extra.136": {
    "ru": "Продолжить редактирование и снять отметку о сдаче",
    "en": "Continue editing and undo submission"
  },
  "room.extra.138": {
    "ru": "Запустить свою попытку — в очередь, по одному. {p0}",
    "en": "Run your attempt — queued, one at a time. {p0}"
  },
  "room.extra.139": {
    "ru": "Код",
    "en": "Code"
  },
  "room.extra.140": {
    "ru": "Текст",
    "en": "Text"
  },
  "room.extra.141": {
    "ru": "Пишите в Markdown…",
    "en": "Write in markdown…"
  },
  "room.extra.143": {
    "ru": "Черновик попытки, ячейка {p0}",
    "en": "Attempt draft, cell {p0}"
  },
  "room.extra.150": {
    "ru": "Запуск от {p0}",
    "en": "{p0} started this run"
  },
  "room.extra.151": {
    "ru": "Остановить выполняющуюся ячейку",
    "en": "Stop the running cell"
  },
  "room.extra.152": {
    "ru": "Остановить запуск может преподаватель или запустивший ячейку",
    "en": "Only the host, or whoever started it, can stop a run"
  },
  "room.extra.154": {
    "ru": "Убрать эту ячейку из очереди",
    "en": "Take this cell out of the queue"
  },
  "room.extra.158": {
    "ru": "{p0} в этой ячейке",
    "en": "{p0} is in this cell"
  },
  "room.extra.177": {
    "ru": "Запустить все ячейки с кодом",
    "en": "Run every code cell"
  },
  "room.extra.180": {
    "ru": "Удерживайте, чтобы перезапустить ядро — все переменные будут сброшены",
    "en": "Hold to restart the kernel — every variable is lost"
  },
  "room.extra.181": {
    "ru": "Очистить все выводы",
    "en": "Clear every output"
  },
  "room.extra.182": {
    "ru": "Форматировать ячейки с кодом через Black с длиной строки 100 символов. Ячейки с синтаксическими ошибками пропускаются.",
    "en": "Format code cells with Black, using a 100-character line limit. Cells with syntax errors are skipped."
  },
  "room.extra.184": {
    "ru": "Перезапустить ядро",
    "en": "Restart the kernel"
  },
  "room.extra.217": {
    "ru": "Что сделать с файлами занятия…",
    "en": "What to do with the class files…"
  },
  "room.extra.218": {
    "ru": "Спросить про {p0}…",
    "en": "Ask about {p0}…"
  },
  "room.extra.219": {
    "ru": "Вопрос по материалам занятия…",
    "en": "A question about the class materials…"
  },
  "room.extra.220": {
    "ru": "Ещё {p0} с",
    "en": "{p0} sec remaining"
  },
  "room.extra.221": {
    "ru": "Отправить",
    "en": "Send"
  },
  "room.extra.223": {
    "ru": "человек",
    "en": "person"
  },
  "room.extra.224": {
    "ru": "человека",
    "en": "people"
  },
  "room.extra.232": {
    "ru": "Что сделать с участником: {p0}",
    "en": "Participant actions: {p0}"
  },
  "room.extra.238": {
    "ru": "Перейти к ячейке {p0}",
    "en": "Go to cell {p0}"
  },
  "room.extra.239": {
    "ru": "Спрашивали про ячейки {p0} — перейти к первой",
    "en": "Asked about cells {p0} — go to the first"
  },
  "room.extra.242": {
    "ru": "Вопрос отправляется",
    "en": "Sending question"
  },
  "room.extra.243": {
    "ru": "Остановить чужой вопрос может преподаватель",
    "en": "Only the teacher can stop someone else’s question"
  },
  "room.extra.258": {
    "ru": "Новый файл в {p0}",
    "en": "New file in {p0}"
  },
  "room.extra.259": {
    "ru": "Новый файл",
    "en": "New file"
  },
  "room.extra.260": {
    "ru": "Новая тетрадь в {p0}",
    "en": "New notebook in {p0}"
  },
  "room.extra.261": {
    "ru": "Новая тетрадь",
    "en": "New notebook"
  },
  "room.extra.262": {
    "ru": "Новая папка в {p0}",
    "en": "New folder in {p0}"
  },
  "room.extra.263": {
    "ru": "Новая папка",
    "en": "New folder"
  },
  "room.extra.265": {
    "ru": "Раскрыть",
    "en": "Expand"
  },
  "room.extra.266": {
    "ru": "Свернуть",
    "en": "Collapse"
  },
  "room.extra.269": {
    "ru": "{p0} — открыть",
    "en": "{p0} — open"
  },
  "room.extra.270": {
    "ru": "{p0} — здесь",
    "en": "{p0} — here"
  },
  "room.extra.272": {
    "ru": "Скопировать {p0}",
    "en": "Copy {p0}"
  },
  "room.extra.273": {
    "ru": "Скачать {p0}",
    "en": "Download {p0}"
  },
  "room.extra.274": {
    "ru": "Убрать {p0}",
    "en": "Remove {p0}"
  },
  "room.extra.275": {
    "ru": "Достигнут лимит глубины дерева файлов. Содержимое папки можно посмотреть из ячейки через os.listdir().",
    "en": "The file tree depth limit was reached. Inspect the folder contents from a cell using os.listdir()."
  },
  "room.extra.284": {
    "ru": "кто-то",
    "en": "someone"
  },
  "room.extra.287": {
    "ru": "Удалил {p0}",
    "en": "Removed by {p0}"
  },
  "room.extra.288": {
    "ru": "Очистить историю терминала для всех",
    "en": "Clear terminal history for everyone"
  },
  "room.extra.291": {
    "ru": "Кто-то",
    "en": "Someone"
  },
  "room.extra.296": {
    "ru": "{p0} не удалось открыть как изображение.",
    "en": "Could not open {p0} as an image."
  },
  "room.extra.297": {
    "ru": "Страница {p0}",
    "en": "Page {p0}"
  },
  "room.extra.300": {
    "ru": "{p0} здесь",
    "en": "{p0} is here"
  },
  "room.extra.401": {
    "ru": "Вернуться в Colloq",
    "en": "Back to Colloq"
  },
  "room.extra.402": {
    "ru": "Открыть курс «{p0}»",
    "en": "Open course “{p0}”"
  },
  "room.extra.405": {
    "ru": "Последнее известное состояние — связь прервалась",
    "en": "Last known — the connection dropped"
  },
  "room.extra.407": {
    "ru": "Файлы и участники — {p0}B",
    "en": "Files and people — {p0}B"
  },
  "room.extra.408": {
    "ru": "Терминал, журнал ядра и история — {p0}J или Ctrl+`",
    "en": "Terminal, kernel log and history — {p0}J or Ctrl+`"
  },
  "room.extra.409": {
    "ru": "{p0} непрочитанных сообщений ядра",
    "en": "{p0} unread kernel messages"
  },
  "room.extra.411": {
    "ru": "Продолжить занятие с прежними правилами доступа",
    "en": "Resume the class with previous access rules"
  },
  "room.extra.412": {
    "ru": "Закончить занятие — участникам останется чтение",
    "en": "End class — participants will have read-only access"
  },
  "room.extra.453": {
    "ru": "попытка",
    "en": "attempt"
  },
  "room.extra.454": {
    "ru": "попытки",
    "en": "attempts"
  },
  "room.extra.455": {
    "ru": "попыток",
    "en": "attempts"
  },
  "room.extra.456": {
    "ru": "сдал",
    "en": "submitted"
  },
  "room.extra.457": {
    "ru": "сдали",
    "en": "submitted"
  },
  "room.extra.458": {
    "ru": "разный ответ",
    "en": "different answer"
  },
  "room.extra.459": {
    "ru": "разных ответа",
    "en": "different answers"
  },
  "room.extra.460": {
    "ru": "разных ответов",
    "en": "different answers"
  },
  "room.extra.461": {
    "ru": "Загруженные файлы видит вся группа",
    "en": "Uploaded files are visible to the whole group"
  },
  "room.confirm.showNamed": {
    "ru": "Показать классу вариант {name}? Его код появится подписанной плашкой под ячейкой у всех; текст ячейки не изменится, убрать можно одним нажатием.",
    "en": "Show {name}’s answer to the class? Their code appears as a signed block under the cell for everyone; the cell text does not change, and one press takes it off."
  },
  "room.confirm.showAnswer": {
    "ru": "Показать классу этот вариант? Его код появится подписанной плашкой под ячейкой у всех; текст ячейки не изменится, убрать можно одним нажатием.",
    "en": "Show this answer to the class? The code appears as a signed block under the cell for everyone; the cell text does not change, and one press takes it off."
  },
  "room.duration.seconds": {
    "ru": "{count} с",
    "en": "{count}s"
  },
  "room.oracle.stepAt": {
    "ru": "+{p0}",
    "en": "+{p0}"
  },
  "room.oracle.progress": {
    "ru": "шаг {p0} · {p1}",
    "en": "step {p0} · {p1}"
  },
  "room.oracle.stalled": {
    "ru": "шаг {p0} · ждём ответа модели уже {p1}",
    "en": "step {p0} · waiting for the model for {p1}"
  },
  "room.bytes": {
    "ru": "{count} Б",
    "en": "{count} B"
  },
  "room.mark.fox": {
    "ru": "лиса",
    "en": "fox"
  },
  "room.mark.turtle": {
    "ru": "черепаха",
    "en": "turtle"
  },
  "room.mark.octopus": {
    "ru": "осьминог",
    "en": "octopus"
  },
  "room.mark.owl": {
    "ru": "сова",
    "en": "owl"
  },
  "room.mark.bee": {
    "ru": "пчела",
    "en": "bee"
  },
  "room.mark.dolphin": {
    "ru": "дельфин",
    "en": "dolphin"
  },
  "room.mark.butterfly": {
    "ru": "бабочка",
    "en": "butterfly"
  },
  "room.mark.penguin": {
    "ru": "пингвин",
    "en": "penguin"
  },
  "room.mark.flamingo": {
    "ru": "фламинго",
    "en": "flamingo"
  },
  "room.mark.koala": {
    "ru": "коала",
    "en": "koala"
  },
  "room.mark.hedgehog": {
    "ru": "ёж",
    "en": "hedgehog"
  },
  "room.mark.whale": {
    "ru": "кит",
    "en": "whale"
  },
  "room.mark.parrot": {
    "ru": "попугай",
    "en": "parrot"
  },
  "room.mark.ladybird": {
    "ru": "божья коровка",
    "en": "ladybird"
  },
  "room.mark.shark": {
    "ru": "акула",
    "en": "shark"
  },
  "room.mark.frog": {
    "ru": "лягушка",
    "en": "frog"
  },
  "room.mark.deer": {
    "ru": "олень",
    "en": "deer"
  },
  "room.mark.squirrel": {
    "ru": "белка",
    "en": "squirrel"
  },
  "room.mark.bat": {
    "ru": "летучая мышь",
    "en": "bat"
  },
  "room.mark.wolf": {
    "ru": "волк",
    "en": "wolf"
  },
  "room.mark.eagle": {
    "ru": "орёл",
    "en": "eagle"
  },
  "room.mark.pufferfish": {
    "ru": "рыба-фугу",
    "en": "pufferfish"
  },
  "room.mark.scorpion": {
    "ru": "скорпион",
    "en": "scorpion"
  },
  "room.mark.snail": {
    "ru": "улитка",
    "en": "snail"
  },
  "room.mark.sauropod": {
    "ru": "зауропод",
    "en": "sauropod"
  },
  "room.mark.T. rex": {
    "ru": "тираннозавр",
    "en": "T. rex"
  },
  "room.mark.crocodile": {
    "ru": "крокодил",
    "en": "crocodile"
  },
  "room.mark.peacock": {
    "ru": "павлин",
    "en": "peacock"
  },
  "room.mark.badger": {
    "ru": "барсук",
    "en": "badger"
  },
  "room.mark.camel": {
    "ru": "верблюд",
    "en": "camel"
  },
  "room.mark.sloth": {
    "ru": "ленивец",
    "en": "sloth"
  },
  "room.mark.otter": {
    "ru": "выдра",
    "en": "otter"
  },
  "room.mark.beaver": {
    "ru": "бобр",
    "en": "beaver"
  },
  "room.mark.leopard": {
    "ru": "леопард",
    "en": "leopard"
  },
  "room.mark.zebra": {
    "ru": "зебра",
    "en": "zebra"
  },
  "room.mark.giraffe": {
    "ru": "жираф",
    "en": "giraffe"
  },
  "room.mark.kangaroo": {
    "ru": "кенгуру",
    "en": "kangaroo"
  },
  "room.mark.elephant": {
    "ru": "слон",
    "en": "elephant"
  },
  "room.mark.rhino": {
    "ru": "носорог",
    "en": "rhino"
  },
  "room.mark.hippo": {
    "ru": "бегемот",
    "en": "hippo"
  },
  "room.mark.mark": {
    "ru": "метка",
    "en": "mark"
  },
  "room.mark.taken": {
    "ru": "{name} — занята",
    "en": "{name} — taken"
  },
  "room.mark.takenCount": {
    "ru": "· занято: {count}",
    "en": "· {count} taken"
  },
  "room.mark.owned": {
    "ru": "Ваша метка — {name}",
    "en": "The {name} is yours"
  },
  "room.cell.label": {
    "ru": "{type}, ячейка {count}",
    "en": "{type} cell {count}"
  },
  "room.cell.waitingInput": {
    "ru": "Ячейка ждёт ввода",
    "en": "The cell is waiting for input"
  },
  "room.kernel.starting": {
    "ru": "запускается…",
    "en": "starting…"
  },
  "room.kernel.restarting": {
    "ru": "перезапускается…",
    "en": "restarting…"
  },
  "room.kernel.state.starting": {
    "ru": "ЗАПУСК",
    "en": "STARTING"
  },
  "room.kernel.state.restarting": {
    "ru": "ПЕРЕЗАПУСК",
    "en": "RESTARTING"
  },
  "room.kernel.state.idle": {
    "ru": "ГОТОВО",
    "en": "IDLE"
  },
  "room.kernel.state.busy": {
    "ru": "ВЫПОЛНЯЕТСЯ",
    "en": "RUNNING"
  },
  "room.kernel.state.dead": {
    "ru": "ЯДРО ОСТАНОВЛЕНО",
    "en": "KERNEL STOPPED"
  },
  "room.head.fold": {
    "ru": "Свернуть шапку",
    "en": "Collapse the header"
  },
  "room.head.unfold": {
    "ru": "Развернуть шапку",
    "en": "Expand the header"
  },
  "room.oracle.shortcut": {
    "ru": "Оракул — {key}I",
    "en": "AI oracle — {key}I"
  },
  "room.person.self": {
    "ru": "{name} (вы)",
    "en": "{name} (you)"
  },
  "room.people.more": {
    "ru": "{names} и ещё {count}",
    "en": "{names} and {count} more"
  },
  "room.join.inside": {
    "ru": {
      "one": "{count} человек уже в комнате",
      "few": "{count} человека уже в комнате",
      "many": "{count} человек уже в комнате",
      "other": "{count} человека уже в комнате"
    },
    "en": {
      "one": "{count} person is already inside",
      "other": "{count} people are already inside"
    }
  },
  "Нет связи с сервером. Повторите запуск после подключения": {
    "ru": "Нет связи с сервером. Повторите запуск после подключения",
    "en": "No connection to the server. Try running again after reconnecting"
  },
  "В комнату сейчас заходит много людей — пробую ещё раз…": {
    "ru": "В комнату сейчас заходит много людей — пробую ещё раз…",
    "en": "Many people are joining the room — trying again…"
  },
  "В этом семинаре это делает преподаватель": {
    "ru": "На этом занятии это делает преподаватель",
    "en": "In this class, the teacher does this"
  },
  "Эту ячейку редактирует и запускает только преподаватель": {
    "ru": "Эту ячейку редактирует и запускает только преподаватель",
    "en": "Only the teacher can edit and run this cell"
  },
  "Консилиум закрыт. Ваш текст доступен в черновике": {
    "ru": "Консилиум закрыт. Ваш текст доступен в черновике",
    "en": "Council is closed. Your text is available in the draft"
  },
  "В этом семинаре можно запускать по одной ячейке. Ваша ячейка уже выполняется или стоит в очереди.": {
    "ru": "На этом занятии можно запускать по одной ячейке. Ваша ячейка уже выполняется или стоит в очереди.",
    "en": "This class allows one cell run at a time. Your cell is already running or queued."
  },
  "the room": {
    "ru": "комната",
    "en": "the room"
  },
  "ещё пишут": {
    "ru": "ещё пишут",
    "en": "still writing"
  },
  "room.council.label": {
    "ru": "Консилиум{cell}",
    "en": "Council{cell}"
  },
  "room.council.attempt": {
    "ru": "Попытка · {name}",
    "en": "Attempt · {name}"
  },
  "room.council.recipients": {
    "ru": "всем {count}",
    "en": "all {count}"
  },
  "room.notes.page": {
    "ru": "Заметки к странице {count}",
    "en": "Notes for page {count}"
  },
  "room.oracle.asker": {
    "ru": "спрашивает {name}",
    "en": "asked by {name}"
  },
  "room.files.loading": {
    "ru": "Загружается {name}",
    "en": "Loading {name}"
  },
  "room.terminal.author": {
    "ru": "запустил {name}",
    "en": "started by {name}"
  },
  "room.person.you": {
    "ru": "{name} — это вы",
    "en": "{name} — you"
  },
  "room.editor.Find": {
    "ru": "Найти",
    "en": "Find"
  },
  "room.editor.Replace": {
    "ru": "Заменить",
    "en": "Replace"
  },
  "room.editor.next": {
    "ru": "дальше",
    "en": "next"
  },
  "room.editor.previous": {
    "ru": "назад",
    "en": "previous"
  },
  "room.editor.all": {
    "ru": "все",
    "en": "all"
  },
  "room.editor.match case": {
    "ru": "учитывать регистр",
    "en": "match case"
  },
  "room.editor.regexp": {
    "ru": "регулярное выражение",
    "en": "regexp"
  },
  "room.editor.by word": {
    "ru": "слово целиком",
    "en": "by word"
  },
  "room.editor.replace": {
    "ru": "заменить",
    "en": "replace"
  },
  "room.editor.replace all": {
    "ru": "заменить все",
    "en": "replace all"
  },
  "room.editor.close": {
    "ru": "закрыть",
    "en": "close"
  },
  "room.editor.Go to line": {
    "ru": "Перейти к строке",
    "en": "Go to line"
  },
  "room.editor.go": {
    "ru": "перейти",
    "en": "go"
  },
  "room.editor.current match": {
    "ru": "текущее совпадение",
    "en": "current match"
  },
  "room.editor.on line": {
    "ru": "в строке",
    "en": "on line"
  },
  "room.editor.replaced $ matches": {
    "ru": "заменено совпадений: $",
    "en": "replaced $ matches"
  },
  "room.editor.replaced match on line $": {
    "ru": "заменено совпадение в строке $",
    "en": "replaced match on line $"
  },
  "room.editor.Completions": {
    "ru": "Подсказки",
    "en": "Completions"
  },
  "room.editor.Selection deleted": {
    "ru": "Выделенное удалено",
    "en": "Selection deleted"
  },
  "room.editor.Diagnostics": {
    "ru": "Диагностика",
    "en": "Diagnostics"
  },
  "room.editor.No diagnostics": {
    "ru": "Нет сообщений",
    "en": "No diagnostics"
  },
  "room.editor.Control character": {
    "ru": "Управляющий символ",
    "en": "Control character"
  },
  "room.editor.Fold line": {
    "ru": "Свернуть строку",
    "en": "Fold line"
  },
  "room.editor.Unfold line": {
    "ru": "Развернуть строку",
    "en": "Unfold line"
  },
  "session not found": {
    "ru": "Занятие не найдено",
    "en": "Class not found"
  },
  "publication not found": {
    "ru": "Публикация не найдена",
    "en": "Publication not found"
  },
  "step not found": {
    "ru": "Шаг не найден",
    "en": "Step not found"
  },
  "room.notebook.cellCount": {
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
  "room.ui.1254": {
    "ru": "убрать с экрана",
    "en": "take off screen"
  },
  "room.ui.1255": {
    "ru": "Вариант {p0}",
    "en": "Answer {p0}"
  },
  "room.ui.1256": {
    "ru": "показал преподаватель",
    "en": "shown by the teacher"
  },
  "room.ui.1258": {
    "ru": "Имена на проекторе",
    "en": "Names on the projector"
  },
  "room.ui.1259": {
    "ru": "Выключено — показанное подписано «Вариант N»",
    "en": "Off — a shown answer is signed “Answer N”"
  },
  "room.ui.1257": {
    "ru": {
      "one": "так же написал ещё {count}",
      "few": "так же написали ещё {count}",
      "many": "так же написали ещё {count}",
      "other": "так же написали ещё {count}"
    },
    "en": {
      "one": "{count} more wrote the same",
      "other": "{count} more wrote the same"
    }
  }
}

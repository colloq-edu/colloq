/**
 * Восемь строк, которыми описывается комната.
 *
 * Одно место на панель и на пульт в самой комнате — иначе две поверхности
 * спрашивают одно и то же разными словами, и преподаватель, поставивший
 * «только чтение» из панели, ищет в комнате переключатель, который называется
 * иначе.
 *
 * Порядок не алфавитный и не по важности, а по ходу занятия: сначала то, что
 * человек делает руками в тетради, потом ядро, потом всё общее.
 */
import type { RoomRules } from "@shared/rules";

export interface RuleOption {
  value: string;
  label: string;
}

export interface RuleRow {
  key: keyof RoomRules &
    ("run" | "edit" | "structure" | "files" | "wipe" | "restart" | "history");
  title: string;
  note: string;
  options: RuleOption[];
}

const EVERYONE = { value: "room", label: "Все" };
const TEACHER = { value: "host", label: "Преподаватель" };

export const RULE_ROWS: RuleRow[] = [
  {
    key: "edit",
    title: "Печатать в ячейках",
    note: "Тетрадь общая: «только преподаватель» делает её лекционной — все видят, никто не пишет.",
    options: [EVERYONE, TEACHER],
  },
  {
    key: "run",
    title: "Запускать ячейки",
    note: "Ядро одно на комнату, так что двадцать нажатий — это одна очередь.",
    options: [EVERYONE, { value: "single", label: "По одной" }, TEACHER],
  },
  {
    key: "structure",
    title: "Менять состав тетради",
    note: "«Только дописывать» — можно добавить свою ячейку, но не убрать и не переставить чужую.",
    options: [EVERYONE, { value: "add", label: "Только дописывать" }, TEACHER],
  },
  {
    key: "files",
    title: "Добавлять файлы",
    note: "Скачивать материалы может вся комната всегда — на это правило не влияет.",
    options: [EVERYONE, TEACHER],
  },
  {
    key: "history",
    title: "Смотреть ленту версий",
    note: "Кто что менял — не секрет от тех, при ком это менялось. Закрывают там, где лента это черновики.",
    options: [EVERYONE, TEACHER],
  },
  {
    key: "restart",
    title: "Перезапускать ядро",
    note: "Перезапуск теряет все переменные у всей комнаты разом.",
    options: [EVERYONE, TEACHER],
  },
  {
    key: "wipe",
    title: "Стирать общее",
    note: "Все выводы, расшифровка терминала, лента вопросов к оракулу. Свою ячейку человек чистит всегда.",
    options: [EVERYONE, TEACHER],
  },
];

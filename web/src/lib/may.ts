/**
 * Что этому человеку можно в этой комнате — в одном месте.
 *
 * Правило, которое останавливает, обязано сказать, что это правило, и сказать
 * там, где нажимают, и до нажатия. Разложить `allows(rules.edit, role)` по
 * двадцати компонентам — верный способ получить комнату, где половина кнопок
 * гаснет, а половина молча ничего не делает; вторые читаются как поломка и
 * приходят обратно баг-репортом.
 *
 * Фразы живут здесь же, рядом с правом: `controls.ts` уже умеет складывать их
 * с «нет связи» и знает, что связь важнее правила.
 */
import {
  allows,
  allowsRun,
  allowsShell,
  allowsStructure,
  readRules,
  type RoomRules,
} from "@shared/rules";
import type { ParticipantRole } from "@shared/protocol";

export interface Permits {
  rules: RoomRules;
  /** Печатать в ячейках. */
  edit: boolean;
  editWhy: string;
  /** Запустить ячейку. */
  run: boolean;
  runWhy: string;
  /** Запустить весь лист: Run All, Run Above, форматирование. */
  bulk: boolean;
  bulkWhy: string;
  /** Добавить ячейку. */
  add: boolean;
  /** Убрать ячейку. */
  remove: boolean;
  /** Переставить или продублировать. */
  move: boolean;
  structureWhy: string;
  /** Есть ли оболочка в комнате вообще. */
  shell: boolean;
  /** Можно ли в неё писать. */
  shellWrite: boolean;
  shellWhy: string;
  /** Стереть всё разом: доска, терминал, лента оракула. */
  wipe: boolean;
  wipeWhy: string;
  /** Перезапустить ядро. */
  restart: boolean;
  restartWhy: string;
  /** Видеть ленту версий. */
  history: boolean;
  /** Добавлять файлы. */
  files: boolean;
  filesWhy: string;
}

const HOSTS = "В этом семинаре это делает преподаватель";

export function permitsIn(rules: unknown, role: ParticipantRole): Permits {
  const read = readRules(rules);
  const structure = (verb: "add" | "remove" | "move"): boolean =>
    allowsStructure(read.structure, role, verb);
  return {
    rules: read,
    edit: allows(read.edit, role),
    editWhy: "Тетрадь в этом семинаре принадлежит преподавателю",
    run: allowsRun(read.run, role, "one"),
    runWhy: "Ячейки в этом семинаре запускает преподаватель",
    bulk: allowsRun(read.run, role, "bulk"),
    bulkWhy:
      read.run === "single" && role !== "host"
        ? "Здесь считают по одной ячейке"
        : "Весь лист в этом семинаре запускает преподаватель",
    add: structure("add"),
    remove: structure("remove"),
    move: structure("move"),
    structureWhy:
      read.structure === "add" && role !== "host"
        ? "Здесь можно добавлять свои ячейки, но не убирать и не переставлять"
        : "Состав тетради в этом семинаре — преподавательский",
    shell: allowsShell(read.terminal, role, "exist"),
    shellWrite: allowsShell(read.terminal, role, "type"),
    shellWhy: "Оболочка в этом семинаре принадлежит преподавателю",
    wipe: allows(read.wipe, role),
    wipeWhy: "Стирать общее здесь может преподаватель",
    restart: allows(read.restart, role),
    restartWhy: "Перезапускает ядро преподаватель",
    history: allows(read.history, role),
    files: allows(read.files, role),
    filesWhy: "Файлы в эту комнату добавляет преподаватель",
  };
}

export { HOSTS };

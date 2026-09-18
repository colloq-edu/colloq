/**
 * Что такое команда и где их брать.
 *
 * Реестр собирается из четырёх файлов, по файлу на группу. Порядок в help —
 * порядок массива внутри файла группы.
 *
 * Здесь только то, чем преподаватель ведёт занятие после `pip install colloq`:
 * поднять, выставить наружу, посмотреть, остановить, снять копию. Мастерская —
 * аренда машин, кластер, ретранслятор, DNS, сборка, тесты — живёт в Makefile
 * и scripts/, обёртки над ней здесь нет.
 */
import type { Env, Io } from './env.js'
import type { Sh } from './sh.js'
import type { Ui } from './ui.js'

import { commands as local } from './commands/local.js'
import { commands as host } from './commands/host.js'
import { commands as env } from './commands/env.js'
import { commands as tools } from './commands/tools.js'

export type Group = 'local' | 'host' | 'env' | 'tools'

/** Флаг команды. arg — имя значения; нет arg — флаг булев. */
export type Flag = {
  name: string
  short?: string
  arg?: string
  summary: string
  multiple?: boolean
}

/** Позиционный аргумент — для help. */
export type Arg = { name: string; summary: string; required?: boolean }

export type Ctx = {
  /** Позиционные аргументы после имени команды. */
  positionals: string[]
  /** Значения флагов из parseArgs. */
  values: Record<string, unknown>
  dryRun: boolean
  yes: boolean
  json: boolean
  sh: Sh
  ui: Ui
  env: Env
  io: Io
  /** Сколько сейчас идёт комнат (ядра в docker). Не запрещает ничего — только уточняет вопрос. */
  rooms(): Promise<number>
  /**
   * Приложение приехало готовым (колесо pip), а не запущено из исходников.
   *
   * Решает только одно — чем звать супервизор и откуда читать собранное:
   * cli/launch.mjs голым node или cli/src/launch.ts через tsx. Поведение
   * команд от него не зависит. Через ctx, а не своим взглядом на диск: модуль
   * группы не смотрит на файловую систему мимо ctx.io, иначе его нельзя
   * проверить, не разложив настоящий дистрибутив. Решает каркас — по признаку
   * у корня приложения (launch-state.ts · isDistribution).
   */
  dist: boolean
  /** Спросить самому: --yes и --dry-run отвечают «да» молча. */
  confirm(question: string): Promise<boolean>
}

export type Command = {
  name: string
  aliases?: string[]
  group: Group
  /** Одна строка по-английски: что делает. */
  summary: string
  /** Начинается с 'colloq '. */
  usage: string
  args?: Arg[]
  flags: Flag[]
  /** Меняет состояние машины. */
  destructive: boolean
  /**
   * Кто задаёт вопрос: 'cli' — каркас перед run(); 'script' — не спрашиваем
   * вовсе, спросит скрипт; 'self' — команда зовёт ctx.confirm() там, где ей
   * нужно.
   */
  confirm?: 'cli' | 'script' | 'self'
  confirmWhen?: (ctx: Ctx) => Promise<boolean>
  /** Вопрос каркаса. Функция — когда цена зависит от аргументов и флагов. */
  confirmQuestion?: string | ((ctx: Ctx) => string | Promise<string>)
  /**
   * Проверка аргументов ДО вопроса. Спрашивать «направить имя на этот адрес?»,
   * чтобы потом сказать «это не адрес», — значит спросить зря; бросает
   * UsageError или PreconditionError.
   */
  check?: (ctx: Ctx) => void | Promise<void>
  /**
   * Дописывать ли к вопросу число идущих комнат. Комнаты считаются на ЭТОЙ
   * машине: там, где писатели на арендованной, число сбивает с толку.
   */
  rooms?: boolean
  /** Что выполнится: `scripts/host.sh`, `native: …`. */
  delegates: string
  /** Примеры для --help. {domain} и {env} подставляются из .env. */
  examples?: string[]
  notes?: string
  run(ctx: Ctx): Promise<number>
}

export const GROUPS: { name: Group; title: string }[] = [
  { name: 'local', title: 'Locally' },
  { name: 'host', title: 'Class online' },
  { name: 'env', title: 'Kernel environments' },
  { name: 'tools', title: 'Tools' },
]

export const registry: Command[] = [...local, ...host, ...env, ...tools]

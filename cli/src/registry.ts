/**
 * Что такое команда и где их брать.
 *
 * Реестр собирается из пяти файлов, по файлу на группу. Агент группы правит
 * ровно свой файл и свой тест: ни строки здесь, в main.ts, ui.ts, sh.ts,
 * env.ts, Makefile и package.json группам менять не нужно. Порядок в help и в
 * меню — порядок массива внутри файла группы.
 */
import type { Env, Io } from './env.js'
import type { Sh } from './sh.js'
import type { Ui } from './ui.js'

import { commands as local } from './commands/local.js'
import { commands as host } from './commands/host.js'
import { commands as vast } from './commands/vast.js'
import { commands as env } from './commands/env.js'
import { commands as tools } from './commands/tools.js'

export type Group = 'local' | 'host' | 'vast' | 'env' | 'tools'

/** Флаг команды. arg — имя значения; нет arg — флаг булев. */
export type Flag = {
  name: string
  short?: string
  arg?: string
  summary: string
  multiple?: boolean
}

/**
 * Позиционный аргумент — для help и для вопроса в меню.
 *
 * makeVar — пара ВИДА=ЗНАЧЕНИЕ, которой этот же аргумент называют вместо
 * позиции: `colloq vast up NAME=hse` и `colloq vast up hse` — одно и то же.
 * Каркас считает обязательный аргумент названным, если пришла его пара, —
 * иначе required был бы несовместим с make-формой и им никто не пользовался бы.
 */
export type Arg = { name: string; summary: string; required?: boolean; makeVar?: string }

/** Как устроена эта машина: от этого зависит, чем останавливать и где смотреть журнал. */
export type Form = 'cluster' | 'service' | 'container' | 'host' | 'other'

export type Ctx = {
  /** Позиционные аргументы после имени команды. */
  positionals: string[]
  /** Значения флагов из parseArgs. */
  values: Record<string, unknown>
  /** Пары ВИДА=ЗНАЧЕНИЕ, снятые из argv: уходят делегируемому make как есть. */
  makeVars: Record<string, string>
  dryRun: boolean
  yes: boolean
  json: boolean
  sh: Sh
  ui: Ui
  env: Env
  io: Io
  /** Сколько сейчас идёт комнат (ядра в docker). Не запрещает ничего — только уточняет вопрос. */
  rooms(): Promise<number>
  /** Форма установки на этой машине. */
  form(): Promise<Form>
  /** Жив ли сервер этой машины: расписка .colloq.pid или кто-то на порту. */
  serverAlive(): Promise<boolean>
  /** Спросить самому: --yes и --dry-run отвечают «да» молча. */
  confirm(question: string): Promise<boolean>
}

export type Command = {
  name: string
  aliases?: string[]
  group: Group
  /** Одна строка по-русски: что делает. */
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
  /** Принимать позиционные сверх объявленных args (у colloq make это хвост цели). */
  extra?: boolean
  /** Что выполнится: `make host HOST=…`, `scripts/dns.sh sync`, `native`. */
  delegates: string
  /** Примеры для --help. {domain} и {env} подставляются из .env. */
  examples?: string[]
  notes?: string
  run(ctx: Ctx): Promise<number>
}

export const GROUPS: { name: Group; title: string }[] = [
  { name: 'local', title: 'Локально' },
  { name: 'host', title: 'Занятие в сети' },
  { name: 'vast', title: 'Машины и версии' },
  { name: 'env', title: 'Окружения ядра' },
  { name: 'tools', title: 'Инструменты' },
]

export const registry: Command[] = [...local, ...host, ...vast, ...env, ...tools]

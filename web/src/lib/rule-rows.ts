/**
 * Девять строк, которыми описывается комната.
 *
 * Одно место на панель и на пульт в самой комнате — иначе две поверхности
 * спрашивают одно и то же разными словами, и преподаватель, поставивший
 * «только чтение» из панели, ищет в комнате переключатель, который называется
 * иначе.
 *
 * Порядок не алфавитный и не по важности, а по ходу занятия: сначала то, что
 * человек делает руками в тетради, потом ядро, потом всё общее.
 */
import type { RoomRules } from '@shared/rules'

export interface RuleOption {
  value: string
  label: string
}

export interface RuleRow {
  key: keyof RoomRules &
    (
      | 'run'
      | 'edit'
      | 'structure'
      | 'board'
      | 'files'
      | 'agent'
      | 'wipe'
      | 'restart'
      | 'history'
    )
  title: string
  note: string
  options: RuleOption[]
}

const EVERYONE = { value: 'room', label: 'Все' }
const TEACHER = { value: 'host', label: 'Преподаватель' }

export const RULE_ROWS: RuleRow[] = [
  {
    key: 'edit',
    title: 'Печатать в ячейках',
    note: 'Тетрадь общая: «только преподаватель» делает её лекционной — все видят, никто не пишет.',
    options: [EVERYONE, TEACHER],
  },
  {
    key: 'run',
    title: 'Запускать ячейки',
    note: 'Ядро одно на комнату, так что двадцать нажатий — это одна очередь.',
    options: [EVERYONE, { value: 'single', label: 'По одной' }, TEACHER],
  },
  {
    key: 'structure',
    title: 'Менять состав тетради',
    note: '«Только дописывать» — можно добавить свою ячейку, но не убрать и не переставить чужую.',
    options: [EVERYONE, { value: 'add', label: 'Только дописывать' }, TEACHER],
  },
  {
    key: 'board',
    title: 'Показывать документ комнате',
    note: 'Поставить свой материал на общий экран. Смотреть и листать у себя может любой всегда.',
    options: [EVERYONE, TEACHER],
  },
  {
    key: 'files',
    title: 'Заводить и править файлы',
    note: 'Скачивать материалы может вся комната всегда — на это правило не влияет. Убирать и переименовывать — преподавательское при любом значении.',
    options: [EVERYONE, TEACHER],
  },
  {
    key: 'agent',
    title: 'Оракул правит файлы сам',
    note: 'Режим «сделать»: оракул читает папку, меняет файлы и запускает их, а весь ход отменяется одной кнопкой. В ячейки он по-прежнему только предлагает.',
    options: [EVERYONE, TEACHER, { value: 'off', label: 'Никто' }],
  },
  {
    key: 'history',
    title: 'Смотреть ленту версий',
    note: 'Кто что менял — не секрет от тех, при ком это менялось. Закрывают там, где лента это черновики.',
    options: [EVERYONE, TEACHER],
  },
  {
    key: 'restart',
    title: 'Перезапускать ядро',
    note: 'Перезапуск теряет все переменные у всей комнаты разом.',
    options: [EVERYONE, TEACHER],
  },
  {
    key: 'wipe',
    title: 'Стирать общее',
    note: 'Все выводы, расшифровка терминала, лента вопросов к оракулу. Свою ячейку человек чистит всегда.',
    options: [EVERYONE, TEACHER],
  },
]

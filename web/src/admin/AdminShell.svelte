<script lang="ts" module>
  export type AdminTab = 'seminars' | 'courses' | 'environments' | 'oracle' | 'teachers'

  /**
   * The numbers on the nav rows.
   *
   * They live in module scope rather than inside the shell because the count is
   * a claim about the list, and the list is edited on a screen the shell has
   * already handed control to — a sidebar that still says 5 after you deleted a
   * seminar is worse than one that says nothing. Screens that change a list
   * push the new length here; the shell only reads it.
   */
  class NavCounts {
    seminars = $state<number | null>(null)
    courses = $state<number | null>(null)
    teachers = $state<number | null>(null)
    environments = $state<number | null>(null)

    /**
     * Списки, которые уже отказали.
     *
     * 403 на «кто может учить» у обычного преподавателя — не разовая неудача, а
     * ответ, и он не меняется от того, что его переспросят при каждом переходе
     * по вкладкам. Отличать «не знаю» от «нет» приходится и здесь: `null` в
     * счётчике значит «ещё не спрашивали», отметка тут — «спросили, и не дали».
     */
    #refused = new Set<AdminTab>()

    /**
     * Только то, чего ещё никто не сказал, — и не то, за чем прямо сейчас идёт
     * открытый экран.
     *
     * Раньше здесь спрашивались все четыре списка на каждый переход по вкладкам,
     * а экран, на который переходили, тут же спрашивал то же самое второй раз.
     * Списки не дешёвые: `/seminars` на каждую строку разбирает снимок тетради
     * в Y.Doc, `/environments` — это `docker version` плюс `docker image
     * inspect` на каждое окружение, и всё это в том же цикле событий, который
     * в эту секунду ведёт чужую пару. Экраны знают свои числа и кладут их сюда
     * сами — поэтому список активной вкладки пропускается целиком: он приедет
     * от неё, и вторая копия того же запроса не приносит ничего, кроме docker.
     */
    async load(active?: AdminTab): Promise<void> {
      const ask = async (
        tab: AdminTab,
        known: number | null,
        read: () => Promise<number>,
      ): Promise<void> => {
        if (tab === active || known !== null || this.#refused.has(tab)) return
        try {
          const n = await read()
          if (tab === 'seminars') this.seminars = n
          else if (tab === 'courses') this.courses = n
          else if (tab === 'teachers') this.teachers = n
          else if (tab === 'environments') this.environments = n
        } catch {
          // Число не приехало и не приедет само: строка остаётся без цифры, а
          // не с выдуманной. Экран этой вкладки поставит её, когда его откроют.
          this.#refused.add(tab)
        }
      }
      await Promise.all([
        ask('seminars', this.seminars, () => adminApi.listSeminars().then((l) => l.length)),
        ask('courses', this.courses, () => adminApi.listCourses().then((l) => l.length)),
        ask('teachers', this.teachers, () => adminApi.listTeachers().then((l) => l.length)),
        ask('environments', this.environments, () =>
          adminApi.listEnvironments().then((r) => r.environments.length),
        ),
      ])
    }
  }

  export const navCounts = new NavCounts()
</script>

<script lang="ts">
  import { tr } from '@shared/i18n'
  import LanguageMenu from '@/admin/ui/LanguageMenu.svelte'
  import type { Snippet } from 'svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon, { type IconName } from '@/components/ui/Icon.svelte'
  import Wordmark from '@/components/ui/Wordmark.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'
  import { colorForId } from '@shared/protocol'
  /*
   * The panel's own motion, loaded with the panel. Three screens open the same
   * menu and the same dialog, so the rules are shared rather than copied into
   * three scoped <style> blocks; the shell is where they enter the bundle
   * because it is the one component every admin tab is rendered inside.
   */
  import '@/admin/motion.css'

  interface Props {
    tab: AdminTab
    navigate: (path: string) => void
    children: Snippet
  }

  let { tab, navigate, children }: Props = $props()

  interface NavItem {
    id: AdminTab
    label: string
    icon: IconName
    href: string
    /** Omitted where we have no honest number — an invented one teaches nothing. */
    count?: number | null
  }

  /*
   * Materials, Environments and Resources are designed and not built. A nav row
   * that leads nowhere costs more than the missing feature does: it teaches the
   * teacher that this panel lies, once, in the first minute.
   */
  const TEACHING = $derived<NavItem[]>([
    { id: 'seminars', label: tr("admin.seminars"), icon: 'board', href: '/admin', count: navCounts.seminars },
    {
      id: 'courses',
      label: tr("admin.courses"),
      icon: 'folder',
      href: '/admin/courses',
      count: navCounts.courses,
    },
    {
      id: 'environments',
      label: tr("admin.environments"),
      icon: 'box',
      href: '/admin/environments',
      count: navCounts.environments,
    },
  ])
  const INSTANCE = $derived<NavItem[]>([
    { id: 'oracle', label: tr("admin.oracle"), icon: 'sparkles', href: '/admin/oracle' },
    {
      id: 'teachers',
      label: tr("admin.who.can.teach"),
      icon: 'users',
      href: '/admin/teachers',
      count: navCounts.teachers,
    },
  ])

  const teacher = $derived(adminAuth.me?.teacher ?? null)

  // Досчитывается на навигации, а не опрашивается: спрашивается при этом только
  // ещё неизвестное, а изменившееся число кладёт сюда сам экран, который его
  // изменил.
  $effect(() => {
    void navCounts.load(tab)
  })

  function open(event: MouseEvent, href: string): void {
    // A middle click or a modifier means "new tab", and that is the browser's
    // job — intercepting it would break the one thing links do better than us.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    navigate(href)
  }
</script>

{#snippet section(label: string, items: NavItem[], first: boolean)}
  <div class={cn('flex shrink-0 flex-col gap-px', first ? 'pt-4' : 'pt-5')}>
    <!-- The group heading is the first thing to go on the narrow rail: with the
         labels gone it heads a column of icons, which it cannot describe. -->
    <p class="hidden px-5 pb-2 text-2xs font-bold uppercase tracking-section text-white/60 md:block">
      {label}
    </p>

    {#each items as item (item.id)}
      {@const active = item.id === tab}
      <!-- The rail is 3px of the row's own left edge in both states, so the
           label lane does not shift by three pixels as you navigate. -->
      <a
        href={item.href}
        aria-current={active ? 'page' : undefined}
        title={item.label}
        onclick={(event) => open(event, item.href)}
        class={cn(
          'flex h-[38px] items-center gap-3 border-l-[3px] pl-[17px] pr-5 transition-colors duration-100',
          'focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/30',
          active
            ? 'border-accent bg-brand-2/40 text-white'
            : 'border-transparent text-white/80 hover:bg-white/5 hover:text-white',
        )}
      >
        <Icon name={item.icon} size={15} class="shrink-0" />
        <span class={cn('hidden min-w-0 flex-1 truncate text-ui md:block', active && 'font-semibold')}>
          {item.label}
        </span>
        {#if item.count !== null && item.count !== undefined}
          <span
            class={cn(
              'hidden shrink-0 font-mono text-micro md:inline',
              active ? 'text-white/70' : 'text-white/60',
            )}
          >
            {item.count}
          </span>
        {/if}
      </a>
    {/each}
  </div>
{/snippet}

<div class="admin flex h-full bg-canvas">
  <!-- The brand navy is the same value in both themes, so the sidebar keeps its
       own contrast scale (white at a few alphas) rather than the ink tokens. -->
  <!--
    236px of rail on a 390px screen is 60% of the window spent on navigation,
    and the panel had no breakpoint at all: the provider form simply sat off
    the right edge. Below md the rail keeps the one thing it needs — where you
    are and where else you can go — as icons, and hands the width back. The
    labels come with the room to draw them.
  -->
  <nav class="flex w-14 shrink-0 flex-col bg-brand md:w-[236px]">
    <div
      class="flex h-16 shrink-0 items-center justify-center border-b border-white/10
             md:justify-start md:px-5"
    >
      <!-- Без строки организации, и не по забывчивости: рельс шириной 236px,
           его единственную строку уже делят логотип и версия, а надпись «кто
           мы» адресована пришедшим по ссылке, а не тем, кто здесь работает. -->
      <div class="hidden w-full md:block">
        <Wordmark version="v0.1" />
      </div>
      <!-- The mark alone: the lockup is a word at 0.22em tracking and there is
           no room for a word here. -->
      <Icon name="logo" size={18} class="text-white md:hidden" />
    </div>

    {@render section(tr("admin.teaching"), TEACHING, true)}
    {@render section(tr("admin.instance"), INSTANCE, false)}

    {#if adminAuth.isOwner}
      <LanguageMenu />
    {/if}

    {#if teacher}
      <div
        class="{adminAuth.isOwner ? '' : 'mt-auto border-t border-white/10'} flex min-h-[60px] shrink-0 flex-col items-center justify-center gap-1.5
               py-2 md:flex-row md:justify-start md:gap-2.5 md:px-5 md:py-0"
      >
        <Avatar name={teacher.name} color={colorForId(teacher.id)} size="md" title={teacher.email} />
        <div class="hidden min-w-0 flex-1 md:block">
          <p class="truncate text-ui font-semibold text-white">{teacher.name}</p>
          <!-- The artboard puts a faculty here; we have no faculty field, and
               the role is the thing that decides what this person can do. -->
          <p class="truncate text-2xs capitalize text-white/70">{tr(`admin.role.${teacher.role}`)}</p>
        </div>
        <button
          type="button"
          title={tr("admin.sign.out")}
          aria-label={tr("admin.sign.out")}
          onclick={() => void adminAuth.signOut()}
          class="inline-flex h-9 w-9 shrink-0 items-center justify-center text-white/60 transition-colors duration-100 hover:bg-white/10 hover:text-white"
        >
          <Icon name="x" size={15} />
        </button>
      </div>
    {/if}
  </nav>

  <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
    {@render children()}
  </main>
</div>

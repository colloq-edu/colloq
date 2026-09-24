<script lang="ts" module>
  export type AdminTab =
    | 'seminars'
    | 'courses'
    | 'competitions'
    | 'environments'
    | 'oracle'
    | 'teachers'

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
    competitions = $state<number | null>(null)
    teachers = $state<number | null>(null)
    environments = $state<number | null>(null)

    /**
     * Lists that have already refused.
     *
     * A 403 on "who can teach" for an ordinary teacher is not a one-off failure
     * but an answer, and it does not change by being asked again on every tab
     * switch. Here too "don't know" has to be told apart from "no": `null` in a
     * counter means "not asked yet", a mark here means "asked, and refused".
     */
    #refused = new Set<AdminTab>()

    /**
     * Only what nobody has told us yet — and not what the open screen is
     * fetching right now.
     *
     * This used to ask for all four lists on every tab switch, and the screen
     * being switched to immediately asked for the same thing a second time.
     * The lists are not cheap: `/seminars` parses a notebook snapshot into a
     * Y.Doc for every row, `/environments` is `docker version` plus `docker
     * image inspect` for every environment, and all of it runs in the same
     * event loop that is serving someone else's class at that very second.
     * Screens know their own numbers and put them here themselves — so the
     * active tab's list is skipped entirely: it will arrive from that tab, and
     * a second copy of the same request brings nothing but docker.
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
          else if (tab === 'competitions') this.competitions = n
          else if (tab === 'teachers') this.teachers = n
          else if (tab === 'environments') this.environments = n
        } catch {
          // The number did not arrive and will not arrive on its own: the row
          // stays without a figure rather than with an invented one. That
          // tab's screen will set it when it is opened.
          this.#refused.add(tab)
        }
      }
      await Promise.all([
        ask('seminars', this.seminars, () => adminApi.listSeminars().then((l) => l.length)),
        ask('courses', this.courses, () => adminApi.listCourses().then((l) => l.length)),
        ask('competitions', this.competitions, () =>
          adminApi.listCompetitions().then((r) => r.competitions.length),
        ),
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
    /*
     * Competitions sit under TEACHING, not under INSTANCE, even though their
     * queue and entrants are shared across the whole server.
     *
     * Because the tab is not about housekeeping but about a task the teacher
     * sets the class — like a class and like a course. INSTANCE holds what is
     * configured once and for everyone (the oracle, who can teach), whereas a
     * competition is set up for a class, runs for a week and is closed with a
     * review. The shared queue is shown inside the section as the runner strip
     * — where people look at it — and does not ask for a row of its own in the
     * rail.
     */
    {
      id: 'competitions',
      label: tr('competitions.title'),
      icon: 'table',
      href: '/admin/competitions',
      count: navCounts.competitions,
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

  // Counted on navigation, not polled: only what is still unknown gets asked
  // for, and a number that changed is put here by the very screen that
  // changed it.
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
      <!-- No organisation line, and not by oversight: the rail is 236px wide,
           its only line is already shared by the logo and the version, and a
           "who we are" caption is addressed to people arriving via a link, not
           to those who work here. -->
      <!--
        The logo links to the list of classes, as on any website.

        This is exactly where people leave the "New class" form: the hand goes
        to the top left corner before the eye finds "Cancel" at the bottom of
        the form, and an unclickable logo in that spot read as a frozen page. A
        link, not a button: a middle click and a ⌘-click open the list in a new
        tab — through the same `open` as the nav rows, and with the same route
        as "Classes". The link takes the full height of the rail header: a
        target the size of a 16-pixel icon is a miss, and the header is empty
        anyway.
      -->
      <a
        href="/admin"
        aria-label={tr("admin.seminars")}
        title={tr("admin.seminars")}
        onclick={(event) => open(event, '/admin')}
        class="flex h-full w-full items-center justify-center transition-opacity duration-100
               hover:opacity-80 focus:outline-none focus-visible:ring-4 focus-visible:ring-inset
               focus-visible:ring-accent/30 md:justify-start"
      >
        <div class="hidden w-full md:block">
          <Wordmark version={'v' + __COLLOQ_VERSION__} />
        </div>
        <!-- The mark alone: the lockup is a word at 0.22em tracking and there is
             no room for a word here. -->
        <Icon name="logo" size={18} class="text-white md:hidden" />
      </a>
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

  <main class="flex min-w-0 flex-1 flex-col overflow-hidden" class:competition-ui={tab === 'competitions'}>
    {@render children()}
  </main>
</div>

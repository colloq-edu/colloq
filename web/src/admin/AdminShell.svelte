<script lang="ts" module>
  export type AdminTab = 'seminars' | 'assistant' | 'teachers'

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
    teachers = $state<number | null>(null)

    /** Both lists, cheap, and independently: a teacher list that 403s must not
     * cost the seminar count. */
    async load(): Promise<void> {
      const [seminars, teachers] = await Promise.allSettled([
        adminApi.listSeminars(),
        adminApi.listTeachers(),
      ])
      if (seminars.status === 'fulfilled') this.seminars = seminars.value.length
      if (teachers.status === 'fulfilled') this.teachers = teachers.value.length
    }
  }

  export const navCounts = new NavCounts()
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon, { type IconName } from '@/components/ui/Icon.svelte'
  import Wordmark from '@/components/ui/Wordmark.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { adminApi } from '@/lib/adminApi'
  import { cn } from '@/lib/utils'
  import { colorForId } from '@shared/protocol'

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
    { id: 'seminars', label: 'Seminars', icon: 'board', href: '/admin', count: navCounts.seminars },
  ])
  const INSTANCE = $derived<NavItem[]>([
    { id: 'assistant', label: 'Assistant', icon: 'sparkles', href: '/admin/assistant' },
    {
      id: 'teachers',
      label: 'Who can teach',
      icon: 'users',
      href: '/admin/teachers',
      count: navCounts.teachers,
    },
  ])

  const teacher = $derived(adminAuth.me?.teacher ?? null)

  // Re-asked on every navigation rather than polled: the two screens that can
  // change a count are both one click away, and they push the new one anyway.
  $effect(() => {
    void tab
    void navCounts.load()
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
    <p class="px-5 pb-2 text-micro font-bold uppercase tracking-section text-white/45">{label}</p>

    {#each items as item (item.id)}
      {@const active = item.id === tab}
      <!-- The rail is 3px of the row's own left edge in both states, so the
           label lane does not shift by three pixels as you navigate. -->
      <a
        href={item.href}
        aria-current={active ? 'page' : undefined}
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
        <span class={cn('min-w-0 flex-1 truncate text-ui', active && 'font-semibold')}>
          {item.label}
        </span>
        {#if item.count !== null && item.count !== undefined}
          <span
            class={cn('shrink-0 font-mono text-micro', active ? 'text-white/70' : 'text-white/50')}
          >
            {item.count}
          </span>
        {/if}
      </a>
    {/each}
  </div>
{/snippet}

<div class="flex h-full bg-canvas">
  <!-- The brand navy is the same value in both themes, so the sidebar keeps its
       own contrast scale (white at a few alphas) rather than the ink tokens. -->
  <nav class="flex w-[236px] shrink-0 flex-col bg-brand">
    <div class="flex h-16 shrink-0 items-center border-b border-white/10 px-5">
      <Wordmark version="v0.1" />
    </div>

    {@render section('Teaching', TEACHING, true)}
    {@render section('Instance', INSTANCE, false)}

    {#if teacher}
      <div class="mt-auto flex h-[60px] shrink-0 items-center gap-2.5 border-t border-white/10 px-5">
        <Avatar name={teacher.name} color={colorForId(teacher.id)} size="md" title={teacher.email} />
        <div class="min-w-0 flex-1">
          <p class="truncate text-ui font-semibold text-white">{teacher.name}</p>
          <!-- The artboard puts a faculty here; we have no faculty field, and
               the role is the thing that decides what this person can do. -->
          <p class="truncate text-micro capitalize text-white/50">{teacher.role}</p>
        </div>
        <button
          type="button"
          title="Sign out"
          aria-label="Sign out"
          onclick={() => void adminAuth.signOut()}
          class="shrink-0 p-1.5 text-white/50 transition-colors duration-100 hover:bg-white/10 hover:text-white"
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

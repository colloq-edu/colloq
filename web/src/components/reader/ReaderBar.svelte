<!--
  The strip across the top of a public page: where you are, and the theme.

  The reader had neither a mark nor a theme switch, and a page opened from a
  chat at night was a white slab with nothing saying whose it was. On a
  class page the way up to the course is the first thing on a phone, a real
  link, because the course is the address a student keeps and the class page
  is the one they were sent.

  The metrics are the competition bar's (competitions/TopBar.svelte): 56 px
  at every width, the same gutters, the mark and the caps at 16 and 15 px.
  A student moves between /k and /c in one evening, and the two public
  faces of one product must not change size under the same logo.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import ThemeSwitch from '@/components/ui/ThemeSwitch.svelte'
  import { plainClick } from './links'

  interface Props {
    /** The course a class page belongs to; the course page itself passes none. */
    course?: { name: string; href: string } | null
    /** The last crumb: «Курс» on a course, «Занятие 02» on a class. */
    crumb?: string | null
    /** On a phone a class page swaps the mark for the way back to its course. */
    wide: boolean
    onnavigate: (path: string) => void
  }

  let { course = null, crumb = null, wide, onnavigate }: Props = $props()

  function up(event: MouseEvent): void {
    if (!course || !plainClick(event)) return
    event.preventDefault()
    onnavigate(course.href)
  }
</script>

<header
  class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-canvas px-4
         sm:px-10"
>
  {#if course && !wide}
    <a
      href={course.href}
      class="press -my-2 flex h-14 min-w-0 items-center gap-1.5 text-[16px] font-semibold leading-6
             text-accent-text"
      aria-label={`${tr('room.page.back')}: ${course.name}`}
      onclick={up}
    >
      <Icon name="chevron-left" size={16} strokeWidth={2.6} class="shrink-0" />
      <span class="truncate">{course.name}</span>
    </a>
  {:else}
    <div class="flex min-w-0 items-center gap-3.5">
      <Icon name="logo" size={16} class="shrink-0 text-primary" />
      <span class="shrink-0 text-[15px] font-black uppercase leading-[22px] tracking-section text-primary">
        Colloq
      </span>
      {#if course || crumb}
        <span class="h-[18px] w-px shrink-0 bg-line" aria-hidden="true"></span>
      {/if}
      {#if course}
        <a
          href={course.href}
          class="min-w-0 truncate text-[15px] font-semibold leading-[22px] text-accent-text
                 hover:underline"
          onclick={up}
        >
          {course.name}
        </a>
        {#if crumb}
          <span class="shrink-0 text-[15px] leading-[22px] text-faint" aria-hidden="true">/</span>
        {/if}
      {/if}
      {#if crumb}
        <span class="shrink-0 text-[15px] leading-[22px] text-muted">{crumb}</span>
      {/if}
    </div>
  {/if}
  <ThemeSwitch />
</header>

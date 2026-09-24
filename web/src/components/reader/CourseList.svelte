<!--
  The course page — the only Colloq address people bookmark. One seminar per
  row, in the order they were taught.

  A document, not a poster: one column, thin rules, no cards. People look at it
  twelve times a semester, and every time they are looking for one row.
-->
<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  import { plural } from '@/lib/plural'
  import type { PublicCourseView } from '@shared/publish'

  interface Props {
    course: PublicCourseView
    onnavigate: (path: string) => void
  }

  let { course, onnavigate }: Props = $props()

  const shortDate = (at: number): string =>
    new Date(at).toLocaleDateString(getLocale(), { day: 'numeric', month: 'long' })

  /* Number of published steps, with the shared plural rule. */
  const steps = (n: number): string => `${n} ${plural(n, tr('room.ui.713'), tr('room.ui.714'), tr('room.ui.715'))}`

  /* The same address as on the exported course page: the name, if one was
     chosen. */
  const href = (pub: { id: string; slug: string | null }): string => `/p/${pub.slug ?? pub.id}`
</script>

<!-- The arrow of a row that can be followed. Defined once, because there are
     two such rows: a live seminar and a closed room that still has its
     reading. -->
{#snippet chevron()}
  <span class="w-4 shrink-0 text-accent" aria-hidden="true">
    <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
      <path
        d="M1 1L6 6L1 11"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </span>
{/snippet}

<div class="min-h-screen bg-canvas px-6 pb-16 pt-16 sm:pt-24">
  <div class="mx-auto w-full max-w-[760px]">
    <h1 class="text-marquee-sm font-black leading-none tracking-tight text-ink sm:text-marquee">
      {course.name}
    </h1>
    {#if course.blurb}
      <p class="mt-3.5 max-w-[560px] text-ui-lg leading-relaxed text-muted">{course.blurb}</p>
    {/if}
    <!--
      The same address that is dictated out loud and printed on the exported
      page.

      This used to be `course.id` — eight random letters — even though the view
      has the course name, the panel copies and dictates exactly that name
      (admin/screens/Courses.svelte), and the static page prints `slug ?? id`
      (publish/render.ts). Both addresses work, but "save this page" under a
      line that was not on the board reads as someone else's page.
    -->
    <p class="mt-4 font-mono text-2xs text-muted">
      {location.host}/c/{course.slug ?? course.id}
    </p>

    <ol class="mt-11 border-t border-line">
      {#each course.items as item, index (index)}
        {@const ordinal = String(index + 1).padStart(2, '0')}
        {#if item.kind === 'gone' && item.publication}
          <!--
            A tombstone with the reading left behind it: deleting a seminar
            keeps the published page by default — a link cannot be taken back
            from students. Without this link row the page is alive and opens by
            its direct address, but from the course — the only address the class
            is given at all — there is no way to reach it.
          -->
          {@const closed = item.publication}
          <li class="border-b border-line">
            <button
              class="flex w-full items-baseline gap-6 py-5 text-left transition-colors duration-100 hover:bg-surface/70"
              onclick={() => onnavigate(href(closed))}
            >
              <span class="w-[34px] shrink-0 font-mono text-ui text-faint">{ordinal}</span>
              <span class="min-w-0 flex-1 text-title text-muted">{item.name}</span>
              <span class="shrink-0 text-ui text-muted">{tr('room.ui.709')}</span>
              {@render chevron()}
            </button>
          </li>
        {:else if item.kind === 'gone'}
          <!-- A tombstone. The row stays: a course from which the fourth week
               silently disappeared is broken for whoever attended it, and the
               numbers of the other rows shift and stop matching the
               timetable. -->
          <li class="flex items-baseline gap-6 border-b border-line py-5">
            <span class="w-[34px] shrink-0 font-mono text-ui text-faint">{ordinal}</span>
            <span class="min-w-0 flex-1 text-title text-muted">{item.name}</span>
            <span class="shrink-0 text-ui text-muted">{tr('room.ui.710')}</span>
            <span class="w-4 shrink-0"></span>
          </li>
        {:else if item.kind === 'seminar' && item.publication}
          {@const publication = item.publication}
          <li class="border-b border-line">
            <button
              class="flex w-full items-baseline gap-6 py-5 text-left transition-colors duration-100 hover:bg-surface/70"
              onclick={() => onnavigate(href(publication))}
            >
              <span class="w-[34px] shrink-0 font-mono text-ui text-muted">{ordinal}</span>
              <span class="min-w-0 flex-1 text-title font-semibold text-ink">{item.name}</span>
              <span class="shrink-0 text-ui text-muted">
                {shortDate(publication.publishedAt)} · {steps(publication.steps)}
              </span>
              {@render chevron()}
            </button>
          </li>
        {:else if item.kind === 'planned'}
          <!--
            A topic that has not been taught yet. The row is needed so that the
            course page is the semester plan from the first week: otherwise it
            is empty in September, and creating thirty rooms in advance means
            thirty links to empty notebooks three months before the class.
          -->
          <li class="flex items-baseline gap-6 border-b border-line py-5">
            <span class="w-[34px] shrink-0 font-mono text-ui text-faint">{ordinal}</span>
            <span class="min-w-0 flex-1 text-title text-muted">{item.name}</span>
            <!-- The week is now typed by hand in the panel, up to forty
                 characters, and on a single line on a phone it took the whole
                 width: the topic shrank to one word per line, and the week lay
                 on top of it. A short one ("14–20 Sep") still does not wrap —
                 45% is enough for it. -->
            <span class="max-w-[45%] shrink-0 break-words text-right text-ui text-muted">{item.when}</span>
            <span class="w-4 shrink-0"></span>
          </li>
        {:else}
          <li class="flex items-baseline gap-6 border-b border-line py-5">
            <span class="w-[34px] shrink-0 font-mono text-ui text-faint">{ordinal}</span>
            <span class="min-w-0 flex-1 text-title text-muted">{item.name}</span>
            <span class="shrink-0 text-ui text-muted">{tr('room.ui.711')}</span>
            <span class="w-4 shrink-0"></span>
          </li>
        {/if}
      {/each}
    </ol>

    <!--
      A promise, not a caption. In the first week the page has one row, and this
      sentence carries it entirely: otherwise a course of one seminar reads as
      broken.
    -->
    <p class="mt-9 text-ui text-muted"> {tr('room.ui.712')} </p>
  </div>
</div>

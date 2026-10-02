<!--
  «КОМНАТА ЗАНЯТИЯ»: the way from a class page back into its room.

  The page is a publication, frozen and forwardable; the room is where the
  class worked, and it keeps what the page does not carry: the edit history,
  the marks, the oracle thread with every asker's name. So the page never
  names its room, and this block draws only what the server's door answer
  allows (shared/publish.ts · RoomDoor): a way in for a browser that was
  there, for staff, or for everyone when the teacher chose «Все»; a locked
  sentence for someone who was not there; nothing when the room is closed to
  the page or gone.

  From 1024 px it is a block in the rail under the materials; below that, a
  row under the archive button, the way a phone lists everything else.
-->
<script lang="ts">
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import type { RoomDoor } from '@shared/publish'

  interface Props {
    door: RoomDoor
    wide: boolean
  }

  let { door, wide }: Props = $props()

  const room = $derived(door.room)
  /** Someone who was not there, on a page whose room is for participants. */
  const locked = $derived(room === null && door.access === 'members')

  /** The words beside the heading: who you are to this room, or what it lets you do. */
  const badge = $derived.by((): { text: string; tone: string } | null => {
    if (!room) return null
    if (door.staff) return { text: tr('room.door.staff'), tone: 'text-positive' }
    if (door.member) return { text: tr('room.door.member'), tone: 'text-positive' }
    return room.live
      ? { text: tr('room.door.live'), tone: 'text-accent-text' }
      : { text: tr('room.door.readOnly'), tone: 'text-muted' }
  })

  /**
   * The line under the button. A teacher reads what students see; a
   * participant reads what the room is now; anyone else reads the cost of
   * coming in: names and questions are on view there.
   */
  const note = $derived.by(() => {
    if (!room) return ''
    if (door.staff) {
      if (door.access === 'anyone') return tr('room.door.staffAnyone')
      if (door.access === 'none') return tr('room.door.staffNone')
      return tr('room.door.staffMembers')
    }
    if (door.member) return room.live ? tr('room.door.open') : tr('room.door.finished')
    return tr('room.door.names')
  })
</script>

{#if wide && (room || locked)}
  <section class="flex flex-col gap-3.5" aria-labelledby="room-door">
    <div class="flex items-end justify-between gap-3 border-b-2 border-ink pb-3">
      <h2
        id="room-door"
        class="text-[13px] font-black uppercase leading-4 tracking-section text-ink"
      >
        {tr('room.door.title')}
      </h2>
      {#if badge}
        <span
          class="text-right font-mono text-[11px] uppercase leading-4 tracking-label {badge.tone}"
        >
          {badge.text}
        </span>
      {:else}
        <span class="flex h-4 items-center text-faint" aria-hidden="true">
          <Icon name="lock" size={14} strokeWidth={2.2} />
        </span>
      {/if}
    </div>
    {#if room}
      <p class="text-ui-lg text-ink">{tr('room.door.about')}</p>
      <!-- A full load, in this tab: the room is its own app, and the way
           back is the browser's «Back». -->
      <a
        href={room.path}
        class="press flex h-11 shrink-0 items-center justify-center gap-2.5 border border-brand px-3
               text-[13px] font-bold uppercase leading-4 tracking-caps text-brand transition-colors
               duration-100 hover:bg-brand/5 dark:border-ink dark:text-ink dark:hover:bg-ink/5"
      >
        <span>{tr('room.door.go')}</span>
        <Icon name="arrow-right" size={16} strokeWidth={2.2} class="shrink-0" />
      </a>
      <p class="text-2xs text-muted">{note}</p>
    {:else}
      <p class="text-ui-lg text-muted">{tr('room.door.locked')}</p>
    {/if}
  </section>
{:else if !wide && room}
  <a
    href={room.path}
    class="press mt-2 flex min-h-[60px] items-center gap-3 border-y border-line py-2.5"
  >
    <span class="flex w-5 shrink-0 justify-center text-accent-text" aria-hidden="true">
      <Icon name="door" size={16} />
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-[16px] font-semibold leading-[22px] text-accent-text">
        {tr('room.door.title')}
      </span>
      <span class="text-2xs text-muted">{tr('room.door.rowNote')}</span>
    </span>
    <span class="shrink-0 text-accent" aria-hidden="true">
      <Icon name="chevron-right" size={16} strokeWidth={2.6} />
    </span>
  </a>
{:else if !wide && locked}
  <div class="mt-2 flex min-h-[60px] items-center gap-3 border-y border-line py-2.5">
    <span class="flex w-5 shrink-0 justify-center text-faint" aria-hidden="true">
      <Icon name="lock" size={16} />
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-[16px] font-semibold leading-[22px] text-muted">
        {tr('room.door.title')}
      </span>
      <span class="text-2xs text-muted">{tr('room.door.rowLocked')}</span>
    </span>
  </div>
{/if}

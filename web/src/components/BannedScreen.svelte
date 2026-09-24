<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * What someone removed from a class sees.
   *
   * Not an error and not a crash: the person was not let in, and they need
   * to understand who did it, until what time, and whom to go to. Silence
   * here would read as a broken Colloq, and a red banner as a breakage that
   * is not their fault; either one sends them off to fix the wrong thing.
   *
   * Nothing beyond what the server does. Neither "forever" nor "in all
   * browsers": a ban lives for a day and rests on a mark, and the very first
   * promise the room does not keep would devalue everything else on this
   * screen.
   *
   * One card for two places — the sign-in screen and an open tab — and the
   * frame around it is set by the caller: at sign-in it is the whole page, in
   * the room it sits on top of it.
   */
  import { untilWords } from '@/lib/bans'
  import Icon from '@/components/ui/Icon.svelte'

  interface Props {
    /** When the ban ends — the same moment the server named. */
    until: number
  }

  let { until }: Props = $props()
</script>

<div class="w-full max-w-sm text-center">
  <span
    class="mx-auto flex h-10 w-10 items-center justify-center border border-line bg-surface text-faint"
  >
    <Icon name="lock" size={16} />
  </span>
  <h1 class="mt-4 text-title font-semibold tracking-tight text-ink">{tr('room.ui.0')}</h1>
  <p class="mt-2 text-ui leading-relaxed text-muted"> {tr('room.ui.1')} {untilWords(until)}{tr('room.ui.2')} </p>
  <p class="mt-2 text-ui leading-relaxed text-muted"> {tr('room.ui.3')} </p>
</div>

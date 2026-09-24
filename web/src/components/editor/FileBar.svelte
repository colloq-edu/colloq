<!--
  The bar under the tabs that belongs to the open file.

  Exactly the spot where the notebook has Run All and Restart: every tab has
  its own action bar, and it always sits under the tab. That way a tab stops
  being just a switch — it names what the centre of the screen is busy with,
  and the bar under it says what can be done with that.
-->
<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { getSessionState } from '@/lib/session.svelte'
  import { permitsIn } from '@/lib/may'
  import { runnerFor } from '@shared/paths'

  interface Props {
    path: string
    /** Running is allowed in this room — the `run` rule. */
    mayRun: boolean
    /** Editing is allowed — the `files` rule. Otherwise it is read-only. */
    mayEdit: boolean
    /** Why editing is not allowed, when it is not. */
    whyReadOnly: string
    /**
     * The server refused an edit: from then on the document is read-only,
     * whatever the rule says.
     */
    refused: boolean
    onrun: () => void
  }

  let { path, mayRun, mayEdit, whyReadOnly, refused, onrun }: Props = $props()

  const session = getSessionState()

  /*
   * The permission comes as a prop, but the phrase comes from here: the `run`
   * rule is explained in the same words in three places (the cell's button,
   * this button, the terminal's input line), and they are the words the
   * server refuses with. A short copy of our own drifted from them silently.
   */
  const may = $derived(permitsIn(session.session.rules, session.me.role, session.finished))

  const runner = $derived(runnerFor(path))
  const entry = $derived(session.files.find((file) => file.path === path))

  /**
   * Who else has this file open.
   *
   * From the room's presence, not the file's: the latter only reaches someone
   * who already has the file open, and this has to be told to exactly the one
   * who is opening it. Names, not dots: there is room for a name here, and
   * "Ada is editing here" is what keeps a person from rewriting the same
   * line.
   */
  const here = $derived(
    session.peers
      .filter((peer) => !peer.isSelf && peer.user.editing === path)
      .map((peer) => peer.user)
      .filter((user, at, all) => all.findIndex((other) => other.id === user.id) === at)
      .slice(0, 3),
  )

  const savedAt = $derived(
    entry
      ? new Date(entry.modifiedAt).toLocaleTimeString(getLocale(), {
          hour: '2-digit',
          minute: '2-digit',
        })
      : null,
  )
</script>

<div class="flex h-[34px] shrink-0 items-stretch border-b border-line bg-canvas">
  {#if runner}
    <!--
      The run is the same as a cell's: the same container, the same Python,
      the same "interrupt" button in the terminal. The only difference is
      where the output goes.

      The transition is a list of properties, not the `transition` shorthand:
      that one animates ALL properties, including the focus ring's
      border-color and box-shadow, and the ring would slide in after the key
      instead of appearing at once. Exactly two move here — brightness under
      the cursor and scale under the finger; the bar is drawn by hand and
      does not fit `.btn` (see index.css · .btn, where the same list is given
      position by position, and this button's twin — "Share screen" in
      SessionScreen).
    -->
    <button
      type="button"
      class="flex shrink-0 items-center gap-2 px-4 text-2xs font-bold uppercase tracking-label
             transition-[filter,transform] duration-press ease-out
             focus-visible:outline-none focus-visible:ring-2
             focus-visible:ring-inset focus-visible:ring-accent/40
             {mayRun
        ? 'bg-primary text-primary-ink enabled:active:scale-[0.97] hover:brightness-110 active:brightness-95'
        : 'cursor-not-allowed bg-surface text-faint'}"
      disabled={!mayRun}
      title={mayRun
        ? tr('room.extra.31', { p0: runner === 'python' ? 'python -u' : 'bash', p1: path })
        : may.runWhy}
      onclick={onrun}
    >
      <Icon name="play" size={11} /> {tr('room.ui.73')} </button>
  {/if}

  <span class="flex-1"></span>

  <!--
    The right half of the bar SHRINKS, and the left one (the run button)
    does not.

    The reason for a permission refusal is a whole sentence ("The teacher
    allowed only themselves to edit"), and next to it come the names of those
    who have the file open. On a phone all of that, together with the "Run"
    button, is twice as wide as the screen, and it stood under `shrink-0`:
    the bar slid off to the right under the room's `overflow-hidden`, and the
    sentence kept its beginning without an end. Now what is READ shrinks and
    is cut with an ellipsis, while what is PRESSED stays whole.
  -->
  <div class="flex min-w-0 shrink items-center gap-2.5 px-3 sm:px-5">
    {#if refused || !mayEdit}
      <!--
        The rule outranks the refusal, not the other way round.

        "The edit was not accepted" is about an edit that never happened: for
        someone who can only read in this room anyway, the socket refuses at
        the very opening, and a person who had typed nothing got a reproach
        instead of the rule. The refusal is named only where typing was
        allowed.
      -->
      <span
        class="flex min-w-0 items-center gap-1.5 text-2xs text-muted"
        title={mayEdit ? tr('room.ui.104') : whyReadOnly}
      >
        <Icon name="lock" size={11} class="shrink-0" />
        <span class="truncate">{mayEdit ? tr('room.ui.104') : whyReadOnly}</span>
      </span>
    {:else if savedAt}
      <!-- The time of the last write to disk, not "there are unsaved
           changes": the file lands on disk by itself a second after the last
           keystroke, and this product has no "save" button. -->
      <span class="font-mono text-2xs tabular-nums text-muted">{tr('room.ui.105')} {savedAt}</span>
    {/if}

    {#if here.length > 0}
      <span class="h-3.5 w-px shrink-0 bg-line" aria-hidden="true"></span>
      <!-- The names shrink too: three people with long names make one more
           screen width, and pushing the refusal reason out with them is
           unfair. -->
      <span class="flex min-w-0 items-center gap-2">
        {#each here as user (user.id)}
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" style={`background:${user.color}`}></span>
            <span class="truncate text-2xs text-muted">{user.name}</span>
          </span>
        {/each}
        <span class="shrink-0 text-2xs text-muted">{tr('room.ui.106')}</span>
      </span>
    {/if}
  </div>
</div>

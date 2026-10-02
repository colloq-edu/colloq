<!--
  A square tick, as the class page artboards draw it: an ink square with a
  check in the canvas colour, or an empty frame.

  A real <input type="checkbox"> underneath, not a button that pretends:
  the keyboard, the label it sits in and a screen reader all get the native
  control. The check is drawn in `text-canvas` rather than white, because in
  the dark theme the ink square turns light and a white check would vanish
  into it.
-->
<script lang="ts">
  interface Props {
    checked: boolean
    disabled?: boolean
    /** For a box that sits without a visible label next to it. */
    label?: string
    /** 18 in the picker rows, 16 in the course row form. */
    size?: 16 | 18
    onchange?: (checked: boolean) => void
  }

  let { checked = $bindable(), disabled = false, label, size = 18, onchange }: Props = $props()
</script>

<span class="relative inline-flex shrink-0 {size === 16 ? 'h-4 w-4' : 'h-[18px] w-[18px]'}">
  <input
    type="checkbox"
    class="peer absolute inset-0 m-0 cursor-pointer appearance-none border-[1.5px] border-faint bg-canvas
           transition-colors duration-quick checked:border-ink checked:bg-ink
           focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
           focus-visible:outline-accent-text disabled:cursor-not-allowed disabled:opacity-40"
    aria-label={label}
    {disabled}
    bind:checked
    onchange={(event) => onchange?.(event.currentTarget.checked)}
  />
  <svg
    class="pointer-events-none absolute inset-0 m-auto hidden text-canvas peer-checked:block"
    width="12"
    height="12"
    viewBox="0 0 12 12"
    aria-hidden="true"
  >
    <path d="M2.5 6.2L5 8.6L9.6 3.6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" />
  </svg>
</span>

<!--
  The search box in a page header's actions.

  A real .field, so it is the same height, border and focus halo as every
  other field in the panel — the hand-built boxes it replaces were 34 px
  beside 40 px buttons, with a ring of their own. 240 px on a desktop; the
  whole actions line on a phone, where AdminPage gives that line a width.
-->
<script lang="ts">
  import Icon from '@/components/ui/Icon.svelte'
  import { cn } from '@/lib/utils'

  interface Props {
    value: string
    /** The accessible name; also the placeholder unless one is given. */
    label: string
    placeholder?: string
    class?: string
  }

  let { value = $bindable(), label, placeholder, class: extra = '' }: Props = $props()
</script>

<label class={cn('relative flex w-[240px] max-w-full items-center max-[640px]:w-full', extra)}>
  <Icon name="search" size={14} class="pointer-events-none absolute left-3 text-faint" />
  <input
    type="search"
    class="field pl-9"
    placeholder={placeholder ?? label}
    aria-label={label}
    bind:value
  />
</label>

<script lang="ts">
  /**
   * Two cells, one border: the theme is always a visible pair, never a mystery
   * toggle whose meaning depends on the state you are already in.
   */
  import Icon from '@/components/ui/Icon.svelte'
  import { theme, type ThemeName } from '@/lib/theme.svelte'

  interface Props {
    class?: string
    /**
     * Which ground the switch sits on. `onLight` follows the theme tokens;
     * `onDark` is the brand band, whose navy is the same in both themes and so
     * cannot use an ink that flips with them.
     */
    tone?: 'onDark' | 'onLight'
  }

  let { class: className = '', tone = 'onLight' }: Props = $props()

  const onDark = $derived(tone === 'onDark')

  const CELL = $derived(
    'flex h-7 w-8 items-center justify-center transition-colors duration-100 ' +
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ' +
      (onDark ? 'focus-visible:ring-white' : 'focus-visible:ring-accent/40'),
  )

  const cell = (name: ThemeName): string => {
    const on = theme.current === name
    if (onDark) return `${CELL} ${on ? 'bg-white text-brand' : 'text-white opacity-55'}`
    return `${CELL} ${on ? 'bg-ink text-canvas' : 'text-faint hover:text-ink'}`
  }

  const OPTIONS: { name: ThemeName; label: string; icon: 'sun' | 'moon' }[] = [
    { name: 'light', label: 'Light theme', icon: 'sun' },
    { name: 'dark', label: 'Dark theme', icon: 'moon' },
  ]
</script>

<div
  role="group"
  aria-label="Colour theme"
  class="inline-flex shrink-0 overflow-hidden border {onDark ? 'border-brand-2' : 'border-line'}
         {className}"
>
  {#each OPTIONS as option, i (option.name)}
    <button
      type="button"
      class="{cell(option.name)} {i > 0 ? `border-l ${onDark ? 'border-brand-2' : 'border-line'}` : ''}"
      aria-pressed={theme.current === option.name}
      aria-label={option.label}
      title={option.label}
      onclick={() => theme.set(option.name)}
    >
      <Icon name={option.icon} size={14} />
    </button>
  {/each}
</div>

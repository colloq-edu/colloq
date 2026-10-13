<script lang="ts">
  import { cn } from '@/lib/utils'

  export interface ChoiceOption {
    value: string
    label: string
    hint?: string
  }

  interface Props {
    options: ChoiceOption[]
    value: string
    onchange: (v: string) => void
    /** 'lg' spells out what each option means; 'sm' assumes the label is enough. */
    size?: 'sm' | 'lg'
    /**
     * Shown but not choosable: the choice does not apply here (a GPU switch
     * on an environment without CUDA), and the line beside it says why.
     */
    disabled?: boolean
  }

  let { options, value, onchange, size = 'sm', disabled = false }: Props = $props()
</script>

{#if size === 'lg'}
  <div class={cn('flex flex-col overflow-hidden border border-line sm:flex-row', disabled && 'opacity-55')}>
    {#each options as option (option.value)}
      {@const on = option.value === value}
      <button
        type="button"
        aria-pressed={on}
        {disabled}
        onclick={() => onchange(option.value)}
        class={cn(
          'min-w-0 flex-1 border-t border-line px-3.5 py-2.5 text-left first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0',
          'transition-colors duration-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/15',
          'disabled:cursor-not-allowed',
          on ? 'bg-primary' : disabled ? 'bg-canvas' : 'bg-canvas hover:bg-surface',
        )}
      >
        <span class={cn('block text-ui font-semibold', on ? 'text-primary-ink' : 'text-ink')}>
          {option.label}
        </span>
        {#if option.hint}
          <span class={cn('mt-0.5 block text-2xs', on ? 'text-primary-ink/75' : 'text-muted')}>
            {option.hint}
          </span>
        {/if}
      </button>
    {/each}
  </div>
{:else}
  <div class={cn('flex flex-wrap items-center gap-2', disabled && 'opacity-55')}>
    {#each options as option (option.value)}
      {@const on = option.value === value}
      <button
        type="button"
        aria-pressed={on}
        title={option.hint}
        {disabled}
        onclick={() => onchange(option.value)}
        class={cn(
          // The panel's control height (index.css · .admin-ui): a preset chip
          // sits in a row with fields and buttons, and 38 beside 40 showed.
          'inline-flex min-h-10 items-center border px-3 py-1.5 text-ui font-medium',
          'transition-colors duration-100 max-[640px]:min-h-11',
          'focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/15 disabled:cursor-not-allowed',
          on
            ? 'border-primary bg-primary text-primary-ink'
            : disabled
              ? 'border-line bg-surface text-ink'
              : 'border-line bg-surface text-ink hover:border-faint hover:bg-raised',
        )}
      >
        {option.label}
      </button>
    {/each}
  </div>
{/if}

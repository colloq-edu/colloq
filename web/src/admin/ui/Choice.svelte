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
  }

  let { options, value, onchange, size = 'sm' }: Props = $props()
</script>

{#if size === 'lg'}
  <div class="flex flex-col overflow-hidden border border-line sm:flex-row">
    {#each options as option (option.value)}
      {@const on = option.value === value}
      <button
        type="button"
        aria-pressed={on}
        onclick={() => onchange(option.value)}
        class={cn(
          'min-w-0 flex-1 border-t border-line px-3.5 py-2.5 text-left first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0',
          'transition-colors duration-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/15',
          on ? 'bg-primary' : 'bg-canvas hover:bg-surface',
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
  <div class="flex flex-wrap items-center gap-2">
    {#each options as option (option.value)}
      {@const on = option.value === value}
      <button
        type="button"
        aria-pressed={on}
        title={option.hint}
        onclick={() => onchange(option.value)}
        class={cn(
          ' border px-3 py-1.5 text-ui font-medium transition-colors duration-100',
          'focus:outline-none focus-visible:ring-4 focus-visible:ring-accent/15',
          on
            ? 'border-primary bg-primary text-primary-ink'
            : 'border-line bg-surface text-ink hover:border-faint hover:bg-raised',
        )}
      >
        {option.label}
      </button>
    {/each}
  </div>
{/if}

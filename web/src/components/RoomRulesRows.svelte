<!--
  Правила комнаты восемью строками.

  Одна разметка на панель и на пульт в самой комнате: настройка, которую в двух
  местах называют по-разному, — это две настройки, и преподаватель будет искать
  в комнате переключатель, который поставил из панели.
-->
<script lang="ts">
  import { RULE_ROWS } from '@/lib/rule-rows'
  import type { RoomRules } from '@shared/rules'

  interface Props {
    rules: RoomRules
    /** Что изменилось — один ключ за раз, чтобы вызывающий сам решил, как это сохранить. */
    onchange: (patch: Partial<RoomRules>) => void
    /** Пока сохранение в пути: переключатели не врут о том, что уже применилось. */
    busy?: boolean
  }

  let { rules, onchange, busy = false }: Props = $props()
</script>

<div class="flex flex-col">
  {#each RULE_ROWS as row (row.key)}
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line-soft py-3 last:border-b-0"
    >
      <div class="min-w-0 flex-1 basis-56">
        <p class="text-ui font-semibold text-ink">{row.title}</p>
        <p class="mt-0.5 text-2xs leading-snug text-muted">{row.note}</p>
      </div>
      <div class="flex shrink-0 border border-line" role="group" aria-label={row.title}>
        {#each row.options as option (option.value)}
          <button
            type="button"
            class="rule-seg {rules[row.key] === option.value ? 'rule-seg-on' : ''}"
            aria-pressed={rules[row.key] === option.value}
            disabled={busy}
            onclick={() => onchange({ [row.key]: option.value } as Partial<RoomRules>)}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .rule-seg {
    height: 30px;
    padding-inline: 11px;
    /* Живое правило не должно быть самым мелким текстом на экране — тот же
       довод, что и у сегмента «кто запускает» на экране создания. */
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: rgb(var(--muted));
    background: none;
    border: 0;
    border-right: 1px solid rgb(var(--line));
    white-space: nowrap;
    transition:
      background-color 100ms ease-out,
      color 100ms ease-out,
      transform 100ms ease-out;
  }
  .rule-seg:last-child {
    border-right: 0;
  }
  .rule-seg:hover:not(:disabled) {
    color: rgb(var(--ink));
  }
  .rule-seg:active:not(:disabled) {
    transform: scale(0.97);
  }
  .rule-seg:disabled {
    opacity: 0.5;
  }
  .rule-seg-on {
    background: rgb(var(--primary));
    color: rgb(var(--primary-ink));
    font-weight: 700;
  }
  .rule-seg-on:hover {
    color: rgb(var(--primary-ink));
  }
  .rule-seg:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px rgb(var(--accent) / 0.5);
  }
</style>

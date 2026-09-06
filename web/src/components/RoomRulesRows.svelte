<!--
  Правила комнаты одиннадцатью строками.

  Одна разметка на панель и на пульт в самой комнате: настройка, которую в двух
  местах называют по-разному, — это две настройки, и преподаватель будет искать
  в комнате переключатель, который поставил из панели.

  Строки двух видов, но рамка у них одна: слева название и подпись, справа одна
  ручка. У девяти правил это переключатель, у двух потолков оракула — поле с
  числом, потому что «сколько вопросов в час» тремя словами не выбрать.
-->
<script lang="ts">
  import { RULE_ROWS, type LimitRow } from '@/lib/rule-rows'
  import type { OracleLimits, RoomRules } from '@shared/rules'

  interface Props {
    rules: RoomRules
    /** Что изменилось — один ключ за раз, чтобы вызывающий сам решил, как это сохранить. */
    onchange: (patch: Partial<RoomRules>) => void
    /** Пока сохранение в пути: переключатели не врут о том, что уже применилось. */
    busy?: boolean
    /**
     * Действующие потолки инстанса — чтобы «как на инстансе» называло число.
     *
     * Необязательные: экран, который их ещё не спросил (или не дождался),
     * рисует те же две строки без подсказки, а не прячет правило целиком.
     */
    instance?: OracleLimits | null
  }

  let { rules, onchange, busy = false, instance = null }: Props = $props()

  /**
   * Число сохраняется по уходу из поля, а не по каждой цифре.
   *
   * Одно изменение — один PATCH на всю комнату (см. `setRule` в
   * SessionScreen), и «2» по дороге к «20» — это лишнее правило, которое
   * успеет доехать до класса и развернуть чей-то вопрос.
   */
  function commit(row: LimitRow, field: HTMLInputElement): void {
    const current = rules[row.key]
    const text = field.value.trim()
    if (!text) {
      if (current !== null) onchange({ [row.key]: null } as Partial<RoomRules>)
      return
    }
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) {
      // Поле возвращается к сохранённому: оставить в нём мусор — значит
      // показывать правило, которого нет.
      field.value = current === null ? '' : String(current)
      return
    }
    const value = Math.min(Math.max(Math.round(parsed), row.min), row.max)
    field.value = String(value)
    if (value !== current) onchange({ [row.key]: value } as Partial<RoomRules>)
  }
</script>

<div class="flex flex-col">
  {#each RULE_ROWS as row (row.key)}
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line-soft py-3 last:border-b-0"
    >
      <div class="min-w-0 flex-1 basis-56">
        <p class="text-ui font-semibold text-ink">{row.title}</p>
        <p class="mt-0.5 text-2xs leading-snug text-muted">{row.note}</p>
        {#if row.kind === 'limit' && instance}
          <p class="mt-0.5 text-2xs font-semibold leading-snug text-muted">
            Сейчас на инстансе: {row.atInstance(instance[row.key])}
          </p>
        {/if}
      </div>
      {#if row.kind === 'choice'}
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
      {:else}
        <div class="flex shrink-0 items-center gap-2">
          <input
            class="rule-num"
            type="number"
            inputmode="numeric"
            min={row.min}
            max={row.max}
            step="1"
            value={rules[row.key] ?? ''}
            placeholder={instance ? String(instance[row.key]) : '—'}
            aria-label={row.title}
            disabled={busy}
            onchange={(event) => commit(row, event.currentTarget)}
          />
          <span class="text-2xs font-semibold text-muted">{row.unit}</span>
          <!-- Пусто — это и есть «как на инстансе», но стирать поле руками
               незачем: кнопка появляется только там, где есть что снять. -->
          {#if rules[row.key] !== null}
            <button
              type="button"
              class="rule-clear"
              disabled={busy}
              onclick={() => onchange({ [row.key]: null } as Partial<RoomRules>)}
            >
              как на инстансе
            </button>
          {/if}
        </div>
      {/if}
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

  /* Поле числа — по мерке переключателя рядом: одна высота, одна рамка, один
     кегль, чтобы две строки из одиннадцати не выглядели чужими. */
  .rule-num {
    width: 4.5rem;
    height: 30px;
    padding-inline: 8px;
    font-size: 12.5px;
    font-weight: 600;
    text-align: right;
    color: rgb(var(--ink));
    background: none;
    border: 1px solid rgb(var(--line));
    appearance: textfield;
  }
  /* Пустое поле показывает инстансовое число серым: «как на инстансе» —
     значение, а не отсутствие значения. */
  .rule-num::placeholder {
    color: rgb(var(--muted));
    font-weight: 600;
    opacity: 0.7;
  }
  /* Стрелки съедают половину ширины и меняют число мимо сохранения. */
  .rule-num::-webkit-outer-spin-button,
  .rule-num::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .rule-num:disabled {
    opacity: 0.5;
  }
  .rule-num:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px rgb(var(--accent) / 0.5);
  }
  .rule-clear {
    font-size: 11px;
    font-weight: 600;
    color: rgb(var(--muted));
    background: none;
    border: 0;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
    white-space: nowrap;
  }
  .rule-clear:hover:not(:disabled) {
    color: rgb(var(--ink));
  }
  .rule-clear:disabled {
    opacity: 0.5;
  }
  .rule-clear:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgb(var(--accent) / 0.5);
  }
</style>

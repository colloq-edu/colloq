/**
 * The languages a contest can offer, named for a person.
 *
 * A contest runs in one of the class kernel images, and which compilers that
 * image holds is a fact of the image, not of the code: `python3` is always
 * there, `g++`/`gcc` are there only once the base kernel adds them. So the
 * editor's choice of language is built from a PROBE of the image (the real one
 * in docker-judge.ts, a fixed one in fake-judge.ts), and these two pure
 * functions turn that probe into the `LanguageOption` the panel and the
 * participant see (shared/contests-entrant.ts): a label with the compiler's
 * version, and whether the image can run it at all.
 *
 * THE LABELS ARE PRODUCT WORDS, NOT UI TEXT. «Python 3.11», «C++20 · g++ 12.2»
 * — the language and compiler names are international and are never translated
 * (the same rule the verdict codes keep, shared/locales/contests.ts). So they
 * are assembled here, from the ids and the probe, rather than carried as `tr`
 * keys: there is nothing in them for a catalogue to hold.
 *
 * Pure and data-only on purpose, like the standings in shared/contests.ts: the
 * server fills `LanguageOption[]` with these, and the suite checks them with no
 * image and no docker (judge/languages is covered in tests).
 */
import { LANGUAGE_TOOL, type ContestLanguage } from '@shared/contests'
import type { LanguageProbe } from './port.js'

/**
 * What a language is called before its version: the fixed head of its label.
 * The standard's year is part of the name a teacher chose in the editor
 * («C++20», «C17»), so it lives here and not in the probe.
 */
const DISPLAY: Record<ContestLanguage, string> = {
  python3: 'Python',
  cpp20: 'C++20',
  c17: 'C17',
}

/**
 * The compiler's own name, shown after a middle dot before its version
 * («· g++ 12.2»); empty for Python, whose version follows the name directly
 * («Python 3.11»), because the interpreter is the language.
 */
const COMPILER: Record<ContestLanguage, string> = {
  python3: '',
  cpp20: 'g++',
  c17: 'gcc',
}

/**
 * A version as a label wears it: the first two numbers, so `3.11.16` reads
 * `3.11` and `12.2.0` reads `12.2`. Everything but the leading `<major>` or
 * `<major>.<minor>` is dropped — a build suffix like `12.2.0-14` is noise to a
 * student choosing a language — and a string with no leading number comes back
 * whole, trimmed, so an image that answers something unexpected still shows it
 * rather than nothing.
 */
export function shortVersion(version: string): string {
  const value = String(version ?? '').trim()
  const match = /^(\d+)(?:\.(\d+))?/.exec(value)
  if (!match) return value
  return match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`
}

/** The version string the probe holds for a language's tool, or null — the image lacks it. */
function versionOf(id: ContestLanguage, probe: LanguageProbe): string | null {
  return probe[LANGUAGE_TOOL[id]]
}

/**
 * Whether this image can run this language: its tool reported a version.
 *
 * The one fact the editor acts on — a language the image cannot run is offered
 * disabled, and a submission in it is refused (`language`, the doors). Read off
 * the same probe the label is, so the two never disagree.
 */
export function languageAvailable(id: ContestLanguage, probe: LanguageProbe): boolean {
  return versionOf(id, probe) !== null
}

/**
 * The label the editor shows for a language: «Python 3.11», «C++20 · g++ 12.2»,
 * «C17 · gcc 12.2». When the image does not have the tool (the probe is null),
 * the bare product name without a version («C++20»), because there is no
 * compiler to name a version of; `languageAvailable` is what greys it out.
 */
export function languageLabel(id: ContestLanguage, probe: LanguageProbe): string {
  const version = versionOf(id, probe)
  if (version === null) return DISPLAY[id]
  const short = shortVersion(version)
  const compiler = COMPILER[id]
  return compiler ? `${DISPLAY[id]} · ${compiler} ${short}` : `${DISPLAY[id]} ${short}`
}

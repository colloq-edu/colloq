/**
 * README animations: seven scenes in .github/assets/readme, each in two
 * languages and in a light and a dark variant (README picks them through
 * <picture>; the competitions and contests scenes are shown on the landing
 * page only).
 *
 *   make readme-art
 *   node --import tsx scripts/readme-art.mts [directory...]
 *
 * The scenes are plain SVG with CSS @keyframes: no scripts, no SMIL, no
 * external fonts and no images, because GitHub shows SVG through <img>, and
 * only that works there. Every scene draws the real interface: the strings,
 * the participants' colors and the order of events are taken from the code
 * (shared/locales, shared/protocol.ts, CellView.svelte, PeoplePanel.svelte,
 * ConsoleView.svelte); where a scene departs from the brief, its header says
 * so. The scenes are independent of each other: each has its own helpers
 * inside its own function, so editing one does not touch the others. A run
 * writes all twenty-eight files into both directories and fails if a file has
 * grown to 40 KB or something has appeared in it that <img> will not show.
 *
 * Two languages. Each scene has its own TEXT dictionary at the top: en and ru,
 * with the locale key in a comment next to the string. The Russian labels are
 * what a person really sees in the product (shared/locales/*.ts, the "ru"
 * values); there are no made-up strings in the scenes, and departures are
 * marked with a comment. The code inside the cells is the same in both
 * languages: Python stays Python.
 *
 * Widths are measured, not guessed, and measured differently for the
 * languages: Cyrillic capitals are wider than Latin ones, so each scene has its
 * own capitals tracking (.12em versus .04em) and its own width tables measured
 * in the browser. Edited a scene? Regenerate and look at the frames in a
 * browser: compare by eye the light and the dark variant on white and on
 * #0d1117, and the frame before the end of the cycle with the first frame (the
 * loop must not "jump").
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Theme = 'light' | 'dark'
type Lang = 'en' | 'ru'
type Scene = (theme: Theme, lang: Lang) => string


// ====================================================================== room

/**
 * Hero scene «One link, the whole room» — room-{light,dark}.svg, 12 s loop.
 *
 * Anna types her name on the join form and joins; the header stack and the
 * teacher's People panel take her in, the count rolls 6 → 7 → 9 → 8 as Timur
 * and Rita arrive and Ivan leaves. Follows the real UI: nextPeers() puts the
 * viewer first and everyone else by name, the header stack is AvatarStack
 * max={4} plus a +N chip, live lines come from whereabouts() in
 * web/src/lib/room.ts. "Anna joined / Ivan left" is a narrator caption, not an
 * app notification — the product has no such toast.
 */
function roomArt(): Scene {
  /* ------------------------------------------------------------- strings --- */

  /**
   * Everything visible is here, per language. The locale key stands next to
   * the string: this is what a person really reads in the room, not a
   * paraphrase.
   *
   * `caret` and `glyph` are positions measured in the browser (the same font
   * stack, 600 15px): the name in the field is typed letter by letter, and the
   * covering strip with the caret steps along these marks. Cyrillic has its
   * own widths, so its marks are its own too. `joinLabelX`/`joinArrowX` are
   * the center of the button label and the left edge of the arrow: "ВОЙТИ НА
   * ЗАНЯТИЕ" is a third longer than "JOIN THE CLASS" and with the English
   * layout would run into the arrow.
   */
  const TEXT = {
    en: {
      title: 'One link, the whole room',
      desc:
        'Anna types her name on the class link and joins; her face lands in the room’s header, the count ticks up, and the teacher’s ' +
        'People panel adds her row and shows her editing cell 03, while Timur and Rita arrive, Dina moves on to cell 05 and Ivan leaves.',
      names: { AL: 'Alex', AN: 'Anna', DI: 'Dina', IV: 'Ivan', MA: 'Marat', OL: 'Oleg', RI: 'Rita', SO: 'Sonya' },
      joining: 'YOU’RE JOINING', // room.ui.840
      classLines: ['Week 4 · Convolutional', 'networks'],
      classLine: 'Week 4 · Convolutional networks',
      yourName: 'YOUR NAME', // room.ui.848
      placeholder: 'Alex', // room.ui.849
      yourMark: 'YOUR MARK', // room.ui.123
      join: 'JOIN THE CLASS', // room.ui.862
      inTheRoom: 'IN THE ROOM', // room.ui.896
      people: 'PEOPLE', // room.ui.658
      teacher: 'Teacher · you', // room.ui.674
      terminal: 'in the terminal', // room.ui.1113
      oracle: 'asking the oracle', // room.ui.1114
      editing: (n: string) => `editing cell ${n}`, // room.ui.1115
      running: (n: string) => `running cell ${n}`, // room.ui.1112
      ticker: { AN: 'ANNA JOINED', TI: 'TIMUR JOINED', RI: 'RITA JOINED', IV: 'IVAN LEFT' },
      caps: '.12em',
      glyph: [0, 10.5, 20, 29.5],
      caret: [0, 11.5, 21, 30.5, 39.5],
      joinLabelX: 140,
      joinArrowX: 229,
    },
    ru: {
      title: 'Одна ссылка — вся комната',
      desc:
        'Анна набирает имя на странице входа по ссылке занятия; её лицо встаёт в шапке комнаты, счётчик растёт, а в панели «Люди» у ' +
        'преподавателя появляется её строка — «правит ячейку 03». Следом входят Тимур и Рита, Дина переходит к ячейке 05, Иван выходит.',
      names: { AL: 'Алексей', AN: 'Анна', DI: 'Дина', IV: 'Иван', MA: 'Марат', OL: 'Олег', RI: 'Рита', SO: 'Соня' },
      joining: 'ВЫ ВХОДИТЕ В',
      classLines: ['Неделя 4 · Свёрточные', 'сети'],
      classLine: 'Неделя 4 · Свёрточные сети',
      yourName: 'ВАШЕ ИМЯ',
      placeholder: 'Александр',
      yourMark: 'ВАША МЕТКА',
      join: 'ВОЙТИ НА ЗАНЯТИЕ',
      inTheRoom: 'В КОМНАТЕ',
      people: 'ЛЮДИ',
      teacher: 'Преподаватель · вы',
      terminal: 'в терминале',
      oracle: 'спрашивает оракула',
      editing: (n: string) => `правит ячейку ${n}`,
      running: (n: string) => `запускает ячейку ${n}`,
      ticker: { AN: 'АННА ВОШЛА', TI: 'ТИМУР ВОШЁЛ', RI: 'РИТА ВОШЛА', IV: 'ИВАН ВЫШЕЛ' },
      caps: '.04em',
      glyph: [0, 10.5, 20, 29],
      caret: [0, 11.5, 21, 30, 38.5],
      joinLabelX: 141.5,
      joinArrowX: 231.5,
    },
  } as const

  /* ------------------------------------------------------------ shared bits */

  const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`
  const MONO = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`
  const EASE_OUT = 'cubic-bezier(.23,1,.32,1)'
  const EASE_IO = 'cubic-bezier(.77,0,.175,1)'

  type Theme = 'light' | 'dark'
  const TOKENS = {
    light: {
      canvas: '#ffffff', surface: '#f3f6fb', line: '#dce3ef', ink: '#101a33', muted: '#5d6b8a',
      faint: '#7c8699', accent: '#0fa0d7', accentText: '#0a6e96', primary: '#0f2d69', primaryInk: '#ffffff',
    },
    dark: {
      canvas: '#060c1c', surface: '#0a1330', line: '#16244b', ink: '#e6e7e8', muted: '#9ba6be',
      faint: '#5e6b85', accent: '#0fa0d7', accentText: '#0fa0d7', primary: '#0fa0d7', primaryInk: '#06203a',
    },
  } as const

  const PARTICIPANT_COLORS = ['#f97362', '#f2a33c', '#8ac44a', '#3ec9a7', '#4aa8f0', '#7e82f0', '#c273e6', '#ef6ba8']

  /* web/src/lib/utils.ts, ported: the ink on a participant disc is measured, not assumed. */
  const DISC_DARK = '#0F2246'
  const DISC_LIGHT = '#FFFFFF'
  function channel(v: number): number {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  function luminance(hex: string): number {
    const n = parseInt(hex.replace('#', ''), 16)
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  }
  function contrastRatio(a: string, b: string): number {
    const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05]
    return x > y ? x / y : y / x
  }
  function inkOn(bg: string): string {
    return contrastRatio(DISC_DARK, bg) >= contrastRatio(DISC_LIGHT, bg) ? DISC_DARK : DISC_LIGHT
  }
  for (const c of PARTICIPANT_COLORS) {
    if (inkOn(c) !== DISC_DARK) throw new Error(`inkOn(${c}) is not ${DISC_DARK}`)
    if (contrastRatio(DISC_DARK, c) < 4.5) throw new Error(`initials on ${c} fall under AA`)
  }

  /** Keyframes as a loop timeline: a start state, then changes at ms with a duration. */
  function timeline(L: number) {
    const pct = (ms: number) => `${+((ms / L) * 100).toFixed(3)}%`
    return (v0: string, changes: [at: number, dur: number, to: string, ease?: 'io'][]): string => {
      let cur = v0
      let out = `0%{${cur}}`
      for (const [t, d, v, e] of changes) {
        out += `${pct(t)}{${cur}${e === 'io' ? `;animation-timing-function:${EASE_IO}` : ''}}${pct(t + d)}{${v}}`
        cur = v
      }
      return out + `100%{${cur}}`
    }
  }

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/)
    return parts.length === 1 ? parts[0].slice(0, 2).toUpperCase() : (parts[0][0] + parts.at(-1)![0]).toUpperCase()
  }

  /* ------------------------------------------------------------- the scene */

  /**
   * Hero: a student joins by the class link; the teacher's room shows her arrive.
   *
   * Truth sources: JoinScreen.svelte (strings, disabled-until-named button),
   * SessionScreen.svelte header (AvatarStack max=4, "{n} in the room"),
   * PeoplePanel.svelte + whereabouts() (rows and live lines), peers.ts nextPeers()
   * (self first, then everyone by name — which is why Anna lands second, Timur and
   * Rita only move the chip, and Ivan's exit pulls Marat back into the stack).
   */
  function roomScene(theme: Theme, lang: Lang): string {
    const L = 12000
    const T = TOKENS[theme]
    const S = TEXT[lang]
    const k = timeline(L)
    const NAVY = '#0f2d69'
    const H = 320

    const P = {
      AL: { name: S.names.AL, color: '#7e82f0' },
      AN: { name: S.names.AN, color: '#f97362' },
      DI: { name: S.names.DI, color: '#3ec9a7' },
      IV: { name: S.names.IV, color: '#ef6ba8' },
      MA: { name: S.names.MA, color: '#f2a33c' },
      OL: { name: S.names.OL, color: '#c273e6' },
      RI: { name: S.names.RI, color: '#4aa8f0' },
      SO: { name: S.names.SO, color: '#8ac44a' },
    } as const
    type Who = keyof typeof P
    for (const p of Object.values(P)) if (!PARTICIPANT_COLORS.includes(p.color)) throw new Error(p.color)

    /* Header stack: 4 faces + chip, 28px circles stepping 20px (−8px overlap). */
    const SX = 642
    const SY = 38
    const seat = (i: number) => SX + 20 * i

    /* People rows: 30px, single line; origin at the row's top-left. */
    const RX = 320
    const RY = 118
    const RH = 30
    const rowY = (i: number) => RY + RH * i
    const LINE_X = 128 // live-line column, relative to the row

    const css: string[] = []
    const anim = (cls: string, frames: string, origin?: string) => {
      css.push(
        `.${cls}{animation:${cls} ${L / 1000}s infinite both${origin ? `;transform-box:fill-box;transform-origin:${origin}` : ''}}@keyframes ${cls}{${frames}}`,
      )
    }

    /* -------------------------------------------------------------- beats */
    const FOCUS = 400
    const KEYS = [600, 710, 820, 930] // 110ms a character
    const PRESS = 1500
    const JOIN = 1800 // the stack starts making room
    const LAND = 2000 // Anna's face lands; count, chip and ticker say so
    const ROWS = 2100
    const ANNA_LINE = 3200
    const TIMUR = 4600
    const RITA = 5300
    const DINA = 6600
    const IVAN = 7600
    const RESET = 11600

    const show = 'opacity:1'
    const hide = 'opacity:0'
    const avIn = 'opacity:0;transform:translateX(-10px) scale(.94)'
    const avOut = 'opacity:0;transform:scale(.72)'
    const still = 'opacity:1;transform:none'

    // Join card
    anim('fr', k(hide, [[FOCUS, 120, show], [PRESS, 120, hide]]))
    const caret = S.caret // caret x after 0..4 characters, measured per language
    const cx = (n: number) => `transform:translateX(${caret[n] - caret[4]}px)`
    anim('ca', k(`${hide};${cx(0)}`, [
      [FOCUS, 1, `${show};${cx(0)}`],
      ...KEYS.map((t, i) => [t, 1, `${show};${cx(i + 1)}`] as [number, number, string]),
      [PRESS, 120, `${hide};${cx(4)}`],
    ]))
    anim('cv', k(cx(0), KEYS.map((t, i) => [t, 1, cx(i + 1)] as [number, number, string])))
    anim('ph', k(show, [[KEYS[0], 1, hide]]))
    anim('mi', k(hide, [[KEYS[1], 160, show]]))
    anim('bt', k('opacity:.4;transform:none', [
      [KEYS[0], 160, 'opacity:1;transform:none'],
      [PRESS, 140, 'opacity:1;transform:scale(.97)'],
      [PRESS + 140, 140, 'opacity:1;transform:none'],
    ]), 'center')
    anim('bl', k(show, [[PRESS, 200, hide]]))
    anim('ck', k('opacity:0;stroke-dashoffset:21', [[PRESS + 60, 200, 'opacity:1;stroke-dashoffset:0']]))

    // Header stack
    const shiftX = 'opacity:1;transform:translateX(-20px)'
    anim('fAN', k(avIn, [[LAND, 280, still]]), 'center')
    anim('fDI', k(shiftX, [[JOIN, 420, still, 'io']]), 'center')
    anim('fIV', k(shiftX, [[JOIN, 420, still, 'io'], [IVAN, 260, avOut]]), 'center')
    anim('fMA', k(still, [[JOIN, 260, avOut]]), 'center')
    anim('fMB', k(avIn, [[IVAN + 300, 280, still]]), 'center')
    anim('cp', k('transform:none', [
      [TIMUR, 1, 'transform:scale(.94)'], [TIMUR + 1, 280, 'transform:none'],
      [RITA, 1, 'transform:scale(.94)'], [RITA + 1, 280, 'transform:none'],
    ]), 'center')
    anim('n2', k(show, [[LAND, 200, hide]]))
    anim('n3', k(hide, [[LAND, 200, show], [TIMUR, 200, hide]]))
    anim('n4', k(hide, [[TIMUR, 200, show], [RITA, 200, hide], [IVAN, 200, show]]))
    anim('n5', k(hide, [[RITA, 200, show], [IVAN, 200, hide]]))

    // Counts: an odometer roll, up for arrivals and down for the departure.
    const up = 'opacity:0;transform:translateY(-4px)'
    const dn = 'opacity:0;transform:translateY(4px)'
    anim('d6', k(still, [[LAND, 200, up]]))
    anim('d7', k(dn, [[LAND, 200, still], [TIMUR, 200, up]]))
    anim('d8', k(dn, [[TIMUR, 200, still], [RITA, 200, up], [IVAN, 200, still]]))
    anim('d9', k(dn, [[RITA, 200, still], [IVAN, 200, dn]]))

    // Ticker: a caption, 2.6 s a line, the next line replaces the last.
    const tIn = 'opacity:0;transform:translateY(4px)'
    const tOut = 'opacity:0;transform:translateY(-4px)'
    anim('t1', k(tIn, [[LAND, 200, still], [LAND + 2600, 200, tOut]]))
    anim('t2', k(tIn, [[TIMUR, 200, still], [RITA, 140, tOut]]))
    anim('t3', k(tIn, [[RITA + 60, 200, still], [IVAN, 140, tOut]]))
    anim('t4', k(tIn, [[IVAN + 60, 200, still], [IVAN + 2600, 200, tOut]]))

    // People rows (offsets are relative to the resolved frame)
    const y = (px: number) => (px ? `transform:translateY(${px}px)` : 'transform:none')
    anim('rAN', k('opacity:0;transform:translateY(4px)', [[ROWS + 300, 260, still]]))
    anim('rDN', k(y(-RH), [[ROWS, 420, y(0), 'io']]))
    anim('rIV', k(`opacity:1;${y(-RH)}`, [[ROWS, 420, `opacity:1;${y(0)}`, 'io'], [IVAN, 260, avOut]]), '0 50%')
    anim('rBU', k(y(0), [[ROWS, 420, y(RH), 'io'], [IVAN + 160, 420, y(0), 'io']]))
    anim('rUP', k(y(RH), [[IVAN + 160, 420, y(0), 'io']]))
    anim('lAN', k(hide, [[ANNA_LINE, 200, show]]))
    anim('lD1', k(show, [[DINA, 200, hide]]))
    anim('lD2', k(hide, [[DINA, 200, show]]))

    // The seam: the start frame fades in over the resolved one, then the loop restarts under it.
    anim('rs', k(hide, [[RESET, 400, show]]))

    /* -------------------------------------------------------------- parts */
    const disc = (who: Who, r: number, ring = false) =>
      `<circle r="${ring ? r - 1 : r}" fill="${P[who].color}"${ring ? ` stroke="${NAVY}" stroke-width="2"` : ''}/>` +
      `<text class="av" y="4" fill="${inkOn(P[who].color)}">${initials(P[who].name)}</text>`

    /* The participants' live lines: whereabouts() in web/src/lib/room.ts. */
    const live = (s: string, cls = 'ui mu') => `<text class="${cls}" x="${LINE_X}" y="19.5">${esc(s)}</text>`
    const line = (who: Who): string =>
      ({
        AL: live(S.teacher, 'nm ac'),
        IV: live(S.terminal),
        MA: live(S.editing('03')),
        OL: live(S.oracle),
        SO: live(S.editing('01')),
      } as Partial<Record<Who, string>>)[who] ?? ''

    const rowDef = (who: Who) =>
      `<g id="p${who}"><g transform="translate(12 15)">${disc(who, 12)}</g>` +
      `<text class="nm i" x="34" y="19.5">${P[who].name}</text>${line(who)}` +
      `<rect x="512" y="11" width="8" height="8" fill="${P[who].color}"/></g>`

    const faceDef = (who: Who) => `<g id="h${who}">${disc(who, 14, true)}</g>`

    const at = (x: number, yy: number, body: string) => `<g transform="translate(${x} ${yy})">${body}</g>`
    const use = (id: string) => `<use href="#${id}"/>`

    const chipCircle = `<circle r="13" fill="#374b9b" stroke="${NAVY}" stroke-width="2"/>`
    const chipLabel = (n: number, cls = '', hidden = false) =>
      `<text class="cl${cls ? ' ' + cls : ''}" y="4"${hidden ? ' opacity="0"' : ''}>+${n}</text>`

    const joinButtonFace =
      `<rect x="44" y="240" width="216" height="44" rx="6" class="pr"/>`
    const joinButtonLabel =
      `<text class="bn pi" x="${S.joinLabelX}" y="266.5">${esc(S.join)}</text>` +
      `<path d="M${S.joinArrowX} 262h11m-4.5-4.5 4.5 4.5-4.5 4.5" class="ps" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`

    const countSuffix = `<text class="lb w2" x="764" y="42">${esc(S.inTheRoom)}</text>`
    const digit = (n: number, x: number, yy: number, cls: string, extra = '') =>
      `<text class="${cls}" x="${x}" y="${yy}"${extra}>${n}</text>`

    const logo = (() => {
      const cells: string[] = []
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++)
          cells.push(
            `<rect x="${304 + 6 * c}" y="${30 + 6 * r}" width="5" height="5" rx="1.3" fill="${(r + c) % 2 ? '#374b9b' : '#fff'}"/>`,
          )
      return cells.join('')
    })()

    /* ------------------------------------------------------------- styles */
    const style =
      `.s{font-family:${SANS}}` +
      // Capitals tracking goes by language: Cyrillic capitals are wider, and at
      // .12em "В КОМНАТЕ" and "ВАША МЕТКА" would stick out of their columns.
      `.lb{font:600 11px ${MONO};letter-spacing:${S.caps}}` +
      `.tk{font:600 11px ${MONO};letter-spacing:.08em}` +
      `.nm{font:600 13px ${SANS}}.ui{font:13px ${SANS}}.tt{font:700 15px ${SANS}}` +
      `.av{font:600 11px ${SANS};text-anchor:middle}` +
      `.cl{font:700 11px ${MONO};text-anchor:middle;fill:#fff}` +
      `.bn{font:700 13px ${SANS};letter-spacing:.1em;text-anchor:middle}` +
      `.fd{font:600 15px ${SANS}}.fp{font:15px ${SANS}}` +
      `.tn{font-variant-numeric:tabular-nums}` +
      `.c{fill:${T.canvas}}.sf{fill:${T.surface}}.ln{stroke:${T.line}}` +
      `.i{fill:${T.ink}}.mu{fill:${T.muted}}.fa{fill:${T.faint}}.ac{fill:${T.accentText}}` +
      `.pr{fill:${T.primary}}.pi{fill:${T.primaryInk}}.ps{stroke:${T.primaryInk}}` +
      `.w{fill:#fff}.w2{fill:#d8e1f2}.soft{fill:#4fc3ee}.gone{fill:rgba(255,255,255,.5)}` +
      css.join('') +
      `[class]{animation-timing-function:${EASE_OUT}}` +
      `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`

    /* --------------------------------------------------------------- body */
    const defs =
      `<defs>` +
      (Object.keys(P) as Who[]).map(rowDef).join('') +
      (['AL', 'AN', 'DI', 'IV', 'MA'] as Who[]).map(faceDef).join('') +
      `<clipPath id="rows"><rect x="305" y="116" width="550" height="183"/></clipPath>` +
      `</defs>`

    const card = `<rect x=".5" y=".5" width="879" height="${H - 1}" rx="12" fill="${NAVY}"/>`

    // Left: the join card (JoinScreen, abstracted)
    const NAME_X = 56 // the left edge of the name in the field
    const last = caret[4]
    const join =
      `<rect x="24.5" y="24.5" width="255" height="279" rx="8" class="c ln"/>` +
      `<text class="lb mu" x="44" y="52">${esc(S.joining)}</text>` +
      `<text class="tt i" x="44" y="77">${esc(S.classLines[0])}</text>` +
      `<text class="tt i" x="44" y="97">${esc(S.classLines[1])}</text>` +
      `<text class="lb mu" x="44" y="128">${esc(S.yourName)}</text>` +
      `<rect x="44.5" y="136.5" width="215" height="35" rx="6" class="c ln"/>` +
      `<g class="fr" opacity="0" fill="none" stroke="${T.accent}">` +
      `<rect x="44.5" y="136.5" width="215" height="35" rx="6"/>` +
      `<rect x="42" y="134" width="220" height="40" rx="8" stroke-width="3" stroke-opacity=".22"/></g>` +
      `<text class="fd i" x="${S.glyph.map((g) => NAME_X + g).join(' ')}" y="160">${esc(P.AN.name)}</text>` +
      `<rect class="cv c" x="${NAME_X + last - 1}" y="141" width="${last + 1.5}" height="26"/>` +
      `<text class="ph fp fa" x="56" y="160" opacity="0">${esc(S.placeholder)}</text>` +
      `<rect class="ca" x="${NAME_X + last - 0.5}" y="145.5" width="2" height="18" fill="${T.accent}" opacity="0"/>` +
      `<rect x="44.5" y="184.5" width="215" height="39" rx="3" class="sf ln"/>` +
      `<circle cx="66" cy="204" r="12" fill="${P.AN.color}"/>` +
      `<text class="mi av" x="66" y="208" fill="${DISC_DARK}">${initials(P.AN.name)}</text>` +
      `<text class="lb mu" x="88" y="208">${esc(S.yourMark)}</text>` +
      `<g class="bt">${joinButtonFace}<g class="bl" opacity="0">${joinButtonLabel}</g>` +
      `<path class="ck ps" d="M145 262l5 5 9-10" fill="none" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="21"/></g>`

    // Right: the room — header on the brand band, ticker, People panel
    const header =
      logo +
      `<text class="tt w" x="330" y="43.5">${esc(S.classLine)}</text>` +
      // chip first, then faces right-to-left: the first person sits on top
      at(seat(4), SY, `<g class="cp">${chipCircle}${chipLabel(2, 'n2', true)}${chipLabel(3, 'n3', true)}${chipLabel(4, 'n4')}${chipLabel(5, 'n5', true)}</g>`) +
      at(seat(3), SY, `<g class="fMA" opacity="0">${use('hMA')}</g>`) +
      at(seat(3), SY, `<g class="fMB">${use('hMA')}</g>`) +
      at(seat(3), SY, `<g class="fIV" opacity="0">${use('hIV')}</g>`) +
      at(seat(2), SY, `<g class="fDI">${use('hDI')}</g>`) +
      at(seat(1), SY, `<g class="fAN">${use('hAN')}</g>`) +
      at(seat(0), SY, use('hAL')) +
      digit(6, 748, 42, 'lb w2 tn d6', ' opacity="0"') +
      digit(7, 748, 42, 'lb w2 tn d7', ' opacity="0"') +
      digit(8, 748, 42, 'lb w2 tn d8') +
      digit(9, 748, 42, 'lb w2 tn d9', ' opacity="0"') +
      countSuffix

    const ticker =
      `<text class="tk soft t1" x="304" y="74" opacity="0">${esc(S.ticker.AN)}</text>` +
      `<text class="tk soft t2" x="304" y="74" opacity="0">${esc(S.ticker.TI)}</text>` +
      `<text class="tk soft t3" x="304" y="74" opacity="0">${esc(S.ticker.RI)}</text>` +
      `<text class="tk gone t4" x="304" y="74" opacity="0">${esc(S.ticker.IV)}</text>`

    const pdigit = (n: number, cls: string, hidden = true) =>
      `<text class="lb mu tn ${cls}" x="840" y="111" text-anchor="end"${hidden ? ' opacity="0"' : ''}>${n}</text>`

    /* The rule after the panel label: its start is computed from the width of the label itself. */
    const capsW = (s: string) => [...s].length * 6.6 + ([...s].length - 1) * parseFloat(S.caps) * 11
    const ruleX = Math.round((320 + capsW(S.people) + 10) * 2) / 2
    const people =
      `<rect x="304.5" y="88.5" width="551" height="215" rx="8" class="c ln"/>` +
      `<text class="lb mu" x="320" y="111">${esc(S.people)}</text>` +
      `<path d="M${ruleX} 107.5h${824 - ruleX}" class="ln"/>` +
      pdigit(6, 'd6') + pdigit(7, 'd7') + pdigit(8, 'd8', false) + pdigit(9, 'd9') +
      `<g clip-path="url(#rows)">` +
      at(RX, rowY(0), use('pAL')) +
      at(RX, rowY(1), `<g class="rAN">${use('pAN')}<text class="ui mu lAN" x="${LINE_X}" y="19.5">${esc(S.editing('03'))}</text></g>`) +
      at(RX, rowY(2), `<g class="rDN">${use('pDI')}<text class="ui mu lD1" x="${LINE_X}" y="19.5" opacity="0">${esc(S.running('04'))}</text><text class="ui mu lD2" x="${LINE_X}" y="19.5">${esc(S.editing('05'))}</text></g>`) +
      at(RX, rowY(3), `<g class="rIV" opacity="0">${use('pIV')}</g>`) +
      at(RX, rowY(3), `<g class="rBU">${use('pMA')}</g>`) +
      at(RX, rowY(4), `<g class="rBU">${use('pOL')}</g>`) +
      at(RX, rowY(5), `<g class="rUP">${use('pRI')}</g>`) +
      at(RX, rowY(6), `<g class="rDN">${use('pSO')}</g>`) +
      `</g>`

    // The start frame, drawn over only what the story changes.
    const reset =
      `<g class="rs" opacity="0">` +
      // join card: empty field with placeholder, bare mark, disabled button
      `<rect x="45" y="137" width="214" height="34" rx="5.5" class="c"/>` +
      `<text class="fp fa" x="56" y="160">${esc(S.placeholder)}</text>` +
      `<rect x="53" y="191" width="26" height="26" class="sf"/><circle cx="66" cy="204" r="12" fill="${P.AN.color}"/>` +
      `<rect x="42" y="238" width="220" height="48" class="c"/>` +
      `<g opacity=".4">${joinButtonFace}${joinButtonLabel}</g>` +
      // header: Alex, Dina, Ivan, Marat, +2 · 6 in the room
      `<rect x="626" y="22" width="232" height="34" fill="${NAVY}"/>` +
      at(seat(4), SY, chipCircle + chipLabel(2)) +
      at(seat(3), SY, use('hMA')) +
      at(seat(2), SY, use('hIV')) +
      at(seat(1), SY, use('hDI')) +
      at(seat(0), SY, use('hAL')) +
      digit(6, 748, 42, 'lb w2 tn') +
      countSuffix +
      // people: 6 and the six rows
      `<rect x="826" y="98" width="20" height="17" class="c"/>` +
      `<text class="lb mu tn" x="840" y="111" text-anchor="end">6</text>` +
      `<rect x="307" y="116" width="546" height="183" class="c"/>` +
      at(RX, rowY(0), use('pAL')) +
      at(RX, rowY(1), use('pDI') + `<text class="ui mu" x="${LINE_X}" y="19.5">${esc(S.running('04'))}</text>`) +
      at(RX, rowY(2), use('pIV')) +
      at(RX, rowY(3), use('pMA')) +
      at(RX, rowY(4), use('pOL')) +
      at(RX, rowY(5), use('pSO')) +
      `</g>`

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="880" height="${H}" viewBox="0 0 880 ${H}" lang="${lang}" role="img" aria-labelledby="t d">` +
      `<title id="t">${esc(S.title)}</title><desc id="d">${esc(S.desc)}</desc>` +
      `<style>${style}</style>` +
      defs +
      card +
      join +
      header +
      ticker +
      people +
      reset +
      `</svg>\n`
    )
  }
  return roomScene
}

// ====================================================================== run

/*
 * Scene "run": write together, run once, everyone sees it — run-{light,dark}.svg,
 * 11 s loop, one geometry with swapped tokens.
 *
 * Maria runs cell 03 (df = pd.read_csv), Ivan's cell 04 waits in the queue and
 * then uses her df in the room's one kernel. Gutter marks, the queued footer,
 * the status row and the elapsed() timer format follow CellView.svelte.
 */
function runArt(): Scene {
  /* ------------------------------------------------------------ strings --- */

  /**
   * The visible strings per language; the locale key is next to them. The code
   * in the cells is one and the same: Python stays Python, only the labels
   * around it change.
   *
   * `bold` holds letter widths per 1000 for the caret label: the Latin ones are
   * taken from Arial Bold, the Cyrillic ones measured in the browser with the
   * same font stack at 700/12. The name in the tag is fitted to the box through
   * textLength, and the box has to be measured, not guessed. `caps` is the
   * capitals tracking: for Cyrillic it is smaller, otherwise "ВЫПОЛНЯЕТСЯ" and
   * "В ОЧЕРЕДИ" do not fit into the same places as RUNNING.
   *
   * The names in the Russian scene are male on purpose: the run line in the app
   * is "запустил" (ran it, masculine) plus a name (room.ui.394), and with a
   * female name it would read wrong. "от Ивана" is the only place where a name
   * is declined: the preposition itself is taken from room.ui.399, the
   * declension is added, otherwise the line is not Russian.
   */
  const TEXT = {
    en: {
      title: 'Write together, run once, everyone sees it',
      desc:
        'Maria runs cell 03 while Ivan finishes typing cell 04 and Alex selects a word in it. ' +
        'Ivan’s run waits its turn in the room’s single kernel, then uses the df that Maria’s cell loaded, ' +
        'and every participant sees the same outputs.',
      maria: 'Maria',
      ivan: 'Ivan',
      alex: 'Alex',
      running: 'RUNNING', // room.ui.393
      startedBy: (who: string) => `started by ${who}`, // room.ui.394
      interrupt: 'INTERRUPT', // room.ui.395
      place: (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'} in queue`, // place() + room.ui.397
      queued: 'QUEUED', // room.ui.398
      by: 'by Ivan', // room.ui.399 + a name
      cancel: 'CANCEL', // room.ui.376
      caption: 'One kernel per room — df from cell 03 is there for everyone in cell 04.',
      people: 'PEOPLE', // room.ui.658
      teacher: 'Teacher', // room.ui.675
      editing: (n: string) => `editing cell ${n}`, // room.ui.1115
      runningCell: (n: string) => `running cell ${n}`, // room.ui.1112
      caps: 0.12,
      bold: { M: 833, a: 556, r: 389, i: 278, I: 278, v: 556, n: 611, A: 722, l: 278, e: 556, x: 556 } as Record<string, number>,
    },
    ru: {
      title: 'Пишут вместе, запуск один, вывод видят все',
      desc:
        'Марат запускает ячейку 03, пока Иван дописывает ячейку 04, а Алексей выделяет в ней слово. ' +
        'Запуск Ивана ждёт своей очереди в единственном ядре комнаты, потом берёт тот самый df, который загрузила ячейка Марата, ' +
        'и одинаковый вывод видит вся комната.',
      maria: 'Марат',
      ivan: 'Иван',
      alex: 'Алексей',
      running: 'ВЫПОЛНЯЕТСЯ',
      startedBy: (who: string) => `запустил ${who}`,
      interrupt: 'ПРЕРВАТЬ',
      place: (n: number) => `${n}-й в очереди`, // room.ui.1236 writes the place as "{n}-й"
      queued: 'В ОЧЕРЕДИ',
      by: 'от Ивана',
      cancel: 'ОТМЕНА',
      caption: 'Ядро одно на всю комнату — df из ячейки 03 есть у всех в ячейке 04.',
      people: 'ЛЮДИ',
      teacher: 'Преподаватель',
      editing: (n: string) => `правит ячейку ${n}`,
      runningCell: (n: string) => `запускает ячейку ${n}`,
      caps: 0.04,
      bold: {
        А: 740, И: 795, М: 916,
        а: 600, в: 600, е: 611, й: 648, к: 580, л: 621, н: 642, р: 657, с: 594, т: 533,
      } as Record<string, number>,
    },
  } as const

  /* ------------------------------------------------------------ tokens --- */

  type Tokens = {
    canvas: string; surface: string; raised: string; line: string
    ink: string; muted: string; faint: string
    accent: string; accentText: string
    syn: { text: string; keyword: string; fn: string; string: string; number: string; punct: string }
  }

  const LIGHT: Tokens = {
    canvas: '#ffffff', surface: '#f3f6fb', raised: '#e7eef9', line: '#dce3ef',
    ink: '#101a33', muted: '#5d6b8a', faint: '#7c8699',
    accent: '#0fa0d7', accentText: '#0a6e96',
    syn: { text: '#101a33', keyword: '#7d50b9', fn: '#966600', string: '#00784e', number: '#b35415', punct: '#5d6b8a' },
  }
  const DARK: Tokens = {
    canvas: '#060c1c', surface: '#0a1330', raised: '#0e1b3d', line: '#16244b',
    ink: '#e6e7e8', muted: '#9ba6be', faint: '#5e6b85',
    accent: '#0fa0d7', accentText: '#0fa0d7',
    syn: { text: '#d6dce8', keyword: '#b98fe8', fn: '#ffd746', string: '#8fd9a8', number: '#eb8c3c', punct: '#9ba6be' },
  }

  /* Participant colours (shared/protocol.ts) — same in both themes. */
  const MARIA = '#f97362' // coral
  const IVAN = '#4aa8f0' // sky
  const ALEX = '#c273e6' // violet
  const CARET_INK = '#06203a' // --accent-ink, the y-codemirror label ink

  /* Ported from web/src/lib/utils.ts: the ink on a participant disc is measured. */
  const DISC_DARK = '#0F2246'
  const DISC_LIGHT = '#FFFFFF'
  function channel(v: number): number {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  function luminance(hex: string): number {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return 0
    const n = parseInt(m[1], 16)
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  }
  function contrastRatio(a: string, b: string): number {
    const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05]
    return x > y ? x / y : y / x
  }
  function inkOn(background: string): string {
    return contrastRatio(DISC_DARK, background) >= contrastRatio(DISC_LIGHT, background) ? DISC_DARK : DISC_LIGHT
  }
  for (const c of [MARIA, IVAN, ALEX]) {
    if (inkOn(c) !== DISC_DARK) throw new Error(`initials on ${c} would be white`)
    if (contrastRatio(DISC_DARK, c) < 4.5) throw new Error(`initials on ${c} under AA`)
    if (contrastRatio(CARET_INK, c) < 4.5) throw new Error(`caret label on ${c} under AA`)
  }

  /* ------------------------------------------------------------- motion --- */

  const LOOP = 11_000
  const R0 = 10_500 // story layer starts fading back to the start frame
  const R1 = 10_900
  const OUT = 'cubic-bezier(.23,1,.32,1)'

  const pct = (ms: number): string => {
    if (ms <= 0) return '0%'
    if (ms >= LOOP) return '100%'
    return `${+((ms / LOOP) * 100).toFixed(3)}%`
  }

  /** A change: at `t` start going to `v` over `d` ms with easing `e`. d=1 is a cut. */
  type Change = [t: number, v: string, d?: number, e?: string]

  let css = ''
  let seq = 0
  let seen = new Map<string, string>()
  /**
   * One animated property track. Returns the class to put on the element.
   * Every segment eases out unless it says otherwise (the shorthand carries OUT,
   * so only the exceptions are written into the keyframes); a 1ms segment is a
   * cut whatever its curve. Identical tracks share one @keyframes.
   */
  function track(v0: string, changes: Change[], end?: string): string {
    const frames: string[] = [`0%{${v0}}`]
    let prev = v0
    let last = 0
    for (const [t, v, d = 200, e = OUT] of changes) {
      if (t < last) throw new Error(`change at ${t} overlaps previous segment ending ${last}`)
      frames.push(`${pct(t)}{${prev}${d > 1 && e !== OUT ? `;animation-timing-function:${e}` : ''}}`)
      frames.push(`${pct(t + d)}{${v}}`)
      prev = v
      last = t + d
    }
    frames.push(`100%{${end ?? prev}}`)
    const body = frames.join('')
    const known = seen.get(body)
    if (known) return `z ${known}`
    const name = `a${(seq++).toString(36)}`
    seen.set(body, name)
    css += `@keyframes ${name}{${body}}.${name}{animation-name:${name}}`
    return `z ${name}`
  }

  const O = (v: number) => `opacity:${v}`
  const OY = (v: number, y: number) => `opacity:${v};transform:translateY(${y}px)`
  const TX = (x: number) => `transform:translate(${+x.toFixed(2)}px)`

  /** Visible between tIn and tOut (enter dIn, exit dOut). */
  const shown = (tIn: number, tOut: number | null, dIn = 200, dOut = 160, peak = 1): string => {
    const ch: Change[] = [[tIn, O(peak), dIn]]
    if (tOut !== null) ch.push([tOut, O(0), dOut])
    else ch.push([R0, O(0), R1 - R0])
    return track(O(0), ch)
  }
  /** Visible at the start, gone between tOut and tIn, back by the loop seam. */
  const hidden = (tOut: number, tIn: number | null, dOut = 120, dIn = 160): string => {
    const ch: Change[] = [[tOut, O(0), dOut]]
    if (tIn !== null) ch.push([tIn, O(1), dIn])
    else ch.push([R0, O(1), R1 - R0])
    return track(O(1), ch)
  }
  /** Row or output enter: opacity + translateY 4px over 260ms, leaves at tOut. */
  const rise = (tIn: number, tOut: number | null, dOut = 160): string => {
    const ch: Change[] = [[tIn, OY(1, 0), 260]]
    ch.push(tOut !== null ? [tOut, OY(0, 0), dOut] : [R0, OY(0, 0), R1 - R0])
    return track(OY(0, 4), ch, OY(0, 4))
  }

  /* --------------------------------------------------------------- type --- */

  const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`
  const MONO = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`
  const CW = 7.8 // 0.6 × 13px
  // Capitals tracking is set by the language: for Cyrillic it is smaller (see TEXT).
  let CAPS_TRACK = 1.32 // mono 11px, .12em
  const CAPS_W = (n: number) => +(n * 6.6 + (n - 1) * CAPS_TRACK).toFixed(2)
  const MONO11_W = (n: number) => +(n * 6.6).toFixed(2)

  /* Advance widths (per 1000) for the caret labels, so the label box
   * is measured instead of guessed; textLength then pins the string to it. */
  let BOLD: Record<string, number> = TEXT.en.bold
  const boldW = (s: string, px: number) => ([...s].reduce((w, ch) => w + (BOLD[ch] ?? 611), 0) * px) / 1000

  const r5 = (n: number) => Math.round(n * 2) / 2
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  /* --------------------------------------------------------------- scene --- */

  type Tok = [cls: string, text: string]

  function runScene(T: Tokens, lang: Lang): string {
    css = ''
    seq = 0
    seen = new Map()
    const S = TEXT[lang]
    CAPS_TRACK = +(S.caps * 11).toFixed(2)
    BOLD = S.bold
    const W = 880
    const H = 300
    const CX = 96 // code text x
    const colX = (c: number) => CX + c * CW

    const code = (x: number, y: number, toks: Tok[], cls = ''): string => {
      const n = toks.reduce((s, [, t]) => s + t.length, 0)
      return `<text class="m c${cls ? ' ' + cls : ''}" xml:space="preserve" x="${x}" y="${y}" textLength="${+(n * CW).toFixed(1)}" lengthAdjust="spacing">${toks
        .map(([c, t]) => `<tspan class="${c}">${esc(t)}</tspan>`)
        .join('')}</text>`
    }
    const caps = (x: number, y: number, s: string, cls: string, anchor = ''): string =>
      `<text class="m cap ${cls}" x="${x}" y="${y}"${anchor ? ` text-anchor="${anchor}"` : ''} textLength="${CAPS_W(s.length)}" lengthAdjust="spacing">${esc(s)}</text>`
    const mono11 = (x: number, y: number, s: string, cls: string, anchor = '', extra = ''): string =>
      `<text class="m m11 ${cls}"${extra} x="${x}" y="${y}"${anchor ? ` text-anchor="${anchor}"` : ''} textLength="${MONO11_W(s.length)}" lengthAdjust="spacing">${esc(s)}</text>`

    /* Remote caret, drawn like y-codemirror: 2px bar, 18px tall, label on top. */
    const caret = (col: number, lineTop: number, name: string, color: string, labelCls: string): string => {
      const x = Math.round(colX(col) - 1)
      const y = lineTop + 2
      const tw = +(boldW(name, 12) * 1.04).toFixed(1)
      return (
        `<rect x="${x}" y="${y}" width="2" height="18" fill="${color}"/>` +
        `<g class="${labelCls}"><rect x="${x}" y="${y - 18}" width="${r5(tw + 10)}" height="18" rx="2" fill="${color}"/>` +
        `<text class="s lab" x="${x + 5}" y="${y - 5}" textLength="${tw}" lengthAdjust="spacing">${name}</text></g>`
      )
    }

    const spinner = (cx: number, cy: number, cls: string): string =>
      // 270° from 12 o'clock clockwise to 9 o'clock; rotates about its own centre.
      `<path class="${cls}" d="M${cx} ${cy - 5}A5 5 0 1 1 ${cx - 5} ${cy}" fill="none" stroke="${T.accentText}" stroke-opacity=".7" stroke-width="1.5" stroke-linecap="round" style="transform-box:view-box;transform-origin:${cx}px ${cy}px"/>`

    const avatarXs = (cx: number, cy: number, color: string, initial: string): string =>
      `<circle cx="${cx}" cy="${cy}" r="9" fill="${color}"/><text class="s ini" x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11">${initial}</text>`

    const button = (right: number, cy: number, label: string): string => {
      const w = r5(CAPS_W(label.length) + 16)
      const x = right - w
      return `<rect x="${x + 0.5}" y="${cy - 9.5}" width="${w - 1}" height="19" rx="6" fill="none" stroke="${T.line}"/>${caps(x + 8, cy + 4, label, 'ink')}`
    }

    /* Running status row: avatar, spinner, RUNNING, started by X, timer, INTERRUPT. */
    const runningRow = (cy: number, who: string, color: string, spinCls: string, timers: [string, string][]): string => {
      const capX = 138
      return (
        avatarXs(105, cy, color, [...who][0]) +
        spinner(126, cy, spinCls) +
        caps(capX, cy + 4, S.running, 'acc') +
        `<text class="s ui mu" x="${r5(capX + CAPS_W(S.running.length) + 8)}" y="${cy + 4.5}">${esc(S.startedBy(who))}</text>` +
        timers.map(([s, cls]) => mono11(546, cy + 4, s, `mu tn ${cls}`, 'end')).join('') +
        button(640, cy, S.interrupt)
      )
    }

    /* ------------------------------------------------ timeline (ms) ---- */
    const M_IN = 400 // Maria's caret appears
    const M_MOVE = 600 // ...and moves to the end of the line
    const I_IN = 600 // Ivan's caret appears in cell 04
    const TYPE0 = 700 // first typed character
    const TYPE_MS = 90
    const A_IN = 1200 // Alex selects "group"
    const A_OUT = 3600 // Alex clicks away
    const RUN3 = 2500 // Maria runs cell 03
    const RUN4 = 3000 // Ivan runs cell 04 → queued
    const DONE3 = 4200
    const START4 = 4500
    const DONE4 = 5600
    const CAPTION = 6600

    const typed = '.mean().round(2)'
    const typeSteps = [...typed].map((_, i) => TYPE0 + i * TYPE_MS)
    const typedEnd = typeSteps[typeSteps.length - 1]

    /* ------------------------------------------------ geometry --------- */
    // Cell 03: two lines. Cell 04: one line. Outputs sit in a slot under each.
    const c3Top = 34 // line 1 top (22px lines)
    const c3Base = [c3Top + 15, c3Top + 22 + 15]
    const c3Slot = 94 // status row / output centre
    const c4Top = 128
    const c4Base = c4Top + 15
    const c4Slot = 166
    const bodyX = 80
    const bodyR = 648

    const line3a: Tok[] = [['t', 'df'], ['p', ' = '], ['t', 'pd'], ['p', '.'], ['f', 'read_csv'], ['p', '('], ['st', '"scores.csv"'], ['p', ')']]
    const line3b: Tok[] = [['t', 'df'], ['p', '.'], ['t', 'shape']]
    const line4: Tok[] = [['t', 'df'], ['p', '.'], ['f', 'groupby'], ['p', '('], ['st', '"group"'], ['p', ')['], ['st', '"score"'], ['p', ']']]
    const line4typed: Tok[] = [['p', '.'], ['f', 'mean'], ['p', '().'], ['f', 'round'], ['p', '('], ['n', '2'], ['p', ')']]
    const col4 = line4.reduce((s, [, t]) => s + t.length, 0) // 28

    const out: string[] = []
    const add = (s: string) => out.push(s)

    // Card and panels.
    add(`<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12" fill="${T.surface}" stroke="${T.line}"/>`)
    add(`<rect x="16.5" y="14.5" width="647" height="241" rx="8" fill="${T.canvas}" stroke="${T.line}"/>`)
    add(`<rect x="676.5" y="14.5" width="187" height="241" rx="8" fill="${T.canvas}" stroke="${T.line}"/>`)

    /* ---- cell 03 ---- */
    // Gutter: ordinal, then the run mark [ ] → [*] → [7].
    add(mono(68, c3Base[0], '03', 'mu', 'end'))
    add(mono(68, c3Base[0], '03', `acc ${shown(RUN3, DONE3, 160, 160)}`, 'end', ' opacity="0"'))
    add(mono11(68, c3Base[1] - 1, '[ ]', `mu ${hidden(RUN3, null, 160)}`, 'end', ' opacity="0"'))
    add(mono11(68, c3Base[1] - 1, '[*]', `acc ${shown(RUN3, DONE3, 160, 160)}`, 'end', ' opacity="0"'))
    add(mono11(68, c3Base[1] - 1, '[7]', `mu ${shown(DONE3, null, 160)}`, 'end'))
    // Body: surface with a 4px left rule that lights while the cell runs.
    add(`<rect x="${bodyX}" y="${c3Top - 2}" width="${bodyR - bodyX}" height="48" fill="${T.surface}"/>`)
    add(`<rect x="${bodyX}" y="${c3Top - 2}" width="4" height="48" fill="${T.line}"/>`)
    add(`<rect class="${shown(RUN3, DONE3, 160, 160)}" x="${bodyX}" y="${c3Top - 2}" width="4" height="48" fill="${T.accent}" opacity="0"/>`)
    add(code(CX, c3Base[0], line3a))
    add(code(CX, c3Base[1], line3b))
    // Status row while running, then the output rises into the same slot.
    const t3 = [track(O(1), [[3000, O(0), 1]]), track(O(0), [[3000, O(1), 1], [3500, O(0), 1]]), track(O(0), [[3500, O(1), 1], [4000, O(0), 1]]), track(O(0), [[4000, O(1), 1]])]
    add(
      `<g class="${rise(RUN3, DONE3)}" opacity="0">` +
        runningRow(c3Slot, S.maria, MARIA, track('transform:rotate(0deg)', [[RUN3, 'transform:rotate(0deg)', 1], [RUN3 + 1, 'transform:rotate(620deg)', DONE3 + 160 - RUN3 - 1, 'linear']]), [
          ['0.0s', t3[0]], ['0.5s', t3[1]], ['1.0s', t3[2]], ['1.5s', t3[3]],
        ]) +
        `</g>`,
    )
    add(`<g class="${rise(DONE3 + 80, null)}">${code(CX, c3Slot + 4.5, [['o', '(1000, 14)']])}</g>`)

    /* ---- cell 04 ---- */
    add(mono(68, c4Base, '04', 'mu', 'end'))
    add(mono(68, c4Base, '04', `acc ${track(O(0), [[RUN4, O(0.8), 160], [START4, O(1), 160], [DONE4, O(0), 160]])}`, 'end', ' opacity="0"'))
    add(mono11(68, c4Base + 18, '[ ]', `mu ${hidden(RUN4, null, 160)}`, 'end', ' opacity="0"'))
    add(mono11(68, c4Base + 18, '[*]', `acc ${shown(RUN4, DONE4, 160, 160)}`, 'end', ' opacity="0"'))
    add(mono11(68, c4Base + 18, '[8]', `mu ${shown(DONE4, null, 160)}`, 'end'))
    add(`<rect x="${bodyX}" y="${c4Top - 2}" width="${bodyR - bodyX}" height="26" fill="${T.surface}"/>`)
    add(`<rect x="${bodyX}" y="${c4Top - 2}" width="4" height="26" fill="${T.line}"/>`)
    add(`<rect class="${track(O(0), [[RUN4, O(0.5), 160], [START4, O(1), 160], [DONE4, O(0), 160]])}" x="${bodyX}" y="${c4Top - 2}" width="4" height="26" fill="${T.accent}" opacity="0"/>`)
    // Alex's selection sits under the text, as CodeMirror draws it.
    const selCls = shown(A_IN, A_OUT, 200, 200)
    add(`<rect class="${selCls}" x="${r5(colX(12))}" y="${c4Top + 1}" width="${r5(5 * CW)}" height="20" fill="${ALEX}" fill-opacity=".18"/>`)
    add(code(CX, c4Base, line4))
    // Typed tail: revealed by a surface-coloured cover that steps right with the caret.
    add(code(colX(col4), c4Base, line4typed, track(O(1), [[R0, O(0), R1 - R0]])))
    // One step track drives both the cover and Ivan's caret, so they cannot drift.
    const typing = track(TX(0), [...typeSteps.map((t, i): Change => [t, TX((i + 1) * CW), 1]), [R1 + 20, TX(0), 1]], TX(0))
    const typedShift = +(typed.length * CW).toFixed(1)
    add(`<rect class="${typing}" x="${r5(colX(col4))}" y="${c4Top}" width="${r5(typed.length * CW + 2)}" height="22" fill="${T.surface}" transform="translate(${+(typed.length * CW).toFixed(1)} 0)"/>`)
    // Queued row: 1st in queue · QUEUED · by Ivan · CANCEL.
    {
      const place = S.place(1)
      const chipW = r5(MONO11_W(place.length) + 12)
      const qx = CX + chipW + 8
      add(
        `<g class="${rise(RUN4, START4, 120)}" opacity="0">` +
          `<rect x="${CX}" y="${c4Slot - 10}" width="${chipW}" height="20" rx="3" fill="${T.raised}"/>` +
          mono11(CX + 6, c4Slot + 4, place, 'mu') +
          caps(qx, c4Slot + 4, S.queued, 'acc') +
          `<text class="s ui mu" x="${r5(qx + CAPS_W(S.queued.length) + 8)}" y="${c4Slot + 4.5}">${esc(S.by)}</text>` +
          button(640, c4Slot, S.cancel) +
          `</g>`,
      )
    }
    const t4 = [track(O(1), [[5100, O(0), 1]]), track(O(0), [[5100, O(1), 1], [5600, O(0), 1]]), track(O(0), [[5600, O(1), 1]])]
    add(
      `<g class="${rise(START4 + 100, DONE4)}" opacity="0">` +
        runningRow(c4Slot, S.ivan, IVAN, track('transform:rotate(0deg)', [[START4 + 100, 'transform:rotate(0deg)', 1], [START4 + 101, 'transform:rotate(420deg)', DONE4 + 160 - START4 - 101, 'linear']]), [
          ['0.0s', t4[0]], ['0.5s', t4[1]], ['1.0s', t4[2]],
        ]) +
        `</g>`,
    )
    // Output: the Series repr, one row after another.
    const series: Tok[][] = [
      [['o', 'group']],
      [['o', 'A    0.71']],
      [['o', 'B    0.64']],
      [['o', 'C    0.58']],
      [['o', 'Name: score, dtype: float64']],
    ]
    series.forEach((row, i) => {
      add(`<g class="${rise(DONE4 + 100 + i * 150, null)}">${code(CX, c4Slot - 10 + 13.5 + i * 18, row)}</g>`)
    })

    /* ---- carets (on top of everything in the notebook) ---- */
    // Maria: appears inside the string in line 1, moves to the end of it.
    const mStart = 18
    const mEnd = 30
    add(
      `<g class="${track(`opacity:0;${TX((mStart - mEnd) * CW)}`, [
        [M_IN, `opacity:1;${TX((mStart - mEnd) * CW)}`, 200],
        [M_MOVE, `opacity:1;${TX(0)}`, 420],
        [R0, `opacity:0;${TX(0)}`, R1 - R0],
      ], `opacity:0;${TX((mStart - mEnd) * CW)}`)}">` +
        caret(mEnd, c3Top, S.maria, MARIA, track(O(0), [[M_IN, O(1), 200], [RUN3 + 1500, O(0), 200]])) +
        `</g>`,
    )
    // Alex: selection head after "group".
    add(`<g class="${selCls}">${caret(17, c4Top, S.alex, ALEX, track(O(0), [[A_IN, O(1), 200], [A_IN + 1500, O(0), 200]]))}</g>`)
    // Ivan: types the tail of cell 04 one character at a time, then runs it.
    add(
      `<g class="${shown(I_IN, null)}"><g class="${typing}" transform="translate(${typedShift} 0)">` +
        caret(col4, c4Top, S.ivan, IVAN, track(O(0), [[I_IN, O(1), 200], [START4, O(0), 200]])) +
        `</g></g>`,
    )

    /* ---- caption ---- */
    add(`<text class="s cap2 ${rise(CAPTION, null)}" x="32" y="282">${esc(S.caption)}</text>`)

    /* ---- people rail ---- */
    add(caps(692, 38, S.people, 'mu'))
    add(`<path d="M${r5(692 + CAPS_W(S.people.length) + 10)} 34.5H836" stroke="${T.line}"/>`)
    add(mono11(848, 38, '3', 'mu', 'end'))
    const person = (i: number, name: string, color: string, lines: string): string => {
      const cy = 68 + i * 42
      return (
        `<circle cx="704" cy="${cy}" r="12" fill="${color}"/>` +
        `<text class="s ini" x="704" y="${cy + 4.5}" text-anchor="middle" font-size="12">${[...name][0]}</text>` +
        `<text class="s nm" x="726" y="${cy - 2}">${esc(name)}</text>` +
        lines
      )
    }
    const act = (i: number, s: string, cls: string, extra = '', tone = 'mu act') =>
      `<text class="s ${tone} ${cls}"${extra} x="726" y="${68 + i * 42 + 14}">${esc(s)}</text>`
    add(
      person(0, S.maria, MARIA,
        act(0, S.editing('03'), hidden(RUN3, DONE3 + 100)) +
        act(0, S.runningCell('03'), shown(RUN3 + 100, DONE3, 160, 120), ' opacity="0"')),
    )
    add(
      person(1, S.ivan, IVAN,
        act(1, S.editing('04'), hidden(START4, DONE4 + 100)) +
        act(1, S.runningCell('04'), shown(START4 + 100, DONE4, 160, 120), ' opacity="0"')),
    )
    add(
      person(2, S.alex, ALEX,
        act(2, S.teacher, hidden(A_IN, A_OUT + 100), ' opacity="0"', 'acc badge') +
        act(2, S.editing('04'), shown(A_IN + 100, A_OUT, 160, 120))),
    )

    const style =
      `.s{font-family:${SANS}}.m{font-family:${MONO}}` +
      `.c{font-size:13px}.m11{font-size:11px}.cap{font-size:11px;font-weight:600}` +
      `.ui{font-size:13px}.act{font-size:12px}.badge{font-size:12px;font-weight:600}.nm{font-size:13px;font-weight:600;fill:${T.ink}}` +
      `.cap2{font-size:13px;fill:${T.ink}}.lab{font-size:12px;font-weight:700;fill:${CARET_INK}}.ini{font-weight:600;fill:${DISC_DARK}}` +
      `.tn{font-variant-numeric:tabular-nums}` +
      `.z{animation-duration:${LOOP / 1000}s;animation-timing-function:${OUT};animation-iteration-count:infinite;animation-fill-mode:both}` +
      `.ink{fill:${T.ink}}.mu{fill:${T.muted}}.acc{fill:${T.accentText}}` +
      `.t,.o{fill:${T.syn.text}}.p{fill:${T.syn.punct}}.f{fill:${T.syn.fn}}.st{fill:${T.syn.string}}.n{fill:${T.syn.number}}.k{fill:${T.syn.keyword}}` +
      css +
      `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" lang="${lang}" role="img" aria-labelledby="run-t run-d">` +
      `<title id="run-t">${S.title}</title><desc id="run-d">${esc(S.desc)}</desc>` +
      `<style>${style}</style>` +
      out.join('') +
      `</svg>\n`
    )

    function mono(x: number, y: number, s: string, cls: string, anchor = '', extra = ''): string {
      return `<text class="m c ${cls}"${extra} x="${x}" y="${y}"${anchor ? ` text-anchor="${anchor}"` : ''} textLength="${+(s.length * CW).toFixed(1)}" lengthAdjust="spacing">${esc(s)}</text>`
    }
  }
  return (theme, lang) => runScene(theme === 'light' ? LIGHT : DARK, lang)
}

// ====================================================================== council

/*
 * Council scene: "Everyone answers; the class discusses one" —
 * council-{light,dark}.svg, 12 s loop, one geometry with swapped tokens.
 *
 * Three students write their own sheets, run (a separate press from Submit, as
 * on the server) and submit; the runs go through the room's one kernel one at a
 * time after Oleg's loop hits the limit. The limit is 15 s because the rules
 * sheet offers 5/15/30/60/300 s. The teacher shows Marat's answer as
 * "Answer 12" without his name. Students never see Correct / Needs revision.
 */
function councilArt(): Scene {
  // ---------------------------------------------------------------- strings ----

  /**
   * The visible strings per language, the locale key next to them. The code of
   * the solutions is one and the same: three answers in Python and a KeyError
   * are data, not interface.
   *
   * `caps` is the capitals tracking. Cyrillic capitals are wider than Latin
   * ones, and at .12em "1 ВЫПОЛНЯЕТСЯ · 0 В ОЧЕРЕДИ" ran into the tabs; .04em
   * keeps the labels in capitals and fits the line into the same strip.
   *
   * `tabs.x` and `tabs.box` are the tab positions: they depend on the width of
   * the labels, measured in the browser (13px/600), and on how much room is
   * left on the right for the queue counter.
   *
   * `counter` is the queue counter character by character: the digits flip in
   * place, so their indices in the string are needed, not just the string
   * itself.
   */
  const TEXT = {
    en: {
      title: 'Council: everyone answers, the class discusses one',
      desc:
        'Anna, Marat and Dina each write their own answer to cell 07; their runs queue through the room’s one kernel one at a time once Oleg’s slow loop is stopped by the 15-second limit, the teacher marks the results in the council console, and shows Marat’s answer to the class as “Answer 12”, without his name.',
      cellLabel: 'CELL 07 · COUNCIL', // room.ui.526 + room.pult.v2.title
      task: 'Mean score per group in <tspan class="c13">df</tspan>',
      // room.pult.v2.rules.*: runLead/runEveryone, limitLead/limitValue+sec, screenLead/screenAnon
      rules: [
        ['RUNS · ', 'BY ANYONE, IN TURN'],
        ['EACH RUN · ', 'CAPPED AT 15 S'],
        ['ON SCREEN · ', 'WITHOUT NAMES'],
      ] as [string, string][],
      names: { anna: 'Anna', marat: 'Marat', dina: 'Dina', oleg: 'Oleg' },
      yourSheet: ' · your sheet', // room.ui.1222
      onlyTeacher: 'only the teacher sees your text', // room.ui.1222
      submit: 'Submit', // room.ui.356
      submitW: 74,
      submitted: 'SUBMITTED 18:42 · AWAITING REVIEW', // room.ui.1224
      yourOnScreen: 'YOUR ANSWER IS ON SCREEN', // room.ui.1227
      onScreen: 'ON SCREEN', // room.ui.349
      answer: 'Answer 12', // room.ui.1255
      nothingShown: 'Nothing is shown to the class', // room.pult.v2.nothingShown
      onClassScreen: 'On the class screen', // room.pult.v2.projection.title
      since: ' · since 18:47',
      showClass: 'Show the class', // room.ui.1336
      clearScreen: 'Clear class screen', // room.pult.v2.projection.clear
      tabs: {
        // room.pult.v2.workTab / queueTab / oracleTab
        labels: ['Work', 'Queue', 'Class Oracle'],
        x: [19, 82, 148],
        box: { x: 10, w: 54 },
      },
      // room.pult.v2.queue.counts
      counter: { label: '1 RUNNING · 0 QUEUED', running: [2, 'RUNNING ·'] as [number, string], queued: [14, 'QUEUED'] as [number, string], digits: [0, 12] },
      running: 'RUNNING', // room.pult.v2.execution.running
      stopped: 'STOPPED: LONGER THAN 15 S', // room.pult.v2.execution.timedOut
      queued: 'QUEUED', // room.pult.v2.execution.queued
      done: 'EXECUTION COMPLETED', // room.pult.v2.execution.ok
      error: 'EXECUTION ERROR', // room.pult.v2.execution.error
      correct: 'CORRECT', // room.pult.v2.review.correct
      revise: 'NEEDS REVISION', // room.pult.v2.review.wrong
      stoppedNote: 'ran past the limit · the queue moved on without them', // room.pult.v2.queue.stoppedNote
      same: '4 others answered the same', // room.pult.v2.workSame
      shownBy: 'shown by the teacher · 18:47 · 4 more wrote the same', // room.ui.1256
      runByTeacher: 'RUN BY THE TEACHER', // room.ui.61
      caps: 0.12,
    },
    ru: {
      title: 'Консилиум: отвечают все, разбирают одного',
      desc:
        'Анна, Марат и Дина пишут свой ответ на ячейку 07; запуски идут по очереди через единственное ядро комнаты, как только медленный цикл Олега останавливается на пределе в 15 секунд. Преподаватель отмечает результаты в пульте консилиума и показывает классу вариант Марата как «Вариант 12» — без имени.',
      cellLabel: 'ЯЧЕЙКА 07 · КОНСИЛИУМ',
      task: 'Средняя оценка по группам в <tspan class="c13">df</tspan>',
      rules: [
        ['ЗАПУСКАЮТ · ', 'ВСЕ ПО ОЧЕРЕДИ'],
        ['КАЖДЫЙ ЗАПУСК · ', 'ДО 15 С'],
        ['НА ЭКРАНЕ · ', 'БЕЗ ИМЁН'],
      ] as [string, string][],
      names: { anna: 'Анна', marat: 'Марат', dina: 'Дина', oleg: 'Олег' },
      yourSheet: ' · ваш лист',
      onlyTeacher: 'ваш текст видит только преподаватель',
      submit: 'Сдать',
      submitW: 60,
      submitted: 'СДАНО 18:42 · ЖДЁТ РАЗБОРА',
      yourOnScreen: 'ВАШ ВАРИАНТ НА ЭКРАНЕ',
      onScreen: 'НА ЭКРАНЕ',
      answer: 'Вариант 12',
      nothingShown: 'На экране класса пока ничего',
      onClassScreen: 'На экране класса',
      since: ' · с 18:47',
      showClass: 'Показать классу',
      clearScreen: 'Убрать с экрана',
      tabs: {
        labels: ['Работы', 'Очередь', 'Оракул о классе'],
        x: [13, 73, 141],
        box: { x: 4, w: 67 },
      },
      counter: { label: '1 ВЫПОЛНЯЕТСЯ · 0 В ОЧЕРЕДИ', running: [2, 'ВЫПОЛНЯЕТСЯ ·'] as [number, string], queued: [18, 'В ОЧЕРЕДИ'] as [number, string], digits: [0, 16] },
      running: 'ВЫПОЛНЯЕТСЯ',
      stopped: 'ОСТАНОВЛЕН: ДОЛЬШЕ 15 С',
      queued: 'В ОЧЕРЕДИ',
      done: 'ЗАПУСК ВЫПОЛНЕН',
      error: 'ОШИБКА ЗАПУСКА',
      correct: 'ВЕРНО',
      revise: 'НА ДОРАБОТКУ',
      stoppedNote: 'считали дольше предела · очередь пошла дальше без вас',
      same: 'Так же ответили ещё 4',
      shownBy: 'показал преподаватель · 18:47 · так же написали ещё 4',
      runByTeacher: 'ЗАПУСКАЛ ПРЕПОДАВАТЕЛЬ',
      caps: 0.04,
    },
  } as const

  // ---------------------------------------------------------------- tokens ----

  type Theme = 'light' | 'dark'

  const PALETTE = {
    light: {
      canvas: '#ffffff', surface: '#f3f6fb', raised: '#e7eef9', line: '#dce3ef', lineSoft: '#e9eef7',
      ink: '#101a33', muted: '#5d6b8a', faint: '#7c8699',
      primary: '#0f2d69', primaryInk: '#ffffff', accent: '#0fa0d7', accentText: '#0a6e96',
      positive: '#0c7a64', warning: '#9b5a08', danger: '#d4162f',
      // submitted chip: bg-brand/10 text-brand-2 in the app
      subFill: '#0f2d69', subText: '#374b9b',
      syn: { text: '#101a33', kw: '#7d50b9', fn: '#966600', str: '#00784e', num: '#b35415', com: '#686e7e', punct: '#5d6b8a' },
    },
    dark: {
      canvas: '#060c1c', surface: '#0a1330', raised: '#0e1b3d', line: '#16244b', lineSoft: '#10193a',
      ink: '#e6e7e8', muted: '#9ba6be', faint: '#5e6b85',
      primary: '#0fa0d7', primaryInk: '#06203a', accent: '#0fa0d7', accentText: '#0fa0d7',
      positive: '#3ec9a7', warning: '#f2a33c', danger: '#f2495f',
      subFill: '#0fa0d7', subText: '#0fa0d7',
      syn: { text: '#d6dce8', kw: '#b98fe8', fn: '#ffd746', str: '#8fd9a8', num: '#eb8c3c', com: '#758096', punct: '#9ba6be' },
    },
  } as const

  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif"
  const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"

  // web/src/lib/utils.ts · inkOn / contrastRatio, ported to assert avatar ink.
  const DISC_DARK = '#0F2246'
  const DISC_LIGHT = '#FFFFFF'
  function channel(v: number): number {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  function luminance(hex: string): number {
    const n = parseInt(hex.replace('#', ''), 16)
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  }
  function contrastRatio(a: string, b: string): number {
    const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05]
    return x > y ? x / y : y / x
  }
  function inkOn(bg: string): string {
    return contrastRatio(DISC_DARK, bg) >= contrastRatio(DISC_LIGHT, bg) ? DISC_DARK : DISC_LIGHT
  }

  // ---------------------------------------------------------------- motion ----

  const LOOP = 12000
  const SEAM = LOOP - 400 // last 400 ms: crossfade back to the start frame
  const HOLD = 10000 // a moment inside the resolved hold: the static frame
  const EASE = {
    out: 'cubic-bezier(.23,1,.32,1)',
    io: 'cubic-bezier(.77,0,.175,1)',
    lin: 'linear',
    step: 'step-end',
  } as const
  type Ease = keyof typeof EASE

  /** at(ms) → keyframe percentage, the one clock every element shares. */
  const at = (ms: number): string => `${+((ms / LOOP) * 100).toFixed(2)}%`
  const r5 = (n: number): number => Math.round(n * 2) / 2

  type Stop = [ms: number, decl: string, ease?: Ease]
  type Change = [ms: number, decl: string, dur: number, ease?: Ease]

  const IDENTITY = new Set(['', 'none', 'scale(1)', 'translateY(0)', 'translateX(0)', 'rotate(0)'])

  class Motion {
    private bodies = new Map<string, string>()
    private out: string[] = []

    /** Raw stops → class name. Identical keyframes share one rule. */
    stops(stops: Stop[], base: Ease = 'out'): string {
      // ease-out is the element default (.a), so only other curves are spelled
      // out; keyframes with the same declaration share one selector list.
      const groups = new Map<string, string[]>()
      for (let i = 0; i < stops.length; i++) {
        const [ms, decl, ease] = stops[i]
        const next = stops[i + 1]
        if (next && next[0] === ms && !ease) continue
        const key = `${decl}${ease && ease !== base ? `;animation-timing-function:${EASE[ease]}` : ''}`
        const list = groups.get(key) ?? []
        if (!list.includes(at(ms))) list.push(at(ms))
        groups.set(key, list)
      }
      const body = [...groups].map(([key, list]) => `${list.join(',')}{${key}}`).join('')
      let name = this.bodies.get(body)
      if (!name) {
        name = `k${this.bodies.size}`
        this.bodies.set(body, name)
        this.out.push(`@keyframes ${name}{${body}}.${name}{animation-name:${name}}`)
      }
      return `a ${name}`
    }

    /**
     * A value track: start value, then timed changes. Whatever differs from the
     * start at SEAM crossfades back to it in the last 400 ms. Returns the class
     * and the resolved (static-frame) value, so the base attributes can be
     * authored as the finished story.
     */
    track(v0: string, changes: Change[], seamEase: Ease = 'out'): { cls: string; end: string } {
      const stops: Stop[] = [[0, v0]]
      let cur = v0
      let end = v0
      for (const [ms, v, dur, ease = 'out'] of changes) {
        if (ms < 400 && ms !== 0) throw new Error(`first beat before 0.4 s: ${ms}`)
        if (ms + dur > SEAM) throw new Error(`beat runs into the seam: ${ms}`)
        stops.push([ms, cur, ease])
        stops.push([ms + dur, v])
        cur = v
        if (ms + dur <= HOLD) end = v
      }
      if (cur !== v0) {
        stops.push([SEAM, cur, seamEase])
      }
      stops.push([LOOP, v0])
      return { cls: this.stops(stops), end }
    }

    css(): string {
      return this.out.join('')
    }
  }

  /** opacity + transform in one declaration string. */
  const st = (o: number, t = 'none'): string => `opacity:${o};transform:${t}`

  /** Attributes for an element whose opacity (and maybe transform) is animated. */
  function attrs(m: Motion, v0: string, changes: Change[], extraCls = '', seamEase: Ease = 'out'): string {
    const { cls, end } = m.track(v0, changes, seamEase)
    const o = /opacity:([\d.]+)/.exec(end)
    const t = /transform:([^;]+)/.exec(end)
    if (t && !IDENTITY.has(t[1].trim())) throw new Error(`static frame would keep a transform: ${end}`)
    const op = o && o[1] !== '1' ? ` opacity="${o[1]}"` : ''
    return `class="${cls}${extraCls ? ' ' + extraCls : ''}"${op}`
  }

  /** Fade helper: 0/1 visibility changes, 160 ms by default. */
  let seamHold = false
  /**
   * Fade helper: 0/1 visibility changes, 160 ms by default. Inside a container
   * that itself fades out at the seam (`seamHold`), children keep their last
   * state and reset on the invisible loop boundary instead of crossfading.
   */
  function fade(m: Motion, v0: 0 | 1, changes: [ms: number, v: 0 | 1, dur?: number][], extraCls = ''): string {
    return attrs(
      m,
      `opacity:${v0}`,
      changes.map(([ms, v, dur = 160]) => [ms, `opacity:${v}`, dur, 'out'] as Change),
      extraCls,
      seamHold ? 'step' : 'out',
    )
  }

  // ------------------------------------------------------------------ text ----

  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  /** Capitals tracking: set by the scene's language (see TEXT). */
  let CAPS_TRACK: number = TEXT.en.caps

  /** Width of a mono run: chars × 0.6 × size, plus the caps tracking. */
  const monoW = (s: string, size: number, caps: boolean): number =>
    [...s].length * 0.6 * size + (caps ? ([...s].length - 1) * CAPS_TRACK * size : 0)

  type Tok = [text: string, cls: string]
  const CODE = new Map<string, { id: string; svg: string }>()

  /** Mono line with an explicit textLength, so every glyph lands on the grid. */
  function monoText(x: number, y: number, toks: Tok[] | string, o: { cls?: string; caps?: boolean; size?: number } = {}): string {
    const size = o.size ?? (o.caps ? 11 : 13)
    const list: Tok[] = typeof toks === 'string' ? [[toks, '']] : toks
    const s = list.map(([t]) => t).join('')
    const w = monoW(s, size, !!o.caps)
    const inner = list.map(([t, c]) => (c ? `<tspan class="${c}">${esc(t)}</tspan>` : esc(t))).join('')
    const base = o.caps ? 'L' : size === 13 ? 'C' : 'c11'
    const cls = `${base}${o.cls ? ' ' + o.cls : ''}`
    // lengthAdjust defaults to "spacing": glyphs keep their shape, gaps absorb the difference
    if (list.length > 1 && !o.caps) {
      // highlighted code repeats across sheets, rows and plates: define once, <use> it
      const key = `${cls}|${s}`
      let id = CODE.get(key)?.id
      if (!id) {
        id = `c${CODE.size}`
        CODE.set(key, { id, svg: `<text id="${id}" class="${cls}" textLength="${+w.toFixed(2)}">${inner}</text>` })
      }
      return `<use href="#${id}" x="${r5(x)}" y="${y}"/>`
    }
    return `<text x="${r5(x)}" y="${y}" class="${cls}" textLength="${+w.toFixed(2)}">${inner}</text>`
  }

  const sans = (x: number, y: number, inner: string, cls = 'u', extra = ''): string =>
    `<text x="${r5(x)}" y="${y}" class="${cls}"${extra}>${inner}</text>`

  /** A caps chip: tinted rect + mono label, optional 12 px icon slot on the left. */
  const CHIPS = new Map<string, { id: string; svg: string }>()
  /**
   * A caps chip: tinted rect + mono label, optional 12 px icon slot on the left.
   * The rect and label are defined once at the origin and placed with <use>, so
   * the same state chip on four rows costs one definition.
   */
  function chip(x: number, y: number, label: string, tone: string, o: { h?: number; icon?: string; right?: boolean } = {}): { svg: string; w: number; x: number } {
    const h = o.h ?? 18
    const tw = monoW(label, 11, true)
    const iconW = o.icon ? 17 : 0
    const w = r5(6 + iconW + tw + 6)
    const cx = o.right ? r5(x - w) : x
    const key = `${label}|${tone}|${h}|${iconW}`
    let id = CHIPS.get(key)?.id
    if (!id) {
      id = `h${CHIPS.size}`
      const ty = r5(h / 2 + 3.9)
      CHIPS.set(key, {
        id,
        svg: `<g id="${id}"><rect width="${w}" height="${h}" rx="3" class="x${tone}"/>${monoText(6 + iconW, ty, label, { caps: true, cls: `t${tone}` })}</g>`,
      })
    }
    const icon = o.icon ? o.icon.replace(/\{x\}/g, String(cx + 11)).replace(/\{y\}/g, String(y + h / 2)) : ''
    return { svg: `<use href="#${id}" x="${cx}" y="${y}"/>${icon}`, w, x: cx }
  }

  // ----------------------------------------------------------------- scene ----

  interface Student { name: string; color: string; code: Tok[]; typeFrom: number; typeTo: number }

  function council(theme: Theme, lang: Lang): string {
    const P = PALETTE[theme]
    const S = TEXT[lang]
    CAPS_TRACK = S.caps
    const m = new Motion()
    CODE.clear()
    CHIPS.clear()
    const W = 880
    const H = 380

    const py = (s: string): Tok[] => {
      // tiny Python highlighter, enough for the three answers
      const out: Tok[] = []
      const re = /("[^"]*"|'[^']*')|(\b\d[\d*]*\b)|(\b(?:for|in|while|True|and|or|not)\b)|([A-Za-z_]\w*)(?=\()|([A-Za-z_]\w*)|(\s+)|([^\sA-Za-z_\d"']+)/g
      let mm: RegExpExecArray | null
      while ((mm = re.exec(s))) {
        const [t, str, num, kw, fn, id, ws] = mm
        const cls = str ? 'ss' : num ? 'sn' : kw ? 'sk' : fn ? 'sf' : id ? 'st' : ws ? '' : 'sp'
        const last = out[out.length - 1]
        if (last && last[1] === cls) last[0] += t
        else out.push([t, cls])
      }
      return out
    }

    const students: Student[] = [
      { name: S.names.anna, color: '#4aa8f0', code: py('df.groupby("group")["score"].mean()'), typeFrom: 400, typeTo: 3200 },
      { name: S.names.marat, color: '#8ac44a', code: py('df["score"].mean()'), typeFrom: 1000, typeTo: 2700 },
      { name: S.names.dina, color: '#c273e6', code: py('df.groupby("group")["scores"].mean()'), typeFrom: 450, typeTo: 3330 },
    ]
    const oleg = { name: S.names.oleg, color: '#f2a33c', code: py('for n in range(10**9): s += n') }
    for (const c of [...students.map((s) => s.color), oleg.color]) {
      if (inkOn(c) !== DISC_DARK) throw new Error(`avatar ink on ${c} is not ${DISC_DARK}`)
      if (contrastRatio(DISC_DARK, c) < 4.5) throw new Error(`avatar contrast on ${c}`)
    }
    const initials = (n: string): string => [...n].slice(0, 2).join('').toUpperCase()

    // Beats (ms)
    const RUN = [3300, 3800, 4300] // ▶ pressed by Anna, Marat, Dina → joins the queue
    const SUB = [3600, 4100, 4600] // Submit pressed
    const STOP = 4600 // Oleg's slow loop hits the limit; the queue moves on
    const DONE = [4900, 5200, 5500] // Anna ok · Marat ok · Dina error
    const MARK = [6600, 6800] // Correct · Needs revision
    const PICK = 7500 // Marat's row selected, "Show the class" appears
    const PRESS = 7700
    const SHOW = 7900
    const SHIFT = 27 // left column FLIP when Anna's plate slides in

    const defs: string[] = []
    const body: string[] = []
    const push = (s: string): void => void body.push(s)

    // ---- card
    push(`<rect x=".5" y=".5" width="879" height="${H - 1}" rx="12" class="bs sl"/>`)

    // ---- top strip
    push(monoText(16, 25, S.cellLabel, { caps: true, cls: 'ta' }))
    push(sans(16, 46, S.task, 'h'))
    {
      const rules = S.rules
      let right = 864
      const parts: string[] = []
      for (const [lead, value] of [...rules].reverse()) {
        const w = r5(monoW(lead + value, 11, true) + 12)
        const x = r5(right - w)
        parts.unshift(
          `<rect x="${x + 0.5}" y="12.5" width="${w - 1}" height="17" rx="3" class="bc sl"/>` +
            monoText(x + 6, 25, [[lead, 'tm'], [value, 'ti']], { caps: true }),
        )
        right = x - 6
      }
      push(parts.join(''))
    }

    // ---- geometry
    const LX = 16 // left column
    const LW = 360
    const RX = 388 // right column
    const RW = 476
    const TOP = 58
    const SHEET_H = 80
    const PLATE_S = 24
    const sheetY = [TOP, TOP + SHEET_H + 3 + PLATE_S + 6, TOP + 2 * SHEET_H + 3 + PLATE_S + 12] // final (after FLIP)
    const plateAY = TOP + SHEET_H + 3
    const plateDY = sheetY[2] + SHEET_H + 3

    const shownCode = py('df["score"].mean()')

    /** Compact shown plate under a student's sheet. */
    const smallPlate = (y: number, id: string, enterAt: number): string => {
      defs.push(`<clipPath id="${id}"><rect x="${LX}" y="${y}" width="${LW}" height="${PLATE_S}" rx="6"/></clipPath>`)
      const c = chip(LX + 12, y + 3, S.onScreen, 'Ps')
      const codeW = monoW('df["score"].mean()', 13, false)
      return (
        `<g ${attrs(m, st(0, 'translateY(-4px)'), [[enterAt, st(1), 260]], 'p')}>` +
        `<g clip-path="url(#${id})"><rect x="${LX}" y="${y}" width="${LW}" height="${PLATE_S}" class="bc"/>` +
        `<rect x="${LX}" y="${y}" width="${LW}" height="${PLATE_S}" class="xp"/>` +
        `<rect x="${LX}" y="${y}" width="4" height="${PLATE_S}" class="bP"/></g>` +
        c.svg +
        `<circle cx="${LX + 12 + c.w + 12}" cy="${y + 12}" r="6.5" class="br sl"/>` +
        sans(LX + 12 + c.w + 23, y + 16.5, S.answer, 'n') +
        monoText(LX + LW - 10 - codeW, y + 16.5, shownCode) +
        `</g>`
      )
    }

    // ---- left column: three student sheets
    const sheets: string[] = []
    students.forEach((s, i) => {
      const sx = LX
      const sy = sheetY[i]
      const g: string[] = []
      g.push(`<rect x="${sx + 0.5}" y="${sy + 0.5}" width="${LW - 1}" height="${SHEET_H - 1}" rx="8" class="bc sl"/>`)
      // header
      g.push(`<circle cx="${sx + 18}" cy="${sy + 17}" r="11" fill="${s.color}"/>`)
      g.push(sans(sx + 18, sy + 21, initials(s.name), 'av m'))
      g.push(sans(sx + 38, sy + 21.5, `<tspan class="w6 ti">${esc(s.name)}</tspan>${esc(S.yourSheet)}`, 'u tm'))
      // code band
      const bandY = sy + 29
      g.push(`<rect x="${sx + 10}" y="${bandY}" width="${LW - 20}" height="24" rx="4" class="bs"/>`)
      const codeX = sx + 20
      const text = s.code.map(([t]) => t).join('')
      g.push(monoText(codeX, bandY + 16.5, s.code))
      // typing: a band-coloured cover with the caret on its edge steps right by
      // whole characters, clipped to the code's own extent.
      const n = text.length
      const clip = `ty${i}`
      defs.push(`<clipPath id="${clip}"><rect x="${codeX - 2}" y="${bandY}" width="${r5(n * 7.8 + 5)}" height="24"/></clipPath>`)
      {
        // token boundaries: reveal whole tokens at the typing pace
        const bounds: number[] = []
        let acc = 0
        for (const [t, c] of s.code) {
          // split identifiers/punct runs into word-ish tokens
          const parts = c === 'sp' ? t.match(/\(\)|\[|\]|\(|\)|\.|"|,|:|=|\+|./g) ?? [t] : [t]
          for (const p of parts) { acc += p.length; bounds.push(acc) }
        }
        const per = (s.typeTo - s.typeFrom) / n
        // segments default to step-end (class .sE); only the fades are eased
        const stops: Stop[] = [[0, 'opacity:1;transform:none']]
        for (const b of bounds) {
          const ms = Math.round(s.typeFrom + b * per)
          stops.push([ms, `transform:translate(${+(b * 7.8).toFixed(1)}px)`])
        }
        const full = `translate(${+(n * 7.8).toFixed(1)}px)`
        stops.push([RUN[i], `opacity:1;transform:${full}`, 'out'])
        stops.push([RUN[i] + 140, `opacity:0;transform:${full}`, 'step'])
        stops.push([SEAM, `opacity:0;transform:none`, 'out'])
        stops.push([LOOP, 'opacity:1;transform:none'])
        g.push(
          `<g clip-path="url(#${clip})"><g class="${m.stops(stops, 'step')} sE" opacity="0">` +
            `<rect x="${codeX - 0.5}" y="${bandY}" width="${r5(n * 7.8 + 6)}" height="24" class="bs"/>` +
            `<rect x="${codeX - 1}" y="${bandY + 4}" width="1.5" height="16" class="bA"/></g></g>`,
        )
      }
      // ▶ run button (⇧↵ in the app): pressed at RUN, gone once submitted
      {
        const bx = sx + LW - 38
        const by = bandY + 3.5
        g.push(
          `<g ${attrs(m, st(1, 'scale(1)'), [
            [RUN[i], st(1, 'scale(.97)'), 70],
            [RUN[i] + 70, st(1, 'scale(1)'), 70],
            [SUB[i] + 140, st(0, 'scale(1)'), 160],
          ], 'p')}>` +
            `<rect x="${bx + 0.5}" y="${by - 0.5}" width="23" height="17" rx="4" class="bc sl"/>` +
            `<path d="M${bx + 9} ${by + 4.5}v8l6.5-4z" class="fA"/>` +
            `<rect x="${bx}" y="${by - 1}" width="24" height="18" rx="4" ${attrs(m, 'opacity:0', [
              [RUN[i], 'opacity:1', 70],
              [RUN[i] + 70, 'opacity:0', 260],
            ])} fill="${P.accent}" fill-opacity=".14"/></g>`,
        )
      }
      // footer: hint + Submit (draft) → submitted chip → (Marat) on screen
      const fy = sy + 57
      g.push(`<g ${fade(m, 1, [[SUB[i] + 140, 0]])}>${sans(sx + 12, fy + 13.5, esc(S.onlyTeacher), 'u tm')}</g>`)
      g.push(
        `<g ${attrs(m, st(1, 'scale(1)'), [
          [SUB[i], st(1, 'scale(.97)'), 70],
          [SUB[i] + 70, st(1, 'scale(1)'), 70],
          [SUB[i] + 140, st(0, 'scale(1)'), 160],
        ], 'p')}>` +
          `<rect x="${sx + LW - 12 - S.submitW}" y="${fy}" width="${S.submitW}" height="18" rx="6" class="bpr"/>` +
          sans(sx + LW - 12 - S.submitW / 2, fy + 13, esc(S.submit), 'u w6 tpi m') +
          `</g>`,
      )
      const sub = chip(sx + LW - 12, fy, S.submitted, 'S', { right: true })
      const subChanges: [number, 0 | 1, number?][] = [[SUB[i] + 260, 1, 200]]
      if (i === 1) subChanges.push([SHOW, 0, 100])
      g.push(`<g ${fade(m, 0, subChanges)}>${sub.svg}</g>`)
      if (i === 1) {
        const on = chip(sx + LW - 12, fy, S.yourOnScreen, 'p15', { right: true })
        g.push(`<g ${fade(m, 0, [[SHOW + 90, 1, 180]])}>${on.svg}</g>`)
      }
      sheets.push(g.join(''))
    })

    // plates go under the sheets so Anna's emerges from beneath Marat's as it moves
    push(smallPlate(plateAY, 'pa', SHOW + 150))
    push(sheets[0])
    push(
      `<g ${attrs(m, st(1, `translateY(-${SHIFT}px)`), [[SHOW, st(1, 'translateY(0)'), 420, 'io']], '', 'io')}>` +
        sheets[1] +
        sheets[2] +
        `</g>`,
    )
    push(smallPlate(plateDY, 'pd', SHOW + 420))

    // ---- right column: the teacher's council console
    const CY = TOP
    const CH = 210
    defs.push(`<clipPath id="cc"><rect x="${RX}" y="${CY}" width="${RW}" height="${CH}" rx="8"/></clipPath>`)
    const con: string[] = []
    con.push(`<rect x="${RX}" y="${CY}" width="${RW}" height="${CH}" class="bc"/>`)

    // banner row: what the class screen shows
    con.push(`<rect x="${RX}" y="${CY}" width="4" height="30" ${fade(m, 0, [[SHOW, 1, 180]], 'bP')}/>`)
    con.push(`<g ${fade(m, 1, [[SHOW, 0, 120]])}>${sans(RX + 16, CY + 19.5, esc(S.nothingShown), 'u tm')}</g>`)
    con.push(
      `<g ${fade(m, 0, [[SHOW + 100, 1, 180]])}>${sans(RX + 16, CY + 19.5, `<tspan class="w7 tp">${esc(S.onClassScreen)}</tspan>${esc(S.since)}`, 'u tm')}</g>`,
    )
    {
      // "Show the class" appears with the selection, is pressed, then becomes "Clear class screen"
      const bw = 150
      const bx = RX + RW - 12 - bw
      con.push(
        `<g ${attrs(m, st(0, 'scale(1)'), [
          [PICK, st(1, 'scale(1)'), 160],
          [PRESS, st(1, 'scale(.97)'), 70],
          [PRESS + 70, st(1, 'scale(1)'), 70],
          [SHOW, st(0, 'scale(1)'), 110],
        ], 'p')}>` +
          `<rect x="${bx}" y="${CY + 5}" width="${bw}" height="20" rx="6" class="bpr"/>` +
          sans(bx + bw / 2, CY + 19.5, esc(S.showClass), 'u w6 tpi m') +
          `</g>`,
      )
      con.push(
        `<g ${fade(m, 0, [[SHOW + 100, 1, 180]])}>` +
          `<rect x="${bx + 0.5}" y="${CY + 5.5}" width="${bw - 1}" height="19" rx="6" class="bc sl"/>` +
          sans(bx + bw / 2, CY + 19.5, esc(S.clearScreen), 'u tm m') +
          `</g>`,
      )
    }
    con.push(`<rect x="${RX}" y="${CY + 30}" width="${RW}" height="1" class="bl"/>`)

    // tabs + queue strip
    const TY = CY + 31
    con.push(`<rect x="${RX + S.tabs.box.x}" y="${TY + 5}" width="${S.tabs.box.w}" height="18" rx="3" class="br"/>`)
    con.push(sans(RX + S.tabs.x[0], TY + 18, esc(S.tabs.labels[0]), 'u w6 ti'))
    con.push(sans(RX + S.tabs.x[1], TY + 18, esc(S.tabs.labels[1]), 'u tm'))
    con.push(sans(RX + S.tabs.x[2], TY + 18, esc(S.tabs.labels[2]), 'u tm'))
    {
      const { label, running, queued, digits } = S.counter
      const pitch = 6.6 + CAPS_TRACK * 11
      const sx = r5(RX + RW - 12 - monoW(label, 11, true))
      const y = TY + 18
      // dot: accent while the kernel is busy, muted once idle
      con.push(`<circle cx="${sx - 9}" cy="${TY + 14}" r="3.5" class="fM"/>`)
      con.push(`<circle cx="${sx - 9}" cy="${TY + 14}" r="3.5" ${fade(m, 1, [[DONE[2], 0, 160]], 'fA')}/>`)
      const digit = (ch: number, d: string, changes: [number, 0 | 1, number?][], v0: 0 | 1): string =>
        `<g ${fade(m, v0, changes.map(([ms, v]) => (v ? [ms + 60, 1, 120] : [ms, 0, 80]) as [number, 0 | 1, number]))}><text x="${r5(sx + ch * pitch)}" y="${y}" class="L ti">${d}</text></g>`
      con.push(monoText(sx + running[0] * pitch, y, running[1], { caps: true, cls: 'tm' }))
      con.push(monoText(sx + queued[0] * pitch, y, queued[1], { caps: true, cls: 'tm' }))
      con.push(digit(digits[0], '1', [[DONE[2], 0, 120]], 1))
      con.push(digit(digits[0], '0', [[DONE[2], 1, 120]], 0))
      // queued: 0 → 1 → 2 → 3 → 2 → 1 → 0
      con.push(digit(digits[1], '0', [[RUN[0], 0, 120], [DONE[1], 1, 120]], 1))
      con.push(digit(digits[1], '1', [[RUN[0], 1, 120], [RUN[1], 0, 120], [DONE[0], 1, 120], [DONE[1], 0, 120]], 0))
      con.push(digit(digits[1], '2', [[RUN[1], 1, 120], [RUN[2], 0, 120], [STOP, 1, 120], [DONE[0], 0, 120]], 0))
      con.push(digit(digits[1], '3', [[RUN[2], 1, 120], [STOP, 0, 120]], 0))
    }
    con.push(`<rect x="${RX}" y="${TY + 28}" width="${RW}" height="1" class="bl"/>`)

    // work rows
    const ROW0 = TY + 29
    const ROW_H = 38
    const spinner = (id: string, until: number, from = 0): string => {
      // 270° arc, one turn per second while its chip is visible
      const turns = Math.max(1, Math.round((until - from) / 1000))
      const stops: Stop[] = [[0, 'transform:rotate(0)']]
      if (from > 0) stops.push([from, 'transform:rotate(0)', 'lin'])
      stops.push([until, `transform:rotate(${turns * 360}deg)`])
      stops.push([LOOP, `transform:rotate(${turns * 360}deg)`])
      return `<circle cx="{x}" cy="{y}" r="4.5" fill="none" stroke-width="1.5" stroke-dasharray="21.2 28.3" stroke-linecap="round" class="o${id} ${m.stops(stops)} p"/>`
    }
    const clock = `<circle cx="{x}" cy="{y}" r="4.5" fill="none" stroke-width="1.3" class="oW"/><path d="M{x} {y}v-2.6M{x} {y}h2.2" fill="none" stroke-width="1.3" stroke-linecap="round" class="oW"/>`
    const fix = (s: string, x: number, y: number): string => s.replace(/\{x\}/g, String(x)).replace(/\{y\}/g, String(y))

    const RUN_X = RX + 104
    const END_X = RX + RW - 12
    const row = (i: number, who: { name: string; color: string }, inner: string, enter: number | null, selected = false): string => {
      const y = ROW0 + i * ROW_H
      const parts: string[] = []
      if (selected) {
        parts.push(
          `<g ${fade(m, 0, [[PICK, 1, 180]])}><rect x="${RX}" y="${y}" width="${RW}" height="${ROW_H}" class="br"/>` +
            `<rect x="${RX}" y="${y}" width="4" height="${ROW_H}" class="bpr"/></g>`,
        )
      }
      if (i > 0) parts.push(`<rect x="${RX}" y="${y}" width="${RW}" height="1" class="bL"/>`)
      parts.push(`<circle cx="${RX + 22}" cy="${y + 19}" r="12" fill="${who.color}"/>`)
      parts.push(sans(RX + 22, y + 23, initials(who.name), 'av m'))
      parts.push(sans(RX + 42, y + 15, esc(who.name), "n"))
      parts.push(inner)
      const content = parts.join('')
      return enter === null
        ? content
        : `<g ${attrs(m, st(0, 'translateY(4px)'), [[enter, st(1), 260]])}>${content}</g>`
    }
    /** Chip that is visible between `from` and `to` (null = until the seam). */
    const stateChip = (y: number, label: string, tone: string, v0: 0 | 1, from: number | null, to: number | null, icon?: string, right = false): string => {
      const c = chip(right ? END_X : RUN_X, y + 2, label, tone, { icon, right })
      // swap, not blend: the old state leaves in 100 ms, the new one lands 90 ms in
      const changes: [number, 0 | 1, number?][] = []
      if (from !== null) changes.push([from + 90, 1, 160])
      if (to !== null) changes.push([to, 0, 100])
      return `<g ${fade(m, v0, changes)}>${c.svg}</g>`
    }
    const time = (y: number, t: number): string =>
      `<g ${fade(m, 0, [[t, 1, 200]])}>${monoText(END_X - 33, y + 32, '18:42', { size: 11, cls: 'tm' })}</g>`

    // Oleg: already running a slow loop when the story starts
    {
      const y = ROW0
      const inner =
        stateChip(y, S.running, 'A', 1, null, STOP, spinner('A', STOP)) +
        stateChip(y, S.stopped, 'W', 0, STOP, null, clock) +
        `<g ${fade(m, 1, [[STOP, 0, 100]])}>${monoText(RX + 42, y + 32, oleg.code)}</g>` +
        `<g ${fade(m, 0, [[STOP + 90, 1, 200]])}>${sans(RX + 42, y + 32, esc(S.stoppedNote), 'u tm')}</g>`
      con.push(row(0, oleg, inner, null))
    }
    // rows that enter during the story leave as a whole at the seam
    seamHold = true
    // Anna
    {
      const y = ROW0 + ROW_H
      const inner =
        stateChip(y, S.queued, 'A', 1, null, STOP) +
        stateChip(y, S.running, 'A', 0, STOP, DONE[0], spinner('A', DONE[0], STOP)) +
        stateChip(y, S.done, 'P', 0, DONE[0], null) +
        stateChip(y, S.correct, 'P', 0, MARK[0], null, undefined, true) +
        monoText(RX + 42, y + 32, students[0].code) +
        time(y, SUB[0] + 260)
      con.push(row(1, students[0], inner, RUN[0]))
    }
    // Marat
    {
      const y = ROW0 + 2 * ROW_H
      const inner =
        stateChip(y, S.queued, 'A', 1, null, DONE[0]) +
        stateChip(y, S.running, 'A', 0, DONE[0], DONE[1], spinner('A', DONE[1], DONE[0])) +
        stateChip(y, S.done, 'P', 0, DONE[1], null) +
        stateChip(y, S.revise, 'W', 0, MARK[1], null, undefined, true) +
        monoText(RX + 42, y + 32, students[1].code) +
        `<g ${fade(m, 0, [[DONE[1] + 90, 1, 200]])}>${sans(r5(RX + 42 + monoW('df["score"].mean()', 13, false) + 12), y + 32, esc(S.same), 'u tm')}</g>` +
        time(y, SUB[1] + 260)
      con.push(row(2, students[1], inner, RUN[1], true))
    }
    // Dina
    {
      const y = ROW0 + 3 * ROW_H
      const inner =
        stateChip(y, S.queued, 'A', 1, null, DONE[1]) +
        stateChip(y, S.running, 'A', 0, DONE[1], DONE[2], spinner('A', DONE[2], DONE[1])) +
        stateChip(y, S.error, 'D', 0, DONE[2], null) +
        `<g ${fade(m, 1, [[DONE[2], 0, 100]])}>${monoText(RX + 42, y + 32, students[2].code)}</g>` +
        `<g ${fade(m, 0, [[DONE[2] + 90, 1, 200]])}>${monoText(RX + 42, y + 32, "KeyError: 'scores'", { cls: 'td' })}</g>` +
        time(y, SUB[2] + 260)
      con.push(row(3, students[2], inner, RUN[2]))
    }
    seamHold = false

    push(`<g clip-path="url(#cc)">${con.join('')}</g>`)
    push(`<rect x="${RX + 0.5}" y="${CY + 0.5}" width="${RW - 1}" height="${CH - 1}" rx="8" class="sl" fill="none"/>`)

    // ---- the shown plate under the console (the teacher's own view of the wall)
    {
      const y = CY + CH + 8
      const h = H - 16 - y
      defs.push(`<clipPath id="cp"><rect x="${RX}" y="${y}" width="${RW}" height="${h}" rx="8"/></clipPath>`)
      const c = chip(RX + 14, y + 6, S.onScreen, 'Ps')
      const tint = 42
      const plate =
        `<g clip-path="url(#cp)">` +
        `<rect x="${RX}" y="${y}" width="${RW}" height="${h}" class="bc"/>` +
        `<rect x="${RX}" y="${y}" width="${RW}" height="${tint}" class="xp"/>` +
        `<rect x="${RX}" y="${y + tint}" width="${RW}" height="24" class="bs"/>` +
        `<rect x="${RX}" y="${y + tint + 24}" width="${RW}" height="1" class="bl"/>` +
        `<rect x="${RX}" y="${y}" width="4" height="${h}" class="bP"/></g>` +
        `<rect x="${RX + 0.5}" y="${y + 0.5}" width="${RW - 1}" height="${h - 1}" rx="8" class="sl" fill="none"/>` +
        c.svg +
        `<circle cx="${RX + 14 + c.w + 14}" cy="${y + 15}" r="8" class="br sl"/>` +
        sans(RX + 14 + c.w + 28, y + 19.5, S.answer, 'n') +
        sans(RX + 14, y + 36, esc(S.shownBy), 'u tm') +
        monoText(RX + 16, y + tint + 16.5, shownCode) +
        monoText(RX + 16, y + tint + 24 + 15.5, '0.6412', { cls: 'ti' }) +
        monoText(r5(RX + RW - 14 - monoW(S.runByTeacher, 11, true)), y + tint + 24 + 15, S.runByTeacher, { caps: true, cls: 'tf' })
      push(`<g ${attrs(m, st(0, 'translateY(4px)'), [[SHOW, st(1), 260]], 'p')}>${plate}</g>`)
    }

    // ---- style
    const css = [
      `.s,.u,.h,.n,.av{font-family:${SANS}}`,
      `.C,.L,.c11,.c13{font-family:${MONO}}`,
      `.u{font-size:13px}.n{font-size:13px;font-weight:600;fill:${P.ink}}.h{font-size:15px;font-weight:700;fill:${P.ink}}`,
      `.av{font-size:11px;font-weight:700;fill:${DISC_DARK}}`,
      `.C{font-size:13px;fill:${P.syn.text}}.c11{font-size:11px}.c13{font-size:14px}`,
      `.L{font-size:11px;font-weight:600;text-transform:uppercase}`,
      `.w6{font-weight:600}.w7{font-weight:700}.m{text-anchor:middle}`,
      `.ti{fill:${P.ink}}.tm{fill:${P.muted}}.tf{fill:${P.faint}}.ta{fill:${P.accentText}}`,
      `.tA{fill:${P.accentText}}.tP,.tp,.tp15{fill:${P.positive}}.tW{fill:${P.warning}}.tD,.td{fill:${P.danger}}`,
      `.tS{fill:${P.subText}}.tpi{fill:${P.primaryInk}}`,
      // chip grounds
      `.xA{fill:${P.accent};fill-opacity:.12}.xP{fill:${P.positive};fill-opacity:.12}.xW{fill:${P.warning};fill-opacity:.12}`,
      `.xD{fill:${P.danger};fill-opacity:.1}.xS{fill:${P.subFill};fill-opacity:.1}.xp15{fill:${P.positive};fill-opacity:.15}`,
      `.xp{fill:${P.positive};fill-opacity:.1}`,
      // the solid ON SCREEN chip: bg-positive, text-canvas
      `.xPs{fill:${P.positive}}.tPs{fill:${P.canvas}}`,
      `.bc{fill:${P.canvas}}.bs{fill:${P.surface}}.br{fill:${P.raised}}.bl{fill:${P.line}}.bL{fill:${P.lineSoft}}`,
      `.bpr{fill:${P.primary}}.bP{fill:${P.positive}}.bA{fill:${P.accent}}.fA{fill:${P.accentText}}.fM{fill:${P.faint}}`,
      `.sl{stroke:${P.line}}.oA{stroke:${P.accentText}}.oW{stroke:${P.warning}}`,
      `.ss{fill:${P.syn.str}}.sn{fill:${P.syn.num}}.sk{fill:${P.syn.kw}}.sf{fill:${P.syn.fn}}.st{fill:${P.syn.text}}.sp{fill:${P.syn.punct}}`,
      `.a{animation:${LOOP / 1000}s ${EASE.out} infinite both}`,
      `.p{transform-box:fill-box;transform-origin:center}.sE{animation-timing-function:step-end}`,
      m.css(),
      `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`,
    ].join('')

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" lang="${lang}" role="img" aria-labelledby="council-title council-desc">` +
      `<title id="council-title">${esc(S.title)}</title><desc id="council-desc">${esc(S.desc)}</desc>` +
      `<style>${css}</style><defs>${defs.join('')}${[...CODE.values(), ...CHIPS.values()].map((c) => c.svg).join('')}</defs>` +
      body.join('') +
      `</svg>`
    )
  }
  return council
}

// ====================================================================== lecture

/*
 * Scene "lecture" — A PDF, your pen, every screen — lecture-{light,dark}.svg,
 * 11 s loop.
 *
 * One geometry, two token sets. The lecture console is always drawn with the
 * DARK tokens (the real /pult is forced dark); the slide is always white paper
 * (it is a PDF page); the card and the student's laptop follow the theme.
 */
function lectureArt(): Scene {
  type Theme = 'light' | 'dark'

  /*
   * The slide is the teacher's PDF, not interface: its text is taken from the
   * landing page (site/index.html, the #lekciya section), where the same slide
   * is drawn in Russian. The interface labels come from the locales, the key
   * next to the string.
   *
   * `hand` is the handwritten note: real pen strokes, one per letter. The
   * English "step size" and the Russian "размер шага" are different sets of
   * curves, because the letters differ; `handScale` fits the word into the
   * space to the right of the formula so that it does not run off the edge of
   * the page.
   *
   * `btn` and `tip` are the geometry of the "To the lecture" button and of the
   * hint above it: the Russian label is shorter and the hint text longer, and
   * both boxes are measured by them.
   */
  const TEXT = {
    en: {
      title: 'A PDF, your pen, every screen',
      desc:
        'The teacher underlines η and writes “step size” on the iPad console; the ink and the red laser appear at the same spot on the projector. The page turns to 08 everywhere, and a student reading back on page 05 sees the presenter’s dot move and returns to the presenter’s page in one tap.',
      deck: 'OPTIMIZATION METHODS',
      lectureNo: 'Lecture 04',
      slide07: 'Gradient descent',
      slide08: 'Choosing η',
      tooSmall: 'too small',
      tooLarge: 'too large',
      convex: 'Convex functions',
      toLecture: 'TO LECTURE', // room.ui.725
      readOwn: 'READ ON MY OWN', // room.ui.299
      here: (who: string) => `${who} is here`, // room.extra.300
      reading: ['independent reading'] as readonly string[], // room.ui.727
      readingY: 119.5,
      readingGap: 0,
      tagDy: 0,
      backToPresenter: 'Return to the presenter’s page', // room.ui.724
      console: 'LECTURE CONSOLE · IPAD',
      projector: 'PROJECTOR',
      student: 'STUDENT',
      teacher: 'Alex',
      caps: 0.12,
      btn: { x: 747, w: 104 },
      tip: { x: 651, y: 26, w: 209, h: 22 },
      handScale: 1.15,
      /* "step size", one pen stroke per letter, x-height 8, baseline 0. */
      hand:
        'M5 -6.5C3.5 -8 .5 -7.5 1 -5.5C1.5 -3.8 5.2 -3.6 5 -1.6C4.8 .4 1.3 .6 0 -.8' + // s
        'M8.8 -10.5C8.6 -6.5 8.2 -2.5 8.8 -.8C9.3 .4 11 .2 12 -1M6.8 -7C8.5 -7.2 10.5 -7.3 12 -7.4' + // t
        'M14.5 -3.6C16.8 -3.4 19.6 -4.4 19.2 -6.2C18.8 -8 15 -7.8 14.4 -4.6C13.9 -1.6 15.8 .3 19.8 -1.2' + // e
        'M23 -7.5C23 -3 22.8 1 22.6 4.5M23 -5.8C24.2 -7.8 28.6 -8.2 28.6 -4.2C28.6 -.4 24.6 .4 23 -1.6' + // p
        'M39 -6.5C37.5 -8 34.5 -7.5 35 -5.5C35.5 -3.8 39.2 -3.6 39 -1.6C38.8 .4 35.3 .6 34 -.8' + // s
        'M42.6 -7C42.4 -4.5 42.2 -2 42.8 -.6M42.9 -10.4L43.2 -10.1' + // i
        'M46 -7.2C48 -7.4 50 -7.4 51.8 -7.4L46.2 -.2C48.2 -.4 50.2 -.2 52.4 -.4' + // z
        'M55.1 -3.6C57.4 -3.4 60.2 -4.4 59.8 -6.2C59.4 -8 55.6 -7.8 55 -4.6C54.5 -1.6 56.4 .3 60.4 -1.2', // e
    },
    ru: {
      title: 'PDF, ваше перо, все экраны',
      desc:
        'Преподаватель подчёркивает η и пишет «размер шага» на пульте с iPad; те же чернила и красная указка появляются в том же месте на проекторе. Страница листается до 08 у всех, а студент, отставший на странице 05, видит, где ведущий, и возвращается к его странице одним нажатием.',
      deck: 'МЕТОДЫ ОПТИМИЗАЦИИ',
      lectureNo: 'Лекция 04',
      slide07: 'Градиентный спуск',
      slide08: 'Выбор η',
      tooSmall: 'слишком мал',
      tooLarge: 'слишком велик',
      convex: 'Выпуклые функции',
      toLecture: 'К ЛЕКЦИИ',
      readOwn: 'ЧИТАТЬ САМОМУ',
      here: (who: string) => `${who} здесь`,
      reading: ['самостоятельный', 'просмотр'] as readonly string[],
      readingY: 115,
      readingGap: 11,
      tagDy: -6,
      backToPresenter: 'Вернуться к странице, на которой ведущий',
      console: 'ПУЛЬТ ЛЕКЦИИ · IPAD',
      projector: 'ПРОЕКТОР',
      student: 'СТУДЕНТ',
      teacher: 'Алексей',
      caps: 0.04,
      btn: { x: 769, w: 82 },
      tip: { x: 603, y: 20, w: 257, h: 22 },
      handScale: 1,
      /* "размер шага" with the same pen: a stroke of its own per letter, x-height 8, baseline 0. */
      hand:
        'M.4 -7.5C.4 -3 .2 1 0 4.5M.4 -5.8C1.6 -7.8 6 -8.2 6 -4.2C6 -.4 2 .4 .4 -1.6' + // р
        'M13 -5.4C11.8 -7.6 8 -7.2 7.6 -4.2C7.2 -1.2 10.6 -.2 12.6 -2.4M13.1 -6.4C12.8 -3.8 12.6 -1.6 13.3 -.5' + // а
        'M15 -6.4C16.2 -7.8 19.4 -7.4 19.2 -5.5C19.1 -4.2 17.4 -3.8 16.4 -3.9C17.6 -4 19.6 -3.5 19.5 -1.8C19.4 -.1 16.4 .5 15.1 -1' + // з
        'M21.2 -.6C21.4 -3.4 21.6 -5.8 21.8 -7.4L24.4 -3.4L27 -7.4C27.2 -5.6 27.4 -3 27.5 -.6' + // м
        'M29 -3.6C31.3 -3.4 34.1 -4.4 33.7 -6.2C33.3 -8 29.5 -7.8 28.9 -4.6C28.4 -1.6 30.3 .3 34.3 -1.2' + // е
        'M36.1 -7.5C36.1 -3 35.9 1 35.7 4.5M36.1 -5.8C37.3 -7.8 41.7 -8.2 41.7 -4.2C41.7 -.4 37.7 .4 36.1 -1.6' + // р
        'M47.2 -7.3C46.9 -4.8 46.9 -2.4 47.3 -1M50.8 -7.3C50.5 -4.8 50.5 -2.4 50.9 -1M54.4 -7.3C54.1 -4.6 54.2 -2 54.7 -.8M47.3 -1C49.7 -.3 52.3 -.4 54.7 -.8' + // ш
        'M61.8 -5.4C60.6 -7.6 56.8 -7.2 56.4 -4.2C56 -1.2 59.4 -.2 61.4 -2.4M61.9 -6.4C61.6 -3.8 61.4 -1.6 62.1 -.5' + // а
        'M63.8 -7.3C65.9 -7.6 68 -7.5 69.4 -7.2M64.1 -7.3C63.8 -4.8 63.8 -2.2 64.4 -.7' + // г
        'M76.5 -5.4C75.3 -7.6 71.5 -7.2 71.1 -4.2C70.7 -1.2 74.1 -.2 76.1 -2.4M76.6 -6.4C76.3 -3.8 76.1 -1.6 76.8 -.5', // а
    },
  } as const

  interface Tokens {
    canvas: string
    surface: string
    raised: string
    line: string
    ink: string
    muted: string
    faint: string
    accent: string
    accentText: string
  }

  const LIGHT: Tokens = {
    canvas: '#ffffff',
    surface: '#f3f6fb',
    raised: '#e7eef9',
    line: '#dce3ef',
    ink: '#101a33',
    muted: '#5d6b8a',
    faint: '#7c8699',
    accent: '#0fa0d7',
    accentText: '#0a6e96',
  }

  const DARK: Tokens = {
    canvas: '#060c1c',
    surface: '#0a1330',
    raised: '#0e1b3d',
    line: '#16244b',
    ink: '#e6e7e8',
    muted: '#9ba6be',
    faint: '#5e6b85',
    accent: '#0fa0d7',
    accentText: '#0fa0d7',
  }

  /* The slide is a PDF page: light paper in both files. */
  const PAPER = {
    ink: '#101a33',
    muted: '#5d6b8a',
    faint: '#7c8699',
    line: '#dce3ef',
    label: '#0a6e96',
    red: '#d4162f', // INKS[1] in web/src/components/lecture/pult.ts, the landing's underline
    green: '#0c7a64', // INKS[3], the landing's arrow
    highlight: '#fff0ad', // .lecture-formula > span on the landing
  }

  const LASER = '#ff2b1d' // LASER_RED in web/src/components/lecture/laser.ts
  const MARKER = '#ffd60a80' // the yellow highlighter, MARKERS[0] in pult.ts (#ffd60a8c there)
  const ALEX = '#c273e6' // a participant colour (shared/protocol.ts)
  const TAG_INK = '#06203a'

  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif"
  const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"

  /* ------------------------------------------------------------ contrast */

  function luminance(hex: string): number {
    const v = hex.replace('#', '')
    const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
    const [r, g, b] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  function contrastRatio(a: string, b: string): number {
    const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05]
    return x > y ? x / y : y / x
  }

  /* -------------------------------------------------------------- timing */

  const LOOP = 11_000
  const W = 880
  const H = 300
  const EASE = { out: 'cubic-bezier(.23,1,.32,1)', io: 'cubic-bezier(.77,0,.175,1)' } as const
  type Ease = keyof typeof EASE | 'steps'

  /** Keyframe offset for a moment in the loop. */
  const at = (ms: number): string => `${+((ms / LOOP) * 100).toFixed(2)}%`

  type Frame = [ms: number, decls: string, ease?: Ease]

  /*
   * Every segment eases out unless a frame says otherwise (`*` in the style sets
   * the default); moves on screen say 'io'. The loop is closed explicitly: an
   * omitted 0% or 100% would fall back to the element's base attributes, which
   * are the reduced-motion still, not the loop's start.
   */
  function keyframes(name: string, frames: Frame[]): string {
    const all = [...frames]
    if (all[0][0] !== 0) all.unshift([0, all[0][1]])
    const last = all[all.length - 1]
    if (last[0] !== LOOP) all.push([LOOP, last[1]])
    // Frames with the same values and easing share one selector list.
    const groups = new Map<string, string[]>()
    for (const [ms, decls, ease] of all) {
      const fn = ease === 'steps' ? 'steps(10,end)' : ease === 'io' ? EASE.io : ''
      const block = `${decls}${fn ? `;animation-timing-function:${fn}` : ''}`
      groups.set(block, [...(groups.get(block) ?? []), at(ms)])
    }
    const body = [...groups].map(([block, offsets]) => `${offsets.join(',')}{${block}}`).join('')
    return `@keyframes ${name}{${body}}.${name}{animation-name:${name}}`
  }

  /* ---------------------------------------------------------------- text */

  /* The scene's language. The slide helpers live outside scene(), so the
   * strings and the capitals tracking are set once per scene run. */
  let STR: (typeof TEXT)[Lang] = TEXT.en

  const h = (v: number): number => Math.round(v * 2) / 2
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const len = (s: string): number => [...s].length

  /** Monospace line with a deterministic width: chars × 0.6 × size. */
  function mono(x: number, y: number, text: string, size: number, fill: string, extra = ''): string {
    const tl = +(len(text) * 0.6 * size).toFixed(1)
    // 11px is inherited from the root <svg>.
    const fs = size === 11 ? '' : ` font-size="${size}"`
    return `<text class="m" x="${h(x)}" y="${h(y)}"${fs} fill="${fill}" textLength="${tl}"${extra}>${esc(text)}</text>`
  }

  /** Width of a mono caps label (0.6em advance + the language's tracking). */
  const capWidth = (text: string): number => len(text) * 0.6 * 11 + (len(text) - 1) * STR.caps * 11

  /** The landing .label: mono 11px caps, 600, tracking by language. */
  function cap(x: number, y: number, text: string, fill: string, extra = ''): string {
    return `<text class="m c" x="${h(x)}" y="${h(y)}" fill="${fill}" textLength="${capWidth(text).toFixed(1)}"${extra}>${esc(text)}</text>`
  }

  function sans(x: number, y: number, text: string, size: number, weight: number, fill: string, extra = ''): string {
    return `<text class="s" x="${h(x)}" y="${h(y)}" font-size="${size}"${weight !== 400 ? ` font-weight="${weight}"` : ''} fill="${fill}"${extra}>${esc(text)}</text>`
  }

  /* ---------------------------------------------------------------- icons */

  /* 24-grid glyphs from web/src/components/ui/Icon.svelte. */
  const ICON = {
    pencil: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M14.5 7.5 16.5 9.5"/>',
    marker: '<path d="M5 20h6"/><path d="M8.5 16.5 6 14l9-9 3.5 3.5-9 9-1 1z"/><path d="M14 6.5 17.5 10"/>',
    eraser: '<path d="M8 20H5l-2-2 9-9 6 6-5 5z"/><path d="M12 5l4-2 5 5-3 4"/>',
    laser:
      '<path d="M3.6 17.4c3.2-1.1 5.4-3.6 7.2-6.1"/><circle cx="16.4" cy="7.6" r="2.8" fill="currentColor" stroke="none"/><circle cx="16.4" cy="7.6" r="6.2" opacity=".45"/>',
    board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  }

  function icon(name: keyof typeof ICON, x: number, y: number, size: number, color: string): string {
    const k = size / 24
    return `<g transform="translate(${x} ${y}) scale(${+k.toFixed(4)})" fill="none" stroke="${color}" color="${color}" stroke-width="${+(1.4 / k).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</g>`
  }

  /* ------------------------------------------------------------- the slide */

  /*
   * The landing's "Gradient descent" slide (site/index.html #lekciya), on a
   * 320×180 page. The formula is monospace like .lecture-formula, laid out
   * glyph by glyph (0.55em advance, the landing's −0.05em tracking) so the ink
   * lands on η in every font.
   */
  const SLIDE_W = 320
  const MAIN = 28
  const SUB = 17

  function formula(): { main: string; sub: string; eta: number } {
    const parts: Array<[string, boolean]> = [
      ['w', false], ['t+1', true], [' ', false], ['=', false], [' ', false], ['w', false], ['t', true],
      [' ', false], ['−', false], [' ', false], ['η', false], [' ', false], ['∇', false], ['L', false],
      ['(', false], ['w', false], ['t', true], [')', false],
    ]
    let x = 20
    const main: Array<[string, number]> = []
    const sub: Array<[string, number]> = []
    let eta = 0
    for (const [text, isSub] of parts) {
      const adv = (isSub ? SUB : MAIN) * 0.55
      for (const ch of text) {
        if (ch !== ' ') (isSub ? sub : main).push([ch, h(x)])
        if (ch === 'η') eta = x
        x += adv
      }
    }
    const row = (glyphs: Array<[string, number]>, y: number, size: number): string =>
      `<text class="m" x="${glyphs.map((g) => g[1]).join(' ')}" y="${y}" font-size="${size}" fill="${PAPER.ink}">${esc(glyphs.map((g) => g[0]).join(''))}</text>`
    return { main: row(main, 100, MAIN), sub: row(sub, 106, SUB), eta }
  }

  const F = formula()
  const ETA_X = F.eta // left edge of η's cell
  const ETA_W = MAIN * 0.55

  /* The landing's annotation paths, scaled onto η. */
  const UNDERLINE = `M${h(ETA_X - 4.5)} 107.5Q${h(ETA_X + ETA_W / 2)} 110 ${h(ETA_X + ETA_W + 5)} 107`
  const ARROW = (() => {
    // M274 5C291 12 304 21 316 42M307 38L318 44L318 30, ×0.55, from the underline's end.
    const k = 0.55
    const x0 = h(ETA_X + ETA_W + 12)
    const y0 = 105.5
    const p = (dx: number, dy: number): string => `${h(x0 + dx * k)} ${h(y0 + dy * k)}`
    return { d: `M${x0} ${y0}C${p(17, 7)} ${p(30, 16)} ${p(42, 37)}M${p(33, 33)}L${p(44, 39)}L${p(44, 25)}`, x0, y0 }
  })()

  /*
   * Shared once in <defs>. The ink paths leave stroke-dashoffset unset, so each
   * <use> instance inherits the offset its own class animates.
   */
  function defs(): string {
    const stroke = (id: string, d: string, color: string, width: number, extra = ''): string =>
      `<path id="${id}" d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1 2"${extra}/>`
    return (
      '<defs>' +
      stroke('u', UNDERLINE, PAPER.red, 2.5) +
      stroke('a', ARROW.d, PAPER.green, 2.5) +
      stroke('w', STR.hand, PAPER.green, 1.9, ` transform="translate(${h(ARROW.x0 + 4)} 144) scale(${STR.handScale})"`) +
      `<g id="f7">${sans(20, 54, STR.slide07, 20, 800, PAPER.ink)}` +
      `<rect x="${h(ETA_X - 1)}" y="80" width="${h(ETA_W + 2)}" height="25" fill="${PAPER.highlight}"/>${F.main}${F.sub}</g>` +
      `<g id="pl">${plots08()}</g>` +
      '</defs>'
    )
  }

  const ink = (): string => '<use href="#u" class="iu"/><use href="#a" class="ia"/><use href="#w" class="ih"/>'


  /** Greeked text: a bar where the text would be too small to read (<11px). */
  const bar = (x: number, y: number, w: number, hgt: number, fill: string, op: number): string =>
    `<rect x="${h(x)}" y="${h(y)}" width="${h(w)}" height="${h(hgt)}" rx="1.5" fill="${fill}" opacity="${op}"/>`

  function smallText(x: number, y: number, text: string, fill: string, greek: boolean, capsLabel = false): string {
    const w = capsLabel ? capWidth(text) : len(text) * 6.6
    if (greek) return bar(x, y - 7.5, w, 7, fill, 0.3)
    return capsLabel ? cap(x, y, text, fill) : mono(x, y, text, 11, fill)
  }

  /** Slide chrome shared by 07 and 08: label, title, footer. */
  function chrome(page: number, greek: boolean): string {
    const num = `${String(page).padStart(2, '0')} / 24`
    return (
      smallText(20, 28, STR.deck, PAPER.label, greek, true) +
      smallText(20, 170, STR.lectureNo, PAPER.muted, greek) +
      smallText(SLIDE_W - 20 - len(num) * 6.6, 170, num, PAPER.muted, greek)
    )
  }

  function slide07(greek: boolean, withInk: boolean): string {
    return (
      chrome(7, greek) +
      '<use href="#f7"/>' +
      (withInk ? ink() : '')
    )
  }

  /* Slide 08: the same bowl twice — η too small creeps, η too large bounces. */
  function bowl(cx: number): { curve: string; y: (dx: number) => number } {
    const y = (dx: number): number => 128 - 56 * (dx / 60) ** 2
    return { curve: `M${cx - 60} 72Q${cx} 184 ${cx + 60} 72`, y }
  }

  function steps(cx: number, dxs: number[], color: string): string {
    const b = bowl(cx)
    const pts = dxs.map((dx) => [h(cx + dx), h(b.y(dx))] as const)
    return (
      `<path d="${b.curve}" fill="none" stroke="${PAPER.faint}" stroke-width="1.5"/>` +
      `<path d="M${pts.map((p) => p.join(' ')).join('L')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>` +
      pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.5" fill="${color}"/>`).join('')
    )
  }

  function plots08(): string {
    return steps(84, [-52, -41.6, -33.3, -26.6, -21.3], PAPER.green) + steps(236, [-30, 36, -43.2, 51.8], PAPER.red)
  }

  function slide08(greek: boolean): string {
    return (
      chrome(8, greek) +
      sans(20, 54, STR.slide08, 20, 800, PAPER.ink) +
      '<use href="#pl"/>' +
      smallText(24, 150, STR.tooSmall, PAPER.muted, greek) +
      smallText(176, 150, STR.tooLarge, PAPER.muted, greek)
    )
  }

  /* ------------------------------------------------------------- geometry */

  const CON = { x: 20, y: 36, w: 280, h: 196, rail: 52 }
  const SHEET = { x: 82, y: 75.5, w: 208, s: 208 / SLIDE_W }
  const PRO = { x: 320, y: 44, w: 320, h: 180 }
  const LAP = { x: 660, y: 59, w: 200, h: 140 }
  const SCR = { x: 665, y: 64, w: 190, h: 130 }
  const PAGE = { x: 716, y: 91, w: 135, s: 135 / SLIDE_W }
  const ROW0 = 91 // rail row for page 04
  const ROW = 20
  const rowTop = (page: number): number => ROW0 + (page - 4) * ROW

  /* Laser path in slide coordinates: along the formula, pausing on η. */
  const LZ = [
    [26, 74],
    [ETA_X + ETA_W / 2, 72],
    [290, 74],
  ] as const

  /* ---------------------------------------------------------------- scene */

  function scene(theme: Theme, lang: Lang): string {
    STR = TEXT[lang]
    const T = theme === 'light' ? LIGHT : DARK
    const D = DARK // the console
    const css: string[] = []
    const out: string[] = []

    /* ---------------- motion ---------------- */

    const hide = 'opacity:0'
    const show = 'opacity:1'
    // Ink: drawn at base; hidden from the loop start, drawn on its beat,
    // cleared while page 07 is off screen.
    const draw = (name: string, from: number, dur: number): string =>
      keyframes(name, [
        [0, 'stroke-dashoffset:1.01'],
        [from, 'stroke-dashoffset:1.01', 'out'],
        [from + dur, 'stroke-dashoffset:0'],
        [9000, 'stroke-dashoffset:0'],
        [9020, 'stroke-dashoffset:1.01'],
      ])
    css.push(draw('iu', 500, 600), draw('ia', 1300, 700), draw('ih', 1450, 700))

    // Page 07 → 08 at 4.8 s; back to 07 in the last 400 ms.
    css.push(
      keyframes('c7', [
        [0, `${show};transform:none`],
        [4800, `${show};transform:none`, 'out'],
        [5000, `${hide};transform:translateX(-8px)`],
        [10580, `${hide};transform:translateX(-8px)`],
        [10600, `${hide};transform:none`, 'out'],
        [11000, `${show};transform:none`],
      ]),
      keyframes('c8', [
        [0, `${hide};transform:translateX(8px)`],
        [4800, `${hide};transform:translateX(8px)`, 'out'],
        [5000, `${show};transform:none`],
        [10600, show, 'out'],
        [11000, hide],
      ]),
      keyframes('p7', [
        [0, show],
        [4800, show, 'out'],
        [5000, hide],
        [10600, hide, 'out'],
        [11000, show],
      ]),
      keyframes('p8', [
        [0, hide],
        [4800, hide, 'out'],
        [5000, show],
        [10600, show, 'out'],
        [11000, hide],
      ]),
      keyframes('g7', [
        [0, show],
        [4800, show, 'out'],
        [4960, hide],
        [10600, hide, 'out'],
        [11000, show],
      ]),
      keyframes('g8', [
        [0, hide],
        [4800, hide, 'out'],
        [4960, show],
        [10600, show, 'out'],
        [11000, hide],
      ]),
      keyframes('tb', [
        [0, 'transform:scaleX(1)'],
        [5000, 'transform:scaleX(1)', 'out'],
        [5200, 'transform:scaleX(1.143)'],
        [10600, 'transform:scaleX(1.143)', 'out'],
        [11000, 'transform:scaleX(1)'],
      ]),
      // Stopwatch seconds 14 → 24, one step a second.
      keyframes('tm', [
        [0, 'transform:none', 'steps'],
        [10000, 'transform:translateY(-140px)'],
        [11000, 'transform:translateY(-140px)'],
      ]),
      // Tools: pen → pointer for the laser beat → pen.
      keyframes('tp', [
        [0, show],
        [2450, show, 'out'],
        [2600, hide],
        [4250, hide, 'out'],
        [4400, show],
      ]),
      keyframes('tq', [
        [0, hide],
        [2450, hide, 'out'],
        [2600, show],
        [4250, show, 'out'],
        [4400, hide],
      ]),
      // Pen swatch: red for the underline, green for the arrow.
      keyframes('sr', [
        [0, show],
        [1150, show, 'out'],
        [1300, hide],
        [10600, hide, 'out'],
        [11000, show],
      ]),
      keyframes('sg', [
        [0, hide],
        [1150, hide, 'out'],
        [1300, show],
        [10600, show, 'out'],
        [11000, hide],
      ]),
    )

    // The page turn is a swipe on the rail: the sheet itself takes no gestures
    // (ConsoleView.svelte, "page turning by swipe goes to the rail").
    css.push(
      keyframes('sw', [
        [0, `${hide};transform:none`],
        [4260, `${hide};transform:none`],
        [4380, `${show};transform:none`, 'io'],
        [4800, `${show};transform:translateX(-26px)`],
        [5000, `${hide};transform:translateX(-26px)`],
      ]),
    )

    // The laser: one dot on both screens, same normalized path.
    const laser = (name: string, s: number): string => {
      const d = (i: number): string =>
        `translate(${h((LZ[i][0] - LZ[0][0]) * s)}px,${h((LZ[i][1] - LZ[0][1]) * s)}px)`
      return keyframes(name, [
        [0, `${hide};transform:${d(0)}`],
        [2600, `${hide};transform:${d(0)}`, 'out'],
        [2720, `${show};transform:${d(0)}`, 'io'],
        [3320, `${show};transform:${d(1)}`],
        [3560, `${show};transform:${d(1)}`, 'io'],
        [3980, `${show};transform:${d(2)}`, 'out'],
        [4180, `${hide};transform:${d(2)}`],
      ])
    }
    css.push(laser('lc', SHEET.s), laser('lp', 1))

    // Student.
    css.push(
      keyframes('so', [
        [0, show],
        [6250, show, 'out'],
        [6450, hide],
        [10600, hide, 'out'],
        [11000, show],
      ]),
      keyframes('sf', [
        [0, hide],
        [6250, hide, 'out'],
        [6450, show],
        [10600, show, 'out'],
        [11000, hide],
      ]),
      keyframes('on', [[0, show], [11000, show]]),
      keyframes('off', [[0, hide], [11000, hide]]),
      // The presenter's dot on the rail: 07 → 08 with the page turn.
      keyframes('rd', [
        [0, `${show};transform:none`],
        [5000, `${show};transform:none`, 'io'],
        [5420, `${show};transform:translateY(${ROW}px)`],
        [10600, `${show};transform:translateY(${ROW}px)`, 'out'],
        [10800, `${hide};transform:translateY(${ROW}px)`],
        [10820, `${hide};transform:none`, 'out'],
        [11000, `${show};transform:none`],
      ]),
      keyframes('tg', [
        [0, hide],
        [5000, hide, 'out'],
        [5200, show],
        [6750, show, 'out'],
        [6950, hide],
      ]),
      // "Here": 05 → 08 after the return.
      keyframes('hi', [
        [0, `${show};transform:translateY(${-2 * ROW}px)`],
        [6250, `${show};transform:translateY(${-2 * ROW}px)`, 'io'],
        [6670, `${show};transform:translateY(${ROW}px)`],
        [10600, `${show};transform:translateY(${ROW}px)`, 'out'],
        [10800, `${hide};transform:translateY(${ROW}px)`],
        [10820, `${hide};transform:translateY(${-2 * ROW}px)`, 'out'],
        [11000, `${show};transform:translateY(${-2 * ROW}px)`],
      ]),
      keyframes('cu', [
        [0, `${hide};transform:translate(-36px,72px)`],
        [5400, `${hide};transform:translate(-36px,72px)`, 'out'],
        [5520, `${show};transform:translate(-36px,72px)`, 'io'],
        [5940, `${show};transform:none`],
        [6900, `${show};transform:none`, 'out'],
        [7100, `${hide};transform:none`],
      ]),
      keyframes('tt', [
        [0, `${hide};transform:translateY(4px)`],
        [5960, `${hide};transform:translateY(4px)`, 'out'],
        [6220, `${show};transform:none`],
        [6550, `${show};transform:none`, 'out'],
        [6750, `${hide};transform:none`],
      ]),
      keyframes('bp', [
        [0, 'transform:scale(1)'],
        [6200, 'transform:scale(1)', 'out'],
        [6270, 'transform:scale(.97)', 'out'],
        [6410, 'transform:scale(1)'],
      ]),
    )

    /* ---------------- card ---------------- */

    out.push(`<rect x=".5" y=".5" width="879" height="299" rx="12" fill="${T.surface}" stroke="${T.line}"/>`)

    /* ---------------- console (always dark) ---------------- */

    const C = CON
    out.push(
      `<rect x="${C.x + 0.5}" y="${C.y + 0.5}" width="${C.w - 1}" height="${C.h - 1}" rx="8" fill="${D.canvas}" stroke="${theme === 'light' ? '#0e1b3d' : D.line}"/>`,
      // Rail with the device's left corners.
      `<path d="M${C.x + 8.5} ${C.y + 1}H${C.x + C.rail}V${C.y + C.h - 1}H${C.x + 8.5}A7.5 7.5 0 0 1 ${C.x + 1} ${C.y + C.h - 8.5}V${C.y + 8.5}A7.5 7.5 0 0 1 ${C.x + 8.5} ${C.y + 1}Z" fill="${D.surface}"/>`,
      `<path d="M${C.x + C.rail + 0.5} ${C.y + 1}V${C.y + C.h - 1}" stroke="${D.line}"/>`,
    )
    // Gauge: page, deck, tempo, stopwatch.
    const gx = C.x + 11
    out.push(
      `<g class="g7">${mono(gx - 1, C.y + 28, '07', 22, D.ink)}</g>`,
      `<g class="g8" opacity="0">${mono(gx - 1, C.y + 28, '08', 22, D.ink)}</g>`,
      mono(gx, C.y + 44, '/ 24', 11, D.muted),
      `<rect x="${gx}" y="${C.y + 50}" width="30" height="2" fill="${D.line}"/>`,
      `<rect class="tb fl" x="${gx}" y="${C.y + 50}" width="${h((30 * 7) / 24)}" height="2" fill="${D.muted}"/>`,
      mono(gx, C.y + 66, '32:', 11, D.muted),
      `<clipPath id="lk"><rect x="${gx + 19.5}" y="${C.y + 56}" width="14" height="13"/></clipPath>`,
      `<g clip-path="url(#lk)"><text class="m tm" fill="${D.muted}">${Array.from(
        { length: 11 },
        (_, i) => `<tspan x="${gx + 19.8}" y="${C.y + 66 + i * 14}">${14 + i}</tspan>`,
      ).join('')}</text></g>`,
    )
    // Tool keys: pen, highlighter, eraser, pointer.
    const key = (i: number): number => C.y + 74 + i * 28
    const ix = C.x + C.rail / 2 - 8
    const keys = (color: string): string[] => [
      icon('pencil', ix, key(0) + 3, 16, color),
      icon('marker', ix, key(1) + 3, 16, color),
      icon('eraser', ix, key(2) + 6, 16, color),
      icon('laser', ix, key(3) + 6, 16, color),
    ]
    const [pen, , , ptr] = keys(D.ink)
    const active = (i: number): string =>
      `<rect x="${C.x + 1}" y="${key(i)}" width="${C.rail - 1}" height="28" fill="${D.raised}"/><rect x="${C.x + C.rail - 3}" y="${key(i)}" width="3" height="28" fill="${D.ink}"/>`
    out.push(
      keys(D.muted).join(''),
      `<g class="tp">${active(0)}${pen}</g>`,
      `<g class="tq" opacity="0">${active(3)}${ptr}</g>`,
    )
    out.push(
      `<g class="sw" opacity="0"><circle cx="${C.x + 40}" cy="${key(2)}" r="8" fill="#ffffff" fill-opacity=".22" stroke="#ffffff" stroke-opacity=".5"/></g>`,
    )
    // Swatches sit on white paper, as on the real rail: ink colours are for paper.
    const chip = (i: number): string =>
      `<rect x="${C.x + C.rail / 2 - 8}" y="${key(i) + 21}" width="16" height="4.5" fill="#ffffff"/>`
    out.push(
      chip(0),
      `<rect class="sr" x="${C.x + C.rail / 2 - 6}" y="${key(0) + 22.5}" width="12" height="1.5" rx=".75" fill="${PAPER.red}" opacity="0"/>`,
      `<rect class="sg" x="${C.x + C.rail / 2 - 6}" y="${key(0) + 22.5}" width="12" height="1.5" rx=".75" fill="${PAPER.green}"/>`,
      chip(1),
      `<rect x="${C.x + C.rail / 2 - 6}" y="${key(1) + 21.5}" width="12" height="3.5" rx="1" fill="${MARKER}"/>`,
    )
    // The sheet: paper stays, the page on it turns.
    const sheetT = `translate(${SHEET.x} ${SHEET.y}) scale(${SHEET.s})`
    out.push(
      `<rect x="${SHEET.x}" y="${SHEET.y}" width="${SHEET.w}" height="${h(SHEET.w * (180 / 320))}" fill="#ffffff"/>`,
      `<g class="c7"><g transform="${sheetT}">${slide07(true, true)}</g></g>`,
      `<g class="c8" opacity="0"><g transform="${sheetT}">${slide08(true)}</g></g>`,
    )

    /* ---------------- projector ---------------- */

    const P = PRO
    out.push(
      `<rect x="${P.x + 0.5}" y="${P.y + 0.5}" width="${P.w - 1}" height="${P.h - 1}" rx="8" fill="#ffffff" stroke="${T.line}"/>`,
      `<g class="p7"><g transform="translate(${P.x} ${P.y})">${slide07(false, true)}</g></g>`,
      `<g class="p8" opacity="0"><g transform="translate(${P.x} ${P.y})">${slide08(false)}</g></g>`,
    )

    // Laser dots (after both sheets so they sit above the ink).
    const dot = (cx: number, cy: number, r: number, cls: string): string =>
      `<g class="${cls}" opacity="0"><circle cx="${h(cx)}" cy="${h(cy)}" r="${r * 2.3}" fill="${LASER}" opacity=".3"/><circle cx="${h(cx)}" cy="${h(cy)}" r="${r}" fill="${LASER}"/></g>`
    out.push(
      dot(SHEET.x + LZ[0][0] * SHEET.s, SHEET.y + LZ[0][1] * SHEET.s, 2.5, 'lc'),
      dot(P.x + LZ[0][0], P.y + LZ[0][1], 3.5, 'lp'),
    )

    /* ---------------- student laptop ---------------- */

    const S = SCR
    out.push(
      `<rect x="${LAP.x + 0.5}" y="${LAP.y + 0.5}" width="${LAP.w - 1}" height="${LAP.h - 1}" rx="8" fill="${T.raised}" stroke="${T.line}"/>`,
      `<rect x="${LAP.x - 5.5}" y="${LAP.y + LAP.h + 0.5}" width="${LAP.w + 11}" height="8" rx="3" fill="${T.raised}" stroke="${T.line}"/>`,
      `<rect x="${LAP.x + LAP.w / 2 - 16}" y="${LAP.y + LAP.h + 1}" width="32" height="2" rx="1" fill="${T.line}"/>`,
      `<rect x="${S.x}" y="${S.y}" width="${S.w}" height="${S.h}" fill="${T.canvas}"/>`,
      `<rect x="${S.x}" y="${S.y}" width="${S.w}" height="22" fill="${T.surface}"/>`,
      `<path d="M${S.x} ${S.y + 22.5}H${S.x + S.w}" stroke="${T.line}"/>`,
      `<rect x="${S.x}" y="${S.y + 23}" width="46" height="${S.h - 23}" fill="${T.surface}"/>`,
      `<path d="M${S.x + 46.5} ${S.y + 23}V${S.y + S.h}" stroke="${T.line}"/>`,
    )

    // Toolbar, reading on their own: page counter and "To lecture".
    const btn = { x: STR.btn.x, y: S.y + 2, w: STR.btn.w, h: 18 }
    out.push(
      `<g class="so" opacity="0">${mono(S.x + 6, S.y + 15, '05 / 24', 11, T.muted)}` +
        `<g class="bp fc"><rect x="${btn.x + 0.5}" y="${btn.y + 0.5}" width="${btn.w - 1}" height="${btn.h - 1}" rx="6" fill="${T.canvas}" stroke="${T.line}"/>` +
        icon('board', btn.x + 6, btn.y + 4, 10, T.accentText) +
        cap(btn.x + 20, btn.y + 13, STR.toLecture, T.accentText) +
        `</g></g>`,
    )
    // Toolbar, following: the lecture bar with "Read on my own".
    out.push(
      `<g class="sf">` +
        `<circle cx="${S.x + 8.5}" cy="${S.y + 11}" r="3" fill="${ALEX}"/>` +
        `<g class="off">${mono(S.x + 15, S.y + 15, '07 / 24', 11, T.muted)}</g>` +
        `<g class="on" opacity="0">${mono(S.x + 15, S.y + 15, '08 / 24', 11, T.muted)}</g>` +
        cap(S.x + S.w - 4 - capWidth(STR.readOwn), S.y + 15, STR.readOwn, T.muted) +
        `</g>`,
    )

    // Page rail: 04–08.
    const thumbX = 689
    const rows: string[] = []
    for (let p = 4; p <= 8; p++) {
      const y = rowTop(p)
      rows.push(
        mono(thumbX - 5 - 13.2, y + 10.5, String(p).padStart(2, '0'), 11, T.faint),
        `<rect x="${thumbX + 0.5}" y="${y + 1.5}" width="18" height="10" fill="#ffffff" stroke="${T.line}"/>`,
        `<rect x="${thumbX + 3}" y="${y + 4}" width="8" height="1.5" fill="${PAPER.ink}" opacity=".45"/>`,
        `<rect x="${thumbX + 3}" y="${y + 7.5}" width="${p % 2 ? 12 : 9}" height="1.5" fill="${PAPER.faint}" opacity=".35"/>`,
      )
    }
    const hiY = rowTop(7)
    out.push(
      `<g class="hi"><rect x="${S.x + 1}" y="${hiY - 2.5}" width="44" height="17" rx="3" fill="${T.raised}"/></g>`,
      rows.join(''),
      `<g class="hi"><rect x="${thumbX}" y="${hiY + 1}" width="19" height="11" fill="none" stroke="${T.accent}" stroke-width="1.5"/></g>`,
    )

    // The page itself: paper stays, content crossfades.
    const pageT = `translate(${PAGE.x} ${PAGE.y})`
    const ph = h(PAGE.w * (180 / 320))
    const ps = PAGE.s
    const studentPage = (title: string, body: string): string =>
      `<g transform="${pageT}">` +
      bar(20 * ps, 9, capWidth(STR.deck) * ps, 3, PAPER.label, 0.3) +
      sans(8.5, 24, title, 11, 700, PAPER.ink) +
      `<g transform="scale(${ps})">${body}</g>` +
      bar(20 * ps, 69, 66 * ps, 3, PAPER.muted, 0.3) +
      bar(PAGE.w - 8.5 - 46 * ps, 69, 46 * ps, 3, PAPER.muted, 0.3) +
      `</g>`
    const convex =
      `<path d="M30 80Q110 220 190 80" fill="none" stroke="${PAPER.faint}" stroke-width="2.5"/>` +
      `<path d="M60 122.5L180 96.5" fill="none" stroke="${PAPER.label}" stroke-width="2.5"/>` +
      `<circle cx="60" cy="122.5" r="4" fill="${PAPER.label}"/><circle cx="180" cy="96.5" r="4" fill="${PAPER.label}"/>` +
      bar(214, 86, 84, 7, PAPER.faint, 0.3) +
      bar(214, 102, 66, 7, PAPER.faint, 0.3) +
      bar(214, 118, 76, 7, PAPER.faint, 0.3)
    const formulaBar =
      `<rect x="${h(ETA_X - 1)}" y="80" width="${h(ETA_W + 2)}" height="25" fill="${PAPER.highlight}"/>` +
      bar(20, 86, 277, 10, PAPER.ink, 0.35)
    out.push(
      `<rect x="${PAGE.x + 0.5}" y="${PAGE.y + 0.5}" width="${PAGE.w - 1}" height="${ph - 1}" fill="#ffffff" stroke="${T.line}"/>`,
      `<g class="so" opacity="0">${studentPage(STR.convex, convex)}</g>`,
      `<g class="off">${studentPage(STR.slide07, formulaBar)}</g>`,
      `<g class="sf" opacity="0">${studentPage(STR.slide08, '<use href="#pl"/>')}</g>`,
    )

    // "independent reading" under the page while they read on their own.
    // The Russian label is twice as long as the English one: under the page it
    // needs two lines, they start higher, and the host's tag moves up so that
    // the top line does not land on it.
    {
      const top = S.y + STR.readingY
      out.push(
        `<g class="so" opacity="0"><circle cx="${PAGE.x + 4}" cy="${top - 4}" r="3" fill="${ALEX}"/>` +
          STR.reading.map((r, i) => sans(PAGE.x + 11, top + i * STR.readingGap, r, 11, 400, T.muted)).join('') +
          `</g>`,
      )
    }

    // The presenter's dot and its title.
    const tagText = STR.here(STR.teacher)
    const tagW = h(len(tagText) * 6.6 + 10)
    out.push(
      `<g class="rd">` +
        `<circle cx="${thumbX}" cy="${hiY + 5}" r="3.5" fill="${ALEX}" stroke="${T.surface}" stroke-width="1.5"/>` +
        `<g class="tg" opacity="0"><rect x="${S.x + 48}" y="${hiY - 15 + STR.tagDy}" width="${tagW}" height="18" rx="2" fill="${ALEX}"/>` +
        mono(S.x + 53, hiY - 2 + STR.tagDy, tagText, 11, TAG_INK, ' font-weight="600"') +
        `</g></g>`,
    )

    // Hover tooltip over "To lecture", and the pointer that presses it.
    const tip = { ...STR.tip }
    out.push(
      `<g class="tt" opacity="0"><rect x="${tip.x + 0.5}" y="${tip.y + 0.5}" width="${tip.w - 1}" height="${tip.h - 1}" rx="6" fill="${T.ink}"/>` +
        `<path d="M${btn.x + 44} ${tip.y + tip.h}l6 6 6-6Z" fill="${T.ink}"/>` +
        sans(tip.x + 9, tip.y + 15, STR.backToPresenter, 11, 400, T.canvas) +
        `</g>`,
      `<g class="cu" opacity="0"><path transform="translate(${btn.x + 58} ${btn.y + 8})" d="M0 0V14L3.6 10.6L6.2 16.2L8.6 15.1L6.1 9.6H11Z" fill="${T.ink}" stroke="${T.canvas}" stroke-linejoin="round"/></g>`,
    )

    /* ---------------- labels ---------------- */

    out.push(
      cap(C.x, 258, STR.console, T.accentText),
      cap(P.x, 258, STR.projector, T.accentText),
      cap(LAP.x, 258, STR.student, T.accentText),
    )

    const style =
      `*{animation:${LOOP / 1000}s ${EASE.out} infinite both}` +
      `.m{font-family:${MONO}}.s{font-family:${SANS}}.c{font-size:11px;font-weight:600;letter-spacing:${String(STR.caps).replace(/^0/, '')}em}` +
      `.fl{transform-box:fill-box;transform-origin:0 50%}.fc{transform-box:fill-box;transform-origin:50% 50%}` +
      css.join('') +
      `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-size="11" lang="${lang}" role="img" aria-labelledby="t d">` +
      `<title id="t">${esc(STR.title)}</title><desc id="d">${esc(STR.desc)}</desc>` +
      `<style>${style}</style>` +
      defs() +
      out.join('') +
      `</svg>\n`
    )
  }

  if (contrastRatio(TAG_INK, ALEX) < 4.5) throw new Error('lecture: tag label contrast below 4.5')
  return scene
}

// ====================================================================== oracle

/**
 * Scene "oracle" — An AI the whole class can follow — oracle-{light,dark}.svg,
 * 10 s loop. A proposed edit comes only from the cell's own "Ask the oracle to
 * change this cell" box (settle() in server/src/ai/index.ts makes a patch only
 * for action 'edit'), so Dina asks from cell 04, not from the panel.
 *
 * Story (seen from Dina's own screen, so every beat is something the real UI
 * draws for her):
 *   0.45 s  she types "Average per group" into cell 04's
 *           "Ask the oracle to change this cell" box (CellView asking box)
 *   1.95 s  Enter sends it; the box closes
 *   2.15 s  her turn lands in the room's Oracle thread: REWRITE badge, 04 chip
 *   2.65 s  "thinking" in the thread, "The oracle is looking at this cell" on the cell
 *   3.1-5.3 the answer streams in six chunks, 400 ms apart
 *   5.5 s   the proposal is lifted out of the finished answer into cell 04:
 *           PROPOSED BY THE ORACLE, the diff, Accept / Discard, authorship note
 *   6.6 s   her pointer moves onto Accept (420 ms), press .97
 *   7.2 s   the proposal collapses, the shared cell now holds the groupby line
 *   7.6 s   "Marat is typing a question…" — the room is following the thread
 *   7.9-9.6 hold; 9.6-10 crossfade back to the start frame
 * Static (reduced-motion) frame: question, full answer, proposal with both buttons.
 */
function oracleArt(): Scene {
  type Theme = 'light' | 'dark'

  /* ------------------------------------------------------------------ strings */

  /**
   * The visible strings per language, the locale key next to them. The
   * Oracle's answer is not an interface string but its own text; the Russian
   * version is taken from the landing page (site/index.html, the #konsilium
   * section: "Сейчас получилось одно число для всей таблицы. Сгруппируйте
   * строки по group, а затем посчитайте среднее в каждой группе"), split into
   * the same six pieces that arrive in the stream.
   *
   * `caps` is the capitals tracking: Cyrillic is wider, .12em would not fit
   * into the badges. The widths of the buttons and badges were measured in the
   * browser with the same font stack: the labels "Попросить переписать" and
   * "Отклонить" are longer than the English ones.
   */
  const TEXT = {
    en: {
      title: 'An AI the whole class can follow',
      desc:
        'Dina asks the oracle to rewrite notebook cell 04; her request and the streamed answer appear in the room’s shared Oracle thread, ' +
        'the proposed diff lands in the cell with Accept and Discard, she accepts it into the shared cell, and Marat is already typing the next question.',
      dina: 'Dina',
      marat: 'Marat',
      you: 'you', // room.ui.544
      request: 'Average per group',
      askPlaceholder: 'What should this cell do instead?', // room.ui.373
      askSend: 'Ask for a rewrite', // room.ui.375
      cancel: 'Cancel', // room.ui.376
      askNote: ['The whole room sees the question', 'and the answer.'] as readonly string[], // room.ui.377
      working: 'The oracle is looking at this cell', // room.oracle.working
      proposed: 'Proposed by the oracle', // room.ui.378
      accept: 'Accept', // room.ui.382
      discard: 'Discard', // room.ui.380
      applyNote: ['Applying updates the shared cell', 'and records you as the author.'] as readonly string[], // room.ui.383
      oracle: 'Oracle', // room.ui.488
      shared: 'Shared ·', // room.ui.490
      ask: 'Ask', // room.ui.513
      act: 'Act', // room.ui.514
      // The mode switch: the box, the active badge and the label centers. The
      // right edge is the same in both languages; it grows to the left.
      seg: { x: 764.5, w: 84, pillX: 767, pillW: 39, askX: 786.5, actX: 827 },
      empty: 'No questions yet.', // room.ui.494
      // room.ui.495, laid out over the panel lines
      emptyHint: ['Ask about the class materials.', 'Your name, question and answer will be visible', 'to the whole group.'] as readonly string[],
      rewrite: 'Rewrite', // room.ui.578
      thinking: 'thinking', // room.ui.545
      answer: ['averages the whole column.', 'Group the rows first,', ' then average each group.', 'I’ve proposed an edit', ' to cell 04.'] as readonly string[],
      typingQuestion: (who: string) => `${who} is typing a question…`, // room.ui.519
      footer: 'The whole room sees the question and answer.', // room.ui.517
      caps: 0.12,
      askBtnW: 150,
      acceptW: 70,
      discardW: 72,
      sharedW: 90,
    },
    ru: {
      title: 'ИИ, за которым следит весь класс',
      desc:
        'Дина просит оракула переписать ячейку 04; её вопрос и ответ, приходящий потоком, видит вся комната в общей ленте оракула. ' +
        'Предложенная правка ложится в ячейку с кнопками «Принять» и «Отклонить»; Дина принимает её в общую ячейку, а Марат уже печатает следующий вопрос.',
      dina: 'Дина',
      marat: 'Марат',
      you: 'вы',
      request: 'Среднее по группам',
      askPlaceholder: 'Что должна делать эта ячейка?',
      askSend: 'Попросить переписать',
      cancel: 'Отмена',
      askNote: ['Вопрос и ответ видит', 'вся комната.'] as readonly string[],
      working: 'Оракул смотрит эту ячейку',
      proposed: 'Предложение оракула',
      accept: 'Принять',
      discard: 'Отклонить',
      applyNote: ['Изменение обновит общую ячейку.', 'Автором будете указаны вы.'] as readonly string[],
      oracle: 'Оракул',
      shared: 'общая ·',
      ask: 'Спросить',
      act: 'Сделать',
      seg: { x: 694.5, w: 154, pillX: 697, pillW: 79, askX: 736.5, actX: 811 },
      empty: 'Вопросов пока нет.',
      emptyHint: ['Задайте вопрос по материалам занятия.', 'Ваше имя, вопрос и ответ будут', 'видны всей группе.'] as readonly string[],
      rewrite: 'Переписать',
      thinking: 'думает',
      answer: ['даёт одно число на всю таблицу.', 'Сгруппируйте строки по group,', ' потом среднее в каждой группе.', 'Я предложил правку', ' для ячейки 04.'] as readonly string[],
      typingQuestion: (who: string) => `${who} печатает вопрос…`,
      footer: 'Вопрос и ответ видит вся комната.',
      caps: 0.04,
      askBtnW: 198,
      acceptW: 81,
      discardW: 94,
      sharedW: 77,
    },
  } as const

  /* ------------------------------------------------------------------ tokens */

  const TOKENS = {
    light: {
      card: '#f3f6fb', canvas: '#ffffff', surface: '#f3f6fb', raised: '#e7eef9',
      line: '#dce3ef', lineSoft: '#e9eef7',
      ink: '#101a33', muted: '#5d6b8a', faint: '#7c8699',
      accent: '#0fa0d7', accentText: '#0a6e96',
      positive: '#0c7a64', danger: '#d4162f',
      primary: '#0f2d69', primaryInk: '#ffffff',
      synText: '#101a33', synFn: '#966600', synString: '#00784e', synPunct: '#5d6b8a',
      tintPositive: 'rgba(12,122,100,.1)', tintDanger: 'rgba(212,22,47,.1)',
      tintAccent: 'rgba(15,160,215,.05)',
      pointer: '#101a33', pointerEdge: '#ffffff',
    },
    dark: {
      card: '#0a1330', canvas: '#060c1c', surface: '#0a1330', raised: '#0e1b3d',
      line: '#16244b', lineSoft: '#10193a',
      ink: '#e6e7e8', muted: '#9ba6be', faint: '#5e6b85',
      accent: '#0fa0d7', accentText: '#0fa0d7',
      positive: '#3ec9a7', danger: '#f2495f',
      primary: '#0fa0d7', primaryInk: '#06203a',
      synText: '#d6dce8', synFn: '#ffd746', synString: '#8fd9a8', synPunct: '#9ba6be',
      tintPositive: 'rgba(62,201,167,.12)', tintDanger: 'rgba(242,73,95,.12)',
      tintAccent: 'rgba(15,160,215,.07)',
      pointer: '#e6e7e8', pointerEdge: '#060c1c',
    },
  } as const

  /** shared/protocol.ts PARTICIPANT_COLORS — the same in both themes. */
  const PEOPLE = { dina: '#4aa8f0', marat: '#f2a33c' } as const

  /* ---------------------------------------------- inkOn (web/src/lib/utils.ts) */

  const DISC_DARK = '#0F2246'
  const DISC_LIGHT = '#FFFFFF'
  function channel(v: number): number {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  function luminance(hex: string): number {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return 0
    const n = parseInt(m[1], 16)
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  }
  function contrastRatio(a: string, b: string): number {
    const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05]
    return x > y ? x / y : y / x
  }
  function inkOn(background: string): string {
    return contrastRatio(DISC_DARK, background) >= contrastRatio(DISC_LIGHT, background) ? DISC_DARK : DISC_LIGHT
  }
  for (const color of Object.values(PEOPLE)) {
    if (inkOn(color) !== DISC_DARK) throw new Error(`initials ink on ${color} is not ${DISC_DARK}`)
    if (contrastRatio(DISC_DARK, color) < 4.5) throw new Error(`initials on ${color} under 4.5:1`)
  }

  /* ------------------------------------------------------------------ motion */

  const LOOP = 10_000
  const at = (ms: number): string => `${+((ms / LOOP) * 100).toFixed(2)}%`
  const OUT = 'cubic-bezier(.23,1,.32,1)'
  const INOUT = 'cubic-bezier(.77,0,.175,1)'

  type Ease = 'out' | 'inout' | 'linear'
  /** [ms, declarations, easing of the segment that STARTS here] */
  type Frame = [number, string, Ease?]

  class Motion {
    private css: string[] = []
    private names = new Set<string>()
    private sealed = false

    /** One element's beats; percentages come from at(ms) so every track shares the loop. */
    track(name: string, frames: Frame[], wholeTurns = false): string {
      if (this.sealed) throw new Error(`track ${name} added after the <style> was written`)
      if (this.names.has(name)) throw new Error(`duplicate track ${name}`)
      this.names.add(name)
      const sorted = [...frames].sort((a, b) => a[0] - b[0])
      if (sorted[0][0] !== 0 || sorted[sorted.length - 1][0] !== LOOP) {
        throw new Error(`${name}: frames must start at 0 and end at ${LOOP}`)
      }
      // A spinner ends 12 whole turns from where it started: the same picture.
      if (!wholeTurns && sorted[0][1] !== sorted[sorted.length - 1][1]) {
        throw new Error(`${name}: loop seam — 0% and 100% differ`)
      }
      // Merge keyframes with identical bodies into one selector list.
      const bodies = new Map<string, string[]>()
      for (const [ms, decl, ease] of sorted) {
        const tf = ease === 'inout' ? `;animation-timing-function:${INOUT}` : ease === 'linear' ? ';animation-timing-function:linear' : ''
        const body = `${decl}${tf}`
        const list = bodies.get(body) ?? []
        const pct = at(ms)
        if (list.includes(pct)) throw new Error(`${name}: two frames at ${pct}`)
        list.push(pct)
        bodies.set(body, list)
      }
      const rules = [...bodies].map(([body, pcts]) => `${pcts.join(',')}{${body}}`).join('')
      this.css.push(`@keyframes ${name}{${rules}}.${name}{animation:${name} ${LOOP / 1000}s ${OUT} infinite both}`)
      return name
    }

    /** Fade (and optionally rise) in at `t`, hold, fade out in the reset window. */
    enter(name: string, t: number, dur: number, opts: { rise?: number; out?: [number, number] } = {}): string {
      const hidden = opts.rise ? `opacity:0;transform:translateY(${opts.rise}px)` : 'opacity:0'
      const shown = opts.rise ? 'opacity:1;transform:translateY(0)' : 'opacity:1'
      const [outAt, outDur] = opts.out ?? [9600, 200]
      return this.track(name, [
        [0, hidden],
        [t, hidden],
        [t + dur, shown],
        [outAt, shown],
        [outAt + outDur, hidden],
        [LOOP, hidden],
      ])
    }

    toString(): string {
      this.sealed = true
      return this.css.join('')
    }
  }

  /* ------------------------------------------------------------------ markup */

  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif"
  const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"

  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const r5 = (n: number): number => Math.round(n * 2) / 2
  const num = (n: number): string => `${+n.toFixed(2)}`

  /** Mono advance at a size: chars × 0.6em, so carets and chunks land the same in every font. */
  const monoLen = (chars: number, size = 13): number => chars * 0.6 * size
  /** Capitals tracking: set by the scene's language (see TEXT). */
  let CAPS_TRACK: number = TEXT.en.caps
  /** Caps label: mono 11 with the language's tracking between glyphs. */
  const capsLen = (chars: number): number => chars * 6.6 + (chars - 1) * CAPS_TRACK * 11

  type Tok = [cls: string, text: string]
  function code(x: number, y: number, toks: Tok[], cls = ''): string {
    const chars = toks.reduce((n, [, t]) => n + t.length, 0)
    const spans = toks.map(([c, t]) => `<tspan class="${c}">${esc(t)}</tspan>`).join('')
    return `<text x="${r5(x)}" y="${r5(y)}" class="m c13${cls ? ` ${cls}` : ''}" textLength="${num(monoLen(chars))}" lengthAdjust="spacing">${spans}</text>`
  }
  function caps(x: number, y: number, s: string, cls: string): string {
    return `<text x="${r5(x)}" y="${r5(y)}" class="m cap ${cls}" textLength="${num(capsLen([...s].length))}" lengthAdjust="spacing">${esc(s.toUpperCase())}</text>`
  }
  function mono11(x: number, y: number, s: string, cls: string): string {
    return `<text x="${r5(x)}" y="${r5(y)}" class="m c11 ${cls}" textLength="${num(monoLen([...s].length, 11))}" lengthAdjust="spacing">${esc(s)}</text>`
  }
  function sans(x: number, y: number, s: string, cls: string, anchor?: 'middle'): string {
    return `<text x="${r5(x)}" y="${r5(y)}" class="s ${cls}"${anchor ? ' text-anchor="middle"' : ''}>${esc(s)}</text>`
  }
  /**
   * A sans chunk that continues a line: the earlier words ride along invisibly,
   * so the new words start exactly where the font put the old ones — no
   * measured x anywhere.
   */
  function tail(x: number, y: number, before: string, s: string, cls: string, extra = ''): string {
    return `<text x="${r5(x)}" y="${r5(y)}" class="s ${cls}${extra ? ` ${extra}` : ''}"><tspan visibility="hidden">${esc(before)}</tspan>${esc(s)}</text>`
  }
  function rect(x: number, y: number, w: number, h: number, cls: string, rx = 0, extra = ''): string {
    return `<rect x="${r5(x)}" y="${r5(y)}" width="${r5(w)}" height="${r5(h)}"${rx ? ` rx="${rx}"` : ''} class="${cls}"${extra}/>`
  }
  function hline(x1: number, x2: number, y: number, cls: string): string {
    return `<path d="M${r5(x1)} ${r5(y)}H${r5(x2)}" class="${cls}"/>`
  }
  function avatar(cx: number, cy: number, r: number, color: string, initials: string, ring = false): string {
    return (
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"${ring ? ' class="ring"' : ''}/>` +
      `<text x="${cx}" y="${r5(cy + 4)}" class="s ini" fill="${inkOn(color)}" text-anchor="middle">${initials}</text>`
    )
  }
  /** 12px spinner: a 270° arc turning on its own centre. */
  function spinner(cx: number, cy: number, cls: string, track: string): string {
    const r = 5
    return (
      `<g class="${track} spin"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none"/>` +
      `<path d="M${cx} ${cy - r}A${r} ${r} 0 1 0 ${cx + r} ${cy}" class="${cls}" fill="none" stroke-width="1.5" stroke-linecap="round"/></g>`
    )
  }
  /** Icon from web/src/components/ui/Icon.svelte (24 grid) at `size` px. */
  function icon(x: number, y: number, size: number, body: string, cls: string): string {
    const k = size / 24
    return `<g transform="translate(${x} ${y}) scale(${num(k)})" class="${cls}" fill="none" stroke-width="${num(1.25 / k)}" stroke-linecap="round" stroke-linejoin="round">${body}</g>`
  }
  const SPARKLES =
    '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'
  const USERS =
    '<path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.5a4 4 0 0 0-3-3.87"/><path d="M15.5 4.13a3.5 3.5 0 0 1 0 6.74"/>'

  /* ------------------------------------------------------------------- scene */

  const W = 880
  const H = 300

  // Beats (ms). Everything below reads from these.
  const B = {
    typeAt: 450, perChar: 88,
    send: 1950,
    turn: 2150,
    think: 2650,
    chunk0: 3100, chunkGap: 400, chunkDur: 160,
    lift: 5500, block: 5800,
    pointerIn: 6200, move: 6600, press: 7020,
    collapse: 7200,
    pointerOut: 7700,
    marat: 7600,
    reset: 9600,
  }

  const OLD_SRC: Tok[] = [['sx', 'df'], ['sp', '['], ['ss', '"score"'], ['sp', '].'], ['sn', 'mean'], ['sp', '()']]
  const NEW_SRC: Tok[] = [
    ['sx', 'df'], ['sp', '.'], ['sn', 'groupby'], ['sp', '('], ['ss', '"group"'], ['sp', ')['],
    ['ss', '"score"'], ['sp', '].'], ['sn', 'mean'], ['sp', '()'],
  ]
  function oracleScene(theme: Theme, lang: Lang): string {
    const t = TOKENS[theme]
    const S = TEXT[lang]
    CAPS_TRACK = S.caps
    const REQUEST = S.request
    const m = new Motion()

    /* ---------- left: notebook cell 04 */
    const LX = 16.5, LY = 16.5, LW = 395, LH = 267
    const CODE_X = 68

    // Output line: static frame sits under the proposal (baseline 251).
    const OUT_Y = 251
    const outA = 215 - OUT_Y   // under the asking box
    const outB = 83 - OUT_Y    // right under the source
    const output = m.track('res', [
      [0, `opacity:1;transform:translateY(${outA}px)`],
      [B.send, `opacity:1;transform:translateY(${outA}px)`, 'inout'],
      [B.send + 420, `opacity:1;transform:translateY(${outB}px)`],
      [B.lift, `opacity:1;transform:translateY(${outB}px)`, 'inout'],
      [B.lift + 420, 'opacity:1;transform:translateY(0)'],
      [B.collapse + 50, 'opacity:1;transform:translateY(0)', 'inout'],
      [B.collapse + 470, `opacity:1;transform:translateY(${outB}px)`],
      [B.reset, `opacity:1;transform:translateY(${outB}px)`],
      [B.reset + 120, `opacity:0;transform:translateY(${outB}px)`],
      [B.reset + 121, `opacity:0;transform:translateY(${outA}px)`],
      [B.reset + 200, `opacity:0;transform:translateY(${outA}px)`],
      [LOOP, `opacity:1;transform:translateY(${outA}px)`],
    ])

    // Source swap: the shared cell takes the accepted text.
    const oldSrc = m.track('src0', [
      [0, 'opacity:1'], [B.collapse, 'opacity:1'], [B.collapse + 120, 'opacity:0'],
      [B.reset + 180, 'opacity:0'], [LOOP, 'opacity:1'],
    ])
    const newSrc = m.track('src1', [
      [0, 'opacity:0'], [B.collapse + 120, 'opacity:0'], [B.collapse + 280, 'opacity:1'],
      [B.reset, 'opacity:1'], [B.reset + 160, 'opacity:0'], [LOOP, 'opacity:0'],
    ])

    // Asking box: visible in the start frame, closes on send.
    const ask = m.track('ask', [
      [0, 'opacity:1;transform:scaleY(1)'],
      [B.send, 'opacity:1;transform:scaleY(1)'],
      [B.send + 200, 'opacity:0;transform:scaleY(.94)'],
      [B.reset + 120, 'opacity:0;transform:scaleY(1)'],
      [LOOP, 'opacity:1;transform:scaleY(1)'],
    ])
    const placeholder = m.track('ph', [
      [0, 'opacity:1'], [B.typeAt, 'opacity:1'], [B.typeAt + 40, 'opacity:0'],
      [B.send + 200, 'opacity:0'], [B.send + 201, 'opacity:1'], [LOOP, 'opacity:1'],
    ])
    const typed: string[] = []
    {
      /*
       * The typing pace is not a constant but a consequence of the length of
       * the request: the last letter must land 92 ms before Enter, otherwise it
       * would blink in an already closing field. For the English string the
       * formula gives exactly the former 88 ms.
       */
      const chars = [...REQUEST]
      const perChar = Math.min(B.perChar, Math.floor((B.send - 92 - B.typeAt) / (chars.length - 1)))
      let k = 0
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i]
        if (ch === ' ') continue
        const when = B.typeAt + i * perChar
        const name = m.track(`k${k++}`, [
          [0, 'opacity:0'], [when, 'opacity:0'], [when + 40, 'opacity:1'],
          [B.send + 200, 'opacity:1'], [B.send + 201, 'opacity:0'], [LOOP, 'opacity:0'],
        ])
        typed.push(tail(84, 98, chars.slice(0, i).join(''), ch, 'c13 ink', name))
      }
    }

    // "The oracle is looking at this cell" — the cell's own status row while the oracle works.
    const status = m.track('st', [
      [0, 'opacity:0'], [B.think, 'opacity:0'], [B.think + 200, 'opacity:1'],
      [B.lift, 'opacity:1'], [B.lift + 160, 'opacity:0'], [LOOP, 'opacity:0'],
    ])

    // Proposal block.
    const block = m.track('blk', [
      [0, 'opacity:0;transform:translateY(4px) scaleY(1)'],
      [B.block, 'opacity:0;transform:translateY(4px) scaleY(1)'],
      [B.block + 260, 'opacity:1;transform:translateY(0) scaleY(1)'],
      [B.collapse, 'opacity:1;transform:translateY(0) scaleY(1)'],
      [B.collapse + 200, 'opacity:0;transform:translateY(0) scaleY(.94)'],
      [B.collapse + 201, 'opacity:0;transform:translateY(4px) scaleY(1)'],
      [LOOP, 'opacity:0;transform:translateY(4px) scaleY(1)'],
    ])
    const accept = m.track('acc', [
      [0, 'transform:scale(1)'], [B.press, 'transform:scale(1)'], [B.press + 70, 'transform:scale(.97)'],
      [B.press + 140, 'transform:scale(1)'], [LOOP, 'transform:scale(1)'],
    ])

    // Dina's own pointer (this is her screen): rest → Accept → press → away.
    const TIP = { x: 118, y: 172 }
    const REST = { x: 330, y: 256 }
    const dx = REST.x - TIP.x, dy = REST.y - TIP.y
    const pointer = m.track('cur', [
      [0, `opacity:0;transform:translate(${dx}px,${dy}px)`],
      [B.pointerIn, `opacity:0;transform:translate(${dx}px,${dy}px)`],
      [B.pointerIn + 200, `opacity:1;transform:translate(${dx}px,${dy}px)`],
      [B.move, `opacity:1;transform:translate(${dx}px,${dy}px)`, 'inout'],
      [B.move + 420, 'opacity:1;transform:translate(0,0)'],
      [B.pointerOut, 'opacity:1;transform:translate(0,0)'],
      [B.pointerOut + 200, 'opacity:0;transform:translate(0,0)'],
      [B.pointerOut + 201, `opacity:0;transform:translate(${dx}px,${dy}px)`],
      [LOOP, `opacity:0;transform:translate(${dx}px,${dy}px)`],
    ])

    /* ---------- right: the room's Oracle panel */
    const RX = 424.5, RW = 439
    const TX = 441 // thread text column

    const empty = m.track('emp', [
      [0, 'opacity:1'], [B.turn - 150, 'opacity:1'], [B.turn + 10, 'opacity:0'],
      [B.reset + 200, 'opacity:0'], [LOOP, 'opacity:1'],
    ])
    const count0 = m.track('n0', [
      [0, 'opacity:1'], [B.turn, 'opacity:1'], [B.turn + 120, 'opacity:0'],
      [B.reset + 200, 'opacity:0'], [LOOP, 'opacity:1'],
    ])
    const count1 = m.track('n1', [
      [0, 'opacity:0'], [B.turn, 'opacity:0'], [B.turn + 120, 'opacity:1'],
      [B.reset, 'opacity:1'], [B.reset + 200, 'opacity:0'], [LOOP, 'opacity:0'],
    ])
    const turn = m.enter('turn', B.turn, 260, { rise: 4 })
    // The turn grows once the oracle starts on it: the asker's colour and the rule under it follow.
    const grow = m.enter('grow', B.think, 200)
    const thinking = m.track('thk', [
      [0, 'opacity:0'], [B.think, 'opacity:0'], [B.think + 200, 'opacity:1'],
      [B.chunk0, 'opacity:1'], [B.chunk0 + 120, 'opacity:0'], [LOOP, 'opacity:0'],
    ])
    const chunk = (i: number): string => m.enter(`a${i}`, B.chunk0 + i * B.chunkGap, B.chunkDur)
    const marat = m.enter('mar', B.marat, 260, { rise: 4 })
    // Spinners turn for the whole loop (12 turns in 10 s), hidden by their row.
    const spinA = m.track('sa', [[0, 'transform:rotate(0deg)', 'linear'], [LOOP, 'transform:rotate(-4320deg)']], true)
    const spinB = m.track('sb', [[0, 'transform:rotate(0deg)', 'linear'], [LOOP, 'transform:rotate(-4320deg)']], true)

    const ANSWER_Y = [149.5, 169.5, 189.5]

    const left = [
      rect(LX, LY, LW, LH, 'pan', 8),
      // Gutter: the selected ordinal and its run mark.
      rect(21.5, 35.5, 28, 20, 'inkb', 3),
      sans(35.5, 51, '04', 't15 cvt', 'middle'),
      mono11(24.5, 72, '[3]', 'mu'),
      // Source.
      rect(56.5, 30.5, 343, 30, 'sfb', 6),
      `<g class="${oldSrc}">${code(CODE_X, 50, OLD_SRC)}</g>`,
      `<g class="${newSrc}" opacity="0">${code(CODE_X, 50, NEW_SRC)}</g>`,

      // Asking box (start frame only).
      `<g class="${ask}" opacity="0">`,
      rect(56, 68, 4, 124, 'inkb'),
      rect(60, 68, 340, 124, 'su'),
      rect(72.5, 78.5, 315, 30, 'fld', 4),
      `<g class="${placeholder}">${sans(84, 98, S.askPlaceholder, 'c13 mu')}</g>`,
      ...typed,
      // The buttons are measured by their own label: "Попросить переписать" is
      // longer than the English one, "Отмена" sits the same 38 px to the right
      // of the button edge.
      rect(72.5, 118.5, S.askBtnW, 28, 'pr', 6),
      sans(72.5 + S.askBtnW / 2, 137, S.askSend, 'c13 w6 pi', 'middle'),
      sans(72.5 + S.askBtnW + 38, 137, S.cancel, 'c13 w6 mu', 'middle'),
      ...S.askNote.map((line, i) => sans(72, 166 + i * 18, line, 'c13 mu')),
      `</g>`,

      // Status row while the oracle works on this cell.
      `<g class="${status}" opacity="0">`,
      spinner(78, 107.5, 'sat', spinB),
      caps(92, 112, S.working, 'at'),
      `</g>`,

      // Proposal (static frame shows it open).
      `<g class="${block}">`,
      rect(56, 68, 4, 160, 'acb'),
      rect(60, 68, 340, 160, 'ta'),
      caps(72, 86, S.proposed, 'at'),
      mono11(258, 86, '+1', 'po'),
      mono11(277.5, 86, '−1', 'da'),
      rect(60, 96, 340, 22, 'td'),
      rect(60, 118, 340, 22, 'tp'),
      sans(82, 111.5, '−', 'c13 fa', 'middle'),
      sans(82, 133.5, '+', 'c13 fa', 'middle'),
      code(92, 111.5, OLD_SRC),
      code(92, 133.5, NEW_SRC),
      hline(60, 400, 146.5, 'lns'),
      `<g class="${accept}">`,
      rect(72.5, 154.5, S.acceptW, 28, 'pr', 6),
      sans(72.5 + S.acceptW / 2, 173, S.accept, 'c13 w6 pi', 'middle'),
      `</g>`,
      rect(80.5 + S.acceptW, 154.5, S.discardW, 28, 'ol', 6),
      sans(80.5 + S.acceptW + S.discardW / 2, 173, S.discard, 'c13 w6 ink', 'middle'),
      ...S.applyNote.map((line, i) => sans(72, 204 + i * 18, line, 'c13 mu')),
      `</g>`,

      // Output of the last run — accepting rewrites the source, it does not run it.
      `<g class="${output}">${code(CODE_X, OUT_Y, [['sx', '0.6412']])}</g>`,
    ]

    /*
     * Widths that depend on the label rather than on the language in general:
     * the "общая ·" badge with a number after it and the request kind badge.
     * The right edge of both stays where it is in the English scene: fixed
     * elements neighbour them.
     */
    const countX = r5(524 + capsLen([...S.shared].length)) + 10
    const badgeW = r5(capsLen([...S.rewrite].length) + 12)
    const badgeX = 769.5 - badgeW
    const initials = (n: string): string => [...n].slice(0, 2).join('').toUpperCase()

    const right = [
      rect(RX, LY, RW, LH, 'pan', 8),
      // Header.
      icon(440, 29.5, 14, SPARKLES, 'ist'),
      caps(462, 40.5, S.oracle, 'ink'),
      // The "общая · N" badge is measured by its label: the Russian one is shorter than the English one.
      rect(518.5, 27.5, S.sharedW, 18, 'rs', 3),
      caps(524, 40.5, S.shared, 'ink'),
      `<g class="${count0}" opacity="0">${mono11(countX, 40.5, '0', 'ink w6')}</g>`,
      `<g class="${count1}">${mono11(countX, 40.5, '1', 'ink w6')}</g>`,
      rect(S.seg.x, 24.5, S.seg.w, 24, 'seg', 6),
      rect(S.seg.pillX, 27, S.seg.pillW, 19, 'pr', 4),
      sans(S.seg.askX, 41, S.ask, 'c13 w6 pi', 'middle'),
      sans(S.seg.actX, 41, S.act, 'c13 w6 mu', 'middle'),
      hline(425, 863, 56.5, 'ln'),

      // Empty thread (start frame only).
      `<g class="${empty}" opacity="0">`,
      sans(TX, 84, S.empty, 't15 ink'),
      ...S.emptyHint.map((line, i) => sans(TX, 108 + i * 18, line, 'c13 mu')),
      `</g>`,

      // Dina's turn.
      `<g class="${turn}">`,
      rect(425, 57, 2, 80, '', 0, ` fill="${PEOPLE.dina}"`),
      avatar(453, 80, 12, PEOPLE.dina, initials(S.dina)),
      `<text x="473" y="84.5" class="s c13"><tspan class="w6 ink">${esc(S.dina)}</tspan><tspan dx="6" class="fa">${esc(S.you)}</tspan></text>`,
      rect(badgeX, 71.5, badgeW, 18, 'rs', 3),
      caps(badgeX + 6, 84.5, S.rewrite, 'mu'),
      rect(777.5, 71.5, 26, 18, 'ol', 3),
      mono11(784, 84.5, '04', 'mu'),
      mono11(815, 84.5, '10:42', 'fa'),
      rect(TX, 98, 407, 28, 'rs', 3),
      sans(451, 116.5, REQUEST, 'c13 w6 ink'),
      `</g>`,
      `<g class="${grow}">`,
      rect(425, 137, 2, 68, '', 0, ` fill="${PEOPLE.dina}"`),
      hline(425, 863, 205.5, 'lns'),
      `</g>`,

      // Thinking, then the answer in six chunks.
      `<g class="${thinking}" opacity="0">`,
      spinner(447, 145, 'smu', spinA),
      sans(459, 149.5, S.thinking, 'c13 mu'),
      `</g>`,
      `<g class="${chunk(0)}">`,
      rect(TX, 136.5, 146.5, 18, 'rs', 3),
      code(444, ANSWER_Y[0], OLD_SRC),
      `</g>`,
      `<g class="${chunk(1)}">${sans(591, ANSWER_Y[0], S.answer[0], 'c13 ink')}</g>`,
      `<g class="${chunk(2)}">${sans(TX, ANSWER_Y[1], S.answer[1], 'c13 ink')}</g>`,
      `<g class="${chunk(3)}">${tail(TX, ANSWER_Y[1], S.answer[1], S.answer[2], 'c13 ink')}</g>`,
      `<g class="${chunk(4)}">${sans(TX, ANSWER_Y[2], S.answer[3], 'c13 ink')}</g>`,
      `<g class="${chunk(5)}">${tail(TX, ANSWER_Y[2], S.answer[3], S.answer[4], 'c13 ink')}</g>`,

      // Somebody else is following the same thread.
      `<g class="${marat}">`,
      avatar(451, 224, 10, PEOPLE.marat, initials(S.marat), true),
      sans(469, 228.5, S.typingQuestion(S.marat), 'c13 it mu'),
      `</g>`,

      // Footer.
      hline(425, 863, 251.5, 'ln'),
      icon(440, 261, 13, USERS, 'imu'),
      sans(460, 272, S.footer, 'c13 mu'),
    ]

    const css =
      `text{white-space:pre}` +
      `.s{font-family:${SANS}}.m{font-family:${MONO}}` +
      `.c13{font-size:13px}.c11{font-size:11px}.w6{font-weight:600}.w7{font-weight:700}` +
      `.cap{font-size:11px;font-weight:600}` +
      `.ini{font-size:11px;font-weight:700}.it{font-style:italic}.t15{font-size:15px;font-weight:700}` +
      `.card{fill:${t.card};stroke:${t.line}}.pan{fill:${t.canvas};stroke:${t.line}}` +
      `.su{fill:${t.surface}}.sfb{fill:${t.surface};stroke:${t.lineSoft}}.seg{fill:${t.canvas};stroke:${t.line}}.rs{fill:${t.raised}}` +
      `.ln{stroke:${t.line};fill:none}.lns{stroke:${t.lineSoft};fill:none}` +
      `.ink{fill:${t.ink}}.mu{fill:${t.muted}}.fa{fill:${t.faint}}.at{fill:${t.accentText}}` +
      `.po{fill:${t.positive}}.da{fill:${t.danger}}.pr{fill:${t.primary}}.pi{fill:${t.primaryInk}}` +
      `.acb{fill:${t.accent}}.inkb{fill:${t.ink}}.cvt{fill:${t.canvas}}` +
      `.tp{fill:${t.tintPositive}}.td{fill:${t.tintDanger}}.ta{fill:${t.tintAccent}}` +
      `.sx{fill:${t.synText}}.sp{fill:${t.synPunct}}.ss{fill:${t.synString}}.sn{fill:${t.synFn}}` +
      `.ist{stroke:${t.accentText}}.imu{stroke:${t.muted}}.sat{stroke:${t.accentText}}.smu{stroke:${t.muted}}` +
      `.ring{stroke:${t.canvas};stroke-width:2}` +
      `.fld{fill:${t.canvas};stroke:${t.accent}}.ol{fill:none;stroke:${t.line}}` +
      `.ptr{fill:${t.pointer};stroke:${t.pointerEdge};stroke-width:1.2;stroke-linejoin:round}` +
      `.spin,.acc,.blk,.ask{transform-box:fill-box}.spin,.acc{transform-origin:center}.blk,.ask{transform-origin:50% 0}` +
      m.toString() +
      `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`

    const ptr = `<g transform="translate(${TIP.x} ${TIP.y})"><g class="${pointer}" opacity="0"><path d="M0 0V15.5L4 11.8 6.6 17.6 9.1 16.5 6.6 10.9H12Z" class="ptr"/></g></g>`

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" lang="${lang}" role="img" aria-labelledby="oracle-title oracle-desc">` +
      `<title id="oracle-title">${S.title}</title><desc id="oracle-desc">${esc(S.desc)}</desc>` +
      `<style>${css}</style>` +
      rect(0.5, 0.5, W - 1, H - 1, 'card', 12) +
      left.join('') +
      right.join('') +
      ptr +
      `</svg>\n`
    )
  }
  return oracleScene
}

// ====================================================================== competitions

/*
 * Competitions scene: "A notebook in, a place on the board" —
 * competitions-{light,dark}.svg, 13 s loop, one geometry with swapped tokens.
 *
 * Anna sends lgbm_v4.ipynb. In "My submissions" (SubmissionRow.svelte, the
 * desktop row) it waits first in the queue, then runs under the stage strip
 * (StageStrip.svelte: all six stages of SUBMISSION_STAGES, the packages one
 * included, which a competition without a set passes at once) while the
 * stopwatch and "Cell N of 14" tick, and is scored. Under the "best" rule the
 * counted mark and "best result" move from her older submission to the new
 * one (countedSubmission, rowWords). On the public leaderboard (BoardView.svelte,
 * the desktop table: place, participant, public MAPE, submissions) her row
 * takes the new score and climbs from 5th place to 2nd.
 *
 * Departures, on purpose: the stopwatch runs about seven times faster than
 * real time; the place numbers stay in their column while the rows move past
 * them (each end of the move is the real table); the environment line under
 * the file name (SubmissionEnvironment.svelte) is left out to fit the height.
 */
function competitionsArt(): Scene {
  // ---------------------------------------------------------------- strings ----

  /**
   * The visible strings per language, the locale key next to them. File names,
   * scores and people's names are data, not interface: they are the same
   * notebook in both languages.
   *
   * `nameW` is the width of Anna's name in the table (sans 700 13px, measured
   * in the browser): the YOU chip stands after it. `countedW` is the width of
   * the "counted" label (sans 700 12px), which sizes its chip.
   */
  const TEXT = {
    en: {
      title: 'Competitions: a notebook in, a place on the board',
      desc:
        'Anna sends lgbm_v4.ipynb. In My submissions it waits first in the queue, runs through the stages (accepted, queue, packages, notebook, CSV check, scoring) and scores 0.1412 MAPE, her best, so it becomes the submission that counts; on the public leaderboard her row climbs from 5th place to 2nd.',
      mine: 'My submissions', // competitions.p.mine
      board: 'Leaderboard', // competitions.p.tabLeaderboard
      ordinals: ['3rd', '4th'], // submissionOrdinal: English suffixes are computed
      queued: 'IN QUEUE', // competitions.entrant.queued
      running: 'RUNNING', // competitions.entrant.running
      scored: 'DONE', // competitions.entrant.scored
      // competitions.stage.accepted / queue, dependencies.installing, competitions.stage.notebook / check / score
      stages: ['ACCEPTED', 'QUEUE', 'INSTALLING PACKAGES', 'RUNNING NOTEBOOK', 'CHECKING CSV', 'SCORING'],
      queueAt: 'First in the queue', // competitions.p.queueAt + competitions.p.ordinal.1
      // competitions.p.cellOf · competitions.p.sentAt · competitions.p.waited (durSeconds)
      cell: (n: number) => `Cell ${n} of 14 · sent at 18:41 · waited 6 s`,
      ofLimit: ' of 10:00', // competitions.p.ofLimit
      cancel: 'Cancel', // competitions.p.cancelRun
      counted: 'counted', // competitions.counted
      countedW: 49.5,
      publicPart: 'public part', // competitions.p.publicPart
      newBest: 'Today at 18:41 · 38 s · best result', // competitions.p.todayAt · durSeconds · best
      oldBest: 'Today at 17:02 · 1 min 12 s · best result', // competitions.p.todayAt · durMinutesSeconds · best
      oldDone: 'Today at 17:02 · finished in 1 min 12 s', // competitions.p.todayAt · doneIn
      // competitions.p.colPlace / colEntrant / colPublicMetric / colSubmissions
      cols: ['PLACE', 'PARTICIPANT', 'PUBLIC MAPE', 'SUBMISSIONS'],
      you: 'YOU', // competitions.p.you
      names: ['Marfa Belova', 'Anna Smirnova', 'Timur Aliev', 'Daniil Orlov', 'Oleg Petrov'],
      nameW: 97.2,
      caps: 0.12,
    },
    ru: {
      title: 'Соревнования: тетрадь на проверку, место в лидерборде',
      desc:
        'Анна отправляет lgbm_v4.ipynb. В «Моих посылках» она ждёт первой в очереди, проходит этапы (принята, очередь, пакеты, запуск тетради, проверка CSV, оценка) и получает 0.1412 по MAPE — свой лучший результат, поэтому посылка идёт в зачёт; в публичном лидерборде строка Анны поднимается с 5-го места на 2-е.',
      mine: 'Мои посылки',
      board: 'Лидерборд',
      ordinals: ['3-я', '4-я'], // competitions.p.ordinalN
      queued: 'В ОЧЕРЕДИ',
      running: 'ВЫПОЛНЯЕТСЯ',
      scored: 'ГОТОВО',
      stages: ['ПРИНЯТА', 'ОЧЕРЕДЬ', 'УСТАНОВКА ПАКЕТОВ', 'ЗАПУСК ТЕТРАДИ', 'ПРОВЕРКА CSV', 'ОЦЕНКА'],
      queueAt: 'Первая в очереди',
      cell: (n: number) => `Ячейка ${n} из 14 · отправлена в 18:41 · ожидание 6 с`,
      ofLimit: ' из 10:00',
      cancel: 'Отменить',
      counted: 'в зачёт',
      countedW: 45.3,
      publicPart: 'публичная часть',
      newBest: 'Сегодня в 18:41 · 38 с · лучший результат',
      oldBest: 'Сегодня в 17:02 · 1 мин 12 с · лучший результат',
      oldDone: 'Сегодня в 17:02 · выполнена за 1 мин 12 с',
      cols: ['МЕСТО', 'УЧАСТНИК', 'ПУБЛИЧНЫЙ MAPE', 'ПОСЫЛОК'],
      you: 'ВЫ',
      names: ['Марфа Белова', 'Анна Смирнова', 'Тимур Алиев', 'Даниил Орлов', 'Олег Петров'],
      nameW: 105.8,
      caps: 0.04,
    },
  } as const

  // ---------------------------------------------------------------- tokens ----

  /*
   * web/src/index.css. The competition pages put `.competition-ui` on their
   * root, which sets both muted and faint to --competition-muted: the strip's
   * stages ahead are that colour too.
   */
  const PALETTE = {
    light: {
      canvas: '#ffffff', raised: '#e7eef9', line: '#dce3ef', ink: '#101a33', muted: '#415069',
      accent: '#0fa0d7', accentText: '#0a6e96', accentInk: '#06203a',
      positive: '#0c7a64', danger: '#d4162f', brand: '#0f2d69', onPositive: '#ffffff',
      // bg-[#F2FAF7] on the counted row; bg-positive/5 under DONE
      countedRow: 'fill:#f2faf7', doneChip: 'fill:#0c7a64;fill-opacity:.05',
    },
    dark: {
      canvas: '#060c1c', raised: '#0e1b3d', line: '#16244b', ink: '#e6e7e8', muted: '#b8c3d6',
      accent: '#0fa0d7', accentText: '#0fa0d7', accentInk: '#06203a',
      positive: '#3ec9a7', danger: '#f2495f', brand: '#0f2d69', onPositive: '#060c1c',
      // dark:bg-positive/10 on the counted row; dark:bg-positive/20 under DONE
      countedRow: 'fill:#3ec9a7;fill-opacity:.1', doneChip: 'fill:#3ec9a7;fill-opacity:.2',
    },
  } as const

  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif"
  const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"

  // web/src/lib/competition-words.ts · AVATAR_TINTS / avatarTint / avatarLetter, ported.
  const AVATAR_TINTS = ['#CFE3F7', '#F7D9E3', '#D8F0E4', '#F2D9B8', '#E3DDF7', '#F7E9C4']
  function avatarTint(name: string): string {
    let hash = 0
    for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 100_000
    return AVATAR_TINTS[hash % AVATAR_TINTS.length]
  }
  const avatarLetter = (name: string): string => [...name.trim()][0].toUpperCase()

  // ---------------------------------------------------------------- motion ----

  const LOOP = 13000
  const SEAM = LOOP - 400 // last 400 ms: back to the start frame
  const DIP = SEAM + 200 // the board's rows are out of sight here and take their start places
  const HOLD = 10500 // a moment inside the resolved hold: the static frame
  const EASE = {
    out: 'cubic-bezier(.23,1,.32,1)',
    io: 'cubic-bezier(.77,0,.175,1)',
    lin: 'linear',
    step: 'step-end',
  } as const
  type Ease = keyof typeof EASE

  const at = (ms: number): string => `${+((ms / LOOP) * 100).toFixed(2)}%`
  const r5 = (n: number): number => Math.round(n * 2) / 2

  type Stop = [ms: number, decl: string, ease?: Ease]
  type Change = [ms: number, decl: string, dur: number, ease?: Ease]

  const IDENTITY = new Set(['', 'none', 'scale(1)', 'translateY(0)', 'translateX(0)'])

  class Motion {
    private bodies = new Map<string, string>()
    private out: string[] = []

    /** Raw stops → class name. Identical keyframes share one rule. */
    stops(stops: Stop[], base: Ease = 'out'): string {
      const groups = new Map<string, string[]>()
      for (let i = 0; i < stops.length; i++) {
        const [ms, decl, ease] = stops[i]
        const next = stops[i + 1]
        if (next && next[0] === ms && !ease) continue
        const key = `${decl}${ease && ease !== base ? `;animation-timing-function:${EASE[ease]}` : ''}`
        const list = groups.get(key) ?? []
        if (!list.includes(at(ms))) list.push(at(ms))
        groups.set(key, list)
      }
      const body = [...groups].map(([key, list]) => `${list.join(',')}{${key}}`).join('')
      let name = this.bodies.get(body)
      if (!name) {
        name = `k${this.bodies.size}`
        this.bodies.set(body, name)
        this.out.push(`@keyframes ${name}{${body}}.${name}{animation-name:${name}}`)
      }
      return `a ${name}`
    }

    /**
     * A value track: start value, then timed changes. At the end the value
     * goes back to the start: over the last 400 ms (`seam`), or, for the
     * board's rows (`dip`), in one step while their group is out of sight.
     */
    track(v0: string, changes: Change[], back: Ease | 'dip' = 'out'): { cls: string; end: string } {
      const stops: Stop[] = [[0, v0]]
      let cur = v0
      let end = v0
      for (const [ms, v, dur, ease = 'out'] of changes) {
        if (ms < 400) throw new Error(`first beat before 0.4 s: ${ms}`)
        if (ms + dur > SEAM) throw new Error(`beat runs into the seam: ${ms}`)
        stops.push([ms, cur, ease])
        stops.push([ms + dur, v])
        cur = v
        if (ms + dur <= HOLD) end = v
      }
      if (cur !== v0) {
        if (back === 'dip') {
          stops.push([DIP, cur, 'step'])
          stops.push([DIP + 10, v0])
        } else {
          stops.push([SEAM, cur, back])
        }
      }
      stops.push([LOOP, v0])
      return { cls: this.stops(stops), end }
    }

    css(): string {
      return this.out.join('')
    }
  }

  const st = (o: number, t = 'none'): string => `opacity:${o};transform:${t}`

  /** Attributes for an element whose opacity (and maybe transform) is animated. */
  function attrs(m: Motion, v0: string, changes: Change[], extraCls = '', back: Ease | 'dip' = 'out'): string {
    const { cls, end } = m.track(v0, changes, back)
    const o = /opacity:([\d.]+)/.exec(end)
    const t = /transform:([^;]+)/.exec(end)
    if (t && !IDENTITY.has(t[1].trim())) throw new Error(`static frame would keep a transform: ${end}`)
    const op = o && o[1] !== '1' ? ` opacity="${o[1]}"` : ''
    return `class="${cls}${extraCls ? ' ' + extraCls : ''}"${op}`
  }

  /**
   * Fade helper: 0/1 visibility changes, 160 ms by default. Inside the new
   * row, which itself fades out at the seam (`seamHold`), children keep their
   * last state and reset on the invisible loop boundary instead of fading.
   */
  let back: Ease | 'dip' = 'out'
  function fade(m: Motion, v0: 0 | 1, changes: [ms: number, v: 0 | 1, dur?: number][], extraCls = ''): string {
    return attrs(m, `opacity:${v0}`, changes.map(([ms, v, dur = 160]) => [ms, `opacity:${v}`, dur, 'out'] as Change), extraCls, back)
  }

  // ------------------------------------------------------------------ text ----

  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  /** Capitals tracking: set by the scene's language (see TEXT). */
  let CAPS_TRACK: number = TEXT.en.caps

  /** Width of a mono run: chars × 0.6 × size, plus the caps tracking. */
  const monoW = (s: string, size: number, caps: boolean): number =>
    [...s].length * 0.6 * size + (caps ? ([...s].length - 1) * CAPS_TRACK * size : 0)

  /** Mono line with an explicit textLength, so every glyph lands on the grid. */
  function monoText(x: number, y: number, s: string, o: { cls?: string; caps?: boolean; size?: number; end?: boolean } = {}): string {
    const size = o.size ?? (o.caps ? 11 : 12)
    const w = monoW(s, size, !!o.caps)
    const base = o.caps ? 'L' : `c${size}`
    const left = o.end ? x - w : x
    return `<text x="${r5(left)}" y="${y}" class="${base}${o.cls ? ' ' + o.cls : ''}" textLength="${+w.toFixed(2)}">${esc(s)}</text>`
  }

  const sans = (x: number, y: number, inner: string, cls = 'u'): string => `<text x="${r5(x)}" y="${y}" class="${cls}">${inner}</text>`

  /**
   * A badge (Badge.svelte): square corners, mono caps. `form` picks the paint:
   * strong (saturated), filled (pale), outline. Defined once, placed with <use>.
   */
  const CHIPS = new Map<string, { id: string; svg: string }>()
  function badge(x: number, y: number, label: string, tone: 'R' | 'Q' | 'D'): string {
    const h = 18
    const w = r5(8 + monoW(label, 11, true) + 8)
    const key = `${label}|${tone}`
    let id = CHIPS.get(key)?.id
    if (!id) {
      id = `h${CHIPS.size}`
      const ground =
        tone === 'Q'
          ? `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" class="oQ" fill="none"/>`
          : `<rect width="${w}" height="${h}" class="x${tone}"/>`
      CHIPS.set(key, { id, svg: `<g id="${id}">${ground}${monoText(8, 12.9, label, { caps: true, cls: `t${tone}` })}</g>` })
    }
    return `<use href="#${id}" x="${x}" y="${y}"/>`
  }

  // ----------------------------------------------------------------- scene ----

  function competitions(theme: Theme, lang: Lang): string {
    const P = PALETTE[theme]
    const S = TEXT[lang]
    CAPS_TRACK = S.caps
    const m = new Motion()
    CHIPS.clear()
    back = 'out'
    const W = 880
    const H = 380

    // Beats (ms)
    const ARRIVE = 700 // the new submission lands on top of the list, first in the queue
    const RUN = 1800 // it starts: RUNNING, the strip at RUNNING NOTEBOOK, cell 1 of 14
    const CELL = 300 // one cell every 300 ms: cell 14 at RUN + 13 × CELL
    const CHECK = 6100
    const SCORE = 6500
    const DONE = 6900 // scored: DONE, 0.1412, counted moves to it
    const BOARD = 7600 // her leaderboard row takes the new score and count
    const MOVE = 8000 // … and climbs from 5th to 2nd

    const defs: string[] = []
    const body: string[] = []
    const push = (s: string): void => void body.push(s)

    const X0 = 20
    const X1 = 860
    const BADGE_X = 68 // after the ordinal column (w-12)
    const DESC_X = 216 // after the badge lane
    const SCORE_R = 742 // right edge of the number column
    const RH = 46 // a row
    const EX = 30 // the bar and the strip under a running row
    const LIST = 40 // under the heading's rule

    // ---- card
    push(`<rect x=".5" y=".5" width="879" height="${H - 1}" rx="12" class="bc sl"/>`)

    // ---- My submissions
    push(sans(X0, 30, esc(S.mine), 'h'))
    push(`<rect x="${X0}" y="38" width="${X1 - X0}" height="2" class="bi"/>`)

    /** The ordinal column: "4-я" over "#37". */
    const ordinal = (y: number, word: string, number: number): string =>
      monoText(X0, y + 19, word, { cls: 'w7 ti' }) + monoText(X0, y + 34, `#${number}`, { size: 11, cls: 'tm' })

    /** The counted chip in the action column: a check and the word, on positive. */
    const countedChip = (y: number): string => {
      const w = r5(9 + 10 + 6 + S.countedW + 9)
      const x = X1 - w
      return (
        `<rect x="${x}" y="${y + 9}" width="${w}" height="24" class="bP"/>` +
        `<path d="M${x + 10} ${y + 21}l2.75 2.75L${x + 18} ${y + 18.25}" fill="none" stroke-width="1.6" class="oO"/>` +
        sans(x + 25, y + 25.5, esc(S.counted), 'u12 w7 tO')
      )
    }

    // the older submission: counted and best until the new one beats it
    {
      const y = LIST + RH
      const g: string[] = []
      g.push(`<rect x="${X0}" y="${y}" width="${X1 - X0}" height="1" ${fade(m, 0, [[ARRIVE, 1, 200]], 'bl')}/>`)
      g.push(`<rect x="${X0}" y="${y + 1}" width="${X1 - X0}" height="${RH - 1}" ${fade(m, 1, [[DONE, 0, 260]], 'xC')}/>`)
      g.push(ordinal(y, S.ordinals[0], 21))
      g.push(badge(BADGE_X, y + 9, S.scored, 'D'))
      g.push(sans(DESC_X, y + 20.5, 'lgbm_v3.ipynb', 'u w7 ti'))
      g.push(`<g ${fade(m, 1, [[DONE, 0, 120]])}>${sans(DESC_X, y + 37, esc(S.oldBest), 'u12 tm')}</g>`)
      g.push(`<g ${fade(m, 0, [[DONE + 100, 1, 200]])}>${sans(DESC_X, y + 37, esc(S.oldDone), 'u12 tm')}</g>`)
      g.push(monoText(SCORE_R, y + 22, '0.1874', { size: 15, cls: 'w7 ti', end: true }))
      g.push(`<g ${fade(m, 1, [[DONE, 0, 160]])}>${sans(SCORE_R, y + 38, esc(S.publicPart), 'u12 tm e')}</g>`)
      g.push(`<g ${fade(m, 1, [[DONE, 0, 160]])}>${countedChip(y)}</g>`)
      g.push(`<rect x="${X0}" y="${y + RH - 1}" width="${X1 - X0}" height="1" class="bl"/>`)
      push(
        `<g ${attrs(m, st(1, `translateY(-${RH}px)`), [
          [ARRIVE, st(1, 'translateY(0)'), 320, 'io'],
          [RUN, st(1, `translateY(${EX}px)`), 280, 'io'],
          [DONE, st(1, 'translateY(0)'), 280, 'io'],
        ], '', 'io')}>${g.join('')}</g>`,
      )
    }

    // the new submission: queued → running → scored; leaves as a whole at the seam
    {
      const y = LIST
      const g: string[] = []
      const seam = back
      back = 'step'
      g.push(`<rect x="${X0}" y="${y}" width="${X1 - X0}" height="${RH}" ${fade(m, 0, [[DONE + 100, 1, 260]], 'xC')}/>`)
      g.push(ordinal(y, S.ordinals[1], 37))
      g.push(`<g ${fade(m, 1, [[RUN, 0, 100]])}>${badge(BADGE_X, y + 9, S.queued, 'Q')}</g>`)
      g.push(`<g ${fade(m, 0, [[RUN + 80, 1, 160], [DONE, 0, 100]])}>${badge(BADGE_X, y + 9, S.running, 'R')}</g>`)
      g.push(`<g ${fade(m, 0, [[DONE + 80, 1, 160]])}>${badge(BADGE_X, y + 9, S.scored, 'D')}</g>`)
      g.push(sans(DESC_X, y + 20.5, 'lgbm_v4.ipynb', 'u w7 ti'))
      g.push(`<g ${fade(m, 1, [[RUN, 0, 100]])}>${sans(DESC_X, y + 37, esc(S.queueAt), 'u12 tm')}</g>`)
      {
        // "Cell N of 14 · …": a column of fourteen captions behind a one-line window, stepping by line
        const LH = 20
        defs.push(`<clipPath id="cl"><rect x="${DESC_X}" y="${y + 24}" width="420" height="18"/></clipPath>`)
        const lines = Array.from({ length: 14 }, (_, i) => sans(DESC_X, y + 37 + i * LH, esc(S.cell(i + 1)), 'u12 tm')).join('')
        const stops: Stop[] = [[0, 'transform:translateY(0)']]
        for (let n = 2; n <= 14; n++) stops.push([RUN + (n - 1) * CELL, `transform:translateY(-${(n - 1) * LH}px)`])
        stops.push([LOOP, `transform:translateY(-${13 * LH}px)`])
        g.push(
          `<g ${fade(m, 0, [[RUN + 80, 1, 160], [DONE, 0, 100]])}><g clip-path="url(#cl)"><g class="${m.stops(stops, 'step')} sE">${lines}</g></g></g>`,
        )
      }
      g.push(`<g ${fade(m, 0, [[DONE + 100, 1, 200]])}>${sans(DESC_X, y + 37, esc(S.newBest), 'u12 tm')}</g>`)

      // the number column: "—" while queued, the stopwatch while running, then the score
      g.push(`<g ${fade(m, 1, [[RUN, 0, 100]])}>${monoText(SCORE_R, y + 21, '—', { cls: 'ti', end: true })}</g>`)
      {
        const full = `00:38${S.ofLimit}`
        const x = SCORE_R - monoW(full, 12, false)
        const pitch = 7.2
        const ticks = 38
        const tick = (k: number): number => Math.round(RUN + (k * (DONE - RUN)) / ticks)
        /** One digit: a column 0…9 behind a one-character window, stepping to `pick(k)` at tick k. */
        const digit = (ch: number, count: number, pick: (k: number) => number): string => {
          const LH = 16
          const id = `d${ch}`
          defs.push(`<clipPath id="${id}"><rect x="${r5(x + ch * pitch)}" y="${y + 9}" width="${pitch}" height="16"/></clipPath>`)
          const stops: Stop[] = [[0, 'transform:translateY(0)']]
          let last = 0
          for (let k = 1; k <= ticks; k++) {
            const v = pick(k)
            if (v !== last) stops.push([tick(k), `transform:translateY(-${v * LH}px)`])
            last = v
          }
          stops.push([LOOP, `transform:translateY(-${last * LH}px)`])
          const col = Array.from({ length: count }, (_, i) => `<text x="${r5(x + ch * pitch)}" y="${y + 21 + i * LH}" class="c12 ti">${i}</text>`).join('')
          return `<g clip-path="url(#${id})"><g class="${m.stops(stops, 'step')} sE">${col}</g></g>`
        }
        g.push(
          `<g ${fade(m, 0, [[RUN + 80, 1, 160], [DONE, 0, 100]])}>` +
            monoText(x, y + 21, '00:', { cls: 'ti' }) +
            digit(3, 4, (k) => Math.floor(k / 10)) +
            digit(4, 10, (k) => k % 10) +
            // SVG collapses the leading space, so the rest starts one character further
            monoText(x + 6 * pitch, y + 21, S.ofLimit.trimStart(), { cls: 'ti' }) +
            `</g>`,
        )
      }
      g.push(`<g ${fade(m, 0, [[DONE + 80, 1, 200]])}>${monoText(SCORE_R, y + 22, '0.1412', { size: 15, cls: 'w7 ti', end: true })}</g>`)
      g.push(`<g ${fade(m, 0, [[DONE + 120, 1, 200]])}>${sans(SCORE_R, y + 38, esc(S.publicPart), 'u12 tm e')}</g>`)

      // the action column: Cancel while it waits or runs, then counted
      g.push(`<g ${fade(m, 1, [[DONE, 0, 100]])}>${sans(X1, y + 21.5, esc(S.cancel), 'u td e')}</g>`)
      g.push(`<g ${fade(m, 0, [[DONE + 100, 1, 220]])}>${countedChip(y)}</g>`)

      // under a running row: the progress bar and the stage strip
      {
        const by = y + RH + 2
        const bar =
          `<rect x="${BADGE_X}" y="${by}" width="${X1 - BADGE_X}" height="4" class="br"/>` +
          `<rect x="${BADGE_X}" y="${by}" width="${X1 - BADGE_X}" height="4" class="bA ${m.stops([
            [0, 'transform:scaleX(.05)'],
            [RUN, 'transform:scaleX(.05)', 'lin'],
            [RUN + 13 * CELL + 200, 'transform:scaleX(.95)'],
            [LOOP, 'transform:scaleX(.95)'],
          ])} pl"/>`
        const sy = by + 20
        const parts: string[] = []
        let sx = BADGE_X
        const fills: [number, string][][] = [
          [],
          [],
          [],
          [[CHECK, P.positive]],
          [[CHECK, P.accentText], [SCORE, P.positive]],
          [[SCORE, P.accentText]],
        ]
        const first = [P.positive, P.positive, P.positive, P.accentText, P.muted, P.muted]
        S.stages.forEach((word, i) => {
          if (i > 0) {
            parts.push(`<rect x="${r5(sx + 8)}" y="${sy - 4}" width="20" height="1" class="bl"/>`)
            sx += 36
          }
          const cls = fills[i].length
            ? ` ${m.track(`fill:${first[i]}`, fills[i].map(([ms, f]) => [ms, `fill:${f}`, 120] as Change), 'step').cls}`
            : ''
          const tone = first[i] === P.positive ? 'tP' : first[i] === P.accentText ? 'tA' : 'tm'
          parts.push(monoText(sx, sy, word, { caps: true, cls: tone + cls }))
          sx += monoW(word, 11, true)
        })
        if (sx > X1) throw new Error(`stage strip runs past the card: ${sx}`)
        g.push(`<g ${fade(m, 0, [[RUN + 120, 1, 200], [DONE, 0, 140]])}>${bar}${parts.join('')}</g>`)
      }
      back = seam
      push(`<g ${attrs(m, st(0, 'translateY(-6px)'), [[ARRIVE, st(1), 320]])}>${g.join('')}</g>`)
    }

    // ---- Leaderboard (the public table)
    const BH = 192
    push(sans(X0, BH, esc(S.board), 'h'))
    const HEAD = BH + 24
    const COL_P = X0 + 60 // the participant column
    push(monoText(X0, HEAD, S.cols[0], { caps: true, cls: 'tm' }))
    push(monoText(COL_P, HEAD, S.cols[1], { caps: true, cls: 'tm' }))
    push(monoText(SCORE_R, HEAD, S.cols[2], { caps: true, cls: 'ti', end: true }))
    push(monoText(X1, HEAD, S.cols[3], { caps: true, cls: 'tm', end: true }))
    push(`<rect x="${X0}" y="${HEAD + 8}" width="${X1 - X0}" height="2" class="bi"/>`)
    const ROWS = HEAD + 10
    const BRH = 28
    for (let i = 1; i <= 5; i++) push(`<rect x="${X0}" y="${ROWS + i * BRH - 1}" width="${X1 - X0}" height="1" class="bl"/>`)

    // final order; Anna (index 1) starts three rows lower, the three she passes one row higher
    const people = [
      { score: '0.1288', count: '7', from: 0 },
      { score: '0.1412', count: '4', from: 3 },
      { score: '0.1430', count: '5', from: -1 },
      { score: '0.1517', count: '9', from: -1 },
      { score: '0.1702', count: '3', from: -1 },
    ]
    const rows: string[] = []
    back = 'dip'
    people.forEach((p, i) => {
      const y = ROWS + i * BRH
      const name = S.names[i]
      const you = i === 1
      const g: string[] = []
      if (you) g.push(`<rect x="${X0}" y="${y}" width="${X1 - X0}" height="${BRH - 1}" class="br"/>`)
      g.push(`<circle cx="${COL_P + 10}" cy="${y + 13.5}" r="10" fill="${avatarTint(name)}"/>`)
      g.push(sans(COL_P + 10, y + 17.5, esc(avatarLetter(name)), 'av m'))
      g.push(sans(COL_P + 28, y + 18, esc(name), 'u w7 ti'))
      if (you) {
        const cx = r5(COL_P + 28 + S.nameW + 10)
        const cw = r5(7 + monoW(S.you, 11, true) + 7)
        g.push(`<rect x="${cx}" y="${y + 5}" width="${cw}" height="17" class="bB"/>` + monoText(cx + 7, y + 17.5, S.you, { caps: true, cls: 'tw' }))
        g.push(`<g ${fade(m, 1, [[BOARD, 0, 140]])}>${monoText(SCORE_R, y + 18.5, '0.1874', { size: 13, cls: 'w7 ti', end: true })}${monoText(X1, y + 18, '3', { cls: 'tm', end: true })}</g>`)
        g.push(`<g ${fade(m, 0, [[BOARD + 120, 1, 220]])}>${monoText(SCORE_R, y + 18.5, p.score, { size: 13, cls: 'w7 ti', end: true })}${monoText(X1, y + 18, p.count, { cls: 'tm', end: true })}</g>`)
      } else {
        g.push(monoText(SCORE_R, y + 18.5, p.score, { size: 13, cls: 'w7 ti', end: true }))
        g.push(monoText(X1, y + 18, p.count, { cls: 'tm', end: true }))
      }
      const inner = g.join('')
      const row = p.from === 0
        ? inner
        : `<g ${attrs(m, st(1, `translateY(${p.from * BRH}px)`), [[MOVE, st(1, 'translateY(0)'), 560, 'io']], '', 'dip')}>${inner}</g>`
      if (you) rows.push(row)
      else rows.unshift(row)
    })
    back = 'out'
    // the board's rows step out of sight for a moment at the seam and come back in their start places
    const dip = m.stops([[0, 'opacity:1'], [SEAM, 'opacity:1'], [DIP, 'opacity:0'], [DIP + 30, 'opacity:0'], [LOOP, 'opacity:1']])
    push(`<g class="${dip}">${rows.join('')}</g>`)
    // the place column stays put: 1…5 down the table whichever row stands there
    for (let i = 0; i < 5; i++) push(monoText(X0, ROWS + i * BRH + 19, String(i + 1), { size: 15, cls: 'w7 ti' }))

    // ---- style
    const css = [
      `.u,.u12,.h,.av{font-family:${SANS}}`,
      `.L,.c11,.c12,.c13,.c15{font-family:${MONO}}`,
      `.u{font-size:13px}.u12{font-size:12px}.h{font-size:15px;font-weight:700;fill:${P.ink}}`,
      `.av{font-size:11px;font-weight:700;fill:#7A4A12}`,
      `.c11{font-size:11px}.c12{font-size:12px}.c13{font-size:13px}.c15{font-size:15px}`,
      `.L{font-size:11px;font-weight:700;text-transform:uppercase}`,
      `.w7{font-weight:700}.m{text-anchor:middle}.e{text-anchor:end}`,
      `.ti{fill:${P.ink}}.tm{fill:${P.muted}}.tA{fill:${P.accentText}}.tP{fill:${P.positive}}.td{fill:${P.danger}}.tw{fill:#ffffff}`,
      // badges: strong running, outline queued, pale done
      `.xR{fill:${P.accent}}.tR{fill:${P.accentInk}}.oQ{stroke:${P.accentText}}.tQ{fill:${P.accentText}}.xD{${P.doneChip}}.tD{fill:${P.positive}}`,
      `.xC{${P.countedRow}}.bP{fill:${P.positive}}.oO{stroke:${P.onPositive}}.tO{fill:${P.onPositive}}`,
      `.bc{fill:${P.canvas}}.br{fill:${P.raised}}.bl{fill:${P.line}}.bi{fill:${P.ink}}.bA{fill:${P.accent}}.bB{fill:${P.brand}}`,
      `.sl{stroke:${P.line}}`,
      `.a{animation:${LOOP / 1000}s ${EASE.out} infinite both}`,
      `.pl{transform-box:fill-box;transform-origin:left}.sE{animation-timing-function:step-end}`,
      m.css(),
      `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`,
    ].join('')

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" lang="${lang}" role="img" aria-labelledby="competitions-title competitions-desc">` +
      `<title id="competitions-title">${esc(S.title)}</title><desc id="competitions-desc">${esc(S.desc)}</desc>` +
      `<style>${css}</style><defs>${defs.join('')}${[...CHIPS.values()].map((c) => c.svg).join('')}</defs>` +
      body.join('') +
      `</svg>`
    )
  }
  return competitions
}

// ====================================================================== contests

/*
 * Contests scene: "A verdict test by test, a place on the board" —
 * contests-{light,dark}.svg, 13 s loop, one geometry with swapped tokens.
 *
 * Anna's first solution to problem C ran out of time on test 9 (#97). Under
 * the editor, in "Submissions for C" (ProblemSubmissions.svelte, the desktop
 * block: the number, VerdictBadge, submissionHead, the clock while the judge
 * has it, usageWords once judged), her new submission #114 lands on top,
 * waits in the queue and is judged test by test, "test N of 22" with the
 * three-colour bar under the row, until it is accepted. Her row of the ICPC
 * board (StandingsTable.svelte, the desktop table; icpcCell in
 * contest-words.ts) follows it: C reads "−1", then "…" over "−1" while queued
 * and "…" over the running test (the viewer's own row only), then "+1" over
 * "1:42"; solved goes 3 → 4 and the penalty 143 → 265 by computeStandings
 * (the minutes to the accepted submission plus 20 for the rejected attempt
 * before it), and the row climbs from 4th place to 2nd. The contest started
 * at 10:00, so the clock 11:42 in the list is 1:42 on the board.
 *
 * Departures, on purpose: the submissions block (the problem's page) and the
 * board (the Leaderboard tab) are two places in the product, drawn here one
 * above the other; the board stops after five rows and leaves out the totals
 * row, the legend and the All / Near me switch; the new row slides in, and
 * the board's row climbs a moment after its numbers change, where the product
 * redraws both at once; the place numbers stay in their column while the rows
 * move past them (each end of the move is the real table); the sizes are the
 * scene's own, both blocks across the card and the type a step smaller. The
 * contest has five problems, so the board shows every column a real one
 * would; a longer contest scrolls sideways there.
 */
function contestsArt(): Scene {
  // ---------------------------------------------------------------- strings ----

  /**
   * The visible strings per language, the locale key next to them. The
   * handles, numbers and times are data, not interface: the same board in
   * both languages, since people join a contest under a Telegram @handle or
   * an email (shared/competitions.ts · entrantHandle).
   *
   * `overLimit` and `usage` are usageWords for the run killed at the 1 s
   * limit and for the accepted one, in the reader's decimal notation.
   */
  const TEXT = {
    en: {
      title: 'Contests: a verdict test by test, a place on the board',
      desc:
        'Anna’s first solution to problem C exceeded the time limit on test 9. Her new submission #114 lands on top of Submissions for C, waits in the queue, is judged test by test, 1 to 22, and is accepted: 0.18 s, 12 MB. On the ICPC board her C cell turns from −1 to +1 at 1:42, solved goes from 3 to 4, the penalty from 143 to 265, and her row climbs from 4th place to 2nd.',
      heading: 'SUBMISSIONS FOR C', // contests.p.problemSubmissions
      all: 'all submissions', // contests.p.allSubmissions
      queued: 'Queued', // contests.p.queued
      running: (n: number) => `Judging · test ${n} of 22`, // contests.p.runningTestOf
      accepted: 'Accepted · 22 tests', // contests.verdict.OK · contests.p.testsCount
      timeLimit: 'Time limit exceeded · test 9', // contests.verdict.TL · contests.p.testN
      overLimit: '> 1 s · 31 MB', // overLimitWords · contests.p.mbUnit
      usage: '0.18 s · 12 MB', // contests.p.secondsUnit · contests.p.mbUnit
      test: (n: number) => `test ${n}`, // contests.p.testN
      // contests.p.colPlace / colEntrant / colSolved / colPenalty
      cols: ['PLACE', 'PARTICIPANT', 'SOLVED', 'PENALTY'],
      you: 'YOU', // contests.p.you
      caps: 0.12,
    },
    ru: {
      title: 'Контесты: вердикт тест за тестом, место в лидерборде',
      desc:
        'Первое решение Анны по задаче C превысило время на тесте 9. Новая посылка #114 встаёт наверх в «Посылках по задаче C», ждёт в очереди, проверяется тест за тестом, с 1-го по 22-й, и принимается: 0,18 с, 12 МБ. В таблице ICPC клетка C у Анны меняется с −1 на +1 (1:42), решённых становится 4 вместо 3, штраф — 265 вместо 143, и строка поднимается с 4-го места на 2-е.',
      heading: 'ПОСЫЛКИ ПО ЗАДАЧЕ C',
      all: 'все посылки',
      queued: 'В очереди',
      running: (n: number) => `Проверяется · тест ${n} из 22`,
      accepted: 'Принято · 22 теста',
      timeLimit: 'Превышено время · тест 9',
      overLimit: '> 1 с · 31 МБ',
      usage: '0,18 с · 12 МБ',
      test: (n: number) => `тест ${n}`,
      cols: ['МЕСТО', 'УЧАСТНИК', 'РЕШЕНО', 'ШТРАФ'],
      you: 'ВЫ',
      caps: 0.04,
    },
  } as const

  /** The width of Anna's handle in the table (sans 700 13px, measured in the browser): the YOU chip stands after it. */
  const NAME_W = 102.6

  // ---------------------------------------------------------------- tokens ----

  /*
   * web/src/index.css. The contest pages put `.competition-ui` on their root,
   * which sets both muted and faint to --competition-muted (the submission's
   * number is faint). A board cell is the canvas with its tint laid over it as
   * an inset shadow, so it stays the same colour on the viewer's raised row:
   * the tints here are that mix, worked out.
   */
  const PALETTE = {
    light: {
      canvas: '#ffffff', raised: '#e7eef9', line: '#dce3ef', ink: '#101a33', muted: '#415069',
      accent: '#0fa0d7', accentText: '#0a6e96', positive: '#0c7a64', danger: '#d4162f', warning: '#9b5a08',
      // text-white on the solid green, text-white/80 under it
      onPositive: 'fill:#ffffff', onPositiveSub: 'fill:#ffffff;fill-opacity:.8',
      // bg-warning/10 under TL; positive/10 and danger/10 over the canvas in a cell
      warningChip: 'fill:#9b5a08;fill-opacity:.1', solvedCell: '#e7f2f0', failedCell: '#fbe8ea',
      // the YOU chip: bg-brand text-white
      youChip: '#0f2d69', onYou: '#ffffff',
    },
    dark: {
      canvas: '#060c1c', raised: '#0e1b3d', line: '#16244b', ink: '#e6e7e8', muted: '#b8c3d6',
      accent: '#0fa0d7', accentText: '#0fa0d7', positive: '#3ec9a7', danger: '#f2495f', warning: '#f2a33c',
      // dark:text-canvas on the solid green, dark:text-canvas/75 under it
      onPositive: 'fill:#060c1c', onPositiveSub: 'fill:#060c1c;fill-opacity:.75',
      // dark:bg-warning/20; positive/15 and danger/15 over the canvas
      warningChip: 'fill:#f2a33c;fill-opacity:.2', solvedCell: '#0e2831', failedCell: '#291526',
      // dark:bg-accent dark:text-accent-ink
      youChip: '#0fa0d7', onYou: '#06203a',
    },
  } as const

  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif"
  const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"

  // web/src/lib/competition-words.ts · AVATAR_TINTS / avatarTint, ported. The board's circle carries no letter.
  const AVATAR_TINTS = ['#CFE3F7', '#F7D9E3', '#D8F0E4', '#F2D9B8', '#E3DDF7', '#F7E9C4']
  function avatarTint(name: string): string {
    let hash = 0
    for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 100_000
    return AVATAR_TINTS[hash % AVATAR_TINTS.length]
  }

  // ---------------------------------------------------------------- motion ----

  const LOOP = 13000
  const SEAM = LOOP - 400 // last 400 ms: back to the start frame
  const DIP = SEAM + 200 // the board's rows are out of sight here and take their start places
  const HOLD = 10500 // a moment inside the resolved hold: the static frame
  const EASE = {
    out: 'cubic-bezier(.23,1,.32,1)',
    io: 'cubic-bezier(.77,0,.175,1)',
    lin: 'linear',
    step: 'step-end',
  } as const
  type Ease = keyof typeof EASE

  const at = (ms: number): string => `${+((ms / LOOP) * 100).toFixed(2)}%`
  const r5 = (n: number): number => Math.round(n * 2) / 2

  type Stop = [ms: number, decl: string, ease?: Ease]
  type Change = [ms: number, decl: string, dur: number, ease?: Ease]

  const IDENTITY = new Set(['', 'none', 'scale(1)', 'translateY(0)', 'translateX(0)'])

  class Motion {
    private bodies = new Map<string, string>()
    private out: string[] = []

    /** Raw stops → class name. Identical keyframes share one rule. */
    stops(stops: Stop[], base: Ease = 'out'): string {
      const groups = new Map<string, string[]>()
      for (let i = 0; i < stops.length; i++) {
        const [ms, decl, ease] = stops[i]
        const next = stops[i + 1]
        if (next && next[0] === ms && !ease) continue
        const key = `${decl}${ease && ease !== base ? `;animation-timing-function:${EASE[ease]}` : ''}`
        const list = groups.get(key) ?? []
        if (!list.includes(at(ms))) list.push(at(ms))
        groups.set(key, list)
      }
      const body = [...groups].map(([key, list]) => `${list.join(',')}{${key}}`).join('')
      let name = this.bodies.get(body)
      if (!name) {
        name = `k${this.bodies.size}`
        this.bodies.set(body, name)
        this.out.push(`@keyframes ${name}{${body}}.${name}{animation-name:${name}}`)
      }
      return `a ${name}`
    }

    /**
     * A value track: start value, then timed changes. At the end the value
     * goes back to the start: over the last 400 ms (`seam`), or, for the
     * board's rows (`dip`), in one step while their group is out of sight.
     */
    track(v0: string, changes: Change[], back: Ease | 'dip' = 'out'): { cls: string; end: string } {
      const stops: Stop[] = [[0, v0]]
      let cur = v0
      let end = v0
      for (const [ms, v, dur, ease = 'out'] of changes) {
        if (ms < 400) throw new Error(`first beat before 0.4 s: ${ms}`)
        if (ms + dur > SEAM) throw new Error(`beat runs into the seam: ${ms}`)
        stops.push([ms, cur, ease])
        stops.push([ms + dur, v])
        cur = v
        if (ms + dur <= HOLD) end = v
      }
      if (cur !== v0) {
        if (back === 'dip') {
          stops.push([DIP, cur, 'step'])
          stops.push([DIP + 10, v0])
        } else {
          stops.push([SEAM, cur, back])
        }
      }
      stops.push([LOOP, v0])
      return { cls: this.stops(stops), end }
    }

    css(): string {
      return this.out.join('')
    }
  }

  const st = (o: number, t = 'none'): string => `opacity:${o};transform:${t}`

  /** Attributes for an element whose opacity (and maybe transform) is animated. */
  function attrs(m: Motion, v0: string, changes: Change[], extraCls = '', back: Ease | 'dip' = 'out'): string {
    const { cls, end } = m.track(v0, changes, back)
    const o = /opacity:([\d.]+)/.exec(end)
    const t = /transform:([^;]+)/.exec(end)
    if (t && !IDENTITY.has(t[1].trim())) throw new Error(`static frame would keep a transform: ${end}`)
    const op = o && o[1] !== '1' ? ` opacity="${o[1]}"` : ''
    return `class="${cls}${extraCls ? ' ' + extraCls : ''}"${op}`
  }

  /**
   * Fade helper: 0/1 visibility changes, 160 ms by default. Inside the new
   * row, which itself fades out at the seam (`back = 'step'`), children keep
   * their last state and reset on the invisible loop boundary instead of
   * fading; on the board (`back = 'dip'`) they reset while it is out of sight.
   */
  let back: Ease | 'dip' = 'out'
  function fade(m: Motion, v0: 0 | 1, changes: [ms: number, v: 0 | 1, dur?: number][], extraCls = ''): string {
    return attrs(m, `opacity:${v0}`, changes.map(([ms, v, dur = 160]) => [ms, `opacity:${v}`, dur, 'out'] as Change), extraCls, back)
  }

  // ------------------------------------------------------------------ text ----

  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  /** Capitals tracking: set by the scene's language (see TEXT). */
  let CAPS_TRACK: number = TEXT.en.caps

  /** Width of a mono run: chars × 0.6 × size, plus the caps tracking. */
  const monoW = (s: string, size: number, caps: boolean): number =>
    [...s].length * 0.6 * size + (caps ? ([...s].length - 1) * CAPS_TRACK * size : 0)

  /** Mono line with an explicit textLength, so every glyph lands on the grid. */
  function monoText(x: number, y: number, s: string, o: { cls?: string; caps?: boolean; size?: number; end?: boolean } = {}): string {
    const size = o.size ?? (o.caps ? 11 : 12)
    const w = monoW(s, size, !!o.caps)
    const base = o.caps ? 'L' : `c${size}`
    const left = o.end ? x - w : x
    return `<text x="${r5(left)}" y="${y}" class="${base}${o.cls ? ' ' + o.cls : ''}" textLength="${+w.toFixed(2)}">${esc(s)}</text>`
  }

  /** A mono run centred on `cx` (a badge's code, a board cell's two lines). */
  const monoMid = (cx: number, y: number, s: string, size: number, cls: string): string =>
    monoText(cx - monoW(s, size, false) / 2, y, s, { size, cls })

  const sans = (x: number, y: number, inner: string, cls = 'u'): string => `<text x="${r5(x)}" y="${y}" class="${cls}">${inner}</text>`

  /**
   * The verdict box (VerdictBadge.svelte): one width whatever the code, so a
   * column of them reads as a column; the code centred, mono bold. Accepted is
   * the one solid box, TL a warning tint, «…» an outline in the live accent
   * while the judge has it (BADGE_PAINT).
   */
  function badge(x: number, y: number, code: string, tone: 'OK' | 'TL' | 'run'): string {
    const ground =
      tone === 'run'
        ? `<rect x="${x + 0.5}" y="${y + 0.5}" width="43" height="21" fill="none" class="oA"/>`
        : `<rect x="${x}" y="${y}" width="44" height="22" class="${tone === 'OK' ? 'bP' : 'xW'}"/>`
    return ground + monoMid(x + 22, y + 15.5, code, 12, `w7 ${tone === 'OK' ? 'tO' : tone === 'TL' ? 'tW' : 'tA'}`)
  }

  // ----------------------------------------------------------------- scene ----

  function contests(theme: Theme, lang: Lang): string {
    const P = PALETTE[theme]
    const S = TEXT[lang]
    CAPS_TRACK = S.caps
    const m = new Motion()
    back = 'out'
    const W = 880
    const H = 380

    // Beats (ms)
    const ARRIVE = 700 // #114 lands on top of the list, in the queue
    const QUEUED = 1000 // the board has it too: C is «…» over «−1»
    const RUN = 2200 // the judge takes it: test 1 of 22
    const TEST = 160 // one test every 160 ms: test 22 at RUN + 21 × TEST
    const DONE = 5700 // accepted: OK, «Accepted · 22 tests», what the run took
    const BOARD = 5800 // the board reloads: C is +1 at 1:42, solved 4, penalty 265
    const MOVE = 6600 // … and the row climbs from 4th place to 2nd
    const testAt = (n: number): number => RUN + (n - 1) * TEST

    const defs: string[] = []
    const body: string[] = []
    const push = (s: string): void => void body.push(s)

    const X0 = 20
    const X1 = 860
    const BADGE_X = X0 + 42 // after the number (w-[30px]) and the gap
    const HEAD_X = BADGE_X + 56 // after the box and the gap
    const RH = 42 // a row
    const EX = 12 // the bar under a running row: gap-2 and h-1
    const LIST = 36 // under the heading's rule

    /*
     * The running test, said twice: «test N of 22» beside the badge and «test N»
     * in the board's cell. Each is a column of 22 lines behind a one-line
     * window, and both columns step together by the same keyframes.
     */
    const LH = 20
    const stepping = (() => {
      const stops: Stop[] = [[0, 'transform:translateY(0)']]
      for (let n = 2; n <= 22; n++) stops.push([testAt(n), `transform:translateY(-${(n - 1) * LH}px)`])
      stops.push([LOOP, `transform:translateY(-${21 * LH}px)`])
      return `${m.stops(stops, 'step')} sE`
    })()

    // ---- card
    push(`<rect x=".5" y=".5" width="879" height="${H - 1}" rx="12" class="bc sl"/>`)

    // ---- Submissions for C
    push(monoText(X0, 26, S.heading, { caps: true, cls: 'tm' }))
    push(sans(X1, 26, esc(S.all), 'u12 tA e'))
    push(`<rect x="${X0}" y="35" width="${X1 - X0}" height="1" class="bi"/>`)

    // the older submission: out of time on test 9; it makes room for the new one
    {
      const y = LIST + RH
      const g: string[] = []
      g.push(`<rect x="${X0}" y="${y}" width="${X1 - X0}" height="1" ${fade(m, 0, [[ARRIVE, 1, 200]], 'bl')}/>`)
      g.push(monoText(X0, y + 25, '#97', { cls: 'tm' }))
      g.push(badge(BADGE_X, y + 10, 'TL', 'TL'))
      g.push(sans(HEAD_X, y + 26, esc(S.timeLimit), 'u ti'))
      g.push(monoText(X1, y + 25, S.overLimit, { cls: 'tm', end: true }))
      g.push(`<rect x="${X0}" y="${y + RH - 1}" width="${X1 - X0}" height="1" class="bl"/>`)
      push(
        `<g ${attrs(m, st(1, `translateY(-${RH}px)`), [
          [ARRIVE, st(1, 'translateY(0)'), 320, 'io'],
          [RUN, st(1, `translateY(${EX}px)`), 280, 'io'],
          [DONE, st(1, 'translateY(0)'), 280, 'io'],
        ], '', 'io')}>${g.join('')}</g>`,
      )
    }

    // the new submission: queued → judged test by test → accepted; leaves as a whole at the seam
    {
      const y = LIST
      const g: string[] = []
      const seam = back
      back = 'step'
      g.push(monoText(X0, y + 25, '#114', { cls: 'tm' }))
      g.push(`<g ${fade(m, 1, [[DONE, 0, 100]])}>${badge(BADGE_X, y + 10, '…', 'run')}</g>`)
      g.push(`<g ${fade(m, 0, [[DONE + 60, 1, 160]])}>${badge(BADGE_X, y + 10, 'OK', 'OK')}</g>`)
      g.push(`<g ${fade(m, 1, [[RUN, 0, 100]])}>${sans(HEAD_X, y + 26, esc(S.queued), 'u ti')}</g>`)
      {
        defs.push(`<clipPath id="ch"><rect x="${HEAD_X}" y="${y + 11}" width="400" height="${LH}"/></clipPath>`)
        const lines = Array.from({ length: 22 }, (_, i) => sans(HEAD_X, y + 26 + i * LH, esc(S.running(i + 1)), 'u ti')).join('')
        g.push(`<g ${fade(m, 0, [[RUN, 1, 120], [DONE, 0, 100]])}><g clip-path="url(#ch)"><g class="${stepping}">${lines}</g></g></g>`)
      }
      g.push(`<g ${fade(m, 0, [[DONE + 80, 1, 200]])}>${sans(HEAD_X, y + 26, esc(S.accepted), 'u ti')}</g>`)

      // the right column: the clock while the judge has it, then what the run took
      g.push(`<g ${fade(m, 1, [[DONE, 0, 100]])}>${monoText(X1, y + 25, '11:42', { cls: 'tm', end: true })}</g>`)
      g.push(`<g ${fade(m, 0, [[DONE + 80, 1, 200]])}>${monoText(X1, y + 25, S.usage, { cls: 'tm', end: true })}</g>`)

      // under a running row: the tests passed in green, the running one in the accent, the rest grey
      {
        const bx = BADGE_X // pl-[42px]: the bar starts under the badge
        const by = y + 40
        const unit = (X1 - bx - 6) / 22 // flex-grow by tests, less two 3 px gaps: 36
        const green: Stop[] = [[0, 'transform:scaleX(0)']]
        const live: Stop[] = [[0, 'transform:translateX(0)']]
        for (let n = 2; n <= 22; n++) {
          green.push([testAt(n), `transform:scaleX(${+((n - 1) / 21).toFixed(4)})`])
          live.push([testAt(n), `transform:translateX(${(n - 1) * unit + 3}px)`])
        }
        green.push([LOOP, 'transform:scaleX(1)'])
        live.push([LOOP, `transform:translateX(${21 * unit + 3}px)`])
        g.push(
          `<g ${fade(m, 0, [[RUN, 1, 140], [DONE, 0, 140]])}>` +
            `<rect x="${bx}" y="${by}" width="${X1 - bx}" height="4" class="bl"/>` +
            `<rect x="${bx}" y="${by}" width="${21 * unit}" height="4" class="bP ${m.stops(green, 'step')} sE pl"/>` +
            // a canvas stroke under the running test's fill keeps the 3 px gap on either side of it
            `<rect x="${bx}" y="${by}" width="${unit}" height="4" class="bA gp ${m.stops(live, 'step')} sE"/>` +
            `</g>`,
        )
      }
      back = seam
      push(`<g ${attrs(m, st(0, 'translateY(-6px)'), [[ARRIVE, st(1), 320]])}>${g.join('')}</g>`)
    }

    // ---- the board (the desktop ICPC table)
    const HB = 166 // the header's baseline
    const COL_P = X0 + 60 // the participant column
    const COL_A = 332 // the first problem column
    const CW = 72 // a problem column; its box is 58 × 30
    const SOLVED_R = 768 // the solved column's right edge; the penalty's is X1
    push(monoText(X0, HB, S.cols[0], { caps: true, cls: 'tm' }))
    push(monoText(COL_P, HB, S.cols[1], { caps: true, cls: 'tm' }))
    ;['A', 'B', 'C', 'D', 'E'].forEach((letter, i) => push(monoMid(COL_A + i * CW + CW / 2, HB, letter, 13, 'w7 ti')))
    push(monoText(SOLVED_R, HB, S.cols[2], { caps: true, cls: 'tm', end: true }))
    push(monoText(X1, HB, S.cols[3], { caps: true, cls: 'tm', end: true }))
    push(`<rect x="${X0}" y="${HB + 8}" width="${X1 - X0}" height="2" class="bi"/>`)
    const ROWS = HB + 10
    const BRH = 38
    for (let i = 1; i <= 5; i++) push(`<rect x="${X0}" y="${ROWS + i * BRH - 1}" width="${X1 - X0}" height="1" class="bl"/>`)

    /*
     * A cell (StandingsTable.svelte · BOX, MAIN, SUB; contest-words.ts ·
     * icpcCell): the first solve of a problem solid green, solved a green tint
     * with the attempts over the minutes from the start, failed a red tint
     * with the misses, being judged a dashed accent box.
     */
    type Tone = 'first' | 'solved' | 'failed' | 'pending'
    type Cell = [tone: Tone, main: string, sub?: string] | null
    const ok = (sub: string, misses = 0, first = false): Cell => [first ? 'first' : 'solved', misses ? `+${misses}` : '+', sub]
    const no = (misses: number): Cell => ['failed', `−${misses}`]
    const MAIN: Record<Tone, string> = { first: 'tO', solved: 'tP', failed: 'td', pending: 'tA' }
    const SUB: Record<Tone, string> = { first: 'tOs', solved: 'tm', failed: 'tm', pending: 'tA' }
    const box = (x: number, y: number, tone: Tone): string =>
      tone === 'pending'
        ? `<rect x="${x + 7.5}" y="${y + 4.5}" width="57" height="29" stroke-dasharray="3 2" class="bc oA"/>`
        : `<rect x="${x + 7}" y="${y + 4}" width="58" height="30" class="${tone === 'first' ? 'bP' : tone === 'solved' ? 'xS' : 'xF'}"/>`
    // the main line sits higher when there is a line under it
    const main = (x: number, y: number, s: string, tone: Tone, alone: boolean): string =>
      monoMid(x + CW / 2, y + (alone ? 23.5 : 17.5), s, 13, `w7 ${MAIN[tone]}`)
    const sub = (x: number, y: number, s: string, tone: Tone): string => monoMid(x + CW / 2, y + 30, s, 11, SUB[tone])
    const cell = (x: number, y: number, c: Cell): string =>
      c ? box(x, y, c[0]) + main(x, y, c[1], c[0], c[2] === undefined) + (c[2] === undefined ? '' : sub(x, y, c[2], c[0])) : ''

    /*
     * The final order. Anna (index 1) starts two rows lower, the two she
     * passes one row higher. The penalties follow the rule: @marfa_belova
     * 9 + 31 + (52 + 20) + 77 = 189; Anna 14 + (41 + 20) + 68 = 143, then
     * + (102 + 20) = 265; @t_aliev 12 + 24 + 47 = 83; @d_orlov 11 + 38 + 57 =
     * 106; @o_petrov 21 + 94 = 115. The first solve of each column is its
     * earliest time.
     */
    const people: { name: string; cells: Cell[]; solved: string; penalty: string; from: number }[] = [
      { name: '@marfa_belova', cells: [ok('0:09', 0, true), ok('0:31'), ok('0:52', 1, true), ok('1:17'), no(1)], solved: '4', penalty: '189', from: 0 },
      { name: '@annasmirnova', cells: [ok('0:14'), ok('0:41', 1), null, ok('1:08'), null], solved: '4', penalty: '265', from: 2 },
      { name: '@t_aliev', cells: [ok('0:12'), ok('0:24', 0, true), no(2), ok('0:47', 0, true), null], solved: '3', penalty: '83', from: -1 },
      { name: '@d_orlov', cells: [ok('0:11'), ok('0:38'), null, no(1), ok('0:57', 0, true)], solved: '3', penalty: '106', from: -1 },
      { name: '@o_petrov', cells: [ok('0:21'), no(3), null, ok('1:34'), null], solved: '2', penalty: '115', from: 0 },
    ]
    const rows: string[] = []
    back = 'dip'
    people.forEach((p, i) => {
      const y = ROWS + i * BRH
      const you = i === 1
      const g: string[] = []
      if (you) g.push(`<rect x="${X0}" y="${y}" width="${X1 - X0}" height="${BRH - 1}" class="br"/>`)
      g.push(`<circle cx="${COL_P + 10}" cy="${y + 19}" r="10" fill="${avatarTint(p.name)}"/>`)
      g.push(sans(COL_P + 28, y + 23.5, esc(p.name), 'u13 w7 ti'))
      p.cells.forEach((c, k) => g.push(cell(COL_A + k * CW, y, c)))
      const numbers = (solved: string, penalty: string): string =>
        monoText(SOLVED_R, y + 24.5, solved, { size: 15, cls: 'w7 ti', end: true }) + monoText(X1, y + 23.5, penalty, { cls: 'tm', end: true })
      if (you) {
        const cx = r5(COL_P + 28 + NAME_W + 10)
        const cw = r5(7 + monoW(S.you, 11, true) + 7)
        g.push(`<rect x="${cx}" y="${y + 10.5}" width="${cw}" height="17" class="bY"/>` + monoText(cx + 7, y + 23, S.you, { caps: true, cls: 'tY' }))
        // C: −1; «…» over −1 in the queue; «…» over the running test; +1 at 1:42
        const c = COL_A + 2 * CW
        g.push(`<g ${fade(m, 1, [[QUEUED, 0, 120]])}>${cell(c, y, no(1))}</g>`)
        g.push(`<g ${fade(m, 0, [[QUEUED, 1, 160], [BOARD, 0, 120]])}>${box(c, y, 'pending')}${main(c, y, '…', 'pending', false)}</g>`)
        g.push(`<g ${fade(m, 0, [[QUEUED, 1, 160], [RUN, 0, 100]])}>${sub(c, y, '−1', 'pending')}</g>`)
        defs.push(`<clipPath id="ct"><rect x="${c + 8}" y="${y + 20}" width="56" height="13.5"/></clipPath>`)
        const lines = Array.from({ length: 22 }, (_, k) => sub(c, y + k * LH, S.test(k + 1), 'pending')).join('')
        g.push(`<g ${fade(m, 0, [[RUN, 1, 100], [BOARD, 0, 120]])}><g clip-path="url(#ct)"><g class="${stepping}">${lines}</g></g></g>`)
        g.push(`<g ${fade(m, 0, [[BOARD, 1, 220]])}>${cell(c, y, ok('1:42', 1))}</g>`)
        // solved and the penalty: 3 and 143 before, 4 and 265 after
        g.push(`<g ${fade(m, 1, [[BOARD, 0, 140]])}>${numbers('3', '143')}</g>`)
        g.push(`<g ${fade(m, 0, [[BOARD + 120, 1, 220]])}>${numbers(p.solved, p.penalty)}</g>`)
      } else {
        g.push(numbers(p.solved, p.penalty))
      }
      const inner = g.join('')
      const row = p.from === 0
        ? inner
        : `<g ${attrs(m, st(1, `translateY(${p.from * BRH}px)`), [[MOVE, st(1, 'translateY(0)'), 560, 'io']], '', 'dip')}>${inner}</g>`
      if (you) rows.push(row)
      else rows.unshift(row)
    })
    back = 'out'
    // the board's rows step out of sight for a moment at the seam and come back in their start places
    const dip = m.stops([[0, 'opacity:1'], [SEAM, 'opacity:1'], [DIP, 'opacity:0'], [DIP + 30, 'opacity:0'], [LOOP, 'opacity:1']])
    push(`<g class="${dip}">${rows.join('')}</g>`)
    // the place column stays put: 1…5 down the table whichever row stands there
    for (let i = 0; i < 5; i++) push(monoText(X0, ROWS + i * BRH + 24.5, String(i + 1), { size: 15, cls: 'w7 ti' }))

    // ---- style
    const css = [
      `.u,.u12,.u13{font-family:${SANS}}`,
      `.L,.c11,.c12,.c13,.c15{font-family:${MONO}}`,
      `.u{font-size:14px}.u12{font-size:12px}.u13{font-size:13px}`,
      `.c11{font-size:11px}.c12{font-size:12px}.c13{font-size:13px}.c15{font-size:15px}`,
      `.L{font-size:11px;font-weight:700;text-transform:uppercase}`,
      `.w7{font-weight:700}.e{text-anchor:end}`,
      `.ti{fill:${P.ink}}.tm{fill:${P.muted}}.tA{fill:${P.accentText}}.tP{fill:${P.positive}}.td{fill:${P.danger}}.tW{fill:${P.warning}}`,
      `.tO{${P.onPositive}}.tOs{${P.onPositiveSub}}.tY{fill:${P.onYou}}`,
      `.bc{fill:${P.canvas}}.br{fill:${P.raised}}.bl{fill:${P.line}}.bi{fill:${P.ink}}.bA{fill:${P.accent}}.bP{fill:${P.positive}}.bY{fill:${P.youChip}}`,
      `.xW{${P.warningChip}}.xS{fill:${P.solvedCell}}.xF{fill:${P.failedCell}}`,
      `.sl{stroke:${P.line}}.oA{stroke:${P.accent}}.gp{stroke:${P.canvas};stroke-width:6px;paint-order:stroke}`,
      `.a{animation:${LOOP / 1000}s ${EASE.out} infinite both}`,
      `.pl{transform-box:fill-box;transform-origin:left}.sE{animation-timing-function:step-end}`,
      m.css(),
      `@media (prefers-reduced-motion:reduce){*{animation:none!important}}`,
    ].join('')

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" lang="${lang}" role="img" aria-labelledby="contests-title contests-desc">` +
      `<title id="contests-title">${esc(S.title)}</title><desc id="contests-desc">${esc(S.desc)}</desc>` +
      `<style>${css}</style><defs>${defs.join('')}</defs>` +
      body.join('') +
      `</svg>`
    )
  }
  return contests
}

// ====================================================================== main

const SCENES: Record<string, () => Scene> = {
  room: roomArt,
  run: runArt,
  council: councilArt,
  lecture: lectureArt,
  oracle: oracleArt,
  competitions: competitionsArt,
  contests: contestsArt,
}

/** What <img> on GitHub will not show or must not fetch: a script, a foreign file, a font, an embedded image. */
const FORBIDDEN = /<script|foreignObject|<image|@import|base64|url\((?!#)|href="(?!#)/i
const LIMIT_KB = 40

/**
 * The scene's file name. English stays without a language mark: README and
 * the landing page link to it, and renaming would break both links; Russian
 * gets `-ru` before the theme.
 */
export function sceneFile(slug: string, lang: Lang, theme: Theme): string {
  return `${slug}${lang === 'en' ? '' : `-${lang}`}-${theme}.svg`
}

/** All twenty-eight files: seven scenes × two languages × two themes. */
export function renderAll(): Map<string, string> {
  const out = new Map<string, string>()
  for (const [slug, make] of Object.entries(SCENES)) {
    const scene = make()
    for (const lang of ['en', 'ru'] as const) {
      for (const theme of ['light', 'dark'] as const) {
        out.set(sceneFile(slug, lang, theme), scene(theme, lang))
      }
    }
  }
  return out
}

/** What <img> will not show, and what has outgrown the limit: one check per file. */
export function complaints(name: string, svg: string): string[] {
  const out: string[] = []
  if (Buffer.byteLength(svg) / 1024 >= LIMIT_KB) out.push(`${name}: ${LIMIT_KB} KB or larger`)
  const bad = svg.match(FORBIDDEN)
  if (bad) out.push(`${name}: forbidden construct ${bad[0]}`)
  return out
}

/*
 * Where to write. There are two directories, and they are not
 * interchangeable: README reads .github/assets/readme, while the landing page
 * is served by Pages from site/ and cannot reach .github/, so it must have its
 * own copy of the same files.
 */
export const OUT_DIRS = [
  fileURLToPath(new URL('../.github/assets/readme', import.meta.url)),
  fileURLToPath(new URL('../site/img/scenes', import.meta.url)),
]

// The file is both imported (the tests call renderAll) and run. It writes to disk only in the second case.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const dirs = (args.length ? args : OUT_DIRS).map((d) => resolve(d))
  const files = renderAll()
  let failed = false
  for (const [name, svg] of files) {
    console.log(`${name}  ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB`)
    for (const line of complaints(name, svg)) {
      console.error(line)
      failed = true
    }
  }
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
    for (const [name, svg] of files) writeFileSync(join(dir, name), svg)
    console.log(`→ ${dir}`)
  }
  if (failed) process.exit(1)
}

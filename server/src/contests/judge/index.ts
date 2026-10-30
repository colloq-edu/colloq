/**
 * The judges, registered: importing this module makes `contestJudge()` able to
 * return the docker judge and the stand-in (judge/port.ts). The queue imports
 * it once; nothing else needs to.
 *
 * The two imports are for their load-time side effect — each backend calls
 * `registerContestJudge` when its module loads — so they are kept here together
 * and nowhere else: a judge nobody imported is a backend `contestJudge()`
 * cannot build.
 */
import './docker-judge.js'
import './fake-judge.js'

export {}

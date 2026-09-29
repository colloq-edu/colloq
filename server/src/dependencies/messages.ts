import { tr } from '@shared/i18n'
import { dependencyErrorText, type DependencyErrorParams } from '@shared/dependencies'

/**
 * Stable API errors; raw Docker paths and resolver URLs never become UI copy.
 *
 * The texts and the numbers they carry are the browser's own
 * (shared/dependencies.ts · dependencyErrorLines): what is stored here, in
 * the instance's language, is what the page draws from the code and params.
 */
export function dependencyMessage(code:string, params?:DependencyErrorParams, requirementsText?:string):string {
 return dependencyErrorText({code,params},requirementsText)
}

/** What a refusal's text needs beyond its code: the line it is about, and what it measured. */
export interface DependencyRefusalDetail { line?: number; params?: DependencyErrorParams }

/**
 * A refused request's text, with the line it is about first, the way a failed
 * set's card puts it ("Line 3: …"). The page shows this text as it comes, so
 * a line number left out of it is a line the entrant has to hunt for.
 */
export function dependencyRefusal(code:string, detail:DependencyRefusalDetail={}):string {
 const text=dependencyMessage(code,detail.params)
 return detail.line?`${tr('dependencies.line',{line:detail.line})}: ${text}`:text
}

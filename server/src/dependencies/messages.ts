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

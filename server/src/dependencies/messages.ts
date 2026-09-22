import { tr } from '@shared/i18n'

/** Stable API errors; raw Docker paths and resolver URLs never become UI copy. */
export function dependencyMessage(code:string):string {
 const keys:Record<string,string>={
  dependency_disabled:'dependencies.disabled', dependency_limits:'dependencies.limitError',
  dependency_empty:'dependencies.error.empty',dependency_owner:'dependencies.error.missing',
  dependency_revision:'dependencies.error.revision',dependency_not_ready:'dependencies.error.notReady',
  dependency_active:'dependencies.error.active',dependency_quota:'dependencies.error.quota',
  dependency_submission_active:'competitions.refusal.inFlight',dependency_submission_quota:'dependencies.error.submissionQuota',
  dependency_join:'dependencies.error.join',dependency_closed:'dependencies.error.closed',
  base_conflict:'dependencies.error.conflict',dependency_conflict:'dependencies.error.conflict',
  wheel_unavailable:'dependencies.error.wheel',invalid_requirement:'dependencies.error.syntax',
  unsupported_source:'dependencies.error.source',package_not_found:'dependencies.error.missingPackage',
  hash_mismatch:'dependencies.error.integrity',download_limit:'dependencies.error.size',installed_limit:'dependencies.error.size',
  disk_full:'dependencies.error.disk',network_error:'dependencies.error.network',timeout:'dependencies.error.timeout',
  cancelled:'dependencies.error.cancelled',image_unpinned:'dependencies.error.base',base_changed:'dependencies.error.base',
  dependency_image:'dependencies.error.base',worker_restarted:'dependencies.error.restarted',
 }
 return tr(keys[code]??'dependencies.error.generic')
}

import type { Competition } from '@shared/competitions'
import { competitionRevision, getBinding } from '../dependencies/store.js'
import { competitionBackend } from './runner-port.js'

/** A replay keeps its immutable base; only a run against the selected retained
 * revision can certify the competition's current inputs. Names alone do not
 * identify a base: an alias can be rebuilt with a different image digest. */
export function submissionUsesCurrentBase(competition: Competition, submissionId: string): boolean {
  const selected = competitionRevision(competition.id)
  const bound = getBinding(submissionId)?.revision
  // The supported fake backend can operate without any image catalog. Once a
  // real revision is selected or bound, it follows the same provenance rules.
  if (!selected && !bound) return competitionBackend() === 'test'
  return !!selected && !!bound && selected.environmentName === competition.environment
    && bound.id === selected.id && bound.imageDigest === selected.imageDigest
    && bound.environmentName === selected.environmentName
}

export interface AttemptProvenance {
  inputRevision: number | null
  notebookInputRevision: number | null
}

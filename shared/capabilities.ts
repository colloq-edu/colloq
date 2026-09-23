/** Operational availability, independent of whether an action is permitted. */
export interface RuntimeCapability { available: boolean; code: string; reason: string | null }
export interface CompetitionCapabilities { execution: RuntimeCapability; preparation: RuntimeCapability }

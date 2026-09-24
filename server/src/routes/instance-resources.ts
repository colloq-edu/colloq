/**
 * What the machine under the instance has to offer, as one endpoint for the
 * panel.
 *
 * The new-class form asks it so that the "memory" field is labelled with the
 * truth: how much the machine has in total, how much is free right now, what
 * a room on the chosen environment gets by default, and which card the
 * machine has. Before this only the operator with ssh knew the numbers, while
 * the decision "how much to give the seminar" is the teacher's.
 *
 * Staff only: this describes the machine, not the room, and a student has
 * nothing to learn from it. `no-store` for the same reason as on the other
 * panel reads, and because the answer is live: free memory changes between
 * two openings of the form.
 */
import { operationalStatus } from '../ops/status.js'
import { Router } from 'express'
import { requireStaff } from '../admin/auth.js'
import { cpuBounds, machineResources, memoryBounds } from '../kernel/resources.js'

export function instanceResourcesRoutes(): Router {
  const router = Router()

  router.get('/api/instance/operations',requireStaff,(_req,res,next)=>{
    void operationalStatus().then(value=>res.set('Cache-Control','no-store').json(value)).catch(next)
  })

  router.get('/api/instance/resources', requireStaff, (_req, res, next) => {
    machineResources()
      .then((resources) =>
        res.set('Cache-Control', 'no-store').json({
          ...resources,
          /*
           * The bounds travel with the numbers rather than being computed in
           * the browser.
           *
           * Computing them there would mean a second copy of the "leave the
           * machine a gigabyte" rule: the server rejects by its copy, the form
           * paints by its own, and they diverge on exactly the day the rule
           * changes.
           */
          limits: { ...memoryBounds(), cpus: cpuBounds() },
        }),
      )
      .catch(next)
  })

  return router
}

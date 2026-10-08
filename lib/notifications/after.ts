/**
 * Delivering what an action just created, once its response has gone.
 *
 * The notifications themselves were written in the action's transaction;
 * this only pushes and mails them sooner than the hourly sweep would. A
 * failure here is logged and left for that sweep to retry.
 */

import { after } from 'next/server'

import { deliverNotifications } from './deliver'

export function deliverSoon() {
  after(async () => {
    try {
      await deliverNotifications()
    } catch (error) {
      console.error('Delivering notifications failed; the hourly sweep will retry', error)
    }
  })
}

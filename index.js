/**
 * LearnHarness Host half.
 *
 * Owns the one-profile lesson/graph store, exposes it to the Tutor preset as
 * the `learnStore` service, and serves the Learn page's read-only JSON view at
 * `/learnharness/api`. Data lives in `$DSH_HOME/learnharness/learn.json`.
 */

import { LearnError, LearnStore, resolveRoot } from './lib/store.js'

export const name = 'learnharness'

const API_ROUTE = '/learnharness/api'
const HEALTH_ROUTE = '/learnharness/health'

/** @param {unknown} error thrown value. @returns {string} a user-facing message. */
function messageOf(error) {
  if (error instanceof LearnError) return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return 'The LearnHarness store could not complete that request.'
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res response to end.
 * @param {number} status HTTP status.
 * @param {unknown} value JSON value.
 * @param {boolean} headOnly write headers only.
 */
function sendJson(res, status, value, headOnly = false) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(headOnly ? undefined : body)
}

/**
 * Serve the Learn page's snapshot for one selected session (or the latest).
 * @param {LearnStore} store shared store.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createHandler(store) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
        res.end()
        return
      }
      const url = new URL(req.url ?? API_ROUTE, 'http://localhost')
      const session = url.searchParams.get('session') ?? ''
      sendJson(res, 200, await store.snapshot(session), req.method === 'HEAD')
    } catch (error) {
      const status = error instanceof LearnError ? 400 : 500
      if (status === 500) console.warn(`[learnharness] Request failed: ${error?.stack ?? error}`)
      sendJson(res, status, { error: messageOf(error) })
    }
  }
}

/**
 * Mount the store service and the browser route.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context.
 * @returns {void}
 */
export function apply(ctx) {
  const store = new LearnStore(resolveRoot())
  ctx.effect(() => ctx.provide('learnStore', store), 'learnharness: store service')
  // Resolve webServer through ctx.inject: at profile boot the service can mount
  // after apply(), and a one-time get would leave the route unregistered.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: API_ROUTE,
      handler: createHandler(store),
    }), 'learnharness: API route')
    // Anonymous liveness probe: counts only, no lesson content.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: HEALTH_ROUTE,
      auth: 'anonymous',
      handler: async (_req, res) => {
        try {
          const view = await store.snapshot()
          sendJson(res, 200, {
            ok: true,
            version: 1,
            lessons: view.lessons.length,
            propositions: view.graph.total.propositions,
            chains: view.graph.total.chains,
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: messageOf(error) })
        }
      },
    }), 'learnharness: health route')
  })
}

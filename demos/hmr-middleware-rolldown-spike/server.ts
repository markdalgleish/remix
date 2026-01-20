/**
 * HMR Middleware Spike Demo Server
 *
 * This demo shows how to use @remix-run/hmr-middleware for
 * Hot Module Replacement during development.
 *
 * Key pattern: HMR middleware is a devDependency and only imported in development.
 * In production, we just use static-middleware directly.
 *
 * The build pipeline:
 * 1. esbuild bundles app/assets/entry.tsx → public/assets/entry.js (with external /assets/*)
 * 2. esbuild transforms app/assets/*.tsx → public/assets/*.js (individual files)
 * 3. In dev: hmr-middleware transforms public/assets/ files for HMR
 * 4. static-middleware serves public/
 */

import * as http from 'node:http'
import { createRequestListener } from '@remix-run/node-fetch-server'
import { createRouter } from '@remix-run/fetch-router'
import { staticFiles } from '@remix-run/static-middleware'

let PORT = 44100
let isDev = process.env.NODE_ENV !== 'production'

// Build middleware array
let middleware = []

// In development, dynamically import HMR middleware
// This keeps @remix-run/hmr-middleware as a devDependency
if (isDev) {
  let { hmr } = await import('@remix-run/hmr-middleware')
  middleware.push(
    hmr('./public', {
      include: /^assets\//, // Only transform files in assets/
      exclude: /^assets\/chunks\//, // Skip esbuild chunks
      debug: true, // Enable HMR logging
    }),
  )
}

// Static files middleware - serves everything from public/
// In dev, disable caching to ensure fresh files
middleware.push(
  staticFiles(
    './public',
    isDev
      ? {
          cacheControl: 'no-store, must-revalidate',
          etag: false,
          lastModified: false,
        }
      : undefined,
  ),
)

// Create router with middleware
let router = createRouter({ middleware })

// Create HTTP server
let server = http.createServer(
  createRequestListener(async (request) => {
    try {
      return await router.fetch(request)
    } catch (error) {
      console.error(error)
      return new Response('Internal Server Error', { status: 500 })
    }
  }),
)

server.listen(PORT, () => {
  console.log(`HMR Middleware Spike running at http://localhost:${PORT}`)
})

// Clean shutdown
let shuttingDown = false

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('\nShutting down...')
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

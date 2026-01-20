/**
 * HMR Middleware
 *
 * Hot Module Replacement middleware for Remix development.
 * Composes with static-middleware to add HMR support.
 *
 * This middleware operates as a transform layer on responses from static-middleware.
 * It doesn't read files directly - it intercepts responses and transforms them.
 *
 * @example
 * import { hmr } from '@remix-run/hmr-middleware'
 * import { staticFiles } from '@remix-run/static-middleware'
 *
 * let router = createRouter({
 *   middleware: [
 *     // HMR must come BEFORE static files to intercept responses
 *     hmr('./public', { include: /^assets\// }),
 *     staticFiles('./public'),
 *   ],
 * })
 */

import * as path from 'node:path'
import type { Middleware } from '@remix-run/fetch-router'

import { transformComponent, maybeHasComponent, HMR_RUNTIME_PATH } from './lib/transform.ts'
import { generateRuntimeModule } from './lib/runtime.ts'
import {
  createModuleGraph,
  trackImports,
  markFileChanged,
  markAsComponent,
  rewriteImports,
  findAffectedComponents,
} from './lib/module-graph.ts'
import { createWatcher, type HmrWatcher } from './lib/watcher.ts'
import { createHmrEventSource, type HmrEventSource } from './lib/sse.ts'

// =============================================================================
// Types
// =============================================================================

export interface HmrOptions {
  /**
   * Pattern to include files for HMR (matched against relative path from root).
   * Only matching files will be transformed and watched.
   *
   * @example
   * // Only transform files in app/ directory
   * include: /^app\//
   */
  include: RegExp

  /**
   * Pattern to exclude files from HMR (matched against relative path from root).
   * Excluded files will be served without HMR transformation.
   *
   * @example
   * // Skip chunks directory (esbuild --chunk-names='chunks/[name]-[hash]')
   * exclude: /\/chunks\//
   */
  exclude?: RegExp

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean
}

// =============================================================================
// Main Export
// =============================================================================

/**
 * Create an HMR middleware.
 *
 * This middleware:
 * 1. Intercepts requests matching `include` pattern
 * 2. Transforms component files for HMR (unless they match `exclude`)
 * 3. Injects HMR client script into HTML responses
 * 4. Provides SSE endpoint at `/@remix/hmr` for live updates
 * 5. Watches `root` directory for file changes
 *
 * @param root Directory to serve and watch (absolute or relative to cwd)
 * @param options HMR configuration
 * @returns A middleware function that handles HMR
 */
export function hmr(root: string, options: HmrOptions): Middleware {
  // Resolve to absolute path
  root = path.resolve(root)

  let { include, exclude, debug = false } = options

  let graph = createModuleGraph()

  function log(...args: unknown[]) {
    if (debug) {
      console.log('[HMR]', ...args)
    }
  }

  // Create HMR event source for SSE notifications
  let hmrEvents: HmrEventSource = createHmrEventSource(debug)

  // Create file watcher
  let watcher: HmrWatcher = createWatcher({ root })

  // Handle file changes
  watcher.onFileChange((event) => {
    // Check if this file matches our include pattern
    if (!include.test(event.relativePath)) {
      return
    }

    log(`File changed: ${event.relativePath}`)

    // Convert relative path to URL path for module graph
    let moduleUrl = '/' + event.relativePath

    // Mark file as changed in module graph
    markFileChanged(graph, moduleUrl, event.timestamp)

    // Find affected components
    let affected = findAffectedComponents(graph, moduleUrl)

    if (affected.length > 0) {
      log(`  → Affected components: ${affected.join(', ')}`)
      // Send update to clients via SSE
      hmrEvents.sendUpdate(affected, event.timestamp)
    } else {
      log(`  → No components affected`)
    }
  })

  // Start watching
  watcher.start()

  // The middleware
  return async (context, next) => {
    let { url } = context

    // Only handle GET/HEAD
    if (context.method !== 'GET' && context.method !== 'HEAD') {
      return next()
    }

    // Handle HMR SSE endpoint
    if (url.pathname === '/@remix/hmr') {
      return hmrEvents.connect()
    }

    // Serve HMR runtime module
    if (url.pathname === HMR_RUNTIME_PATH) {
      return new Response(generateRuntimeModule(), {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'no-store, must-revalidate',
        },
      })
    }

    // Get relative path from URL
    let relativePath = url.pathname.replace(/^\/+/, '')

    // Check if this path matches our include pattern
    if (!include.test(relativePath)) {
      // Check if it's an HTML file we should inject into
      // (HTML files outside our include pattern still need the HMR client)
      let response = await next()

      // Inject HMR initialization into HTML responses
      if (response.headers.get('Content-Type')?.includes('text/html')) {
        let html = await response.text()

        // HMR runtime script - auto-connects when loaded (like Vite)
        let hmrScript = `<script type="module" src="${HMR_RUNTIME_PATH}"></script>`

        // Insert before first <script> tag or before </head>
        if (html.includes('<script')) {
          html = html.replace('<script', hmrScript + '\n<script')
        } else if (html.includes('</head>')) {
          html = html.replace('</head>', hmrScript + '\n</head>')
        }

        // Build new headers, removing Content-Length (will be recalculated)
        let newHeaders = new Headers(response.headers)
        newHeaders.delete('Content-Length')
        newHeaders.set('Content-Type', 'text/html; charset=utf-8')
        newHeaders.set('Cache-Control', 'no-cache')

        return new Response(html, {
          status: response.status,
          headers: newHeaders,
        })
      }

      return response
    }

    // This path matches include - get response from static-middleware
    let response = await next()

    // Don't transform error responses
    if (!response.ok) {
      return response
    }

    // Only transform JavaScript files
    let contentType = response.headers.get('Content-Type') ?? ''
    if (!contentType.includes('javascript')) {
      return response
    }

    let moduleUrl = '/' + relativePath
    log(`Transforming ${moduleUrl}...`)

    // Read the response body
    let source = await response.text()

    // Track imports for the module graph
    trackImports(graph, moduleUrl, source)

    // Check if excluded from HMR transforms
    let isExcluded = exclude?.test(relativePath) ?? false

    // Transform if it's a component and not excluded
    if (!isExcluded && maybeHasComponent(source)) {
      log(`  → Marked as component (HMR boundary)`)
      markAsComponent(graph, moduleUrl)

      // Transform the component for HMR
      let result = await transformComponent(source, moduleUrl)
      source = result.code

      // Inline the source map if generated
      if (result.map) {
        let mapBase64 = Buffer.from(result.map).toString('base64')
        source += `\n//# sourceMappingURL=data:application/json;base64,${mapBase64}`
      }
    }

    // Rewrite imports with timestamps for changed dependencies
    source = rewriteImports(graph, source, moduleUrl)

    // Build new headers, stripping headers that no longer apply after transformation
    let newHeaders = new Headers(response.headers)
    newHeaders.delete('Content-Length') // Content size changed
    newHeaders.delete('ETag') // Hash no longer matches transformed content
    // Keep Last-Modified - it's still valid (transform is deterministic)
    newHeaders.set('Cache-Control', 'no-store, must-revalidate')

    return new Response(source, {
      status: response.status,
      headers: newHeaders,
    })
  }
}

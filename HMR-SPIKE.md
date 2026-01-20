# HMR Spike

An exploration of Hot Module Replacement for Remix 3's bundler-free ESM architecture.

> **Document Structure:** This document is organized into three sections:
>
> 1. **The Plan** (Problem → Solution → Implementation) — Always clean and up-to-date. Should be shareable with others at any time.
> 2. **Design Decisions** — Architectural choices and their rationale. Updated as decisions are made.
> 3. **Development Log** (Appendix) — Session notes, brain dumps, learnings, and progress tracking. This is where we capture the messy exploration work without cluttering the plan.
>
> When working on this spike, keep the plan focused on _what_ and _why_. Put the _how we got here_ in the dev log.
>
> **Task Numbering:** Unfinished tasks can be renumbered or regrouped as understanding evolves. Once a task is complete, keep its number stable so we don't lose our bearings when referencing past work.

## The Problem

Remix 3 serves real ES modules to the browser without bundling. This is great for simplicity and debugging, but creates a DX gap: when you edit a component, you need to refresh the browser to see changes.

Traditional HMR relies on:

1. Build-time transforms to inject HMR code
2. Module bundling that allows swapping module contents
3. Framework-specific integrations (React Refresh) that can swap component internals

We want HMR without:

- Changing the component model
- Requiring a bundler
- Altering production behavior

## The Core Insight

Remix components have a two-phase structure:

```tsx
function Counter(handle: Handle) {
  // SETUP PHASE - runs once, creates closure state
  let count = 0

  // RENDER PHASE - returned function, runs on every update
  return () => <button>{count}</button>
}
```

The problem with naive HMR: when you re-import a module, calling the new `Counter` function creates a **new closure** with fresh state. The old `count` sitting at 5 is in a different closure than the new `count` at 0.

## The Solution: State Hoisting + Render Proxy

### 1. Hoist State to WeakMap

Transform setup variables to live in a WeakMap keyed by handle:

```tsx
// Original
let count = 0

// Transformed (dev only)
let __s = __hmr_state(handle) // WeakMap lookup
__s.count ??= 0
```

Now state survives across HMR because it's in the stable WeakMap, not in a closure.

### 2. Render Function Proxy

Instead of returning the render function directly, return a proxy that delegates to a registry:

```tsx
// Transformed
function Counter(handle: Handle) {
  let __s = __hmr_state(handle)

  // Check if setup changed (hash comparison)
  if (
    __hmr_setup(handle, __s, 'hash123', () => {
      __s.count = 0
    })
  ) {
    __hmr_request_remount(handle)
    return () => null
  }

  // Register the REAL render function
  __hmr_register('/app/Counter.tsx', 'Counter', handle, () => <button>{__s.count}</button>)

  // Return a proxy that looks up current render
  return () => __hmr_call(handle)
}
```

### 3. HMR Update Flow

1. File changes → server notifies client via SSE (Server-Sent Events)
2. Client re-imports module with cache-busting `?t=timestamp`
3. For each handle from that module:
   - Call new component function with existing handle
   - State preserved via `??=` pattern
   - New render function registered
   - Call `handle.update()` to trigger re-render
4. Remix calls the proxy (which it's been holding all along)
5. Proxy delegates to registry → new render function executes

**Key insight**: Remix never knows anything changed. It's holding the same proxy function reference.

### 4. Setup Hash Safety

If setup code changes (variables added/removed/renamed), the `??=` pattern might not behave correctly. Solution:

1. Hash the setup scope code during transform
2. On HMR, compare old hash to new hash
3. If same → safe render swap with state preservation
4. If different → full remount via `requestRemount(handle)` (state lost, but safe)

---

## Implementation Plan

### Phase 1: Middleware Foundation ✅

Build the core transform and runtime injection.

| Task | Description                        | Status |
| ---- | ---------------------------------- | ------ |
| 1.1  | Source file + middleware transform | ✅     |
| 1.2  | Middleware injects HMR runtime     | ✅     |
| 1.3  | JSX globals injection              | ✅     |
| 1.4  | Setup hash + `requestRemount` API  | ✅     |

**Outcome:** Clean source files (no HMR code), transform applied at serve time, HMR runtime injected into HTML.

---

### Phase 2: Module Graph ✅

Track imports to propagate changes through dependencies.

| Task | Description                           | Status |
| ---- | ------------------------------------- | ------ |
| 2.0  | Validate import freshness mechanism   | ✅     |
| 2.1  | Import tracking + timestamps          | ✅     |
| 2.2  | Find affected components (graph walk) | ✅     |
| 2.3  | Full import propagation flow          | ✅     |

**Key Discovery:** Browser caches modules by URL. Solution: rewrite import paths with timestamps for changed dependencies.

**Outcome:** Editing `utils.ts` correctly identifies and updates all components that import it.

---

### Phase 3: Automatic Updates ✅

File watching and notifications to complete the HMR loop. (Originally WebSocket, migrated to SSE in Phase 4.)

| Task | Description                                | Status |
| ---- | ------------------------------------------ | ------ |
| 3.1  | File watcher + notification infrastructure | ✅     |
| 3.2  | E2E test infrastructure (Playwright)       | ✅     |
| 3.3  | Fix: remount uses old code                 | ✅     |
| 3.4  | Fix: import propagation not triggering     | ✅     |
| 3.5  | Manual sanity check                        | ✅     |

**E2E Test Status:** All 4 tests passing.

**Key Fix (Task 3.3):** The `__hmr_update` function was incorrectly calling `__hmr_register_component` with the wrapper function, overwriting the correct impl that was registered when the module loaded. Removing this redundant call fixed both the remount bug and import propagation.

---

### Phase 4: Generalization ✅

| Task | Description                                    | Status |
| ---- | ---------------------------------------------- | ------ |
| 4.1  | AST-based transform (SWC)                      | ✅     |
| 4.2  | Transform tests with Prettier-based comparison | ✅     |
| 4.3  | SSE instead of WebSocket                       | ✅     |

**4.1 Notes:** Initially used OXC parser, but migrated to SWC for better AST manipulation capabilities. The transform uses SWC to parse the code, extract component metadata, and generate HMR-wrapped code via string slicing. Tests use Prettier normalization for output comparison.

**4.3 Notes:** Replaced WebSocket with Server-Sent Events (SSE). SSE is just HTTP with `Content-Type: text/event-stream`, fitting perfectly into the middleware pattern. No more `attach(server)` required - HMR is now pure middleware. Client uses `EventSource` with built-in reconnection.

---

### Phase 5: Standalone HMR Middleware (Current)

**Key Insight:** Bundling HMR into `static-dev-middleware` was convenient but conceptually muddy. HMR needs knowledge of:

1. The filesystem (to watch for changes)
2. The build output (to know what files to transform)
3. The build configuration (to know what to exclude)

This makes `static-dev-middleware` a "half solution" that conflates two concerns. A standalone `@remix-run/hmr-middleware` that composes with `@remix-run/static-middleware` is cleaner.

**New API:**

```typescript
import { hmr } from '@remix-run/hmr-middleware'
import { staticFiles } from '@remix-run/static-middleware'

let router = createRouter({
  middleware: [
    hmr('./public', {
      include: /^app\//, // Only transform files in app/ directory
      exclude: /chunk-/, // Skip chunks (default)
    }),
    staticFiles('./public'),
  ],
})
```

**Benefits:**

- Single responsibility - HMR middleware just does HMR
- Composable - Works with any static file middleware
- Consistent API - `root` matches static-middleware, `include`/`exclude` both match relative paths
- Honest - Doesn't pretend to be a "dev version" of static-middleware

| Task | Description                                          | Status  |
| ---- | ---------------------------------------------------- | ------- |
| 5.1  | Create `@remix-run/hmr-middleware` package structure | ✅ Done |
| 5.2  | Copy hmr-spike to hmr-middleware-spike demo          | ✅ Done |
| 5.3  | Implement HMR middleware with new API                | ✅ Done |
| 5.4  | Add E2E tests for hmr-middleware                     | ✅ Done |
| 5.5  | Verify hmr-middleware-spike demo works               | ✅ Done |
| 5.6  | Clean up static-dev-middleware and hmr-spike         | ✅ Done |

---

### Phase 6: Future Enhancements

| Task | Description                                     | Status                          |
| ---- | ----------------------------------------------- | ------------------------------- |
| 6.1  | Inline source maps                              | ✅ Done                         |
| 6.2  | Multiple components per module                  | ✅ Done                         |
| 6.3  | Setup prop handling                             | Pending                         |
| 6.4  | Explore assets-middleware (esbuild integration) | Deferred - see Design Decisions |

**6.1 Notes:** esbuild configured with `sourcemap: 'inline'` in dev, SWC transform uses `swc.print()` with `sourceMaps: true` and `inputSourceMap` to chain source maps through the transform. Debugging works in browser devtools.

**6.2 Notes:** Multi-component modules work out of the box. The transform iterates all module items, each component gets its own `__impl` function and registry entry keyed by `moduleUrl::componentName`. When a module changes, HMR notifies the client which component(s) updated. Unit tests and E2E tests verify Header/Footer components in same file update independently.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Developer Saves File                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     HMR Middleware                           │
│  • File watcher detects change                               │
│  • Module graph: "who imports this?" → find components       │
│  • Sends SSE: { files: ['/app/Counter.js'] }                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      HMR Client                              │
│  • Receives SSE message via EventSource                      │
│  • Re-imports affected modules with ?t=timestamp             │
│  • Calls component(existingHandle)                           │
│  • Calls handle.update()                                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Remix Runtime                             │
│  • Calls render function (the proxy)                         │
│  • Proxy delegates to registry → new code executes           │
│  • DOM updates                                               │
└─────────────────────────────────────────────────────────────┘
```

### File Structure (Target)

```
packages/hmr-middleware/
  src/
    index.ts              # hmr(root, options) - only public API
    lib/
      transform.ts        # SWC-based AST transform (async)
      client.ts           # generateClientScript() + EventSource client
      module-graph.ts     # Import tracking + graph walking
      watcher.ts          # File watching (chokidar)
      sse.ts              # Server-Sent Events (pure HTTP streaming)
  test/
    e2e/
      hmr.e2e.test.ts     # Playwright E2E tests
      test-server.ts      # Test server with esbuild + HMR
    fixtures/
      app/Counter.tsx     # Test component source
      app/utils.ts        # Test utility source
      public/             # Built output

demos/hmr-middleware-spike/
  server.ts               # Demo server (esbuild + hmr-middleware + static-middleware)
  app/
    entry.tsx             # App entry (clean, no HMR code)
    Counter.tsx           # Normal component (clean)
    utils.ts              # Utility for testing propagation
  public/                 # Built output (gitignored)

# Current Implementation
packages/hmr-middleware/          # HMR middleware package
demos/hmr-middleware-spike/       # Demo showing HMR + static middleware composition
```

---

## Design Decisions

### Server-Side HMR: Out of Scope

**Current behavior:** Dev server uses `tsx watch`, which restarts on file changes. Slow but functional.

**Why we're deferring:** Client HMR is the big win (preserving UI state). Server restart doesn't affect client state. Adding server HMR is architecturally separate and can be done later.

### Package Structure: Standalone HMR Middleware

**Decision:** `@remix-run/hmr-middleware` as a separate composable middleware, used alongside `@remix-run/static-middleware`.

**Why:**

- **Single responsibility** - HMR is a distinct concern from static file serving
- **Composable** - Works with any static file serving approach
- **Explicit** - Users consciously add HMR, configure it for their build
- **Consistent API** - `root` parameter matches static-middleware, `include`/`exclude` both operate on relative paths

```typescript
import { hmr } from '@remix-run/hmr-middleware'
import { staticFiles } from '@remix-run/static-middleware'

let isDev = process.env.NODE_ENV !== 'production'

let router = createRouter({
  middleware: [
    // HMR intercepts matching files, transforms them, handles /@remix/hmr
    ...(isDev ? [hmr('./public', { include: /^app\// })] : []),
    // Static serves everything else
    staticFiles('./public'),
  ],
})
```

**Previous approach:** `static-dev-middleware` bundled HMR into file serving. This was convenient but conflated concerns and required awkward configuration (e.g., `hmrTransformExclude`) that leaked build knowledge into the middleware.

### SSE over WebSocket

**Decision:** Use Server-Sent Events instead of WebSocket for HMR notifications.

**Why:**

- SSE is standard HTTP (`text/event-stream`), fits perfectly into middleware pattern
- No special server setup required (no `attach(server)`)
- `EventSource` has built-in reconnection
- Simpler implementation, fewer dependencies

**Current API:**

```typescript
let staticFiles = createStaticFilesMiddleware({ ... })
router.use(staticFiles.middleware)
// That's it - HMR just works via /@remix/hmr endpoint
```

### esbuild: Stays in App Server

**Current architecture:**

- App server runs esbuild to transform TSX→JS
- Middleware serves the built JS files with HMR transforms applied at serve-time
- Middleware needs to know which files to transform (components) vs skip (chunks)

**Why:** Keeps middleware focused on HMR. Integrating esbuild into middleware is deferred (see below).

### Assets Middleware: Deferred

**Explored:** Integrating esbuild directly into middleware (like the previous `assets-middleware` experiment).

**Challenge:** On-demand compilation of individual files creates a dependency pre-bundling problem. How do you compile a single app file when it imports npm packages that need to be resolved?

**Current approach:** Keep esbuild in the app's build step, make middleware configurable to handle different output patterns (e.g., `skipTransform` option for chunk files).

**Future:** May revisit if a clean solution emerges for the dependency pre-bundling challenge.

---

## Appendix: Development Log

### Session 1: Design + Manual Validation

- Identified closure problem with Remix components
- Designed state hoisting + proxy pattern
- Created manual prototype in `demos/hmr-spike`
- **Proved:** State hoisting works, proxy pattern works with Remix runtime

### Session 2-3: Phase 1 Complete

- Created `@remix-run/hmr-middleware` package
- Moved transform to middleware (source files stay clean)
- Moved HMR runtime to middleware (injected into HTML)
- Added JSX globals injection

### Session 4: Phase 1 Foundation Complete

- Added `requestRemount(handle)` to `@remix-run/component`
- Implemented setup hash checking
- Changed from `handle.__hmr` to WeakMap-based state
- 9 HMR integration tests passing

### Session 5: Phase 2 Complete

- Validated import freshness mechanism (discovered browser caching issue)
- Implemented module graph with import tracking
- Implemented import rewriting with timestamps
- 34 module graph tests passing

### Session 6: Phase 3 Complete

- Added chokidar for file watching
- Added ws for WebSocket server
- Created `static-dev-middleware` package
- Migrated all code from `hmr-middleware`
- Set up Playwright E2E tests in middleware package
- **Bug found:** `__hmr_update` was overwriting impl with wrapper
- **Fix:** Remove redundant `__hmr_register_component` call from `__hmr_update`
- All 4 E2E tests passing, 51 unit tests passing
- Manual sanity check passed ✅

**HMR now works end-to-end:**

- Edit component → state preserved
- Edit setup scope → remounts with NEW code
- Edit imported file → propagates to components
- Cleanup works correctly on remount

### Session 7: Phase 4.1 - SWC Transform

- Started with OXC parser for AST-based transform
- OXC lacks codegen/visitor API in JS - only string manipulation possible
- Explored SWC as alternative for proper AST manipulation + source maps
- Initial implementation used global `spanOffset` variable (wrong approach)
- Implemented `transformComponentSwc` using SWC parse + string slicing
- All 9 transform unit tests passing, all 4 E2E tests passing

### Session 8: SWC Cleanup + Async APIs

**Investigation into SWC span behavior:**

- SWC spans accumulate across parse calls in the same process (intentional for multi-file support)
- **Wrong approach:** Global mutable `spanOffset` variable with "first non-whitespace" heuristic
- **Correct approach:** Use `ast.span.start` as the base offset for each parse call (local, not global)

**Performance improvement:**

- Switched from `parseSync()` to `parse()` for non-blocking transforms
- Dev server shouldn't block event loop while transforming files
- Added both async and sync versions of all transform functions
- Tests use sync versions, servers use async versions

**Changes:**

- Removed global `spanOffset` state
- Added `baseOffset` parameter passed to extraction functions
- Switched to async-only transform API
- All 43 unit tests passing, all 4 E2E tests passing

### Session 9: API Cleanup

**Key realization:** The `/hmr` subpath export was scaffolding for iteration, not a public API. Consumers should use `createStaticFilesMiddleware()` and nothing else.

**Changes:**

- Removed `/hmr` subpath from package.json exports
- Deleted `src/hmr.ts` entry point
- Simplified to async-only transform (removed sync versions)
- Transform returns `{ code, map }` (PreparedResult pattern)
- E2E test server and demo use internal imports (not public API)
- Only public export: `createStaticFilesMiddleware()`

**Architecture clarification:**

- The middleware encapsulates all HMR logic
- Demo uses custom esbuild pipeline, so it imports internal modules directly
- This is fine - the demo is a proof-of-concept, not a reference implementation

### Session 10: SSE Migration + esbuild Splitting

**SSE replaces WebSocket:**

- Replaced `ws` library with native `ReadableStream` for Server-Sent Events
- Removed `attach(server)` method - HMR is now pure middleware
- Client uses `EventSource` with built-in reconnection
- Much simpler implementation, fewer dependencies

**esbuild splitting:**

- Changed demo to use `--bundle --splitting` to produce ES modules
- Each source file → entry point, npm packages → chunks
- Added `skipTransform` check for chunk files (pattern: `/^chunk-/`)

**Explored assets-middleware rearchitecture:**

- Investigated integrating esbuild directly into middleware (like old `assets-middleware` commit)
- Hit complexity wall: on-demand compilation creates dep pre-bundling problem
- **Decision:** Defer. Keep esbuild in app's build step, make middleware configurable instead.

### Session 11: Configuration Improvements

**Pivot from assets-middleware to configurability:**

- Instead of full esbuild integration, add `skipTransform` config option
- Document the esbuild contract clearly
- Allows custom build setups while keeping HMR working

**Added:** `hmrTransformExclude` config option to `static-dev-middleware`

- RegExp pattern to exclude files from HMR transformation
- Default: `/^chunk-/` (works with esbuild `--splitting`)
- All unit tests (45) and E2E tests (4) passing

### Session 12: Architectural Pivot to Standalone HMR Middleware (Current)

**Key realization:** Bundling HMR into `static-dev-middleware` is a "half solution":

- HMR needs knowledge of filesystem, build output, AND build configuration
- Config like `hmrTransformExclude` leaks build knowledge into file serving
- Two concerns conflated: serving files vs. HMR transformations

**Decision:** Create standalone `@remix-run/hmr-middleware` that:

- Has single responsibility (just HMR)
- Composes with any static file middleware
- Uses consistent API (`root` matches static-middleware, `include`/`exclude` operate on relative paths)

**New API:**

```typescript
hmr('./public', {
  include: /^app\//, // Only transform files in app/ directory
  exclude: /chunk-/, // Skip chunks (default)
})
```

**Approach:**

1. Build `hmr-middleware` alongside existing `static-dev-middleware` (as reference)
2. Create `hmr-middleware-spike` demo alongside existing `hmr-spike`
3. Validate everything works
4. Clean up old implementation after confirmation

**Next:** Create `@remix-run/hmr-middleware` package structure (Task 5.1)

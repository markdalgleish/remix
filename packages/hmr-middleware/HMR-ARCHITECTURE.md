# HMR Architecture

This document explains how Hot Module Replacement works for Remix components. It's written in enough detail that you could implement it yourself.

## Table of Contents

1. [The Problem](#the-problem)
2. [The Two-Phase Component Model](#the-two-phase-component-model)
3. [Architecture Overview](#architecture-overview)
4. [Walkthrough: Page Load](#walkthrough-page-load)
5. [Walkthrough: Changing a Component's Render Body](#walkthrough-changing-a-components-render-body)
6. [Walkthrough: Changing a Component's Setup Scope](#walkthrough-changing-a-components-setup-scope)
7. [Walkthrough: Changing a Dependency](#walkthrough-changing-a-dependency)
8. [The Transform in Detail](#the-transform-in-detail)
9. [The Module Graph](#the-module-graph)
10. [The Runtime](#the-runtime)
11. [Source Maps](#source-maps)

---

## The Problem

Remix components have a unique two-phase structure:

```tsx
function Counter(handle) {
  // SETUP PHASE - runs once when component mounts
  let count = 0
  
  // RENDER PHASE - runs every time we need to render
  return () => (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => { count++; handle.update() }}>
        Increment
      </button>
    </div>
  )
}
```

The challenge: if we hot-replace this module, the `count` variable resets to `0` because the setup phase runs again. We want to:

1. **Preserve state** when only the render body changes
2. **Remount** when the setup scope changes (new variables, different initialization)
3. **Propagate changes** from dependencies up to the nearest component boundary

---

## The Two-Phase Component Model

Understanding this model is crucial for understanding HMR:

```
┌─────────────────────────────────────────────────────────────┐
│  function Counter(handle) {                                  │
│                                                              │
│    ┌───────────────────────────────────────────────────┐    │
│    │  SETUP PHASE (runs once)                          │    │
│    │                                                   │    │
│    │  let count = 0                                    │    │
│    │  let doubled = () => count * 2                    │    │
│    └───────────────────────────────────────────────────┘    │
│                                                              │
│    return () => (                                            │
│      ┌─────────────────────────────────────────────────┐    │
│      │  RENDER PHASE (runs on every render)            │    │
│      │                                                 │    │
│      │  <div>{count} × 2 = {doubled()}</div>           │    │
│      └─────────────────────────────────────────────────┘    │
│    )                                                         │
│  }                                                           │
└─────────────────────────────────────────────────────────────┘
```

The setup phase creates **closure state** that the render function captures. This state lives for the lifetime of the component instance.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                           BROWSER                                     │
│                                                                       │
│  ┌─────────────┐     ┌──────────────┐     ┌───────────────────────┐  │
│  │   HTML      │────▶│  HMR Runtime │────▶│  Transformed          │  │
│  │   Page      │     │  (SSE client)│     │  Components           │  │
│  └─────────────┘     └──────────────┘     └───────────────────────┘  │
│         │                   ▲                       │                 │
│         │                   │ SSE                   │ import          │
│         │                   │                       ▼                 │
└─────────│───────────────────│───────────────────────│─────────────────┘
          │                   │                       │
          │ request           │                       │ request
          ▼                   │                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                           SERVER                                      │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    HMR Middleware                             │    │
│  │                                                               │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │    │
│  │  │  File       │  │  Module     │  │  SSE        │           │    │
│  │  │  Watcher    │  │  Graph      │  │  Endpoint   │           │    │
│  │  │  (chokidar) │  │             │  │             │           │    │
│  │  └──────┬──────┘  └─────────────┘  └─────────────┘           │    │
│  │         │                                                     │    │
│  │         │ file change                                         │    │
│  │         ▼                                                     │    │
│  │  ┌─────────────────────────────────────────────────────────┐ │    │
│  │  │  Transform Layer                                        │ │    │
│  │  │  - Injects HMR runtime into HTML                        │ │    │
│  │  │  - Transforms components with SWC                       │ │    │
│  │  │  - Rewrites imports with timestamps                     │ │    │
│  │  └─────────────────────────────────────────────────────────┘ │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                │                                      │
│                                ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                  Static Files Middleware                      │    │
│  │                  (serves actual files)                        │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

Key components:

1. **HMR Middleware** - Intercepts requests, transforms responses
2. **File Watcher** - Detects file changes on disk
3. **Module Graph** - Tracks import relationships between files
4. **Transform** - Rewrites component code for HMR support
5. **SSE Endpoint** - Pushes updates to connected browsers
6. **HMR Runtime** - Client-side code that handles updates

---

## Walkthrough: Page Load

Let's trace what happens when a browser loads an HTML page.

### Step 1: Browser requests HTML

```
GET /index.html
```

### Step 2: HMR middleware intercepts the response

The static files middleware returns the original HTML:

```html
<!DOCTYPE html>
<html>
  <head>
    <title>My App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/assets/entry.js"></script>
  </body>
</html>
```

The HMR middleware injects the runtime script **before the first `<script>` tag**:

```html
<!DOCTYPE html>
<html>
  <head>
    <title>My App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/@remix/hmr/runtime.js"></script>
    <script type="module" src="/assets/entry.js"></script>
  </body>
</html>
```

### Step 3: Browser loads the HMR runtime

```
GET /@remix/hmr/runtime.js
```

The HMR middleware serves a generated JavaScript module that:

1. Exports HMR helper functions (`__hmr_state`, `__hmr_setup`, etc.)
2. Automatically connects to the SSE endpoint at `/@remix/hmr`
3. Listens for update messages and re-imports changed modules

The runtime immediately connects:

```
[HMR] Connecting to http://localhost:44100/@remix/hmr
[HMR] Connected
[HMR] Runtime loaded
```

### Step 4: Browser loads entry.js

```
GET /assets/entry.js
```

Entry files aren't typically components, so they pass through with minimal transformation (just import rewriting for any changed dependencies).

### Step 5: Entry imports Counter.js

```
GET /assets/Counter.js
```

The static middleware returns the esbuild output:

```javascript
// Original Counter.js (from esbuild)
import { jsx } from "@remix-run/component/jsx-runtime";

export function Counter(handle) {
  let count = 0;
  return () => jsx("div", { children: count });
}
```

The HMR middleware detects this is a component (PascalCase function returning a function) and transforms it:

```javascript
// Transformed Counter.js
import {
  __hmr_state,
  __hmr_setup,
  __hmr_register,
  __hmr_call,
  __hmr_request_remount,
  __hmr_register_component,
  __hmr_get_component,
} from '/@remix/hmr/runtime.js'

import { jsx } from "@remix-run/component/jsx-runtime";

function Counter__impl(handle) {
  let __s = __hmr_state(handle);
  if (__hmr_setup(handle, __s, 'hmbue7w', () => {
    __s.count = 0;
  })) {
    __hmr_request_remount(handle);
    return () => null;
  }
  __hmr_register('/assets/Counter.js', 'Counter', handle, () => 
    jsx("div", { children: __s.count })
  );
  return () => __hmr_call(handle);
}

__hmr_register_component('/assets/Counter.js', 'Counter', Counter__impl);

export function Counter(handle) {
  let impl = __hmr_get_component('/assets/Counter.js', 'Counter');
  return impl(handle);
}
```

**What changed:**

1. Setup variables moved to `__s` (a stable state object per handle)
2. Setup code wrapped in `__hmr_setup` with a hash
3. Render body references `__s.count` instead of `count`
4. Component registers itself with the HMR runtime
5. Exported function delegates to current implementation

### Step 6: Component renders

When Remix calls `Counter(handle)`:

1. The exported `Counter` calls `__hmr_get_component` to get `Counter__impl`
2. `Counter__impl` gets/creates a state object for this handle
3. First render: setup runs, hash stored, render function registered
4. Returns a proxy that calls `__hmr_call` when invoked
5. `__hmr_call` invokes the registered render function

---

## Walkthrough: Changing a Component's Render Body

Now let's see what happens when you edit the render body.

### Before (source file):

```tsx
function Counter(handle) {
  let count = 0
  return () => <div>Count: {count}</div>
}
```

### After (source file):

```tsx
function Counter(handle) {
  let count = 0
  return () => <div>Current count: {count}!</div>  // Changed text
}
```

### Step 1: File watcher detects change

The watcher (chokidar) fires with the file path and timestamp:

```
[HMR] File changed: assets/Counter.js
```

### Step 2: Find affected components

The module graph tracks that `Counter.js` is a component file (HMR boundary). Since the changed file IS a component, it's the affected component:

```
[HMR]   → Affected components: /assets/Counter.js
```

### Step 3: Notify clients via SSE

The server sends an SSE message:

```json
{
  "type": "update",
  "files": ["/assets/Counter.js"],
  "timestamp": 1705123456789
}
```

### Step 4: Client receives update

The HMR runtime logs:

```
[HMR] Received update for: ["/assets/Counter.js"]
[HMR] Re-importing /assets/Counter.js?t=1705123456789
```

### Step 5: Browser re-imports the module

```
GET /assets/Counter.js?t=1705123456789
```

The timestamp query parameter busts the browser cache.

### Step 6: Transform calculates setup hash

The transform computes a hash of the setup code:

```javascript
// Setup code: "let count = 0"
// Hash: 'hmbue7w' (unchanged!)
```

**The hash is the same** because the setup scope didn't change.

### Step 7: New module executes

When the new module loads:

1. `__hmr_register_component` updates the registry with new `Counter__impl`
2. The runtime calls the new component function for each existing handle:

```javascript
// For each existing Counter instance:
newComponentFn(handle)  // Re-runs Counter__impl
handle.update()         // Triggers re-render
```

### Step 8: Component updates without remounting

Inside `Counter__impl`:

```javascript
let __s = __hmr_state(handle);  // Gets EXISTING state object

if (__hmr_setup(handle, __s, 'hmbue7w', () => { ... })) {
  // Hash matches! Returns false, setup is SKIPPED
}

// Registers NEW render function with existing __s.count
__hmr_register('/assets/Counter.js', 'Counter', handle, () =>
  jsx("div", { children: "Current count: " + __s.count + "!" })  // New UI
);
```

**Result:** The UI updates with new text, but `count` keeps its value!

---

## Walkthrough: Changing a Component's Setup Scope

What if you change the setup code?

### Before:

```tsx
function Counter(handle) {
  let count = 0
  return () => <div>Count: {count}</div>
}
```

### After:

```tsx
function Counter(handle) {
  let count = 100  // Changed initial value!
  return () => <div>Count: {count}</div>
}
```

### Step 1-5: Same as before

File changes, SSE notification, browser re-imports.

### Step 6: Transform calculates NEW setup hash

```javascript
// Old setup: "let count = 0"   → hash: 'hmbue7w'
// New setup: "let count = 100" → hash: 'h2f9k3x'  // DIFFERENT!
```

### Step 7: Component detects setup change

Inside `Counter__impl`:

```javascript
let __s = __hmr_state(handle);  // Gets existing state

if (__hmr_setup(handle, __s, 'h2f9k3x', () => { ... })) {
  // Hash DIFFERS from stored hash!
  // Returns true, signaling remount needed
  console.warn('[HMR] Setup scope changed, component will remount');
  __hmr_request_remount(handle);  // Tell Remix to remount
  return () => null;  // Return noop for this cycle
}
```

### Step 8: Component remounts

`__hmr_request_remount` tells the Remix runtime to:

1. Unmount the old component instance
2. Create a fresh handle
3. Mount the component again

On the fresh mount:

```javascript
let __s = __hmr_state(handle);  // NEW state object (empty)

if (__hmr_setup(handle, __s, 'h2f9k3x', () => {
  __s.count = 100;  // Setup runs with new value
})) {
  // First run, hash stored, returns false
}
// Component continues with count = 100
```

**Result:** Component remounts with `count = 100`.

---

## Walkthrough: Changing a Dependency

What happens when you change a file that a component imports?

### File structure:

```
/assets/Counter.js    (component - imports utils.js)
/assets/utils.js      (utility - formatCount function)
```

### utils.js before:

```javascript
export function formatCount(n) {
  return `Count: ${n}`
}
```

### utils.js after:

```javascript
export function formatCount(n) {
  return `Total: ${n}`  // Changed label
}
```

### Step 1: File watcher detects change

```
[HMR] File changed: assets/utils.js
```

### Step 2: Walk the module graph

The module graph knows:

```
/assets/utils.js is imported by → /assets/Counter.js
/assets/Counter.js is a component (HMR boundary)
```

The graph walker:

1. Starts at `utils.js`
2. `utils.js` is NOT a component, so bubble up to importers
3. `Counter.js` IS a component → stop here, add to affected list

```
[HMR]   → Affected components: /assets/Counter.js
```

### Step 3: Mark dependency as changed

The graph stores:

```javascript
changeTimestamps.set('/assets/utils.js', 1705123456789)
```

### Step 4: Notify client (same as before)

SSE sends update for `Counter.js`.

### Step 5: Client re-imports Counter.js

```
GET /assets/Counter.js?t=1705123456789
```

### Step 6: Import rewriting kicks in

The HMR middleware transforms Counter.js. When it sees:

```javascript
import { formatCount } from './utils.js'
```

It checks if `utils.js` has a change timestamp. It does! So it rewrites:

```javascript
import { formatCount } from './utils.js?t=1705123456789'
```

### Step 7: Browser fetches fresh utils.js

Because the import URL changed, the browser fetches:

```
GET /assets/utils.js?t=1705123456789
```

**Result:** Counter gets the new `formatCount` function, and since setup scope didn't change, state is preserved.

---

## The Transform in Detail

The transform operates on JavaScript (post-esbuild), not TypeScript source.

### Detection

A function is detected as a component if:

1. It has a PascalCase name (`Counter`, `UserProfile`, etc.)
2. It returns a function expression (arrow or regular)

Supported patterns:

```javascript
// Function declaration
function Counter(handle) { return () => ... }

// Const with function expression
const Counter = function(handle) { return () => ... }

// Const with arrow function (block body)
const Counter = (handle) => { return () => ... }

// Const with arrow function (expression body)
const Counter = (handle) => () => ...
```

### Transformation Steps

Given this input:

```javascript
export function Counter({ signal, params }) {
  let count = 0
  let label = 'clicks'
  
  return () => (
    <div>{count} {label}</div>
  )
}
```

The transform:

**1. Add HMR runtime import:**

```javascript
import {
  __hmr_state,
  __hmr_setup,
  __hmr_register,
  __hmr_call,
  __hmr_request_remount,
  __hmr_register_component,
  __hmr_get_component,
} from '/@remix/hmr/runtime.js'
```

**2. Extract setup variables:**

```javascript
// Found: count, label
```

**3. Compute setup hash:**

```javascript
// Code: "let count = 0\nlet label = 'clicks'"
// Hash: 'h7k2m9p'
```

**4. Generate implementation function:**

```javascript
function Counter__impl({ signal, params }) {
  // Get stable state object for this handle
  let __s = __hmr_state({ signal, params });
  
  // Check if setup needs to run
  if (__hmr_setup({ signal, params }, __s, 'h7k2m9p', () => {
    // Setup assignments (only run on first mount or after remount)
    __s.count = 0;
    __s.label = 'clicks';
  })) {
    // Setup hash changed - request remount
    __hmr_request_remount({ signal, params });
    return () => null;
  }
  
  // Register render function (uses __s.* instead of local vars)
  __hmr_register('/assets/Counter.js', 'Counter', { signal, params }, () =>
    <div>{__s.count} {__s.label}</div>
  );
  
  // Return proxy that calls registered render
  return () => __hmr_call({ signal, params });
}
```

**5. Register implementation:**

```javascript
__hmr_register_component('/assets/Counter.js', 'Counter', Counter__impl);
```

**6. Generate delegating wrapper:**

```javascript
export function Counter({ signal, params }) {
  let impl = __hmr_get_component('/assets/Counter.js', 'Counter');
  return impl({ signal, params });
}
```

The wrapper is what Remix imports and holds. When HMR updates, `__hmr_get_component` returns the NEW implementation, but Remix doesn't need to re-import.

---

## The Module Graph

The module graph tracks relationships between files.

### Data Structures

```typescript
interface ModuleGraph {
  // Reverse deps: file → who imports it
  importedBy: Map<string, Set<string>>
  
  // Forward deps: file → what it imports
  imports: Map<string, Set<string>>
  
  // When each file last changed
  changeTimestamps: Map<string, number>
  
  // Which files are components (HMR boundaries)
  componentFiles: Set<string>
}
```

### Building the Graph

When a JS file is served, we parse its imports:

```javascript
// Counter.js
import { jsx } from '@remix-run/component/jsx-runtime'
import { formatCount } from './utils.js'
```

We extract local imports (starting with `./` or `../`):

```javascript
imports.set('/assets/Counter.js', new Set(['/assets/utils.js']))
importedBy.set('/assets/utils.js', new Set(['/assets/Counter.js']))
```

### Finding Affected Components

When `utils.js` changes:

```javascript
function findAffectedComponents(graph, changedFile) {
  let affected = new Set()
  let queue = [changedFile]
  
  while (queue.length > 0) {
    let file = queue.shift()
    
    // If this is a component, it's a boundary - stop here
    if (graph.componentFiles.has(file)) {
      affected.add(file)
      continue  // Don't bubble further
    }
    
    // Otherwise, bubble up to all importers
    let importers = graph.importedBy.get(file)
    if (importers) {
      queue.push(...importers)
    }
  }
  
  return [...affected]
}
```

### Import Rewriting

When serving a module, rewrite imports for changed dependencies:

```javascript
// If utils.js changed at timestamp 123456:
import { formatCount } from './utils.js'
// becomes:
import { formatCount } from './utils.js?t=123456'
```

This forces the browser to fetch the fresh version.

---

## The Runtime

The HMR runtime runs in the browser. It's served as an ES module at `/@remix/hmr/runtime.js`.

### State Storage

```javascript
// WeakMap: handle → { var1: val1, var2: val2, __setupHash: 'h123' }
const hmrState = new WeakMap()

function __hmr_state(handle) {
  if (!hmrState.has(handle)) {
    hmrState.set(handle, {})
  }
  return hmrState.get(handle)
}
```

Using WeakMap means state is garbage collected when the handle is.

### Render Registry

```javascript
// WeakMap: handle → current render function
const renderRegistry = new WeakMap()

// Map: moduleUrl → Map<componentName → Set<handle>>
const handlesByModule = new Map()

function __hmr_register(moduleUrl, componentName, handle, renderFn) {
  // Store render function
  renderRegistry.set(handle, renderFn)
  
  // Track this handle for updates
  handlesByModule
    .get(moduleUrl)
    .get(componentName)
    .add(handle)
}

function __hmr_call(handle) {
  return renderRegistry.get(handle)()
}
```

### Component Registry

```javascript
// Map: 'moduleUrl::componentName' → implementation function
const componentRegistry = new Map()

function __hmr_register_component(moduleUrl, componentName, impl) {
  componentRegistry.set(`${moduleUrl}::${componentName}`, impl)
}

function __hmr_get_component(moduleUrl, componentName) {
  return componentRegistry.get(`${moduleUrl}::${componentName}`)
}
```

When a module hot-updates, it calls `__hmr_register_component` with the new implementation. The exported wrapper calls `__hmr_get_component`, so it always gets the latest.

### Setup Hash Checking

```javascript
function __hmr_setup(handle, state, hash, setupFn) {
  if (state.__setupHash === undefined) {
    // First run - execute setup
    setupFn()
    state.__setupHash = hash
    return false  // Continue normally
  }
  
  if (state.__setupHash !== hash) {
    // Setup changed - need remount
    __hmr_clear_state(handle)
    return true  // Signal remount needed
  }
  
  // Hash matches - skip setup
  return false
}
```

### SSE Client

```javascript
const eventSource = new EventSource('/@remix/hmr')

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data)
  
  if (message.type === 'update') {
    message.files.forEach(file => {
      const url = file + '?t=' + message.timestamp
      
      // Dynamic import fetches new module
      import(url).then(newModule => {
        // Update all instances of components in this module
        __hmr_update(file, newModule)
      })
    })
  }
}
```

---

## Source Maps

Preserving source maps is critical for debugging. Here's how we handle them:

### Input: esbuild's inline source maps

esbuild outputs JavaScript with inline source maps:

```javascript
export function Counter(handle) {
  let count = 0;
  return () => jsx("div", { children: count });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLC...
```

### Transform: SWC preserves mappings

We use SWC's `parse()` and `print()` with source map support:

```javascript
// Parse the input
let ast = await swc.parse(source, {
  syntax: 'ecmascript',
  jsx: true,
})

// Transform AST...

// Print with source map, chaining from input map
let result = await swc.print(transformedAst, {
  sourceMaps: true,
  inputSourceMap: extractInlineSourceMap(source),
})
```

### Output: new inline source map

The transformed code gets a new inline source map that chains through:

```
Original TSX → esbuild → JS with map → SWC transform → JS with chained map
```

When you debug in the browser, you see your original TypeScript source.

---

## Key Insights

1. **State lives in a WeakMap keyed by handle** - Not in closure variables
2. **Setup hash detects scope changes** - Different hash = remount
3. **Components are HMR boundaries** - Changes bubble up but stop at components
4. **The wrapper pattern enables hot-swap** - Remix holds wrapper, implementation swaps beneath it
5. **Timestamps bust browser cache** - `?t=123` forces fresh fetch
6. **SSE is simpler than WebSocket** - One-way, auto-reconnect, no handshake
7. **Transform is AST-based** - Proper transformations preserve source maps

---

## Limitations

1. **Only Remix components** - Regular functions aren't transformed
2. **PascalCase detection** - Component must start with uppercase
3. **Setup scope only** - Can't preserve arbitrary closure state
4. **No CSS HMR** - This is JS-only (CSS would need different approach)
5. **Development only** - The middleware should not run in production

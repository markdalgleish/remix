import { createRoot, requestRemount } from '@remix-run/component'
import type { Handle } from '@remix-run/component'

// =============================================================================
// APP ENTRY
// This file is bundled by esbuild with /assets/* as external imports.
// HMR runtime is served as a module at /@remix/hmr/runtime.js
// =============================================================================

// Wire up requestRemount for HMR (global avoids bundler issues)
;(window as any).__hmr_request_remount_impl = requestRemount

async function main() {
  // Import the pre-built JS file (not TSX)
  let { Counter } = await import('/assets/Counter.js')

  function App(handle: Handle) {
    return () => (
      <div>
        <Counter />

        <div css={{ marginTop: '2rem', paddingTop: '1rem', borderTop: '1px solid #eee' }}>
          <p css={{ marginBottom: '1rem', color: '#666', fontSize: '14px' }}>
            <strong>HMR Test:</strong> Edit app/assets/Counter.tsx or app/assets/utils.ts and save
          </p>
        </div>
      </div>
    )
  }

  let container = document.getElementById('app')!
  container.innerHTML = '' // Clear "Loading..." placeholder
  let root = createRoot(container)
  root.render(<App />)
}

main().catch(console.error)

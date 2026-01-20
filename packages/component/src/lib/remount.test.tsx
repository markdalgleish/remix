import { describe, it, expect } from 'vitest'
import { createRoot } from './vdom.ts'
import { requestRemount } from './component.ts'
import type { Handle } from './component.ts'

describe('requestRemount', () => {
  it('triggers cleanup and fresh mount', () => {
    let container = document.createElement('div')
    let root = createRoot(container)

    let setupCount = 0
    let cleanupCount = 0
    let capturedHandle: Handle | null = null

    function Counter(handle: Handle) {
      setupCount++
      capturedHandle = handle
      handle.signal.addEventListener('abort', () => {
        cleanupCount++
      })
      return () => <div>Setup count: {setupCount}</div>
    }

    // Initial render
    root.render(<Counter />)
    root.flush()

    expect(setupCount).toBe(1)
    expect(cleanupCount).toBe(0)
    expect(container.textContent).toBe('Setup count: 1')

    // Trigger remount
    requestRemount(capturedHandle!)
    root.flush()

    // After remount:
    expect(setupCount).toBe(2) // Setup ran again
    expect(cleanupCount).toBe(1) // Old instance cleaned up
    expect(container.textContent).toBe('Setup count: 2')
  })

  it('handle.on() listeners are cleaned up on remount', () => {
    let container = document.createElement('div')
    let root = createRoot(container)

    let clickCount = 0
    let capturedHandle: Handle | null = null

    function App(handle: Handle) {
      capturedHandle = handle
      handle.on(document, {
        click: () => {
          clickCount++
        },
      })
      return () => <div>App</div>
    }

    // Initial render
    root.render(<App />)
    root.flush()

    // Listener works
    document.dispatchEvent(new MouseEvent('click'))
    expect(clickCount).toBe(1)

    // Trigger remount
    requestRemount(capturedHandle!)
    root.flush()

    // After remount - old listener should be cleaned up, new listener attached
    // So one click should still only increment by 1 (not 2)
    document.dispatchEvent(new MouseEvent('click'))
    expect(clickCount).toBe(2) // Only one increment, not two (old listener gone)
  })

  it('state resets after remount', () => {
    let container = document.createElement('div')
    let root = createRoot(container)

    let capturedHandle: Handle | null = null

    function Counter(handle: Handle) {
      let count = 0
      capturedHandle = handle
      return () => (
        <button
          on={{
            click: () => {
              count++
              handle.update()
            },
          }}
        >
          Count: {count}
        </button>
      )
    }

    // Initial render
    root.render(<Counter />)
    root.flush()

    expect(container.textContent).toBe('Count: 0')

    // Increment
    container.querySelector('button')!.click()
    root.flush()
    expect(container.textContent).toBe('Count: 1')

    // Another increment
    container.querySelector('button')!.click()
    root.flush()
    expect(container.textContent).toBe('Count: 2')

    // Trigger remount
    requestRemount(capturedHandle!)
    root.flush()

    // State should be reset
    expect(container.textContent).toBe('Count: 0')
  })

  it('new handle.signal is not aborted after remount', () => {
    let container = document.createElement('div')
    let root = createRoot(container)

    let signals: AbortSignal[] = []

    function App(handle: Handle) {
      signals.push(handle.signal)
      return () => <div>App</div>
    }

    // Initial render
    root.render(<App />)
    root.flush()

    expect(signals.length).toBe(1)
    expect(signals[0].aborted).toBe(false)

    // Get the handle and trigger remount
    // We need to capture the handle to call requestRemount
    let capturedHandle: Handle | null = null
    function AppWithCapture(handle: Handle) {
      capturedHandle = handle
      signals.push(handle.signal)
      return () => <div>App</div>
    }

    // Re-render with capture
    root.render(<AppWithCapture />)
    root.flush()

    // Trigger remount
    requestRemount(capturedHandle!)
    root.flush()

    // Old signal should be aborted, new signal should not
    expect(signals[1].aborted).toBe(true) // Old signal from before remount
    expect(signals[2].aborted).toBe(false) // New signal after remount
  })
})

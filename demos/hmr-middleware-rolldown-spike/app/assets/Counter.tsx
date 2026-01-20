import type { Handle } from '@remix-run/component'
import { formatCount, getButtonStyle } from './utils.js'

/**
 * A simple counter component.
 * This imports from utils.ts to test import propagation HMR.
 */
export function Counter(handle: Handle) {
  let count = 0

  return () => (
    <div>
      <h2 css={{ color: '#333' }}>Counter</h2>
      <p css={{ color: '#666' }}>Click the button to increment</p>
      <button
        on={{
          click: () => {
            count++
            handle.update()
          },
        }}
        css={{
          ...getButtonStyle(),
          '&:hover': { backgroundColor: '#357abd' },
        }}
      >
        {formatCount(count)}
      </button>
    </div>
  )
}

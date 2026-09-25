import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import VirtualKeyboardModal from './components/VirtualKeyboardModal.js'
import './index.css'

/**
 * Entry point — mounts the React root onto the #root div declared in
 * index.html.
 *
 * The on-screen keyboard is mounted here, beside `App` rather than inside
 * its logged-in shell, because `App` returns early for every pre-login
 * screen; a keyboard mounted in the shell does not exist during onboarding
 * or the fiscal setup gate.
 */
const container = document.getElementById('root')
if (!container) {
  throw new Error('Root container #root not found in index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
    <VirtualKeyboardModal />
  </StrictMode>
)

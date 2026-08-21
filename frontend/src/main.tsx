import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './context/AuthContext.tsx'
import { PinnedProvider } from './context/PinnedContext.tsx'
import { BasketProvider } from './context/BasketContext.tsx'
import { ToastProvider } from './components/Toast.tsx'
import { ThemeProvider } from './context/ThemeContext.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <PinnedProvider>
          <BasketProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </BasketProvider>
        </PinnedProvider>
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)

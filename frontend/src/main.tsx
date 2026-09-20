import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AuthProvider } from './context/AuthContext.tsx'
import { ToastProvider } from './components/Toast.tsx'
import { ThemeProvider } from './context/ThemeContext.tsx'
import { initSearchClient } from './search/searchClient'

// индекс поиска грузим в фоне сразу
initSearchClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="приложение">
      <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
)

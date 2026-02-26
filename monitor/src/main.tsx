import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppProvider } from './context/AppContext';
import { NoteServiceProvider } from './context/NoteServiceContext';
import ErrorBoundary from './components/shared/ErrorBoundary';
import App from './App';
import './index.css';

// Remove loading indicator once React mounts
const loadingEl = document.getElementById('app-loading');
if (loadingEl) loadingEl.remove();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary viewName="Root">
      <AppProvider>
        <NoteServiceProvider>
          <App />
        </NoteServiceProvider>
      </AppProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

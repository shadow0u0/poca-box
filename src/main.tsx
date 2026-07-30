import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter } from 'react-router-dom';
import App from './App';
import { routes } from './routes';
import { requestPersistentStorage, seedIfNeeded } from './data/seed';
import './index.css';

// Hash routing keeps deep links working on GitHub Pages, which serves static
// files only and cannot rewrite unknown paths to index.html.
const router = createHashRouter([{ path: '/', element: <App />, children: routes }]);

async function bootstrap() {
  await seedIfNeeded();
  // Fire-and-forget: a refusal only means the browser may evict data later,
  // which 設定 surfaces as a banner.
  void requestPersistentStorage();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

void bootstrap();

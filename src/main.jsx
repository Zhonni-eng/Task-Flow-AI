import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AppRoot from './AppRoot.jsx';
import { loadAppData } from './storage/storage.js';
import './styles/theme.css';
import './styles/layout.css';
import './styles/board.css';
import './styles/controls.css';
import './styles/dialogs.css';
import './styles/toolbar.css';
import './styles/navigation.css';
import './styles/list.css';
import './styles/polish.css';

// Saved data is loaded before the first render, so sample tasks never flash
// before the user's own tasks appear.
loadAppData().then((boot) => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <AppRoot boot={boot} />
    </StrictMode>,
  );
});

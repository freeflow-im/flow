// The guest scheduler's page (book.html): its own small entry, with no session, no suite bar and no data of the owner's
// beyond what the public API answers (docs/specs/guest-scheduler.md §2.4).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BookApp } from './BookApp';
import './book.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BookApp />
  </StrictMode>,
);

import React from 'react';
import ReactDOM from 'react-dom/client';
import { PortalApp } from './PortalApp';
import { ReviewApp } from './review/ReviewApp';
import { isReviewRoute } from './review-route';
import './styles.css';

// Two surfaces, one bundle. The server serves the same index for /portal and
// /portal/review; the pathname picks the app so the knowledge explorer and the
// reviewer deck never share state.
const Root = isReviewRoute(window.location.pathname) ? ReviewApp : PortalApp;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);

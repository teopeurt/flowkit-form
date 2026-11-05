import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import '@flowkit-demo/ui/tokens.css';
import './styles.css';
import { router } from './router';

const root = document.getElementById('root');
if (!root) throw new Error('FlowKit web root is missing.');

createRoot(root).render(<StrictMode><RouterProvider router={router} /></StrictMode>);

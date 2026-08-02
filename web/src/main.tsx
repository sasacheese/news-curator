import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { greetConsole } from './greeting';
import { applyTheme } from './settings';
import './styles.css';

applyTheme();
greetConsole();

const root = document.getElementById('root');
if (!root) throw new Error('#root が見つかりません');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

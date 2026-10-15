import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

const container = document.getElementById('root');
if (!container) throw new Error('Client root element #root is missing.');
// One root and one effect-owned game; no development-only double mounting.
createRoot(container).render(<App />);

import { useState } from 'react';
import { loadSettings } from './settings';
import { GameSurface } from './ShellPanels';
import { ClientShell } from './Shell';

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [route] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return { capture: params.has('capture') || params.has('g2') || params.has('combat'), map: params.get('map') || 'Airpirates' };
  });
  // Qualification keeps its original canvas-only route and diagnostic hooks.
  if (route.capture) return <GameSurface capture map={route.map} settings={settings} />;
  return <ClientShell settings={settings} setSettings={setSettings} />;
}

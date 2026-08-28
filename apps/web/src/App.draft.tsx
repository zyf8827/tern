import React, { useState } from 'react';

export function AppDraft() {
  const [tab, setTab] = useState('runs');
  return (
    <div style={{ padding: 20 }}>
      <h1>Tern Dashboard (Draft)</h1>
      <nav>
        <button onClick={() => setTab('projects')}>Projects</button>
        <button onClick={() => setTab('runs')}>Runs</button>
      </nav>
      <p>Current view: {tab}</p>
    </div>
  );
}

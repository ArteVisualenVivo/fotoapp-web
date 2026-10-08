import { Capacitor } from '@capacitor/core';
import { BrowserRouter, HashRouter, Routes, Route } from 'react-router-dom';
import Portfolio from './Portfolio';
import Admin from './Admin';

export default function App() {
  const Router = Capacitor.isNativePlatform() ? HashRouter : BrowserRouter;

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Portfolio />} />
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </Router>
  );
}

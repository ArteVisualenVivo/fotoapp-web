import { Capacitor } from '@capacitor/core';
import { BrowserRouter, HashRouter, Routes, Route } from 'react-router-dom';
import Portfolio from './Portfolio';
import PortfolioShop from './PortfolioShop';
import Admin from './Admin';

export default function App() {
  const Router = Capacitor.isNativePlatform() ? HashRouter : BrowserRouter;

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Portfolio mode="gallery" />} />
        <Route path="/tienda" element={<PortfolioShop mode="shop" />} />
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </Router>
  );
}

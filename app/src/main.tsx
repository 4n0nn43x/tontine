import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles/base.css";
import "./styles/landing.css";
import "./styles/sections.css";
import "./styles/app.css";
import { AppShell } from "./components/AppShell";
import { Landing } from "./pages/Landing";
import { Dashboard } from "./pages/Dashboard";
import { Orders, OrderDetail } from "./pages/Orders";
import { Trade } from "./pages/Trade";
import { Firms, FirmDetail } from "./pages/Firms";
import { Portfolio } from "./pages/Portfolio";
import { Thesis } from "./pages/Thesis";
import { NotFound } from "./pages/NotFound";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route element={<AppShell />}>
          <Route path="/app" element={<Dashboard />} />
          <Route path="/app/orders" element={<Orders />} />
          <Route path="/app/orders/:id" element={<OrderDetail />} />
          <Route path="/app/trade" element={<Trade />} />
          {/* Jobs became orders: old links land on the orders. */}
          <Route path="/app/jobs/*" element={<Navigate to="/app/orders" replace />} />
          <Route path="/app/post" element={<Navigate to="/app/trade" replace />} />
          <Route path="/app/firms" element={<Firms />} />
          <Route path="/app/firms/:id" element={<FirmDetail />} />
          <Route path="/app/portfolio" element={<Portfolio />} />
          <Route path="/thesis" element={<Thesis />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

import React from "react";
import { createRoot } from "react-dom/client";
// SVAR Grid styles (Willow theme + all-features bundle). Imported here
// so the chunk lands once at app boot instead of on first grid mount.
import "@svar-ui/react-grid/all.css";
import App from "./App.tsx";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

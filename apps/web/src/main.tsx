import React from "react";
import { createRoot } from "react-dom/client";
// Metis admin template adoption: Bootstrap 5 + Bootstrap Icons + Inter font
// (Inter is bundled via the @fontsource-free CDN at runtime — see index.html
// link tag). Bootstrap base CSS must come BEFORE styles.css so app-level
// overrides win.
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";
// Bootstrap JS (Popper-driven dropdowns, modal close on Esc, etc.).
// We use only the data-bs-* APIs in markup; the bundle wires those up.
import "bootstrap/dist/js/bootstrap.bundle.min.js";
import App from "./App.tsx";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

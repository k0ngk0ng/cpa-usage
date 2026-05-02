import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

// React-Router uses window.location.pathname; mount it under the runtime base
// path so links like `/usage/events` work and reload-resilience holds.
function basename(): string {
  const raw = window.__APP_BASE_PATH__ || "";
  if (!raw || raw === "__APP_BASE_PATH__") return "/usage";
  return raw.replace(/\/+$/, "");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename()}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "maplibre-gl/dist/maplibre-gl.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);



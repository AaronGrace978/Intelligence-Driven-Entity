import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/orbitron/600.css";
import "@fontsource/orbitron/900.css";
import App from "./App";
import { deckStatus, DESKTOP_STATUS } from "./lib/api";
import { lightGraphicsPreferred, notePlatform, setLightGraphics } from "./lib/budget";
import { feedPad } from "./lib/pad";
import "./styles.css";

if (import.meta.env.DEV) {
  (window as unknown as { __entityPad: typeof feedPad }).__entityPad = feedPad;
}

deckStatus()
  .catch((e) => {
    console.error(e);
    return DESKTOP_STATUS;
  })
  .then((platform) => {
    notePlatform(platform.gameMode);
    if (platform.deck) setLightGraphics(lightGraphicsPreferred());
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <App platform={platform} />
      </React.StrictMode>,
    );
  });

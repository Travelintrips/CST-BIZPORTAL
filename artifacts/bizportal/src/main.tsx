import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installChunkLoadRecovery } from "@/lib/chunkLoadRecovery";

// Older links and notifications use the app's former /bizportal prefix.
// Normalize those URLs before the root-mounted router starts.
if (window.location.pathname === "/bizportal" || window.location.pathname.startsWith("/bizportal/")) {
  const normalizedPath = window.location.pathname.replace(/^\/bizportal(?=\/|$)/, "") || "/";
  window.history.replaceState(null, "", `${normalizedPath}${window.location.search}${window.location.hash}`);
}

(window as any).__BASE_PATH__ = import.meta.env.BASE_URL || "/";

// A user can keep an older HTML document open while a new deployment replaces
// its hashed lazy chunks. Vite emits this event when that stale chunk is gone;
// reload once so the browser receives the current HTML and asset manifest.
installChunkLoadRecovery();

// No portal relay needed — Customer Portal handles its own OAuth redirect directly.

createRoot(document.getElementById("root")!).render(<App />);

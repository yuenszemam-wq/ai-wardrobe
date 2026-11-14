import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { bootTheme } from "./theme";

// 先套用手機快取的介面主題，避免先顯示舊主題再突然切換
bootTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 正式環境（https）註冊；本機測試可用 localStorage aw:sw-test=1 明確開啟（測試離線冷啟動）
let swTest = false;
try { swTest = localStorage.getItem("aw:sw-test") === "1"; } catch { /* 私人瀏覽 */ }
if ("serviceWorker" in navigator && (location.protocol === "https:" || swTest)) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then(r => { void r.update().catch(() => undefined); }).catch(() => {});
  });
}

import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// 字型全數自架(由 Vite 打包進 dist),不依賴任何執行期 CDN。
// 版本鎖定於 package-lock.json;production CSP 僅允許 'self' 字型來源。
import "@fontsource/lxgw-wenkai-tc/400.css";
import "@fontsource/lxgw-wenkai-tc/700.css";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/500.css";
import "@fontsource/roboto-mono/600.css";
import "@fontsource/roboto-mono/700.css";

createRoot(document.getElementById("root")!).render(<App />);

import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Include Material Icons
const materialIconsLink = document.createElement('link');
materialIconsLink.rel = 'stylesheet';
materialIconsLink.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
document.head.appendChild(materialIconsLink);

// Include Roboto Font
const robotoFontLink = document.createElement('link');
robotoFontLink.rel = 'stylesheet';
robotoFontLink.href = 'https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Mono&display=swap';
document.head.appendChild(robotoFontLink);

// Set page title
const title = document.createElement('title');
title.textContent = '員工薪資計算系統';
document.head.appendChild(title);

createRoot(document.getElementById("root")!).render(<App />);

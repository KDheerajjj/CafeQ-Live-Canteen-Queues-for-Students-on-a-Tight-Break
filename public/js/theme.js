// theme.js — light/dark theme switch, shown in the header of every page.
//
// First visit: follow the phone's setting (prefers-color-scheme), and keep
// following it if it changes. Once the student taps the switch, their choice
// is remembered on this device (localStorage) and wins from then on.
// A tiny inline script in each page's <head> applies the theme before first
// paint, so there is no flash of the wrong colours; this module adds the button.

const KEY = "cafeq.theme";
const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function stored() {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

export function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    const next = theme === "dark" ? "light" : "dark";
    btn.textContent = theme === "dark" ? "☀️ Light" : "🌙 Dark";
    btn.setAttribute("aria-label", `Switch to ${next} theme`);
    btn.title = `Switch to ${next} theme`;
  }
}

/** Wire up #theme-toggle. Safe to call on any page. */
export function initThemeToggle() {
  apply(stored() || (media && media.matches ? "dark" : "light"));
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* not remembered, still switches */
    }
    apply(next);
  });
  // No explicit choice yet -> keep following the system setting live.
  media?.addEventListener?.("change", (e) => {
    if (!stored()) apply(e.matches ? "dark" : "light");
  });
}

initThemeToggle();

// Resolve the local theme before rendering the page.
try {
  const saved = localStorage.getItem("pactum:site-theme");
  const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
} catch { document.documentElement.classList.toggle("dark", matchMedia("(prefers-color-scheme: dark)").matches); }

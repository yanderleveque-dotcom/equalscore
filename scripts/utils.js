// utils.js — formatting, DOM helpers, deterministic RNG

/** Format an integer as CLP with thousands separators, e.g. 1234567 -> "$1.234.567". */
export function clp(n) {
  if (n == null || isNaN(n)) return "—";
  return "$" + Math.round(n).toLocaleString("es-CL");
}

/** Format a number with es-CL thousands separators (no currency sign). */
export function num(n) {
  if (n == null || isNaN(n)) return "—";
  return Math.round(n).toLocaleString("es-CL");
}

/** Percentage with one decimal, e.g. 0.123 -> "12,3%". */
export function pct(fraction, decimals = 1) {
  if (fraction == null || isNaN(fraction)) return "—";
  return (fraction * 100).toFixed(decimals).replace(".", ",") + "%";
}

/** Format an ISO date string (yyyy-mm-dd) as dd-mm-yyyy. */
export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

/** Days between two date-like values (a - b) in whole days. */
export function daysBetween(a, b) {
  return Math.floor((new Date(a) - new Date(b)) / 86400000);
}

/** Escape text for safe insertion into innerHTML. */
export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip accents and lowercase for accent-insensitive search. */
export function normalize(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .trim();
}

/** Deterministic seeded PRNG (mulberry32). Returns a function -> [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small DOM helpers. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

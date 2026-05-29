// Centralised API base URL.
// In dev: empty string — Vite proxy in vite.config.js forwards /api → backend.
// In production: set VITE_API_URL=https://your-backend.example.com at build time.
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export function apiUrl(path) {
  if (!path) return API_BASE;
  return API_BASE + (path.startsWith('/') ? path : '/' + path);
}

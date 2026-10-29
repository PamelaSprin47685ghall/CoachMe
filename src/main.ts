import { mount } from 'svelte';
import 'framework7/css/bundle';
import 'katex/dist/katex.min.css';
import './app.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) {
  throw new Error('Missing #app mount target');
}

const app = mount(App, { target });

// PWA: register the app-shell service worker (production builds only; never caches /api or /auth).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Installability is optional; the app works without a service worker.
    });
  });
}

export default app;

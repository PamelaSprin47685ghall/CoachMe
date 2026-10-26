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

export default app;

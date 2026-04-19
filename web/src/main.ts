import { createApp } from 'vue';
import { createPinia } from 'pinia';
import axios from 'axios';
import App from './App.vue';
import router from './router/index.js';
import './styles/global.scss';
import { withBasePath } from './lib/base.js';

axios.defaults.baseURL = withBasePath('');

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');

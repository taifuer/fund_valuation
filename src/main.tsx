import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

if (/^[a-f0-9]{32}$/i.test(__BAIDU_ANALYTICS_ID__)) {
  const analyticsWindow = window as Window & { _hmt?: unknown[] };
  analyticsWindow._hmt = analyticsWindow._hmt || [];
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://hm.baidu.com/hm.js?${__BAIDU_ANALYTICS_ID__}`;
  document.head.appendChild(script);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

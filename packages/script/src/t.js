// DataGoat tracking script — browser bootstrap.
//
// Served by the Worker at GET /t.js. Reads its configuration from the script
// tag's data-* attributes, exposes window.datagoat(), and starts tracking.

import { createTracker, VERSION } from './core.js';

(function () {
  'use strict';

  const w = window;
  const d = document;

  function findScript() {
    if (d.currentScript && d.currentScript.src) return d.currentScript;
    const scripts = d.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      if (/\/t\.js(\?|$)/.test(scripts[i].src)) return scripts[i];
    }
    return null;
  }

  function readConfig(script) {
    const d = (script && script.dataset) || {};
    const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
    const config = {
      site: d.site || '',
      endpoint: d.endpoint || '',
      domain: d.domain || '',
      mode: d.cookieless === 'true' ? 'cookieless' : d.mode || 'auto',
      autoTrack: d.autoTrack !== 'false',
      spa: d.spa !== 'false',
      hash: d.hash === 'true',
      respectDnt: d.respectDnt !== 'false',
      dnt: d.dnt || 'cookieless',
      requireConsent: d.requireConsent === 'true',
      blockBots: d.blockBots !== 'false',
      botThreshold: d.botThreshold ? parseInt(d.botThreshold, 10) : 60,
      redactUrl: d.redactUrl !== 'false',
      crossDomain: list(d.crossDomain),
      allowEmbed: d.allowEmbed === 'true',
    };
    if (!config.endpoint) {
      try {
        config.endpoint = new URL(script.src).origin;
      } catch (err) {
        config.endpoint = w.location.origin;
      }
    }
    return config;
  }

  const script = findScript();
  const config = readConfig(script);
  const tracker = createTracker(config);

  const existing = w.datagoat;
  const queue = existing && existing.q ? existing.q.splice(0) : [];

  const api = function (command, ...args) {
    return tracker.command(command, ...args);
  };
  api.q = [];
  api.version = VERSION;

  w.datagoat = api;

  tracker.init(queue);
})();

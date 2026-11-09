// Use the theme that is active in Home Assistant, as in Smart Charging Planner.
//
// The app runs in a frame inside Home Assistant (ingress, same address).
// This script reads the theme variables of the Home Assistant page and copies
// them onto this page, so every user sees the app in their own theme: the
// default theme or a custom one, light or dark. When the Home Assistant page
// cannot be read (the app opened on its own, or a browser blocks it), the
// fallbacks in styles.css (Home Assistant's default theme) are used, light or
// dark as the browser prefers.
(function () {
  'use strict';

  // The Home Assistant theme variables the app uses.
  const VARS = [
    '--primary-color', '--text-primary-color', '--primary-background-color',
    '--secondary-background-color', '--card-background-color', '--ha-card-background',
    '--primary-text-color', '--secondary-text-color', '--divider-color',
    '--error-color', '--warning-color', '--success-color', '--purple-color',
    '--ha-card-border-radius', '--ha-card-border-width', '--ha-card-border-color',
    '--ha-card-box-shadow', '--input-fill-color',
    '--ha-font-family-body', '--paper-font-body1_-_font-family', '--mdc-typography-font-family',
  ];

  const root = document.documentElement;

  // The Home Assistant page, or null when it cannot be read.
  function haDocument() {
    try {
      const p = window.parent;
      if (!p || p === window) return null;
      const doc = p.document; // throws when the browser does not allow it
      return doc && doc.documentElement ? doc : null;
    } catch (e) {
      return null;
    }
  }

  // Relative brightness 0..1 of a CSS colour, or null when unknown.
  function brightness(value) {
    if (!value) return null;
    const probe = document.createElement('span');
    probe.style.color = value;
    if (!probe.style.color) return null;
    probe.style.display = 'none';
    (document.body || root).appendChild(probe);
    const rgb = getComputedStyle(probe).color.match(/[\d.]+/g);
    probe.remove();
    if (!rgb || rgb.length < 3) return null;
    const [r, g, b] = rgb.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  // Copy the theme variables.
  function apply() {
    const doc = haDocument();
    let style = null;
    try {
      style = doc ? doc.defaultView.getComputedStyle(doc.documentElement) : null;
    } catch (e) {
      style = null;
    }
    for (const name of VARS) {
      const value = style ? String(style.getPropertyValue(name) || '').trim() : '';
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
    // Light or dark: from the Home Assistant background, else the browser.
    let dark = null;
    if (style) {
      const scheme = String(style.getPropertyValue('color-scheme') || '').trim();
      if (scheme === 'dark' || scheme === 'light') dark = scheme === 'dark';
      const bright = brightness(String(style.getPropertyValue('--primary-background-color') || '').trim());
      if (bright != null) dark = bright < 0.5;
    }
    if (dark == null) dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.scheme = dark ? 'dark' : 'light';
  }

  // Load the fonts of the Home Assistant page (Roboto), so the text looks the same.
  let fontsCopied = false;
  function copyFonts() {
    if (fontsCopied) return;
    const doc = haDocument();
    if (!doc) return;
    const rules = [];
    try {
      for (const sheet of Array.from(doc.styleSheets)) {
        let list;
        try { list = sheet.cssRules; } catch (e) { continue; } // other origin
        const base = sheet.href || doc.baseURI;
        for (const rule of Array.from(list || [])) {
          if (rule.type !== 5 || rules.length >= 40) continue; // 5 = @font-face
          rules.push(rule.cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, url) => {
            try { return `url("${new URL(url, base).href}")`; } catch (e) { return m; }
          }));
        }
      }
    } catch (e) {
      return;
    }
    if (!rules.length) return;
    const el = document.createElement('style');
    el.id = 'ha-fonts';
    el.textContent = rules.join('\n');
    document.head.appendChild(el);
    fontsCopied = true;
  }

  apply();

  // Follow theme changes: a new theme, dark mode on or off.
  function watch() {
    copyFonts();
    const doc = haDocument();
    if (doc && window.MutationObserver) {
      const again = () => apply();
      try {
        const observer = new MutationObserver(again);
        observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
        if (doc.head) observer.observe(doc.head, { childList: true });
      } catch (e) { /* keep the current colours */ }
    }
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', () => apply());
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) apply(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();

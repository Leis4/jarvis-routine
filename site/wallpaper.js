/* JARVIS Routine v49 — cinematic living background controller.
 *
 * One managed scene at a time:
 *   AURA  — Vanta WAVES (three.js r134, MIT) geometric 3D waves.
 *   FLUID — GPU Navier–Stokes fluid factory (see vendor/fluid/fluid.js, MIT).
 *   STILL — static CSS gradient, no GPU, no RAF.
 *
 * Keeps the v48 public API: JarvisWallpaper.{init,apply,set,get,mode,stop,start}.
 * The saved choice stays in localStorage jarvis_ui_wallpaper; STILL is never
 * silently overridden. 30 fps cap for AURA, 30 fps + adaptive DPR for FLUID.
 *
 * PRIVACY: draws only; no app data, no network.
 */
(function (root) {
  'use strict';
  const KEY = 'jarvis_ui_wallpaper';
  const DEFAULTS = { mode: 'aura', intensity: 'mid' };
  const VALID = ['aura', 'fluid', 'still'];

  let host = null;
  let vanta = null;
  let fluid = null;
  let raf = 0;
  let mode = 'aura';
  let effective = 'aura';
  let intensity = 'mid';
  let isLight = false;
  let builtFor = '';
  let failure = '';
  let running = false;

  function read() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || 'null');
      return o && VALID.includes(o.mode) ? { mode: o.mode, intensity: o.intensity || 'mid' } : { ...DEFAULTS };
    } catch (e) { return { ...DEFAULTS }; }
  }
  function write(w) { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch (e) {} }

  function themeLight() {
    const t = document.documentElement.dataset.theme;
    if (t === 'light') return true;
    if (t === 'dark') return false;
    try { return !!root.matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { return false; }
  }
  function motionMinimal() {
    try { return (root.ui && root.ui.motion) === 'minimal'; } catch (e) { return false; }
  }
  function reduced() {
    try { return !!root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function effectiveMode() {
    if (reduced() || motionMinimal()) return 'still';
    const w = read();
    return VALID.includes(w.mode) ? w.mode : 'aura';
  }
  function intensityValue() {
    const i = read().intensity;
    return i === 'low' ? 0.72 : i === 'high' ? 1.28 : 1;
  }

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.getElementById('wallpaper');
    if (!host) {
      host = document.createElement('div');
      host.id = 'wallpaper';
      host.setAttribute('aria-hidden', 'true');
      document.body.appendChild(host);
    }
    return host;
  }

  function clearHost() {
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.className = '';
    host.style.filter = '';
  }

  function destroyScenes() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (vanta) {
      try { vanta.destroy(); } catch (e) {}
      vanta = null;
    }
    if (fluid) {
      try { fluid.destroy(); } catch (e) {}
      fluid = null;
    }
    running = false;
  }

  function capVantaFps(effect) {
    if (!effect || typeof effect.animationLoop !== 'function') return;
    const original = effect.animationLoop.bind(effect);
    let last = 0;
    effect.animationLoop = function () {
      const now = performance.now();
      if (now - last < 33) { requestAnimationFrame(effect.animationLoop); return; }
      last = now;
      original();
    };
  }

  function vantaOptions() {
    const options = {
      el: host,
      THREE: root.THREE,
      backgroundAlpha: 1,
      scale: Math.max(1, (root.devicePixelRatio || 1) / 1.3),
      scaleMobile: Math.max(1, (root.devicePixelRatio || 1) / 1.3),
      mouseControls: false,
      touchControls: false,
      gyroControls: false,
      minHeight: 200,
      minWidth: 200,
      waveHeight: 24,
      waveSpeed: 1.55,
      zoom: 0.8,
      shininess: 62
    };
    if (isLight) {
      options.color = 0x3f79c8;
      options.backgroundColor = 0xe9eefb;
    } else {
      options.color = 0x2f74c8;
      options.backgroundColor = 0x061226;
    }
    return options;
  }

  function buildAura() {
    if (!root.THREE || !root.VANTA || !root.VANTA.WAVES) throw new Error('vanta_unavailable');
    vanta = root.VANTA.WAVES(vantaOptions());
    capVantaFps(vanta);
    if (vanta && vanta.renderer && vanta.renderer.setPixelRatio) {
      vanta.renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 1.3));
      try { vanta.resize(); } catch (e) {}
    }
    applyIntensity();
  }

  function buildFluid() {
    if (!root.JarvisFluid || !root.JarvisFluid.create) throw new Error('fluid_unavailable');
    fluid = root.JarvisFluid.create(host, {
      light: isLight,
      intensity: isLight ? 1.05 : 0.95,
      simResolution: 96,
      dyeResolution: 384,
      pressureIterations: 12,
      autoSplatMs: 1900,
      dprCap: 1.35
    });
    if (!fluid) throw new Error('fluid_no_webgl');
    applyIntensity();
  }

  function applyIntensity() {
    const v = intensityValue();
    if (host) {
      host.style.filter = v === 1 ? '' : `brightness(${v.toFixed(2)}) saturate(${(0.9 + v * 0.18).toFixed(2)})`;
    }
    if (fluid) fluid.setIntensity(isLight ? 1.05 * v : 0.95 * v);
  }

  function setCanvasVisibility(visible) {
    if (!host) return;
    for (const c of host.querySelectorAll('canvas')) c.style.visibility = visible ? '' : 'hidden';
  }

  function build() {
    ensureHost();
    destroyScenes();
    clearHost();
    isLight = themeLight();
    document.documentElement.dataset.wallpaper = effective;
    if (effective === 'still') {
      host.classList.add('wp-still');
      document.documentElement.dataset.wallpaper = 'still';
      builtFor = 'still';
      failure = '';
      return;
    }
    host.classList.add('wp-live');
    builtFor = effective + (isLight ? '-light' : '-dark');
    failure = '';
    try {
      if (effective === 'aura') buildAura();
      else buildFluid();
      running = true;
    } catch (e) {
      failure = String(e && e.message || e);
      try { console.warn('JARVIS wallpaper:', failure); } catch (err) {}
      destroyScenes();
      clearHost();
      effective = 'still';
      host.classList.add('wp-still');
      document.documentElement.dataset.wallpaper = 'still';
      builtFor = 'still-fallback';
    }
  }

  function start() {
    if (effective === 'still') return;
    if (vanta || fluid) { setCanvasVisibility(true); if (fluid) fluid.start(); running = true; return; }
    build();
  }
  function stop() {
    running = false;
    if (fluid) fluid.stop(false);
    if (vanta) setCanvasVisibility(false);
  }

  function apply() {
    const w = read();
    mode = VALID.includes(w.mode) ? w.mode : 'aura';
    intensity = w.intensity || 'mid';
    const next = effectiveMode();
    const themeNow = themeLight();
    const needBuild = !host || next !== effective || builtFor !== next + (themeNow ? '-light' : '-dark');
    effective = next;
    isLight = themeNow;
    if (next === 'still') {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      destroyScenes();
      ensureHost();
      clearHost();
      host.classList.add('wp-still');
      document.documentElement.dataset.wallpaper = 'still';
      builtFor = 'still';
      return;
    }
    if (needBuild) build();
    else {
      document.documentElement.dataset.wallpaper = effective;
      applyIntensity();
      if (!document.hidden) start();
    }
  }

  function init() {
    ensureHost();
    apply();
    let lastWidth = root.innerWidth;
    root.addEventListener('resize', () => {
      if (Math.abs(root.innerWidth - lastWidth) < 2) { if (fluid) fluid.resize(); return; }
      lastWidth = root.innerWidth;
      if (effective === 'fluid' && fluid) fluid.resize();
      if (effective === 'aura' && vanta) { try { vanta.resize(); } catch (e) {} }
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (fluid) fluid.stop(false); if (vanta) setCanvasVisibility(false); }
      else if (effective !== 'still') { setCanvasVisibility(true); if (fluid) fluid.start(); else if (vanta) setCanvasVisibility(true); }
    });
    root.addEventListener('pagehide', () => { if (fluid) fluid.stop(false); });
    root.addEventListener('pageshow', () => { if (effective !== 'still') { setCanvasVisibility(true); if (fluid) fluid.start(); } });
    try {
      root.matchMedia('(prefers-color-scheme: light)').addEventListener('change', apply);
      root.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', apply);
    } catch (e) {}
    try {
      new MutationObserver(() => {
        const now = themeLight();
        if (now !== isLight) apply();
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
  }

  root.JarvisWallpaper = {
    init, apply,
    set(w) { const cur = read(); write({ ...cur, ...w }); apply(); },
    get: read,
    mode: () => effective,
    savedMode: () => mode,
    stop,
    start,
    diagnose() {
      return {
        saved: read().mode,
        effective,
        theme: isLight ? 'light' : 'dark',
        reducedMotion: reduced(),
        motion: (root.ui && root.ui.motion) || 'full',
        webgl: !!root.THREE,
        fluid: !!root.JarvisFluid,
        canvases: host ? host.querySelectorAll('canvas').length : 0,
        running,
        failure: failure || null,
        reason: effective === 'still'
          ? (reduced() || motionMinimal() ? 'modifier' : (failure ? 'fallback' : 'saved_still'))
          : 'live'
      };
    }
  };
  function boot() {
    try { init(); }
    catch (e) {
      failure = String(e && e.message || e);
      try { console.warn('JARVIS wallpaper init:', failure); } catch (err) {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* JARVIS v49 — isolated GPU fluid background.
 *
 * Adapted from Pavel Dobryakov's WebGL-Fluid-Simulation (MIT):
 *   https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
 *   Copyright (c) 2017 Pavel Dobryakov
 * License text: site/vendor/third-party-licenses/WEBGL-FLUID-LICENSE.txt
 *
 * Changes for JARVIS: single managed factory (start/stop/destroy), WebGL1,
 * no bloom/sunrays/dithering/dat.gui, no global canvas or listeners, passive
 * pointer input that never calls preventDefault (scrolling stays native),
 * autonomous timed splats, 30 fps cap, adaptive resolution, theme/intensity
 * uniforms. The 2D Navier–Stokes GPU pipeline itself is the upstream algorithm.
 */
(function (root) {
  'use strict';

  const PALETTE = [
    [0.10, 0.52, 1.00], [0.45, 0.30, 1.00], [0.10, 0.90, 0.98],
    [0.85, 0.28, 0.92], [0.22, 0.70, 1.00], [0.62, 0.36, 1.00]
  ];

  const BASE_VERT = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  const COPY_FRAG = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; uniform sampler2D uTexture;
    void main () { gl_FragColor = texture2D(uTexture, vUv); }`;

  const CLEAR_FRAG = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; uniform sampler2D uTexture; uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`;

  const SPLAT_FRAG = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; uniform sampler2D uTarget; uniform float aspectRatio;
    uniform vec3 color; uniform vec2 point; uniform float radius;
    void main () {
      vec2 p = vUv - point.xy; p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      vec3 base = texture2D(uTarget, vUv).xyz;
      gl_FragColor = vec4(base + splat, 1.0);
    }`;

  const ADVECTION_FRAG = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uSource;
    uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;
    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
      vec2 st = uv / tsize - 0.5;
      vec2 iuv = floor(st); vec2 fuv = fract(st);
      vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
      vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
      vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
      vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
      return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }
    void main () {
    #ifdef MANUAL_FILTERING
      vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
      vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      vec4 result = texture2D(uSource, coord);
    #endif
      float decay = 1.0 + dissipation * dt;
      gl_FragColor = result / decay;
    }`;

  const DIVERGENCE_FRAG = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x;
      float R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y;
      float B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) { L = -C.x; }
      if (vR.x > 1.0) { R = -C.x; }
      if (vT.y > 1.0) { T = -C.y; }
      if (vB.y < 0.0) { B = -C.y; }
      gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`;

  const CURL_FRAG = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).y;
      float R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x;
      float B = texture2D(uVelocity, vB).x;
      gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`;

  const VORTICITY_FRAG = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;
    void main () {
      float L = texture2D(uCurl, vL).x;
      float R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x;
      float B = texture2D(uCurl, vB).x;
      float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curl * C;
      force.y *= -1.0;
      vec2 velocity = texture2D(uVelocity, vUv).xy;
      velocity += force * dt;
      velocity = min(max(velocity, -1000.0), 1000.0);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }`;

  const PRESSURE_FRAG = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uPressure; uniform sampler2D uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      float divergence = texture2D(uDivergence, vUv).x;
      gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
    }`;

  const GRADIENT_FRAG = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uPressure; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      vec2 velocity = texture2D(uVelocity, vUv).xy;
      velocity.xy -= vec2(R - L, T - B);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }`;

  const DISPLAY_FRAG = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform sampler2D uTexture; uniform vec2 texelSize;
    uniform float uLight; uniform float uExposure;
    void main () {
      vec3 c = texture2D(uTexture, vUv).rgb;
      vec3 lc = texture2D(uTexture, vL).rgb;
      vec3 rc = texture2D(uTexture, vR).rgb;
      vec3 tc = texture2D(uTexture, vT).rgb;
      vec3 bc = texture2D(uTexture, vB).rgb;
      float dx = length(rc) - length(lc);
      float dy = length(tc) - length(bc);
      vec3 n = normalize(vec3(dx, dy, length(texelSize)));
      float diffuse = clamp(dot(n, vec3(0.0, 0.0, 1.0)) + 0.72, 0.72, 1.0);
      c *= diffuse;
      float a = clamp(max(c.r, max(c.g, c.b)) * 1.25, 0.0, 1.0);
      vec3 bg = mix(vec3(0.012, 0.028, 0.075), vec3(0.925, 0.95, 1.0), uLight);
      vec3 ink = mix(c * 1.85, c * 1.45, uLight);
      vec3 col = mix(bg, ink, a);
      float vig = smoothstep(0.92, 0.22, length(vUv - 0.5));
      col *= mix(0.86 + 0.14 * vig, 0.97 + 0.03 * vig, uLight);
      gl_FragColor = vec4(col * uExposure, 1.0);
    }`;

  function compile(gl, type, src, keywords) {
    let prefix = '';
    if (keywords && keywords.length) prefix = keywords.map(k => '#define ' + k + '\n').join('');
    const sh = gl.createShader(type);
    gl.shaderSource(sh, prefix + src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('fluid shader: ' + log);
    }
    return sh;
  }

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('fluid link: ' + gl.getProgramInfoLog(p));
    return { program: p, uniforms: uniforms(gl, p) };
  }

  function uniforms(gl, p) {
    const out = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      out[name] = gl.getUniformLocation(p, name);
    }
    return out;
  }

  function create(host, options) {
    const opts = Object.assign({
      simResolution: 96, dyeResolution: 384, pressureIterations: 12,
      curl: 30, splatRadius: 0.18, splatForce: 6800, autoSplatMs: 1900,
      intensity: 1, light: false, dprCap: 1.35
    }, options || {});

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    host.appendChild(canvas);

    const gl = canvas.getContext('webgl', {
      alpha: false, depth: false, stencil: false, antialias: false,
      preserveDrawingBuffer: false, powerPreference: 'low-power'
    });
    if (!gl) { canvas.remove(); return null; }

    const halfFloat = gl.getExtension('OES_texture_half_float');
    const linear = gl.getExtension('OES_texture_half_float_linear');
    gl.getExtension('OES_texture_float');
    const texType = halfFloat ? halfFloat.HALF_FLOAT_OES : gl.UNSIGNED_BYTE;

    function supportsFormat(internal, format, type) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
      return ok;
    }

    let formatRGBA = null, formatRG = null, formatR = null;
    if (supportsFormat(gl.RGBA, gl.RGBA, texType)) formatRGBA = { internalFormat: gl.RGBA, format: gl.RGBA };
    if (!formatRGBA && supportsFormat(gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE)) formatRGBA = { internalFormat: gl.RGBA, format: gl.RGBA };
    if (supportsFormat(gl.RGBA, gl.RGBA, texType)) formatRG = { internalFormat: gl.RGBA, format: gl.RGBA };
    if (!formatRG) formatRG = formatRGBA;
    formatR = formatRGBA;
    const useHalf = !!(halfFloat && formatRGBA && texType === halfFloat.HALF_FLOAT_OES);

    const vs = compile(gl, gl.VERTEX_SHADER, BASE_VERT);
    const advectionKeywords = linear && useHalf ? [] : ['MANUAL_FILTERING'];
    const programs = {
      copy: program(gl, vs, compile(gl, gl.FRAGMENT_SHADER, COPY_FRAG)),
      clear: program(gl, vs, compile(gl, gl.FRAGMENT_SHADER, CLEAR_FRAG)),
      splat: program(gl, vs, compile(gl, gl.FRAGMENT_SHADER, SPLAT_FRAG)),
      advection: program(gl, vs, compile(gl, gl.FRAGMENT_SHADER, ADVECTION_FRAG, advectionKeywords)),
      divergence: program(gl, vs, compile(gl, gl.FRAGMENT_SHADER, DIVERGENCE_FRAG)),
      curl: program(gl, vs, compile(gl, gl.FRAGMENT_SHADER, CURL_FRAG)),
      vorticity: program(gl, vs, compile(gl, gl.FRAGMENT_SHADER, VORTICITY_FRAG)),
      pressure: program(gl, vs, compile(gl, gl.FRAGMENT_SHADER, PRESSURE_FRAG)),
      gradient: program(gl, vs, compile(gl, gl.FRAGMENT_SHADER, GRADIENT_FRAG)),
      display: program(gl, vs, compile(gl, gl.FRAGMENT_SHADER, DISPLAY_FRAG))
    };

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    const quads = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quads);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(programs.copy.program, 'aPosition');
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(loc);

    let dye = null, velocity = null, divergence = null, curl = null, pressure = null;
    let raf = 0, running = false, destroyed = false;
    let last = 0, autoTimer = 0, lastResize = 0;
    let slowFrames = 0, quality = 1, dprCap = opts.dprCap;
    let intensity = opts.intensity, light = opts.light;
    const pointers = new Map();

    function blit(target) {
      if (target) {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      } else {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }

    function fbo(w, h, fmt, filter) {
      gl.activeTexture(gl.TEXTURE0);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, w, h, 0, fmt.format, texType, null);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return {
        texture, fbo: framebuffer, width: w, height: h,
        texelSizeX: 1 / w, texelSizeY: 1 / h,
        attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
      };
    }

    function doubleFBO(w, h, fmt, filter) {
      let a = fbo(w, h, fmt, filter), b = fbo(w, h, fmt, filter);
      return {
        width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
        get read() { return a; }, set read(v) { a = v; },
        get write() { return b; }, set write(v) { b = v; },
        swap() { const t = a; a = b; b = t; }
      };
    }

    function destroyFBO(f) {
      if (!f) return;
      gl.deleteTexture(f.texture); gl.deleteFramebuffer(f.fbo);
    }
    function destroyDouble(d) { if (!d) return; destroyFBO(d.read); destroyFBO(d.write); }

    function resolution(base) {
      let aspect = gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight);
      if (aspect < 1) aspect = 1 / aspect;
      const min = Math.round(base), max = Math.round(base * aspect);
      return gl.drawingBufferWidth > gl.drawingBufferHeight ? { width: max, height: min } : { width: min, height: max };
    }

    function initFBOs() {
      const sim = resolution(Math.max(48, Math.round(opts.simResolution * quality)));
      const dyeRes = resolution(Math.max(192, Math.round(opts.dyeResolution * quality)));
      const filter = linear && useHalf ? gl.LINEAR : gl.NEAREST;
      destroyDouble(dye); destroyDouble(velocity);
      destroyFBO(divergence); destroyFBO(curl); destroyDouble(pressure);
      dye = doubleFBO(dyeRes.width, dyeRes.height, formatRGBA, filter);
      velocity = doubleFBO(sim.width, sim.height, formatRG, filter);
      divergence = fbo(sim.width, sim.height, formatR, gl.NEAREST);
      curl = fbo(sim.width, sim.height, formatR, gl.NEAREST);
      pressure = doubleFBO(sim.width, sim.height, formatR, gl.NEAREST);
      gl.disable(gl.BLEND);
      seed(7);
    }

    function resize() {
      const dpr = Math.min(root.devicePixelRatio || 1, dprCap);
      const w = Math.max(1, Math.round((canvas.clientWidth || root.innerWidth) * dpr));
      const h = Math.max(1, Math.round((canvas.clientHeight || root.innerHeight) * dpr));
      if (canvas.width === w && canvas.height === h) return false;
      canvas.width = w; canvas.height = h;
      initFBOs();
      return true;
    }

    function color() {
      const p = PALETTE[(Math.random() * PALETTE.length) | 0];
      const j = 0.78 + Math.random() * 0.44;
      return [p[0] * j, p[1] * j, p[2] * j];
    }

    function splat(x, y, dx, dy, rgb) {
      if (!dye || !velocity) return;
      const aspect = canvas.width / Math.max(1, canvas.height);
      let radius = opts.splatRadius / 100;
      if (aspect > 1) radius *= aspect;
      gl.useProgram(programs.splat.program);
      gl.uniform1i(programs.splat.uniforms.uTarget, velocity.read.attach(0));
      gl.uniform1f(programs.splat.uniforms.aspectRatio, aspect);
      gl.uniform2f(programs.splat.uniforms.point, x, y);
      gl.uniform3f(programs.splat.uniforms.color, dx, dy, 0);
      gl.uniform1f(programs.splat.uniforms.radius, radius);
      blit(velocity.write); velocity.swap();
      gl.uniform1i(programs.splat.uniforms.uTarget, dye.read.attach(0));
      gl.uniform3f(programs.splat.uniforms.color, rgb[0], rgb[1], rgb[2]);
      blit(dye.write); dye.swap();
    }

    function seed(n) {
      const spots = [[0.22,0.18],[0.7,0.28],[0.3,0.55],[0.78,0.62],[0.18,0.82],[0.6,0.88],[0.5,0.42]];
      for (let i = 0; i < n; i++) {
        const c = color(), s = 2.2 + Math.random() * 1.2;
        const at = spots[i % spots.length];
        splat(at[0] + (Math.random() - 0.5) * 0.1, at[1] + (Math.random() - 0.5) * 0.1,
          (Math.random() - 0.5) * 1100, (Math.random() - 0.5) * 1100,
          [c[0] * s, c[1] * s, c[2] * s]);
      }
    }

    function step(dt) {
      gl.disable(gl.BLEND);
      // curl
      gl.useProgram(programs.curl.program);
      gl.uniform2f(programs.curl.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(programs.curl.uniforms.uVelocity, velocity.read.attach(0));
      blit(curl);
      // vorticity
      gl.useProgram(programs.vorticity.program);
      gl.uniform2f(programs.vorticity.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(programs.vorticity.uniforms.uVelocity, velocity.read.attach(0));
      gl.uniform1i(programs.vorticity.uniforms.uCurl, curl.attach(1));
      gl.uniform1f(programs.vorticity.uniforms.curl, opts.curl);
      gl.uniform1f(programs.vorticity.uniforms.dt, dt);
      blit(velocity.write); velocity.swap();
      // divergence
      gl.useProgram(programs.divergence.program);
      gl.uniform2f(programs.divergence.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(programs.divergence.uniforms.uVelocity, velocity.read.attach(0));
      blit(divergence);
      // pressure decay
      gl.useProgram(programs.clear.program);
      gl.uniform1i(programs.clear.uniforms.uTexture, pressure.read.attach(0));
      gl.uniform1f(programs.clear.uniforms.value, 0.8);
      blit(pressure.write); pressure.swap();
      // pressure solve
      gl.useProgram(programs.pressure.program);
      gl.uniform2f(programs.pressure.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(programs.pressure.uniforms.uDivergence, divergence.attach(0));
      for (let i = 0; i < opts.pressureIterations; i++) {
        gl.uniform1i(programs.pressure.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write); pressure.swap();
      }
      // gradient subtract
      gl.useProgram(programs.gradient.program);
      gl.uniform2f(programs.gradient.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform1i(programs.gradient.uniforms.uPressure, pressure.read.attach(0));
      gl.uniform1i(programs.gradient.uniforms.uVelocity, velocity.read.attach(1));
      blit(velocity.write); velocity.swap();
      // velocity advection
      gl.useProgram(programs.advection.program);
      gl.uniform2f(programs.advection.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      if (!(linear && useHalf)) gl.uniform2f(programs.advection.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
      const vid = velocity.read.attach(0);
      gl.uniform1i(programs.advection.uniforms.uVelocity, vid);
      gl.uniform1i(programs.advection.uniforms.uSource, vid);
      gl.uniform1f(programs.advection.uniforms.dt, dt);
      gl.uniform1f(programs.advection.uniforms.dissipation, 0.14);
      blit(velocity.write); velocity.swap();
      // dye advection
      if (!(linear && useHalf)) gl.uniform2f(programs.advection.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
      gl.uniform1i(programs.advection.uniforms.uVelocity, velocity.read.attach(0));
      gl.uniform1i(programs.advection.uniforms.uSource, dye.read.attach(1));
      gl.uniform1f(programs.advection.uniforms.dissipation, 0.62);
      blit(dye.write); dye.swap();
    }

    function draw() {
      if (!dye) return;
      gl.useProgram(programs.display.program);
      gl.uniform2f(programs.display.uniforms.texelSize, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
      gl.uniform1i(programs.display.uniforms.uTexture, dye.read.attach(0));
      gl.uniform1f(programs.display.uniforms.uLight, light ? 1 : 0);
      gl.uniform1f(programs.display.uniforms.uExposure, intensity);
      blit(null);
    }

    function frame(now) {
      raf = 0;
      if (destroyed || !running) return;
      if (document.hidden) { raf = requestAnimationFrame(frame); return; }
      if (now - last < 33) { raf = requestAnimationFrame(frame); return; }
      const dt = Math.min(0.033, Math.max(0.001, (now - (last || now)) / 1000));
      last = now;
      resize();
      // autonomous motion so the phone never looks static
      autoTimer += dt * 1000;
      if (autoTimer > opts.autoSplatMs) {
        autoTimer = 0;
        for (let k = 0; k < 2; k++) {
          const c = color(), s = 2.4 + Math.random() * 1.1;
          splat(0.12 + Math.random() * 0.76, 0.15 + Math.random() * 0.7,
            (Math.random() - 0.5) * 1500, (Math.random() - 0.5) * 1500,
            [c[0] * s, c[1] * s, c[2] * s]);
        }
      }
      pointers.forEach((p, id) => {
        if (!p.moved) return;
        p.moved = false;
        const dx = (p.x - p.px) * opts.splatForce;
        const dy = (p.y - p.py) * opts.splatForce;
        if (Math.abs(dx) + Math.abs(dy) < 1) return;
        splat(p.x, 1 - p.y, dx, -dy, [p.c[0] * 2.4, p.c[1] * 2.4, p.c[2] * 2.4]);
        p.px = p.x; p.py = p.y;
      });
      step(dt);
      draw();
      const cost = performance.now() - now;
      if (cost > 30) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
      if (slowFrames > 24) {
        slowFrames = 0;
        if (quality > 0.7) { quality = 0.7; initFBOs(); }
        else if (dprCap > 1.0) { dprCap = 1.0; canvas.width = 0; resize(); }
      }
      raf = requestAnimationFrame(frame);
    }

    function point(e) {
      return { x: e.clientX / Math.max(1, root.innerWidth), y: e.clientY / Math.max(1, root.innerHeight) };
    }
    function onDown(e) {
      if (!running) return;
      const p = point(e);
      pointers.set(e.pointerId, { x: p.x, y: p.y, px: p.x, py: p.y, moved: true, c: color() });
    }
    function onMove(e) {
      if (!running) return;
      let p = pointers.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'touch') return;
        p = { x: point(e).x, y: point(e).y, px: 0, py: 0, moved: false, c: color() };
        p.px = p.x; p.py = p.y;
        pointers.set(e.pointerId, p);
      }
      const q = point(e);
      p.px = p.x; p.py = p.y; p.x = q.x; p.y = q.y; p.moved = true;
    }
    function onUp(e) { pointers.delete(e.pointerId); }
    function onVisibility() {
      if (document.hidden) stop(false);
      else if (!destroyed) start();
    }

    const listeners = [
      ['pointerdown', onDown, { passive: true }],
      ['pointermove', onMove, { passive: true }],
      ['pointerup', onUp, { passive: true }],
      ['pointercancel', onUp, { passive: true }]
    ];

    function addListeners() {
      listeners.forEach(([n, fn, o]) => root.addEventListener(n, fn, o));
      document.addEventListener('visibilitychange', onVisibility);
    }
    function removeListeners() {
      listeners.forEach(([n, fn, o]) => root.removeEventListener(n, fn, o));
      document.removeEventListener('visibilitychange', onVisibility);
    }

    function start() {
      if (running || destroyed) return;
      running = true;
      last = 0;
      addListeners();
      if (!raf) raf = requestAnimationFrame(frame);
    }
    function stop(hide) {
      running = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      removeListeners();
      if (hide) canvas.style.visibility = 'hidden';
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true; stop(false);
      destroyDouble(dye); destroyDouble(velocity); destroyDouble(pressure);
      destroyFBO(divergence); destroyFBO(curl);
      Object.values(programs).forEach(p => gl.deleteProgram(p.program));
      gl.deleteShader(vs);
      gl.deleteBuffer(buffer); gl.deleteBuffer(quads);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      canvas.remove();
    }

    resize();
    start();
    return {
      canvas,
      start, stop, destroy, resize,
      splat,
      setIntensity(v) { intensity = Math.max(0.5, Math.min(1.6, Number(v) || 1)); },
      setTheme(isLight) { light = !!isLight; },
      isRunning() { return running; }
    };
  }

  root.JarvisFluid = { create };
})(typeof globalThis !== 'undefined' ? globalThis : window);

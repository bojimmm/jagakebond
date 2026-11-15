/* Public sign-in conveniences; no credentials or account data are persisted here. */
(() => {
  'use strict';
  const wire = () => {
    const button = document.getElementById('auth-toggle-password');
    const field = document.getElementById('auth-password');
    if (button && field) button.addEventListener('click', () => {
      const shown = field.type === 'password';
      field.type = shown ? 'text' : 'password';
      button.textContent = shown ? 'Tutup' : 'Lihat';
      button.setAttribute('aria-pressed', String(shown));
      button.setAttribute('aria-label', shown ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
    });
    const register = document.getElementById('auth-tab-register');
    // The existing API wrapper selects the real backend on Android; a relative
    // fetch would incorrectly contact Capacitor's local static-file server.
    if (register && typeof api === 'function') api('/api/auth/options', { anonymous: true })
      .then(options => {
        const open = !!(options && options.passwordRegistration === true);
        register.hidden = !open;
        const hint = document.getElementById('auth-hint');
        if (open && hint) hint.textContent = 'Baru di JagaKebond? Buat akun untuk mulai mencatat.';
      }).catch(() => { /* Closed by default when offline or on an older server. */ });
  };
  const wireLandingChrome = () => {
    const authGate = document.getElementById('auth-gate');
    if (!authGate) return;
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons(); } catch (_) {}
    }

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';

    const topbar = document.getElementById('topbar');
    const menuToggle = document.getElementById('menu-toggle');
    const mobileDrawer = document.getElementById('mobile-drawer');

    const setBar = (show) => {
      if (!topbar) return;
      topbar.classList.toggle('is-shown', show);
      topbar.setAttribute('aria-hidden', String(!show));
    };

    const closeDrawer = (restoreFocus) => {
      if (!mobileDrawer || mobileDrawer.hidden) return;
      mobileDrawer.classList.remove('is-open');
      if (menuToggle) {
        menuToggle.setAttribute('aria-expanded', 'false');
        menuToggle.setAttribute('aria-label', window.JagaI18n ? window.JagaI18n.t('Buka menu navigasi') : 'Buka menu navigasi');
      }
      window.setTimeout(() => {
        if (menuToggle && menuToggle.getAttribute('aria-expanded') === 'false') mobileDrawer.hidden = true;
      }, reduce ? 0 : 250);
      if (restoreFocus && menuToggle) menuToggle.focus({ preventScroll: true });
    };

    const openDrawer = () => {
      if (!mobileDrawer || !menuToggle) return;
      mobileDrawer.hidden = false;
      menuToggle.setAttribute('aria-expanded', 'true');
      menuToggle.setAttribute('aria-label', window.JagaI18n ? window.JagaI18n.t('Tutup menu navigasi') : 'Tutup menu navigasi');
      window.requestAnimationFrame(() => {
        mobileDrawer.classList.add('is-open');
        if (hasGsap && !reduce) {
          window.gsap.fromTo('#mobile-drawer a',
            { y: 20, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.4, stagger: 0.05, ease: 'expo.out' }
          );
        }
      });
    };

    if (menuToggle && mobileDrawer) {
      menuToggle.addEventListener('click', () => {
        const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
        if (expanded) closeDrawer(false); else openDrawer();
      });
      mobileDrawer.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => closeDrawer(false));
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && menuToggle.getAttribute('aria-expanded') === 'true') closeDrawer(true);
      });
    }

    authGate.querySelectorAll('a[href^="#"]').forEach(link => {
      link.addEventListener('click', (ev) => {
        const href = link.getAttribute('href');
        if (!href || href === '#') return;
        const target = href === '#auth-gate' ? authGate : document.getElementById(href.slice(1));
        if (!target) return;
        ev.preventDefault();
        closeDrawer(false);
        if (target === authGate) {
          authGate.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
        } else {
          const gateRect = authGate.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          const top = Math.max(0, authGate.scrollTop + (targetRect.top - gateRect.top) - 76);
          authGate.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
        }
      });
    });

    const syncTopbar = () => {
      if (authGate.classList.contains('hidden')) { setBar(false); return; }
      const layout = authGate.querySelector('.auth-layout');
      const threshold = layout ? Math.max(260, layout.offsetHeight * 0.55) : 340;
      setBar(authGate.scrollTop >= threshold);
    };
    authGate.addEventListener('scroll', syncTopbar, { passive: true });
    syncTopbar();

    const videoEl = document.getElementById('explainer-video');
    const chapterBtns = Array.from(document.querySelectorAll('#video-panduan .chapter-btn'));
    const setActiveChapter = (idx) => {
      chapterBtns.forEach((btn, i) => {
        const on = i === idx;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', String(on));
      });
    };
    chapterBtns.forEach((btn, i) => {
      btn.addEventListener('click', () => {
        const seekSec = Number(btn.getAttribute('data-seek')) || 0;
        setActiveChapter(i);
        if (videoEl) {
          try {
            videoEl.currentTime = seekSec;
            const p = videoEl.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch (_) {}
        }
      });
    });
    if (videoEl) {
      videoEl.addEventListener('click', () => {
        try {
          const dur = Number(videoEl.duration);
          if (videoEl.ended || (Number.isFinite(dur) && dur > 0 && videoEl.currentTime >= dur - 0.15)) {
            videoEl.currentTime = 0;
            const p = videoEl.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } else if (videoEl.paused) {
            const p = videoEl.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } else {
            videoEl.pause();
          }
        } catch (_) {}
      });
      videoEl.addEventListener('timeupdate', () => {
        const idx = Math.min(4, Math.floor((videoEl.currentTime || 0) / 4));
        setActiveChapter(idx);
      });
      videoEl.addEventListener('ended', () => {
        setActiveChapter(4);
      });
    }

    if (hasGsap && !authGate.classList.contains('hidden')) {
      window.gsap.registerPlugin(window.ScrollTrigger);
      const mm = window.gsap.matchMedia();
      mm.add('(prefers-reduced-motion: reduce)', () => {
        window.gsap.set(['.auth-brand-panel .landing-brand', '.landing-copy > *', '.landing-farmer', '.landing-app-shot', '.auth-panel-inner', '#auth-gate .reveal', '#tagline .w'], {
          opacity: 1, y: 0
        });
      });
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const heroTl = window.gsap.timeline({ defaults: { ease: 'expo.out', duration: 0.9 } });
        heroTl
          .fromTo('.auth-brand-panel .landing-brand', { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.65 }, 0)
          .fromTo('.landing-copy > *', { y: 18, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.08, duration: 0.85 }, 0.06)
          .fromTo('.landing-farmer', { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.85 }, 0.14)
          .fromTo(['.landing-app-map', '.landing-app-home', '.landing-app-history'],
            { y: 20, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.09, duration: 0.85 }, 0.18)
          .fromTo('.auth-panel-inner', { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.85 }, 0.10);

        if (window.matchMedia('(hover: hover)').matches) {
          authGate.querySelectorAll('.landing-app-shot').forEach(card => {
            card.addEventListener('mouseenter', () => window.gsap.to(card, { y: -6, duration: 0.45, ease: 'power3.out', overwrite: 'auto' }));
            card.addEventListener('mouseleave', () => window.gsap.to(card, { y: 0, duration: 0.55, ease: 'power3.out', overwrite: 'auto' }));
          });
        }

        const taglineEl = document.getElementById('tagline');
        const revealEls = Array.from(authGate.querySelectorAll('.reveal'));
        if ('IntersectionObserver' in window) {
          if (taglineEl) {
            const tagObs = new IntersectionObserver((entries, obs) => {
              if (entries.some(e => e.isIntersecting)) {
                window.gsap.to('#tagline .w', { opacity: 1, duration: 0.6, stagger: 0.06, ease: 'power3.out', overwrite: 'auto' });
                obs.disconnect();
              }
            }, { root: authGate, threshold: 0.05 });
            tagObs.observe(taglineEl);
          }
          window.gsap.set(revealEls, { y: 24, opacity: 0 });
          const revObs = new IntersectionObserver((entries, obs) => {
            const above = [], inView = [];
            const gateRect = authGate.getBoundingClientRect();
            entries.forEach(entry => {
              if (entry.boundingClientRect.bottom <= gateRect.top + 10) {
                above.push(entry.target);
                obs.unobserve(entry.target);
              } else if (entry.isIntersecting || entry.boundingClientRect.top < gateRect.bottom) {
                inView.push(entry.target);
                obs.unobserve(entry.target);
              }
            });
            if (above.length) window.gsap.set(above, { y: 0, opacity: 1, overwrite: 'auto' });
            if (inView.length) {
              window.gsap.to(inView, {
                y: 0, opacity: 1, duration: 0.55,
                stagger: Math.min(0.05, 0.20 / inView.length),
                ease: 'expo.out', overwrite: 'auto'
              });
            }
          }, { root: authGate, rootMargin: '0px 0px 40px 0px', threshold: 0.01 });
          revealEls.forEach(el => revObs.observe(el));
        } else {
          authGate.querySelectorAll('.reveal, #tagline .w').forEach(el => {
            el.style.opacity = '1';
            el.style.transform = 'none';
          });
        }
      });
    } else {
      authGate.querySelectorAll('.reveal, #tagline .w').forEach(el => {
        el.style.opacity = '1';
        el.style.transform = 'none';
      });
    }
  };
  const initLandingTour = () => {
    const authGate = document.getElementById('auth-gate');
    const canvas = document.getElementById('island-canvas');
    if (!authGate || !canvas) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const STEP_META = [
      { label: 'Langkah 1 dari 5', badge: 'Beranda: Ringkasan kebun dan cuaca', icon: 'compass', next: 'Lanjut ke Foto', shot: 'img/landing-app-mobile.png' },
      { label: 'Langkah 2 dari 5', badge: 'Foto Tanaman: Pindai gejala dan GPS', icon: 'camera', next: 'Lanjut ke Riwayat', shot: 'img/mobile-hud.png' },
      { label: 'Langkah 3 dari 5', badge: 'Riwayat: Status dan koreksi per tanaman', icon: 'clipboard-list', next: 'Lanjut ke Peta', shot: 'img/mobile-scan.png' },
      { label: 'Langkah 4 dari 5', badge: 'Peta: Batas petak dan pin status', icon: 'map-pin', next: 'Lanjut ke Offline', shot: 'img/mobile-map.png' },
      { label: 'Langkah 5 dari 5', badge: 'Siap Mencatat: Antrean offline tersinkron', icon: 'cloud', next: 'Kembali ke Beranda', shot: 'img/mobile-history.png' }
    ];
    const progressLabel = document.getElementById('island-progress-label');
    const badgeText = document.getElementById('island-badge-text');
    const badgeIconWrap = document.getElementById('island-badge-icon');
    const pillBtns = Array.from(document.querySelectorAll('#cara .island-pill'));
    const stepCards = Array.from(document.querySelectorAll('#cara .tour-step-card'));
    const prevBtn = document.getElementById('tour-prev');
    const nextBtn = document.getElementById('tour-next');
    const tourState = {
      currentStep: 0, targetFloat: 0, smoothFloat: 0,
      yawOffset: 0, pitchOffset: 0, dragging: false,
      manualLockUntil: 0, lastX: 0, lastY: 0, clockSec: 0
    };
    window.__JK_ISLAND_STATE__ = tourState;
    const isMobileTour = () => window.innerWidth <= 1023;

    const cardCenterProgress = () => {
      if (!stepCards.length) return 0;
      const mid = window.innerHeight * 0.5;
      const centers = stepCards.map(c => {
        const r = c.getBoundingClientRect();
        return r.top + r.height * 0.5;
      });
      if (mid <= centers[0]) return 0;
      const last = centers.length - 1;
      if (mid >= centers[last]) return last;
      for (let i = 0; i < last; i++) {
        if (mid >= centers[i] && mid <= centers[i + 1]) {
          const span = Math.max(1, centers[i + 1] - centers[i]);
          return i + Math.max(0, Math.min(1, (mid - centers[i]) / span));
        }
      }
      return 0;
    };

    const updateBadgeIcon = (iconName) => {
      if (!badgeIconWrap || !iconName) return;
      badgeIconWrap.innerHTML = '<i data-lucide="' + iconName + '" aria-hidden="true"></i>';
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        try { window.lucide.createIcons(); } catch (_) {}
      }
    };

    const applyStepUI = (idx) => {
      const clamped = Math.max(0, Math.min(4, idx));
      const changed = clamped !== tourState.currentStep;
      tourState.currentStep = clamped;
      tourState.targetFloat = clamped;
      const meta = STEP_META[clamped];
      const tr = (text) => (window.JagaI18n && typeof window.JagaI18n.t === 'function') ? window.JagaI18n.t(text) : text;
      if (progressLabel) progressLabel.textContent = tr(meta.label);
      if (badgeText) badgeText.textContent = tr(meta.badge);
      if (changed) updateBadgeIcon(meta.icon);
      pillBtns.forEach((btn, i) => {
        const on = i === clamped;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', String(on));
      });
      stepCards.forEach((card, i) => card.classList.toggle('is-active', i === clamped));
      if (prevBtn) prevBtn.disabled = clamped === 0;
      if (nextBtn) nextBtn.textContent = tr(meta.next);
    };
    window.addEventListener('jk:langchange', () => applyStepUI(tourState.currentStep));

    const selectStepExplicit = (idx, scrollCard) => {
      const clamped = Math.max(0, Math.min(4, idx));
      tourState.manualLockUntil = Date.now() + 950;
      applyStepUI(clamped);
      if (scrollCard && !isMobileTour() && stepCards[clamped]) {
        stepCards[clamped].scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      }
    };

    pillBtns.forEach(btn => btn.addEventListener('click', () => selectStepExplicit(Number(btn.dataset.step) || 0, true)));
    stepCards.forEach(card => card.addEventListener('click', () => selectStepExplicit(Number(card.dataset.tourStep) || 0, false)));
    if (prevBtn) prevBtn.addEventListener('click', () => selectStepExplicit(Math.max(0, tourState.currentStep - 1), true));
    if (nextBtn) nextBtn.addEventListener('click', () => selectStepExplicit(tourState.currentStep >= 4 ? 0 : tourState.currentStep + 1, true));

    const tourStepsWrap = document.getElementById('tour-steps-list');
    if (tourStepsWrap) {
      let swipeX = 0, swipeY = 0;
      tourStepsWrap.addEventListener('touchstart', e => {
        if (!isMobileTour() || !e.touches.length) return;
        swipeX = e.touches[0].clientX;
        swipeY = e.touches[0].clientY;
      }, { passive: true });
      tourStepsWrap.addEventListener('touchend', e => {
        if (!isMobileTour() || !e.changedTouches.length) return;
        const dx = e.changedTouches[0].clientX - swipeX;
        const dy = e.changedTouches[0].clientY - swipeY;
        if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          if (dx < 0 && tourState.currentStep < 4) selectStepExplicit(tourState.currentStep + 1, false);
          else if (dx > 0 && tourState.currentStep > 0) selectStepExplicit(tourState.currentStep - 1, false);
        }
      }, { passive: true });
    }

    const onScrollSync = () => {
      if (isMobileTour() || tourState.dragging || Date.now() <= tourState.manualLockUntil || authGate.classList.contains('hidden')) return;
      const prog = cardCenterProgress();
      tourState.targetFloat = prog;
      const nearest = Math.max(0, Math.min(4, Math.round(prog)));
      if (nearest !== tourState.currentStep) {
        tourState.currentStep = nearest;
        const meta = STEP_META[nearest];
        if (progressLabel) progressLabel.textContent = meta.label;
        if (badgeText) badgeText.textContent = meta.badge;
        updateBadgeIcon(meta.icon);
        pillBtns.forEach((b, i) => { b.classList.toggle('is-active', i === nearest); b.setAttribute('aria-selected', String(i === nearest)); });
        stepCards.forEach((c, i) => c.classList.toggle('is-active', i === nearest));
        if (prevBtn) prevBtn.disabled = nearest === 0;
        if (nextBtn) nextBtn.textContent = meta.next;
      }
    };
    authGate.addEventListener('scroll', onScrollSync, { passive: true });
    window.addEventListener('scroll', onScrollSync, { passive: true });

    const startDrag = (x, y) => { tourState.dragging = true; tourState.lastX = x; tourState.lastY = y; };
    const moveDrag = (x, y) => {
      if (!tourState.dragging) return;
      tourState.yawOffset = Math.max(-0.85, Math.min(0.85, tourState.yawOffset + (x - tourState.lastX) * 0.008));
      tourState.pitchOffset = Math.max(-0.35, Math.min(0.45, tourState.pitchOffset + (y - tourState.lastY) * 0.006));
      tourState.lastX = x; tourState.lastY = y;
    };
    const endDrag = () => { tourState.dragging = false; };
    canvas.addEventListener('mousedown', e => startDrag(e.clientX, e.clientY));
    window.addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
    window.addEventListener('mouseup', endDrag);
    canvas.addEventListener('touchstart', e => { if (e.touches.length) startDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    canvas.addEventListener('touchmove', e => {
      if (!tourState.dragging || !e.touches.length) return;
      e.preventDefault();
      moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    canvas.addEventListener('touchend', endDrag);

    const THREE = window.THREE;
    const clamp01 = v => Math.max(0, Math.min(1, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
    const easeOutBack = x => { const c1 = 1.70158, c3 = c1 + 1, t = clamp01(x); return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
    const easeOutCubic = x => 1 - Math.pow(1 - clamp01(x), 3);

    let webglRenderer = null;
    if (THREE) {
      try {
        webglRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        webglRenderer.setSize(720, 540, false);
        webglRenderer.setClearColor(0x000000, 0);
        webglRenderer.shadowMap.enabled = true;
        webglRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
      } catch (_) {
        webglRenderer = null;
      }
    }

    if (webglRenderer && THREE) {
      const ASPECT = 720 / 540;
      const FH_ASPECT_SCALE = 1.28;
      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);

      const hemiLight = new THREE.HemisphereLight(0xf4fbf2, 0x6d5b4a, 0.62);
      const ambLight = new THREE.AmbientLight(0xffffff, 0.16);
      const sun = new THREE.DirectionalLight(0xfff3df, 0.95);
      sun.position.set(-7, 16, 9);
      sun.castShadow = true;
      const smSize = Math.min(1024, webglRenderer.capabilities.maxTextureSize || 1024);
      sun.shadow.mapSize.set(smSize, smSize);
      sun.shadow.camera.left = -9;
      sun.shadow.camera.right = 9;
      sun.shadow.camera.top = 9;
      sun.shadow.camera.bottom = -9;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 50;
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.02;
      sun.shadow.radius = 3;
      const fillLight = new THREE.DirectionalLight(0xe7f0ff, 0.22);
      fillLight.position.set(10, 6, -4);
      scene.add(hemiLight, ambLight, sun, fillLight);

      const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
      const smoother = t => { const u = clamp01(t); return u * u * u * (u * (u * 6 - 15) + 10); };
      const win = (x, a, b) => clamp01((x - a) / (b - a));
      const settle = (t, w) => (t <= 0 ? 0 : 1 - Math.exp(-(w || 9) * t) * (1 + (w || 9) * t));
      const popEase = t => (t <= 0 ? 0 : t >= 1.6 ? 1 : 1 - Math.exp(-7 * t) * Math.cos(9 * t));
      const rng = seed0 => {
        let seed = seed0;
        return () => {
          seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      };
      const canvasRRect = (ctx, x, y, w, h, r) => {
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.lineTo(x + w - rr, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
        ctx.lineTo(x + w, y + h - rr);
        ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
        ctx.lineTo(x + rr, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
        ctx.lineTo(x, y + rr);
        ctx.quadraticCurveTo(x, y, x + rr, y);
        ctx.closePath();
      };

      const R = rng(20261115);
      const std = (hex, o) => new THREE.MeshStandardMaterial(Object.assign({ color: hex, flatShading: true, roughness: 0.9, metalness: 0 }, o || {}));
      const addMesh = (parent, mesh, x, y, z, cast, recv) => {
        mesh.position.set(x || 0, y || 0, z || 0);
        mesh.castShadow = cast !== false;
        mesh.receiveShadow = recv !== false;
        parent.add(mesh);
        return mesh;
      };

      const world = new THREE.Group();
      scene.add(world);

      /* Soft grounded WebGL contact shadow directly below the rounded-rectangle island */
      (() => {
        const scv = document.createElement('canvas');
        scv.width = 256; scv.height = 256;
        const sctx2 = scv.getContext('2d');
        sctx2.clearRect(0, 0, 256, 256);
        for (let q = 0; q < 14; q++) {
          const p = q / 13;
          const pad = 16 + p * 34;
          sctx2.fillStyle = 'rgba(15, 31, 20, ' + (0.012 + (1 - p) * 0.014).toFixed(4) + ')';
          canvasRRect(sctx2, pad, pad + 6, 256 - pad * 2, 256 - pad * 2, 42 - p * 12);
          sctx2.fill();
        }
        const stex = new THREE.CanvasTexture(scv);
        const smesh = new THREE.Mesh(
          new THREE.PlaneGeometry(13.4, 11.2),
          new THREE.MeshBasicMaterial({ map: stex, transparent: true, opacity: 0.65, depthWrite: false })
        );
        smesh.rotation.x = -Math.PI / 2;
        smesh.position.set(0, -1.96, 0.12);
        smesh.renderOrder = 1;
        world.add(smesh);
      })();

      /* Rounded-rectangle low-poly island */
      const IX = 5, IZ = 4, IR = 1.5;
      const rrShape = (x0, z0, x1, z1, rTL, rTR, rBR, rBL) => {
        const s = new THREE.Shape();
        s.moveTo(x0 + rBL, -z1);
        s.lineTo(x1 - rBR, -z1);
        if (rBR) s.quadraticCurveTo(x1, -z1, x1, -(z1 - rBR)); else s.lineTo(x1, -z1);
        s.lineTo(x1, -(z0 + rTR));
        if (rTR) s.quadraticCurveTo(x1, -z0, x1 - rTR, -z0); else s.lineTo(x1, -z0);
        s.lineTo(x0 + rTL, -z0);
        if (rTL) s.quadraticCurveTo(x0, -z0, x0, -(z0 + rTL)); else s.lineTo(x0, -z0);
        s.lineTo(x0, -(z1 - rBL));
        if (rBL) s.quadraticCurveTo(x0, -z1, x0 + rBL, -z1); else s.lineTo(x0, -z1);
        return s;
      };
      const slab = (shape, yBottom, height, mat, bevel, seg) => {
        const bv = bevel === undefined ? 0.03 : bevel;
        const geo = new THREE.ExtrudeGeometry(shape, {
          depth: Math.max(0.001, height - bv * 2),
          curveSegments: seg || 3,
          bevelEnabled: bv > 0,
          bevelThickness: bv,
          bevelSize: bv,
          bevelSegments: 1
        });
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, yBottom + bv, 0);
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true; m.receiveShadow = true;
        return m;
      };

      const TOP = 0.1;
      const islandBase = new THREE.Group();
      world.add(islandBase);
      islandBase.add(slab(rrShape(-IX + 0.2, -IZ + 0.2, IX - 0.2, IZ - 0.2, IR - 0.2, IR - 0.2, IR - 0.2, IR - 0.2), -1.85, 0.95, std(0x8c8278), 0.06, 4));
      islandBase.add(slab(rrShape(-IX + 0.12, -IZ + 0.12, IX - 0.12, IZ - 0.12, IR - 0.12, IR - 0.12, IR - 0.12, IR - 0.12), -0.96, 0.3, std(0x6b4c35), 0.04, 4));
      islandBase.add(slab(rrShape(-IX + 0.08, -IZ + 0.08, IX - 0.08, IZ - 0.08, IR - 0.08, IR - 0.08, IR - 0.08, IR - 0.08), -0.7, 0.56, std(0x7d5a40), 0.04, 4));

      const grassCols = [0x6f9f58, 0x78a760, 0x699a53, 0x7dab64, 0x73a35c];
      const CW = (IX * 2) / 5, CD = (IZ * 2) / 5, GAP = 0.05;
      const raised = { '0,0': true, '1,0': true, '0,1': true };
      for (let gi = 0; gi < 5; gi++) {
        for (let gj = 0; gj < 5; gj++) {
          const x0 = -IX + gi * CW + GAP, x1 = -IX + (gi + 1) * CW - GAP;
          const z0 = -IZ + gj * CD + GAP, z1 = -IZ + (gj + 1) * CD - GAP;
          const rr = IR - GAP;
          const gShape = rrShape(
            x0, z0, x1, z1,
            gi === 0 && gj === 0 ? rr : 0, gi === 4 && gj === 0 ? rr : 0,
            gi === 4 && gj === 4 ? rr : 0, gi === 0 && gj === 4 ? rr : 0
          );
          const lift = raised[gi + ',' + gj] ? 0.22 : 0;
          const col = new THREE.Color(grassCols[(gi * 3 + gj * 2) % grassCols.length]);
          world.add(slab(gShape, -0.13, 0.23 + lift, std(col, { roughness: 0.95 }), 0.035, 3));
        }
      }
      const TERRACE = TOP + 0.22;

      /* Saung Kebun */
      const saung = new THREE.Group();
      saung.position.set(-3.15, TERRACE, -2.35);
      world.add(saung);
      const wood = std(0x9a6a3c), woodDark = std(0x6b4a2b), thatchA = std(0xb48650), thatchB = std(0x9c6f3d);
      [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]].forEach(pt => {
        addMesh(saung, new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.34, 0.14), woodDark), pt[0], 0.17, pt[1]);
        addMesh(saung, new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 1.15, 6), wood), pt[0], 0.34 + 0.08 + 0.575, pt[1]);
      });
      addMesh(saung, new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.1, 1.62), std(0xb98552)), 0, 0.39, 0);
      for (let dk = -3; dk <= 3; dk++) addMesh(saung, new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 1.6), woodDark), dk * 0.22, 0.446, 0, false, true);
      addMesh(saung, new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 0.06), wood), 0, 0.72, -0.62);
      addMesh(saung, new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.4), wood), -0.62, 0.72, 0);
      const roofLow = addMesh(saung, new THREE.Mesh(new THREE.ConeGeometry(1.42, 0.5, 4, 1, true), thatchA), 0, 1.66, 0);
      roofLow.rotation.y = Math.PI / 4;
      roofLow.material.side = THREE.DoubleSide;
      const roofTop = addMesh(saung, new THREE.Mesh(new THREE.ConeGeometry(0.86, 0.62, 4), thatchB), 0, 2.0, 0);
      roofTop.rotation.y = Math.PI / 4;
      addMesh(saung, new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.05, 1.02), woodDark), 0, 1.43, 0);

      const lanternMat = std(0xffe9a8, { emissive: 0xffa53a, emissiveIntensity: 0.1, roughness: 0.5 });
      addMesh(saung, new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.22, 4), woodDark), 0.5, 1.29, 0.5, false, true);
      addMesh(saung, new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.03, 0.17), woodDark), 0.5, 1.17, 0.5, false, true);
      const lantern = addMesh(saung, new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), lanternMat), 0.5, 1.06, 0.5, false, false);
      lantern.scale.set(1, 1.25, 1);
      const lanternLight = new THREE.PointLight(0xffb057, 0, 3.4, 2);
      lanternLight.position.set(0.5, 1.0, 0.5);
      saung.add(lanternLight);

      addMesh(saung, new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), std(0xc9cfd2, { roughness: 0.5 })), 0, 2.5, 0);
      const vane = new THREE.Group();
      vane.position.set(0, 2.76, 0);
      saung.add(vane);
      for (let vk = 0; vk < 3; vk++) {
        const arm = new THREE.Group(); arm.rotation.y = (vk * Math.PI * 2) / 3; vane.add(arm);
        addMesh(arm, new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.018, 0.018), std(0xd1d5db)), 0.15, 0, 0, true, false);
        const cup = addMesh(arm, new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.08, 6), std(vk === 0 ? 0xd97706 : 0x15803d)), 0.3, 0, 0, true, false);
        cup.rotation.z = Math.PI / 2;
      }

      /* Stepping stones path */
      [[-2.15, -1.55], [-1.75, -1.15], [-1.25, -0.95]].forEach((pt, k) => {
        const s = addMesh(world, new THREE.Mesh(new THREE.CylinderGeometry(0.2 - k * 0.01, 0.22, 0.05, 7), std(0xc9bfa9)), pt[0], TOP + 0.02, pt[1], false, true);
        s.rotation.y = k * 0.9;
      });

      /* Bedeng Cabai: Two Raised Beds with Silver Mulch & 6 Chili Plants */
      const BEDS = [{ z: -0.2 }, { z: 1.2 }];
      const BED_X = -1.05, BED_LEN = 4.3, BED_W = 0.9, BED_H = 0.3;
      const PLANT_X = [-2.45, -1.05, 0.35];
      BEDS.forEach(b => {
        world.add(slab(rrShape(BED_X - BED_LEN / 2, b.z - BED_W / 2, BED_X + BED_LEN / 2, b.z + BED_W / 2, 0.08, 0.08, 0.08, 0.08), TOP - 0.02, BED_H, std(0x7a4e33), 0.05, 2));
        world.add(slab(rrShape(BED_X - BED_LEN / 2 + 0.06, b.z - BED_W / 2 + 0.06, BED_X + BED_LEN / 2 - 0.06, b.z + BED_W / 2 - 0.06, 0.05, 0.05, 0.05, 0.05), TOP + BED_H - 0.03, 0.03, std(0xc3cacc, { roughness: 0.55, metalness: 0.15 }), 0.0, 2));
        PLANT_X.forEach(x => {
          addMesh(world, new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.012, 8), std(0x2b2f2c)), x, TOP + BED_H + 0.006, b.z, false, true);
        });
      });
      const BED_TOP = TOP + BED_H;

      const plantDefs = [
        { bed: 1, xi: 2, status: 'kritis', name: 'Cabai 1' },
        { bed: 1, xi: 1, status: 'waspada', name: 'Cabai 4' },
        { bed: 1, xi: 0, status: 'sehat', name: 'Cabai 7' },
        { bed: 0, xi: 1, status: 'kritis', name: 'Cabai 3' },
        { bed: 0, xi: 0, status: 'sehat', name: 'Cabai 6' },
        { bed: 0, xi: 2, status: 'sehat', name: 'Cabai 2' }
      ];
      const leafGreens = [0x3f7f35, 0x4a8f3c, 0x56993f, 0x46873a];
      const plants = plantDefs.map((d, idx) => {
        const g = new THREE.Group();
        g.position.set(PLANT_X[d.xi], BED_TOP, BEDS[d.bed].z);
        world.add(g);
        const sway = new THREE.Group(); g.add(sway);
        addMesh(sway, new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.04, 0.62, 5), std(0x4d7c3a)), 0, 0.31, 0);
        const sick = d.status === 'kritis';
        const pr = rng(100 + idx);
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2 + pr() * 0.6;
          const rad = 0.13 + pr() * 0.08;
          const col = sick && k % 3 === 0 ? 0x9a9a3e : leafGreens[(k + idx) % leafGreens.length];
          const leaf = addMesh(sway, new THREE.Mesh(new THREE.IcosahedronGeometry(0.15 + pr() * 0.05, 0), std(col, { roughness: 0.8 })), Math.cos(a) * rad, 0.55 + pr() * 0.22, Math.sin(a) * rad);
          leaf.scale.set(1, 0.72, 1);
          leaf.rotation.set(pr(), pr() * 3, pr());
          if (sick && k % 2 === 0) {
            addMesh(sway, new THREE.Mesh(new THREE.DodecahedronGeometry(0.035, 0), std(0x4a2c17)), Math.cos(a) * (rad + 0.13), 0.57 + pr() * 0.15, Math.sin(a) * (rad + 0.13), false, false);
          }
        }
        addMesh(sway, new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 0), std(leafGreens[idx % 4])), 0, 0.84, 0);
        for (let pk = 0; pk < 4; pk++) {
          const pa = (pk / 4) * Math.PI * 2 + 0.4;
          const pod = addMesh(sway, new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.22, 5), std(sick && pk === 1 ? 0x7c2d12 : 0xd4322c, { roughness: 0.45 })), Math.cos(pa) * 0.24, 0.42, Math.sin(pa) * 0.24);
          pod.rotation.set(Math.PI + Math.sin(pa) * 0.25, 0, Math.cos(pa) * 0.25);
        }
        const ajir = addMesh(g, new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 1.05, 5), std(0xc9a66b)), 0.17, 0.5, -0.1);
        ajir.rotation.z = 0.06;
        return { g, sway, def: d, top: new THREE.Vector3(g.position.x, BED_TOP + 0.95, g.position.z) };
      });
      const cabai1 = plants[0];

      /* Animated Low-Poly Pond + Border Stones + Lily Pads */
      const POND = { x: 2.95, z: 2.05, rx: 1.35, rz: 0.82 };
      const basin = addMesh(world, new THREE.Mesh(new THREE.CircleGeometry(1, 20), std(0x335f67)), POND.x, TOP + 0.012, POND.z, false, true);
      basin.rotation.x = -Math.PI / 2; basin.scale.set(POND.rx + 0.08, POND.rz + 0.08, 1);
      const pondGeo = new THREE.RingGeometry(0.0001, 1, 20, 4);
      pondGeo.rotateX(-Math.PI / 2);
      const pond = addMesh(world, new THREE.Mesh(pondGeo, std(0x5aaed0, { roughness: 0.18, metalness: 0.05, transparent: true, opacity: 0.93 })), POND.x, TOP + 0.05, POND.z, false, true);
      pond.scale.set(POND.rx, 1, POND.rz);
      const pondBase = Float32Array.from(pondGeo.attributes.position.array);
      for (let rk = 0; rk < 22; rk++) {
        const ra = (rk / 22) * Math.PI * 2;
        const rock = addMesh(world, new THREE.Mesh(new THREE.DodecahedronGeometry(0.1 + R() * 0.07, 0), std(R() > 0.5 ? 0x9aa39b : 0xa9b0a6)), POND.x + Math.cos(ra) * (POND.rx + 0.08), TOP + 0.05, POND.z + Math.sin(ra) * (POND.rz + 0.08));
        rock.scale.y = 0.6; rock.rotation.set(R(), R() * 3, R());
      }
      [[2.45, 1.85], [3.45, 2.35]].forEach(pt => {
        const pad = addMesh(world, new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.012, 7), std(0x4f9a4a)), pt[0], TOP + 0.075, pt[1], false, true);
        pad.rotation.y = pt[0];
      });

      /* Trees, Banana, Rocks, Grass Tufts */
      const makeTree = (x, z, s) => {
        const g = new THREE.Group(); g.position.set(x, TOP, z); g.scale.setScalar(s); world.add(g);
        addMesh(g, new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.9, 6), std(0x6b4a2b)), 0, 0.45, 0);
        addMesh(g, new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), std(0x4f8a3c)), 0, 1.15, 0);
        addMesh(g, new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 0), std(0x5f9a48)), 0.25, 1.5, 0.1);
        addMesh(g, new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), std(0x467d36)), -0.28, 1.35, -0.12);
        return g;
      };
      const trees = [makeTree(3.95, -2.75, 1.1), makeTree(4.25, -1.25, 0.82), makeTree(-4.2, 2.85, 0.75)];
      const banana = new THREE.Group(); banana.position.set(-4.25, TERRACE, -0.55); world.add(banana);
      addMesh(banana, new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.0, 6), std(0x7d8f45)), 0, 0.5, 0);
      for (let bk = 0; bk < 5; bk++) {
        const bleaf = new THREE.Group(); bleaf.position.y = 1.0; bleaf.rotation.y = (bk / 5) * Math.PI * 2; banana.add(bleaf);
        const bblade = addMesh(bleaf, new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.02, 0.22), std(bk % 2 ? 0x5e9c3e : 0x6aa847)), 0.33, 0.1, 0);
        bblade.rotation.z = 0.45;
      }
      for (let sr = 0; sr < 9; sr++) {
        const rx = lerp(-4.4, 4.4, R()), rz = lerp(-3.5, 3.5, R());
        if ((rx > -3.6 && rx < 1.6 && rz > -0.9 && rz < 1.9) || (Math.hypot((rx - POND.x) / 1.7, (rz - POND.z) / 1.2) < 1)) continue;
        const rr2 = addMesh(world, new THREE.Mesh(new THREE.DodecahedronGeometry(0.1 + R() * 0.12, 0), std(0x9aa39b)), rx, TOP + 0.03, rz);
        rr2.scale.y = 0.65; rr2.rotation.set(R(), R() * 3, R());
      }
      const tuftMat = std(0x5b8e45);
      for (let tk = 0; tk < 46; tk++) {
        const tx = lerp(-4.5, 4.5, R()), tz = lerp(-3.6, 3.6, R());
        if ((tx > -3.5 && tx < 1.5 && tz > -0.8 && tz < 1.8) || Math.hypot((tx - POND.x) / 1.6, (tz - POND.z) / 1.1) < 1 || (tx < -2 && tz < -1.2)) continue;
        if (Math.abs(tx) / IX + Math.abs(tz) / IZ > 1.55) continue;
        const tf = addMesh(world, new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16 + R() * 0.08, 4), tuftMat), tx, TOP + 0.08, tz, false, false);
        tf.rotation.set((R() - 0.5) * 0.5, R() * 3, (R() - 0.5) * 0.5);
      }

      /* Step 1: Scan Beam + GPS Rings + Reticle */
      const beamGeo = new THREE.ConeGeometry(1, 1, 28, 1, true);
      beamGeo.translate(0, -0.5, 0);
      beamGeo.rotateX(-Math.PI / 2);
      const beamMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
      const beam = new THREE.Mesh(beamGeo, beamMat); beam.renderOrder = 5; beam.visible = false; scene.add(beam);
      const beamCoreGeo = new THREE.ConeGeometry(1, 1, 10, 1, true);
      beamCoreGeo.translate(0, -0.5, 0);
      beamCoreGeo.rotateX(-Math.PI / 2);
      const beamCoreMat = new THREE.MeshBasicMaterial({ color: 0x16a34a, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, wireframe: true });
      const beamCore = new THREE.Mesh(beamCoreGeo, beamCoreMat); beamCore.renderOrder = 6; beamCore.visible = false; scene.add(beamCore);

      const rings = [0, 1, 2].map(() => {
        const m = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 48), new THREE.MeshBasicMaterial({ color: 0x16a34a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
        m.rotation.x = -Math.PI / 2;
        m.position.set(cabai1.g.position.x, BED_TOP + 0.02, cabai1.g.position.z);
        m.renderOrder = 4; m.visible = false; scene.add(m);
        return m;
      });
      const reticle = new THREE.Group(); reticle.visible = false; reticle.renderOrder = 20; scene.add(reticle);
      (() => {
        const rm = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.95, depthTest: false });
        for (let k = 0; k < 4; k++) {
          const corner = new THREE.Group(); corner.rotation.z = (k * Math.PI) / 2; reticle.add(corner);
          const a = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.04), rm); a.position.set(0.38, 0.47, 0); corner.add(a);
          const b = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.22), rm); b.position.set(0.47, 0.38, 0); corner.add(b);
        }
      })();

      /* Step 2: Three Checklist Slabs (Staircase) */
      const SLAB_STEPS = ['Petik daun berbercak', 'Kurangi tunas air bawah', 'Fungisida kontak sore hari'];
      const makeSlabTexture = (n, label, done) => {
        const cv = document.createElement('canvas'); cv.width = 640; cv.height = 220;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = done ? '#f0fdf4' : '#ffffff';
        ctx.fillRect(0, 0, 640, 220);
        ctx.strokeStyle = done ? '#86efac' : '#d7e3da';
        ctx.lineWidth = 6;
        ctx.strokeRect(3, 3, 634, 214);
        ctx.fillStyle = done ? '#16a34a' : '#15803d';
        canvasRRect(ctx, 28, 106, 74, 74, 14);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (done) {
          ctx.lineWidth = 9; ctx.strokeStyle = '#ffffff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(48, 144); ctx.lineTo(61, 158); ctx.lineTo(84, 128); ctx.stroke();
        } else {
          ctx.font = '800 44px "Google Sans", "Plus Jakarta Sans", system-ui, sans-serif';
          ctx.fillText(String(n), 65, 146);
        }
        ctx.textAlign = 'left';
        ctx.fillStyle = '#0d1f12';
        ctx.font = '700 36px "Google Sans", "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.fillText(label, 122, 144);
        const tx = new THREE.CanvasTexture(cv);
        tx.anisotropy = Math.min(8, webglRenderer.capabilities.getMaxAnisotropy() || 1);
        tx.minFilter = webglRenderer.capabilities.isWebGL2 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        return tx;
      };
      const SLAB = { x: 1.72, z: -0.68, w: 2.15, d: 0.74, h: 0.16, stepZ: -0.46, stepY: 0.17 };
      const slabs = SLAB_STEPS.map((label, k) => {
        const side = std(k === 0 ? 0xd9f2df : (k === 1 ? 0xe7f3d6 : 0xd8efe6), { roughness: 0.7 });
        const texOff = makeSlabTexture(k + 1, label, false);
        const texOn = makeSlabTexture(k + 1, label, true);
        const topMat = new THREE.MeshStandardMaterial({ map: texOff, roughness: 0.75 });
        const mats = [side, side, topMat, side, side, side];
        const m = new THREE.Mesh(new THREE.BoxGeometry(SLAB.w, SLAB.h, SLAB.d), mats);
        m.castShadow = true; m.receiveShadow = true; m.visible = false; scene.add(m);
        return { m, top: topMat, texOff, texOn, k };
      });
      const SLAB_DROPS = [0.06, 0.28, 0.50];

      /* Step 3: Purple Bedeng Boundary Rail + Pins */
      const RAIL = { x0: BED_X - BED_LEN / 2 - 0.35, x1: BED_X + BED_LEN / 2 + 0.35, z0: BEDS[0].z - BED_W / 2 - 0.35, z1: BEDS[1].z + BED_W / 2 + 0.35 };
      const railMat = std(0xa855f7, { emissive: 0x7e22ce, emissiveIntensity: 0.55, roughness: 0.5 });
      const railFillMat = new THREE.MeshBasicMaterial({ color: 0x9333ea, transparent: true, opacity: 0, depthWrite: false });
      const railFill = new THREE.Mesh(new THREE.PlaneGeometry(RAIL.x1 - RAIL.x0, RAIL.z1 - RAIL.z0), railFillMat);
      railFill.rotation.x = -Math.PI / 2;
      railFill.position.set((RAIL.x0 + RAIL.x1) / 2, TOP + 0.025, (RAIL.z0 + RAIL.z1) / 2);
      railFill.renderOrder = 2; railFill.visible = false; scene.add(railFill);

      const railCorners = [[RAIL.x0, RAIL.z0], [RAIL.x1, RAIL.z0], [RAIL.x1, RAIL.z1], [RAIL.x0, RAIL.z1]];
      const railEdges = railCorners.map((aPt, k) => {
        const bPt = railCorners[(k + 1) % 4];
        const len = Math.hypot(bPt[0] - aPt[0], bPt[1] - aPt[1]);
        const geo = new THREE.BoxGeometry(1, 0.07, 0.07); geo.translate(0.5, 0, 0);
        const m = new THREE.Mesh(geo, railMat); m.castShadow = true;
        m.position.set(aPt[0], TOP + 0.36, aPt[1]);
        m.rotation.y = -Math.atan2(bPt[1] - aPt[1], bPt[0] - aPt[0]);
        m.visible = false; scene.add(m);
        return { m, len };
      });
      const railPosts = [];
      railCorners.forEach((aPt, k) => {
        const bPt = railCorners[(k + 1) % 4];
        const n = k % 2 === 0 ? 4 : 2;
        for (let q = 0; q < n; q++) {
          const frac = q / n;
          const p = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.44, 6), railMat);
          p.position.set(lerp(aPt[0], bPt[0], frac), TOP + 0.2, lerp(aPt[1], bPt[1], frac));
          p.castShadow = true; p.visible = false; scene.add(p);
          railPosts.push({ m: p, order: k + frac });
        }
      });

      const STATUS_COL = { kritis: 0xdc2626, waspada: 0xf59e0b, sehat: 0x16a34a };
      const pins = plants.map((p, k) => {
        const g = new THREE.Group(); g.visible = false; scene.add(g);
        const mat = std(STATUS_COL[p.def.status], { roughness: 0.45 });
        addMesh(g, new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), mat), 0, 0.42, 0);
        const tip = addMesh(g, new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.34, 8), mat), 0, 0.16, 0);
        tip.rotation.x = Math.PI;
        addMesh(g, new THREE.Mesh(new THREE.IcosahedronGeometry(0.085, 0), std(0xffffff, { roughness: 0.4 })), 0, 0.44, 0.12, false, false);
        g.position.copy(p.top).add(new THREE.Vector3(0, 0.05, 0));
        return { g, base: p.top.clone(), k };
      });

      /* Step 4: Sync Cloud + Data Packets */
      const cloud = new THREE.Group(); cloud.visible = false; scene.add(cloud);
      const cloudMat = std(0xe7f0ea, { roughness: 0.55, emissive: 0x6f8578, emissiveIntensity: 0.30 });
      const cloudShade = std(0xcbe0d2, { roughness: 0.65, emissive: 0x556b5e, emissiveIntensity: 0.38 });
      [
        [0, 0, 0, 0.55, cloudMat], [-0.55, -0.12, 0.05, 0.4, cloudMat], [0.58, -0.1, 0, 0.42, cloudMat],
        [0.2, 0.28, -0.1, 0.38, cloudMat], [-0.15, -0.28, 0.15, 0.36, cloudShade], [0.35, -0.3, 0.1, 0.32, cloudShade]
      ].forEach(c => {
        addMesh(cloud, new THREE.Mesh(new THREE.DodecahedronGeometry(c[3], 0), c[4]), c[0], c[1], c[2], true, false);
      });
      const packetMat = std(0x22c55e, { emissive: 0x16a34a, emissiveIntensity: 0.6, roughness: 0.4 });
      const packets = [0, 1, 2, 3, 4].map(() => {
        const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.145, 0), packetMat);
        m.castShadow = true; m.visible = false; scene.add(m);
        return m;
      });

      /* Rounded 3D Smartphone & Real App Screen Texture */
      const PH = { w: 2.0, h: 4.33, d: 0.17, r: 0.3 };
      const SCR = { w: 1.86, h: 1.86 * (1688 / 780), r: 0.22 };
      const roundedRect2D = (w, h, r) => {
        const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
        s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
        s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
        s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
        return s;
      };

      const phoneRig = new THREE.Group(); scene.add(phoneRig);
      const phone = new THREE.Group(); phoneRig.add(phone);
      const bodyGeo = new THREE.ExtrudeGeometry(roundedRect2D(PH.w - 0.06, PH.h - 0.06, PH.r), {
        depth: PH.d - 0.06, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3, curveSegments: 10
      });
      bodyGeo.translate(0, 0, -(PH.d - 0.06) / 2);
      const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0x232a27, roughness: 0.42, metalness: 0.35 }));
      body.castShadow = true; phone.add(body);

      const glass = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect2D(PH.w - 0.08, PH.h - 0.08, PH.r - 0.03), 10), new THREE.MeshBasicMaterial({ color: 0x0b0f0d }));
      glass.position.z = PH.d / 2 + 0.002; phone.add(glass);

      const scrGeo = new THREE.ShapeGeometry(roundedRect2D(SCR.w, SCR.h, SCR.r), 12);
      (() => {
        const pos = scrGeo.attributes.position, uv = scrGeo.attributes.uv;
        for (let k = 0; k < pos.count; k++) uv.setXY(k, (pos.getX(k) + SCR.w / 2) / SCR.w, (pos.getY(k) + SCR.h / 2) / SCR.h);
        uv.needsUpdate = true;
      })();

      const screenCanvas = document.createElement('canvas');
      screenCanvas.width = 780; screenCanvas.height = 1688;
      const sctx = screenCanvas.getContext('2d');
      const screenTex = new THREE.CanvasTexture(screenCanvas);
      screenTex.minFilter = webglRenderer.capabilities.isWebGL2 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      screenTex.magFilter = THREE.LinearFilter;
      screenTex.anisotropy = Math.min(8, webglRenderer.capabilities.getMaxAnisotropy() || 1);
      const screenMesh = new THREE.Mesh(scrGeo, new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }));
      screenMesh.position.z = PH.d / 2 + 0.004; phone.add(screenMesh);

      addMesh(phone, new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.07), body.material), PH.w / 2 + 0.005, 0.9, 0, false, false);
      addMesh(phone, new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.26, 0.07), body.material), PH.w / 2 + 0.005, 0.35, 0, false, false);
      addMesh(phone, new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.06), new THREE.MeshStandardMaterial({ color: 0x2c3431, roughness: 0.35, metalness: 0.4 })), -0.52, PH.h / 2 - 0.5, -PH.d / 2 - 0.02, false, false);
      const lensLocal = new THREE.Vector3(-0.52, PH.h / 2 - 0.5, -PH.d / 2 - 0.06);

      let screenDirty = true;
      const loadScreenImg = url => {
        const im = new Image();
        im.onload = () => { screenDirty = true; };
        im.src = url;
        return im;
      };
      const screenImgs = STEP_META.map(m => loadScreenImg(m.shot));
      const homeScrolledImg = loadScreenImg('img/mobile-home-scrolled.png');

      const drawStepScreen = (ctx, stepIdx, t) => {
        ctx.fillStyle = '#f8fbf9';
        ctx.fillRect(0, 0, 780, 1688);
        const im = screenImgs[stepIdx];
        if (!im || !im.complete || !im.naturalWidth) return false;
        if (stepIdx === 0) {
          ctx.drawImage(im, 0, 0, 780, 1688);
          let sp = 0;
          if (!reduce && homeScrolledImg.complete && homeScrolledImg.naturalWidth) {
            const phM = (t % 5.2) / 5.2;
            if (phM >= 0.2 && phM < 0.48) sp = smoother((phM - 0.2) / 0.28);
            else if (phM >= 0.48 && phM < 0.78) sp = 1;
            else if (phM >= 0.78) sp = 1 - smoother((phM - 0.78) / 0.22);
          }
          if (sp > 0.004 && homeScrolledImg.complete && homeScrolledImg.naturalWidth) {
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 128, 780, 1412); ctx.clip();
            ctx.drawImage(im, 0, 128, 780, 1412, 0, 128 - sp * 180, 780, 1412);
            ctx.globalAlpha = sp;
            ctx.drawImage(homeScrolledImg, 0, 128, 780, 1412, 0, 128 + (1 - sp) * 180, 780, 1412);
            ctx.globalAlpha = 1;
            ctx.restore();
            ctx.drawImage(im, 0, 0, 780, 128, 0, 0, 780, 128);
            ctx.drawImage(im, 0, 1540, 780, 148, 0, 1540, 780, 148);
          }
        } else if (stepIdx === 1) {
          ctx.drawImage(im, 0, 0, 780, 1688);
          if (!reduce) {
            const sy = lerp(560, 880, 0.5 - 0.5 * Math.cos(t * 2.5));
            ctx.save();
            ctx.beginPath(); ctx.rect(200, 540, 380, 360); ctx.clip();
            ctx.fillStyle = 'rgba(74, 222, 128, 0.16)'; ctx.fillRect(200, sy - 24, 380, 24);
            ctx.fillStyle = 'rgba(134, 239, 172, 0.92)'; ctx.fillRect(200, sy - 2, 380, 3);
            ctx.restore();
          }
        } else {
          ctx.drawImage(im, 0, 0, 780, 1688);
        }
        return true;
      };

      /* Five Action Stations aligned with Explainer Video (Option A) */
      const STATIONS = [
        { anchor: [-3.15, 1.5, -2.35], az: 0.66, el: 0.5, fh: 10.4 * FH_ASPECT_SCALE, dr: 2.75, df: 1.3, py: 3.05, yaw: -0.24, shift: [0.28, 0.14] },
        { anchor: [cabai1.g.position.x, 0.9, cabai1.g.position.z], az: 0.98, el: 0.42, fh: 9.2 * FH_ASPECT_SCALE, dr: 2.45, df: 0.9, py: 2.8, yaw: -0.5, shift: [0.22, 0.08] },
        { anchor: [SLAB.x, 0.6, SLAB.z - 0.45], az: 0.58, el: 0.56, fh: 10.0 * FH_ASPECT_SCALE, dr: 2.95, df: 0.7, py: 2.95, yaw: -0.26, shift: [0.24, 0.08] },
        { anchor: [BED_X, 0.4, (BEDS[0].z + BEDS[1].z) / 2], az: 0.74, el: 0.92, fh: 10.8 * FH_ASPECT_SCALE, dr: 4.15, df: 1.4, py: 3.0, yaw: -0.2, shift: [0.34, 0.02] },
        { anchor: [0.2, 1.2, -2.8], az: 0.7, el: 0.5, fh: 10.4 * FH_ASPECT_SCALE, dr: 2.6, df: 1.5, py: 2.95, yaw: -0.24, shift: [0.26, 0.12] }
      ];
      const UP = new THREE.Vector3(0, 1, 0);
      STATIONS.forEach(s => {
        const right = new THREE.Vector3(Math.cos(s.az), 0, -Math.sin(s.az));
        const fwd = new THREE.Vector3(Math.sin(s.az), 0, Math.cos(s.az));
        const a = new THREE.Vector3(s.anchor[0], s.anchor[1], s.anchor[2]);
        s.phone = a.clone().addScaledVector(right, s.dr).addScaledVector(fwd, s.df);
        s.phone.y = s.py;
        const mid = a.clone().lerp(s.phone, 0.5); mid.y = 1.1;
        const baseFh = s.fh / FH_ASPECT_SCALE;
        s.target = mid.addScaledVector(right, -s.shift[0] * baseFh * 0.16).addScaledVector(UP, -s.shift[1] * baseFh * 0.16);
      });
      const CLOUD_POS = STATIONS[4].phone.clone().add(new THREE.Vector3(-2.15, 1.05, 1.65));

      const tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), targetTmp = new THREE.Vector3();
      const stepAges = [99, 0, 0, 0, 0];
      let lastTs = 0, lastScreenPaintTs = -1, lastScreenSf = -1;
      const scratchCanvas = document.createElement('canvas');
      scratchCanvas.width = 780; scratchCanvas.height = 1688;
      const scratchCtx = scratchCanvas.getContext('2d');

      const tickStage = ts => {
        if (authGate.classList.contains('hidden')) {
          lastTs = 0;
          window.requestAnimationFrame(tickStage);
          return;
        }
        const now = (typeof ts === 'number' ? ts : performance.now()) * 0.001;
        const dt = lastTs > 0 ? Math.min(0.1, Math.max(0.001, now - lastTs)) : 0.016;
        lastTs = now;
        if (!reduce) tourState.clockSec += dt;

        const followAlpha = reduce ? 1 : (1 - Math.exp(-9.5 * dt));
        tourState.smoothFloat += (tourState.targetFloat - tourState.smoothFloat) * followAlpha;
        const sf = Math.max(0, Math.min(4, tourState.smoothFloat));
        const t = tourState.clockSec;

        const i0 = Math.min(4, Math.floor(sf));
        const i1 = Math.min(4, i0 + 1);
        const f = smoothstep(0.06, 0.94, sf - i0);
        const s0 = STATIONS[i0], s1 = STATIONS[i1];

        const drift = reduce ? 0 : Math.sin(t * 0.45) * 0.025;
        const az = lerp(s0.az, s1.az, f) - tourState.yawOffset * 1.1 + drift;
        const el = clamp(lerp(s0.el, s1.el, f) + tourState.pitchOffset * 0.65, 0.22, 1.25);
        const fh = lerp(s0.fh, s1.fh, f);
        targetTmp.copy(s0.target).lerp(s1.target, f);

        camera.left = (-fh * ASPECT) / 2;
        camera.right = (fh * ASPECT) / 2;
        camera.top = fh / 2;
        camera.bottom = -fh / 2;
        camera.updateProjectionMatrix();
        const CAM_D = 40;
        camera.position.set(
          targetTmp.x + CAM_D * Math.cos(el) * Math.sin(az),
          targetTmp.y + CAM_D * Math.sin(el),
          targetTmp.z + CAM_D * Math.cos(el) * Math.cos(az)
        );
        camera.lookAt(targetTmp);
        camera.updateMatrixWorld();

        /* Ambient island life */
        vane.rotation.y = reduce ? 0.5 : t * 3.1;
        plants.forEach((p, idx) => {
          p.sway.rotation.z = reduce ? 0 : Math.sin(t * 1.7 + idx * 1.3) * 0.045;
          p.sway.rotation.x = reduce ? 0 : Math.sin(t * 1.3 + idx) * 0.03;
        });
        trees.forEach((tr, idx) => { tr.rotation.z = reduce ? 0 : Math.sin(t * 1.1 + idx * 2) * 0.012; });
        banana.rotation.y = reduce ? 0 : Math.sin(t * 0.9) * 0.05;
        {
          const pos = pondGeo.attributes.position, base = pondBase;
          for (let pi = 0; pi < pos.count; pi++) {
            const px = base[pi * 3], pz = base[pi * 3 + 2];
            const pr = Math.hypot(px, pz);
            const amp = (reduce || pr > 0.98) ? 0 : 0.035;
            pos.setY(pi, base[pi * 3 + 1] + amp * Math.sin(t * 3.0 + px * 5.2 + pz * 3.4) + amp * 0.6 * Math.sin(t * 2.1 - pr * 7));
          }
          pos.needsUpdate = true;
        }

        /* Step proximity weights */
        const w1 = smoothstep(0.28, 0.78, sf) * (1 - smoothstep(1.25, 1.72, sf));
        const w2 = smoothstep(1.28, 1.78, sf) * (1 - smoothstep(2.25, 2.72, sf));
        const w3 = smoothstep(2.28, 2.78, sf) * (1 - smoothstep(3.25, 3.72, sf));
        const w4 = smoothstep(3.28, 3.78, sf);
        const wArr = [1 - smoothstep(0.25, 0.72, sf), w1, w2, w3, w4];
        for (let si = 1; si < 5; si++) {
          if (wArr[si] > 0.32) stepAges[si] = reduce ? 99 : Math.min(99, stepAges[si] + dt);
          else if (wArr[si] < 0.04) stepAges[si] = 0;
        }

        /* Lantern glow in Step 4 */
        lanternMat.emissiveIntensity = 0.12 + w4 * (1.85 + (reduce ? 0 : Math.sin(t * 8) * 0.08));
        lanternLight.intensity = w4 * 1.6;

        /* Phone flight between stations */
        const p0 = s0.phone, p1 = s1.phone;
        const arc = Math.sin(Math.PI * f) * 0.65;
        phoneRig.position.set(
          lerp(p0.x, p1.x, f),
          lerp(p0.y, p1.y, f) + arc + (reduce ? 0 : Math.sin(t * 1.6) * 0.045),
          lerp(p0.z, p1.z, f)
        );
        const pyaw = lerp(s0.yaw, s1.yaw, f);
        const pbank = Math.sin(Math.PI * f) * 0.10 * Math.sign(p1.x - p0.x || 1);
        phoneRig.quaternion.copy(camera.quaternion);
        tmpQ.setFromEuler(tmpE.set(-0.06 + (reduce ? 0 : Math.sin(t * 1.2) * 0.012), pyaw + (reduce ? 0 : Math.sin(t * 0.9) * 0.02), pbank));
        phoneRig.quaternion.multiply(tmpQ);
        phoneRig.updateMatrixWorld(true);

        /* Phone screen compositing */
        const movingSf = Math.abs(sf - lastScreenSf) > 0.002;
        const liveScreen = (sf < 1.65) && !reduce && (t - lastScreenPaintTs > 0.033);
        if (screenDirty || movingSf || liveScreen) {
          const curS = Math.min(4, Math.floor(sf));
          const nxtS = Math.min(4, curS + 1);
          const scrMix = curS === nxtS ? 0 : smoothstep(0.28, 0.72, sf - curS);
          const ok = drawStepScreen(sctx, curS, t);
          if (scrMix > 0.01 && drawStepScreen(scratchCtx, nxtS, t)) {
            sctx.save();
            sctx.globalAlpha = scrMix;
            sctx.drawImage(scratchCanvas, 0, 0);
            sctx.restore();
          }
          if (ok) {
            screenTex.needsUpdate = true;
            screenDirty = false;
            lastScreenPaintTs = t;
            lastScreenSf = sf;
          }
        }

        /* Step 1: Scan beam + GPS rings + reticle */
        const b1 = w1 * (reduce ? 1 : settle(stepAges[1] * 2.5, 6));
        const lens = lensLocal.clone().applyMatrix4(phone.matrixWorld);
        const tgt = cabai1.g.position.clone().add(new THREE.Vector3(0, 0.62, 0));
        const bdist = lens.distanceTo(tgt);
        [beam, beamCore].forEach((m, idx) => {
          m.visible = b1 > 0.02;
          if (!m.visible) return;
          m.position.copy(lens); m.lookAt(tgt);
          const br = (idx === 0 ? 0.62 : 0.5) * (reduce ? 1 : 0.96 + Math.sin(t * 7) * 0.04);
          m.scale.set(br, br, Math.max(0.01, bdist * b1));
        });
        beamMat.opacity = 0.17 * b1;
        beamCoreMat.opacity = 0.24 * b1;
        rings.forEach((r, idx) => {
          const ph = reduce ? (idx * 0.33) : ((t * 0.75 + idx / 3) % 1);
          r.visible = b1 > 0.02;
          r.scale.setScalar(0.25 + ph * 1.05);
          r.material.opacity = b1 * 0.55 * (1 - ph);
        });
        reticle.visible = b1 > 0.02;
        if (reticle.visible) {
          reticle.position.copy(tgt);
          reticle.quaternion.copy(camera.quaternion);
          reticle.scale.setScalar((0.95 + 0.22 * (1 - settle(stepAges[1] * 2, 6))) * (reduce ? 1 : 1 + Math.sin(t * 5) * 0.02));
          reticle.children.forEach(c => { c.children.forEach(m => { m.material.opacity = b1; }); });
        }

        /* Step 2: Staircase checklist slabs */
        const age2 = stepAges[2];
        slabs.forEach((s, idx) => {
          const tFall = (age2 - SLAB_DROPS[idx]) / 0.26;
          const restY = TOP + SLAB.h / 2 + 0.01 + idx * SLAB.stepY;
          let y = restY, sx = 1, sy = 1;
          if (tFall < 0) {
            y = restY + 3.4;
          } else if (tFall < 1) {
            y = restY + 3.4 * (1 - tFall * tFall);
            sx = 0.97; sy = 1.06;
          } else {
            const a = (tFall - 1) * 0.26 * 4;
            const sq = Math.exp(-a * 9) * Math.sin(a * 26) * 0.22;
            y = restY + Math.abs(Math.sin(a * 9)) * Math.exp(-a * 7) * 0.18;
            sx = 1 + sq * 0.6; sy = 1 - sq;
          }
          s.m.visible = w2 > 0.03 && tFall >= 0;
          if (!s.m.visible) return;
          s.m.position.set(SLAB.x, y - (1 - w2) * 0.4, SLAB.z + idx * SLAB.stepZ);
          s.m.scale.set(sx * (0.65 + 0.35 * w2), sy * w2, sx * (0.65 + 0.35 * w2));
          const nextTex = age2 >= SLAB_DROPS[idx] + 0.24 ? s.texOn : s.texOff;
          if (s.top.map !== nextTex) { s.top.map = nextTex; s.top.needsUpdate = true; }
        });

        /* Step 3: Purple Bedeng perimeter rail + pins */
        const age3 = stepAges[3];
        const railT = win(age3, 0.02, 0.52);
        railEdges.forEach((e, idx) => {
          const fEdge = smoother(win(railT, idx * 0.25, idx * 0.25 + 0.25));
          e.m.visible = w3 > 0.02 && fEdge > 0.001;
          e.m.scale.set(Math.max(0.001, e.len * fEdge), w3, w3);
        });
        railPosts.forEach(p => {
          const pf = popEase(win(railT * 4 - p.order, 0, 1) * 1.6);
          p.m.visible = w3 > 0.02 && railT * 4 >= p.order;
          p.m.scale.set(1, Math.max(0.01, pf * w3), 1);
        });
        railFill.visible = w3 > 0.02;
        railFillMat.opacity = 0.13 * w3 * smoothstep(0.06, 0.4, age3);
        pins.forEach((p, idx) => {
          const sc = popEase(win(age3, 0.20 + idx * 0.05, 0.20 + idx * 0.05 + 0.36) * 1.6) * w3;
          p.g.visible = sc > 0.02;
          p.g.scale.setScalar(Math.max(0.01, sc));
          p.g.position.set(p.base.x, p.base.y + 0.08 + (reduce ? 0 : Math.sin(t * 2.6 + idx) * 0.05), p.base.z);
          p.g.rotation.y = (reduce ? 0 : t * 0.8) + idx;
        });

        /* Step 4: Sync cloud + streaming packets */
        const age4 = stepAges[4];
        const cl = w4 * popEase(win(age4, 0.02, 0.35) * 1.6);
        cloud.visible = cl > 0.02;
        if (cloud.visible) {
          cloud.scale.setScalar(Math.max(0.01, cl));
          cloud.position.copy(CLOUD_POS).add(new THREE.Vector3(reduce ? 0 : Math.sin(t * 0.8) * 0.12, reduce ? 0 : Math.sin(t * 1.3) * 0.06, 0));
        }
        const phoneTop = new THREE.Vector3(0, PH.h / 2 + 0.06, 0).applyMatrix4(phone.matrixWorld);
        packets.forEach((m, idx) => {
          m.visible = w4 > 0.25 && cl > 0.2;
          if (!m.visible) return;
          const ph = reduce ? (idx * 0.18) : ((t * 0.55 + idx * 0.2) % 1);
          const e = smoothstep(0, 1, ph);
          const ctrl = phoneTop.clone().lerp(cloud.position, 0.5).add(new THREE.Vector3(0.15, 0.55, 0.1));
          const pA = phoneTop.clone().lerp(ctrl, e);
          const pB = ctrl.clone().lerp(cloud.position, e);
          m.position.copy(pA.lerp(pB, e));
          m.rotation.set((reduce ? 0 : t * 3) + idx, reduce ? 0 : t * 4, 0);
          m.scale.setScalar((Math.sin(Math.PI * ph) * 0.55 + 0.45) * w4);
        });

        webglRenderer.render(scene, camera);
        window.requestAnimationFrame(tickStage);
      };
      window.requestAnimationFrame(tickStage);
      return;
    }

    const ctx2 = canvas.getContext('2d');
    if (!ctx2) return;
    const shotImgs = STEP_META.map(m => { const im = new Image(); im.src = m.shot; return im; });
    const render2DFallback = () => {
      if (!authGate.classList.contains('hidden')) {
        const idx = tourState.currentStep;
        const im = shotImgs[idx];
        ctx2.clearRect(0, 0, 720, 540);
        ctx2.fillStyle = '#f0f6f1'; ctx2.fillRect(0, 0, 720, 540);
        if (im && im.complete && im.naturalWidth > 0) {
          const h = 440, w = Math.round((im.naturalWidth / im.naturalHeight) * h);
          ctx2.drawImage(im, (720 - w) / 2, 24, w, h);
        }
      }
      window.requestAnimationFrame(render2DFallback);
    };
    window.requestAnimationFrame(render2DFallback);
  };

  const wireAll = () => {
    wire();
    wireLandingChrome();
    initLandingTour();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireAll); else wireAll();
})();

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
        menuToggle.setAttribute('aria-label', 'Buka menu navigasi');
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
      menuToggle.setAttribute('aria-label', 'Tutup menu navigasi');
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
      videoEl.addEventListener('timeupdate', () => {
        const idx = Math.min(4, Math.floor((videoEl.currentTime || 0) / 4));
        setActiveChapter(idx);
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
      if (progressLabel) progressLabel.textContent = meta.label;
      if (badgeText) badgeText.textContent = meta.badge;
      if (changed) updateBadgeIcon(meta.icon);
      pillBtns.forEach((btn, i) => {
        const on = i === clamped;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', String(on));
      });
      stepCards.forEach((card, i) => card.classList.toggle('is-active', i === clamped));
      if (prevBtn) prevBtn.disabled = clamped === 0;
      if (nextBtn) nextBtn.textContent = meta.next;
    };

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
        webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        webglRenderer.setSize(720, 540, false);
        webglRenderer.shadowMap.enabled = true;
        webglRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
      } catch (_) {
        webglRenderer = null;
      }
    }

    if (webglRenderer && THREE) {
      const scene = new THREE.Scene();
      const frustumHalf = 3.25;
      const aspect = 720 / 540;
      const camera = new THREE.OrthographicCamera(-frustumHalf * aspect, frustumHalf * aspect, frustumHalf, -frustumHalf, 0.1, 100);
      const ambLight = new THREE.AmbientLight(0xffffff, 0.72);
      const hemiLight = new THREE.HemisphereLight(0xf0fdf4, 0x78350f, 0.45);
      const sun = new THREE.DirectionalLight(0xfffbeb, 0.94);
      sun.position.set(6.5, 10.5, 5.5);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      scene.add(ambLight, hemiLight, sun);

      const lanternPoint = new THREE.PointLight(0xffb703, 0.2, 4.5);
      lanternPoint.position.set(1.55, 1.05, -0.95);
      scene.add(lanternPoint);

      const roundedRectShape = (w, d, r) => {
        const s = new THREE.Shape(), x = -w / 2, y = -d / 2;
        s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
        s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
        s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
        s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
        return s;
      };
      const layerMesh = (w, d, h, r, hex, bevel) => {
        const geo = new THREE.ExtrudeGeometry(roundedRectShape(w, d, r), { depth: h, bevelEnabled: true, bevelThickness: 0.05, bevelSize: bevel, bevelSegments: 1, curveSegments: 5 });
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.88, metalness: 0.04, flatShading: true }));
        mesh.castShadow = true; mesh.receiveShadow = true;
        return mesh;
      };
      const makeChiliPlant = (status) => {
        const g = new THREE.Group();
        const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.025, 0.92, 5), new THREE.MeshStandardMaterial({ color: 0xd4a373, roughness: 0.8, flatShading: true }));
        stake.position.set(0.14, 0.44, -0.06); stake.castShadow = true; g.add(stake);
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.085, 0.45, 5), new THREE.MeshStandardMaterial({ color: 0x6d4c3d, flatShading: true }));
        stem.position.y = 0.22; stem.castShadow = true; g.add(stem);
        const cMain = status === 'healthy' ? 0x16a34a : (status === 'moderate' ? 0x84cc16 : 0x65a30d);
        const cAcc = status === 'healthy' ? 0x22c55e : (status === 'moderate' ? 0xeab308 : 0xef4444);
        const mMain = new THREE.MeshStandardMaterial({ color: cMain, roughness: 0.82, flatShading: true });
        const mAcc = new THREE.MeshStandardMaterial({ color: cAcc, roughness: 0.72, flatShading: true });
        const crown = new THREE.Mesh(new THREE.DodecahedronGeometry(0.32, 0), mMain);
        crown.position.set(0, 0.62, 0); crown.scale.set(1.15, 0.85, 1.15); crown.castShadow = true; g.add(crown);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + 0.3;
          const t = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18, 0), i === 0 ? mAcc : mMain);
          t.position.set(Math.cos(a) * 0.24, 0.48 + (i % 2) * 0.08, Math.sin(a) * 0.24);
          t.castShadow = true; g.add(t);
        }
        const podMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.55, flatShading: true });
        for (let p = 0; p < 2; p++) {
          const pod = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.16, 5), podMat);
          pod.rotation.x = Math.PI; pod.rotation.z = p === 0 ? 0.25 : -0.25;
          pod.position.set(p === 0 ? 0.2 : -0.18, 0.42, 0.16);
          g.add(pod);
        }
        return g;
      };
      const makePin = (colorHex) => {
        const g = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.45, flatShading: true });
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.38, 6), mat);
        cone.rotation.x = Math.PI; cone.position.y = 0.20; cone.castShadow = true;
        const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.20, 0), mat);
        head.position.y = 0.46; head.castShadow = true;
        const dot = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        dot.position.set(0, 0.46, 0.13);
        g.add(cone, head, dot);
        return g;
      };

      const island = new THREE.Group();
      scene.add(island);
      const rockCore = layerMesh(4.65, 3.35, 0.56, 0.62, 0x3b2f2f, 0.08); rockCore.position.y = -0.68;
      const baseRock = layerMesh(4.95, 3.60, 0.34, 0.68, 0x524038, 0.09); baseRock.position.y = -0.44;
      const midSoil = layerMesh(5.30, 3.90, 0.22, 0.72, 0x6d422d, 0.08); midSoil.position.y = -0.10;
      const topGrass = layerMesh(5.38, 3.98, 0.16, 0.74, 0x7ac15a, 0.06); topGrass.position.y = 0.12;
      const bedengBase = layerMesh(3.4, 2.5, 0.12, 0.36, 0x5ca443, 0.04); bedengBase.position.set(-0.52, 0.28, 0);
      const f1 = layerMesh(2.6, 0.65, 0.12, 0.22, 0x5c3c28, 0.03); f1.position.set(-0.52, 0.40, -0.58);
      const f2 = layerMesh(2.6, 0.65, 0.12, 0.22, 0x5c3c28, 0.03); f2.position.set(-0.52, 0.40, 0.58);
      island.add(rockCore, baseRock, midSoil, topGrass, bedengBase, f1, f2);

      const saung = new THREE.Group();
      saung.position.set(1.62, 0.28, -0.92);
      const deck = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.10, 1.04), new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.85, flatShading: true }));
      deck.position.y = 0.08; deck.castShadow = true; deck.receiveShadow = true; saung.add(deck);
      const postMat = new THREE.MeshStandardMaterial({ color: 0x5c3a21, roughness: 0.9, flatShading: true });
      [[-0.48, -0.42], [0.48, -0.42], [-0.48, 0.42], [0.48, 0.42]].forEach(pt => {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.82, 5), postMat);
        p.position.set(pt[0], 0.50, pt[1]); p.castShadow = true; saung.add(p);
      });
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.88, 0.52, 4), new THREE.MeshStandardMaterial({ color: 0xc2410c, roughness: 0.78, flatShading: true }));
      roof.position.y = 1.12; roof.rotation.y = Math.PI / 4; roof.castShadow = true; saung.add(roof);
      const lanternMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xffb703, emissiveIntensity: 0.3, roughness: 0.35, flatShading: true });
      const lantern = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), lanternMat);
      lantern.position.set(0, 0.78, 0.24); saung.add(lantern);
      island.add(saung);

      const vaneMast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.25, 5), new THREE.MeshStandardMaterial({ color: 0x64748b, flatShading: true }));
      vaneMast.position.set(2.15, 0.86, -1.42); vaneMast.castShadow = true; island.add(vaneMast);
      const vaneSpin = new THREE.Group();
      vaneSpin.position.set(2.15, 1.48, -1.42);
      const arm1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.03, 0.03), new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true }));
      const arm2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.42), new THREE.MeshStandardMaterial({ color: 0x15803d, flatShading: true }));
      vaneSpin.add(arm1, arm2);
      island.add(vaneSpin);

      const pondBasin = layerMesh(1.18, 1.38, 0.05, 0.32, 0x0369a1, 0.02);
      pondBasin.position.set(1.68, 0.25, 0.68);
      island.add(pondBasin);
      const pondTiles = [];
      const pMat1 = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.28, metalness: 0.12, flatShading: true });
      const pMat2 = new THREE.MeshStandardMaterial({ color: 0x7dd3fc, roughness: 0.22, metalness: 0.15, flatShading: true });
      for (let px = 0; px < 3; px++) {
        for (let pz = 0; pz < 3; pz++) {
          const tile = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.06, 6), (px + pz) % 2 === 0 ? pMat1 : pMat2);
          tile.position.set(1.38 + px * 0.30, 0.31, 0.38 + pz * 0.30);
          island.add(tile);
          pondTiles.push({ mesh: tile, ix: px, iz: pz });
        }
      }

      const plantGroups = [], pins = [];
      [
        { pos: [-1.22, 0.54, -0.58], status: 'healthy', pinColor: 0x15803d },
        { pos: [0.18, 0.54, -0.58], status: 'severe', pinColor: 0xdc2626 },
        { pos: [-1.22, 0.54, 0.58], status: 'healthy', pinColor: 0x15803d },
        { pos: [0.18, 0.54, 0.58], status: 'moderate', pinColor: 0xd97706 }
      ].forEach(sp => {
        const pl = makeChiliPlant(sp.status); pl.position.set(sp.pos[0], sp.pos[1], sp.pos[2]);
        island.add(pl); plantGroups.push(pl);
        const pin = makePin(sp.pinColor); pin.position.set(sp.pos[0], sp.pos[1] + 1.25, sp.pos[2]); pin.scale.setScalar(0.001); pin.visible = false;
        island.add(pin); pins.push({ mesh: pin, baseY: sp.pos[1] + 1.25 });
      });

      const mapOverlay = new THREE.Group();
      const mapFillMat = new THREE.MeshBasicMaterial({ color: 0xa855f7, transparent: true, opacity: 0, side: THREE.DoubleSide });
      const mapFill = new THREE.Mesh(new THREE.PlaneGeometry(3.46, 2.56), mapFillMat);
      mapFill.rotation.x = -Math.PI / 2; mapFill.position.set(-0.52, 0.43, 0);
      mapOverlay.add(mapFill);
      const railMat = new THREE.MeshBasicMaterial({ color: 0x9333ea, transparent: true, opacity: 0 });
      [{ w: 3.52, d: 0.09, x: -0.52, z: -1.28 }, { w: 3.52, d: 0.09, x: -0.52, z: 1.28 }, { w: 0.09, d: 2.65, x: -2.25, z: 0 }, { w: 0.09, d: 2.65, x: 1.21, z: 0 }].forEach(r => {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(r.w, 0.07, r.d), railMat);
        rail.position.set(r.x, 0.46, r.z); mapOverlay.add(rail);
      });
      [[-2.25, -1.28], [1.21, -1.28], [1.21, 1.28], [-2.25, 1.28]].forEach(pt => {
        const node = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), railMat);
        node.position.set(pt[0], 0.50, pt[1]); mapOverlay.add(node);
      });
      mapOverlay.visible = false; island.add(mapOverlay);

      const texLoader = new THREE.TextureLoader();
      const phoneTexs = STEP_META.map(m => {
        const tx = texLoader.load(m.shot);
        tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
        if (THREE.sRGBEncoding) tx.encoding = THREE.sRGBEncoding;
        return tx;
      });
      const mobTopImg = new Image(); mobTopImg.src = 'img/landing-app-mobile.png';
      const mobScrImg = new Image(); mobScrImg.src = 'img/mobile-home-scrolled.png';
      const mobScrollCanvas = document.createElement('canvas');
      mobScrollCanvas.width = 780; mobScrollCanvas.height = 1688;
      const mobScrollCtx = mobScrollCanvas.getContext('2d');
      const mobScrollTex = new THREE.CanvasTexture(mobScrollCanvas);
      mobScrollTex.minFilter = THREE.LinearFilter; mobScrollTex.magFilter = THREE.LinearFilter;
      if (THREE.sRGBEncoding) mobScrollTex.encoding = THREE.sRGBEncoding;
      let lastMobSp = -1;
      const drawMobScrollFrame = (sp) => {
        if (!mobScrollCtx || !mobTopImg.complete || !mobTopImg.naturalWidth) return false;
        const c = mobScrollCtx;
        c.clearRect(0, 0, 780, 1688);
        c.fillStyle = '#f8fbf9'; c.fillRect(0, 0, 780, 1688);
        c.save(); c.beginPath(); c.rect(0, 128, 780, 1412); c.clip();
        c.drawImage(mobTopImg, 0, 128, 780, 1412, 0, 128 - sp * 180, 780, 1412);
        if (sp > 0.005 && mobScrImg.complete && mobScrImg.naturalWidth > 0) {
          c.globalAlpha = sp;
          c.drawImage(mobScrImg, 0, 128, 780, 1412, 0, 128 + (1 - sp) * 180, 780, 1412);
          c.globalAlpha = 1;
        }
        c.restore();
        c.drawImage(mobTopImg, 0, 0, 780, 128, 0, 0, 780, 128);
        c.drawImage(mobTopImg, 0, 1540, 780, 148, 0, 1540, 780, 148);
        mobScrollTex.needsUpdate = true;
        return true;
      };

      const phoneScreenMat = new THREE.MeshBasicMaterial({ map: phoneTexs[0] });
      const phoneRig = new THREE.Group();
      const phoneBody = new THREE.Mesh(new THREE.BoxGeometry(0.94, 1.90, 0.08), new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.38, metalness: 0.2 }));
      phoneBody.castShadow = true; phoneBody.receiveShadow = true;
      const phoneTrim = new THREE.Mesh(new THREE.BoxGeometry(0.90, 1.84, 0.02), new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.45 }));
      phoneTrim.position.z = 0.036;
      const phoneScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 1.76), phoneScreenMat);
      phoneScreen.position.z = 0.048;
      const phoneNotch = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.01), new THREE.MeshBasicMaterial({ color: 0x020617 }));
      phoneNotch.position.set(0, 0.90, 0.052);
      phoneRig.add(phoneBody, phoneTrim, phoneScreen, phoneNotch);
      phoneRig.position.set(1.45, 1.55, -0.35);
      island.add(phoneRig);
      const phoneStations = [[1.45, 1.55, -0.35], [0.85, 1.42, -0.32], [1.72, 1.52, -0.15], [1.65, 1.58, 0.55], [1.42, 1.62, -0.15]];
      const camLookTmp = new THREE.Vector3();
      let lastPhoneIdx = 0;

      const scanBeam = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.05, 4, 1, true), new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0, side: THREE.DoubleSide }));
      scanBeam.position.set(0.54, 1.0, -0.5); scanBeam.rotation.z = Math.PI / 2.3; scanBeam.rotation.y = 0.3; scanBeam.visible = false; island.add(scanBeam);
      const gpsRing = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.55, 16), new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0, side: THREE.DoubleSide }));
      gpsRing.rotation.x = -Math.PI / 2; gpsRing.position.set(0.18, 0.56, -0.58); gpsRing.visible = false; island.add(gpsRing);

      const historyCards = [];
      [{ y: 1.45, z: -0.25, bar: 0xdc2626 }, { y: 1.82, z: -0.45, bar: 0xd97706 }, { y: 2.19, z: -0.65, bar: 0x16a34a }].forEach(hs => {
        const c = new THREE.Group();
        const plate = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.30, 0.05), new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true }));
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.22, 0.06), new THREE.MeshBasicMaterial({ color: hs.bar })); stripe.position.x = -0.42;
        const line = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.08, 0.06), new THREE.MeshBasicMaterial({ color: 0xcbd5e1 })); line.position.x = 0.14;
        c.add(plate, stripe, line); c.position.set(1.12, hs.y, hs.z); c.rotation.y = -0.25; c.scale.setScalar(0.001); c.visible = false;
        island.add(c); historyCards.push(c);
      });

      const syncCloud = new THREE.Group();
      const clM = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true });
      const c0 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.42, 0), clM);
      const c1 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.28, 0), clM); c1.position.set(-0.34, -0.06, 0);
      const c2 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.30, 0), clM); c2.position.set(0.34, -0.05, 0);
      syncCloud.add(c0, c1, c2); syncCloud.position.set(1.85, 2.55, 0.2); syncCloud.scale.setScalar(0.001); syncCloud.visible = false; island.add(syncCloud);
      const syncDots = [];
      for (let d = 0; d < 4; d++) {
        const dot = new THREE.Mesh(new THREE.OctahedronGeometry(0.09, 0), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
        dot.visible = false; island.add(dot); syncDots.push(dot);
      }

      const camPoses = [[7.4, 5.6, 7.6], [5.9, 4.1, 6.2], [6.8, 4.9, 7.0], [3.4, 8.2, 5.2], [7.0, 5.1, 7.2]];
      const camZooms = [0.96, 1.15, 1.04, 1.02, 0.98];

      const tickStage = () => {
        if (authGate.classList.contains('hidden')) {
          window.requestAnimationFrame(tickStage);
          return;
        }
        if (!reduce) tourState.clockSec += 0.016;
        tourState.smoothFloat += (tourState.targetFloat - tourState.smoothFloat) * (reduce ? 1 : 0.16);
        const sf = Math.max(0, Math.min(4, tourState.smoothFloat));
        const t = tourState.clockSec;
        const i0 = Math.min(4, Math.floor(sf)), i1 = Math.min(4, i0 + 1), f = sf - i0;
        camera.position.set(
          lerp(camPoses[i0][0], camPoses[i1][0], f) + (reduce ? 0 : Math.sin(t * 0.45) * 0.14),
          lerp(camPoses[i0][1], camPoses[i1][1], f) + tourState.pitchOffset * 3.0,
          lerp(camPoses[i0][2], camPoses[i1][2], f)
        );
        camera.zoom = lerp(camZooms[i0], camZooms[i1], f);
        camera.updateProjectionMatrix();
        camera.lookAt(0.05, 0.50, 0);
        island.rotation.y = -0.22 + tourState.yawOffset + (reduce ? 0 : Math.sin(t * 0.35) * 0.05);

        plantGroups.forEach((pg, idx) => { pg.rotation.z = reduce ? 0 : Math.sin(t * 2 + idx) * 0.03; });
        vaneSpin.rotation.y = reduce ? 0.5 : t * 2.4;
        pondTiles.forEach(pt => { pt.mesh.position.y = 0.31 + (reduce ? 0 : Math.sin(t * 2.5 + pt.ix * 1.1 + pt.iz * 0.9) * 0.018); });

        const wCam = smoothstep(0.45, 0.85, sf) * (1 - smoothstep(1.30, 1.65, sf));
        const wHist = smoothstep(1.40, 1.85, sf) * (1 - smoothstep(2.25, 2.65, sf));
        const wMap = smoothstep(2.35, 2.80, sf) * (1 - smoothstep(3.25, 3.65, sf));
        const wSync = smoothstep(3.40, 3.85, sf);

        sun.color.setRGB(lerp(1.0, 0.99, wSync), lerp(0.98, 0.72, wSync), lerp(0.92, 0.48, wSync));
        sun.intensity = lerp(0.94, 0.65, wSync);
        hemiLight.color.setRGB(lerp(0.94, 0.55, wSync), lerp(0.99, 0.62, wSync), lerp(0.96, 0.92, wSync));
        lanternMat.emissiveIntensity = 0.3 + wSync * 1.45;
        lanternPoint.intensity = 0.2 + wSync * 1.35;

        const pIdx = Math.max(0, Math.min(4, Math.round(sf)));
        if (pIdx === 0) {
          const phM = reduce ? 0 : ((t % 4.4) / 4.4);
          let msp = 0;
          if (phM >= 0.18 && phM < 0.48) {
            const mu = (phM - 0.18) / 0.30;
            msp = mu < 0.5 ? 2 * mu * mu : 1 - Math.pow(-2 * mu + 2, 2) / 2;
          } else if (phM >= 0.48 && phM < 0.82) {
            msp = 1;
          } else if (phM >= 0.82) {
            const md = (phM - 0.82) / 0.18;
            msp = 1 - (md < 0.5 ? 2 * md * md : 1 - Math.pow(-2 * md + 2, 2) / 2);
          }
          if (mobTopImg.complete && mobTopImg.naturalWidth > 0 && mobScrImg.complete && mobScrImg.naturalWidth > 0) {
            if (Math.abs(msp - lastMobSp) > 0.002 || lastPhoneIdx !== 0) {
              if (drawMobScrollFrame(msp)) lastMobSp = msp;
            }
            if (phoneScreenMat.map !== mobScrollTex) {
              phoneScreenMat.map = mobScrollTex; phoneScreenMat.needsUpdate = true;
            }
            lastPhoneIdx = 0;
          } else if (lastPhoneIdx !== 0) {
            phoneScreenMat.map = phoneTexs[0]; phoneScreenMat.needsUpdate = true; lastPhoneIdx = 0;
          }
        } else if (pIdx !== lastPhoneIdx) {
          phoneScreenMat.map = phoneTexs[pIdx]; phoneScreenMat.needsUpdate = true; lastPhoneIdx = pIdx;
        }
        phoneRig.visible = true;
        phoneRig.position.set(
          lerp(phoneStations[i0][0], phoneStations[i1][0], f),
          lerp(phoneStations[i0][1], phoneStations[i1][1], f) + (reduce ? 0 : Math.sin(t * 2.1) * 0.04),
          lerp(phoneStations[i0][2], phoneStations[i1][2], f)
        );
        camLookTmp.set(camera.position.x, camera.position.y * 0.45, camera.position.z);
        island.worldToLocal(camLookTmp);
        phoneRig.lookAt(camLookTmp);

        scanBeam.visible = wCam > 0.02;
        scanBeam.material.opacity = wCam * (reduce ? 0.32 : 0.26 + 0.14 * Math.sin(t * 9));
        gpsRing.visible = wCam > 0.02;
        gpsRing.material.opacity = wCam * 0.72;

        historyCards.forEach((hc, idx) => {
          const sc = easeOutCubic(clamp01(wHist * 1.35 - idx * 0.14));
          hc.visible = sc > 0.02; hc.scale.setScalar(Math.max(0.001, sc));
          hc.position.y = lerp(2.25, 1.45 + idx * 0.38, sc) + (reduce ? 0 : Math.sin(t * 2.4 + idx) * 0.03);
        });

        mapOverlay.visible = wMap > 0.02;
        mapFillMat.opacity = wMap * 0.24; railMat.opacity = wMap * 0.92;
        pins.forEach((pm, idx) => {
          const pop = easeOutBack(clamp01(wMap * 1.45 - idx * 0.12)) * 1.15;
          pm.mesh.visible = pop > 0.02; pm.mesh.scale.setScalar(Math.max(0.001, pop));
          pm.mesh.position.y = pm.baseY + (reduce ? 0 : Math.abs(Math.sin(t * 3 + idx)) * 0.10 * pop);
        });

        syncCloud.visible = wSync > 0.02;
        syncCloud.scale.setScalar(Math.max(0.001, easeOutBack(wSync)));
        syncDots.forEach((dot, idx) => {
          dot.visible = wSync > 0.15;
          if (dot.visible) {
            const p = reduce ? (idx * 0.25) : ((t * 0.7 + idx * 0.25) % 1);
            dot.position.set(lerp(1.18, 1.85, p), 1.4 + Math.sin(p * Math.PI) * 1.2 + p * 0.7, lerp(-0.32, 0.2, p));
          }
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

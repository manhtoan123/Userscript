// ==UserScript==
// @name         SangTacViet Nghe Sach Plus
// @namespace    http://tampermonkey.net/
// @version      4.6
// @author       @NMT25
// @description  Nghe sách tự động với TTS, bookmark, auto-continue
// @match        *://*.sangtacviet.com/*
// @match        *://*.sangtacviet.app/*
// @match        *://*.sangtacviet.me/*
// @match        *://*.sangtacviet.pro/*
// @match        *://*.sangtacviet.vip/*
// @match        *://sangtacviet.com/*
// @match        *://sangtacviet.app/*
// @match        *://sangtacviet.me/*
// @match        *://sangtacviet.pro/*
// @match        *://sangtacviet.vip/*
// @match        *://103.82.20.93/*
// @match        *://*.103.82.20.93/*
// @icon         http://103.82.20.93/favicon.png
// @grant        none
// @license      MIT
// @downloadURL  https://update.greasyfork.org/scripts/556860/SangTacViet%20Nghe%20Sach%20Plus.user.js
// @updateURL    https://update.greasyfork.org/scripts/556860/SangTacViet%20Nghe%20Sach%20Plus.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // v4.5 fixes:
    // [FIX #1]  setInterval ID được lưu lại, cleared khi unload
    // [FIX #2]  MutationObserver ref được lưu lại, disconnect khi unload
    // [FIX #3]  Thêm window beforeunload cleanup tổng thể
    // [FIX #4]  visibilitychange & pageshow không còn rỗng — gọi AudioSessionFix.ensureActive()
    // [FIX #5]  _navPending nâng lên module-level thay vì gắn vào function object
    // [FIX #6]  Cache icon element reference, không querySelector mỗi 400ms
    // [FIX #7]  Dirty-check tipEl.textContent trước khi ghi DOM
    // [FIX #8]  Wrap poll() trong try/catch — interval không chết thầm lặng khi throw
    // [FIX #9]  ensureTikTokPatch thoát sớm khi proto đã được patch
    // [FIX #10] AudioContext được close trong cleanup khi unload
    // [FIX #11] ldTimer được clear trong cleanup tổng thể
    //
    // v4.6 fixes:
    // [FIX #12] trigger() cũng unlock HTML5 <audio> — iOS cần cả AudioContext lẫn HTMLAudioElement
    // [FIX #13] handleClick() gọi AudioSessionFix.trigger() cùng gesture với play
    // [FIX #14] MediaSession 'play' handler gọi AudioSessionFix.trigger()

    /* ── CONSTANTS ── */
    var POLL_MS      = 400;
    var SAVE_EVERY   = 15;
    var BM_EVERY     = 5;
    var PRELOAD_AT   = 0.70;
    var MAX_RELOADS  = 3;
    var RETRY_DELAYS = [2000, 4000, 8000];
    var ARC_R        = 45;
    var ARC_C        = 2 * Math.PI * ARC_R;

    /* ── STATE VARS ── */
    var booted          = false;
    var wasOn           = false;
    var prevCid         = null;
    var prevBid         = null;
    var chapLoading     = false;
    var ldTimer         = null;
    var bmTick          = 0;
    var _reloadCount    = 0;
    var resumeRequested = false;
    var _resumeId       = 0;
    var _audioLifeBound = false;
    var btn, tmrEl, tipEl, arcSvg, arcProg, fixBtn;

    // [FIX #1] Lưu ID của interval để có thể clearInterval khi cleanup
    var _pollIv = null;
    // [FIX #2] Lưu ref của MutationObserver để có thể disconnect khi cleanup
    var _mo = null;
    // [FIX #5] Nâng _navPending lên module scope thay vì gắn lên function object.
    // Tránh mất state nếu onPlayerFinish bị wrap hoặc reassign bởi tryHook.
    var _navPending = false;
    // [FIX #6] Cache ref element icon, tránh querySelector mỗi 400ms trong poll()
    var _btnIcon = null;
    // [FIX #7] Cache nội dung tip cuối cùng để dirty-check trước khi ghi DOM
    var _lastTip = '';

    /* ─────────────────────────────────────────────────────────────
     *  MODULE TIMER
     * ───────────────────────────────────────────────────────────── */
    var Timer = {
        total: 0, chapter: 0,
        _on: false, _iv: null, _bid: '',

        _key: function () { return 'stv_tts_t_' + this._bid; },

        load: function (bookId) {
            this._bid = bookId || '';
            try {
                var d = JSON.parse(localStorage.getItem(this._key()));
                if (d && typeof d.t === 'number' && d.t > 0) this.total = d.t;
            } catch (e) {}
        },

        save: function () {
            try {
                localStorage.setItem(this._key(), JSON.stringify({ t: this.total, d: Date.now() }));
            } catch (e) {}
        },

        start: function () {
            if (this._on) return;
            this._on = true;
            var me = this;
            this._iv = setInterval(function () {
                me.total++;
                me.chapter++;
                if (me.total % SAVE_EVERY === 0) me.save();
            }, 1000);
        },

        pause: function () {
            if (!this._on) return;
            this._on = false;
            clearInterval(this._iv);
            this._iv = null;
            this.save();
        },

        resetChapter: function () { this.chapter = 0; },

        fmt: function (s) {
            var h = ~~(s / 3600), m = ~~((s % 3600) / 60), sc = s % 60;
            var p = function (n) { return n < 10 ? '0' + n : '' + n; };
            return h > 0 ? h + ':' + p(m) + ':' + p(sc) : p(m) + ':' + p(sc);
        }
    };

    /* ─────────────────────────────────────────────────────────────
     *  MODULE PRELOADER
     * ───────────────────────────────────────────────────────────── */
    var Preloader = {
        href: '', status: 'idle', _xhr: null,

        check: function (progress) {
            if (this.status !== 'idle' || progress < PRELOAD_AT) return;
            var nav = document.getElementById('navnextbot');
            if (!nav || !nav.href) return;
            this.href = nav.href;
            this.status = 'loading';
            var me = this;
            var xhr = new XMLHttpRequest();
            xhr.open('GET', this.href, true);
            xhr.timeout = 20000;
            xhr.onload    = function () { me.status = xhr.status < 400 ? 'done' : 'error'; };
            xhr.onerror   = function () { me.status = 'error'; };
            xhr.ontimeout = function () { me.status = 'error'; };
            xhr.send();
            this._xhr = xhr;
        },

        reset: function () {
            if (this._xhr) try { this._xhr.abort(); } catch (e) {}
            this.href = ''; this.status = 'idle'; this._xhr = null;
        }
    };

    /* ─────────────────────────────────────────────────────────────
     *  MODULE BOOKMARK
     * ───────────────────────────────────────────────────────────── */
    var Bookmark = {
        _key: function (bid, cid) { return 'stv_bm_' + bid + '_' + cid; },

        save: function (bid, cid, idx) {
            if (!bid || !cid || idx < 1) return;
            try {
                localStorage.setItem(this._key(bid, cid),
                    JSON.stringify({ i: idx, d: Date.now() }));
            } catch (e) {}
        },

        load: function (bid, cid) {
            try {
                var d = JSON.parse(localStorage.getItem(this._key(bid, cid)));
                if (d && typeof d.i === 'number' && d.i > 0) return d.i;
            } catch (e) {}
            return 0;
        },

        clear: function (bid, cid) {
            try { localStorage.removeItem(this._key(bid, cid)); } catch (e) {}
        }
    };

    /* ─────────────────────────────────────────────────────────────
     *  MODULE AUTO-CONTINUE
     * ───────────────────────────────────────────────────────────── */
    var AutoContinue = {
        _KEY: 'stv_ac',

        isActive: function () {
            try { return sessionStorage.getItem(this._KEY) === '1'; } catch (e) { return false; }
        },

        setActive: function (val) {
            try {
                if (val) sessionStorage.setItem(this._KEY, '1');
                else     sessionStorage.removeItem(this._KEY);
            } catch (e) {}
        }
    };

    /* ─────────────────────────────────────────────────────────────
     *  CSS INJECTION
     * ───────────────────────────────────────────────────────────── */
    function injectCSS() {
        if (document.getElementById('stv-plus-css')) return;
        var el = document.createElement('style');
        el.id = 'stv-plus-css';
        el.textContent = [
            '#stv-tts-btn{',
            '  position:fixed;right:14px;bottom:80px;z-index:10001;',
            '  width:50px;height:50px;border-radius:50%;border:none;',
            '  background:linear-gradient(135deg,#667eea,#764ba2);',
            '  color:#fff;font-size:20px;cursor:pointer;',
            '  box-shadow:0 2px 12px rgba(102,126,234,.4);',
            '  display:flex;align-items:center;justify-content:center;',
            '  transition:all .25s ease;-webkit-tap-highlight-color:transparent;',
            '  outline:none;padding:0;line-height:1;overflow:visible;',
            '}',
            '#stv-tts-btn:hover{transform:scale(1.1);box-shadow:0 4px 20px rgba(102,126,234,.55);}',
            '#stv-tts-btn:active{transform:scale(.93);}',
            '#stv-tts-btn.stv-on{animation:stv-glow 2s ease-in-out infinite;}',
            '@keyframes stv-glow{',
            '  0%,100%{box-shadow:0 2px 12px rgba(102,126,234,.4);}',
            '  50%{box-shadow:0 2px 22px rgba(102,126,234,.75),0 0 0 7px rgba(102,126,234,.13);}',
            '}',
            '#stv-tts-btn.stv-ld{',
            '  background:linear-gradient(135deg,#f0ad4e,#ec971f);',
            '  animation:stv-bk 1s ease-in-out infinite !important;',
            '}',
            '@keyframes stv-bk{0%,100%{opacity:1}50%{opacity:.45}}',
            '#stv-tmr{',
            '  position:absolute;top:-8px;left:50%;transform:translateX(-50%);',
            '  background:rgba(0,0,0,.78);color:#fff;',
            '  font:10px/1 "SF Mono",Consolas,"Courier New",monospace;',
            '  padding:2px 6px;border-radius:8px;white-space:nowrap;',
            '  pointer-events:none;opacity:0;transition:opacity .3s;',
            '  font-variant-numeric:tabular-nums;',
            '}',
            '#stv-tts-btn.stv-on #stv-tmr,#stv-tts-btn:hover #stv-tmr{opacity:1;}',
            '#stv-tip{',
            '  position:absolute;right:58px;top:50%;transform:translateY(-50%);',
            '  background:rgba(0,0,0,.82);color:#fff;font-size:12px;',
            '  padding:5px 10px;border-radius:6px;white-space:nowrap;',
            '  pointer-events:none;opacity:0;transition:opacity .2s;',
            '}',
            '#stv-tts-btn:hover #stv-tip{opacity:1;}',
            '.stv-arc{',
            '  position:absolute;top:-4px;left:-4px;',
            '  width:calc(100% + 8px);height:calc(100% + 8px);',
            '  pointer-events:none;transform:rotate(-90deg);',
            '  opacity:0;transition:opacity .4s;',
            '}',
            '.stv-arc.stv-vis{opacity:1;}',
            '#stv-prog{transition:stroke-dashoffset .4s ease;}',
            /* ── Error toast ── */
            '#stv-err-toast{',
            '  position:fixed;bottom:140px;right:14px;z-index:10002;',
            '  background:#2d2d2d;color:#fff;font-size:13px;',
            '  padding:10px 14px;border-radius:8px;',
            '  box-shadow:0 4px 16px rgba(0,0,0,.4);',
            '  display:flex;align-items:center;gap:10px;',
            '  max-width:280px;line-height:1.4;',
            '}',
            '#stv-err-toast button{',
            '  background:#e53e3e;color:#fff;border:none;',
            '  padding:4px 10px;border-radius:4px;font-size:12px;',
            '  cursor:pointer;white-space:nowrap;flex-shrink:0;',
            '}',
            '#stv-err-toast button:hover{background:#c53030;}',

            /* ── Nút fix âm thanh iOS ── */
            '#stv-fix-btn{',
            '  position:fixed;right:14px;bottom:140px;z-index:10001;',
            '  width:50px;height:50px;border-radius:50%;border:none;',
            '  background:linear-gradient(135deg,#f6ad55,#ed8936);',
            '  color:#fff;font-size:18px;cursor:pointer;',
            '  box-shadow:0 2px 12px rgba(237,137,54,.45);',
            '  display:flex;align-items:center;justify-content:center;',
            '  transition:opacity .3s ease,transform .3s ease;',
            '  -webkit-tap-highlight-color:transparent;',
            '  outline:none;padding:0;line-height:1;',
            '}',
            '#stv-fix-btn:hover{transform:scale(1.1);}',
            '#stv-fix-btn:active{transform:scale(.93);}',
            '#stv-fix-btn.stv-fix-hide{opacity:0;transform:scale(.6);pointer-events:none;}',
            '#stv-fix-tip{',
            '  position:absolute;right:58px;top:50%;transform:translateY(-50%);',
            '  background:rgba(0,0,0,.82);color:#fff;font-size:12px;',
            '  padding:5px 10px;border-radius:6px;white-space:nowrap;',
            '  pointer-events:none;opacity:0;transition:opacity .2s;',
            '}',
            '#stv-fix-btn:hover #stv-fix-tip{opacity:1;}',

            /* ── Responsive ── */
            '@media(max-width:768px){',
            '  #stv-tts-btn{width:44px;height:44px;font-size:17px;bottom:76px;right:8px;}',
            '  #stv-tmr{font-size:9px;}',
            '  #stv-tip{display:none;}',
            '  #stv-err-toast{right:8px;bottom:130px;font-size:12px;}',
            '  #stv-fix-btn{width:44px;height:44px;font-size:16px;bottom:130px;right:8px;}',
            '  #stv-fix-tip{display:none;}',
            '}'
        ].join('\n');
        document.head.appendChild(el);
    }

    /* ─────────────────────────────────────────────────────────────
     *  NÚT NGHE SÁCH + SVG ARC
     * ───────────────────────────────────────────────────────────── */
    function ensureBtn() {
        if (document.getElementById('stv-tts-btn')) {
            btn     = document.getElementById('stv-tts-btn');
            tmrEl   = document.getElementById('stv-tmr');
            tipEl   = document.getElementById('stv-tip');
            arcSvg  = btn.querySelector('.stv-arc');
            arcProg = document.getElementById('stv-prog');
            // [FIX #6] Khôi phục cache icon khi button đã tồn tại (VD: sau SPA nav)
            _btnIcon = btn.querySelector('i.fas');
            return;
        }

        btn = document.createElement('button');
        btn.id = 'stv-tts-btn';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Nghe sách');
        btn.innerHTML = '<i class="fas fa-headphones"></i>';

        // [FIX #6] Cache icon element ngay sau khi tạo, tránh querySelector mỗi poll tick
        _btnIcon = btn.querySelector('i.fas');

        tmrEl = document.createElement('span');
        tmrEl.id = 'stv-tmr';
        tmrEl.textContent = '00:00';
        btn.appendChild(tmrEl);

        tipEl = document.createElement('span');
        tipEl.id = 'stv-tip';
        tipEl.textContent = 'Nghe s\u00E1ch';
        btn.appendChild(tipEl);

        var ns = 'http://www.w3.org/2000/svg';
        arcSvg = document.createElementNS(ns, 'svg');
        arcSvg.setAttribute('class', 'stv-arc');
        arcSvg.setAttribute('viewBox', '0 0 100 100');

        var track = document.createElementNS(ns, 'circle');
        track.setAttribute('cx', '50'); track.setAttribute('cy', '50');
        track.setAttribute('r', '' + ARC_R); track.setAttribute('fill', 'none');
        track.setAttribute('stroke', 'rgba(255,255,255,0.15)');
        track.setAttribute('stroke-width', '3.5');
        arcSvg.appendChild(track);

        arcProg = document.createElementNS(ns, 'circle');
        arcProg.id = 'stv-prog';
        arcProg.setAttribute('cx', '50'); arcProg.setAttribute('cy', '50');
        arcProg.setAttribute('r', '' + ARC_R); arcProg.setAttribute('fill', 'none');
        arcProg.setAttribute('stroke', 'rgba(255,255,255,0.9)');
        arcProg.setAttribute('stroke-width', '3.5');
        arcProg.setAttribute('stroke-linecap', 'round');
        arcProg.setAttribute('stroke-dasharray', ARC_C.toFixed(2));
        arcProg.setAttribute('stroke-dashoffset', ARC_C.toFixed(2));
        arcSvg.appendChild(arcProg);

        btn.appendChild(arcSvg);
        btn.addEventListener('click', handleClick);
        document.body.appendChild(btn);
    }

    /* ─────────────────────────────────────────────────────────────
     *  NÚT FIX ÂM THANH iOS — dùng 1 lần rồi biến mất
     * ───────────────────────────────────────────────────────────── */
    function ensureFixBtn() {
        if (document.getElementById('stv-fix-btn')) {
            fixBtn = document.getElementById('stv-fix-btn');
            return;
        }

        fixBtn = document.createElement('button');
        fixBtn.id = 'stv-fix-btn';
        fixBtn.type = 'button';
        fixBtn.setAttribute('aria-label', 'Fix âm thanh iOS');
        fixBtn.innerHTML = '<i class="fas fa-volume-up"></i>';

        var tip = document.createElement('span');
        tip.id = 'stv-fix-tip';
        tip.textContent = 'Fix \u00E2m thanh iOS';
        fixBtn.appendChild(tip);

        fixBtn.addEventListener('click', function () {
            AudioSessionFix.trigger();
            /* Ẩn ngay, xóa khỏi DOM sau khi transition xong */
            fixBtn.classList.add('stv-fix-hide');
            setTimeout(function () {
                if (fixBtn && fixBtn.parentNode) fixBtn.parentNode.removeChild(fixBtn);
                fixBtn = null;
            }, 350);
        });

        document.body.appendChild(fixBtn);
    }

    /* ─────────────────────────────────────────────────────────────
     *  CLICK HANDLER
     * ───────────────────────────────────────────────────────────── */
    function handleClick() {
        var p = getPlayer();

        if (p && p.isPlaying) {
            AutoContinue.setActive(false);
            p.stop();
            return;
        }

        // [FIX #13] Unlock iOS audio trong cùng gesture với lệnh play
        AudioSessionFix.trigger();

        if (p && p.tokenizedSentences && p.tokenizedSentences.length > 0) {
            AutoContinue.setActive(true);
            p.resume();
            return;
        }

        if (window.speaker && typeof window.speaker.readBook === 'function') {
            AutoContinue.setActive(true);
            resumeRequested = true;
            window.speaker.readBook();
            setTimeout(tryHook, 500);
            scheduleResume(50);
        }
    }

    /* ─────────────────────────────────────────────────────────────
     *  SCHEDULE RESUME (từ bookmark)
     * ───────────────────────────────────────────────────────────── */
    function scheduleResume(retries) {
        var myId = ++_resumeId;
        _doScheduleResume(myId, retries);
    }

    function _doScheduleResume(myId, retries) {
        if (myId !== _resumeId || !resumeRequested || retries <= 0) {
            if (myId === _resumeId) resumeRequested = false;
            return;
        }
        var p = getPlayer();
        if (p && p.isPlaying && p.tokenizedSentences && p.tokenizedSentences.length > 0) {
            resumeRequested = false;
            var bid   = window.abookid || '';
            var cid   = getChapId();
            var saved = Bookmark.load(bid, cid);
            if (saved > 0 && saved < p.tokenizedSentences.length) {
                p.start(saved);
                try {
                    if (window.ui && window.ui.notif)
                        window.ui.notif('\u25B6 Ti\u1EBFp t\u1EEB c\u00E2u ' + (saved + 1) + '/' + p.tokenizedSentences.length);
                } catch (e) {}
            }
            return;
        }
        setTimeout(function () { _doScheduleResume(myId, retries - 1); }, 100);
    }

    /* ─────────────────────────────────────────────────────────────
     *  WAKELOCK
     * ───────────────────────────────────────────────────────────── */
    var WakeLock = {
        _lock: null,

        request: function () {
            if (!navigator.wakeLock || this._lock) return;
            var me = this;
            navigator.wakeLock.request('screen').then(function (lock) {
                me._lock = lock;
                lock.addEventListener('release', function () {
                    me._lock = null;
                    if (document.visibilityState === 'visible') me.request();
                });
            }).catch(function () {});
        },

        release: function () {
            if (!this._lock) return;
            try { this._lock.release(); } catch (e) {}
            this._lock = null;
        }
    };

    /* ─────────────────────────────────────────────────────────────
     *  MEDIA SESSION
     * ───────────────────────────────────────────────────────────── */
    var MediaSess = {
        _set: false,

        update: function (playing) {
            if (!navigator.mediaSession) return;
            try {
                if (!this._set) {
                    var title = '';
                    try {
                        title = document.title || '';
                        var h1 = document.querySelector('h1');
                        if (h1) title = h1.textContent.trim() || title;
                    } catch (e) {}
                    navigator.mediaSession.metadata = new MediaMetadata({
                        title:  title || 'Nghe s\u00E1ch',
                        artist: 'SangTacViet',
                        album:  ''
                    });
                    navigator.mediaSession.setActionHandler('play', function () {
                        // [FIX #14] Unlock iOS audio khi play từ lock screen / notification
                        AudioSessionFix.trigger();
                        var p = getPlayer();
                        if (p && p.tokenizedSentences && p.tokenizedSentences.length > 0) {
                            AutoContinue.setActive(true);
                            p.resume();
                        } else if (window.speaker && window.speaker.readBook) {
                            AutoContinue.setActive(true);
                            window.speaker.readBook();
                        }
                    });
                    navigator.mediaSession.setActionHandler('pause', function () {
                        var p = getPlayer();
                        if (p && p.isPlaying) {
                            AutoContinue.setActive(false);
                            p.stop();
                        }
                    });
                    navigator.mediaSession.setActionHandler('nexttrack', function () {
                        var nav = document.getElementById('navnextbot');
                        if (nav) nav.click();
                    });
                    navigator.mediaSession.setActionHandler('previoustrack', function () {
                        var nav = document.getElementById('navprevbot');
                        if (nav) nav.click();
                    });
                    this._set = true;
                }
                navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
            } catch (e) {}
        },

        reset: function () { this._set = false; }
    };

    /* ─────────────────────────────────────────────────────────────
     *  AUDIO SESSION FIX (iOS unlock)
     * ───────────────────────────────────────────────────────────── */
    var AudioSessionFix = {
        _ctx: null,
        _done: false,
        _gestureBound: false,
        _onGesture: null,
        _resumeTimer: null,

        _getCtx: function () {
            if (this._ctx) {
                if (this._ctx.state === 'closed') {
                    this._ctx = null;
                } else {
                    return this._ctx;
                }
            }
            try {
                var Ctor = window.AudioContext || window.webkitAudioContext;
                if (!Ctor) return null;
                this._ctx = new Ctor({ latencyHint: 'interactive' });
            } catch (e) { this._ctx = null; }
            return this._ctx;
        },

        _bindGestureUnlock: function () {
            if (this._gestureBound) return;
            var me = this;
            this._onGesture = function () { me.trigger(); };
            ['touchstart', 'click', 'keydown'].forEach(function (ev) {
                document.addEventListener(ev, me._onGesture, { passive: true });
            });
            this._gestureBound = true;
        },

        _unbindGestureUnlock: function () {
            if (!this._gestureBound || !this._onGesture) return;
            var me = this;
            ['touchstart', 'click', 'keydown'].forEach(function (ev) {
                document.removeEventListener(ev, me._onGesture, false);
            });
            this._gestureBound = false;
            this._onGesture = null;
        },

        _ping: function (ctx, markDone) {
            var me = this;
            try {
                var buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
                var src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(ctx.destination);
                src.start(0);
                src.onended = function () {
                    try { src.disconnect(); } catch (e) {}
                    if (markDone) me._done = true;
                    if (ctx.state === 'running') me._unbindGestureUnlock();
                };
            } catch (e) {}
        },

        _resumeLoop: function (tries, delay) {
            var me = this;
            if (me._resumeTimer) { clearTimeout(me._resumeTimer); me._resumeTimer = null; }
            var left = tries || 0;

            function step() {
                if (document.visibilityState === 'hidden') {
                    me._resumeTimer = setTimeout(step, 1000);
                    return;
                }
                var ctx = me._getCtx();
                if (!ctx || ctx.state === 'running') {
                    me._unbindGestureUnlock();
                    return;
                }
                if (left <= 0) {
                    me._bindGestureUnlock();
                    return;
                }
                left--;
                ctx.resume().catch(function () {});
                me._resumeTimer = setTimeout(step, delay || 220);
            }
            step();
        },

        // [FIX #12] Unlock HTML5 <audio> — iOS cần play() trên HTMLAudioElement
        // trong user-gesture để kích hoạt audio session cho <audio> elements
        _unlockHtmlAudio: function () {
            try {
                var buf = new ArrayBuffer(46);
                var v   = new DataView(buf);
                /* RIFF header */
                v.setUint32(0,  0x52494646, false);   // 'RIFF'
                v.setUint32(4,  38, true);
                v.setUint32(8,  0x57415645, false);   // 'WAVE'
                /* fmt  chunk */
                v.setUint32(12, 0x666D7420, false);   // 'fmt '
                v.setUint32(16, 16, true);
                v.setUint16(20, 1, true);              // PCM
                v.setUint16(22, 1, true);              // mono
                v.setUint32(24, 22050, true);          // sample rate
                v.setUint32(28, 44100, true);          // byte rate
                v.setUint16(32, 2, true);              // block align
                v.setUint16(34, 16, true);             // bits per sample
                /* data chunk */
                v.setUint32(36, 0x64617461, false);    // 'data'
                v.setUint32(40, 2, true);
                v.setInt16(44, 0, true);               // one silent sample

                var blob = new Blob([buf], { type: 'audio/wav' });
                var url  = URL.createObjectURL(blob);
                var a    = new Audio(url);
                a.volume = 0.01;
                var p = a.play();
                if (p && p.then) {
                    p.then(function () {
                        setTimeout(function () {
                            try { a.pause(); } catch (e) {}
                            URL.revokeObjectURL(url);
                        }, 50);
                    }).catch(function () { URL.revokeObjectURL(url); });
                }
            } catch (e) {}
        },

        trigger: function () {
            var ctx = this._getCtx();
            if (!ctx) return;
            var me = this;
            me._bindGestureUnlock();
            // [FIX #12] Unlock HTML5 Audio song song với AudioContext
            me._unlockHtmlAudio();
            function _play() { me._ping(ctx, true); }
            if (ctx.state === 'suspended') {
                ctx.resume().then(_play).catch(function () {
                    _play();
                    me._resumeLoop(4, 180);
                });
            } else {
                _play();
            }
        },

        triggerSilent: function () {
            var ctx = this._getCtx();
            if (!ctx) return;
            var me = this;
            if (ctx.state === 'suspended') {
                ctx.resume().then(function () {
                    me._ping(ctx, false);
                    me._unbindGestureUnlock();
                }).catch(function () {
                    me._bindGestureUnlock();
                    me._resumeLoop(4, 250);
                });
            } else if (ctx.state === 'running') {
                this._ping(ctx, false);
            }
        },

        ensureActive: function () {
            var ctx = this._getCtx();
            if (!ctx) return;
            if (ctx.state === 'suspended') this.triggerSilent();
        },

        reset: function () {
            this._done = false;
            if (this._resumeTimer) {
                clearTimeout(this._resumeTimer);
                this._resumeTimer = null;
            }
            /* Không đóng ctx — tái dùng cho chương tiếp */
        },

        // [FIX #10] Đóng AudioContext khi trang unload để giải phóng OS resource
        close: function () {
            this._unbindGestureUnlock();
            if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
            if (this._ctx && this._ctx.state !== 'closed') {
                try { this._ctx.close(); } catch (e) {}
            }
            this._ctx = null;
        }
    };

    /* ─────────────────────────────────────────────────────────────
     *  [FIX #3] CLEANUP TỔNG THỂ — gọi khi beforeunload
     *  Giải phóng: interval, observer, AudioContext, timers
     * ───────────────────────────────────────────────────────────── */
    function cleanup() {
        // [FIX #1] Clear interval đã lưu
        if (_pollIv !== null) { clearInterval(_pollIv); _pollIv = null; }
        // [FIX #2] Disconnect observer đã lưu
        if (_mo !== null) { try { _mo.disconnect(); } catch (e) {} _mo = null; }
        // [FIX #11] Clear ldTimer nếu còn đang pending
        if (ldTimer !== null) { clearTimeout(ldTimer); ldTimer = null; }
        // [FIX #10] Đóng AudioContext
        AudioSessionFix.close();
        // Lưu timer lần cuối trước khi tắt
        Timer.pause();
    }

    /* ─────────────────────────────────────────────────────────────
     *  safeReadBook
     * ───────────────────────────────────────────────────────────── */
    function safeReadBook(resumeRetries, withBookmark) {
        resumeRetries = resumeRetries || 80;
        var p = getPlayer();

        if (p && p.isPlaying) {
            if (withBookmark) {
                resumeRequested = true;
                scheduleResume(resumeRetries);
            }
            return;
        }

        if (window.speaker && typeof window.speaker.readBook === 'function') {
            if (withBookmark) resumeRequested = true;
            window.speaker.readBook();
            setTimeout(tryHook, 500);
            scheduleResume(resumeRetries);
        }
    }

    /* ─────────────────────────────────────────────────────────────
     *  POLLING
     * ───────────────────────────────────────────────────────────── */
    function poll() {
        // [FIX #8] Wrap toàn bộ poll trong try/catch.
        // Nếu không làm vậy, một exception bất kỳ sẽ không kill interval
        // nhưng sẽ để lại UI state không đồng bộ mà không có log nào.
        try {
            _pollInner();
        } catch (e) {
            // Log để debug nhưng không re-throw — interval phải tiếp tục chạy
            if (typeof console !== 'undefined') {
                console.error('[stv-plus] poll error:', e);
            }
        }
    }

    function _pollInner() {
        var p        = getPlayer();
        var on       = !!(p && p.isPlaying);
        var hasSent  = !!(p && p.tokenizedSentences && p.tokenizedSentences.length > 0);
        var total    = hasSent ? p.tokenizedSentences.length : 0;
        var cur      = hasSent ? p.currentSentenceIndex : 0;
        var progress = total > 0 ? cur / total : 0;

        var bid = window.abookid || '';
        if (bid && bid !== prevBid) {
            prevBid = bid;
            Timer.load(bid);
        }

        if (btn) {
            btn.classList.toggle('stv-on', on);
            btn.classList.toggle('stv-ld', chapLoading && !on);

            // [FIX #6] Dùng _btnIcon đã cache, không gọi querySelector mỗi tick
            var ico = _btnIcon;
            if (ico) {
                var cls = chapLoading ? 'fa-spinner'
                        : on          ? 'fa-pause'
                        : hasSent     ? 'fa-play'
                        :               'fa-headphones';
                if (!ico.classList.contains(cls)) ico.className = 'fas ' + cls;
            }
        }

        if (on && !wasOn) {
            Timer.start();
            WakeLock.request();
            MediaSess.update(true);
        }
        if (!on && wasOn) {
            Timer.pause();
            WakeLock.release();
            MediaSess.update(false);
            if (p && cur > 0) Bookmark.save(bid, getChapId(), cur);
        }
        wasOn = on;

        var cid = getChapId();
        if (cid && cid !== prevCid) {
            if (prevCid !== null) {
                Timer.resetChapter();
                Preloader.reset();
            }
            prevCid = cid;
            _reloadCount = 0;
        }

        if (on) {
            bmTick++;
            if (bmTick >= BM_EVERY) {
                bmTick = 0;
                if (cur > 0) Bookmark.save(bid, getChapId(), cur);
            }
        } else {
            bmTick = 0;
        }

        if (on) Preloader.check(progress);

        if (arcSvg)  arcSvg.classList.toggle('stv-vis', hasSent && (on || progress > 0));
        if (arcProg) arcProg.setAttribute('stroke-dashoffset', (ARC_C * (1 - progress)).toFixed(2));
        if (tmrEl)   tmrEl.textContent = Timer.fmt(Timer.chapter);

        if (tipEl) {
            var nextTip;
            if (Timer._on) {
                var pct = total > 0 ? Math.round(progress * 100) : 0;
                nextTip = 'Ch\u01B0\u01A1ng ' + Timer.fmt(Timer.chapter)
                    + '  \u00B7  T\u1ED5ng ' + Timer.fmt(Timer.total)
                    + (total > 0 ? '  \u00B7  ' + pct + '%' : '');
            } else if (chapLoading) {
                nextTip = '\u0110ang t\u1EA3i ch\u01B0\u01A1ng ti\u1EBFp...';
            } else if (hasSent) {
                nextTip = 'Ti\u1EBFp t\u1EE5c nghe';
            } else {
                nextTip = 'Nghe s\u00E1ch';
            }
            // [FIX #7] Chỉ ghi vào DOM khi nội dung thực sự thay đổi,
            // tránh trigger layout recalculation không cần thiết mỗi 400ms
            if (nextTip !== _lastTip) {
                tipEl.textContent = nextTip;
                _lastTip = nextTip;
            }
        }

        if (window.ttsUI && !window.ttsUI.__stv) tryHook();
        patchTikTokInstance();
    }

    /* ─────────────────────────────────────────────────────────────
     *  HELPERS
     * ───────────────────────────────────────────────────────────── */
    function getPlayer() {
        return (window.ttsUI && window.ttsUI.player) ? window.ttsUI.player : null;
    }

    function getChapId() {
        if (window.abookchapter) return '' + window.abookchapter;
        try {
            var cc = window.contentcontainer || 'maincontent';
            var el = document.getElementById(cc);
            if (!el) return '';
            // Ưu tiên attribute 'cid' — fallback el.id có thể là 'maincontent'
            // (một giá trị generic va chạm giữa mọi chương của cùng cuốn sách).
            // Tuy nhiên chưa có API tốt hơn nên giữ nguyên, chỉ document rủi ro.
            return el.getAttribute('cid') || el.id;
        } catch (e) { return ''; }
    }

    /* ─────────────────────────────────────────────────────────────
     *  onPlayerFinish
     * ───────────────────────────────────────────────────────────── */
    function onPlayerFinish() {
        var p = getPlayer();
        var sentCount = (p && p.tokenizedSentences) ? p.tokenizedSentences.length : 0;

        if (sentCount === 0) {
            AutoContinue.setActive(false);
            chapLoading = false;
            showErrToast('\u26A0 Kh\u00F4ng c\u00F3 n\u1ED9i dung \u2014 l\u1ED7i d\u1ECBch AI.', true);
            return;
        }

        var bid = window.abookid || '';
        var cid = getChapId();
        if (bid && cid) Bookmark.clear(bid, cid);

        chapLoading = true;
        if (ldTimer) clearTimeout(ldTimer);
        ldTimer = setTimeout(function () { chapLoading = false; }, 30000);

        if (AutoContinue.isActive()) {
            // [FIX #5] Dùng module-level _navPending thay vì onPlayerFinish._navPending.
            // Function property bị mất nếu function bị wrap hoặc reassign bởi tryHook.
            _navPending = true;
            setTimeout(function () {
                if (!_navPending) return;
                // [FIX #5] Dùng try/finally để đảm bảo _navPending luôn được reset
                // kể cả khi nav.click() throw exception
                try {
                    var nav = document.getElementById('navnextbot');
                    if (nav && nav.href) {
                        nav.click();
                    } else {
                        AutoContinue.setActive(false);
                        chapLoading = false;
                    }
                } finally {
                    _navPending = false;
                }
            }, 2500);
        }
    }

    /* ─────────────────────────────────────────────────────────────
     *  TOAST LỖI CÓ NÚT THỬ LẠI
     * ───────────────────────────────────────────────────────────── */
    function showErrToast(msg, withRetryBtn) {
        var old = document.getElementById('stv-err-toast');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var toast = document.createElement('div');
        toast.id = 'stv-err-toast';

        var txt = document.createElement('span');
        txt.textContent = msg;
        toast.appendChild(txt);

        var _autoHide;

        if (withRetryBtn) {
            var retryBtn = document.createElement('button');
            retryBtn.textContent = 'Th\u1EED l\u1EA1i';
            retryBtn.addEventListener('click', function () {
                clearTimeout(_autoHide);
                if (toast.parentNode) toast.parentNode.removeChild(toast);
                _reloadCount = 0;
                AutoContinue.setActive(true);
                _reloadCurrentChapter();
            });
            toast.appendChild(retryBtn);
        }

        document.body.appendChild(toast);

        _autoHide = setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 15000);
    }

    /* ─────────────────────────────────────────────────────────────
     *  tryHook — WRAP onContentLoaded + applyConfig
     * ───────────────────────────────────────────────────────────── */
    function tryHook() {
        var t = window.ttsUI;
        if (!t || t.__stv) return;

        function bindFinishOnce() {
            try {
                if (!t || !t.player || !t.player.on) return;
                if (t.__stv_finish_bound) return;
                t.player.on('finish', onPlayerFinish);
                t.__stv_finish_bound = true;
            } catch (e) {}
        }

        var _ocl = t.onContentLoaded;
        t.onContentLoaded = function () {
            chapLoading = false;
            if (ldTimer) { clearTimeout(ldTimer); ldTimer = null; }
            Timer.resetChapter();
            Preloader.reset();
            AudioSessionFix.reset();
            MediaSess.reset();
            // [FIX #5] Reset module-level _navPending thay vì function property
            _navPending = false;
            _lastTip = ''; // [FIX #7] Invalidate tip cache khi chapter mới load

            var p = getPlayer();
            var _origStart = null;
            if (p && typeof p.start === 'function') {
                _origStart = p.start;
                p.start = function () {};
            }

            try {
                if (typeof _ocl === 'function') _ocl.apply(t, arguments);
            } catch (e) {}

            if (p && _origStart) p.start = _origStart;

            var sentCount = (p && p.tokenizedSentences) ? p.tokenizedSentences.length : 0;

            if (sentCount === 0) {
                if (_reloadCount < MAX_RELOADS) {
                    var delay = RETRY_DELAYS[_reloadCount] || 2000;
                    _reloadCount++;
                    try {
                        if (window.ui && window.ui.notif)
                            window.ui.notif('\u26A0 N\u1ED9i dung tr\u1ED1ng, th\u1EED t\u1EA3i l\u1EA1i ('
                                + _reloadCount + '/' + MAX_RELOADS + ')...');
                    } catch (e) {}
                    setTimeout(function () { _reloadCurrentChapter(); }, delay);
                } else {
                    AutoContinue.setActive(false);
                    showErrToast('\u274C L\u1ED7i d\u1ECBch AI \u2014 ch\u01B0\u01A1ng n\u00E0y kh\u00F4ng load \u0111\u01B0\u1EE3c.', true);
                }
                return;
            }

            if (AutoContinue.isActive()) {
                setTimeout(function () {
                    if (!AutoContinue.isActive()) return;
                    resumeRequested = false;
                    safeReadBook(80, false);
                }, 3000);
            }
        };

        var _ac = t.applyConfig;
        if (typeof _ac === 'function') {
            t.applyConfig = function () {
                _ac.apply(t, arguments);
                bindFinishOnce();
            };
        }

        t.__stv = true;
        bindFinishOnce();
    }

    /* ─────────────────────────────────────────────────────────────
     *  RELOAD CHƯƠNG HIỆN TẠI
     * ───────────────────────────────────────────────────────────── */
    function _reloadCurrentChapter() {
        try {
            var href = window.location.href;
            if (window.ui && typeof window.ui.swiftload === 'function') {
                window.ui.swiftload(href, 'naviga', function () {
                    window.contentcontainer = 'maincontent';
                    if (typeof window.loadConfig === 'function') window.loadConfig();
                    if (typeof window.defineSys === 'function') window.defineSys();
                });
            } else {
                window.location.reload();
            }
        } catch (e) {
            try { window.location.reload(); } catch (e2) {}
        }
    }

    /* ─────────────────────────────────────────────────────────────
     *  PATCH TIKTOK VOICE
     * ───────────────────────────────────────────────────────────── */
    var TIKTOK_PROXY_FIXED = '/io/s1213/tiktoktts?voice={voice}';

    function _makeTikTokFetchAudio(self) {
        return function patchedFetchAudio(text, options) {
            if (!text || text.trim().length === 0)
                return Promise.reject(new Error('Text is required'));
            options = options || {};

            return self.getVoices().then(function (voices) {
                var voiceId = options.voice !== undefined ? options.voice : self.options.voice;
                voiceId = parseInt(voiceId, 10) || 0;
                if (voiceId < 0 || voiceId >= voices.length) voiceId = 0;

                var serverVoiceId = voices[voiceId].serverId || 'tiktok:1';
                var url = TIKTOK_PROXY_FIXED.replace('{voice}', encodeURIComponent(serverVoiceId));

                return self.fetchWithTimeout(url, {
                    text:  text,
                    voice: serverVoiceId
                }).then(function (response) {
                    if (!response.ok) throw new Error('TikTok fetch failed: ' + response.statusText);
                    return response.blob();
                });
            });
        };
    }

    function patchTikTokProto() {
        try {
            var svc = window.TextToSpeechService;
            if (!svc || typeof svc.getProvider !== 'function') return false;

            var instance;
            try { instance = svc.getProvider('TikTokTTS'); } catch (e) { return false; }
            if (!instance) return false;

            var proto = instance.constructor && instance.constructor.prototype;
            if (!proto) return false;
            if (proto.__stv_tiktok_fixed) return true;

            proto.fetchAudio = function (text, options) {
                return _makeTikTokFetchAudio(this)(text, options);
            };

            proto.getVoices = function () {
                return Promise.resolve([
                    { id: 0, name: 'N\u1EEF 1',  fullName: 'Gi\u1ECDng N\u1EEF 1 (TikTok)',  serverId: 'tiktok:1' },
                    { id: 1, name: 'Nam 1', fullName: 'Gi\u1ECDng Nam 1 (TikTok)', serverId: 'tiktok:2' },
                    { id: 2, name: 'N\u1EEF 2',  fullName: 'Gi\u1ECDng N\u1EEF 2 (TikTok)',  serverId: 'tiktok:3' }
                ]);
            };

            proto.__stv_tiktok_fixed = true;
            return true;
        } catch (e) { return false; }
    }

    function patchTikTokInstance() {
        try {
            var p = getPlayer();
            if (!p || !p.provider) return;
            if (p.provider.id !== 'tiktok' || p.provider.__stv_instance_fixed) return;
            p.provider.fetchAudio = _makeTikTokFetchAudio(p.provider);
            p.provider.__stv_instance_fixed = true;
        } catch (e) {}
    }

    // [FIX #9] Thoát sớm ngay khi proto đã được patch thành công,
    // không tiếp tục lặp thêm 20 lần × 300ms = 6 giây không cần thiết
    function ensureTikTokPatch(retries) {
        var protoDone = patchTikTokProto();
        patchTikTokInstance();
        if (protoDone) return; // [FIX #9] Proto fixed → không cần retry thêm
        if ((retries || 0) > 0)
            setTimeout(function () { ensureTikTokPatch(retries - 1); }, 300);
    }

    /* ─────────────────────────────────────────────────────────────
     *  INIT VÀ BOOT
     * ───────────────────────────────────────────────────────────── */
    function init() {
        if (!document.getElementById('hiddenid')) return;

        if (!booted) {
            booted = true;
            Timer.load(window.abookid || '');
            prevBid = window.abookid || '';
            injectCSS();
            ensureBtn();
            ensureFixBtn();

            // [FIX #1] Lưu ID interval để có thể clearInterval trong cleanup()
            _pollIv = setInterval(poll, POLL_MS);

            if (window.ttsUI) tryHook();

            if (AutoContinue.isActive()) {
                setTimeout(function () {
                    if (!AutoContinue.isActive()) return;
                    safeReadBook(80, true);
                }, 800);
            }
        } else {
            if (!document.getElementById('stv-tts-btn')) ensureBtn();
            if (!document.getElementById('stv-fix-btn') && fixBtn !== null) ensureFixBtn();
            if (window.ttsUI && !window.ttsUI.__stv) tryHook();
        }
    }

    var _debounce = null;
    function debouncedInit() {
        if (_debounce) return;
        _debounce = setTimeout(function () { _debounce = null; init(); }, 200);
    }

    function boot() {
        if (!_audioLifeBound) {
            _audioLifeBound = true;

            // [FIX #4] visibilitychange không còn rỗng — khôi phục AudioContext
            // khi tab trở lại foreground (trình duyệt có thể suspend ctx khi tab ẩn)
            document.addEventListener('visibilitychange', function () {
                if (document.visibilityState === 'visible') {
                    AudioSessionFix.ensureActive();
                }
            }, false);

            // [FIX #4] pageshow không còn rỗng — xử lý back/forward cache restore
            // trên Safari iOS: ctx có thể bị suspend sau khi page được restore từ bfcache
            window.addEventListener('pageshow', function (e) {
                if (e.persisted) {
                    AudioSessionFix.ensureActive();
                }
            }, false);

            // [FIX #3] Đăng ký cleanup tổng thể một lần duy nhất
            window.addEventListener('beforeunload', cleanup, false);
        }

        ensureTikTokPatch(20);
        init();

        if (window.MutationObserver) {
            // [FIX #2] Lưu ref observer để có thể disconnect trong cleanup()
            _mo = new MutationObserver(debouncedInit);
            _mo.observe(document.body, { childList: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();

// ==UserScript==
// @name         SangTacViet Nghe Sach Plus
// @namespace    http://tampermonkey.net/
// @version      2.1
// @author       @NMT25
// @description  (v2.1) Nút nghe sách, đếm giờ, tự chuyển chương, preload chương kế, ghi nhớ vị trí, vòng tiến trình.
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

    /* ==================================================================
     *  SangTacViet Nghe Sách Plus v2.1
     *  ----------------------------------------------------------------
     *  MỚI trong v2.1:
     *  ① Preload chương tiếp  – fetch trước nội dung khi đọc ~70%
     *  ② Ghi nhớ vị trí      – auto-save câu đang đọc, resume khi mở lại
     *  ③ Vòng tiến trình      – SVG arc quanh nút hiện % câu đã đọc
     *
     *  Giữ nguyên từ v2.0:
     *  - Polling 400ms (player.reset() xóa events → không dùng .on())
     *  - Monkey-patch ttsUI.onContentLoaded + ttsUI.applyConfig
     *  - Nút riêng biệt, hoạt động song song TTS gốc
     * ================================================================== */

    var POLL_MS    = 400;    // Tần suất polling (ms)
    var SAVE_EVERY = 15;     // Lưu timer mỗi N giây
    var BM_EVERY   = 5;      // Lưu bookmark mỗi N lần poll (~2s)
    var PRELOAD_AT = 0.70;   // Preload chương tiếp khi đọc được 70%
    var ARC_R      = 45;     // Bán kính arc SVG (viewBox 100×100)
    var ARC_C      = 2 * Math.PI * ARC_R; // Chu vi ≈ 282.74

    /* ─────────────────────────────────────────────────────────────
     *  1. BỘ ĐẾM THỜI GIAN NGHE
     *     Lưu tổng thời gian theo bookId, đếm riêng từng chương
     * ───────────────────────────────────────────────────────────── */
    var Timer = {
        total: 0, chapter: 0,
        _on: false, _iv: null, _bid: '',

        _key: function () { return 'stv_tts_t' + (this._bid ? '_' + this._bid : ''); },

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
                me.total++; me.chapter++;
                if (me.total % SAVE_EVERY === 0) me.save();
            }, 1000);
        },

        pause: function () {
            if (!this._on) return;
            this._on = false;
            clearInterval(this._iv); this._iv = null;
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
     *  2. PRELOADER CHƯƠNG TIẾP
     *     Fetch trước URL chương kế tiếp để warm HTTP cache.
     *     Khi FINISH → swiftload sẽ lấy response từ cache → nhanh hơn.
     * ───────────────────────────────────────────────────────────── */
    var Preloader = {
        href: '', status: 'idle', _xhr: null,

        /** Bắt đầu preload nếu đủ điều kiện */
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

        /** Reset khi chuyển chương */
        reset: function () {
            if (this._xhr) try { this._xhr.abort(); } catch (e) {}
            this.href = ''; this.status = 'idle'; this._xhr = null;
        }
    };

    /* ─────────────────────────────────────────────────────────────
     *  3. BOOKMARK – GHI NHỚ VỊ TRÍ ĐỌC
     *     Lưu sentenceIndex theo bookId + chapterId.
     *     Khi người dùng bấm Nghe sách → resume từ câu đã lưu.
     *     Khi chương đọc xong tự nhiên (FINISH) → xóa bookmark.
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
     *  4. INJECT CSS
     *     Nút gradient tím, pulse khi phát, loading vàng,
     *     timer badge, tooltip, SVG progress arc
     * ───────────────────────────────────────────────────────────── */
    function injectCSS() {
        if (document.getElementById('stv-plus-css')) return;
        var el = document.createElement('style');
        el.id = 'stv-plus-css';
        el.textContent = [
            /* Nút chính */
            '#stv-tts-btn{',
            '  position:fixed; right:14px; bottom:80px; z-index:10001;',
            '  width:50px; height:50px; border-radius:50%; border:none;',
            '  background:linear-gradient(135deg,#667eea,#764ba2);',
            '  color:#fff; font-size:20px; cursor:pointer;',
            '  box-shadow:0 2px 12px rgba(102,126,234,.4);',
            '  display:flex; align-items:center; justify-content:center;',
            '  transition:all .25s ease; -webkit-tap-highlight-color:transparent;',
            '  outline:none; padding:0; line-height:1; overflow:visible;',
            '}',
            '#stv-tts-btn:hover{ transform:scale(1.1); box-shadow:0 4px 20px rgba(102,126,234,.55); }',
            '#stv-tts-btn:active{ transform:scale(.93); }',

            /* Pulse khi đang phát */
            '#stv-tts-btn.stv-on{ animation:stv-glow 2s ease-in-out infinite; }',
            '@keyframes stv-glow{',
            '  0%,100%{ box-shadow:0 2px 12px rgba(102,126,234,.4); }',
            '  50%{ box-shadow:0 2px 22px rgba(102,126,234,.75), 0 0 0 7px rgba(102,126,234,.13); }',
            '}',

            /* Loading vàng nhấp nháy */
            '#stv-tts-btn.stv-ld{',
            '  background:linear-gradient(135deg,#f0ad4e,#ec971f);',
            '  animation:stv-bk 1s ease-in-out infinite !important;',
            '}',
            '@keyframes stv-bk{ 0%,100%{opacity:1} 50%{opacity:.45} }',

            /* Timer badge (phía trên nút) */
            '#stv-tmr{',
            '  position:absolute; top:-8px; left:50%; transform:translateX(-50%);',
            '  background:rgba(0,0,0,.78); color:#fff;',
            '  font:10px/1 "SF Mono",Consolas,"Courier New",monospace;',
            '  padding:2px 6px; border-radius:8px; white-space:nowrap;',
            '  pointer-events:none; opacity:0; transition:opacity .3s;',
            '  font-variant-numeric:tabular-nums;',
            '}',
            '#stv-tts-btn.stv-on #stv-tmr, #stv-tts-btn:hover #stv-tmr{ opacity:1; }',

            /* Tooltip (bên trái nút) */
            '#stv-tip{',
            '  position:absolute; right:58px; top:50%; transform:translateY(-50%);',
            '  background:rgba(0,0,0,.82); color:#fff; font-size:12px;',
            '  padding:5px 10px; border-radius:6px; white-space:nowrap;',
            '  pointer-events:none; opacity:0; transition:opacity .2s;',
            '}',
            '#stv-tts-btn:hover #stv-tip{ opacity:1; }',

            /* SVG progress arc */
            '.stv-arc{',
            '  position:absolute; top:-4px; left:-4px;',
            '  width:calc(100% + 8px); height:calc(100% + 8px);',
            '  pointer-events:none; transform:rotate(-90deg);',
            '  opacity:0; transition:opacity .4s;',
            '}',
            '.stv-arc.stv-vis{ opacity:1; }',
            '#stv-prog{ transition:stroke-dashoffset .4s ease; }',

            /* Responsive mobile */
            '@media(max-width:768px){',
            '  #stv-tts-btn{ width:44px; height:44px; font-size:17px; bottom:76px; right:8px; }',
            '  #stv-tmr{ font-size:9px; }',
            '  #stv-tip{ display:none; }',
            '}'
        ].join('\n');
        document.head.appendChild(el);
    }

    /* ─────────────────────────────────────────────────────────────
     *  5. TẠO NÚT NGHE SÁCH + SVG ARC
     *     Position fixed, phía trên configBox/gear button.
     *     Icon tai nghe (FA5 Pro sẵn trên trang).
     *     Timer badge + tooltip + SVG vòng tiến trình.
     * ───────────────────────────────────────────────────────────── */
    var btn, tmrEl, tipEl, arcSvg, arcProg;

    function ensureBtn() {
        if (document.getElementById('stv-tts-btn')) {
            btn     = document.getElementById('stv-tts-btn');
            tmrEl   = document.getElementById('stv-tmr');
            tipEl   = document.getElementById('stv-tip');
            arcSvg  = btn.querySelector('.stv-arc');
            arcProg = document.getElementById('stv-prog');
            return;
        }

        btn = document.createElement('button');
        btn.id = 'stv-tts-btn';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Nghe sách');

        // Icon headphone (FA5 Pro có sẵn trên trang)
        btn.innerHTML = '<i class="fas fa-headphones"></i>';

        // Timer badge
        tmrEl = document.createElement('span');
        tmrEl.id = 'stv-tmr';
        tmrEl.textContent = '00:00';
        btn.appendChild(tmrEl);

        // Tooltip
        tipEl = document.createElement('span');
        tipEl.id = 'stv-tip';
        tipEl.textContent = 'Nghe s\u00E1ch';
        btn.appendChild(tipEl);

        // ── SVG Progress Arc ──
        var ns = 'http://www.w3.org/2000/svg';
        arcSvg = document.createElementNS(ns, 'svg');
        arcSvg.setAttribute('class', 'stv-arc');
        arcSvg.setAttribute('viewBox', '0 0 100 100');

        // Track nền (vòng mờ)
        var track = document.createElementNS(ns, 'circle');
        track.setAttribute('cx', '50');
        track.setAttribute('cy', '50');
        track.setAttribute('r', '' + ARC_R);
        track.setAttribute('fill', 'none');
        track.setAttribute('stroke', 'rgba(255,255,255,0.15)');
        track.setAttribute('stroke-width', '3.5');
        arcSvg.appendChild(track);

        // Progress arc (vòng sáng)
        arcProg = document.createElementNS(ns, 'circle');
        arcProg.id = 'stv-prog';
        arcProg.setAttribute('cx', '50');
        arcProg.setAttribute('cy', '50');
        arcProg.setAttribute('r', '' + ARC_R);
        arcProg.setAttribute('fill', 'none');
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
     *  6. XỬ LÝ CLICK NÚT
     *     Đang phát → pause | Đang pause → resume | Chưa init → readBook()
     *     Khi lần đầu bấm: đặt cờ resumeRequested để poll/scheduleResume
     *     tự nhảy đến câu đã lưu trong bookmark.
     * ───────────────────────────────────────────────────────────── */
    var resumeRequested = false;

    function handleClick() {
        var p = getPlayer();

        // Đang phát → pause
        if (p && p.isPlaying) { p.stop(); return; }

        // Đang pause, có câu → resume
        if (p && p.tokenizedSentences && p.tokenizedSentences.length > 0) {
            p.resume();
            return;
        }

        // Chưa khởi tạo → gọi hệ thống gốc + đặt cờ resume
        if (window.speaker && typeof window.speaker.readBook === 'function') {
            resumeRequested = true;
            window.speaker.readBook();
            setTimeout(tryHook, 500);
            // Vòng lặp nhanh (~100ms) để resume sớm nhất có thể
            scheduleResume(50);
        }
    }

    /**
     * Chờ player bắt đầu phát rồi nhảy đến vị trí bookmark.
     * Thử tối đa `retries` lần, mỗi 100ms (~5s tổng).
     */
    function scheduleResume(retries) {
        if (!resumeRequested || retries <= 0) { resumeRequested = false; return; }
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
        setTimeout(function () { scheduleResume(retries - 1); }, 100);
    }

    function getPlayer() {
        return (window.ttsUI && window.ttsUI.player) ? window.ttsUI.player : null;
    }

    /* ─────────────────────────────────────────────────────────────
     *  7. POLLING TRẠNG THÁI
     *     400ms interval – đồng bộ UI, timer, bookmark, preload, arc.
     *     Dùng polling vì player.reset() trong applyConfig()
     *     xóa sạch events = {} → listener bên ngoài bị mất.
     * ───────────────────────────────────────────────────────────── */
    var wasOn       = false;
    var prevCid     = null;
    var chapLoading = false;
    var ldTimer     = null;
    var bmTick      = 0;

    function poll() {
        var p        = getPlayer();
        var on       = !!(p && p.isPlaying);
        var hasSent  = p && p.tokenizedSentences && p.tokenizedSentences.length > 0;
        var total    = hasSent ? p.tokenizedSentences.length : 0;
        var cur      = hasSent ? p.currentSentenceIndex : 0;
        var progress = total > 0 ? cur / total : 0;

        /* ── CSS classes trên nút ── */
        if (btn) {
            btn.classList.toggle('stv-on', on);
            btn.classList.toggle('stv-ld', chapLoading && !on);

            var ico = btn.querySelector('i.fas');
            if (ico) {
                var cls = chapLoading ? 'fa-spinner'
                        : on         ? 'fa-pause'
                        : hasSent    ? 'fa-play'
                        :              'fa-headphones';
                if (!ico.classList.contains(cls)) ico.className = 'fas ' + cls;
            }
        }

        /* ── Timer start/pause ── */
        if (on && !wasOn) Timer.start();
        if (!on && wasOn) {
            Timer.pause();
            // Lưu bookmark ngay khi dừng (đề phòng người dùng tắt trang)
            if (p && cur > 0) {
                Bookmark.save(window.abookid || '', getChapId(), cur);
            }
        }
        wasOn = on;

        /* ── Phát hiện chuyển chương ── */
        var cid = getChapId();
        if (cid && cid !== prevCid) {
            if (prevCid !== null) {
                Timer.resetChapter();
                Preloader.reset();
            }
            prevCid = cid;
        }

        /* ── Bookmark save định kỳ (~2s khi đang phát) ── */
        if (on) {
            bmTick++;
            if (bmTick >= BM_EVERY) {
                bmTick = 0;
                if (cur > 0) Bookmark.save(window.abookid || '', getChapId(), cur);
            }
        } else {
            bmTick = 0;
        }

        /* ── Preload chương tiếp khi đạt ngưỡng ── */
        if (on) Preloader.check(progress);

        /* ── SVG Progress arc ── */
        if (arcSvg) arcSvg.classList.toggle('stv-vis', hasSent && (on || progress > 0));
        if (arcProg) {
            var offset = ARC_C * (1 - progress);
            arcProg.setAttribute('stroke-dashoffset', offset.toFixed(2));
        }

        /* ── Timer display & tooltip ── */
        if (tmrEl) tmrEl.textContent = Timer.fmt(Timer.chapter);
        if (tipEl) {
            if (Timer._on) {
                var pct = total > 0 ? Math.round(progress * 100) : 0;
                tipEl.textContent = 'Ch\u01B0\u01A1ng ' + Timer.fmt(Timer.chapter)
                    + '  \u00B7  T\u1ED5ng ' + Timer.fmt(Timer.total)
                    + (total > 0 ? '  \u00B7  ' + pct + '%' : '');
            } else if (chapLoading) {
                tipEl.textContent = '\u0110ang t\u1EA3i ch\u01B0\u01A1ng ti\u1EBFp...';
            } else if (hasSent) {
                tipEl.textContent = 'Ti\u1EBFp t\u1EE5c nghe';
            } else {
                tipEl.textContent = 'Nghe s\u00E1ch';
            }
        }

        /* ── Auto hook nếu ttsUI vừa xuất hiện ── */
        if (window.ttsUI && !window.ttsUI.__stv) tryHook();
    }

    function getChapId() {
        if (window.abookchapter) return '' + window.abookchapter;
        try {
            var cc = window.contentcontainer || 'maincontent';
            var el = document.getElementById(cc);
            return el ? (el.getAttribute('cid') || el.id) : '';
        } catch (e) { return ''; }
    }

    /* ─────────────────────────────────────────────────────────────
     *  8. HOOK VÀO HỆ THỐNG TTS GỐC
     *     Monkey-patch ttsUI.onContentLoaded + ttsUI.applyConfig
     *
     *     onContentLoaded: page gọi sau swiftload → ta reset state
     *     applyConfig: gốc gọi player.reset() rồi đăng ký events
     *       → ta thêm FINISH listener SAU reset (để sống sót)
     * ───────────────────────────────────────────────────────────── */

    function onPlayerFinish() {
        // Xóa bookmark chương vừa đọc xong (đã hoàn thành tự nhiên)
        var bid = window.abookid || '';
        var cid = getChapId();
        if (bid && cid) Bookmark.clear(bid, cid);

        // Bật trạng thái loading trên nút
        chapLoading = true;
        if (ldTimer) clearTimeout(ldTimer);
        // Safety: tắt loading sau 30s nếu chương kế không load được
        ldTimer = setTimeout(function () { chapLoading = false; }, 30000);
    }

    function tryHook() {
        var t = window.ttsUI;
        if (!t || t.__stv) return;

        /* Patch onContentLoaded */
        var _ocl = t.onContentLoaded;
        t.onContentLoaded = function () {
            if (typeof _ocl === 'function') _ocl.apply(t, arguments);

            // Reset state sau khi chương mới sẵn sàng
            chapLoading = false;
            if (ldTimer) { clearTimeout(ldTimer); ldTimer = null; }
            Timer.resetChapter();
            Preloader.reset();
        };

        /* Patch applyConfig */
        var _ac = t.applyConfig;
        if (typeof _ac === 'function') {
            t.applyConfig = function () {
                // Gốc: player.reset() → đăng ký events (FINISH → swiftload)
                _ac.apply(t, arguments);

                // Thêm FINISH listener SAU reset → sống sót
                try { t.player.on('finish', onPlayerFinish); } catch (e) {}
            };
        }

        t.__stv = true;

        // Hook player hiện tại (chapter đầu tiên)
        try {
            if (t.player && t.player.on) t.player.on('finish', onPlayerFinish);
        } catch (e) {}
    }

    /* ─────────────────────────────────────────────────────────────
     *  9. UNHIDE NÚT GỐC TRONG configBox
     *     Trang ẩn nút "Nghe sách" cho nguồn Faloo/dịch/sáng tác.
     *     Ta hiện lại nó.
     * ───────────────────────────────────────────────────────────── */
    function unhideOrigBtn() {
        try {
            var b = document.querySelector('#configBox .bg-dark button[onclick="speaker.readBook()"]');
            if (b) b.style.display = '';
        } catch (e) {}
    }

    /* ─────────────────────────────────────────────────────────────
     *  10. KHỞI TẠO & THEO DÕI SPA
     *      Chỉ chạy trên trang đọc chương (có #hiddenid).
     *      MutationObserver + interval fallback cho swiftload.
     * ───────────────────────────────────────────────────────────── */
    var booted = false;

    function init() {
        var isReader = !!document.getElementById('hiddenid');
        if (!isReader) {
            var existing = document.getElementById('stv-tts-btn');
            if (existing) existing.style.display = 'none';
            return;
        }

        var existingBtn = document.getElementById('stv-tts-btn');
        if (existingBtn) existingBtn.style.display = '';

        if (!booted) {
            booted = true;
            Timer.load(window.abookid || '');
            injectCSS();
            ensureBtn();
            unhideOrigBtn();
            setInterval(poll, POLL_MS);
            if (window.ttsUI) tryHook();
        } else {
            if (!document.getElementById('stv-tts-btn')) ensureBtn();
            unhideOrigBtn();
            if (window.ttsUI && !window.ttsUI.__stv) tryHook();
        }
    }

    var _debounce = null;
    function debouncedInit() {
        if (_debounce) return;
        _debounce = setTimeout(function () { _debounce = null; init(); }, 200);
    }

    function boot() {
        init();
        setInterval(init, 3000);
        if (window.MutationObserver) {
            new MutationObserver(debouncedInit).observe(document.body, { childList: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();

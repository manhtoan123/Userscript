// ==UserScript==
// @name         Uploader - Tách 1 File TXT Dài Thành Nhiều Chương
// @namespace    http://tampermonkey.net/
// @version      29.0
// @description  v29.0: ETA thời gian hoàn thành, Worker Timer chống tab ẩn, chọn chương trước upload. v28.5: Lọc thông báo hệ thống.
// @author       Bạn & AI Helper
// @match        *://*/uploader/list-chapter/*
// @match        *://*/uploader/add-chapter/*
// @grant        unsafeWindow
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // --- CẤU HÌNH ---
    const MIN_WAIT_TIME = 100, MAX_WAIT_TIME = 170, MAX_RETRIES_PER_FILE = 3, REQUEST_TIMEOUT = 5000;
    const MAX_LINES = 400;

    // REGEX CHƯƠNG
    const regexChuong = /^\s*((?:【(?=[^】]*[0-9])(?!\d+[\.\u3001\uff0e])[^】]{1,30}】|《(?=[^》]*[0-9])[^》]{1,30}》|[\uff08(]\s*[0-9]+\s*[)\uff09])(?:\uff08[0-9]+\uff09|\([0-9]+\))?|(?:第[0-9零一二两三四五六七八九十百千万ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ\.\-]+(?:[章节回卷篇部集季幕话期层关]|系列|部分|外传)|序章|序幕|序篇|序曲|序言|前言|引子|引言|楔子|终章|终幕|终篇|终卷|终结|完结|大结局|番外|尾声|后记|附录|间章|插曲|[上中下][篇卷部])(?:[\s·\-\u2014:：]*(?:【[^】]{1,30}】|《[^》]{1,30}》|\[[^\]]{1,30}\]|[\uff08(][^)\uff09]{1,30}[)\uff09])|[\s·\-\u2014:：]+\S.*)?|第[0-9零一二两三四五六七八九十百千万\.\-]+[夜天]\s*$|章\s*[0-9零一二两三四五六七八九十百千万\.\-]+|#\s*[0-9]+|#?\s*[0-9]+[\.\-:]?\s*$|#?\s*[0-9]+[\.\-:]?\s+(?![\u4e00-\u9fa5月天年日周时秒分前后号点层楼])|[\u4e00-\u9fa5\w\s\-]{1,15}篇(?![\u4e00-\u9fa5])|[iI][fF]\s*[\u4e00-\u9fa5][\u4e00-\u9fa5\w\s\-]{0,14}(?![\u4e00-\u9fa5\w]))/u;

    GM_addStyle(`
        #main-uploader-log-panel { font-size: 13px; font-family: monospace; background-color: #1a1d21; color: #ced4da; padding: 8px; margin-top: 10px; border-radius: 4px; white-space: pre-wrap; max-height: 250px; overflow-y: auto; border: 1px solid #444; display: none; }
        .log-success { color: #28a745; font-weight: bold; } .log-error { color: #dc3545; font-weight: bold; }
        .log-info { color: #17a2b8; } .log-warn { color: #ffc107; } .log-title { color: #00bcd4; }
        .control-container { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
        .button-group { display: flex; justify-content: center; gap: 10px; align-items: center; flex-wrap: wrap; }
        #chapter-preview-panel { font-size: 13px; font-family: monospace; background-color: #1e2228; color: #ced4da; padding: 0; margin-top: 8px; border-radius: 4px; max-height: 400px; overflow-y: auto; border: 1px solid #555; display: none; }
        #chapter-preview-panel table { width: 100%; border-collapse: collapse; }
        #chapter-preview-panel th { background: #2a2f36; color: #17a2b8; padding: 6px 8px; text-align: left; position: sticky; top: 0; z-index: 1; border-bottom: 2px solid #444; }
        #chapter-preview-panel td { padding: 4px 8px; border-bottom: 1px solid #333; }
        #chapter-preview-panel tr:hover td { background: #2a3040; }
        #chapter-preview-panel tr.row-unchecked td { opacity: 0.4; text-decoration: line-through; }
        .preview-new { color: #28a745; }
        .encoding-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; margin-left: 6px; }
        .badge-utf8 { background: #17a2b8; color: #fff; }
        .badge-gbk { background: #ffc107; color: #000; }
        .preview-btn { background: #6c5ce7 !important; }
        .preview-btn:hover { background: #5a4bd1 !important; }
        .select-btn { background: #00b894 !important; font-size: 12px !important; padding: 4px 10px !important; }
        .select-btn:hover { background: #00a381 !important; }
        #eta-panel { font-size: 14px; font-family: monospace; background: linear-gradient(135deg, #1a1d21, #2a2f36); color: #ffc107; padding: 10px 14px; margin-top: 8px; border-radius: 6px; border: 1px solid #ffc107; display: none; text-align: center; }
        #eta-panel .eta-label { color: #ced4da; font-size: 12px; }
        #eta-panel .eta-value { font-size: 18px; font-weight: bold; }
        #eta-panel .eta-progress { background: #333; border-radius: 4px; height: 8px; margin-top: 6px; overflow: hidden; }
        #eta-panel .eta-bar { background: linear-gradient(90deg, #28a745, #00b894); height: 100%; border-radius: 4px; transition: width 0.3s ease; }
        .chapter-checkbox { width: 16px; height: 16px; cursor: pointer; accent-color: #28a745; }
        .header-checkbox { width: 16px; height: 16px; cursor: pointer; accent-color: #17a2b8; }
    `);

    // --- WORKER TIMER: Không bị throttle khi tab ẩn ---
    const workerBlob = new Blob([`
        self.onmessage = function(e) {
            if (e.data.type === 'setTimeout') {
                setTimeout(function() { self.postMessage({ id: e.data.id }); }, e.data.delay);
            }
        };
    `], { type: 'application/javascript' });

    const timerWorker = new Worker(URL.createObjectURL(workerBlob));
    let timerCallbacks = {};
    let timerIdCounter = 0;

    timerWorker.onmessage = function(e) {
        const cb = timerCallbacks[e.data.id];
        if (cb) {
            cb();
            delete timerCallbacks[e.data.id];
        }
    };

    function workerTimeout(delay) {
        return new Promise(resolve => {
            const id = ++timerIdCounter;
            timerCallbacks[id] = resolve;
            timerWorker.postMessage({ type: 'setTimeout', id, delay });
        });
    }

    // --- BIẾN TOÀN CỤC ---
    const pageAPI = unsafeWindow;
    let allExtractedFiles = [];
    let selectedIndices = new Set();
    let pendingFilesQueue = [];
    let isProcessing = false;

    // --- ETA TRACKING ---
    let etaStartTime = 0;
    let etaTotalChapters = 0;
    let etaCompletedChapters = 0;

    // --- CÁC HÀM TIỆN ÍCH ---
    const translateTextPromise = (text) => new Promise((resolve, reject) => {
        if (!pageAPI.ajax) return reject(new Error("Hàm 'ajax' không tồn tại."));
        pageAPI.ajax(`sajax=trans&content=${encodeURIComponent(text)}`, (res) => resolve(res.trim()));
    });
    const getRandomWaitTime = () => Math.random() * (MAX_WAIT_TIME - MIN_WAIT_TIME) + MIN_WAIT_TIME;
    const getChapterId = (fileName) => fileName.replace(/(_part\d+)?\.txt$/i, '').trim();

    function readFileAs(file, encoding) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => resolve('');
            reader.readAsText(file, encoding);
        });
    }

    function createVirtualFile(chapterTitle, content, partCount) {
        let safeTitle = chapterTitle.replace(/[\\/:*?"<>|]/g, '').trim();
        if (!safeTitle) safeTitle = "Chương không tên";
        let finalName = partCount ? `${safeTitle}_part${partCount}.txt` : `${safeTitle}.txt`;
        return new File([content], finalName, { type: 'text/plain' });
    }

    const regexSoThuanTuy = /^#?\s*[0-9]+[\.\-:]?\s*$/;

    // --- BỘ LỌC DÒNG KHÔNG PHẢI CHƯƠNG (v28.5 + v29.0) ---
    const isSkipAsChapter = (line) => {
        if (/^作者[\uff1a:]/.test(line)) return true;
        if (/^--/.test(line)) return true;
        if (/^\[(?:uploadedimage|sxsy)/i.test(line)) return true;
        if (/^【\d+[\.\u3001\uff0e\s]/.test(line)) return true;
        if (/^【[^】]{0,12}[\uff1a:][^】]*】$/.test(line) && !/[第章节回卷篇]/.test(line)) return true;
        if (/^\[本帖/.test(line)) return true;
        if (/^\[当前时间/.test(line)) return true;
        if (/\d{6,}\s*$/.test(line)) return true;
        if (/^【[^】]*(?:已到账|已获得|已领取|已解锁|已完成|已激活|已触发|系统|奖励|恭喜|提示|提醒|警告|通知|任务|成就|技能|属性|好感|孝心|积分|金币|银币|经验|体力|魅力|智力|声望|贡献|点数|升级|降级|扣除|增加|减少|获取|消耗|充值|签到|打卡|抽奖|宝箱|道具|装备|buff|debuff)[^】]*】\s*$/.test(line)) return true;
        if (/^【[^】]*\d+\s*(?:点|个|次|元|级|层|份|张|把|颗|块|瓶|条|枚|株|只|头|匹|件|套|组|包|箱|滴|两|斤|克|倍|成|分)[^】]*】\s*$/.test(line)) return true;
        return false;
    };

    // --- THUẬT TOÁN CẮT TEXT THÀNH CÁC FILE CHƯƠNG ---
    function splitTextToVirtualFiles(text, originalFileName) {
        let lines = text.split(/\r?\n/);
        let extractedVirtualFiles = [];

        let currentChapterTitle = originalFileName.replace(/\.txt$/i, '').trim();
        let currentLines = [];
        let lineCount = 0;
        let partCount = 1;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let cleanLine = line.trim();
            const prevCleanLine = i > 0 ? lines[i - 1].trim() : '';

            const isBareNumber = regexSoThuanTuy.test(cleanLine);
            const isMainChapter = /第[0-9零一二两三四五六七八九十百千万.\-]+[章节回卷话]/.test(cleanLine);
            const maxTitleLen = isMainChapter ? 80 : 40;
            const isChapterLine =
                regexChuong.test(cleanLine) &&
                cleanLine.length > 0 &&
                cleanLine.length <= maxTitleLen &&
                (!isBareNumber || prevCleanLine === '') &&
                !isSkipAsChapter(cleanLine);

            if (isChapterLine) {
                if (currentLines.length > 0 && currentLines.join('').trim() !== '') {
                    extractedVirtualFiles.push(
                        createVirtualFile(currentChapterTitle, currentLines.join('\n'), partCount > 1 ? partCount : null)
                    );
                }
                currentChapterTitle = cleanLine;
                currentLines = [line];
                lineCount = 1;
                partCount = 1;
            } else {
                currentLines.push(line);
                lineCount++;
                if (lineCount >= MAX_LINES) {
                    extractedVirtualFiles.push(
                        createVirtualFile(currentChapterTitle, currentLines.join('\n'), partCount)
                    );
                    currentLines = [];
                    lineCount = 0;
                    partCount++;
                }
            }
        }

        if (currentLines.length > 0 && currentLines.join('').trim() !== '') {
            extractedVirtualFiles.push(
                createVirtualFile(currentChapterTitle, currentLines.join('\n'), partCount > 1 ? partCount : null)
            );
        }
        return extractedVirtualFiles;
    }

    async function splitLargeFileToChapters(largeFile, log_func) {
        log_func(`Đang đọc file: "${largeFile.name}"...`, 'warn');

        const [textUtf8, textGbk] = await Promise.all([
            readFileAs(largeFile, 'utf-8'),
            readFileAs(largeFile, 'gb18030')
        ]);

        log_func(`Đang thử cắt chương với cả UTF-8 và GBK...`, 'info');

        const chaptersUtf8 = splitTextToVirtualFiles(textUtf8, largeFile.name);
        const chaptersGbk  = splitTextToVirtualFiles(textGbk,  largeFile.name);

        let chosen, chosenLabel;
        if (chaptersGbk.length > chaptersUtf8.length) {
            chosen = chaptersGbk;
            chosenLabel = 'GBK';
        } else {
            chosen = chaptersUtf8;
            chosenLabel = 'UTF-8';
        }

        log_func(`  UTF-8: ${chaptersUtf8.length} chương | GBK: ${chaptersGbk.length} chương → Chọn <span class="encoding-badge badge-${chosenLabel === 'GBK' ? 'gbk' : 'utf8'}">${chosenLabel}</span>`, 'info');
        log_func(`✅ Đã cắt xong! Thu được ${chosen.length} chương (${chosenLabel}).`, 'log-success');
        return chosen;
    }

    // --- ETA: Tính & hiển thị thời gian ---
    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '--:--';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
        if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
        return `${s}s`;
    }

    function updateETA(etaPanel) {
        if (etaTotalChapters === 0) return;
        const elapsed = (Date.now() - etaStartTime) / 1000;
        const percent = (etaCompletedChapters / etaTotalChapters) * 100;
        const avgPerChapter = etaCompletedChapters > 0 ? elapsed / etaCompletedChapters : 0;
        const remaining = avgPerChapter * (etaTotalChapters - etaCompletedChapters);

        etaPanel.style.display = 'block';
        etaPanel.innerHTML = `
            <div class="eta-label">⏱️ Tiến độ Upload</div>
            <div class="eta-value">${etaCompletedChapters} / ${etaTotalChapters} chương (${percent.toFixed(1)}%)</div>
            <div style="margin-top:4px; font-size:12px; color:#ced4da;">
                ⏳ Đã chạy: <b>${formatTime(elapsed)}</b> &nbsp;|&nbsp;
                ⏰ Còn lại: <b style="color:#28a745">${formatTime(remaining)}</b> &nbsp;|&nbsp;
                ⚡ Tốc độ: <b>${avgPerChapter.toFixed(1)}s/chương</b>
            </div>
            <div class="eta-progress"><div class="eta-bar" style="width:${percent}%"></div></div>
        `;
    }

    // --- UPLOAD 1 CHƯƠNG ---
    async function primaryUpload(file, log) {
        const chapterContent = await file.text();
        let titleForApi = file.name.replace(/\.txt$/i, '').trim();

        let translatedTitle;
        try { translatedTitle = await translateTextPromise(titleForApi); }
        catch (e) { translatedTitle = titleForApi; }

        log(` -> Tên xử lý: "${translatedTitle}"`, 'log-title');

        let attempts = 0;
        while (attempts < MAX_RETRIES_PER_FILE) {
            const numInput = pageAPI.g("ip-num");
            if (!numInput) throw new Error("Không tìm thấy ô điền số chương.");
            const currentChap = numInput.value;

            try {
                const createPromise = new Promise((resolve, reject) => pageAPI.ajax(`ajax=bookmanager&action=createchap&ctx=${currentChap}&pctx=${pageAPI.contextParent}`, d => (d === "data broken" || !/^\d+$/.test(d)) ? reject(new Error(`Server từ chối`)) : resolve(parseInt(d))));
                const timeoutCreate = workerTimeout(REQUEST_TIMEOUT).then(() => { throw new Error('Hết giờ tạo'); });
                const chapterId = await Promise.race([createPromise, timeoutCreate]);

                const payload = [{ uname: "name", name: translatedTitle, ctx: chapterId }, { uname: "content", content: chapterContent.replace(/</g, ""), ctx: chapterId }];
                const savePromise = new Promise((resolve, reject) => pageAPI.postSaves(payload, (res) => res === "" ? resolve() : reject(new Error(res || "Lỗi khi lưu"))));
                const timeoutSave = workerTimeout(REQUEST_TIMEOUT).then(() => { throw new Error('Hết giờ lưu'); });
                await Promise.race([savePromise, timeoutSave]);

                numInput.value = parseInt(currentChap) + 1;
                return true;
            } catch (error) {
                log(` -> Lỗi tại chương ${currentChap}: ${error.message} (Thử lại...)`, 'error');
                attempts++;
                numInput.value = parseInt(currentChap) + 1;
            }
        }
        return false;
    }

    // --- XỬ LÝ HÀNG ĐỢI UPLOAD ---
    async function processQueue(log, etaPanel) {
        if (isProcessing || pendingFilesQueue.length === 0) return;

        isProcessing = true;
        const resumeBtn = document.getElementById('resume-button');
        resumeBtn.disabled = true; resumeBtn.textContent = 'Đang Upload...';

        etaStartTime = Date.now();
        etaTotalChapters = pendingFilesQueue.length;
        etaCompletedChapters = 0;
        updateETA(etaPanel);

        while (pendingFilesQueue.length > 0) {
            const file = pendingFilesQueue.shift();
            try {
                log(`[Còn ${pendingFilesQueue.length + 1}] Đang Upload: ${file.name}`, 'info');
                const success = await primaryUpload(file, log);

                etaCompletedChapters++;
                updateETA(etaPanel);

                if (success) {
                    log(` -> HOÀN TẤT!`, 'log-success');
                } else {
                    log(` -> Thất bại hoàn toàn với: ${file.name}`, 'error');
                }
            } catch (err) {
                etaCompletedChapters++;
                updateETA(etaPanel);
                log(`!!!!!!!! LỖI: ${err.message}`, 'error');
            }

            if (pendingFilesQueue.length > 0) {
                const waitTime = getRandomWaitTime();
                await workerTimeout(waitTime);
            }
        }

        // Hiển thị tổng kết
        const totalTime = (Date.now() - etaStartTime) / 1000;
        log(`--- TOÀN BỘ HOÀN TẤT trong ${formatTime(totalTime)} ---`, 'log-success');
        etaPanel.innerHTML = `
            <div class="eta-label">✅ Hoàn tất!</div>
            <div class="eta-value">${etaTotalChapters} chương trong ${formatTime(totalTime)}</div>
            <div style="margin-top:4px; font-size:12px; color:#28a745;">
                ⚡ Trung bình: ${(totalTime / etaTotalChapters).toFixed(1)}s/chương
            </div>
            <div class="eta-progress"><div class="eta-bar" style="width:100%"></div></div>
        `;
        resumeBtn.style.display = 'none';
        isProcessing = false;
    }

    // --- BẢNG XEM TRƯỚC VỚI CHECKBOX ---
    function buildPreviewTable(files) {
        let html = `<table><thead><tr>
            <th><input type="checkbox" class="header-checkbox" id="select-all-chap" checked title="Chọn/bỏ tất cả"></th>
            <th>#</th><th>Tên chương</th><th>Kích cỡ</th>
        </tr></thead><tbody>`;
        files.forEach((f, idx) => {
            const sizeKB = (f.size / 1024).toFixed(1);
            const name = f.name.replace(/\.txt$/i, '');
            const checked = selectedIndices.has(idx) ? 'checked' : '';
            const rowClass = selectedIndices.has(idx) ? 'preview-new' : 'preview-new row-unchecked';
            html += `<tr class="${rowClass}" data-idx="${idx}">
                <td><input type="checkbox" class="chapter-checkbox" data-idx="${idx}" ${checked}></td>
                <td>${idx + 1}</td>
                <td>${name.replace(/</g, '&lt;')}</td>
                <td>${sizeKB} KB</td>
            </tr>`;
        });
        html += '</tbody></table>';
        return html;
    }

    function getSelectedCount() {
        return selectedIndices.size;
    }

    function updateButtonCounts() {
        const previewBtn = document.getElementById('preview-button');
        const resumeBtn = document.getElementById('resume-button');
        const count = getSelectedCount();
        if (previewBtn && previewBtn.style.display !== 'none') {
            const isVisible = document.getElementById('chapter-preview-panel').style.display === 'block';
            previewBtn.textContent = isVisible ? '🔽 Ẩn danh sách chương' : `👁 Xem trước chương (${count}/${allExtractedFiles.length})`;
        }
        if (resumeBtn && resumeBtn.style.display !== 'none' && !isProcessing) {
            resumeBtn.textContent = `Bắt đầu Upload (${count} chương)`;
            resumeBtn.disabled = count === 0;
        }
    }

    function attachCheckboxEvents(previewPanel) {
        // Checkbox từng chương
        previewPanel.querySelectorAll('.chapter-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const idx = parseInt(e.target.dataset.idx);
                const row = previewPanel.querySelector(`tr[data-idx="${idx}"]`);
                if (e.target.checked) {
                    selectedIndices.add(idx);
                    row.classList.remove('row-unchecked');
                } else {
                    selectedIndices.delete(idx);
                    row.classList.add('row-unchecked');
                }
                // Cập nhật header checkbox
                const allCb = previewPanel.querySelectorAll('.chapter-checkbox');
                const headerCb = document.getElementById('select-all-chap');
                const allChecked = [...allCb].every(c => c.checked);
                const someChecked = [...allCb].some(c => c.checked);
                headerCb.checked = allChecked;
                headerCb.indeterminate = !allChecked && someChecked;
                updateButtonCounts();
            });
        });

        // Checkbox chọn tất cả
        const headerCb = document.getElementById('select-all-chap');
        if (headerCb) {
            headerCb.addEventListener('change', (e) => {
                const allCb = previewPanel.querySelectorAll('.chapter-checkbox');
                allCb.forEach(cb => {
                    cb.checked = e.target.checked;
                    const idx = parseInt(cb.dataset.idx);
                    const row = previewPanel.querySelector(`tr[data-idx="${idx}"]`);
                    if (e.target.checked) {
                        selectedIndices.add(idx);
                        row.classList.remove('row-unchecked');
                    } else {
                        selectedIndices.delete(idx);
                        row.classList.add('row-unchecked');
                    }
                });
                headerCb.indeterminate = false;
                updateButtonCounts();
            });
        }
    }

    // --- NHANH CHỌN THEO RANGE ---
    function addQuickSelectButtons(controlContainer, previewPanel) {
        const existing = document.getElementById('quick-select-group');
        if (existing) existing.remove();

        const group = document.createElement('div');
        group.id = 'quick-select-group';
        group.className = 'button-group';
        group.style.fontSize = '12px';

        // Nút chọn range
        const rangeLabel = document.createElement('span');
        rangeLabel.textContent = 'Chọn từ:';
        rangeLabel.style.color = '#ced4da';
        const fromInput = document.createElement('input');
        fromInput.type = 'number'; fromInput.min = 1; fromInput.value = 1;
        fromInput.style.cssText = 'width:60px; padding:3px 6px; border-radius:3px; border:1px solid #555; background:#2a2f36; color:#fff; text-align:center;';
        const toLabel = document.createElement('span');
        toLabel.textContent = 'đến:';
        toLabel.style.color = '#ced4da';
        const toInput = document.createElement('input');
        toInput.type = 'number'; toInput.min = 1; toInput.value = allExtractedFiles.length;
        toInput.style.cssText = 'width:60px; padding:3px 6px; border-radius:3px; border:1px solid #555; background:#2a2f36; color:#fff; text-align:center;';

        const applyBtn = document.createElement('button');
        applyBtn.textContent = '✅ Áp dụng';
        applyBtn.className = 'primary select-btn';
        applyBtn.onclick = () => {
            const from = Math.max(1, parseInt(fromInput.value) || 1) - 1;
            const to = Math.min(allExtractedFiles.length, parseInt(toInput.value) || allExtractedFiles.length) - 1;

            // Bỏ chọn tất cả trước
            selectedIndices.clear();
            // Chọn range
            for (let i = from; i <= to; i++) {
                selectedIndices.add(i);
            }
            // Cập nhật UI
            previewPanel.innerHTML = buildPreviewTable(allExtractedFiles);
            attachCheckboxEvents(previewPanel);
            updateButtonCounts();
        };

        const invertBtn = document.createElement('button');
        invertBtn.textContent = '🔄 Đảo chọn';
        invertBtn.className = 'primary select-btn';
        invertBtn.onclick = () => {
            for (let i = 0; i < allExtractedFiles.length; i++) {
                if (selectedIndices.has(i)) selectedIndices.delete(i);
                else selectedIndices.add(i);
            }
            previewPanel.innerHTML = buildPreviewTable(allExtractedFiles);
            attachCheckboxEvents(previewPanel);
            updateButtonCounts();
        };

        group.append(rangeLabel, fromInput, toLabel, toInput, applyBtn, invertBtn);
        controlContainer.insertBefore(group, controlContainer.lastElementChild);
    }

    // --- SETUP GIAO DIỆN ---
    function setupUploaderInterface(originalButton) {
        if (originalButton.dataset.enhanced) return;
        originalButton.dataset.enhanced = 'true';

        const parentContainer = originalButton.parentNode;
        const logPanel = document.createElement('div'); logPanel.id = 'main-uploader-log-panel';
        const etaPanel = document.createElement('div'); etaPanel.id = 'eta-panel';
        const controlContainer = document.createElement('div'); controlContainer.className = 'control-container';

        const fileBtns = document.createElement('div'); fileBtns.className = 'button-group';
        const multiFileBtn = document.createElement('button');
        multiFileBtn.textContent = '📂 Chọn File TXT'; multiFileBtn.className = 'primary';
        fileBtns.append(multiFileBtn);

        const previewBtn = document.createElement('button'); previewBtn.textContent = '👁 Xem trước chương'; previewBtn.id = 'preview-button'; previewBtn.className = 'primary preview-btn'; previewBtn.style.display = 'none';
        const resumeBtn = document.createElement('button'); resumeBtn.textContent = 'Bắt đầu Upload'; resumeBtn.id = 'resume-button'; resumeBtn.className = 'primary'; resumeBtn.style.display = 'none';

        const actionGroup = document.createElement('div'); actionGroup.className = 'button-group';
        actionGroup.append(previewBtn, resumeBtn);

        const previewPanel = document.createElement('div'); previewPanel.id = 'chapter-preview-panel';

        controlContainer.append(fileBtns, actionGroup);
        parentContainer.parentElement.append(logPanel, etaPanel, previewPanel, controlContainer);
        originalButton.style.display = 'none';

        const log_func = (msg, type) => {
            logPanel.innerHTML += `<div class="log-entry${type ? ` log-${type}` : ''}">${msg}</div>`;
            logPanel.scrollTop = logPanel.scrollHeight;
        };

        resumeBtn.onclick = () => {
            // Chỉ upload các chương được chọn
            pendingFilesQueue = allExtractedFiles.filter((_, idx) => selectedIndices.has(idx));
            if (pendingFilesQueue.length === 0) {
                alert('Chưa chọn chương nào!');
                return;
            }
            log_func(`🚀 Bắt đầu upload ${pendingFilesQueue.length} chương đã chọn...`, 'success');
            processQueue(log_func, etaPanel);
        };

        previewBtn.onclick = () => {
            const isVisible = previewPanel.style.display === 'block';
            previewPanel.style.display = isVisible ? 'none' : 'block';
            previewBtn.textContent = isVisible
                ? `👁 Xem trước chương (${getSelectedCount()}/${allExtractedFiles.length})`
                : '🔽 Ẩn danh sách chương';

            // Hiện/ẩn quick select buttons
            const quickGroup = document.getElementById('quick-select-group');
            if (quickGroup) quickGroup.style.display = isVisible ? 'none' : 'flex';
        };

        const handleFileSelection = async (files) => {
            if (isProcessing) return alert('Đang chạy, vui lòng chờ.');
            logPanel.style.display = 'block'; logPanel.innerHTML = '';
            previewPanel.style.display = 'none'; previewPanel.innerHTML = '';
            etaPanel.style.display = 'none';

            const sortedFiles = Array.from(files).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            log_func(`📂 ${sortedFiles.length} file được chọn (sắp xếp theo tên)`, 'info');

            allExtractedFiles = [];
            for (let i = 0; i < sortedFiles.length; i++) {
                const f = sortedFiles[i];
                log_func(` [${i + 1}/${sortedFiles.length}] Đang xử lý: "${f.name}"`, 'info');
                const parts = await splitLargeFileToChapters(f, log_func);
                allExtractedFiles.push(...parts);
            }
            log_func(`✅ Tổng cộng ${allExtractedFiles.length} chương từ ${sortedFiles.length} file.`, 'log-success');

            // Mặc định chọn tất cả
            selectedIndices = new Set(allExtractedFiles.map((_, i) => i));

            previewPanel.innerHTML = buildPreviewTable(allExtractedFiles);
            attachCheckboxEvents(previewPanel);
            addQuickSelectButtons(controlContainer, previewPanel);

            previewBtn.textContent = `👁 Xem trước chương (${allExtractedFiles.length}/${allExtractedFiles.length})`;
            previewBtn.style.display = 'inline-block';

            log_func(`Sẵn sàng Upload. Mở xem trước để chọn/bỏ chương, rồi nhấn "Bắt đầu Upload".`, 'success');
            resumeBtn.textContent = `Bắt đầu Upload (${allExtractedFiles.length} chương)`;
            resumeBtn.style.display = 'block'; resumeBtn.disabled = false;
        };

        multiFileBtn.onclick = () => {
            const i = document.createElement('input');
            i.type = 'file'; i.accept = '.txt'; i.multiple = true;
            i.onchange = e => { if (e.target.files.length > 0) handleFileSelection(e.target.files); };
            i.click();
        };
    }

    const observer = new MutationObserver(() => {
        const btn = document.querySelector('#wdaddtxt button[onclick="loadTxtFile()"]');
        if (btn) { setupUploaderInterface(btn); observer.disconnect(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();
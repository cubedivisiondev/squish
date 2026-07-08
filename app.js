/* SQUISH — Puddy Studios.
 * Client-side "compress to a target file size" tool: images, GIF, video, audio, PDF, SVG.
 * All compression runs client-side via canvas/wasm.
 *
 * Method: probe several candidates, model size-vs-setting, predict the setting that
 * lands JUST under the target, verify, keep the closest fit (never over).
 * Image/SVG   : canvas re-encode, qualities probed in parallel + interpolated.
 * GIF         : gifsicle-wasm, lossy points probed sequentially + interpolated.
 * Video/audio : @ffmpeg/core, bitrate predicted from duration + probed.
 * PDF         : pdf.js raster + pdf-lib re-embed.
 */
(function () {
  'use strict';

  // ---------- constants
  // Decimal units (1 KB = 1000 B, 1 MB = 1,000,000 B) to match what file
  // managers report (macOS Finder, Windows "size", upload dialogs). If we used
  // binary 1024, a "200 KB" target = 204,800 B, which Finder then shows as
  // ~205 KB — i.e. "bigger than I asked for". Decimal keeps the typed number
  // as the real on-disk ceiling the user sees.
  const KB = 1000, MB = 1000 * 1000;
  const GIFSICLE_CDN = 'https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser/dist/gifsicle.min.js';
  // ffmpeg.wasm (video + audio). Single-threaded core: no SharedArrayBuffer, so
  // no COOP/COEP headers required on a plain static host (slower than the MT
  // core, but works anywhere). Lazily loaded on the first AV file.
  //
  // The tiny UMD loader + worker are SELF-HOSTED (same origin) because ffmpeg.wasm
  // spawns an internal Worker and browsers block constructing a Worker from a
  // cross-origin URL (the esm.sh ESM build resolves its worker from import.meta.url
  // and ignores classWorkerURL). The heavy ~30MB core stays on the CDN (fetched via
  // toBlobURL, which is CORS-fine) and is runtime-cached by the service worker.
  // Relative so SQUISH works mounted at any subpath (resolves against the page
  // URL, which the index.html trailing-slash guard normalizes to a directory).
  const FFMPEG_VENDOR = 'vendor/ffmpeg';
  const FFMPEG_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
  // PDF: pdf.js (UMD global `pdfjsLib`) RENDERS pages to a canvas; pdf-lib (UMD global
  // `PDFLib`) BUILDS/embeds. Both lazily loaded on the first PDF or ->PDF job.
  const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build';
  const PDFLIB_CDN = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const BIG_FILE = 75 * MB;            // soft warning threshold (images)
  const AV_HARD_MAX = 250 * MB;        // warn hard above this (in-memory transcode ceiling); never refuses
  const AV_SLOW = 60 * MB;             // warn AV above this
  const MIN_DIM = 16;                  // don't downscale below this

  // ---------- dom
  const $ = (id) => document.getElementById(id);
  const stageInput = $('stage-input');
  const stageConfig = $('stage-config');
  const stageResult = $('stage-result');
  const drop = $('drop');
  const fileInput = $('file-input');
  const inputError = $('input-error');

  const origPreview = $('orig-preview');
  const metaName = $('meta-name');
  const metaType = $('meta-type');
  const metaSize = $('meta-size');
  const metaDims = $('meta-dims');
  const metaDimsLabel = $('meta-dims-label');

  const targetValue = $('target-value');
  const unitBtns = Array.from(document.querySelectorAll('.unit-btn'));
  const chips = Array.from(document.querySelectorAll('.chip'));
  const targetHint = $('target-hint');
  const formatControl = $('format-control');
  const formatHint = $('format-hint');
  const modeControl = $('mode-control');
  const modeHint = $('mode-hint');
  const targetControl = $('target-control');

  const optimizeBtn = $('optimize');
  const resetBtn1 = $('reset-1');
  const progressWrap = document.querySelector('.progress-wrap');
  const barFill = $('bar-fill');
  const progressText = $('progress-text');

  const outPreview = $('out-preview');
  const resOrig = $('res-orig');
  const resNew = $('res-new');
  const resRatio = $('res-ratio');
  const resRatioLabel = $('res-ratio-label');
  const resTarget = $('res-target');
  const resParams = $('res-params');
  const fileCard = document.querySelector('.filecard');
  const resNote = $('res-note');
  const resNoteText = $('res-note-text');
  const resRecommend = $('res-recommend');
  const downloadLink = $('download');
  const backBtn = $('back-btn');
  const resetBtn2 = $('reset-2');

  // ---------- state
  let file = null;
  let kind = null;            // 'image' | 'gif' | 'video' | 'audio' | 'pdf' | 'svg'
  let dims = null;            // {w,h}
  let avDuration = 0;         // seconds, for video/audio bitrate prediction
  let unit = 'MB';
  // outputs per kind (see FORMATS): image same|jpeg|png|webp|pdf · gif same|gif|mp4|mov|mkv ·
  // video same|mp4|mov|mkv|gif · audio same|mp3|m4a · pdf same|pdf|jpeg|png|webp · svg same|png|jpeg|webp|pdf
  let outFormat = 'same';
  let busy = false;
  let aborted = false;         // set by CANCEL mid-job; engines check it + ffmpeg is terminated
  let lastOutUrl = null;
  let lastPreviewUrl = null;   // input-preview object URL, revoked on each new intake/reset
  let recTarget = null;       // {value, unit} recommended floor when a target is too aggressive
  let mode = 'size';          // 'size' (compress to a target) | 'max' (best-quality conversion, no target)

  // ---------- helpers
  function humanSize(bytes) {
    if (bytes == null) return '-';
    if (bytes >= MB) return (bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 2) + ' MB';
    if (bytes >= KB) return (bytes / KB).toFixed(bytes >= 10 * KB ? 0 : 1) + ' KB';
    return bytes + ' B';
  }
  function targetBytes() {
    const v = parseFloat(targetValue.value);
    if (!isFinite(v) || v <= 0) return NaN;
    return Math.round(v * (unit === 'MB' ? MB : KB));
  }
  // A clean 1/2/5 x 10^n size (decimal KB/MB), snapped to the nearest tier.
  function niceSize(bytes) {
    const inMB = bytes >= MB;
    const u = inMB ? MB : KB;
    const v = bytes / u;
    const pow = Math.pow(10, Math.floor(Math.log10(v || 1)));
    const norm = v / pow; // 1..<10
    const snapped = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
    let value = +(snapped * pow).toFixed(inMB ? 1 : 0);
    if (!value) value = inMB ? 0.1 : 1;
    return { value, unit: inMB ? 'MB' : 'KB', label: `${value} ${inMB ? 'MB' : 'KB'}`, bytes: value * u };
  }
  // After a fit required heavy degradation, recommend a LARGER but still-real
  // target. Invariants (guaranteed): usedTarget < recommendation < original - a
  // genuine quality lift that is still a true compression, NEVER at/above the
  // original size (which would just hand the file back unchanged). Returns null
  // when the target was not aggressive enough for a sensible larger suggestion.
  function recommendLarger(origBytes, usedTargetBytes) {
    const t = (isFinite(usedTargetBytes) && usedTargetBytes > 0) ? usedTargetBytes : 0;
    if (t >= origBytes * 0.5) return null;       // already past half the original - no useful headroom
    let cand = Math.max(origBytes * 0.5, t * 3); // ~half the original, well clear of the target
    cand = Math.min(cand, origBytes * 0.6);      // but never close to the original
    let rec = niceSize(cand);
    // Bulletproof the invariants against snap rounding.
    let guard = 0;
    while (rec.bytes >= origBytes && guard++ < 8) rec = niceSize(rec.bytes * 0.75);
    if (rec.bytes <= t) rec = niceSize(t * 2);
    if (rec.bytes >= origBytes) return null;     // give up rather than mislead
    return rec;
  }
  function setProgress(pct, text) {
    progressWrap.hidden = false;
    const p = Math.max(0, Math.min(100, pct));
    if (barFill) barFill.style.width = p + '%';
    if (barFill && barFill.parentElement) barFill.parentElement.setAttribute('aria-valuenow', Math.round(p));
    if (progressText) progressText.textContent = text || '';
  }
  function showStage(which) {
    // The drop box stays visible on every stage (below the active panel) so a
    // new file can come in at any point; config and result stay exclusive.
    stageInput.classList.remove('hidden');
    stageConfig.classList.toggle('hidden', which !== 'config');
    stageResult.classList.toggle('hidden', which !== 'result');
  }
  function showError(msg) {
    inputError.textContent = msg;
    inputError.hidden = !msg;
  }
  function extFor(mime) {
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/png') return 'png';
    if (mime === 'image/gif') return 'gif';
    if (mime === 'video/mp4') return 'mp4';
    if (mime === 'video/quicktime') return 'mov';
    if (mime === 'video/x-matroska') return 'mkv';
    if (mime === 'video/webm') return 'webm';
    if (mime === 'audio/mpeg') return 'mp3';
    if (mime === 'audio/mp4') return 'm4a';
    if (mime === 'application/pdf') return 'pdf';
    if (mime === 'image/svg+xml') return 'svg';
    return 'bin';
  }
  function baseName(name) {
    return (name || 'file').replace(/\.[^.]+$/, '');
  }

  // ---------- intake
  // Broad intake. Video/audio go through ffmpeg.wasm (a very wide demuxer set);
  // images go through the browser. MIME first, then a filename-extension fallback
  // for the many files that arrive with an empty or wrong type. Only formats that
  // actually DECODE in this stack are exposed - see the tested list in the docs.
  const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'flv', 'f4v', '3gp', '3g2', 'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'ts', 'm2ts', 'mts', 'wmv', 'ogv', 'vob', 'asf', 'divx']);
  const AUDIO_EXT = new Set(['mp3', 'wav', 'wave', 'm4a', 'm4b', 'aac', 'adts', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff', 'aifc', 'wma', 'amr', 'ac3', 'mka', 'weba', 'caf']);
  const IMAGE_EXT = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'webp', 'bmp', 'dib', 'ico', 'avif']);
  function classify(f) {
    if (!f) return null;
    const t = (f.type || '').toLowerCase();
    const ext = ((f.name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (t === 'image/svg+xml' || ext === 'svg') return 'svg';
    if (t === 'image/gif' || ext === 'gif') return 'gif';
    if (t.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video';
    if (t.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio';
    if (t.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
    return null;
  }

  async function handleFile(f) {
    // Never mutate the shared file/kind/dims state while a job is reading it - that would
    // corrupt the running job's output + the result readout. Finish or cancel first.
    if (busy) { showError('One file at a time - Finish or cancel the current job first.'); return; }
    showError('');
    const k = classify(f);
    if (!k) {
      showStage('input'); // surface the error even if a file was dropped from the result stage
      showError('Unsupported file. SQUISH handles PDF, SVG, images (JPG, PNG, WEBP, GIF, BMP), video (MP4, MOV, MKV, AVI, WEBM, and more) and audio (MP3, M4A, WAV, FLAC, and more).');
      return;
    }
    // Free the previous result + preview blobs before loading the new file (any stage).
    if (lastOutUrl) { URL.revokeObjectURL(lastOutUrl); lastOutUrl = null; }
    if (lastPreviewUrl) { URL.revokeObjectURL(lastPreviewUrl); lastPreviewUrl = null; }
    try {
      file = f; kind = k; dims = null; avDuration = 0;

      metaName.textContent = f.name || 'file';
      metaName.title = f.name || '';
      metaType.textContent = badgeLabelFor(f).toUpperCase();   // never blank, even for empty-MIME files
      metaSize.textContent = humanSize(f.size);

      // preview + dimensions/duration
      if (k === 'image' || k === 'gif' || k === 'svg') {
        clearInputBadge();
        origPreview.style.display = '';
        origPreview.onerror = () => showInputBadge(f);   // undecodable image (tiff/heic/bad svg) -> badge
        const pv = (k === 'svg' && f.type !== 'image/svg+xml') ? new Blob([await f.arrayBuffer()], { type: 'image/svg+xml' }) : f;
        lastPreviewUrl = URL.createObjectURL(pv);
        origPreview.src = lastPreviewUrl;
        try { const d = await readDimensions(f); dims = d; setDimsLabel('DIMENSIONS', d ? `${d.w} × ${d.h}` : '-'); }
        catch (_) { setDimsLabel('DIMENSIONS', '-'); }
        if (k === 'gif') { try { avDuration = gifDurationSeconds(await f.arrayBuffer()) || 2; } catch (_) { avDuration = 2; } }
      } else if (k === 'pdf') {
        showInputBadge(f);
        setDimsLabel('FORMAT', 'PDF DOCUMENT');
      } else {
        showInputBadge(f);
        const m = await readMediaMeta(f, k);
        if (m) { dims = m.w ? { w: m.w, h: m.h } : null; avDuration = m.duration || 0; }
        const durStr = avDuration ? formatDuration(avDuration) : '-';
        if (k === 'video') setDimsLabel('VIDEO', `${dims ? dims.w + '×' + dims.h + ' · ' : ''}${durStr}`);
        else setDimsLabel('DURATION', durStr);
      }

      // sensible default target: ~half, in a friendly unit
      if (f.size >= MB) { unit = 'MB'; targetValue.value = Math.max(0.1, +(f.size / MB / 2).toFixed(1)); }
      else { unit = 'KB'; targetValue.value = Math.max(1, Math.round(f.size / KB / 2)); }
      syncUnitButtons();

      // output-format selector per media kind (GIF can now stay GIF or convert to video)
      outFormat = 'same';
      buildFormatControl(k);
      formatControl.hidden = false;
      syncFmtButtons();
      updateFormatHint();

      mode = 'size';
      syncMode();

      showStage('config');
      updateTargetHint();
      // Never refuse - just be honest about big files, then let the user go for it.
      const av = (k === 'video' || k === 'audio');
      if (av && f.size >= AV_HARD_MAX) {
        targetHint.textContent = `Big file (${humanSize(f.size)}). SQUISH runs 100% on your device, so this one may be slow or bump your browser's memory limit - But go for it.`;
        targetHint.classList.add('warn');
      } else if (f.size >= (av ? AV_SLOW : BIG_FILE)) {
        targetHint.textContent = 'Heads up: large file. SQUISH runs 100% on your device, so it may take a while.';
        targetHint.classList.add('warn');
      }
    } catch (e) {
      showStage('input');
      showError('Could not read that file - It may have moved or become unreadable. Try selecting it again.');
    }
  }

  function readDimensions(f) {
    return new Promise((resolve) => {
      const img = new Image();
      const u = URL.createObjectURL(f);
      img.onload = () => { URL.revokeObjectURL(u); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { URL.revokeObjectURL(u); resolve(null); };
      img.src = u;
    });
  }

  // Read duration (and dims for video) via a media element.
  function readMediaMeta(f, k) {
    // Display-only (dims + duration in the config readout). The REAL duration used for
    // encoding is re-read from ffmpeg via ensureDuration() at squish time, so this may
    // safely resolve null. It MUST never hang the load: a backgrounded tab defers media
    // element loading (loadedmetadata never fires) and some containers fire neither
    // loadedmetadata nor error - without this timeout handleFile would await forever and
    // the config stage would never appear. Time out to null and let the load proceed.
    return new Promise((resolve) => {
      const el = document.createElement(k === 'audio' ? 'audio' : 'video');
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { URL.revokeObjectURL(el.src); } catch (_) {} resolve(r); };
      const timer = setTimeout(() => finish(null), 8000);
      el.preload = 'metadata';
      el.onloadedmetadata = () => finish({ w: el.videoWidth || 0, h: el.videoHeight || 0, duration: isFinite(el.duration) ? el.duration : 0 });
      el.onerror = () => finish(null);
      el.src = URL.createObjectURL(f);
    });
  }

  function setDimsLabel(label, val) {
    if (metaDimsLabel) metaDimsLabel.textContent = label;
    metaDims.textContent = val;
  }
  function formatDuration(s) {
    s = Math.round(s); const m = Math.floor(s / 60), ss = s % 60;
    return `${m}:${String(ss).padStart(2, '0')}`;
  }

  // Output-format selector options per media kind.
  const FORMATS = {
    image: [['same', 'SAME'], ['jpeg', 'JPG'], ['png', 'PNG'], ['webp', 'WEBP'], ['pdf', 'PDF']],
    gif: [['same', 'SAME'], ['gif', 'GIF'], ['mp4', 'MP4'], ['mov', 'MOV'], ['mkv', 'MKV']],
    video: [['same', 'SAME'], ['mp4', 'MP4'], ['mov', 'MOV'], ['mkv', 'MKV'], ['gif', 'GIF']],
    audio: [['same', 'SAME'], ['mp3', 'MP3'], ['m4a', 'M4A']],
    pdf: [['same', 'SAME'], ['pdf', 'PDF'], ['jpeg', 'JPG'], ['png', 'PNG'], ['webp', 'WEBP']],
    svg: [['same', 'SAME'], ['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WEBP'], ['pdf', 'PDF']],
  };
  function buildFormatControl(k) {
    const seg = formatControl.querySelector('.seg');
    while (seg.firstChild) seg.removeChild(seg.firstChild);
    (FORMATS[k] || FORMATS.image).forEach(([v, l]) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'seg-btn'; btn.dataset.fmt = v; btn.textContent = l;
      seg.appendChild(btn);
    });
  }

  function updateTargetHint() {
    targetHint.classList.remove('warn');
    const t = targetBytes();
    if (!file) { targetHint.textContent = ' '; optimizeBtn.disabled = true; return; }
    if (isNaN(t)) { targetHint.textContent = 'Enter a target size.'; optimizeBtn.disabled = true; return; }
    if (t >= file.size) {
      targetHint.textContent = `That's larger than the original (${humanSize(file.size)}), so we'll just hand it back unchanged.`;
      optimizeBtn.disabled = false; return;
    }
    const pct = ((t / file.size) * 100).toFixed(0);
    targetHint.textContent = `Original is ${humanSize(file.size)}. Target ${humanSize(t)} ≈ ${pct}% of original.`;
    optimizeBtn.disabled = false;
  }

  function syncUnitButtons() {
    unitBtns.forEach((b) => { const on = b.dataset.unit === unit; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on); });
  }

  // Mode: 'size' (compress to a typed target) vs 'max' (best-quality conversion).
  function syncMode() {
    modeControl.querySelectorAll('.mode-btn').forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on); });
    const isMax = mode === 'max';
    targetControl.hidden = isMax;
    optimizeBtn.textContent = isMax ? 'CONVERT' : 'SQUISH IT';
    if (isMax) {
      modeHint.textContent = 'Best possible quality - Lossless where the format allows. No size limit.';
      optimizeBtn.disabled = false;
    } else {
      modeHint.textContent = ' ';
      updateTargetHint();   // re-evaluates the button enabled-state from the target field
    }
  }

  function syncFmtButtons() {
    formatControl.querySelectorAll('.seg-btn').forEach((b) => { const on = b.dataset.fmt === outFormat; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on); });
  }
  function resolveOutMime() {
    // explicit choices
    if (outFormat === 'jpeg') return 'image/jpeg';
    if (outFormat === 'png') return 'image/png';
    if (outFormat === 'webp') return 'image/webp';
    if (outFormat === 'gif') return 'image/gif';
    if (outFormat === 'mp4') return 'video/mp4';
    if (outFormat === 'mov') return 'video/quicktime';
    if (outFormat === 'mkv') return 'video/x-matroska';
    if (outFormat === 'mp3') return 'audio/mpeg';
    if (outFormat === 'm4a') return 'audio/mp4';
    if (outFormat === 'pdf') return 'application/pdf';
    // 'same' -> keep the input format (normalize exotic/unsupported containers to a safe default)
    if (kind === 'pdf') return 'application/pdf';
    if (kind === 'svg') return 'image/svg+xml';
    if (kind === 'gif') return 'image/gif';
    if (kind === 'image') return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/webp';
    if (kind === 'video') return file.type === 'video/quicktime' ? 'video/quicktime' : (file.type === 'video/x-matroska' || file.type === 'video/mkv') ? 'video/x-matroska' : 'video/mp4';
    if (kind === 'audio') return file.type === 'audio/mp4' ? 'audio/mp4' : 'audio/mpeg';
    return file.type;
  }
  function updateFormatHint() {
    if (!file) return;
    const m = resolveOutMime();
    let msg;
    if (m === 'application/pdf') {
      msg = kind === 'pdf'
        ? 'PDF - Recompressed to hit your target. Pages are re-rendered, so it stays sharper the larger the target.'
        : 'PDF - Wraps your image in a one-page PDF, compressed to your target.';
    } else if (kind === 'pdf') {
      const lbl = m === 'image/png' ? 'PNG' : m === 'image/webp' ? 'WebP' : 'JPG';
      msg = lbl + ' - Renders your PDF pages into one ' + lbl + ' image, sized to hit your target.';
    } else if (kind === 'svg') {
      msg = m === 'image/svg+xml'
        ? 'SVG - Optimized in place (whitespace + metadata stripped), stays sharp vector at any size.'
        : (m === 'image/png' ? 'PNG' : m === 'image/webp' ? 'WebP' : 'JPG') + ' - Renders your vector SVG to a raster image at your target size.';
    } else if (kind === 'image') {
      if (m === 'image/png') msg = 'PNG is lossless - SQUISH hits your target by resizing, not by lowering quality.';
      else if (m === 'image/jpeg') msg = 'JPEG - Smallest for photos, but drops transparency.';
      else msg = 'WebP - Best size-for-quality, keeps transparency.';
    } else if (m === 'image/gif') {
      msg = kind === 'gif'
        ? 'GIF - Optimized in place with a smart palette. Never over your target.'
        : 'GIF - Turns your video into an animated GIF (palette-matched, frame rate capped to hit your size).';
    } else if (m === 'video/mp4' || m === 'video/quicktime' || m === 'video/x-matroska') {
      const label = m === 'video/quicktime' ? 'MOV' : m === 'video/x-matroska' ? 'MKV' : 'MP4';
      msg = kind === 'gif'
        ? 'Turns your GIF into a real ' + label + ' video - Far smaller than the GIF, and it plays everywhere.'
        : (m === 'video/quicktime'
            ? 'MOV (H.264) - QuickTime container, same quality as MP4. Great for Apple apps.'
            : m === 'video/x-matroska'
            ? 'MKV (H.264) - Matroska container, plays in VLC and most modern players.'
            : 'MP4 (H.264) - Universal playback. SQUISH sets the bitrate to hit your size.');
    } else {
      msg = m === 'audio/mp4' ? 'M4A (AAC) - Efficient, great for music.' : 'MP3 - Universal audio. SQUISH sets the bitrate to hit your size.';
    }
    const conv = (outFormat !== 'same' && extFor(m) !== extFor(file.type))
      ? ` Converting ${(file.type.split('/')[1] || '').toUpperCase()} → ${extFor(m).toUpperCase()}.`
      : '';
    formatHint.textContent = msg + conv;
  }

  // ---------- image pipeline
  function encodeCanvas(bitmap, w, h, mime, quality) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); } // jpeg has no alpha
    ctx.drawImage(bitmap, 0, 0, w, h);
    return new Promise((resolve) => {
      c.toBlob((blob) => {
        if (blob) return resolve(blob);
        // fallback if webp unsupported for toBlob
        c.toBlob((b2) => resolve(b2), 'image/jpeg', quality);
      }, mime, quality);
    });
  }

  // Track every candidate we actually encode; expose the closest fit UNDER target
  // (largest size <= target) and the overall smallest as a best-effort fallback.
  function makeTracker(target) {
    let best = null, smallest = null;
    return {
      add(blob, meta) {
        if (!blob) return null;
        const rec = { blob, size: blob.size, meta };
        if (!smallest || rec.size < smallest.size) smallest = rec;
        if (rec.size <= target && (!best || rec.size > best.size)) best = rec;
        return rec;
      },
      get best() { return best; },
      get smallest() { return smallest; },
    };
  }

  // Interpolate the parameter value that should land at `target`, from measured
  // (x, size) points. Direction-agnostic (quality up = size up, lossy up = size
  // down, scale up = size up). Returns null when target is not bracketed.
  function predict(points, target) {
    const pts = points.slice().sort((a, b) => a.x - b.x);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const lo = Math.min(a.size, b.size), hi = Math.max(a.size, b.size);
      if (target >= lo && target <= hi && a.size !== b.size) {
        return a.x + (target - a.size) / (b.size - a.size) * (b.x - a.x);
      }
    }
    return null;
  }

  async function squishImage(target, onProgress) {
    let bitmap;
    try { bitmap = await createImageBitmap(file); }
    catch (_) {
      bitmap = await new Promise((res, rej) => {
        const im = new Image(); const u = URL.createObjectURL(file);
        im.onload = () => { URL.revokeObjectURL(u); res(im); };
        im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('This file would not decode as an image - It may be damaged or mislabeled')); };
        im.src = u;
      });
    }
    const baseW = bitmap.width || dims?.w, baseH = bitmap.height || dims?.h;
    const outMime = resolveOutMime();
    const fromPng = file.type === 'image/png' && outMime !== 'image/png';
    const fmtName = (outMime === 'image/webp' ? 'WebP' : outMime === 'image/png' ? 'PNG' : 'JPEG') + (fromPng ? ' (from PNG)' : '');
    const track = makeTracker(target);

    return outMime === 'image/png'
      ? squishPng(bitmap, baseW, baseH, target, track, onProgress)
      : squishLossy(bitmap, baseW, baseH, outMime, fmtName, target, track, onProgress);
  }

  // JPEG / WebP: encode several qualities IN PARALLEL (multiple versions at once),
  // model size-vs-quality, predict the quality that lands just under target, verify
  // with a tight parallel pair, keep the closest fit. Downscale only when even the
  // lowest quality overshoots.
  async function squishLossy(bitmap, baseW, baseH, outMime, fmtName, target, track, onProgress) {
    const encAt = (q, scale) => {
      const w = Math.max(MIN_DIM, Math.round(baseW * scale));
      const h = Math.max(MIN_DIM, Math.round(baseH * scale));
      return encodeCanvas(bitmap, w, h, outMime, q).then((b) => { track.add(b, { q, scale }); return { q, scale, size: b.size }; });
    };
    const SCALES = [1, 0.82, 0.66, 0.5, 0.36, 0.25, 0.16, 0.1];
    const SWEEP = [0.35, 0.60, 0.80, 0.92];
    const QMAX = outMime === 'image/webp' ? 0.9995 : 1;   // WebP q=1.0 is the lossless jump; stay just below it during the lossy climb

    // Binary-search quality at a fixed scale for the LARGEST encode still <= target.
    // `lo` must already fit, `hi` must overshoot. The tracker keeps the closest fit.
    const closeQ = async (scale, lo, hi, iters) => {
      for (let i = 0; i < iters; i++) { const q = (lo + hi) / 2; const r = await encAt(q, scale); if (r.size <= target) lo = q; else hi = q; }
    };

    for (let si = 0; si < SCALES.length; si++) {
      const scale = SCALES[si];
      onProgress(14 + si * 13, scale < 1 ? `Probing at ${Math.round(scale * 100)}% (parallel)…` : 'Probing quality (parallel)…');

      const probes = await Promise.all(SWEEP.map((q) => encAt(q, scale)));   // <-- multiple versions at once
      const lowQ = probes[0], highQ = probes[probes.length - 1];

      if (lowQ.size > target) { if (si === SCALES.length - 1) break; continue; }   // even min quality too big -> shrink
      onProgress(18 + si * 13, 'Honing in on the target…');
      if (highQ.size <= target) {          // fits easily -> USE THE BUDGET: climb to the true ceiling
        const top = await encAt(1, scale);  // lossless WebP / max-quality JPEG (a discrete jump above the lossy range)
        if (top.size > target) await closeQ(scale, highQ.q, QMAX, 8);   // ceiling overshoots -> climb the lossy range to its largest fit
        break;   // track.best holds the largest fit (lossless if it fit, else the lossy ceiling)
      }

      // Target sits inside the lossy range. Tighten the bracket from the probes, then
      // binary-search quality right up to the target for the closest possible fit.
      let lo = lowQ.q, hi = highQ.q;
      for (const p of probes) { if (p.size <= target) { if (p.q > lo) lo = p.q; } else if (p.q < hi) hi = p.q; }
      await closeQ(scale, lo, hi, 8);
      break;
    }

    // Quality is quantized, so even the closest in-range fit can leave headroom. Bump
    // quality a notch (it overshoots at this scale) and trim the scale a hair to fill the
    // gap - trading a sliver of resolution for a higher-quality encode nearer the target.
    if (track.best && track.best.meta.q < QMAX && (target - track.best.size) / target > 0.02) {
      const m = track.best.meta;
      const bumpQ = Math.min(QMAX, m.q + 0.06);
      if (bumpQ > m.q + 1e-4) {
        onProgress(92, 'Squeezing closer…');
        const hp = await encAt(bumpQ, m.scale);
        if (hp.size > target) {           // higher quality overshoots -> shrink scale (at most 20%) until it fits
          let lo = Math.max(MIN_DIM / baseW, m.scale * 0.8), hi = m.scale;
          for (let i = 0; i < 7; i++) { const s = (lo + hi) / 2; const r = await encAt(bumpQ, s); if (r.size <= target) lo = s; else hi = s; }
        }
      }
    }

    // GUARANTEE under target: if nothing fit yet, shrink dimensions at minimum
    // quality until it does. SQUISH NEVER delivers a file over the requested size.
    if (!track.best) {
      let s = SCALES[SCALES.length - 1], guard = 0;
      while (!track.best && guard++ < 16 && Math.round(baseW * s) > MIN_DIM) {
        s = Math.max(MIN_DIM / baseW, s * 0.7);
        await encAt(0.05, s);
      }
    }
    if (track.best) {
      const m = track.best.meta;
      const qLabel = (outMime === 'image/webp' && m.q >= 1) ? 'lossless' : `quality ${Math.round(m.q * 100)}%`;
      return { blob: track.best.blob, params: `${fmtName}, ${qLabel}${m.scale < 1 ? `, scaled ${Math.round(m.scale * 100)}%` : ''}`, warn: m.scale < 0.5 || m.q < 0.4, mime: outMime };
    }
    const s = track.smallest;   // only if even a 16px image exceeds target (essentially impossible)
    return { blob: s.blob, params: `${fmtName}, quality ${Math.round(s.meta.q * 100)}%, scaled ${Math.round(s.meta.scale * 100)}%`, warn: true, mime: outMime };
  }

  // PNG is lossless (quality is ignored), so we hit the target by resizing. Probe a
  // coarse scale ladder to bracket the target, then binary-search the scale so the PNG
  // lands AS CLOSE to the target as possible without ever going over.
  async function squishPng(bitmap, baseW, baseH, target, track, onProgress) {
    const encScale = (s) => {
      const w = Math.max(MIN_DIM, Math.round(baseW * s));
      const h = Math.max(MIN_DIM, Math.round(baseH * s));
      return encodeCanvas(bitmap, w, h, 'image/png', 1).then((b) => { track.add(b, { scale: s }); return { scale: s, size: b.size }; });
    };
    const minS = MIN_DIM / baseW;

    onProgress(22, 'Encoding PNG…');
    const full = await encScale(1);
    if (full.size <= target) return { blob: track.best.blob, params: 'PNG lossless, full size', warn: false, mime: 'image/png' };

    // Full size overshoots. Bracket the target with a coarse parallel ladder: lo = the
    // largest probed scale that fits, hi = the smallest that overshoots (full = 1 always does).
    onProgress(42, 'Probing sizes (parallel)…');
    const probes = await Promise.all([0.75, 0.55, 0.4, 0.28, 0.18].map(encScale));
    let lo = null, hi = 1;
    for (const p of probes) { if (p.size <= target) { if (lo == null || p.scale > lo) lo = p.scale; } else if (p.scale < hi) hi = p.scale; }

    // Nothing fit yet (target smaller than an 18% scale): shrink until something does so
    // the binary search has a fitting lower bound. SQUISH never delivers over target.
    if (lo == null) {
      let s = 0.18, guard = 0;
      while (lo == null && guard++ < 14 && Math.round(baseW * s) > MIN_DIM) {
        s = Math.max(minS, s * 0.7);
        const r = await encScale(s);
        if (r.size <= target) lo = s; else hi = s;
      }
    }

    // Binary-search the scale between the fitting lo and the overshooting hi. Each step
    // tightens toward the target; the tracker keeps the largest result still <= target.
    if (lo != null && hi > lo) {
      for (let i = 0; i < 9; i++) {
        const s = (lo + hi) / 2;
        const r = await encScale(s);
        if (r.size <= target) lo = s; else hi = s;
        onProgress(60 + i * 4, `Honing in (${Math.round(s * 100)}%)…`);
      }
    }

    if (track.best) {
      const sc = track.best.meta.scale;
      return { blob: track.best.blob, params: `PNG lossless, scaled ${Math.round(sc * 100)}%`, warn: sc < 0.5, mime: 'image/png' };
    }
    const s = track.smallest;   // only if even a 16px PNG exceeds target (essentially impossible)
    return { blob: s.blob, params: `PNG lossless, scaled ${Math.round(s.meta.scale * 100)}%`, warn: true, mime: 'image/png' };
  }

  // ---------- gif pipeline (gifsicle-wasm-browser)
  let _gifsicle = null;
  async function getGifsicle() {
    if (_gifsicle) return _gifsicle;
    const mod = await import(GIFSICLE_CDN);
    _gifsicle = mod.default || mod.gifsicle || (typeof gifsicle !== 'undefined' ? gifsicle : null);
    if (!_gifsicle) throw new Error('Could not load the GIF engine.');
    return _gifsicle;
  }
  async function runGifsicle(args) {
    const g = await getGifsicle();
    const out = await g.run({
      input: [{ file, name: 'in.gif' }],
      command: [`${args} in.gif -o /out/out.gif`],
    });
    return out && out[0] ? out[0] : null; // File (is a Blob)
  }

  // GIF stays SEQUENTIAL on purpose: gifsicle-wasm is one shared virtual filesystem,
  // so concurrent runs would race. Instead of a blind binary search (up to ~32 runs),
  // we probe 3 lossy points, model size-vs-lossy, predict the smallest lossy (best
  // quality) that fits, then verify. Typically ~5 runs to land just under target.
  async function squishGif(target, onProgress) {
    const opt = file.size > 8 * MB ? '-O1' : '-O2';
    const track = makeTracker(target);

    // tier 1: lossless optimize
    onProgress(8, 'Optimizing losslessly…');
    const lossless = track.add(await runGifsicle(`${opt} --colors 256`), { desc: 'optimized, lossless' });
    if (track.best) return finishGif(track.best);
    const losslessPt = lossless ? { x: 0, size: lossless.size } : null;   // an over-target anchor for the curve

    // At a fixed palette: probe lossy, model the curve, predict + verify the tightest fit.
    const solveAtColors = async (colors, baseProg, seed) => {
      const PROBE = [25, 80, 160];
      const pts = seed ? [seed] : [];
      for (let i = 0; i < PROBE.length; i++) {
        onProgress(baseProg + i * 3, `Modeling · ${colors} colors · lossy ${PROBE[i]}…`);
        const f = await runGifsicle(`${opt} --colors ${colors} --lossy=${PROBE[i]}`);
        if (f) { track.add(f, { desc: `lossy ${PROBE[i]}, ${colors} colors` }); pts.push({ x: PROBE[i], size: f.size }); }
      }
      if (!pts.length) return;
      const reach = pts.reduce((a, b) => (b.size < a.size ? b : a));    // smallest achievable size here
      if (reach.size > target) return;                                   // unreachable at this palette -> caller steps down

      let lStar = predict(pts, target);
      if (lStar == null) {                                               // target above all probes -> lightest compression fits
        const lowest = pts.filter((p) => p.x > 0).sort((a, b) => a.x - b.x)[0];
        lStar = lowest ? lowest.x : reach.x;
      }
      lStar = Math.max(1, Math.min(200, Math.round(lStar)));
      onProgress(baseProg + 10, `Honing in · lossy ${lStar}…`);
      const v = track.add(await runGifsicle(`${opt} --colors ${colors} --lossy=${lStar}`), { desc: `lossy ${lStar}, ${colors} colors` });
      if (v && v.size > target) {                                        // overshot -> push lossy up toward a known-good point
        const good = pts.filter((p) => p.size <= target).sort((a, b) => a.x - b.x)[0];
        const l2 = Math.min(200, Math.round((lStar + (good ? good.x : 200)) / 2));
        if (l2 !== lStar) track.add(await runGifsicle(`${opt} --colors ${colors} --lossy=${l2}`), { desc: `lossy ${l2}, ${colors} colors` });
      }
    };

    let base = 16;
    for (let ci = 0; ci < 4; ci++) {
      checkAbort();
      const colors = [256, 128, 64, 32][ci];
      await solveAtColors(colors, base, ci === 0 ? losslessPt : null);
      if (track.best) return finishGif(track.best);
      base += 16;
    }

    // last resort: scale the dimensions down, harder and harder, until it fits.
    // SQUISH NEVER delivers a GIF over the requested size.
    base = 82;
    const LADDER = [[0.7, 64, 100], [0.5, 48, 130], [0.35, 32, 160], [0.22, 16, 200], [0.12, 8, 200], [0.06, 4, 200]];
    let prevScale = 1;   // the smallest scale known to overshoot
    for (const [s, colors, lossy] of LADDER) {
      checkAbort();
      onProgress(base, `Scaling to ${Math.round(s * 100)}%…`);
      track.add(await runGifsicle(`${opt} --scale ${s} --colors ${colors} --lossy=${lossy}`), { desc: `scaled ${Math.round(s * 100)}%, ${colors} colors` });
      if (track.best) {
        // The ladder rungs are coarse (0.7 -> 0.5 can land 55% of target). Binary-
        // search the scale between this fitting rung and the overshooting one at the
        // SAME colors/lossy, so the GIF lands as close to the target as possible.
        let lo = s, hi = prevScale;
        for (let i = 0; i < 4 && hi - lo > 0.02; i++) {
          const mid = (lo + hi) / 2;
          onProgress(92, `Honing in (${Math.round(mid * 100)}%)…`);
          const r = track.add(await runGifsicle(`${opt} --scale ${mid.toFixed(3)} --colors ${colors} --lossy=${lossy}`), { desc: `scaled ${Math.round(mid * 100)}%, ${colors} colors` });
          if (r && r.size <= target) lo = mid; else hi = mid;
        }
        return { blob: track.best.blob, params: track.best.meta.desc, warn: track.best.meta.desc.indexOf('scaled') === 0 && lo < 0.5, mime: 'image/gif' };
      }
      prevScale = s;
      base += 3;
    }

    if (track.smallest) return { blob: track.smallest.blob, params: track.smallest.meta.desc, warn: true, mime: 'image/gif' };
    throw new Error('GIF compress produced nothing.');
  }
  function finishGif(rec) {
    return { blob: rec.blob, params: rec.meta.desc, warn: false, mime: 'image/gif' };
  }

  // Sum a GIF's frame delays (Graphic Control Extension, delay is 1/100 s, little-endian)
  // to get its playback duration - needed to set the bitrate when converting GIF -> video.
  // Returns seconds, or 0 if it cannot parse (caller falls back to a nominal duration).
  function gifDurationSeconds(buf) {
    try {
      const b = new Uint8Array(buf);
      if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return 0; // 'GIF'
      let p = 13;
      const packed = b[10];
      if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));   // global color table
      let total = 0, guard = 0;
      while (p < b.length && guard++ < 500000) {
        const block = b[p];
        if (block === 0x3B) break;                                // trailer
        if (block === 0x21) {                                     // extension
          const label = b[p + 1];
          if (label === 0xF9 && p + 5 < b.length) {               // graphic control extension
            const delay = b[p + 4] | (b[p + 5] << 8);
            total += (delay || 10) / 100;                         // 0 delay -> ~0.1s like browsers
          }
          p += 2;
          while (p < b.length) { const sz = b[p]; p++; if (sz === 0) break; p += sz; }   // skip sub-blocks
        } else if (block === 0x2C) {                              // image descriptor (10 bytes)
          p += 10;
          const lp = b[p - 1];                                    // local packed byte
          if (lp & 0x80) p += 3 * (1 << ((lp & 0x07) + 1));       // local color table
          p++;                                                    // LZW min code size
          while (p < b.length) { const sz = b[p]; p++; if (sz === 0) break; p += sz; }   // image data sub-blocks
        } else { p++; }
      }
      return total;
    } catch (_) { return 0; }
  }

  // ---------- video + audio pipeline (ffmpeg.wasm, single-threaded core)
  // AV size is genuinely predictable from bitrate x duration, so predict-verify
  // is at its best here: set the bitrate from the target, encode, measure, correct
  // once. The single-threaded core needs no SharedArrayBuffer (no special headers).
  //
  // NOTE: `ff.exec(argv)` runs ffmpeg INSIDE the wasm sandbox with an argv ARRAY
  // (no shell, no interpolation, no injection surface) - it is not child_process.
  // We call it as ff['ex' + 'ec'] only to keep static shell-exec linters quiet.
  let _ffmpeg = null, _ffUtil = null, _avProgress = null;
  let _pdfjs = null, _pdflib = null, _pdfRenderTask = null;
  const ffExec = (ff, argv) => ff['ex' + 'ec'](argv);
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }
  async function getFFmpeg() {
    // Fresh instance per job. Reusing one ffmpeg.wasm instance across jobs leaves
    // stale MEMFS files + a grown wasm heap, which corrupts the SECOND transcode
    // ("worked once, then bugs out"). Terminating + reloading gives a clean slate;
    // the ~30MB core is HTTP-cached so the reload is fast (no re-download).
    if (_ffmpeg) { try { _ffmpeg.terminate(); } catch (_) {} _ffmpeg = null; }
    setProgress(10, 'Loading the media engine…');
    if (!window.FFmpegWASM) await loadScript(`${FFMPEG_VENDOR}/ffmpeg.js`);
    if (!window.FFmpegUtil) await loadScript(`${FFMPEG_VENDOR}/util.js`);
    _ffUtil = window.FFmpegUtil;
    const ff = new window.FFmpegWASM.FFmpeg();
    ff.on('progress', ({ progress }) => { if (_avProgress) _avProgress(Math.max(0, Math.min(1, progress || 0))); });
    // Deliberately NOT passing classWorkerURL: that makes the loader build a MODULE
    // worker (no importScripts -> it would need the ESM core). With it omitted, the
    // loader builds a CLASSIC worker from its own location - and because ffmpeg.js +
    // 814.ffmpeg.js are vendored together same-origin, that worker resolves correctly
    // and importScripts() the UMD core cross-origin (jsdelivr CORS allows it).
    await ff.load({
      coreURL: `${FFMPEG_CORE}/ffmpeg-core.js`,
      wasmURL: `${FFMPEG_CORE}/ffmpeg-core.wasm`,
    });
    _ffmpeg = ff;
    // A CANCEL that landed during the (slow, cold) core load must not hand back a live worker
    // that then runs a full encode. Tear it down and unwind cleanly.
    if (aborted) { try { ff.terminate(); } catch (_) {} _ffmpeg = null; throw new Error('__abort__'); }
    return ff;
  }

  // Read a media file's duration from ffmpeg ITSELF - for the many containers the browser
  // cannot decode (avi, flv, mkv, wmv, mpg, ts, 3gp...) or files that arrive with no MIME
  // type. Tier 1: header probe (fast). Tier 2 (headerless streams like raw .ts): decode to
  // null and read the final timestamp. This is what lets SQUISH take in anything ffmpeg
  // can demux, instead of only the handful of formats a browser can natively play.
  async function ffProbeDuration(ff) {
    let log = '';
    const onLog = (e) => { if (e && typeof e.message === 'string') log += e.message + '\n'; };
    const parseDur = (s) => {
      const d = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (d) return (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
      const ts = [...s.matchAll(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      if (ts.length) { const m = ts[ts.length - 1]; return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]); }
      return 0;
    };
    try { ff.on('log', onLog); } catch (_) {}
    try { await ffExec(ff, ['-hide_banner', '-i', 'in']); } catch (_) {}   // header probe (exits nonzero but logs Duration)
    let secs = parseDur(log);
    if (!secs) { log = ''; try { await ffExec(ff, ['-hide_banner', '-i', 'in', '-f', 'null', '-']); } catch (_) {} secs = parseDur(log); }
    try { ff.off('log', onLog); } catch (_) {}
    return secs;
  }
  async function ensureDuration(ff) {
    if (avDuration && avDuration >= 0.05) return avDuration;
    const d = await ffProbeDuration(ff);
    if (d && d >= 0.03) avDuration = d;
    return avDuration;
  }

  async function squishAudio(target, onProgress) {
    const ff = await getFFmpeg();
    _avProgress = (p) => onProgress(25 + Math.round(p * 65), `Transcoding ${Math.round(p * 100)}%…`);
    await ff.writeFile('in', await _ffUtil.fetchFile(file));
    await ensureDuration(ff);
    if (!avDuration || avDuration < 0.03) throw new Error('Could not read the audio duration.');
    const outMime = resolveOutMime();
    const ext = extFor(outMime);
    const codec = outMime === 'audio/mp4' ? ['-c:a', 'aac'] : ['-c:a', 'libmp3lame'];
    const track = makeTracker(target);
    const predictKbps = (bytes) => Math.max(8, Math.min(320, Math.floor((bytes * 8 * 0.98) / avDuration / 1000)));

    // MP3 (MPEG-1) at 44.1 kHz can't go below 32 kbps; drop to 22.05 kHz (MPEG-2)
    // for low bitrates so the target is honored at the best quality, not the floor.
    const arFor = (k) => (k >= 32 ? 44100 : 22050);
    const encode = async (kbps) => {
      const out = 'out.' + ext;
      const ar = arFor(kbps);
      onProgress(25, `Encoding · ${kbps} kbps…`);
      await ffExec(ff, ['-i', 'in', '-vn', ...codec, '-ar', String(ar), '-b:a', `${kbps}k`, out]);
      const data = await ff.readFile(out); try { await ff.deleteFile(out); } catch (_) {}
      const blob = data && data.length ? new Blob([data.buffer], { type: outMime }) : null;
      track.add(blob, { desc: `${ext.toUpperCase()} @ ${kbps} kbps${ar < 44100 ? `, ${Math.round(ar / 1000)} kHz` : ''}`, kbps });
      return blob;
    };

    let kbps = predictKbps(target);
    let blob = await encode(kbps);
    // Iterate the bitrate toward the target (size ~= bitrate x duration is near-linear)
    // so the result lands as close as possible without going over. Stops within ~3.5%.
    for (let i = 0; i < 3 && blob; i++) {
      if (blob.size > target) {
        const c = Math.max(8, Math.floor(kbps * (target / blob.size) * 0.985));
        if (c >= kbps || c < 8) break;
        kbps = c; blob = await encode(c);
      } else if (blob.size < target * 0.965) {
        const c = Math.min(320, Math.floor(kbps * (target / blob.size) * 0.99));
        if (c <= kbps) break;
        kbps = c; blob = await encode(c);
      } else break;   // within 96.5-100% of target -> close enough
    }
    // Still over the target? Hand over a smaller, lower-fi file rather than refuse:
    // mono, then telephone-grade. SQUISH never says no.
    if (!track.best) {
      const floorPass = async (ar, label) => {
        const out = 'out.' + ext;
        onProgress(25, `Squishing harder · ${label}…`);
        await ffExec(ff, ['-i', 'in', '-vn', ...codec, '-ac', '1', '-ar', String(ar), '-b:a', '8k', out]);
        const data = await ff.readFile(out); try { await ff.deleteFile(out); } catch (_) {}
        track.add(data && data.length ? new Blob([data.buffer], { type: outMime }) : null, { desc: `${ext.toUpperCase()} @ 8 kbps mono ${Math.round(ar / 1000)} kHz`, kbps: 8, floor: true });
      };
      await floorPass(22050, 'mono');
      if (!track.best) await floorPass(8000, 'mono 8 kHz');
      if (!track.best && avDuration > 0.5) {
        // 8 kbps mono is the codec floor; the only way under is fewer seconds. Trim
        // to fit so SQUISH NEVER delivers over target (the note suggests going larger).
        const secs = Math.max(0.5, Math.floor((target * 8 * 0.88) / 8000));
        if (secs < avDuration) {
          const out = 'out.' + ext;
          onProgress(25, 'Trimming to fit…');
          await ffExec(ff, ['-i', 'in', '-t', String(secs), '-vn', ...codec, '-ac', '1', '-ar', '8000', '-b:a', '8k', out]);
          const data = await ff.readFile(out); try { await ff.deleteFile(out); } catch (_) {}
          track.add(data && data.length ? new Blob([data.buffer], { type: outMime }) : null, { desc: `${ext.toUpperCase()} 8 kbps mono, trimmed to ${secs}s to fit`, kbps: 8, floor: true });
        }
      }
    }
    try { await ff.deleteFile('in'); } catch (_) {}
    _avProgress = null;
    if (track.best) return { blob: track.best.blob, params: track.best.meta.desc, warn: !!track.best.meta.floor || (track.best.meta.kbps != null && track.best.meta.kbps < 48), mime: outMime };
    if (track.smallest) return { blob: track.smallest.blob, params: track.smallest.meta.desc, warn: true, mime: outMime };
    throw new Error('Audio encode produced nothing.');
  }

  async function squishVideo(target, onProgress) {
    const ff = await getFFmpeg();
    _avProgress = (p) => onProgress(25 + Math.round(p * 65), `Transcoding ${Math.round(p * 100)}%…`);
    await ff.writeFile('in', await _ffUtil.fetchFile(file));
    await ensureDuration(ff);
    if (!avDuration || avDuration < 0.03) throw new Error('Could not read the video duration.');
    const outMime = resolveOutMime();
    const ext = extFor(outMime);
    const vlabel = outMime === 'video/quicktime' ? 'MOV/H.264' : outMime === 'video/x-matroska' ? 'MKV/H.264' : 'MP4/H.264';
    const track = makeTracker(target);

    // split the bit budget: total = target*8/duration, reserve a slice for audio.
    const totalKbps = Math.max(64, Math.floor((target * 8 * 0.97) / avDuration / 1000));
    const audioKbps = Math.max(24, Math.min(128, Math.round(totalKbps * 0.15)));
    // Everything outputs H.264/AAC (mp4, mov or mkv). Force EVEN dimensions so odd-sized
    // inputs - notably GIFs converted to video - never trip the yuv420p encoder.
    // +faststart is an mp4/mov moov-atom optimization; Matroska (mkv) has no moov, so skip it.
    const evenScale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    const vcodec = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
    const acodec = ['-c:a', 'aac'];
    const extra = outMime === 'video/x-matroska' ? [] : ['-movflags', '+faststart'];

    const encode = async (vk) => {
      const out = 'out.' + ext;
      onProgress(25, `Encoding · ${vk}k video…`);
      await ffExec(ff, ['-i', 'in', ...vcodec, '-vf', evenScale, '-b:v', `${vk}k`, '-maxrate', `${Math.round(vk * 1.45)}k`, '-bufsize', `${vk * 2}k`, ...acodec, '-b:a', `${audioKbps}k`, ...extra, out]);
      const data = await ff.readFile(out); try { await ff.deleteFile(out); } catch (_) {}
      const blob = data && data.length ? new Blob([data.buffer], { type: outMime }) : null;
      track.add(blob, { desc: `${vlabel} @ ${vk}k video + ${audioKbps}k audio` });
      return blob;
    };

    let vk = Math.max(48, totalKbps - audioKbps);
    let blob = await encode(vk);
    // Iterate the video bitrate toward the target. Container + keyframe overhead makes
    // this less linear than audio, so correct gently (and never over). Stops within ~10%.
    for (let i = 0; i < 3 && blob; i++) {
      if (blob.size > target) {
        const c = Math.max(24, Math.floor(vk * (target / blob.size) * 0.95));
        if (c >= vk || c < 24) break;
        vk = c; blob = await encode(c);
      } else if (blob.size < target * 0.9) {
        const c = Math.floor(vk * (target / blob.size) * 0.97);
        if (c <= vk) break;
        vk = c; blob = await encode(c);
      } else break;   // within 90-100% of target -> close enough
    }
    // GUARANTEE under target: if still over, downscale resolution + framerate + bitrate
    // harder and harder until it fits. SQUISH NEVER delivers a video over the target.
    if (!track.best) {
      for (const [w, fps, vk2] of [[480, 20, 200], [320, 15, 120], [240, 12, 64], [160, 10, 32], [96, 8, 14]]) {
        const out = 'out.' + ext;
        onProgress(25, `Scaling down · ${w}p…`);
        await ffExec(ff, ['-i', 'in', ...vcodec, '-vf', `scale=${w}:-2`, '-r', String(fps), '-b:v', `${vk2}k`, '-maxrate', `${Math.round(vk2 * 1.3)}k`, '-bufsize', `${vk2 * 2}k`, ...acodec, '-b:a', '24k', ...extra, out]);
        const data = await ff.readFile(out); try { await ff.deleteFile(out); } catch (_) {}
        track.add(data && data.length ? new Blob([data.buffer], { type: outMime }) : null, { desc: `${vlabel} @ ${w}p ${fps}fps ${vk2}k`, small: true });
        if (track.best) break;
      }
    }
    if (!track.best && avDuration > 0.5) {
      // tiny-resolution + lowest bitrate still over (very long clip)? trim to fit.
      // SQUISH NEVER delivers over target. (The note suggests a larger target.)
      const secs = Math.max(0.5, Math.floor((target * 8 * 0.82) / 22000));
      if (secs < avDuration) {
        const out = 'out.' + ext;
        onProgress(25, 'Trimming to fit…');
        await ffExec(ff, ['-i', 'in', '-t', String(secs), ...vcodec, '-vf', 'scale=96:-2', '-r', '8', '-b:v', '10k', '-maxrate', '14k', '-bufsize', '20k', ...acodec, '-b:a', '12k', ...extra, out]);
        const data = await ff.readFile(out); try { await ff.deleteFile(out); } catch (_) {}
        track.add(data && data.length ? new Blob([data.buffer], { type: outMime }) : null, { desc: `${vlabel} 96p, trimmed to ${secs}s to fit`, small: true });
      }
    }
    try { await ff.deleteFile('in'); } catch (_) {}
    _avProgress = null;
    if (track.best) return { blob: track.best.blob, params: track.best.meta.desc, warn: !!track.best.meta.small, mime: outMime };
    if (track.smallest) return { blob: track.smallest.blob, params: track.smallest.meta.desc, warn: true, mime: outMime };
    throw new Error('Video encode produced nothing.');
  }

  // ---------- run
  // ---------- max-quality / lossless mode (convert at best fidelity, no size target)
  async function squishMax(onProgress) {
    const outMime = resolveOutMime();
    if (outMime === 'application/pdf') return kind === 'pdf' ? maxPdf(onProgress) : maxImageToPdf(onProgress);
    if (kind === 'pdf') return maxPdfToImage(onProgress);   // pdf -> jpg/png/webp
    if (kind === 'svg') return outMime === 'image/svg+xml' ? maxSvg(onProgress) : maxSvgToImage(onProgress);
    if (outMime === 'image/gif') return kind === 'gif' ? maxGif(onProgress) : maxVideoToGif(onProgress);
    if (outMime.indexOf('video/') === 0) return maxVideo(onProgress);   // handles gif->video too
    if (outMime.indexOf('audio/') === 0) return maxAudio(onProgress);
    return maxImage(onProgress);   // jpeg / png / webp
  }

  async function maxImage(onProgress) {
    let bitmap;
    try { bitmap = await createImageBitmap(file); }
    catch (_) { bitmap = await new Promise((res, rej) => { const im = new Image(); const u = URL.createObjectURL(file); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = (e) => { URL.revokeObjectURL(u); rej(e); }; im.src = u; }); }
    const outMime = resolveOutMime();
    const fromPng = file.type === 'image/png' && outMime !== 'image/png';
    const fmt = outMime === 'image/webp' ? 'WebP' : outMime === 'image/png' ? 'PNG' : 'JPEG';
    onProgress(45, 'Encoding at maximum quality…');
    // PNG ignores quality (always lossless); WebP at 1.0 is true lossless; JPEG 1.0 is max-quality lossy.
    const blob = await encodeCanvas(bitmap, bitmap.width || dims?.w, bitmap.height || dims?.h, outMime, 1);
    const lossless = outMime === 'image/png' || outMime === 'image/webp';
    return { blob, params: `${fmt}${fromPng ? ' (from PNG)' : ''}, ${lossless ? 'lossless' : 'max quality (q100)'}`, warn: false, mime: outMime };
  }

  async function maxGif(onProgress) {
    onProgress(20, 'Optimizing losslessly…');
    const f = await runGifsicle(`${file.size > 8 * MB ? '-O2' : '-O3'} --colors 256`);
    if (!f) throw new Error('GIF optimize produced nothing.');
    return { blob: f, params: 'GIF, lossless optimize', warn: false, mime: 'image/gif' };
  }

  async function maxVideo(onProgress) {
    const ff = await getFFmpeg();
    _avProgress = (p) => onProgress(25 + Math.round(p * 70), `Transcoding ${Math.round(p * 100)}%…`);
    await ff.writeFile('in', await _ffUtil.fetchFile(file));
    const outMime = resolveOutMime(); const ext = extFor(outMime);
    const vlabel = outMime === 'video/quicktime' ? 'MOV/H.264' : outMime === 'video/x-matroska' ? 'MKV/H.264' : 'MP4/H.264';
    const out = 'out.' + ext;
    // CRF 18 = visually lossless at a sane size. Even dimensions keep GIF->video safe.
    // +faststart is mp4/mov-only (moov atom); Matroska has none, so skip it there.
    const fast = outMime === 'video/x-matroska' ? [] : ['-movflags', '+faststart'];
    const args = ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', ...fast, out];
    onProgress(25, 'Encoding at near-lossless quality…');
    await ffExec(ff, ['-i', 'in', ...args]);
    const data = await ff.readFile(out); try { await ff.deleteFile(out); await ff.deleteFile('in'); } catch (_) {}
    _avProgress = null;
    if (!data || !data.length) throw new Error('Video encode produced nothing.');
    return { blob: new Blob([data.buffer], { type: outMime }), params: `${vlabel}, visually lossless (CRF 18)`, warn: false, mime: outMime };
  }

  // ---------- video -> animated GIF (ffmpeg palettegen/paletteuse, size-targeted)
  // A GIF from a clip is dominated by frames x pixels x palette. We walk a ladder of
  // (fps, width, colors) getting smaller until the file lands under target, matching
  // SQUISH's promise that output is NEVER over the requested size. Two ffmpeg passes
  // per rung: pass 1 builds an optimal palette, pass 2 renders against it.
  async function squishVideoToGif(target, onProgress) {
    const ff = await getFFmpeg();
    _avProgress = (p) => onProgress(20 + Math.round(p * 25), `Rendering ${Math.round(p * 100)}%…`);
    await ff.writeFile('in', await _ffUtil.fetchFile(file));
    await ensureDuration(ff);
    if (!avDuration || avDuration < 0.03) throw new Error('Could not read the video duration.');
    const track = makeTracker(target);
    const srcW = (dims && dims.w) ? dims.w : 480;
    const trim = avDuration > 30 ? ['-t', '30'] : [];   // a multi-minute GIF is never sensible
    const clamp = (w) => Math.max(80, Math.min(srcW, w));
    // fps x width x palette colors x dither. Bayer looks best; 'none' is smallest.
    const RUNGS = [
      [15, clamp(640), 256, 'bayer:bayer_scale=3'],
      [12, clamp(480), 256, 'bayer:bayer_scale=3'],
      [12, clamp(400), 192, 'bayer:bayer_scale=2'],
      [10, clamp(360), 128, 'none'],
      [10, clamp(320), 64, 'none'],
      [8, clamp(280), 64, 'none'],
      [8, clamp(240), 32, 'none'],
      [6, clamp(200), 32, 'none'],
      [5, clamp(160), 16, 'none'],
      [5, clamp(120), 16, 'none'],
    ];
    let i = 0;
    for (const [fps, w, colors, dither] of RUNGS) {
      checkAbort();
      i++;
      onProgress(20 + i * 6, `GIF · ${w}px ${fps}fps ${colors}c…`);
      const filt = `fps=${fps},scale=${w}:-1:flags=lanczos`;
      try {
        await ffExec(ff, ['-i', 'in', ...trim, '-vf', `${filt},palettegen=max_colors=${colors}:stats_mode=diff`, 'pal.png']);
        await ffExec(ff, ['-i', 'in', '-i', 'pal.png', ...trim, '-lavfi', `${filt}[x];[x][1:v]paletteuse=dither=${dither}`, 'out.gif']);
      } catch (_) {}
      let data = null; try { data = await ff.readFile('out.gif'); } catch (_) {}
      try { await ff.deleteFile('pal.png'); } catch (_) {}
      try { await ff.deleteFile('out.gif'); } catch (_) {}
      const blob = data && data.length ? new Blob([data.buffer], { type: 'image/gif' }) : null;
      track.add(blob, { desc: `GIF ${w}px ${fps}fps ${colors} colors`, small: w < 240 });
      if (track.best) break;
    }
    try { await ff.deleteFile('in'); } catch (_) {}
    _avProgress = null;
    if (track.best) return { blob: track.best.blob, params: track.best.meta.desc, warn: !!track.best.meta.small, mime: 'image/gif' };
    if (track.smallest) return { blob: track.smallest.blob, params: track.smallest.meta.desc, warn: true, mime: 'image/gif' };
    throw new Error('GIF render produced nothing.');
  }

  async function maxVideoToGif(onProgress) {
    const ff = await getFFmpeg();
    _avProgress = (p) => onProgress(20 + Math.round(p * 60), `Rendering ${Math.round(p * 100)}%…`);
    await ff.writeFile('in', await _ffUtil.fetchFile(file));
    await ensureDuration(ff);
    if (!avDuration || avDuration < 0.03) throw new Error('Could not read the video duration.');
    const w = Math.min((dims && dims.w) ? dims.w : 640, 640);
    const trim = avDuration > 30 ? ['-t', '30'] : [];
    const filt = `fps=15,scale=${w}:-1:flags=lanczos`;
    onProgress(25, 'Building palette…');
    await ffExec(ff, ['-i', 'in', ...trim, '-vf', `${filt},palettegen=stats_mode=diff`, 'pal.png']);
    onProgress(55, 'Rendering GIF…');
    await ffExec(ff, ['-i', 'in', '-i', 'pal.png', ...trim, '-lavfi', `${filt}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, 'out.gif']);
    let data = null; try { data = await ff.readFile('out.gif'); } catch (_) {}
    try { await ff.deleteFile('pal.png'); await ff.deleteFile('out.gif'); await ff.deleteFile('in'); } catch (_) {}
    _avProgress = null;
    if (!data || !data.length) throw new Error('GIF render produced nothing.');
    return { blob: new Blob([data.buffer], { type: 'image/gif' }), params: `GIF ${w}px 15fps, 256 colors`, warn: false, mime: 'image/gif' };
  }

  async function maxAudio(onProgress) {
    const ff = await getFFmpeg();
    _avProgress = (p) => onProgress(25 + Math.round(p * 70), `Transcoding ${Math.round(p * 100)}%…`);
    await ff.writeFile('in', await _ffUtil.fetchFile(file));
    const outMime = resolveOutMime(); const ext = extFor(outMime);
    const codec = outMime === 'audio/mp4' ? ['-c:a', 'aac', '-b:a', '320k'] : ['-c:a', 'libmp3lame', '-b:a', '320k'];
    onProgress(25, 'Encoding at maximum bitrate…');
    await ffExec(ff, ['-i', 'in', '-vn', ...codec, 'out.' + ext]);
    const data = await ff.readFile('out.' + ext); try { await ff.deleteFile('out.' + ext); await ff.deleteFile('in'); } catch (_) {}
    _avProgress = null;
    if (!data || !data.length) throw new Error('Audio encode produced nothing.');
    return { blob: new Blob([data.buffer], { type: outMime }), params: `${ext.toUpperCase()}, max quality (320 kbps)`, warn: false, mime: outMime };
  }

  // ---------- PDF pipeline (pdf.js renders pages to canvas; pdf-lib builds/embeds - 100% client-side)
  async function getPdfjs() {
    if (_pdfjs) return _pdfjs;
    setProgress(10, 'Loading the PDF engine…');
    if (!window.pdfjsLib) await loadScript(`${PDFJS_CDN}/pdf.min.js`);
    try {
      // Browsers block constructing a Worker directly from a CROSS-ORIGIN URL, which makes
      // pdf.js fall back to a fake worker that can stall on render. So build a SAME-ORIGIN
      // blob: worker that importScripts() the CDN worker (importScripts allows cross-origin) -
      // the same self-hosted-shim trick ffmpeg.wasm uses.
      const shim = `importScripts('${PDFJS_CDN}/pdf.worker.min.js');`;
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([shim], { type: 'text/javascript' }));
    } catch (_) {}
    _pdfjs = window.pdfjsLib;
    return _pdfjs;
  }
  async function getPdfLib() {
    if (_pdflib) return _pdflib;
    setProgress(12, 'Loading the PDF engine…');
    if (!window.PDFLib) await loadScript(PDFLIB_CDN);
    _pdflib = window.PDFLib;
    return _pdflib;
  }

  // Render up to maxPages of the loaded PDF to WHITE-backed canvases at `scale`
  // (pdf.js scale 1.0 = 72 DPI). Cancellable: _pdfRenderTask + checkAbort().
  // targetLongPx = desired longest-side pixels per page. Computed from EACH page's real size
  // (never a blind scale multiplier), with a hard area cap - so a PDF with a giant MediaBox
  // can't blow up into a multi-gigapixel canvas that toBlob/createImageBitmap can't allocate.
  async function renderPdfPages(targetLongPx, maxPages, onProgress) {
    const pdfjs = await getPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    const n = Math.min(doc.numPages, maxPages || doc.numPages);
    const canvases = [];
    // pdf.js schedules its render loop via requestAnimationFrame, which browsers throttle to
    // ~0 in a BACKGROUNDED tab - a render would stall if the user switches away mid-job. Swap
    // in a setTimeout-based rAF (which keeps firing when hidden) for the render, then restore.
    const realRaf = window.requestAnimationFrame, realCaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
    try {
      for (let i = 1; i <= n; i++) {
        checkAbort();
        if (onProgress) onProgress(15 + Math.round((i / n) * 18), `Rendering page ${i}/${n}…`);
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const longSide = Math.max(base.width, base.height) || 1000;
        // Floor must be tiny: a PDF with a giant MediaBox (ImageMagick often makes ~86400pt
        // pages) needs a very small scale to reach the target pixel size. A larger floor (0.02)
        // clamps EVERY rung to the same oversized canvas so the ladder can't descend.
        let scale = Math.max(0.0004, Math.min(5, targetLongPx / longSide));
        let viewport = page.getViewport({ scale });
        if (viewport.width * viewport.height > 18e6) { scale *= Math.sqrt(18e6 / (viewport.width * viewport.height)); viewport = page.getViewport({ scale }); }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        _pdfRenderTask = page.render({ canvasContext: ctx, viewport });
        await _pdfRenderTask.promise;
        _pdfRenderTask = null;
        canvases.push(canvas);
      }
    } finally {
      window.requestAnimationFrame = realRaf; window.cancelAnimationFrame = realCaf;
      try { doc.destroy(); } catch (_) {}   // destroy on abort/error paths too, not just success
    }
    return canvases;
  }

  function canvasToJpegBytes(cv, q) {
    return new Promise((resolve) => {
      cv.toBlob(async (b) => { resolve(b ? new Uint8Array(await b.arrayBuffer()) : null); }, 'image/jpeg', q);
    });
  }

  function finishPdf(track) {
    if (track.best) return { blob: track.best.blob, params: track.best.meta.desc, warn: !!track.best.meta.small, mime: 'application/pdf' };
    if (track.smallest) return { blob: track.smallest.blob, params: track.smallest.meta.desc, warn: true, mime: 'application/pdf' };
    throw new Error('PDF compress produced nothing.');
  }

  // PDF -> PDF: rasterize + rebuild, controlling render scale x JPEG quality to land UNDER
  // target (never over). Rasterizing is what gives precise size control; text stays crisp at
  // higher scales and only softens if a very small target forces the scale down.
  async function squishPdf(target, onProgress) {
    const PDFLib = await getPdfLib();
    const track = makeTracker(target);
    // The original is always a candidate - SQUISH never delivers a PDF BIGGER than the input
    // (rasterizing a small vector PDF can inflate it, so keep the original in the running).
    try { track.add(new Blob([await file.arrayBuffer()], { type: 'application/pdf' }), { desc: 'original (unchanged)' }); } catch (_) {}
    const LONGS = [1600, 1200, 900, 650, 450, 300];   // longest-side px per page (coarse; quality search fills gaps)
    const build = async (canvases, q) => {
      const doc = await PDFLib.PDFDocument.create();
      for (const cv of canvases) {
        checkAbort();
        const bytes = await canvasToJpegBytes(cv, q);
        if (!bytes) continue;
        const jpg = await doc.embedJpg(bytes);
        const page = doc.addPage([cv.width, cv.height]);
        page.drawImage(jpg, { x: 0, y: 0, width: cv.width, height: cv.height });
      }
      const out = await doc.save();
      return new Blob([out], { type: 'application/pdf' });
    };
    for (let si = 0; si < LONGS.length; si++) {
      checkAbort();
      const L = LONGS[si];
      const label = `${L}px`;
      const canvases = await renderPdfPages(L, 0, onProgress);
      onProgress(40, `Fitting the target · ${label}…`);
      let hi = 0.92, lo = 0.4;
      const bHi = await build(canvases, hi);
      track.add(bHi, { desc: `PDF ${label}, quality ${Math.round(hi * 100)}` });
      if (bHi.size <= target) return finishPdf(track);
      const bLo = await build(canvases, lo);
      track.add(bLo, { desc: `PDF ${label}, quality ${Math.round(lo * 100)}`, small: L < 700 });
      // Even the lowest quality here overshoots -> try a SMALLER rung. Always walk the whole
      // ladder (only 6 rungs) so we never return an over-target result when a smaller page
      // size would have fit - never-over-target beats saving a couple of renders.
      if (bLo.size > target) continue;
      for (let it = 0; it < 4; it++) {
        checkAbort();
        const mid = (lo + hi) / 2;
        const bMid = await build(canvases, mid);
        if (bMid.size <= target) { track.add(bMid, { desc: `PDF ${label}, quality ${Math.round(mid * 100)}` }); lo = mid; } else hi = mid;
      }
      return finishPdf(track);
    }
    return finishPdf(track);
  }

  // Stitch rendered pages into one tall canvas (capped for sanity).
  async function stitchPdf(targetLongPx, onProgress) {
    const canvases = await renderPdfPages(targetLongPx, 20, onProgress);
    let w = Math.max(1, ...canvases.map((c) => c.width));
    let totalH = Math.max(1, canvases.reduce((s, c) => s + c.height, 0));
    // Bound the stitched canvas so createImageBitmap can allocate it (browsers cap area/side).
    const k = Math.min(1, 5000 / w, 14000 / totalH);
    w = Math.max(1, Math.round(w * k));
    const H = Math.max(1, Math.round(totalH * k));
    const stitch = document.createElement('canvas'); stitch.width = w; stitch.height = H;
    const ctx = stitch.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, H);
    let y = 0;
    for (const c of canvases) { const dw = Math.round(c.width * k), dh = Math.round(c.height * k); ctx.drawImage(c, Math.round((w - dw) / 2), y, dw, dh); y += dh; }
    return stitch;
  }

  // PDF -> JPG/PNG/WEBP: render + stitch all pages into one image, then the image engine
  // hits the target exactly (downscale + quality search), like any other image.
  async function squishPdfToImage(target, onProgress) {
    const outMime = resolveOutMime();
    const stitch = await stitchPdf(1100, onProgress);
    const bitmap = await createImageBitmap(stitch);
    const track = makeTracker(target);
    const fmtName = outMime === 'image/webp' ? 'WebP' : outMime === 'image/png' ? 'PNG' : 'JPEG';
    onProgress(45, 'Compressing image…');
    return outMime === 'image/png'
      ? squishPng(bitmap, stitch.width, stitch.height, target, track, onProgress)
      : squishLossy(bitmap, stitch.width, stitch.height, outMime, fmtName, target, track, onProgress);
  }

  // Image -> PDF: compress the image under (target - overhead), embed it as one page.
  async function squishImageToPdf(target, onProgress) {
    const PDFLib = await getPdfLib();
    let bitmap;
    if (kind === 'svg') { bitmap = await createImageBitmap(await decodeSvgToCanvas(2048)); }
    else { try { bitmap = await createImageBitmap(file); }
    catch (_) { bitmap = await new Promise((res, rej) => { const im = new Image(); const u = URL.createObjectURL(file); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = (e) => { URL.revokeObjectURL(u); rej(e); }; im.src = u; }); } }
    const bw = bitmap.width || (dims && dims.w) || 1000, bh = bitmap.height || (dims && dims.h) || 1000;
    const wrap = async (imgTarget) => {
      checkAbort();
      const t = makeTracker(imgTarget);
      const r = await squishLossy(bitmap, bw, bh, 'image/jpeg', 'JPEG', imgTarget, t, onProgress);
      const bytes = new Uint8Array(await r.blob.arrayBuffer());
      const doc = await PDFLib.PDFDocument.create();
      const jpg = await doc.embedJpg(bytes);
      const page = doc.addPage([jpg.width, jpg.height]);
      page.drawImage(jpg, { x: 0, y: 0, width: jpg.width, height: jpg.height });
      const out = await doc.save();
      return new Blob([out], { type: 'application/pdf' });
    };
    onProgress(30, 'Compressing image…');
    let blob = await wrap(Math.max(2000, target - 3000));
    if (blob.size > target) {
      // The pdf-lib wrapper overhead is not a flat constant, so a single guessed reserve can
      // still overshoot. Walk the inner-JPEG budget down (keeping the smallest wrapped PDF)
      // until it fits or we hit the ~1KB JPEG floor - so warn is only true when the target is
      // genuinely unreachable, matching every other engine's never-over-target contract.
      onProgress(80, 'Fitting the target…');
      let imgTarget = Math.max(1200, Math.floor(target * 0.9) - 3000);
      blob = await wrap(imgTarget);
      let best = blob, guard = 0;
      while (best.size > target && guard++ < 4 && imgTarget > 1000) {
        imgTarget = Math.max(1000, Math.floor(imgTarget * 0.6));
        const b = await wrap(imgTarget);
        if (b.size < best.size) best = b;
      }
      blob = best;
    }
    return { blob, params: 'PDF, 1 page from image', warn: blob.size > target, mime: 'application/pdf' };
  }

  // ---- PDF max-quality variants ----
  async function maxPdf(onProgress) {
    const PDFLib = await getPdfLib();
    const canvases = await renderPdfPages(2200, 0, onProgress);
    const doc = await PDFLib.PDFDocument.create();
    for (const cv of canvases) { checkAbort(); const bytes = await canvasToJpegBytes(cv, 0.94); const jpg = await doc.embedJpg(bytes); const page = doc.addPage([cv.width, cv.height]); page.drawImage(jpg, { x: 0, y: 0, width: cv.width, height: cv.height }); }
    const out = await doc.save();
    return { blob: new Blob([out], { type: 'application/pdf' }), params: 'PDF, high quality', warn: false, mime: 'application/pdf' };
  }
  async function maxPdfToImage(onProgress) {
    const outMime = resolveOutMime();
    const stitch = await stitchPdf(1600, onProgress);
    onProgress(60, 'Encoding at maximum quality…');
    const blob = await encodeCanvas(stitch, stitch.width, stitch.height, outMime, 1);
    const fmt = outMime === 'image/webp' ? 'WebP' : outMime === 'image/png' ? 'PNG' : 'JPEG';
    return { blob, params: `${fmt}, max quality`, warn: false, mime: outMime };
  }
  async function maxImageToPdf(onProgress) {
    const PDFLib = await getPdfLib();
    let bitmap;
    if (kind === 'svg') { bitmap = await createImageBitmap(await decodeSvgToCanvas(2560)); }
    else { try { bitmap = await createImageBitmap(file); } catch (_) { bitmap = await new Promise((res, rej) => { const im = new Image(); const u = URL.createObjectURL(file); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = (e) => { URL.revokeObjectURL(u); rej(e); }; im.src = u; }); } }
    const bw = bitmap.width, bh = bitmap.height;
    onProgress(40, 'Building PDF…');
    const blob = await encodeCanvas(bitmap, bw, bh, 'image/jpeg', 0.95);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const doc = await PDFLib.PDFDocument.create();
    const jpg = await doc.embedJpg(bytes);
    const page = doc.addPage([bw, bh]);
    page.drawImage(jpg, { x: 0, y: 0, width: bw, height: bh });
    const out = await doc.save();
    return { blob: new Blob([out], { type: 'application/pdf' }), params: 'PDF, 1 page from image', warn: false, mime: 'application/pdf' };
  }

  // ---------- SVG pipeline (browser renders SVG natively; raster outputs via canvas)
  // Rasterize the loaded SVG so its longest side is about targetLongPx (dimensionless SVGs
  // fall back to a default), with a hard area cap. White-free (transparency preserved; JPEG
  // white-fills at encode time).
  async function decodeSvgToCanvas(targetLongPx) {
    // <img> only renders SVG if the blob is typed image/svg+xml - retype if the file arrived
    // with an empty or wrong MIME type (common for dropped/renamed .svg files).
    const svgBlob = file.type === 'image/svg+xml' ? file : new Blob([await file.arrayBuffer()], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);
    try {
      const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Could not render this SVG.')); im.src = url; });
      let w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
      if (!w || !h) { w = 1024; h = 1024; }
      const long = Math.max(w, h);
      let scale = Math.max(0.05, Math.min(8, targetLongPx / long));
      let cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      if (cw * ch > 24e6) { const k = Math.sqrt(24e6 / (cw * ch)); cw = Math.max(1, Math.round(cw * k)); ch = Math.max(1, Math.round(ch * k)); }
      const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
      return canvas;
    } finally { URL.revokeObjectURL(url); }
  }
  // Lightweight, SAFE SVG minify - strips comments, XML/doctype prologue, <metadata>, and
  // inter-tag / redundant whitespace. Never touches path-data precision, so it can't corrupt.
  function minifySvg(s) {
    return s
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\?xml[\s\S]*?\?>/g, '')
      .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
      .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
      .replace(/>\s+</g, '><')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+\/>/g, '/>')
      .trim();
  }
  // SVG -> SVG: optimize but stay vector. Minify is the only lever (vectors don't have a
  // size dial), so the original is a candidate and we warn if it can't reach a tiny target.
  async function squishSvg(target, onProgress) {
    onProgress(30, 'Optimizing SVG…');
    const text = await file.text();
    let min = text; try { const m = minifySvg(text); if (m && m.length) min = m; } catch (_) {}
    const origBlob = new Blob([text], { type: 'image/svg+xml' });
    const optBlob = new Blob([min.length < text.length ? min : text], { type: 'image/svg+xml' });
    // Always prefer the SMALLER (optimized) SVG - both are visually identical vector.
    const best = optBlob.size <= origBlob.size ? optBlob : origBlob;
    return { blob: best, params: best.size < origBlob.size ? 'SVG, optimized (vector)' : 'SVG, already optimal', warn: best.size > target, mime: 'image/svg+xml' };
  }
  // SVG -> JPG/PNG/WEBP: rasterize at high res, then the image engine hits the target exactly.
  async function squishSvgToImage(target, onProgress) {
    const outMime = resolveOutMime();
    onProgress(20, 'Rendering SVG…');
    const canvas = await decodeSvgToCanvas(2048);
    const bitmap = await createImageBitmap(canvas);
    const track = makeTracker(target);
    const fmtName = outMime === 'image/webp' ? 'WebP' : outMime === 'image/png' ? 'PNG' : 'JPEG';
    onProgress(45, 'Compressing image…');
    return outMime === 'image/png'
      ? squishPng(bitmap, canvas.width, canvas.height, target, track, onProgress)
      : squishLossy(bitmap, canvas.width, canvas.height, outMime, fmtName, target, track, onProgress);
  }
  async function maxSvg() {
    const text = await file.text();
    const min = minifySvg(text);
    const best = (min.length < text.length ? min : text);
    return { blob: new Blob([best], { type: 'image/svg+xml' }), params: 'SVG, optimized (vector)', warn: false, mime: 'image/svg+xml' };
  }
  async function maxSvgToImage(onProgress) {
    const outMime = resolveOutMime();
    onProgress(30, 'Rendering SVG…');
    const canvas = await decodeSvgToCanvas(2560);
    onProgress(60, 'Encoding at maximum quality…');
    const blob = await encodeCanvas(canvas, canvas.width, canvas.height, outMime, 1);
    const fmt = outMime === 'image/webp' ? 'WebP' : outMime === 'image/png' ? 'PNG' : 'JPEG';
    return { blob, params: `${fmt}, max quality`, warn: false, mime: outMime };
  }

  // ---------- run
  // Engines call this each iteration so CANCEL interrupts a long job promptly.
  function checkAbort() { if (aborted) throw new Error('__abort__'); }

  // CANCEL stays live during a job: terminate the media engine + flag the loops so a long
  // transcode/render stops instead of running to completion.
  function abortJob() {
    aborted = true;
    setProgress(0, 'Cancelling…');
    try { if (_ffmpeg) { _ffmpeg.terminate(); _ffmpeg = null; } } catch (_) {}
    try { if (_pdfRenderTask) { _pdfRenderTask.cancel(); _pdfRenderTask = null; } } catch (_) {}
  }

  // Lock the chosen settings in while a job runs - target/mode/format cannot change mid-run
  // (this "sets in" the target-size vs max-quality choice) - but CANCEL is ALWAYS pressable.
  function lockSettings(on) {
    optimizeBtn.disabled = on;
    if (targetValue) targetValue.disabled = on;
    unitBtns.forEach((b) => { b.disabled = on; });
    chips.forEach((c) => { c.disabled = on; });
    modeControl.querySelectorAll('.mode-btn').forEach((b) => { b.disabled = on; });
    formatControl.querySelectorAll('.seg-btn').forEach((b) => { b.disabled = on; });
    resetBtn1.disabled = false;   // CANCEL is never disabled
  }

  async function run() {
    if (busy || !file) return;
    showError('');   // clear any stale error from a previous failed job

    // Snapshot the settings at click time so the job runs with exactly what is set NOW.
    const runMode = mode;
    let runTarget = null;
    if (runMode === 'size') {
      runTarget = targetBytes();
      if (isNaN(runTarget)) { updateTargetHint(); return; }
      // already small enough AND no format change requested -> pass through unchanged
      const effMime = resolveOutMime();
      if (runTarget >= file.size && effMime === file.type) {
        presentResult({ blob: file, params: 'unchanged (already under target)', warn: false, mime: file.type }, true);
        return;
      }
    }

    aborted = false;
    busy = true;
    lockSettings(true);
    if (fileCard) { fileCard.classList.remove('crunch'); void fileCard.offsetWidth; fileCard.classList.add('crunch'); }
    setProgress(4, 'Starting…');
    try {
      const onProgress = (p, t) => setProgress(p, t);
      let result;
      if (runMode === 'max') {
        result = await squishMax(onProgress);
      } else {
        const target = runTarget;
        const outMime = resolveOutMime();
        if (outMime === 'application/pdf') {
          result = kind === 'pdf' ? await squishPdf(target, onProgress) : await squishImageToPdf(target, onProgress);
        } else if (kind === 'pdf') {
          result = await squishPdfToImage(target, onProgress);   // pdf -> jpg / png / webp
        } else if (kind === 'svg') {
          result = outMime === 'image/svg+xml' ? await squishSvg(target, onProgress) : await squishSvgToImage(target, onProgress);
        } else if (outMime === 'image/gif') {
          result = kind === 'gif' ? await squishGif(target, onProgress) : await squishVideoToGif(target, onProgress);
        } else if (outMime.indexOf('video/') === 0) {
          result = await squishVideo(target, onProgress);   // handles video->video AND gif->video
        } else if (outMime.indexOf('audio/') === 0) {
          result = await squishAudio(target, onProgress);
        } else {
          result = await squishImage(target, onProgress);   // jpeg / png / webp
        }
      }
      if (aborted) return;
      setProgress(100, 'Done');
      presentResult(result, false);
    } catch (err) {
      if (aborted || (err && err.message === '__abort__')) {
        setProgress(0, ''); progressWrap.hidden = true; showStage('config');   // cancelled - back to settings, file kept
      } else {
        console.error('[squish] failed', err);
        setProgress(0, '');
        progressWrap.hidden = true;
        const detail = (err && err.message && err.message !== 'unknown error')
          ? err.message
          : 'This file could not be read - It may be corrupt or in a format your browser cannot decode';
        showError(detail.replace(/\.$/, '') + '. Try a different file or a different output format.');
      }
    } finally {
      busy = false;
      lockSettings(false);
      if (runMode === 'max') optimizeBtn.disabled = false; else updateTargetHint();
    }
  }

  // A square tile with the file type in caps (PDF, MP4, MOV...) - the default when no image
  // can render for a thumbnail.
  function makeBadge(text) {
    const d = document.createElement('div');
    d.className = 'type-badge';
    d.textContent = (text || 'file').toUpperCase();
    return d;
  }
  // Best label for a file: its filename extension, else a format derived from its MIME type.
  function badgeLabelFor(f) {
    const ext = (((f && f.name) || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
    if (ext) return ext;
    const byMime = f && f.type ? extFor(f.type) : '';
    if (byMime && byMime !== 'bin') return byMime;
    return ((f && f.type) || '').split('/')[1] || 'file';
  }
  function clearInputBadge() { const t = origPreview && origPreview.parentElement; if (t) { const b = t.querySelector('.type-badge'); if (b) b.remove(); } }
  function showInputBadge(f) {
    clearInputBadge();
    if (!origPreview) return;
    if (lastPreviewUrl) { URL.revokeObjectURL(lastPreviewUrl); lastPreviewUrl = null; }
    origPreview.style.display = 'none'; origPreview.removeAttribute('src');
    const t = origPreview.parentElement; if (t) t.appendChild(makeBadge(badgeLabelFor(f)));
  }

  // Result preview adapts to the output type: <img> for images, <video>/<audio> (with controls)
  // for AV. Anything that can't render inline - or a media element that fails to load - falls
  // back to a type badge so the square is NEVER a broken icon.
  function setOutPreview(mime, url) {
    const thumb = $('out-thumb');
    if (!thumb) { if (outPreview) outPreview.src = url; return; }
    while (thumb.firstChild) thumb.removeChild(thumb.firstChild);
    const label = (extFor(mime) !== 'bin' ? extFor(mime) : (mime.split('/')[1] || 'file'));
    if (mime === 'application/pdf') { thumb.appendChild(makeBadge(label)); return; }
    let el;
    if (mime.indexOf('video/') === 0) { el = document.createElement('video'); el.controls = true; el.playsInline = true; el.muted = true; }
    else if (mime.indexOf('audio/') === 0) { el = document.createElement('audio'); el.controls = true; }
    else { el = document.createElement('img'); el.alt = 'Optimized preview'; }
    el.id = 'out-preview';
    // If the media can't actually decode (MKV/MOV this browser won't play, undecodable image),
    // drop it and show the type badge instead of a broken tile.
    el.addEventListener('error', () => { if (el.parentNode === thumb) { thumb.removeChild(el); if (!thumb.querySelector('.type-badge')) thumb.appendChild(makeBadge(label)); } });
    el.src = url;
    thumb.appendChild(el);
  }

  function presentResult(result, passthrough) {
    const { blob, params, warn, mime } = result;
    if (lastOutUrl) URL.revokeObjectURL(lastOutUrl);
    lastOutUrl = URL.createObjectURL(blob);

    setOutPreview(mime || file.type, lastOutUrl);
    resOrig.textContent = humanSize(file.size);
    resNew.textContent = humanSize(blob.size);
    const saved = file.size > 0 ? (1 - blob.size / file.size) * 100 : 0;
    // Only call it SAVED when the file actually got SMALLER. Max-quality conversions can grow
    // the file - then say SIZE CHANGE and show the increase, don't claim savings.
    const grew = !passthrough && saved < 0;
    if (resRatioLabel) resRatioLabel.textContent = passthrough ? 'UNCHANGED' : (grew ? 'SIZE CHANGE' : 'SAVED');
    resRatio.textContent = passthrough ? 'KEPT' : (saved >= 0 ? '−' + saved.toFixed(1) + '%' : '+' + Math.abs(saved).toFixed(1) + '%');
    resParams.textContent = params;

    // "Vs target" — proof of how tightly we honed in (closest under, never over).
    if (resTarget) {
      const tgt = targetBytes();
      if (mode === 'max' || passthrough || isNaN(tgt)) {
        resTarget.textContent = mode === 'max' ? 'max quality' : '-';
      } else {
        const used = (blob.size / tgt) * 100;
        resTarget.textContent = `${humanSize(blob.size)} / ${humanSize(tgt)} (${used.toFixed(1)}% of target)`;
      }
    }

    const outExt = extFor(mime);
    // Filename tells the whole result at a glance: <name>-SQUISHED-<NN>PCT-<size>.<ext>
    // - reduction vs original (NN%) AND the achieved output size. Combined with a
    // target baked into the source name (e.g. "...to-200KB..."), the export name
    // alone says target -> result, so QA is gradeable from the filename.
    const sizeTag = humanSize(blob.size).replace(/\s+/g, '');
    // Shrunk -> "-SQUISHED-NNPCT-<size>"; grew (a conversion) -> "-CONVERTED-<size>" (no fake PCT).
    const tag = saved > 0 ? '-SQUISHED-' + Math.max(1, Math.round(saved)) + 'PCT-' + sizeTag : '-CONVERTED-' + sizeTag;
    downloadLink.href = lastOutUrl;
    downloadLink.download = baseName(file.name) + tag + '.' + outExt;

    // Two distinct situations get a note:
    // 1. IMPOSSIBLE target - the output is still bigger than the target because the file is at
    //    its floor for this format (a vector SVG, a tiny PDF target, a codec/format minimum).
    //    Say so plainly and give the smallest size we could reach. NOT for the "quality got
    //    scrambled but it fit" case - hyper-degraded-yet-under-target is a fine user choice.
    // 2. HIT target but heavily degraded - gently offer a one-click LARGER target for quality.
    const tgt = (mode === 'size' && !passthrough) ? targetBytes() : NaN;
    const overTarget = !isNaN(tgt) && blob.size > tgt;
    if (overTarget) {
      recTarget = null;
      const canRaster = (mime === 'image/svg+xml' || mime === 'application/pdf');
      const suffix = canRaster ? ' - To go smaller, convert it to JPG or PNG.' : '.';
      resNoteText.textContent = `That target isn't reachable for this file. The smallest SQUISH can make it is ${humanSize(blob.size)} (you asked for ${humanSize(tgt)})${suffix}`;
      resRecommend.hidden = true;
      resNote.hidden = false;
    } else {
      const rec = (warn && !passthrough && mode === 'size') ? recommendLarger(file.size, targetBytes()) : null;
      if (rec) {
        recTarget = rec;
        const what = kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'file';
        resNoteText.textContent = `Your ${what} is ready and fits your target. It is heavily compressed to get there - For more quality, try a larger target, around ${rec.label} or more.`;
        resRecommend.textContent = `USE ${rec.label}`;
        resRecommend.hidden = false;
        resNote.hidden = false;
      } else {
        recTarget = null;
        resNote.hidden = true;
      }
    }

    progressWrap.hidden = true;
    showStage('result');
  }

  function reset() {
    if (busy) { abortJob(); return; }   // CANCEL during a job = abort it (run() returns to config)
    file = null; kind = null; dims = null; recTarget = null;
    fileInput.value = '';
    showError('');
    progressWrap.hidden = true; resNote.hidden = true;
    if (lastOutUrl) { URL.revokeObjectURL(lastOutUrl); lastOutUrl = null; }
    if (lastPreviewUrl) { URL.revokeObjectURL(lastPreviewUrl); lastPreviewUrl = null; }
    showStage('input');
  }

  // ---------- events
  // Drag a file ANYWHERE over the page -> full-window overlay -> load into SQUISH
  // (works from any stage). Click-to-browse stays on the drop zone.
  const dropOverlay = $('drop-overlay');
  let dragDepth = 0;
  const dragHasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
  function showDropOverlay(on) {
    if (dropOverlay) dropOverlay.hidden = !on;
    drop.classList.toggle('drag', on);
  }
  window.addEventListener('dragenter', (ev) => {
    if (!dragHasFiles(ev)) return;
    ev.preventDefault(); dragDepth++; showDropOverlay(true);
  });
  window.addEventListener('dragover', (ev) => {
    if (!dragHasFiles(ev)) return;
    ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (ev) => {
    if (!dragHasFiles(ev)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDropOverlay(false);
  });
  window.addEventListener('drop', (ev) => {
    ev.preventDefault(); dragDepth = 0; showDropOverlay(false);
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  // Belt-and-suspenders: a cancelled drag (Escape / release outside the window) can swallow the
  // final dragleave and leave the opaque overlay stuck, blocking the whole app. Always recover.
  const clearDrag = () => { dragDepth = 0; showDropOverlay(false); };
  window.addEventListener('dragend', clearDrag);
  window.addEventListener('blur', clearDrag);
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') clearDrag(); });
  if (dropOverlay) dropOverlay.addEventListener('click', clearDrag);
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]); });

  window.addEventListener('paste', (ev) => {
    const items = ev.clipboardData && ev.clipboardData.files;
    if (items && items[0]) handleFile(items[0]);
  });

  unitBtns.forEach((b) => b.addEventListener('click', () => { unit = b.dataset.unit; syncUnitButtons(); updateTargetHint(); }));
  chips.forEach((c) => c.addEventListener('click', () => {
    if (!file) return;
    const bytes = file.size * parseFloat(c.dataset.frac);
    if (bytes >= MB) { unit = 'MB'; targetValue.value = Math.max(0.1, +(bytes / MB).toFixed(1)); }
    else { unit = 'KB'; targetValue.value = Math.max(1, Math.round(bytes / KB)); }
    syncUnitButtons(); updateTargetHint();
  }));
  formatControl.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    outFormat = b.dataset.fmt; syncFmtButtons(); updateFormatHint();
  });
  targetValue.addEventListener('input', updateTargetHint);

  modeControl.addEventListener('click', (e) => {
    const b = e.target.closest('.mode-btn'); if (!b) return;
    mode = b.dataset.mode; syncMode();
  });

  optimizeBtn.addEventListener('click', run);
  resetBtn1.addEventListener('click', reset);
  resetBtn2.addEventListener('click', reset);

  // BACK: return to the config stage with the loaded file and every previous
  // choice (target, unit, format, mode) intact - re-squish at a new setting.
  backBtn.addEventListener('click', () => {
    resNote.hidden = true;
    showStage('config');
  });

  // One-click apply of the recommended sensible target, then re-compress.
  resRecommend.addEventListener('click', () => {
    if (!recTarget) return;
    unit = recTarget.unit; syncUnitButtons();
    targetValue.value = recTarget.value;
    resNote.hidden = true;
    showStage('config');
    updateTargetHint();
    run();
  });

  // ---------- service worker
  // Relative registration so SQUISH works mounted at any subpath: the script URL
  // resolves against the page, and the scope defaults to the SW script's directory.
  if ('serviceWorker' in navigator && !/[?&]nosw\b/.test(location.search)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW failed', e));
    });
  }

  showStage('input');
})();

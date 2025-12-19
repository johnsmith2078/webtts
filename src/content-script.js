(() => {
  // Guard against multiple injections.
  if (window.__webTtsHelperInjected) return;
  window.__webTtsHelperInjected = true;

  const state = {
    currentText: "",
    currentRange: null,
    utterance: null,
    isSpeaking: false,
    highlighter: null
  };

  const shadowHost = document.createElement("div");
  shadowHost.setAttribute("data-web-tts-helper", "host");
  shadowHost.style.all = "initial";
  shadowHost.style.position = "fixed";
  shadowHost.style.zIndex = "2147483647";
  shadowHost.style.pointerEvents = "none";

  const shadowRoot = shadowHost.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host {
      pointer-events: none;
    }
    button {
      all: unset;
      pointer-events: auto;
      width: 36px;
      height: 36px;
      border-radius: 18px;
      background: #ffffff;
      color: #111827;
      border: 1px solid rgba(0,0,0,0.08);
      box-shadow: 0 4px 14px rgba(0,0,0,0.12);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      cursor: pointer;
      transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease;
    }
    button:hover {
      transform: translateY(-1px) scale(1.02);
      box-shadow: 0 8px 18px rgba(0,0,0,0.16);
    }
    button:active {
      transform: translateY(0) scale(0.99);
      box-shadow: 0 2px 10px rgba(0,0,0,0.16);
    }
    [data-web-tts-helper="highlight-layer"] {
      pointer-events: none;
      position: fixed;
      left: 0;
      top: 0;
      width: 0;
      height: 0;
    }
    .highlight-box {
      position: fixed;
      pointer-events: none;
      background: rgba(255, 235, 59, 0.42);
      border-radius: 4px;
      box-shadow: 0 0 0 1px rgba(17, 24, 39, 0.12);
    }
  `;
  shadowRoot.appendChild(style);

  const highlightLayer = document.createElement("div");
  highlightLayer.setAttribute("data-web-tts-helper", "highlight-layer");
  shadowRoot.appendChild(highlightLayer);

  const button = document.createElement("button");
  button.type = "button";
  button.title = "朗读选中内容";
  button.textContent = "▶";
  button.style.display = "none";
  button.style.position = "fixed";
  button.style.left = "0px";
  button.style.top = "0px";

  shadowRoot.appendChild(button);
  document.documentElement.appendChild(shadowHost);

  let hideTimer = null;

  const DEFAULT_GTTS_LANG = "en";
  const DEFAULT_GTTS_TLD = "com";

  function guessLanguageTagByScript(text) {
    const s = String(text || "");
    if (/[\u3040-\u30ff\uff66-\uff9d]/.test(s)) return "ja";
    if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(s)) return "ko";
    if (/[\u4e00-\u9fff]/.test(s)) return "zh";
    if (/[\u0400-\u04ff]/.test(s)) return "ru";
    if (/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/.test(s)) return "ar";
    if (/[\u0590-\u05ff]/.test(s)) return "he";
    if (/[\u0900-\u097f]/.test(s)) return "hi";
    if (/[\u0980-\u09ff]/.test(s)) return "bn";
    if (/[\u0b80-\u0bff]/.test(s)) return "ta";
    if (/[\u0e00-\u0e7f]/.test(s)) return "th";
    return "";
  }

  function detectLanguageWithChrome(text) {
    return new Promise((resolve) => {
      const detector = chrome?.i18n?.detectLanguage;
      if (typeof detector !== "function") {
        resolve("");
        return;
      }

      // Avoid huge inputs; Chrome's detector works fine on a prefix.
      const sample = String(text || "").slice(0, 2000);
      detector(sample, (result) => {
        if (chrome?.runtime?.lastError) {
          resolve("");
          return;
        }
        const languages = result?.languages;
        if (!Array.isArray(languages) || !languages.length) {
          resolve("");
          return;
        }

        let best = null;
        for (const item of languages) {
          if (!item || !item.language || item.language === "und") continue;
          if (!best || (Number(item.percentage) || 0) > (Number(best.percentage) || 0)) {
            best = item;
          }
        }
        resolve(best?.language || "");
      });
    });
  }

  function sanitizeText(text) {
    return String(text || "")
      .replace(/[&<>]/g, " ")
      .replace(/[\u0000-\u0008\u000B-\u001F]/g, " ")
      .replace(/[\r\n]/g, " ");
  }

  function getUserSettings() {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) {
        resolve({
          gttsLanguage: "__auto__",
          gttsTld: DEFAULT_GTTS_TLD,
          gttsSlow: false,
          ratePercent: 0,
          volumePercent: 0
        });
        return;
      }
      chrome.storage.sync.get(
        {
          gttsLanguage: "__auto__",
          gttsTld: DEFAULT_GTTS_TLD,
          gttsSlow: false,
          ratePercent: 0,
          volumePercent: 0
        },
        resolve
      );
    });
  }

  function sendMessageToBackground(message) {
    return new Promise((resolve, reject) => {
      const sender = chrome?.runtime?.sendMessage;
      if (typeof sender !== "function") {
        reject(new Error("chrome.runtime.sendMessage unavailable"));
        return;
      }

      sender(message, (response) => {
        if (chrome?.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "sendMessage failed"));
          return;
        }
        resolve(response);
      });
    });
  }

  function sendGttsCancel(requestId) {
    const sender = chrome?.runtime?.sendMessage;
    if (typeof sender !== "function") return;
    sender({ type: "gttsCancel", requestId }, () => {
      // ignore errors
    });
  }

  function concatUint8Arrays(chunks) {
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged;
  }

  function base64ToUint8Array(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function normalizeAudioBuffer(value) {
    if (!value) return null;
    if (value instanceof ArrayBuffer) return value;

    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }

    return null;
  }

  function looksLikeMp3(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 3) return false;
    const hasId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const hasFrameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    return hasId3 || hasFrameSync;
  }

  const GTTS_LANGUAGE_ALIASES = {
    fil: "tl",
    he: "iw",
    in: "id",
    jv: "jw"
  };

  const GTTS_LANG_ALLOWLIST = new Set(["fr-CA", "pt-PT", "zh", "zh-CN", "zh-TW"]);

  const DEPRECATED_GTTS_LANG_FALLBACK = {
    "en-us": "en",
    "en-ca": "en",
    "en-uk": "en",
    "en-gb": "en",
    "en-au": "en",
    "en-gh": "en",
    "en-in": "en",
    "en-ie": "en",
    "en-nz": "en",
    "en-ng": "en",
    "en-ph": "en",
    "en-za": "en",
    "en-tz": "en",
    "fr-fr": "fr",
    "pt-br": "pt",
    "pt-pt": "pt",
    "es-es": "es",
    "es-us": "es",
    "zh-cn": "zh-CN",
    "zh-tw": "zh-TW"
  };

  function normalizeGttsLang(tag) {
    const raw = String(tag || "").trim();
    if (!raw) return "";

    const lower = raw.toLowerCase();
    if (lower === "zh-hans") return "zh-CN";
    if (lower === "zh-hant") return "zh-TW";

    const parts = lower.split("-");
    const base = GTTS_LANGUAGE_ALIASES[parts[0]] || parts[0];
    const rest = parts
      .slice(1)
      .map((p) => (p.length === 2 ? p.toUpperCase() : p));
    const normalized = [base, ...rest].join("-");

    const deprecatedFallback = DEPRECATED_GTTS_LANG_FALLBACK[normalized.toLowerCase()];
    if (deprecatedFallback) return deprecatedFallback;

    if (GTTS_LANG_ALLOWLIST.has(normalized)) return normalized;
    return base;
  }

  async function detectGttsLang(text) {
    const trimmed = String(text || "").trim();
    const nav = normalizeGttsLang(navigator.language) || DEFAULT_GTTS_LANG;
    if (!trimmed) return nav;

    const chromeTag = await detectLanguageWithChrome(trimmed);
    const guessedTag = chromeTag || guessLanguageTagByScript(trimmed) || navigator.language || DEFAULT_GTTS_LANG;
    return normalizeGttsLang(guessedTag) || nav;
  }

  function computePlaybackRate(ratePercent) {
    const num = Number(ratePercent) || 0;
    const rate = 1 + num / 100;
    if (!Number.isFinite(rate) || rate <= 0) return 1;
    return Math.max(0.25, Math.min(3, rate));
  }

  function computeVolumeGain(volumePercent) {
    const num = Number(volumePercent) || 0;
    const gain = 1 + num / 100;
    if (!Number.isFinite(gain) || gain < 0) return 1;
    return Math.max(0, Math.min(3, gain));
  }

  function trimTextForSpeech(text) {
    const raw = String(text || "");
    const leadingMatch = raw.match(/^\s*/);
    const trailingMatch = raw.match(/\s*$/);
    const leading = leadingMatch ? leadingMatch[0].length : 0;
    const trailing = trailingMatch ? trailingMatch[0].length : 0;
    const end = Math.max(leading, raw.length - trailing);
    return { trimmedText: raw.slice(leading, end), trimOffset: leading };
  }

  const CJK_RE =
    /[\u3040-\u30ff\uff66-\uff9d\uac00-\ud7af\u1100-\u11ff\u3130-\u318f\u4e00-\u9fff]/;
  const HAS_SPACE_RE = /\s/;

  function computeHighlightRange(text, index) {
    const s = String(text || "");
    const len = s.length;
    if (!len) return null;

    let i = Number(index);
    if (!Number.isFinite(i)) i = 0;
    i = Math.max(0, Math.min(len - 1, Math.floor(i)));

    if (/\s/.test(s[i])) {
      let left = i - 1;
      let right = i + 1;
      while (left >= 0 || right < len) {
        if (left >= 0 && !/\s/.test(s[left])) {
          i = left;
          break;
        }
        if (right < len && !/\s/.test(s[right])) {
          i = right;
          break;
        }
        left -= 1;
        right += 1;
      }
    }

    const hasSpaces = HAS_SPACE_RE.test(s);
    const isCjk = CJK_RE.test(s);

    if (!hasSpaces || isCjk) {
      return { start: i, end: Math.min(len, i + 1) };
    }

    let start = i;
    while (start > 0 && !/\s/.test(s[start - 1])) start -= 1;
    let end = i + 1;
    while (end < len && !/\s/.test(s[end])) end += 1;
    if (end <= start) return null;
    return { start, end };
  }

  function createRequestId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  class GttsSession {
    constructor(
      text,
      { lang, tld, slow = false, playbackRate = 1, volumeGain = 1, trimOffset = 0, highlighter = null }
    ) {
      this.text = String(text || "");
      this.lang = normalizeGttsLang(lang) || DEFAULT_GTTS_LANG;
      this.tld = String(tld || DEFAULT_GTTS_TLD).trim() || DEFAULT_GTTS_TLD;
      this.slow = Boolean(slow);

      const rateNum = Number(playbackRate);
      this.playbackRate = Number.isFinite(rateNum) && rateNum > 0 ? Math.max(0.25, Math.min(3, rateNum)) : 1;

      const gainNum = Number(volumeGain);
      this.volumeGain = Number.isFinite(gainNum) ? Math.max(0, Math.min(3, gainNum)) : 1;
      this.trimOffset = Number(trimOffset) || 0;
      this.highlighter = highlighter;

      this.requestId = createRequestId();
      this.cancelled = false;

      this.audioEl = null;
      this.audioUrl = "";
      this.audioContext = null;
      this.boundaryRaf = 0;
      this.playResolve = null;
      this.playReject = null;
    }

    cancel() {
      this.cancelled = true;
      if (this.boundaryRaf) {
        cancelAnimationFrame(this.boundaryRaf);
        this.boundaryRaf = 0;
      }
      if (this.requestId) sendGttsCancel(this.requestId);
      this.cleanupAudio();
      if (this.playResolve) {
        try {
          this.playResolve();
        } catch (_) {
          // ignore
        }
        this.playResolve = null;
        this.playReject = null;
      }
    }

    cleanupAudio() {
      if (this.audioEl) {
        try {
          this.audioEl.pause();
          this.audioEl.src = "";
        } catch (_) {
          // ignore
        }
        this.audioEl = null;
      }

      if (this.audioUrl) {
        try {
          URL.revokeObjectURL(this.audioUrl);
        } catch (_) {
          // ignore
        }
        this.audioUrl = "";
      }

      if (this.audioContext) {
        try {
          this.audioContext.close();
        } catch (_) {
          // ignore
        }
        this.audioContext = null;
      }
    }

    async start() {
      const response = await sendMessageToBackground({
        type: "gttsSynthesize",
        requestId: this.requestId,
        text: this.text,
        lang: this.lang,
        tld: this.tld,
        slow: this.slow
      });

      if (this.cancelled) return;
      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "gTTS synthesis failed");
      }

      let audioBuffer = normalizeAudioBuffer(response.audioBuffer);
      if (!audioBuffer) {
        const base64Chunks = response.audioBase64Chunks;
        if (Array.isArray(base64Chunks) && base64Chunks.length) {
          const chunks = base64Chunks.map((b64) => base64ToUint8Array(String(b64 || "")));
          audioBuffer = concatUint8Arrays(chunks).buffer;
        }
      }

      if (!audioBuffer || audioBuffer.byteLength <= 0) throw new Error("gTTS missing audio");
      if (!looksLikeMp3(audioBuffer)) {
        throw new Error(`gTTS returned non-MP3 data (size=${audioBuffer.byteLength})`);
      }

      await this.playAudio(audioBuffer);
    }

    applyVolume(audio) {
      const gain = Number(this.volumeGain);
      if (!Number.isFinite(gain) || gain < 0) return;

      if (gain <= 1) {
        audio.volume = gain;
        return;
      }

      audio.volume = 1;
      try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) return;

        const ctx = new AudioContextCtor();
        const source = ctx.createMediaElementSource(audio);
        const gainNode = ctx.createGain();
        gainNode.gain.value = gain;
        source.connect(gainNode);
        gainNode.connect(ctx.destination);
        this.audioContext = ctx;
      } catch (_) {
        // ignore
      }
    }

    startProgressTracking() {
      const audio = this.audioEl;
      const highlighter = this.highlighter;
      if (!audio || !highlighter || !this.text) return;

      let lastStart = -1;
      let lastEnd = -1;

      const initialRange = computeHighlightRange(this.text, 0);
      if (initialRange) {
        lastStart = this.trimOffset + initialRange.start;
        lastEnd = this.trimOffset + initialRange.end;
        highlighter.highlightOffsets(lastStart, lastEnd);
      }

      const tick = () => {
        if (this.cancelled || !this.audioEl) return;
        if (audio.ended || audio.paused) return;

        const duration = audio.duration;
        if (Number.isFinite(duration) && duration > 0) {
          const ratio = Math.max(0, Math.min(1, audio.currentTime / duration));
          const idx = Math.min(this.text.length - 1, Math.floor(ratio * this.text.length));
          const range = computeHighlightRange(this.text, idx);
          if (range) {
            const start = this.trimOffset + range.start;
            const end = this.trimOffset + range.end;
            if (start !== lastStart || end !== lastEnd) {
              lastStart = start;
              lastEnd = end;
              highlighter.highlightOffsets(start, end);
            }
          }
        }

        this.boundaryRaf = requestAnimationFrame(tick);
      };

      this.boundaryRaf = requestAnimationFrame(tick);
    }

    async playAudio(audioBuffer) {
      const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
      const audioUrl = URL.createObjectURL(blob);
      this.audioUrl = audioUrl;

      const audio = new Audio(audioUrl);
      this.audioEl = audio;
      audio.playbackRate = this.playbackRate;
      this.applyVolume(audio);

      return new Promise((resolve, reject) => {
        this.playResolve = resolve;
        this.playReject = reject;

        audio.onended = () => {
          this.playResolve = null;
          this.playReject = null;
          this.cleanupAudio();
          resolve();
        };
        audio.onerror = () => {
          this.playResolve = null;
          this.playReject = null;
          this.cleanupAudio();
          const code = audio.error && typeof audio.error.code === "number" ? audio.error.code : 0;
          reject(new Error(`audio playback failed (code=${code})`));
        };

        audio
          .play()
          .then(() => {
            this.startProgressTracking();
          })
          .catch((e) => {
            this.playResolve = null;
            this.playReject = null;
            this.cleanupAudio();
            reject(e);
          });
      });
    }
  }

  function rangeIntersectsNode(range, node) {
    if (typeof range.intersectsNode === "function") {
      try {
        return range.intersectsNode(node);
      } catch (_) {
        return false;
      }
    }
    try {
      const nodeRange = document.createRange();
      nodeRange.selectNode(node);
      return (
        range.compareBoundaryPoints(Range.END_TO_START, nodeRange) > 0 &&
        range.compareBoundaryPoints(Range.START_TO_END, nodeRange) < 0
      );
    } catch (_) {
      return false;
    }
  }

  function getNodeIndex(node) {
    let i = 0;
    let cur = node;
    while (cur && cur.previousSibling) {
      i += 1;
      cur = cur.previousSibling;
    }
    return i;
  }

  function createRangeTextMap(range) {
    const pieces = [];
    const chunks = [];
    let totalLength = 0;

    function addTextPiece(node, startOffset, endOffset) {
      const text = node.nodeValue?.slice(startOffset, endOffset) || "";
      if (!text) return;
      const startIndex = totalLength;
      const endIndex = startIndex + text.length;
      pieces.push({ type: "text", node, startOffset, startIndex, endIndex });
      chunks.push(text);
      totalLength = endIndex;
    }

    function addBrPiece(br) {
      const parent = br.parentNode;
      if (!parent) return;
      const startIndex = totalLength;
      const endIndex = startIndex + 1;
      pieces.push({
        type: "br",
        afterContainer: parent,
        afterOffset: getNodeIndex(br) + 1,
        startIndex,
        endIndex
      });
      chunks.push("\n");
      totalLength = endIndex;
    }

    const root = range.commonAncestorContainer;

    function considerNode(node) {
      if (!rangeIntersectsNode(range, node)) return;

      if (node.nodeType === Node.TEXT_NODE) {
        const textLength = node.nodeValue?.length || 0;
        if (!textLength) return;
        let startOffset = 0;
        let endOffset = textLength;
        if (node === range.startContainer) startOffset = range.startOffset;
        if (node === range.endContainer) endOffset = range.endOffset;
        if (startOffset < 0) startOffset = 0;
        if (endOffset > textLength) endOffset = textLength;
        if (startOffset >= endOffset) return;
        addTextPiece(node, startOffset, endOffset);
        return;
      }

      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") {
        addBrPiece(node);
      }
    }

    if (root.nodeType === Node.TEXT_NODE) {
      considerNode(root);
    } else {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (!rangeIntersectsNode(range, node)) return NodeFilter.FILTER_REJECT;
            if (node.nodeType === Node.TEXT_NODE) {
              return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            }
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          }
        }
      );

      let node = walker.nextNode();
      while (node) {
        considerNode(node);
        node = walker.nextNode();
      }
    }

    function findPieceForIndex(index) {
      let low = 0;
      let high = pieces.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const piece = pieces[mid];
        if (index < piece.startIndex) {
          high = mid - 1;
        } else if (index >= piece.endIndex) {
          low = mid + 1;
        } else {
          return piece;
        }
      }
      return null;
    }

    function indexToDomPosition(index) {
      if (index <= 0) {
        return { container: range.startContainer, offset: range.startOffset };
      }
      if (index >= totalLength) {
        return { container: range.endContainer, offset: range.endOffset };
      }

      const piece = findPieceForIndex(index);
      if (!piece) return { container: range.endContainer, offset: range.endOffset };

      const delta = index - piece.startIndex;
      if (piece.type === "text") {
        return { container: piece.node, offset: piece.startOffset + delta };
      }
      if (piece.type === "br") {
        return { container: piece.afterContainer, offset: piece.afterOffset };
      }
      return { container: range.endContainer, offset: range.endOffset };
    }

    function rangeForOffsets(start, end) {
      const clampedStart = Math.max(0, Math.min(totalLength, start));
      const clampedEnd = Math.max(0, Math.min(totalLength, end));
      const s = Math.min(clampedStart, clampedEnd);
      const e = Math.max(clampedStart, clampedEnd);

      const startPos = indexToDomPosition(s);
      const endPos = indexToDomPosition(e);
      const r = document.createRange();
      r.setStart(startPos.container, startPos.offset);
      r.setEnd(endPos.container, endPos.offset);
      return r;
    }

    return {
      text: chunks.join(""),
      length: totalLength,
      rangeForOffsets
    };
  }

  function createSelectionHighlighter(textMap) {
    const boxes = [];
    let activeRange = null;

    function hideAll() {
      boxes.forEach((b) => {
        b.style.display = "none";
      });
    }

    function updateFromRange(range) {
      let rects = [];
      try {
        rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      } catch (_) {
        rects = [];
      }

      for (let i = 0; i < rects.length; i += 1) {
        const rect = rects[i];
        let box = boxes[i];
        if (!box) {
          box = document.createElement("div");
          box.className = "highlight-box";
          highlightLayer.appendChild(box);
          boxes.push(box);
        }
        box.style.display = "block";
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
      }

      for (let i = rects.length; i < boxes.length; i += 1) {
        boxes[i].style.display = "none";
      }
    }

    function refresh() {
      if (!activeRange) return;
      updateFromRange(activeRange);
    }

    const onScrollOrResize = () => refresh();
    document.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize, true);

    return {
      highlightOffsets(start, end) {
        if (!textMap || !textMap.length) return;
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          activeRange = null;
          hideAll();
          return;
        }
        try {
          activeRange = textMap.rangeForOffsets(start, end);
          updateFromRange(activeRange);
        } catch (_) {
          activeRange = null;
          hideAll();
        }
      },
      clear() {
        activeRange = null;
        hideAll();
      },
      destroy() {
        activeRange = null;
        document.removeEventListener("scroll", onScrollOrResize, true);
        window.removeEventListener("resize", onScrollOrResize, true);
        boxes.forEach((b) => b.remove());
        boxes.length = 0;
      }
    };
  }

  function cancelSpeech() {
    if (state.highlighter) {
      state.highlighter.destroy();
      state.highlighter = null;
    }
    const session = state.utterance;
    if (session && typeof session.cancel === "function") {
      session.cancel();
    }
    state.utterance = null;
    state.isSpeaking = false;
    updateButtonUI();
  }

  async function speak(text, textMap) {
    cancelSpeech();
    if (!text) return;

    const settings = await getUserSettings();

    if (textMap) {
      try {
        state.highlighter = createSelectionHighlighter(textMap);
      } catch (_) {
        state.highlighter = null;
      }
    }

    const speechText = sanitizeText(text);
    const trimmed = trimTextForSpeech(speechText);
    if (!trimmed.trimmedText.trim()) {
      if (state.highlighter) {
        state.highlighter.destroy();
        state.highlighter = null;
      }
      return;
    }

    const tld = String(settings.gttsTld || DEFAULT_GTTS_TLD).trim() || DEFAULT_GTTS_TLD;
    const slow = Boolean(settings.gttsSlow);

    const lang =
      settings.gttsLanguage && settings.gttsLanguage !== "__auto__"
        ? normalizeGttsLang(settings.gttsLanguage) || DEFAULT_GTTS_LANG
        : await detectGttsLang(trimmed.trimmedText);

    const session = new GttsSession(trimmed.trimmedText, {
      lang,
      tld,
      slow,
      playbackRate: computePlaybackRate(settings.ratePercent),
      volumeGain: computeVolumeGain(settings.volumePercent),
      trimOffset: trimmed.trimOffset,
      highlighter: state.highlighter
    });
    state.utterance = session;
    state.isSpeaking = true;
    updateButtonUI();

    try {
      await session.start();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (message !== "cancelled") console.error("gTTS error:", err);
    } finally {
      if (state.utterance === session) {
        state.utterance = null;
        state.isSpeaking = false;
        if (state.highlighter) {
          state.highlighter.destroy();
          state.highlighter = null;
        }
        updateButtonUI();
        scheduleHide();
      }
    }
  }

  function updateButtonUI() {
    button.textContent = state.isSpeaking ? "■" : "▶";
    button.title = state.isSpeaking ? "停止朗读" : "朗读选中内容";
  }

  function scheduleHide(delay = 2500) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      button.style.display = "none";
      shadowHost.style.pointerEvents = "none";
    }, delay);
  }

  function hideButton() {
    clearTimeout(hideTimer);
    button.style.display = "none";
    shadowHost.style.pointerEvents = "none";
  }

  function showButtonForSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      hideButton();
      return;
    }

    const rawText = selection.toString();
    const trimmedText = rawText.trim();
    if (!trimmedText) {
      hideButton();
      return;
    }

    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    const anchorRect =
      rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();

    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const buttonSize = 36;
    const margin = 8;
    const desiredLeft = anchorRect.right + margin;
    const desiredTop = anchorRect.top + anchorRect.height / 2 - buttonSize / 2;
    const clampedLeft = Math.min(Math.max(desiredLeft, margin), viewportWidth - buttonSize - margin);
    const clampedTop = Math.min(Math.max(desiredTop, margin), viewportHeight - buttonSize - margin);

    state.currentText = rawText;
    state.currentRange = range.cloneRange();
    button.style.left = `${clampedLeft}px`;
    button.style.top = `${clampedTop}px`;
    button.style.display = "inline-flex";
    shadowHost.style.pointerEvents = "auto";
    updateButtonUI();
    scheduleHide();
  }

  function handleMouseUp() {
    setTimeout(showButtonForSelection, 0);
  }

  function handleKeyUp(event) {
    // Allow keyboard-based selections (Shift+Arrow, Ctrl+A etc.)
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
    setTimeout(showButtonForSelection, 0);
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    clearTimeout(hideTimer);
    shadowHost.style.pointerEvents = "auto";

    if (state.isSpeaking) {
      cancelSpeech();
      scheduleHide(800);
    } else {
      let text = state.currentText;
      let map = null;
      if (state.currentRange) {
        try {
          map = createRangeTextMap(state.currentRange);
          if (map?.text && map.text.trim()) {
            text = map.text;
          } else {
            map = null;
          }
        } catch (_) {
          map = null;
        }
      }
      speak(text, map);
    }
  });

  document.addEventListener("mouseup", handleMouseUp, true);
  document.addEventListener("keyup", handleKeyUp, true);
  document.addEventListener("scroll", () => scheduleHide(500), true);
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideButton();
  });
})();

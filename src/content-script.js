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

  const DEFAULT_FALLBACK_LOCALE = "en-US";
  const DEFAULT_FALLBACK_VOICE = "en-US, AriaNeural";

  // Some legacy/alias language tags that may appear in detectors/user agents.
  const LANGUAGE_ALIASES = {
    in: "id",
    iw: "he",
    ji: "yi",
    jw: "jv",
    no: "nb",
    tl: "fil"
  };

  // When a base language maps to multiple locales, prefer a commonly used default.
  const DEFAULT_LOCALE_BY_LANGUAGE = {
    ar: "ar-SA",
    da: "da-DK",
    de: "de-DE",
    el: "el-GR",
    en: "en-US",
    es: "es-ES",
    fa: "fa-IR",
    fi: "fi-FI",
    fr: "fr-FR",
    he: "he-IL",
    hi: "hi-IN",
    id: "id-ID",
    it: "it-IT",
    ja: "ja-JP",
    ko: "ko-KR",
    nb: "nb-NO",
    nl: "nl-NL",
    pt: "pt-BR",
    ru: "ru-RU",
    sv: "sv-SE",
    th: "th-TH",
    tr: "tr-TR",
    uk: "uk-UA",
    vi: "vi-VN",
    zh: "zh-CN"
  };

  // Keep the old defaults stable for common locales.
  const PREFERRED_VOICE_BY_LOCALE = {
    "en-us": "en-US, AriaNeural",
    "zh-cn": "zh-CN, XiaoxiaoNeural",
    "ru-ru": "ru-RU, SvetlanaNeural"
  };

  let voiceIndexPromise = null;

  async function getVoiceIndex() {
    if (voiceIndexPromise) return voiceIndexPromise;
    voiceIndexPromise = (async () => {
      if (!chrome?.runtime?.getURL) throw new Error("chrome.runtime.getURL unavailable");
      const url = chrome.runtime.getURL("src/voice_list.tsv");
      const tsv = await fetch(url).then((r) => r.text());

      const localeToVoices = new Map(); // "en-US" -> ["en-US, AriaNeural", ...]
      const languageNameToVoices = new Map(); // "English(United States)" -> ["en-US, ...", ...]
      const lowerLocaleToCanonical = new Map(); // "en-us" -> "en-US"
      const baseLangToLocales = new Map(); // "en" -> ["en-US", "en-GB", ...]

      tsv.split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        const fields = line.split("\t");
        if (fields.length < 3) return;

        const languageName = fields[0].trim();
        const code = fields[2].trim();
        if (!code) return;

        const locale = code.split(",")[0].trim();
        if (!locale) return;

        const localeLower = locale.toLowerCase();
        if (!lowerLocaleToCanonical.has(localeLower)) lowerLocaleToCanonical.set(localeLower, locale);

        if (!localeToVoices.has(locale)) localeToVoices.set(locale, []);
        localeToVoices.get(locale).push(code);

        if (!languageNameToVoices.has(languageName)) languageNameToVoices.set(languageName, []);
        languageNameToVoices.get(languageName).push(code);

        const base = localeLower.split("-")[0];
        if (!base) return;
        if (!baseLangToLocales.has(base)) baseLangToLocales.set(base, []);
        const list = baseLangToLocales.get(base);
        if (!list.includes(locale)) list.push(locale);
      });

      return { localeToVoices, languageNameToVoices, lowerLocaleToCanonical, baseLangToLocales };
    })();
    return voiceIndexPromise;
  }

  function normalizeLanguageTag(tag) {
    const raw = String(tag || "").trim();
    if (!raw) return "";

    const lower = raw.toLowerCase();

    // Common script tags returned by some detectors.
    if (lower === "zh-hans") return "zh-CN";
    if (lower === "zh-hant") return "zh-TW";

    const parts = lower.split("-");
    const base = LANGUAGE_ALIASES[parts[0]] || parts[0];
    if (parts.length === 1) return base;
    return [base, ...parts.slice(1)].join("-");
  }

  function getNavigatorLocales() {
    const locales = [];
    if (Array.isArray(navigator.languages)) locales.push(...navigator.languages);
    if (navigator.language) locales.push(navigator.language);
    return Array.from(new Set(locales.filter(Boolean)));
  }

  function resolveLocaleFromTag(tag, voiceIndex) {
    const normalized = normalizeLanguageTag(tag);
    if (!normalized) return "";

    const lower = normalized.toLowerCase();
    if (voiceIndex?.lowerLocaleToCanonical && lower.includes("-")) {
      const direct = voiceIndex.lowerLocaleToCanonical.get(lower);
      if (direct) return direct;
    }

    const base = lower.split("-")[0];
    if (!base) return "";

    // Prefer user's locale if it matches the detected base language and is available.
    if (voiceIndex?.lowerLocaleToCanonical) {
      for (const navLocale of getNavigatorLocales()) {
        const navNormalized = normalizeLanguageTag(navLocale);
        if (!navNormalized) continue;
        const navLower = navNormalized.toLowerCase();
        if (navLower.split("-")[0] !== base) continue;
        const candidate = voiceIndex.lowerLocaleToCanonical.get(navLower);
        if (candidate) return candidate;
      }
    }

    const defaultLocale = DEFAULT_LOCALE_BY_LANGUAGE[base];
    if (defaultLocale) {
      if (voiceIndex?.lowerLocaleToCanonical) {
        const candidate = voiceIndex.lowerLocaleToCanonical.get(defaultLocale.toLowerCase());
        if (candidate) return candidate;
      }
      return defaultLocale;
    }

    if (voiceIndex?.baseLangToLocales) {
      const locales = voiceIndex.baseLangToLocales.get(base);
      if (Array.isArray(locales) && locales.length) return locales[0];
    }

    // Last resort: return base language, which is still a valid BCP-47 tag.
    return base;
  }

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

  async function detectLanguage(text) {
    const trimmed = String(text || "").trim();

    let voiceIndex = null;
    try {
      voiceIndex = await getVoiceIndex();
    } catch (_) {
      voiceIndex = null;
    }

    const navLocale =
      resolveLocaleFromTag(navigator.language || DEFAULT_FALLBACK_LOCALE, voiceIndex) ||
      navigator.language ||
      DEFAULT_FALLBACK_LOCALE;

    if (!trimmed) return navLocale;

    const chromeTag = await detectLanguageWithChrome(trimmed);
    const guessedTag = chromeTag || guessLanguageTagByScript(trimmed) || navLocale;

    return resolveLocaleFromTag(guessedTag, voiceIndex) || navLocale;
  }

  async function pickVoiceForLanguageName(languageName) {
    let voiceIndex = null;
    try {
      voiceIndex = await getVoiceIndex();
    } catch (_) {
      return { lang: DEFAULT_FALLBACK_LOCALE, voice: DEFAULT_FALLBACK_VOICE };
    }

    const voices = voiceIndex.languageNameToVoices.get(languageName) || [];
    if (!voices.length) return { lang: DEFAULT_FALLBACK_LOCALE, voice: DEFAULT_FALLBACK_VOICE };

    const locale = voices[0].split(",")[0].trim();
    const preferred = PREFERRED_VOICE_BY_LOCALE[String(locale).toLowerCase()];
    const voice = preferred && voices.includes(preferred) ? preferred : voices[0];
    return { lang: locale || DEFAULT_FALLBACK_LOCALE, voice };
  }

  // --- Edge TTS implementation (ported from edge-tts-gui/src/communicate.cpp) ---
  const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const WSS_URL =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/" +
    "readaloud/edge/v1?TrustedClientToken=" +
    TRUSTED_CLIENT_TOKEN;
  const DEFAULT_CHROMIUM_FULL_VERSION = "130.0.2849.68";

  function getChromiumFullVersion() {
    const ua = navigator.userAgent || "";
    const match = ua.match(/Edg\/([\d.]+)/) || ua.match(/Chrome\/([\d.]+)/);
    return (match && match[1]) || DEFAULT_CHROMIUM_FULL_VERSION;
  }

  const CHROMIUM_FULL_VERSION = getChromiumFullVersion();
  const MAX_MESSAGE_SIZE = 8192 * 16;
  const WSS_CONNECT_TIMEOUT_MS = 10000;
  const WSS_MAX_RETRIES = 2;
  const WSS_RETRY_BASE_DELAY_MS = 350;
  const WSS_RETRY_MAX_DELAY_MS = 1400;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function computeRetryDelayMs(failureCount) {
    const exp = Math.min(WSS_RETRY_MAX_DELAY_MS, WSS_RETRY_BASE_DELAY_MS * 2 ** failureCount);
    return Math.round(exp * (0.8 + Math.random() * 0.4));
  }

  function connectId() {
    if (crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, "");
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function dateToString() {
    const d = new Date();
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dayName = days[d.getUTCDay()];
    const monthName = months[d.getUTCMonth()];
    const day = String(d.getUTCDate()).padStart(2, "0");
    const year = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return `${dayName} ${monthName} ${day} ${year} ${hh}:${mm}:${ss} GMT+0000 (Coordinated Universal Time)`;
  }

  async function sha256HexUpper(str) {
    const data = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }

  async function generateSecMsGecToken() {
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    let ticks = (nowSecs + 11644473600n) * 10000000n;
    ticks -= ticks % 3000000000n; // 5 minutes
    const strToHash = ticks.toString() + TRUSTED_CLIENT_TOKEN;
    return sha256HexUpper(strToHash);
  }

  function generateSecMsGecVersion() {
    return `1-${CHROMIUM_FULL_VERSION}`;
  }

  function sanitizeText(text) {
    return text
      .replace(/[&<>]/g, " ")
      .replace(/[\u0000-\u0008\u000B-\u001F]/g, " ")
      .replace(/[\r\n]/g, " ");
  }

  function mkssml(text, voice, rate, volume, pitch, lang) {
    const voiceName = `Microsoft Server Speech Text to Speech Voice (${voice})`;
    return (
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
      `<voice name='${voiceName}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
      text +
      `</prosody></voice></speak>`
    );
  }

  function speechConfigMessage(timestamp) {
    return (
      `X-Timestamp:${timestamp}\r\n` +
      "Content-Type:application/json; charset=utf-8\r\n" +
      "Path:speech.config\r\n\r\n" +
      '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":false,"wordBoundaryEnabled":true},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
    );
  }

  function ssmlMessage(requestId, timestamp, ssml) {
    return (
      `X-RequestId:${requestId}\r\n` +
      "Content-Type:application/ssml+xml\r\n" +
      `X-Timestamp:${timestamp}Z\r\n` + // This extra Z matches Edge's behavior.
      "Path:ssml\r\n\r\n" +
      ssml
    );
  }

  function parseHeaders(message) {
    const headerEnd = message.indexOf("\r\n\r\n");
    const headerEndLf = headerEnd < 0 ? message.indexOf("\n\n") : -1;
    const rawHeaders =
      headerEnd >= 0
        ? message.slice(0, headerEnd)
        : headerEndLf >= 0
          ? message.slice(0, headerEndLf)
          : message;
    const headers = {};
    rawHeaders.split(/\r?\n/).forEach((line) => {
      const idx = line.indexOf(":");
      if (idx > 0) {
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    });
    return headers;
  }

  function parseBody(message) {
    const idx = message.indexOf("\r\n\r\n");
    if (idx >= 0) return message.slice(idx + 4);
    const idxLf = message.indexOf("\n\n");
    if (idxLf >= 0) return message.slice(idxLf + 2);
    return "";
  }

  function safeJsonParse(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function ticksToMs(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return num / 10000;
  }

  function extractWordBoundaries(metadata) {
    const list = metadata?.Metadata || metadata?.metadata;
    if (!Array.isArray(list)) return [];

    const boundaries = [];
    list.forEach((item) => {
      const type = item?.Type || item?.type;
      if (type !== "WordBoundary") return;

      const data = item?.Data || item?.data || {};
      const audioOffsetMs = ticksToMs(data.Offset ?? data.offset);
      const durationMs = ticksToMs(data.Duration ?? data.duration);
      const textInfo = data.text ?? data.Text ?? data.word ?? data.Word ?? null;

      let word = "";
      let textOffset = null;
      let textLength = null;

      if (textInfo && typeof textInfo === "object") {
        word = String(textInfo.Text ?? textInfo.text ?? textInfo.Word ?? textInfo.word ?? "");

        const offsetCandidate =
          textInfo.Offset ?? textInfo.offset ?? textInfo.TextOffset ?? textInfo.textOffset ?? null;
        const lengthCandidate =
          textInfo.Length ??
          textInfo.length ??
          textInfo.WordLength ??
          textInfo.wordLength ??
          textInfo.TextLength ??
          textInfo.textLength ??
          null;

        const offsetNum = Number(offsetCandidate);
        if (Number.isFinite(offsetNum)) textOffset = offsetNum;

        const lengthNum = Number(lengthCandidate);
        if (Number.isFinite(lengthNum)) textLength = lengthNum;
      } else if (typeof textInfo === "string") {
        word = textInfo;
      }

      const dataTextOffsetNum = Number(data.TextOffset ?? data.textOffset);
      if (Number.isFinite(dataTextOffsetNum)) textOffset = dataTextOffsetNum;

      const dataTextLengthNum = Number(data.WordLength ?? data.wordLength ?? data.TextLength ?? data.textLength);
      if (Number.isFinite(dataTextLengthNum)) textLength = dataTextLengthNum;

      if (textOffset == null) {
        textOffset = NaN;
      } else {
        const textOffsetNum = Number(textOffset);
        textOffset = Number.isFinite(textOffsetNum) ? textOffsetNum : NaN;
      }
      if (!Number.isFinite(Number(textLength)) || Number(textLength) <= 0) textLength = word.length || 0;

      boundaries.push({ audioOffsetMs, durationMs, textOffset, textLength, word });
    });

    return boundaries;
  }

  async function pickVoiceForLang(langOrTag) {
    const lower = (langOrTag || "").toLowerCase();
    const legacyFallback = lower.startsWith("zh")
      ? "zh-CN, XiaoxiaoNeural"
      : lower.startsWith("ru")
        ? "ru-RU, SvetlanaNeural"
        : DEFAULT_FALLBACK_VOICE;

    let voiceIndex = null;
    try {
      voiceIndex = await getVoiceIndex();
    } catch (_) {
      return legacyFallback;
    }

    const locale = resolveLocaleFromTag(langOrTag, voiceIndex);
    const canonical =
      (locale && voiceIndex.lowerLocaleToCanonical.get(String(locale).toLowerCase())) || locale;
    const voices = (canonical && voiceIndex.localeToVoices.get(canonical)) || [];
    if (!voices.length) return legacyFallback;

    const preferred = PREFERRED_VOICE_BY_LOCALE[String(canonical).toLowerCase()];
    if (preferred && voices.includes(preferred)) return preferred;

    return voices[0];
  }

  function formatSignedPercent(value) {
    const num = Number(value) || 0;
    return num >= 0 ? `+${num}%` : `${num}%`;
  }

  function formatSignedHz(value) {
    const num = Number(value) || 0;
    return num >= 0 ? `+${num}Hz` : `${num}Hz`;
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

  class EdgeTtsSession {
    constructor(
      text,
      { lang, voice, rate = "+0%", volume = "+0%", pitch = "+0Hz", onBoundary = null }
    ) {
      this.text = sanitizeText(text);
      this.lang = lang;
      this.voice = voice;
      this.rate = rate;
      this.volume = volume;
      this.pitch = pitch;
      this.onBoundary = typeof onBoundary === "function" ? onBoundary : null;
      this.ws = null;
      this.audioEl = null;
      this.audioChunks = [];
      this.boundaries = [];
      this.boundaryRaf = 0;
      this.boundaryIndex = -1;
      this.cancelled = false;
      this.partIndex = 0;
      this.parts = [];
      this.partCharOffsets = [];
      this.requestIdToPartIndex = new Map();
      this.requestId = "";
      this.playResolve = null;
      this.playReject = null;
    }

    cancel() {
      this.cancelled = true;
      if (this.boundaryRaf) {
        cancelAnimationFrame(this.boundaryRaf);
        this.boundaryRaf = 0;
      }
      try {
        if (
          this.ws &&
          (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
        ) {
          this.ws.close();
        }
      } catch (_) {
        // ignore
      }
      if (this.audioEl) {
        try {
          this.audioEl.pause();
          this.audioEl.src = "";
        } catch (_) {
          // ignore
        }
      }
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

    async start() {
      let failures = 0;
      while (true) {
        try {
          await this.startOnce();
          return;
        } catch (err) {
          if (this.cancelled) return;
          const retryable = Boolean(err && err.edgeTtsRetryable);
          if (!retryable || failures >= WSS_MAX_RETRIES) throw err;
          const delayMs = computeRetryDelayMs(failures);
          failures += 1;
          console.warn("Edge TTS websocket failed, retrying...", {
            attempt: failures,
            delayMs,
            message: err && err.message ? err.message : String(err)
          });
          await sleep(delayMs);
        }
      }
    }

    async startOnce() {
      const secMsGec = await generateSecMsGecToken();
      const secMsGecVersion = generateSecMsGecVersion();
      const connectionId = connectId();
      const url =
        `${WSS_URL}` +
        `&Sec-MS-GEC=${secMsGec}` +
        `&Sec-MS-GEC-Version=${secMsGecVersion}` +
        `&ConnectionId=${connectionId}`;

      this.parts = [];
      this.partCharOffsets = [];
      this.audioChunks = [];
      this.boundaries = [];
      this.requestIdToPartIndex = new Map();
      for (let i = 0; i < this.text.length; i += MAX_MESSAGE_SIZE) {
        this.partCharOffsets.push(i);
        this.parts.push(this.text.slice(i, i + MAX_MESSAGE_SIZE));
      }
      this.partIndex = 0;

      return new Promise((resolve, reject) => {
        if (this.cancelled) return resolve();

        let hadWsError = false;
        let timedOut = false;

        const makeRetryableError = (message, extra = {}) => {
          const err = new Error(message);
          err.edgeTtsRetryable = true;
          Object.assign(err, extra);
          return err;
        };

        const ws = new WebSocket(url);
        this.ws = ws;
        ws.binaryType = "arraybuffer";
        const textDecoder = new TextDecoder();

        const connectTimer = setTimeout(() => {
          timedOut = true;
          try {
            ws.close();
          } catch (_) {
            // ignore
          }
        }, WSS_CONNECT_TIMEOUT_MS);

        const ingestMetadata = (headers, bodyText) => {
          const requestId = headers["X-RequestId"] || headers["X-RequestID"] || "";
          const partIndex = this.requestIdToPartIndex.get(requestId);
          const partCharOffset =
            typeof partIndex === "number" ? this.partCharOffsets[partIndex] || 0 : 0;
          const payload = safeJsonParse(String(bodyText || "").trim());
          const boundaries = extractWordBoundaries(payload);
          boundaries.forEach((b) => {
            this.boundaries.push({
              partIndex: typeof partIndex === "number" ? partIndex : 0,
              audioOffsetMs: b.audioOffsetMs,
              durationMs: b.durationMs,
              textOffset: partCharOffset + b.textOffset,
              textLength: b.textLength,
              word: b.word
            });
          });
        };

        const sendPart = () => {
          if (this.cancelled || this.partIndex >= this.parts.length) return;
          const timestamp = dateToString();
          this.requestId = connectId();
          this.requestIdToPartIndex.set(this.requestId, this.partIndex);
          try {
            ws.send(speechConfigMessage(timestamp));
            const ssml = mkssml(
              this.parts[this.partIndex],
              this.voice,
              this.rate,
              this.volume,
              this.pitch,
              this.lang
            );
            ws.send(ssmlMessage(this.requestId, timestamp, ssml));
          } catch (_) {
            hadWsError = true;
            try {
              ws.close();
            } catch (_) {
              // ignore
            }
          }
        };

        ws.onopen = () => {
          clearTimeout(connectTimer);
          sendPart();
        };

        ws.onmessage = async (event) => {
          if (this.cancelled) return;
          if (typeof event.data === "string") {
            const headers = parseHeaders(event.data);
            const path = headers["Path"];
            if (path === "audio.metadata") {
              ingestMetadata(headers, parseBody(event.data));
              return;
            }
            if (path === "turn.end") {
              this.partIndex += 1;
              if (this.partIndex < this.parts.length) {
                sendPart();
              } else {
                ws.close();
              }
            }
            return;
          }

          // Binary message (audio or metadata).
          let binary = event.data;
          if (binary instanceof Blob) {
            binary = await binary.arrayBuffer();
          }
          const buf = new Uint8Array(binary);
          if (buf.length < 2) return;
          const headerLength = (buf[0] << 8) | buf[1];
          if (buf.length <= headerLength + 2) return;
          const headersText = textDecoder.decode(buf.slice(2, headerLength + 2));
          const headers = parseHeaders(headersText);
          const path = headers["Path"];
          const payloadBytes = buf.slice(headerLength + 2);
          if (!path) {
            // Fallback: keep previous behavior for unexpected frames.
            this.audioChunks.push(payloadBytes);
            return;
          }
          if (path === "audio.metadata") {
            ingestMetadata(headers, textDecoder.decode(payloadBytes));
            return;
          }
          if (path === "audio") {
            this.audioChunks.push(payloadBytes);
          }
        };

        ws.onerror = () => {
          hadWsError = true;
        };

        ws.onclose = async (ev) => {
          clearTimeout(connectTimer);
          this.ws = null;

          if (this.cancelled) return resolve();
          if (!this.audioChunks.length) {
            const code = ev && typeof ev.code === "number" ? ev.code : 0;
            const reason = ev && ev.reason ? ev.reason : "";
            const baseMsg = timedOut
              ? "Edge TTS websocket connect timeout"
              : "Edge TTS websocket closed without audio";
            const msg = `${baseMsg} (code=${code}${reason ? ` reason=${reason}` : ""})`;
            reject(
              makeRetryableError(msg, {
                closeCode: code,
                closeReason: reason,
                hadWsError,
                timedOut
              })
            );
            return;
          }
          try {
            await this.playCollectedAudio();
            resolve();
          } catch (e) {
            reject(e);
          }
        };
      });
    }

    startBoundaryTracking() {
      if (!this.audioEl || !this.onBoundary || !this.boundaries.length) return;
      const audio = this.audioEl;

      // If the offsets reset per part, approximate by stitching parts with their max (offset+duration).
      const partCount = this.parts.length || 1;
      const partStats = Array.from({ length: partCount }, () => ({ min: Infinity, max: 0 }));
      this.boundaries.forEach((b) => {
        const idx = typeof b.partIndex === "number" ? b.partIndex : 0;
        const stat = partStats[idx] || partStats[0];
        stat.min = Math.min(stat.min, b.audioOffsetMs);
        stat.max = Math.max(stat.max, b.audioOffsetMs + (b.durationMs || 0));
      });
      const offsetsLookContinuous =
        partCount <= 1 ||
        partStats.slice(1).every((s, idx) => {
          const prev = partStats[idx];
          if (!Number.isFinite(s.min) || !Number.isFinite(prev.max)) return true;
          return s.min >= prev.max - 100;
        });

      const partStartMs = new Array(partCount).fill(0);
      if (!offsetsLookContinuous) {
        for (let i = 1; i < partCount; i += 1) {
          const prev = partStats[i - 1];
          partStartMs[i] = partStartMs[i - 1] + (Number.isFinite(prev.max) ? prev.max : 0);
        }
      }

      const timeline = this.boundaries
        .map((b) => ({
          ...b,
          globalAudioOffsetMs:
            (partStartMs[typeof b.partIndex === "number" ? b.partIndex : 0] || 0) + b.audioOffsetMs
        }))
        .filter((b) => Number.isFinite(b.globalAudioOffsetMs))
        .sort((a, b) => a.globalAudioOffsetMs - b.globalAudioOffsetMs);

      this.boundaryIndex = -1;
      let lastEmittedIndex = -1;

      const tick = () => {
        if (this.cancelled || !this.audioEl) return;
        const currentMs = audio.currentTime * 1000;
        while (
          this.boundaryIndex + 1 < timeline.length &&
          timeline[this.boundaryIndex + 1].globalAudioOffsetMs <= currentMs
        ) {
          this.boundaryIndex += 1;
        }

        if (this.boundaryIndex !== lastEmittedIndex) {
          lastEmittedIndex = this.boundaryIndex;
          const boundary = timeline[this.boundaryIndex];
          if (boundary) this.onBoundary(boundary);
        }

        if (!audio.ended && !audio.paused) {
          this.boundaryRaf = requestAnimationFrame(tick);
        }
      };

      this.boundaryRaf = requestAnimationFrame(tick);
    }

    async playCollectedAudio() {
      if (!this.audioChunks.length) return;
      const total = this.audioChunks.reduce((sum, c) => sum + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of this.audioChunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }

      const blob = new Blob([merged], { type: "audio/mpeg" });
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      this.audioEl = audio;

      return new Promise((resolve, reject) => {
        this.playResolve = resolve;
        this.playReject = reject;
        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          this.playResolve = null;
          this.playReject = null;
          resolve();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(audioUrl);
          this.playResolve = null;
          this.playReject = null;
          reject(new Error("audio playback failed"));
        };
        audio
          .play()
          .then(() => {
            this.startBoundaryTracking();
          })
          .catch((e) => {
            URL.revokeObjectURL(audioUrl);
            this.playResolve = null;
            this.playReject = null;
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

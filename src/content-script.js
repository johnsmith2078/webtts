(() => {
  // Guard against multiple injections.
  if (window.__webTtsHelperInjected) return;
  window.__webTtsHelperInjected = true;

  const state = {
    currentText: "",
    utterance: null,
    isSpeaking: false
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
  `;
  shadowRoot.appendChild(style);

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
      .replace(/[\r\n]+/g, " ");
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
    const [rawHeaders] = message.split("\r\n\r\n");
    const headers = {};
    rawHeaders.split("\r\n").forEach((line) => {
      const idx = line.indexOf(":");
      if (idx > 0) {
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    });
    return headers;
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
        resolve({ languageName: "__auto__", voiceCode: "auto", ratePercent: 0, volumePercent: 0, pitchHz: 0 });
        return;
      }
      chrome.storage.sync.get(
        {
          languageName: "__auto__",
          voiceCode: "auto",
          ratePercent: 0,
          volumePercent: 0,
          pitchHz: 0
        },
        resolve
      );
    });
  }

  class EdgeTtsSession {
    constructor(text, { lang, voice, rate = "+0%", volume = "+0%", pitch = "+0Hz" }) {
      this.text = sanitizeText(text);
      this.lang = lang;
      this.voice = voice;
      this.rate = rate;
      this.volume = volume;
      this.pitch = pitch;
      this.ws = null;
      this.audioEl = null;
      this.audioChunks = [];
      this.cancelled = false;
      this.partIndex = 0;
      this.parts = [];
      this.requestId = "";
      this.playResolve = null;
      this.playReject = null;
    }

    cancel() {
      this.cancelled = true;
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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
      const secMsGec = await generateSecMsGecToken();
      const secMsGecVersion = generateSecMsGecVersion();
      const connectionId = connectId();
      const url =
        `${WSS_URL}` +
        `&Sec-MS-GEC=${secMsGec}` +
        `&Sec-MS-GEC-Version=${secMsGecVersion}` +
        `&ConnectionId=${connectionId}`;

      this.parts = [];
      for (let i = 0; i < this.text.length; i += MAX_MESSAGE_SIZE) {
        this.parts.push(this.text.slice(i, i + MAX_MESSAGE_SIZE));
      }
      this.partIndex = 0;

      return new Promise((resolve, reject) => {
        if (this.cancelled) return resolve();

        const ws = new WebSocket(url);
        this.ws = ws;
        ws.binaryType = "arraybuffer";

        const sendPart = () => {
          if (this.cancelled || this.partIndex >= this.parts.length) return;
          const timestamp = dateToString();
          this.requestId = connectId();
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
        };

        ws.onopen = () => {
          sendPart();
        };

        ws.onmessage = async (event) => {
          if (this.cancelled) return;
          if (typeof event.data === "string") {
            const headers = parseHeaders(event.data);
            const path = headers["Path"];
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

          // Binary audio message.
          let binary = event.data;
          if (binary instanceof Blob) {
            binary = await binary.arrayBuffer();
          }
          const buf = new Uint8Array(binary);
          if (buf.length < 2) return;
          const headerLength = (buf[0] << 8) | buf[1];
          if (buf.length <= headerLength + 2) return;
          const audioData = buf.slice(headerLength + 2);
          this.audioChunks.push(audioData);
        };

        ws.onerror = (err) => {
          if (this.cancelled) return resolve();
          reject(err);
        };

        ws.onclose = async (ev) => {
          if (this.cancelled) return resolve();
          if (!this.audioChunks.length) {
            console.warn("Edge TTS websocket closed without audio", {
              code: ev.code,
              reason: ev.reason
            });
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
            // playing
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

  function cancelSpeech() {
    const session = state.utterance;
    if (session && typeof session.cancel === "function") {
      session.cancel();
    }
    state.utterance = null;
    state.isSpeaking = false;
    updateButtonUI();
  }

  async function speak(text) {
    cancelSpeech();
    if (!text) return;

    const settings = await getUserSettings();

    let lang = "";
    let voice = "";

    if (settings.voiceCode && settings.voiceCode !== "auto") {
      voice = settings.voiceCode;
      const locale = voice.split(",")[0];
      lang = (locale && locale.trim()) || navigator.language || DEFAULT_FALLBACK_LOCALE;
    } else if (settings.languageName && settings.languageName !== "__auto__") {
      const picked = await pickVoiceForLanguageName(settings.languageName);
      lang = picked.lang;
      voice = picked.voice;
    } else {
      lang = await detectLanguage(text);
      voice = await pickVoiceForLang(lang);
    }

    const session = new EdgeTtsSession(text, {
      lang,
      voice,
      rate: formatSignedPercent(settings.ratePercent),
      volume: formatSignedPercent(settings.volumePercent),
      pitch: formatSignedHz(settings.pitchHz)
    });
    state.utterance = session;
    state.isSpeaking = true;
    updateButtonUI();

    try {
      await session.start();
    } catch (err) {
      console.error("Edge TTS error:", err);
    } finally {
      if (state.utterance === session) {
        state.utterance = null;
        state.isSpeaking = false;
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

    const text = selection.toString().trim();
    if (!text) {
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

    state.currentText = text;
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
      speak(state.currentText);
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

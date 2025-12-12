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

  function detectLanguage(text) {
    const trimmed = text.trim();
    if (!trimmed) return navigator.language || "en-US";
    const hasCJK = /[\u4e00-\u9fff]/.test(trimmed);
    const hasCyrillic = /[\u0400-\u04FF]/.test(trimmed);
    if (hasCJK) return "zh-CN";
    if (hasCyrillic) return "ru-RU";
    return navigator.language || "en-US";
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

  function pickVoiceForLang(lang) {
    const lower = (lang || "").toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN, XiaoxiaoNeural";
    if (lower.startsWith("ru")) return "ru-RU, SvetlanaNeural";
    return "en-US, AriaNeural";
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
        resolve({ voiceCode: "auto", ratePercent: 0, volumePercent: 0, pitchHz: 0 });
        return;
      }
      chrome.storage.sync.get(
        {
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
    const detectedLang = detectLanguage(text);
    let lang = detectedLang;
    let voice = pickVoiceForLang(detectedLang);
    if (settings.voiceCode && settings.voiceCode !== "auto") {
      voice = settings.voiceCode;
      const locale = voice.split(",")[0];
      if (locale) lang = locale.trim();
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

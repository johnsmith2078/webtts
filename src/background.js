(() => {
  const GOOGLE_TTS_RPC = "jQ1olc";
  const GOOGLE_TTS_MAX_CHARS = 100;

  const DEFAULT_LANG = "en";
  const DEFAULT_TLD = "com";

  const activeControllers = new Map();

  function translateUrl(tld, path) {
    const safeTld = String(tld || DEFAULT_TLD).trim() || DEFAULT_TLD;
    const safePath = String(path || "").replace(/^\/+/, "");
    return `https://translate.google.${safeTld}/${safePath}`;
  }

  function packageRpc(text, lang, slow) {
    const speed = slow ? true : null;
    const parameter = [text, lang, speed, "null"];
    const escapedParameter = JSON.stringify(parameter, null, 0);
    const rpc = [[[GOOGLE_TTS_RPC, escapedParameter, null, "generic"]]];
    const escapedRpc = JSON.stringify(rpc, null, 0);
    return `f.req=${encodeURIComponent(escapedRpc)}&`;
  }

  const ONLY_PUNC_OR_SPACE_RE = /^[\s\p{P}]*$/u;
  const PUNCTUATION_BREAK_CHARS = new Set(Array.from("?!？！.,¡()[]¿…‥،;:—。，、：\n"));

  function cleanTokens(tokens) {
    return tokens
      .map((t) => String(t || "").trim())
      .filter((t) => t && !ONLY_PUNC_OR_SPACE_RE.test(t));
  }

  function minimizeToken(theString, delim, maxSize) {
    let s = String(theString || "");
    if (!s) return [];

    if (delim && s.startsWith(delim)) s = s.slice(delim.length);
    if (s.length <= maxSize) return [s];

    let cut = -1;
    if (delim) cut = s.lastIndexOf(delim, maxSize);
    if (cut <= 0) cut = maxSize;

    return [s.slice(0, cut), ...minimizeToken(s.slice(cut), delim, maxSize)];
  }

  function tokenize(text) {
    const raw = String(text || "").trim();
    if (!raw) return [];
    if (raw.length <= GOOGLE_TTS_MAX_CHARS) return cleanTokens([raw]);

    const tokens = [];
    let cur = "";
    for (const ch of raw) {
      cur += ch;
      if (PUNCTUATION_BREAK_CHARS.has(ch)) {
        tokens.push(cur);
        cur = "";
      }
    }
    if (cur) tokens.push(cur);

    const cleaned = cleanTokens(tokens);
    const minimized = [];
    cleaned.forEach((t) => {
      minimized.push(...minimizeToken(t, " ", GOOGLE_TTS_MAX_CHARS));
    });
    return cleanTokens(minimized);
  }

  function extractAudioBase64(responseText) {
    const text = String(responseText || "");
    if (!text) return "";

    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.includes(GOOGLE_TTS_RPC)) continue;
      const match = line.match(/jQ1olc","\[\\"(.*?)\\"]/);
      if (match && match[1]) return match[1];
    }

    const match = text.match(/jQ1olc","\[\\"(.*?)\\"]/);
    return match && match[1] ? match[1] : "";
  }

  function base64ToUint8Array(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function concatChunks(chunks) {
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged;
  }

  async function synthesizeGttsBase64Chunks({ text, lang, tld, slow, signal }) {
    const safeLang = String(lang || DEFAULT_LANG).trim() || DEFAULT_LANG;
    const safeTld = String(tld || DEFAULT_TLD).trim() || DEFAULT_TLD;
    const parts = tokenize(text);
    if (!parts.length) throw new Error("No text to speak");

    const url = translateUrl(safeTld, "_/TranslateWebserverUi/data/batchexecute");
    const base64Chunks = [];

    for (const part of parts) {
      const body = packageRpc(part, safeLang, slow);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"
        },
        body,
        credentials: "omit",
        cache: "no-store",
        signal
      });

      if (!response.ok) {
        throw new Error(`gTTS request failed: HTTP ${response.status}`);
      }

      const textBody = await response.text();
      const audioBase64 = extractAudioBase64(textBody);
      if (!audioBase64) {
        throw new Error("gTTS response missing audio");
      }
      base64Chunks.push(audioBase64);
    }

    return base64Chunks;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "gttsCancel") {
      const requestId = String(message.requestId || "");
      const controller = activeControllers.get(requestId);
      if (controller) {
        controller.abort();
        activeControllers.delete(requestId);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type !== "gttsSynthesize") return;

    const requestId = String(message.requestId || "");
    const controller = new AbortController();
    if (requestId) activeControllers.set(requestId, controller);

    synthesizeGttsBase64Chunks({
      text: message.text,
      lang: message.lang,
      tld: message.tld,
      slow: Boolean(message.slow),
      signal: controller.signal
    })
      .then((audioBase64Chunks) => {
        if (requestId) activeControllers.delete(requestId);
        sendResponse({ ok: true, audioBase64Chunks });
      })
      .catch((err) => {
        if (requestId) activeControllers.delete(requestId);
        const msg =
          err && err.name === "AbortError"
            ? "cancelled"
            : err && err.message
              ? err.message
              : "gTTS synthesis failed";
        sendResponse({ ok: false, error: msg });
      });

    return true;
  });
})();

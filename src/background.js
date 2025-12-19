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

    if (!text.includes(GOOGLE_TTS_RPC)) return "";

    // Prefer parsing the nested JSON string so that unicode escapes (e.g. \\u003d) are decoded properly.
    try {
      const match = text.match(new RegExp(`${GOOGLE_TTS_RPC}","([^"]+)"`));
      const encodedPayload = match && match[1] ? match[1] : "";
      if (encodedPayload) {
        const decodedPayload = JSON.parse(`"${encodedPayload}"`); // e.g. `[\"<b64>\"]`
        const innerJsonText = String(decodedPayload || "").replace(/\\"/g, '"');
        const inner = JSON.parse(innerJsonText);
        const base64 = Array.isArray(inner) ? inner[0] : "";
        if (typeof base64 === "string" && base64) return base64;
      }
    } catch (_) {
      // ignore
    }

    // Fallback regex: keep it broad, but only accept base64-ish characters.
    const legacy = text.match(/jQ1olc","\[\\"(.*?)\\"/);
    if (legacy && legacy[1]) {
      const candidate = legacy[1].replace(/\\u003d/g, "=").replace(/\\u002b/g, "+").replace(/\\u002f/g, "/");
      if (/^[A-Za-z0-9+/=]+$/.test(candidate)) return candidate;
    }
    return "";
  }

  function base64ToUint8Array(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function uint8ArrayToBase64(bytes) {
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
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
    const referrer = translateUrl(safeTld, "");
    const base64Chunks = [];

    for (const part of parts) {
      let audioBase64 = "";
      let lastHead = "";

      // Primary: gTTS batchexecute (same strategy as python gTTS).
      {
        const body = packageRpc(part, safeLang, slow);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
            Accept: "*/*"
          },
          body,
          credentials: "omit",
          cache: "no-store",
          referrer,
          referrerPolicy: "no-referrer-when-downgrade",
          signal
        });

        if (!response.ok) {
          throw new Error(`gTTS request failed: HTTP ${response.status}`);
        }

        const contentType = response.headers.get("content-type") || "";
        const textBody = await response.text();
        audioBase64 = extractAudioBase64(textBody);
        lastHead = `ct=${contentType || "?"} len=${textBody.length} rpc=${String(textBody || "").includes(GOOGLE_TTS_RPC)}`;
      }

      // Fallback: translate_tts endpoint (returns MP3 directly).
      if (!audioBase64) {
        const makeTtsUrl = (client) => {
          const params = new URLSearchParams();
          params.set("ie", "UTF-8");
          params.set("client", client);
          params.set("tl", safeLang);
          params.set("q", part);
          params.set("ttsspeed", slow ? "0.24" : "1");
          params.set("total", "1");
          params.set("idx", "0");
          params.set("textlen", String(part.length));
          params.set("prev", "input");
          return translateUrl(safeTld, "translate_tts") + `?${params.toString()}`;
        };

        const fetchTts = async (client) => {
          const ttsUrl = makeTtsUrl(client);
          const response = await fetch(ttsUrl, {
            method: "GET",
            headers: { Accept: "*/*" },
            credentials: "omit",
            cache: "no-store",
            referrer,
            referrerPolicy: "no-referrer-when-downgrade",
            signal
          });
          return { client, ttsUrl, response };
        };

        let attempt = await fetchTts("tw-ob");
        if (!attempt.response.ok && (attempt.response.status === 400 || attempt.response.status === 403)) {
          attempt = await fetchTts("gtx");
        }

        const response = attempt.response;

        if (!response.ok) {
          const contentType = response.headers.get("content-type") || "";
          throw new Error(
            `gTTS fallback request failed: HTTP ${response.status} (client=${attempt.client} tld=${safeTld} lang=${safeLang} ct=${contentType || "?"})`
          );
        }

        const contentType = response.headers.get("content-type") || "";
        if (/text\/html/i.test(contentType)) {
          throw new Error(
            `gTTS blocked (HTML response,可能被拦截/需要代理/切换域名) (client=${attempt.client} tld=${safeTld} lang=${safeLang} ct=${contentType})`
          );
        }

        const mp3Bytes = new Uint8Array(await response.arrayBuffer());
        audioBase64 = uint8ArrayToBase64(mp3Bytes);
      }

      if (!audioBase64) {
        const hint =
          lastHead && /ct=text\/html/i.test(lastHead)
            ? " (HTML response,可能被拦截/需要代理/切换域名)"
            : "";
        throw new Error(
          `gTTS response missing audio (tld=${safeTld} lang=${safeLang}${hint}${lastHead ? `, ${lastHead}` : ""})`
        );
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

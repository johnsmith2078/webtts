(() => {
  const languageSelect = document.getElementById("language");
  const tldSelect = document.getElementById("tld");
  const slowCheckbox = document.getElementById("slow");
  const rateRange = document.getElementById("rate");
  const volumeRange = document.getElementById("volume");
  const rateValue = document.getElementById("rateValue");
  const volumeValue = document.getElementById("volumeValue");

  const GTTS_LANGS = {
    af: "Afrikaans",
    am: "Amharic",
    ar: "Arabic",
    bg: "Bulgarian",
    bn: "Bengali",
    bs: "Bosnian",
    ca: "Catalan",
    cs: "Czech",
    cy: "Welsh",
    da: "Danish",
    de: "German",
    el: "Greek",
    en: "English",
    es: "Spanish",
    et: "Estonian",
    eu: "Basque",
    fi: "Finnish",
    fr: "French",
    "fr-CA": "French (Canada)",
    gl: "Galician",
    gu: "Gujarati",
    ha: "Hausa",
    hi: "Hindi",
    hr: "Croatian",
    hu: "Hungarian",
    id: "Indonesian",
    is: "Icelandic",
    it: "Italian",
    iw: "Hebrew",
    ja: "Japanese",
    jw: "Javanese",
    km: "Khmer",
    kn: "Kannada",
    ko: "Korean",
    la: "Latin",
    lt: "Lithuanian",
    lv: "Latvian",
    ml: "Malayalam",
    mr: "Marathi",
    ms: "Malay",
    my: "Myanmar (Burmese)",
    ne: "Nepali",
    nl: "Dutch",
    no: "Norwegian",
    pa: "Punjabi (Gurmukhi)",
    pl: "Polish",
    pt: "Portuguese (Brazil)",
    "pt-PT": "Portuguese (Portugal)",
    ro: "Romanian",
    ru: "Russian",
    si: "Sinhala",
    sk: "Slovak",
    sq: "Albanian",
    sr: "Serbian",
    su: "Sundanese",
    sv: "Swedish",
    sw: "Swahili",
    ta: "Tamil",
    te: "Telugu",
    th: "Thai",
    tl: "Filipino",
    tr: "Turkish",
    uk: "Ukrainian",
    ur: "Urdu",
    vi: "Vietnamese",
    yue: "Cantonese",
    "zh-CN": "Chinese (Simplified)",
    "zh-TW": "Chinese (Traditional)",
    zh: "Chinese (Mandarin)"
  };

  const GTTS_TLDS = [
    { value: "com", label: "translate.google.com" },
    { value: "com.hk", label: "translate.google.com.hk" },
    { value: "cn", label: "translate.google.cn" }
  ];

  function updateRangeLabels() {
    rateValue.textContent = `${rateRange.value}%`;
    volumeValue.textContent = `${volumeRange.value}%`;
  }

  function populateLanguages() {
    languageSelect.innerHTML = "";
    languageSelect.add(new Option("自动(根据文本)", "__auto__"));
    Object.entries(GTTS_LANGS)
      .sort((a, b) => a[1].localeCompare(b[1], "en", { sensitivity: "base" }))
      .forEach(([code, name]) => {
        languageSelect.add(new Option(`${name} (${code})`, code));
      });
  }

  function populateTlds() {
    tldSelect.innerHTML = "";
    GTTS_TLDS.forEach((item) => {
      tldSelect.add(new Option(item.label, item.value));
    });
  }

  function saveSettings() {
    chrome.storage.sync.set({
      gttsLanguage: languageSelect.value,
      gttsTld: tldSelect.value,
      gttsSlow: Boolean(slowCheckbox.checked),
      ratePercent: Number(rateRange.value) || 0,
      volumePercent: Number(volumeRange.value) || 0
    });
  }

  function attachListeners() {
    languageSelect.addEventListener("change", () => {
      saveSettings();
    });
    tldSelect.addEventListener("change", saveSettings);
    slowCheckbox.addEventListener("change", saveSettings);
    [rateRange, volumeRange].forEach((el) => {
      el.addEventListener("input", () => {
        updateRangeLabels();
      });
      el.addEventListener("change", saveSettings);
    });
  }

  function restoreSettings() {
    chrome.storage.sync.get(
      {
        gttsLanguage: "__auto__",
        gttsTld: "com",
        gttsSlow: false,
        ratePercent: 0,
        volumePercent: 0
      },
      (items) => {
        const lang = items.gttsLanguage || "__auto__";
        languageSelect.value = lang;
        tldSelect.value = items.gttsTld || "com";
        slowCheckbox.checked = Boolean(items.gttsSlow);

        rateRange.value = items.ratePercent;
        volumeRange.value = items.volumePercent;
        updateRangeLabels();
      }
    );
  }

  (async () => {
    populateLanguages();
    populateTlds();
    attachListeners();
    restoreSettings();
  })();
})();

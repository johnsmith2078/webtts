(() => {
  const languageSelect = document.getElementById("language");
  const voiceSelect = document.getElementById("voice");
  const rateRange = document.getElementById("rate");
  const volumeRange = document.getElementById("volume");
  const pitchRange = document.getElementById("pitch");
  const rateValue = document.getElementById("rateValue");
  const volumeValue = document.getElementById("volumeValue");
  const pitchValue = document.getElementById("pitchValue");

  let voiceData = {};

  function updateRangeLabels() {
    rateValue.textContent = `${rateRange.value}%`;
    volumeValue.textContent = `${volumeRange.value}%`;
    pitchValue.textContent = `${pitchRange.value}Hz`;
  }

  function populateLanguages() {
    languageSelect.innerHTML = "";
    languageSelect.add(new Option("自动(根据文本)", "__auto__"));
    Object.keys(voiceData)
      .sort()
      .forEach((lang) => {
        languageSelect.add(new Option(lang, lang));
      });
  }

  function populateVoices(language) {
    voiceSelect.innerHTML = "";
    voiceSelect.add(new Option("自动", "__auto__"));

    if (language === "__auto__") {
      voiceSelect.disabled = true;
      return;
    }
    voiceSelect.disabled = false;
    const list = voiceData[language] || [];
    list.forEach((v) => {
      voiceSelect.add(new Option(v.name, v.code));
    });
  }

  function saveSettings() {
    const languageName = languageSelect.value;
    const selectedVoiceValue = voiceSelect.disabled ? "__auto__" : voiceSelect.value;
    const voiceCode = selectedVoiceValue === "__auto__" ? "auto" : selectedVoiceValue;
    const voiceName =
      selectedVoiceValue === "__auto__" ? "" : voiceSelect.options[voiceSelect.selectedIndex]?.text || "";

    chrome.storage.sync.set({
      languageName,
      voiceCode,
      voiceName,
      ratePercent: Number(rateRange.value) || 0,
      volumePercent: Number(volumeRange.value) || 0,
      pitchHz: Number(pitchRange.value) || 0
    });
  }

  function attachListeners() {
    languageSelect.addEventListener("change", () => {
      populateVoices(languageSelect.value);
      saveSettings();
    });
    voiceSelect.addEventListener("change", saveSettings);
    [rateRange, volumeRange, pitchRange].forEach((el) => {
      el.addEventListener("input", () => {
        updateRangeLabels();
      });
      el.addEventListener("change", saveSettings);
    });
  }

  async function loadVoiceList() {
    const url = chrome.runtime.getURL("src/voice_list.tsv");
    const text = await fetch(url).then((r) => r.text());
    const data = {};
    text.split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      const fields = line.split("\t");
      if (fields.length < 3) return;
      const language = fields[0];
      const voiceName = fields[1];
      const code = fields[2];
      if (!data[language]) data[language] = [];
      data[language].push({ name: voiceName, code });
    });
    voiceData = data;
  }

  function restoreSettings() {
    chrome.storage.sync.get(
      {
        languageName: "__auto__",
        voiceCode: "auto",
        ratePercent: 0,
        volumePercent: 0,
        pitchHz: 0
      },
      (items) => {
        const lang = items.languageName || "__auto__";
        languageSelect.value = lang;
        populateVoices(lang);

        if (items.voiceCode && items.voiceCode !== "auto" && !voiceSelect.disabled) {
          voiceSelect.value = items.voiceCode;
        } else {
          voiceSelect.value = "__auto__";
        }

        rateRange.value = items.ratePercent;
        volumeRange.value = items.volumePercent;
        pitchRange.value = items.pitchHz;
        updateRangeLabels();
      }
    );
  }

  (async () => {
    await loadVoiceList();
    populateLanguages();
    attachListeners();
    restoreSettings();
  })();
})();


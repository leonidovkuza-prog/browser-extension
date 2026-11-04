const STORAGE_KEY = "deepSearchSettings";

const DEFAULT_SETTINGS = {
  enabled: false,
  minDurationMinutes: 20,
  maxViews: 30000,
  hideShorts: true,
  hideStreams: true
};

const fields = {
  enabled: document.getElementById("enabled"),
  hideShorts: document.getElementById("hideShorts"),
  hideStreams: document.getElementById("hideStreams"),
  minDurationMinutes: document.getElementById("minDurationMinutes"),
  maxViews: document.getElementById("maxViews")
};

function applyToForm(settings) {
  fields.enabled.checked = Boolean(settings.enabled);
  fields.hideShorts.checked = Boolean(settings.hideShorts);
  fields.hideStreams.checked = Boolean(settings.hideStreams);
  fields.minDurationMinutes.value = Number(settings.minDurationMinutes);
  fields.maxViews.value = Number(settings.maxViews);
}

function readForm() {
  const minDurationMinutes = Math.max(0, Number(fields.minDurationMinutes.value) || 0);
  const maxViews = Math.max(0, Number(fields.maxViews.value) || 0);
  return {
    enabled: fields.enabled.checked,
    hideShorts: fields.hideShorts.checked,
    hideStreams: fields.hideStreams.checked,
    minDurationMinutes,
    maxViews
  };
}

function load() {
  chrome.storage.sync.get(STORAGE_KEY, (data) => {
    applyToForm({ ...DEFAULT_SETTINGS, ...(data[STORAGE_KEY] || {}) });
  });
}

function save() {
  const settings = readForm();
  chrome.storage.sync.set({ [STORAGE_KEY]: settings }, () => {
    const status = document.getElementById("status");
    status.textContent = "Сохранено";
    setTimeout(() => {
      status.textContent = "";
    }, 1200);
  });
}

document.getElementById("save").addEventListener("click", save);
fields.enabled.addEventListener("change", save);
fields.hideShorts.addEventListener("change", save);
fields.hideStreams.addEventListener("change", save);
load();

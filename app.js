// Prosty frontend w czystym JS: obsluga uploadu XLSX, przetwarzanie danych,
// zapis w localStorage oraz wizualizacje Chart.js.

const STORAGE_KEY = "kilometry-datasets";
let pendingFile = null;
let currentData = null; // { drivers, duetPairs, totals, fileName, sheetName, importedAt }
let chartInstances = {};

const el = (id) => document.getElementById(id);

const dropZone = el("drop-zone");
const fileInput = el("file-input");
const datasetNameInput = el("dataset-name");
const processBtn = el("process-btn");
const saveBtn = el("save-btn");
const statusText = el("status-text");
const savedList = el("saved-list");
const clearStorageBtn = el("clear-storage");
const driverSelect = el("driver-select");
const driverSearch = el("driver-search");
const soloKmEl = el("solo-km");
const baranaKmEl = el("barana-km");
const totalKmEl = el("total-km");
const duetTable = el("duet-table");
const sumTotalEl = el("sum-total");
const sumSoloEl = el("sum-solo");
const sumBaranaEl = el("sum-barana");
const shareBaranaEl = el("share-barana");
const externalLists = { system: [], podwojna: [], podwojnaGroups: [] }; // listy nazw z plików zewnętrznych
const externalRankings = { system: [], podwojna: [] }; // rankingi wyliczone po załadowaniu głównego pliku

const numberFormat = new Intl.NumberFormat("pl-PL", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function setStatus(message) {
  statusText.textContent = message;
}

function getPodwojnaSet() {
  return new Set(externalLists.podwojna.map((n) => n.toLowerCase()));
}

function getAdjustedDrivers() {
  if (!currentData) return [];
  const podSet = getPodwojnaSet();
  const nameToGroup = new Map();
  externalLists.podwojnaGroups.forEach((g) => {
    g.names.forEach((n) => nameToGroup.set(n.toLowerCase(), g.nr));
  });
  // obliczamy max km "na barana" na grupę, żeby nie sumować podwójnej obsady
  const groupMax = new Map();
  externalLists.podwojnaGroups.forEach((g) => {
    let maxKm = 0;
    g.names.forEach((n) => {
      const d = currentData.drivers.find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (d) maxKm = Math.max(maxKm, d.kilometryNaBarana);
    });
    groupMax.set(g.nr, maxKm);
  });

  return currentData.drivers.map((d) => {
    const groupNr = nameToGroup.get(d.name.toLowerCase());
    const isPod = podSet.has(d.name.toLowerCase());
    const kmBaranaAdj = isPod ? (groupMax.get(groupNr) || 0) : d.kilometryNaBarana;
    const kmTotalAdj = d.kilometrySolo + kmBaranaAdj;
    return { ...d, kilometryNaBaranaAdj: kmBaranaAdj, kilometryTotalAdj: kmTotalAdj, podwojnaNr: groupNr };
  });
}

function computeTotals(driversAdj) {
  const nameToGroup = new Map();
  externalLists.podwojnaGroups.forEach((g) => g.names.forEach((n) => nameToGroup.set(n.toLowerCase(), g.nr)));

  const soloSum = driversAdj.reduce((acc, d) => acc + d.kilometrySolo, 0);

  // km na barana do ogólnej statystyki: sumujemy unikalne pary, ale pomijamy pary z kierowcami z podwójnej obsady
  let baranaSum = 0;
  if (currentData && currentData.duetPairs) {
    currentData.duetPairs.forEach(({ a, b, km }) => {
      if (!nameToGroup.has(a.toLowerCase()) && !nameToGroup.has(b.toLowerCase())) {
        baranaSum += km;
      }
    });
  } else {
    baranaSum = driversAdj
      .filter((d) => !nameToGroup.has(d.name.toLowerCase()))
      .reduce((acc, d) => acc + d.kilometryNaBaranaAdj, 0);
  }

  const totalKm = soloSum + baranaSum;
  return {
    totalDrivers: driversAdj.length,
    totalKm,
    soloKm: soloSum,
    baranaKm: baranaSum,
    avgKm: driversAdj.length ? totalKm / driversAdj.length : 0,
    baranaShare: totalKm ? (baranaSum / totalKm) * 100 : 0,
  };
}

function loadStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (e) {
    console.warn("Nie udalo sie odczytac storage", e);
    return {};
  }
}

function saveStorage(dataObj) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(dataObj));
}

function refreshSavedList() {
  const storage = loadStorage();
  savedList.innerHTML = "";
  const entries = Object.entries(storage);
  if (!entries.length) {
    const li = document.createElement("li");
    li.textContent = "Brak zapisanych zestawow.";
    savedList.appendChild(li);
    return;
  }

  entries
    .sort((a, b) => (b[1].importedAt || "").localeCompare(a[1].importedAt || ""))
    .forEach(([key, value]) => {
      const li = document.createElement("li");
      const info = document.createElement("div");
      info.innerHTML = `<strong>${key}</strong><br/><small>${value.drivers?.length || 0} kierowcow - ${value.fileName || "plik"}</small>`;
      const actions = document.createElement("div");

      const loadBtn = document.createElement("button");
      loadBtn.textContent = "Wczytaj";
      loadBtn.className = "primary";
      loadBtn.onclick = () => loadDataset(key);

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Usun";
      deleteBtn.className = "ghost";
      deleteBtn.onclick = () => {
        const copy = loadStorage();
        delete copy[key];
        saveStorage(copy);
        refreshSavedList();
        setStatus(`Usunieto zapis ${key}`);
      };

      actions.append(loadBtn, deleteBtn);
      li.append(info, actions);
      savedList.appendChild(li);
    });
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (value === null || value === undefined) return 0;
  const num = parseFloat(String(value).replace(",", "."));
  return Number.isFinite(num) ? num : 0;
}

function validateRows(rows) {
  if (!rows.length) {
    return { ok: false, reason: "Arkusz jest pusty." };
  }
  const keys = Object.keys(rows[0] || {});
  const hasDriver = keys.find((k) => k.toLowerCase().includes("kierowca"));
  const hasSolo = keys.find((k) => k.toLowerCase().includes("kilometry solo") || k.toLowerCase().includes("kilometry all"));
  const duetCols = keys.filter((k) => k.toLowerCase().startsWith("kilometry z"));
  if (!hasDriver || !hasSolo || duetCols.length === 0) {
    return {
      ok: false,
      reason: "Brak kolumn 'Kierowca', 'Kilometry all' (lub 'Kilometry solo') oraz co najmniej jednej kolumny 'Kilometry z ...'.",
    };
  }
  return { ok: true };
}

function transformRows(rows) {
  const drivers = [];
  const duetMap = new Map();
  let soloSum = 0;
  let baranaSum = 0;

  rows.forEach((row) => {
    const name = String(row["Kierowca"] || row["kierowca"] || "").trim();
    if (!name) return;
    const kilometryAll = toNumber(row["Kilometry all"] ?? row["kilometry all"] ?? row["Kilometry solo"] ?? row["kilometry solo"]);
    let kilometryNaBarana = 0;
    const duets = [];

    Object.entries(row).forEach(([key, value]) => {
      if (key.toLowerCase().startsWith("kilometry z")) {
        const km = toNumber(value);
        kilometryNaBarana += km;
        if (km > 0) {
          const partner = key.replace(/kilometry z\s*/i, "").trim();
          duets.push({ partner, km });
          const pairKey = [name, partner].sort((a, b) => a.localeCompare(b, "pl")).join(" :: ");
          const existing = duetMap.get(pairKey) || 0;
          // unikamy podwójnego liczenia pary w obie strony – bierzemy maksimum z wpisów
          duetMap.set(pairKey, Math.max(existing, km));
        }
      }
    });

    const kilometrySolo = Math.max(0, kilometryAll - kilometryNaBarana);
    const kilometryTotal = kilometryAll; // kolumna all to łączny dystans
    soloSum += kilometrySolo;
    baranaSum += kilometryNaBarana;
    duets.sort((a, b) => b.km - a.km);

    drivers.push({ name, kilometrySolo, kilometryNaBarana, kilometryTotal, duets });
  });

  drivers.sort((a, b) => b.kilometryTotal - a.kilometryTotal);

  const duetPairs = Array.from(duetMap.entries())
    .map(([key, km]) => {
      const [a, b] = key.split(" :: ");
      return { pair: `${a} + ${b}`, km, a, b };
    })
    .sort((a, b) => b.km - a.km);

  const totals = {
    totalDrivers: drivers.length,
    totalKm: soloSum + baranaSum,
    soloKm: soloSum,
    baranaKm: baranaSum,
    avgKm: drivers.length ? (soloSum + baranaSum) / drivers.length : 0,
    baranaShare: soloSum + baranaSum ? (baranaSum / (soloSum + baranaSum)) * 100 : 0,
  };

  return { drivers, duetPairs, totals };
}

async function processFile(file) {
  if (!file) {
    setStatus("Wybierz plik XLSX.");
    return;
  }
  setStatus("Przetwarzanie pliku...");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: 0 });

  const validation = validateRows(rows);
  if (!validation.ok) {
    setStatus(validation.reason);
    return;
  }

  const parsed = transformRows(rows);
  currentData = {
    ...parsed,
    fileName: file.name,
    sheetName,
    importedAt: new Date().toISOString(),
  };

  if (!datasetNameInput.value) {
    datasetNameInput.value = file.name.replace(/\.[^.]+$/, "");
  }

  setStatus(`Zaladowano ${parsed.drivers.length} kierowcow z arkusza ${sheetName}.`);
  populateDriverSelect(parsed.drivers);
  refreshViews();
}

function populateDriverSelect(drivers, filter = "") {
  driverSelect.innerHTML = "";
  const filtered = drivers.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase()));
  filtered.forEach((driver) => {
    const opt = document.createElement("option");
    opt.value = driver.name;
    opt.textContent = driver.name;
    driverSelect.appendChild(opt);
  });
  if (filtered[0]) {
    driverSelect.value = filtered[0].name;
    showDriver(filtered[0].name);
  } else {
    showDriver(null);
  }
}

function showDriver(name) {
  if (!currentData) return;
  if (!name) {
    soloKmEl.textContent = "0";
    baranaKmEl.textContent = "0";
    totalKmEl.textContent = "0";
    duetTable.innerHTML = "";
    return;
  }
  const driver = currentData.drivers.find((d) => d.name === name);
  if (!driver) return;
  soloKmEl.textContent = numberFormat.format(driver.kilometrySolo);
  baranaKmEl.textContent = numberFormat.format(driver.kilometryNaBarana);
  totalKmEl.textContent = numberFormat.format(driver.kilometryTotal);

  duetTable.innerHTML = "";
  if (!driver.duets.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="2">Brak wspólnych kilometrów.</td>`;
    duetTable.appendChild(row);
  } else {
    driver.duets.forEach((d) => {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${d.partner}</td><td>${numberFormat.format(d.km)} km</td>`;
      duetTable.appendChild(row);
    });
  }
}

function updateSummary(totals) {
  sumTotalEl.textContent = numberFormat.format(totals.totalKm);
  sumSoloEl.textContent = numberFormat.format(totals.soloKm);
  sumBaranaEl.textContent = numberFormat.format(totals.baranaKm);
  shareBaranaEl.textContent = numberFormat.format(totals.baranaShare);
}

function refreshViews() {
  if (!currentData) return;
  const adjustedDrivers = getAdjustedDrivers();
  const totals = computeTotals(adjustedDrivers);
  updateSummary(totals);
  renderCharts(adjustedDrivers, currentData.duetPairs);
}

function renderCharts(drivers, duetPairs) {
  const adjusted = drivers.map((d) =>
    d.kilometryTotalAdj !== undefined ? d : { ...d, kilometryTotalAdj: d.kilometryTotal, kilometryNaBaranaAdj: d.kilometryNaBarana }
  );
  const topTotal = [...adjusted].sort((a, b) => b.kilometryTotalAdj - a.kilometryTotalAdj).slice(0, 10);
  const topSolo = [...adjusted].sort((a, b) => b.kilometrySolo - a.kilometrySolo).slice(0, 10);
  const podwojnaNamesSet = getPodwojnaSet();
  const topBarana = [...adjusted]
    .filter((d) => !podwojnaNamesSet.has(d.name.toLowerCase()))
    .sort((a, b) => b.kilometryNaBaranaAdj - a.kilometryNaBaranaAdj)
    .slice(0, 10);

  renderBar(
    "chart-total",
    topTotal.map((d) => d.name),
    topTotal.map((d) => d.kilometryTotalAdj ?? d.kilometryTotal),
    "Łącznie",
    "#7de3ff"
  );
  renderBar(
    "chart-solo",
    topSolo.map((d) => d.name),
    topSolo.map((d) => d.kilometrySolo),
    "Solo",
    "#7fb0ff"
  );
  renderBar(
    "chart-barana",
    topBarana.map((d) => d.name),
    topBarana.map((d) => d.kilometryNaBaranaAdj ?? d.kilometryNaBarana),
    "Na barana",
    "#ffb86c"
  );

  updateExternalFromCurrent();
}

function renderExternalCharts() {
  const topSystem = externalRankings.system.slice(0, 10);
  const topPodwojna = externalRankings.podwojna.slice(0, 10);

  renderBar(
    "chart-system",
    topSystem.map((d) => d.name),
    topSystem.map((d) => d.km),
    "System",
    "#a4f199"
  );
  renderBar(
    "chart-podwojna",
    topPodwojna.map((d) => d.name),
    topPodwojna.map((d) => d.km),
    "Podwojna obsada",
    "#ff8ad1"
  );
}

function renderBar(canvasId, labels, data, label, color) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
  }
  chartInstances[canvasId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label,
          data,
          backgroundColor: color,
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: "#c5cde0" } },
        y: {
          ticks: { color: "#c5cde0" },
          beginAtZero: true,
        },
      },
      plugins: {
        legend: { labels: { color: "#c5cde0" } },
      },
    },
  });
}

function loadDataset(key) {
  const storage = loadStorage();
  const dataset = storage[key];
  if (!dataset) return;
  currentData = dataset;
  datasetNameInput.value = key;
  setStatus(`Zaladowano zapis: ${key}`);
  populateDriverSelect(dataset.drivers);
  refreshViews();
}

function buildNameList(rows) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0] || {});
  const driverKey = keys.find((k) => String(k).toLowerCase().includes("kierowca")) || keys[0];
  return rows
    .map((row) => String(row[driverKey] ?? "").trim())
    .filter(Boolean);
}

function buildPodwojnaList(rows) {
  if (!rows.length) return { names: [], groups: [] };
  const keys = Object.keys(rows[0] || {});
  const driverKey = keys.find((k) => String(k).toLowerCase().includes("kierowca")) || keys[0];
  const nrKey = keys.find((k) => String(k).toLowerCase() === "nr");

  const names = [];
  const groupMap = new Map();

  rows.forEach((row) => {
    const name = String(row[driverKey] ?? "").trim();
    if (!name) return;
    names.push(name);
    const nr = nrKey ? row[nrKey] : undefined;
    if (nr !== undefined && nr !== null && nr !== "") {
      const key = String(nr).trim();
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(name);
    }
  });

  const groups = Array.from(groupMap.entries())
    .map(([nr, arr]) => ({ nr, names: arr }))
    .sort((a, b) => Number(a.nr) - Number(b.nr));

  return { names, groups };
}

function updateExternalFromCurrent() {
  if (!currentData) {
    externalRankings.system = [];
    externalRankings.podwojna = [];
    renderExternalCharts();
    return;
  }

  const adjustedDrivers = getAdjustedDrivers();

  // System: ranking tylko dla kierowcow z listy system.xlsx (sort po lacznych km)
  const systemNames = new Set(externalLists.system.map((n) => n.toLowerCase()));
  externalRankings.system = adjustedDrivers
    .filter((d) => systemNames.has(d.name.toLowerCase()))
    .map((d) => ({ name: d.name, km: d.kilometryTotalAdj ?? d.kilometryTotal }))
    .sort((a, b) => b.km - a.km);

  // Podwojna obsada: grupy z numerem obsady, km zsumowane po czlonkach (km na barana)
  const driverMap = new Map(adjustedDrivers.map((d) => [d.name.toLowerCase(), d]));
  const groupAggregates = externalLists.podwojnaGroups.map((g) => {
    const members = g.names;
    // bierzemy tylko jednego kierowcę z grupy: tego z największą liczbą km "na barana"
    const kmValues = members.map((name) => driverMap.get(name.toLowerCase())?.kilometryNaBaranaAdj || 0);
    const km = kmValues.length ? Math.max(...kmValues) : 0;
    const label = `Obsada ${g.nr}: ${members.join(" + ")}`;
    return { name: label, km };
  });
  externalRankings.podwojna = groupAggregates.sort((a, b) => b.km - a.km);

  renderExternalCharts();
}

async function loadExternalList(path, key) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: 0 });
    if (key === "podwojna") {
      const { names, groups } = buildPodwojnaList(rows);
      externalLists.podwojna = names;
      externalLists.podwojnaGroups = groups;
    } else {
      externalLists[key] = buildNameList(rows);
    }
    updateExternalFromCurrent();
    refreshViews();
  } catch (err) {
    console.warn(`Nie udalo sie wczytac ${path}:`, err);
    if (key === "podwojna") {
      externalLists.podwojna = [];
      externalLists.podwojnaGroups = [];
    } else {
      externalLists[key] = [];
    }
    updateExternalFromCurrent();
    refreshViews();
  }
}

function handlePickedFile(file) {
  if (!file) return;
  pendingFile = file;
  setStatus(`Wybrano: ${file.name}`);
  if (!datasetNameInput.value) datasetNameInput.value = file.name.replace(/\.[^.]+$/, "");
}

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragenter", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.add("hover");
});
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.add("hover");
});
dropZone.addEventListener("dragleave", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove("hover");
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove("hover");
  const file = e.dataTransfer?.files?.[0];
  handlePickedFile(file);
});

// Zatrzymujemy domyslne otwarcie pliku przez przegladarke nawet poza strefa drop
["dragenter", "dragover", "dragleave", "drop"].forEach((evt) => {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
  });
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) handlePickedFile(file);
});

fileInput.addEventListener("change", (e) => handlePickedFile(e.target.files[0]));

processBtn.addEventListener("click", () => processFile(pendingFile));

saveBtn.addEventListener("click", () => {
  if (!currentData) {
    setStatus("Brak danych do zapisania.");
    return;
  }
  const key = datasetNameInput.value.trim() || currentData.fileName || "dataset";
  const storage = loadStorage();
  storage[key] = currentData;
  saveStorage(storage);
  setStatus(`Zapisano zestaw: ${key}`);
  refreshSavedList();
});

driverSelect.addEventListener("change", (e) => showDriver(e.target.value));

driverSearch.addEventListener("input", (e) => {
  if (!currentData) return;
  populateDriverSelect(currentData.drivers, e.target.value);
});

clearStorageBtn.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  refreshSavedList();
  setStatus("Wyczyszczono zapisane miesiace.");
});

refreshSavedList();
loadExternalList("system.xlsx", "system");
loadExternalList("podwojna.xlsx", "podwojna");


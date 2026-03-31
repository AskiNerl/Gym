const defaultExercises = [
  "\u0416\u0438\u043c \u043b\u0451\u0436\u0430",
  "\u0411\u0438\u0446\u0435\u043f\u0441",
  "\u041f\u0440\u0438\u0441\u0435\u0434",
  "\u041f\u043e\u0434\u0442\u044f\u0433\u0438\u0432\u0430\u043d\u0438\u044f"
];

// Fill these fields to enable cloud sync via Supabase.
const cloudConfig = {
  supabaseUrl: "https://fxolqlfezieggfwdvchp.supabase.co",
  supabaseAnonKey: "sb_publishable_557NYy_OYegz51oNV29ZJA_w_-USYi_",
  stateTable: "workout_state",
  stateId: ""
};

function createCloudClient() {
  if (!cloudConfig.supabaseUrl || !cloudConfig.supabaseAnonKey || !cloudConfig.stateId) {
    return null;
  }

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    return null;
  }

  try {
    return window.supabase.createClient(cloudConfig.supabaseUrl, cloudConfig.supabaseAnonKey);
  } catch (error) {
    return null;
  }
}

function createStorage() {
  let localStorageEnabled = false;

  try {
    let testKey = "__tracker_storage_test__";
    localStorage.setItem(testKey, "1");
    localStorage.removeItem(testKey);
    localStorageEnabled = true;
  } catch (error) {
    localStorageEnabled = false;
  }

  function readCookie(key) {
    let prefix = `${encodeURIComponent(key)}=`;
    let parts = document.cookie ? document.cookie.split("; ") : [];

    for (let part of parts) {
      if (part.startsWith(prefix)) {
        return decodeURIComponent(part.slice(prefix.length));
      }
    }

    return null;
  }

  function writeCookie(key, value) {
    let encodedKey = encodeURIComponent(key);
    let encodedValue = encodeURIComponent(value);
    let maxAgeSeconds = 60 * 60 * 24 * 365 * 3;
    document.cookie = `${encodedKey}=${encodedValue}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
  }

  return {
    getItem(key) {
      if (localStorageEnabled) {
        try {
          let localValue = localStorage.getItem(key);
          if (localValue !== null) {
            return localValue;
          }
        } catch (error) {
          localStorageEnabled = false;
        }
      }

      return readCookie(key);
    },
    setItem(key, value) {
      let saved = false;

      if (localStorageEnabled) {
        try {
          localStorage.setItem(key, value);
          saved = true;
        } catch (error) {
          localStorageEnabled = false;
        }
      }

      try {
        writeCookie(key, value);
        saved = true;
      } catch (error) {
        // Ignore cookie failures if localStorage succeeded.
      }

      return saved;
    }
  };
}

const storage = createStorage();
const indexedDBName = "workout-tracker-db";
const indexedDBStoreName = "app-data";
const cacheStorageName = "workout-tracker-state-v1";
const cacheKeyPrefix = "/__tracker_store__/";
let indexedDBOpenPromise = null;
const cloudClient = createCloudClient();
const cloudSyncKeys = new Set(["workouts", "exercises", "theme"]);
let cloudBootstrapDone = false;
let cloudSyncTimer = null;
let cloudSyncInProgress = false;
let cloudSyncPending = false;
let cloudSyncErrorShown = false;

function openIndexedDB() {
  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }

  if (indexedDBOpenPromise) {
    return indexedDBOpenPromise;
  }

  indexedDBOpenPromise = new Promise(resolve => {
    try {
      let request = indexedDB.open(indexedDBName, 1);

      request.onupgradeneeded = () => {
        let db = request.result;
        if (!db.objectStoreNames.contains(indexedDBStoreName)) {
          db.createObjectStore(indexedDBStoreName);
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        resolve(null);
      };

      request.onblocked = () => {
        resolve(null);
      };
    } catch (error) {
      resolve(null);
    }
  });

  return indexedDBOpenPromise;
}

function getIndexedDBValue(key) {
  return openIndexedDB().then(db => new Promise(resolve => {
    if (!db) {
      resolve(null);
      return;
    }

    try {
      let tx = db.transaction(indexedDBStoreName, "readonly");
      let store = tx.objectStore(indexedDBStoreName);
      let request = store.get(key);

      request.onsuccess = () => {
        resolve(typeof request.result === "string" ? request.result : null);
      };

      request.onerror = () => {
        resolve(null);
      };
    } catch (error) {
      resolve(null);
    }
  }));
}

function setIndexedDBValue(key, value) {
  return openIndexedDB().then(db => new Promise(resolve => {
    if (!db) {
      resolve(false);
      return;
    }

    try {
      let tx = db.transaction(indexedDBStoreName, "readwrite");
      tx.objectStore(indexedDBStoreName).put(value, key);

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (error) {
      resolve(false);
    }
  }));
}

function persistToIndexedDB(key, value) {
  setIndexedDBValue(key, value).catch(() => {});
}

function openStateCache() {
  if (!("caches" in window)) {
    return Promise.resolve(null);
  }

  return caches.open(cacheStorageName).catch(() => null);
}

function toCacheRequestURL(key) {
  return `${cacheKeyPrefix}${encodeURIComponent(key)}`;
}

function getCacheValue(key) {
  return openStateCache().then(cache => new Promise(resolve => {
    if (!cache) {
      resolve(null);
      return;
    }

    cache.match(toCacheRequestURL(key)).then(response => {
      if (!response) {
        resolve(null);
        return;
      }

      response.text().then(text => resolve(text)).catch(() => resolve(null));
    }).catch(() => resolve(null));
  }));
}

function setCacheValue(key, value) {
  return openStateCache().then(cache => new Promise(resolve => {
    if (!cache) {
      resolve(false);
      return;
    }

    try {
      let response = new Response(value, {
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      });

      cache.put(toCacheRequestURL(key), response).then(() => {
        resolve(true);
      }).catch(() => {
        resolve(false);
      });
    } catch (error) {
      resolve(false);
    }
  }));
}

function persistToCache(key, value) {
  setCacheValue(key, value).catch(() => {});
}

function persistRawToAllStores(key, value) {
  storage.setItem(key, value);
  persistToIndexedDB(key, value);
  persistToCache(key, value);
}

function requestPersistentStorage() {
  if (!navigator.storage || typeof navigator.storage.persist !== "function") {
    return;
  }

  navigator.storage.persist().catch(() => {});
}

function isSafariBrowser() {
  let ua = navigator.userAgent;
  let vendor = navigator.vendor || "";
  let isAppleVendor = vendor.includes("Apple");
  let isSafariUA = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Android/i.test(ua);
  return isAppleVendor && isSafariUA;
}

async function requestSafariStorageAccess() {
  if (!isSafariBrowser()) return;
  if (typeof document.hasStorageAccess !== "function") return;
  if (typeof document.requestStorageAccess !== "function") return;

  try {
    let hasAccess = await document.hasStorageAccess();
    if (hasAccess) return;
    await document.requestStorageAccess();
  } catch (error) {
    // If Safari denies, we keep working with available storage layers.
  }
}

function bindSafariStorageAccessRequest() {
  if (!isSafariBrowser()) return;

  let requested = false;

  let requestOnGesture = () => {
    if (requested) return;
    requested = true;
    requestSafariStorageAccess().catch(() => {});
  };

  document.addEventListener("click", requestOnGesture, { capture: true });
  document.addEventListener("touchend", requestOnGesture, { capture: true, passive: true });
}

function isCloudEnabled() {
  return cloudClient !== null;
}

function getCurrentThemeValue() {
  return document.body.classList.contains("dark") ? "dark" : "light";
}

async function runCloudSync() {
  if (!isCloudEnabled()) return;
  if (!cloudBootstrapDone) return;
  if (cloudSyncInProgress) {
    cloudSyncPending = true;
    return;
  }

  cloudSyncInProgress = true;
  cloudSyncPending = false;

  try {
    let payload = {
      id: cloudConfig.stateId,
      workouts,
      exercises,
      theme: getCurrentThemeValue(),
      updated_at: new Date().toISOString()
    };

    let { error } = await cloudClient
      .from(cloudConfig.stateTable)
      .upsert(payload, { onConflict: "id" });

    if (error && !cloudSyncErrorShown) {
      cloudSyncErrorShown = true;
      openNoticeModal("Ошибка синхронизации с облаком. Проверь настройки Supabase.");
    }
  } catch (error) {
    if (!cloudSyncErrorShown) {
      cloudSyncErrorShown = true;
      openNoticeModal("Ошибка синхронизации с облаком. Проверь интернет и настройки Supabase.");
    }
  } finally {
    cloudSyncInProgress = false;
    if (cloudSyncPending) {
      runCloudSync();
    }
  }
}

function scheduleCloudSync(key) {
  if (!cloudSyncKeys.has(key)) return;
  if (!isCloudEnabled()) return;
  if (!cloudBootstrapDone) return;

  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    runCloudSync();
  }, 350);
}

async function bootstrapCloudState() {
  if (!isCloudEnabled()) return;

  try {
    let { data, error } = await cloudClient
      .from(cloudConfig.stateTable)
      .select("id, workouts, exercises, theme")
      .eq("id", cloudConfig.stateId)
      .maybeSingle();

    if (error) {
      cloudBootstrapDone = true;
      if (!cloudSyncErrorShown) {
        cloudSyncErrorShown = true;
        openNoticeModal("Не удалось загрузить облачные данные. Проверь таблицу и ключи Supabase.");
      }
      return;
    }

    let cloudWorkouts = data && Array.isArray(data.workouts) ? data.workouts.slice() : [];
    let cloudExercises = data && Array.isArray(data.exercises) ? data.exercises.slice() : [];
    let cloudTheme = data ? data.theme : null;
    let hasCloudState = cloudWorkouts.length > 0 || cloudExercises.length > 0 || cloudTheme === "dark" || cloudTheme === "light";

    if (hasCloudState) {
      let useCloudWorkouts = cloudWorkouts.length > workouts.length;
      if (useCloudWorkouts) {
        workouts = cloudWorkouts;
        persistRawToAllStores("workouts", JSON.stringify(workouts));
      }

      let useCloudExercises = cloudExercises.length > exercises.length;
      if (!useCloudExercises && cloudExercises.length > 0) {
        useCloudExercises = !hasCustomExercises(exercises) && hasCustomExercises(cloudExercises);
      }

      if (useCloudExercises) {
        exercises = cloudExercises;
        persistRawToAllStores("exercises", JSON.stringify(exercises));
      }

      if (cloudTheme === "dark" || cloudTheme === "light") {
        applyTheme(cloudTheme);
        persistRawToAllStores("theme", cloudTheme);
      }

      normalizeStoredWorkouts();
      ensureRequiredExercises();
      loadExercises(document.getElementById("exerciseSelect").value);
      updateWeightMode();
      render();
      renderCalendar();
    } else {
      cloudBootstrapDone = true;
      await runCloudSync();
      return;
    }
  } catch (error) {
    if (!cloudSyncErrorShown) {
      cloudSyncErrorShown = true;
      openNoticeModal("Не удалось подключиться к Supabase. Проверь URL и ключ.");
    }
  } finally {
    cloudBootstrapDone = true;
  }
}

function getStoredValue(key) {
  return storage.getItem(key);
}

function getStoredJSON(key, fallback) {
  let rawValue = getStoredValue(key);
  if (!rawValue) return fallback;

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    return fallback;
  }
}

function getStoredArray(key, fallback) {
  let parsed = getStoredJSON(key, fallback);

  if (Array.isArray(parsed)) {
    return parsed.slice();
  }

  return Array.isArray(fallback) ? fallback.slice() : [];
}

function setStoredValue(key, value) {
  persistRawToAllStores(key, value);
  scheduleCloudSync(key);
}

function setStoredJSON(key, value) {
  let jsonValue = JSON.stringify(value);
  persistRawToAllStores(key, jsonValue);
  scheduleCloudSync(key);
}

let workouts = getStoredArray("workouts", []);
let exercises = getStoredArray("exercises", defaultExercises);
const lockedExercises = new Set([
  "\u0416\u0438\u043c \u043b\u0451\u0436\u0430",
  "\u0411\u0438\u0446\u0435\u043f\u0441",
  "\u041f\u0440\u0438\u0441\u0435\u0434",
  "\u041f\u043e\u0434\u0442\u044f\u0433\u0438\u0432\u0430\u043d\u0438\u044f"
]);

const bodyweightAllowedExercises = new Set([
  "\u041f\u0440\u0438\u0441\u0435\u0434",
  "\u041f\u043e\u0434\u0442\u044f\u0433\u0438\u0432\u0430\u043d\u0438\u044f"
]);

let pendingDeleteIndex = null;

function ensureRequiredExercises() {
  let changed = false;
  let required = Array.from(lockedExercises);

  required.forEach(exercise => {
    if (!exercises.includes(exercise)) {
      exercises.push(exercise);
      changed = true;
    }
  });

  if (changed) {
    setStoredJSON("exercises", exercises);
  }
}

function isCustomExercise(exercise) {
  return !lockedExercises.has(exercise);
}

function saveExercises() {
  setStoredJSON("exercises", exercises);
}

function parseArrayFromRawStorage(rawValue) {
  if (!rawValue) return [];

  try {
    let parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function hasCustomExercises(list) {
  return list.some(exercise => !lockedExercises.has(exercise));
}

function seedIndexedDBFromSyncStorage() {
  let workoutsRaw = storage.getItem("workouts");
  let exercisesRaw = storage.getItem("exercises");
  let themeRaw = storage.getItem("theme");

  if (workoutsRaw !== null) {
    persistToIndexedDB("workouts", workoutsRaw);
    persistToCache("workouts", workoutsRaw);
  }

  if (exercisesRaw !== null) {
    persistToIndexedDB("exercises", exercisesRaw);
    persistToCache("exercises", exercisesRaw);
  }

  if (themeRaw !== null) {
    persistToIndexedDB("theme", themeRaw);
    persistToCache("theme", themeRaw);
  }
}

async function hydrateFromIndexedDB() {
  let [workoutsRawIDB, exercisesRawIDB, themeRawIDB, workoutsRawCache, exercisesRawCache, themeRawCache] = await Promise.all([
    getIndexedDBValue("workouts"),
    getIndexedDBValue("exercises"),
    getIndexedDBValue("theme"),
    getCacheValue("workouts"),
    getCacheValue("exercises"),
    getCacheValue("theme")
  ]);

  let workoutsFromIDB = parseArrayFromRawStorage(workoutsRawIDB);
  let workoutsFromCache = parseArrayFromRawStorage(workoutsRawCache);
  let exercisesFromIDB = parseArrayFromRawStorage(exercisesRawIDB);
  let exercisesFromCache = parseArrayFromRawStorage(exercisesRawCache);
  let workoutsFromBackup = workoutsFromIDB.length >= workoutsFromCache.length ? workoutsFromIDB : workoutsFromCache;

  let exercisesFromBackup = exercisesFromIDB.length >= exercisesFromCache.length ? exercisesFromIDB : exercisesFromCache;
  if (!exercisesFromBackup.length && exercisesFromCache.length) {
    exercisesFromBackup = exercisesFromCache;
  }

  let changed = false;

  if (workoutsFromBackup.length > workouts.length) {
    workouts = workoutsFromBackup.slice();
    persistRawToAllStores("workouts", JSON.stringify(workouts));
    changed = true;
  }

  let useBackupExercises = exercisesFromBackup.length > exercises.length;
  if (!useBackupExercises && exercisesFromBackup.length) {
    useBackupExercises = !hasCustomExercises(exercises) && hasCustomExercises(exercisesFromBackup);
  }

  if (useBackupExercises) {
    exercises = exercisesFromBackup.slice();
    persistRawToAllStores("exercises", JSON.stringify(exercises));
    changed = true;
  }

  let themeRaw = themeRawIDB === "dark" || themeRawIDB === "light" ? themeRawIDB : themeRawCache;
  if (themeRaw === "dark" || themeRaw === "light") {
    let savedTheme = getStoredValue("theme");
    if (savedTheme !== "dark" && savedTheme !== "light") {
      applyTheme(themeRaw);
      persistRawToAllStores("theme", themeRaw);
    }
  }

  if (!changed) return;

  normalizeStoredWorkouts();
  ensureRequiredExercises();
  loadExercises(document.getElementById("exerciseSelect").value);
  updateWeightMode();
  render();
  renderCalendar();
}

function updateWeightMode() {
  let exercise = document.getElementById("exerciseSelect").value;
  let weightInput = document.getElementById("weight");
  let bodyweightRow = document.getElementById("bodyweightRow");
  let bodyweightToggle = document.getElementById("bodyweightToggle");
  let canUseBodyweight = bodyweightAllowedExercises.has(exercise);

  bodyweightRow.hidden = !canUseBodyweight;

  if (!canUseBodyweight) {
    bodyweightToggle.checked = false;
  }

  let useBodyweight = canUseBodyweight && bodyweightToggle.checked;
  weightInput.disabled = useBodyweight;
  weightInput.placeholder = useBodyweight ? "\u0421\u0432\u043e\u0439 \u0432\u0435\u0441" : "\u0412\u0435\u0441 (\u043a\u0433)";
  if (useBodyweight) {
    weightInput.value = "";
  }
}

function bindExerciseControls() {
  let exerciseSelect = document.getElementById("exerciseSelect");
  let bodyweightToggle = document.getElementById("bodyweightToggle");

  exerciseSelect.addEventListener("change", () => {
    updateWeightMode();
    renderExercisePicker();
  });
  bodyweightToggle.addEventListener("change", updateWeightMode);
}

function getTodayISO() {
  let today = new Date();
  let year = today.getFullYear();
  let month = String(today.getMonth() + 1).padStart(2, "0");
  let day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDateString(value) {
  if (typeof value !== "string") return "";

  let date = value.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date;
  }

  let ruDateMatch = date.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!ruDateMatch) {
    return "";
  }

  let day = String(ruDateMatch[1]).padStart(2, "0");
  let month = String(ruDateMatch[2]).padStart(2, "0");
  let year = ruDateMatch[3];

  return `${year}-${month}-${day}`;
}

function formatDateForDisplay(value) {
  let isoDate = normalizeDateString(value);
  if (!isoDate) return value;

  let [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

function normalizeStoredWorkouts() {
  let changed = false;

  workouts = workouts.map(workout => {
    let normalizedDate = normalizeDateString(workout.date);

    if (!normalizedDate || normalizedDate === workout.date) {
      return workout;
    }

    changed = true;
    return { ...workout, date: normalizedDate };
  });

  if (changed) {
    setStoredJSON("workouts", workouts);
  }
}

let editingPickerExercise = "";
let openedPickerExercise = "";
let pickerMenuAnimationTimer = null;

function loadExercises(preferredExercise = "") {
  let select = document.getElementById("exerciseSelect");
  let currentValue = preferredExercise || select.value;
  select.innerHTML = "";

  exercises.forEach(ex => {
    let option = document.createElement("option");
    option.value = ex;
    option.textContent = ex;
    select.appendChild(option);
  });

  let nextValue = currentValue && exercises.includes(currentValue) ? currentValue : (exercises[0] || "");
  if (nextValue) {
    select.value = nextValue;
  }

  renderExercisePicker();
  updateWeightMode();
}

function renderExercisePicker() {
  let select = document.getElementById("exerciseSelect");
  let selectedExercise = select.value;
  let toggle = document.getElementById("exercisePickerToggle");
  let list = document.getElementById("exercisePickerList");
  if (!toggle || !list) return;

  toggle.textContent = selectedExercise || "Выбрать упражнение";
  list.innerHTML = "";

  if (editingPickerExercise && !exercises.includes(editingPickerExercise)) {
    editingPickerExercise = "";
  }

  if (openedPickerExercise && !exercises.includes(openedPickerExercise)) {
    openedPickerExercise = "";
  }

  exercises.forEach((exerciseName, index) => {
    let isCustom = isCustomExercise(exerciseName);
    let row = document.createElement("div");
    row.className = "exercise-option-row";
    row.style.setProperty("--row-index", String(index));

    if (exerciseName === selectedExercise) {
      row.classList.add("active");
    }

    if (isCustom) {
      row.classList.add("custom");
    }

    if (openedPickerExercise === exerciseName) {
      row.classList.add("open");
    }

    if (editingPickerExercise === exerciseName) {
      row.classList.add("editing");

      let editRow = document.createElement("div");
      editRow.className = "exercise-option-edit-row";

      let input = document.createElement("input");
      input.type = "text";
      input.value = exerciseName;
      input.placeholder = "Новое название";
      input.maxLength = 40;

      let saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.className = "exercise-option-save";
      saveButton.textContent = "Сохранить";
      saveButton.onclick = event => {
        event.stopPropagation();
        renameCustomExercise(exerciseName, input.value);
      };

      let cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "exercise-option-cancel";
      cancelButton.textContent = "Отмена";
      cancelButton.onclick = event => {
        event.stopPropagation();
        editingPickerExercise = "";
        renderExercisePicker();
      };

      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          renameCustomExercise(exerciseName, input.value);
        }

        if (event.key === "Escape") {
          editingPickerExercise = "";
          renderExercisePicker();
        }
      });

      editRow.appendChild(input);
      editRow.appendChild(saveButton);
      editRow.appendChild(cancelButton);
      row.appendChild(editRow);

      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    } else {
      let mainButton = document.createElement("button");
      mainButton.type = "button";
      mainButton.className = "exercise-option-main";
      mainButton.textContent = exerciseName;
      mainButton.setAttribute("role", "option");
      mainButton.setAttribute("aria-selected", exerciseName === selectedExercise ? "true" : "false");
      mainButton.onclick = event => {
        event.preventDefault();
        openedPickerExercise = "";
        editingPickerExercise = "";
        select.value = exerciseName;
        updateWeightMode();
        renderExercisePicker();
        closeExercisePicker();
      };

      row.appendChild(mainButton);

      if (isCustom) {
        let actions = document.createElement("div");
        actions.className = "exercise-option-actions";

        let editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "exercise-option-edit";
        editButton.textContent = "Редакт.";
        editButton.onclick = event => {
          event.stopPropagation();
          editingPickerExercise = exerciseName;
          openedPickerExercise = "";
          renderExercisePicker();
        };

        let deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "exercise-option-delete";
        deleteButton.textContent = "Удалить";
        deleteButton.onclick = event => {
          event.stopPropagation();
          removeCustomExercise(exerciseName);
        };

        actions.appendChild(editButton);
        actions.appendChild(deleteButton);
        row.appendChild(actions);

        bindPickerSwipe(mainButton, exerciseName);
      }
    }

    list.appendChild(row);
  });
}

function openExercisePicker() {
  let menu = document.getElementById("exercisePickerMenu");
  let toggle = document.getElementById("exercisePickerToggle");
  if (!menu || !toggle) return;

  menu.hidden = false;
  menu.classList.remove("menu-opening");
  requestAnimationFrame(() => {
    menu.classList.add("menu-opening");
  });
  clearTimeout(pickerMenuAnimationTimer);
  pickerMenuAnimationTimer = setTimeout(() => {
    menu.classList.remove("menu-opening");
  }, 320);
  toggle.classList.add("open");
  toggle.setAttribute("aria-expanded", "true");
}

function closeExercisePicker() {
  let menu = document.getElementById("exercisePickerMenu");
  let toggle = document.getElementById("exercisePickerToggle");
  if (!menu || !toggle) return;

  menu.hidden = true;
  clearTimeout(pickerMenuAnimationTimer);
  menu.classList.remove("menu-opening");
  toggle.classList.remove("open");
  toggle.setAttribute("aria-expanded", "false");
}

function bindExercisePickerControls() {
  let toggle = document.getElementById("exercisePickerToggle");
  if (!toggle) return;

  toggle.addEventListener("click", event => {
    event.preventDefault();
    let menu = document.getElementById("exercisePickerMenu");
    if (!menu || menu.hidden) {
      openExercisePicker();
      return;
    }

    closeExercisePicker();
  });

  document.addEventListener("click", event => {
    if (!event.target.closest(".exercise-picker")) {
      closeExercisePicker();

      if (openedPickerExercise || editingPickerExercise) {
        openedPickerExercise = "";
        editingPickerExercise = "";
        renderExercisePicker();
      }
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeExercisePicker();

      if (openedPickerExercise || editingPickerExercise) {
        openedPickerExercise = "";
        editingPickerExercise = "";
        renderExercisePicker();
      }
    }
  });
}

function bindPickerSwipe(node, exerciseName) {
  let startX = 0;
  let startY = 0;

  node.addEventListener("touchstart", event => {
    let touch = event.changedTouches[0];
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });

  node.addEventListener("touchend", event => {
    let touch = event.changedTouches[0];
    let dx = touch.clientX - startX;
    let dy = touch.clientY - startY;

    if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy)) {
      return;
    }

    if (dx < -30) {
      openedPickerExercise = exerciseName;
      renderExercisePicker();
      return;
    }

    if (dx > 30 && openedPickerExercise === exerciseName) {
      openedPickerExercise = "";
      renderExercisePicker();
    }
  }, { passive: true });
}

function addExercise() {
  let input = document.getElementById("newExercise");
  let value = input.value.trim();

  if (!value) return;

  if (exercises.includes(value)) {
    openNoticeModal("Такое упражнение уже есть.");
    return;
  }

  exercises.push(value);
  saveExercises();

  input.value = "";
  loadExercises(value);
}

function renameCustomExercise(oldName, nextName) {
  if (!isCustomExercise(oldName)) return;

  let newName = nextName.trim();
  if (!newName) {
    openNoticeModal("Введите название упражнения.");
    return;
  }

  if (newName !== oldName && exercises.includes(newName)) {
    openNoticeModal("Такое упражнение уже есть.");
    return;
  }

  let index = exercises.indexOf(oldName);
  if (index === -1) return;

  exercises[index] = newName;
  saveExercises();

  let workoutsChanged = false;
  workouts = workouts.map(workout => {
    if (workout.exercise !== oldName) {
      return workout;
    }

    workoutsChanged = true;
    return { ...workout, exercise: newName };
  });

  if (workoutsChanged) {
    setStoredJSON("workouts", workouts);
  }

  let selectedExercise = document.getElementById("exerciseSelect").value;
  let nextSelected = selectedExercise === oldName ? newName : selectedExercise;

  editingPickerExercise = "";
  openedPickerExercise = "";
  loadExercises(nextSelected);
  render();
  renderCalendar();
}

function removeCustomExercise(exerciseName) {
  if (!isCustomExercise(exerciseName)) return;

  exercises = exercises.filter(exercise => exercise !== exerciseName);
  saveExercises();

  if (editingPickerExercise === exerciseName) {
    editingPickerExercise = "";
  }

  if (openedPickerExercise === exerciseName) {
    openedPickerExercise = "";
  }

  let selectedExercise = document.getElementById("exerciseSelect").value;
  let nextSelected = selectedExercise === exerciseName ? (exercises[0] || "") : selectedExercise;
  loadExercises(nextSelected);
}

function addWorkout() {
  let exercise = document.getElementById("exerciseSelect").value;
  let bodyweightToggle = document.getElementById("bodyweightToggle");
  let useBodyweight = bodyweightAllowedExercises.has(exercise) && bodyweightToggle.checked;
  let weight = parseFloat(document.getElementById("weight").value);
  let sets = parseInt(document.getElementById("sets").value, 10);
  let isWeightInvalid = Number.isNaN(weight);
  let today = getTodayISO();

  if (selectedDate > today) {
    openNoticeModal("На будущее нельзя ставить записи тренировок.");
    return;
  }

  if (Number.isNaN(sets)) return;
  if (!useBodyweight && isWeightInvalid) return;

  if (weight < 0 || sets < 0) {
    alert("\u0412\u0435\u0441 \u0438 \u043f\u043e\u0434\u0445\u043e\u0434\u044b \u043d\u0435 \u043c\u043e\u0433\u0443\u0442 \u0431\u044b\u0442\u044c \u043c\u0435\u043d\u044c\u0448\u0435 0");
    return;
  }

  if (!useBodyweight && weight <= 0) {
    alert("\u0412\u0435\u0441 \u0434\u043e\u043b\u0436\u0435\u043d \u0431\u044b\u0442\u044c \u0431\u043e\u043b\u044c\u0448\u0435 0 \u043a\u0433");
    return;
  }

  if (sets === 0) {
    alert("\u041a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e \u043f\u043e\u0434\u0445\u043e\u0434\u043e\u0432 \u0434\u043e\u043b\u0436\u043d\u043e \u0431\u044b\u0442\u044c \u0431\u043e\u043b\u044c\u0448\u0435 0");
    return;
  }

  let workout = {
    exercise,
    weight: useBodyweight ? null : weight,
    bodyweight: useBodyweight,
    sets,
    date: selectedDate
  };

  workouts.push(workout);
  setStoredJSON("workouts", workouts);

  render();
  renderCalendar();
}

function formatWorkoutWeight(workout) {
  let legacyBodyweight = bodyweightAllowedExercises.has(workout.exercise) && Number(workout.weight) === 0;
  let isBodyweightWorkout = workout.bodyweight === true || legacyBodyweight;

  return isBodyweightWorkout ? "\u0441\u0432\u043e\u0439 \u0432\u0435\u0441" : `${workout.weight} \u043a\u0433`;
}

function syncModalBodyState() {
  let confirmModal = document.getElementById("confirmModal");
  let noticeModal = document.getElementById("noticeModal");
  let hasOpenModal = (confirmModal && !confirmModal.hidden) || (noticeModal && !noticeModal.hidden);
  document.body.classList.toggle("modal-open", hasOpenModal);
}

function openDeleteModal(index) {
  let workout = workouts[index];
  if (!workout) return;

  pendingDeleteIndex = index;

  let modal = document.getElementById("confirmModal");
  let text = document.getElementById("confirmText");
  let dateForDisplay = formatDateForDisplay(workout.date);
  let weightLabel = formatWorkoutWeight(workout);
  text.textContent = `${dateForDisplay} - ${workout.exercise}: ${weightLabel} (${workout.sets} \u043f\u043e\u0434\u0445\u043e\u0434\u043e\u0432)`;

  modal.hidden = false;
  syncModalBodyState();
}

function openNoticeModal(message, title = "Ошибка") {
  let modal = document.getElementById("noticeModal");
  let titleNode = document.getElementById("noticeTitle");
  let textNode = document.getElementById("noticeText");

  titleNode.textContent = title;
  textNode.textContent = message;
  modal.hidden = false;
  syncModalBodyState();
}

function closeDeleteModal() {
  pendingDeleteIndex = null;
  document.getElementById("confirmModal").hidden = true;
  syncModalBodyState();
}

function closeNoticeModal() {
  document.getElementById("noticeModal").hidden = true;
  syncModalBodyState();
}

function confirmDeleteWorkout() {
  if (pendingDeleteIndex === null) return;
  if (!workouts[pendingDeleteIndex]) {
    closeDeleteModal();
    return;
  }

  workouts.splice(pendingDeleteIndex, 1);
  setStoredJSON("workouts", workouts);
  closeDeleteModal();

  render();
  renderCalendar();
}

function bindDeleteModal() {
  document.getElementById("confirmCancel").addEventListener("click", closeDeleteModal);
  document.getElementById("confirmBackdrop").addEventListener("click", closeDeleteModal);
  document.getElementById("confirmDelete").addEventListener("click", confirmDeleteWorkout);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !document.getElementById("confirmModal").hidden) {
      closeDeleteModal();
    }
  });
}

function bindNoticeModal() {
  document.getElementById("noticeOk").addEventListener("click", closeNoticeModal);
  document.getElementById("noticeBackdrop").addEventListener("click", closeNoticeModal);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !document.getElementById("noticeModal").hidden) {
      closeNoticeModal();
    }
  });
}

function bindSettingsControls() {
  let settingsBtn = document.querySelector(".settings-btn");
  if (!settingsBtn) return;

  settingsBtn.type = "button";
  settingsBtn.setAttribute("aria-label", "Открыть настройки");
  settingsBtn.removeAttribute("onclick");

  let toggleSettings = event => {
    event.preventDefault();
    event.stopPropagation();
    toggleMenu();
  };

  settingsBtn.addEventListener("click", toggleSettings);

  document.addEventListener("click", event => {
    let menu = document.getElementById("menu");
    if (!menu || menu.style.display !== "block") return;

    if (event.target.closest(".settings-btn") || event.target.closest(".settings-menu")) {
      return;
    }

    menu.style.display = "none";
  });
}

function bindMobileZoomLock() {
  let lastTouchEnd = 0;

  document.addEventListener("touchend", event => {
    let target = event.target;
    let isInteractive = target && target.closest && target.closest("button, input, select, textarea, label, a");
    let now = Date.now();

    if (!isInteractive && now - lastTouchEnd <= 300) {
      event.preventDefault();
    }
    lastTouchEnd = now;
  }, { passive: false });

  document.addEventListener("touchmove", event => {
    if (event.touches.length > 1) {
      event.preventDefault();
    }

    if (typeof event.scale === "number" && event.scale !== 1) {
      event.preventDefault();
    }
  }, { passive: false });

  document.addEventListener("gesturestart", event => event.preventDefault());
  document.addEventListener("gesturechange", event => event.preventDefault());
  document.addEventListener("gestureend", event => event.preventDefault());
}

function requestDeleteWorkout(index) {
  openDeleteModal(index);
}

function render() {
  let list = document.getElementById("list");
  list.innerHTML = "";

  let workoutsForDate = workouts
    .map((workout, index) => ({ workout, index }))
    .filter(item => normalizeDateString(item.workout.date) === selectedDate)
    .slice()
    .reverse();

  if (!workoutsForDate.length) {
    list.style.display = "none";
    return;
  }

  list.style.display = "block";

  workoutsForDate.forEach(item => {
    let w = item.workout;
    let li = document.createElement("li");
    li.className = "workout-item";

    let content = document.createElement("div");
    content.className = "workout-content";

    let info = document.createElement("div");
    info.className = "workout-info";
    let dateForDisplay = formatDateForDisplay(w.date);
    let weightLabel = formatWorkoutWeight(w);
    info.textContent = `${dateForDisplay} - ${w.exercise}: ${weightLabel} (${w.sets} \u043f\u043e\u0434\u0445\u043e\u0434\u043e\u0432)`;

    let deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-btn";
    deleteButton.textContent = "\u00d7";
    deleteButton.title = "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0437\u0430\u043f\u0438\u0441\u044c";
    deleteButton.setAttribute("aria-label", "\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0437\u0430\u043f\u0438\u0441\u044c");
    deleteButton.onclick = event => {
      event.stopPropagation();
      requestDeleteWorkout(item.index);
    };

    content.appendChild(info);
    content.appendChild(deleteButton);

    li.appendChild(content);
    list.appendChild(li);
  });
}

// \u0422\u0415\u041c\u0410
function toggleTheme() {
  document.body.classList.toggle("dark");
  setStoredValue("theme",
    document.body.classList.contains("dark") ? "dark" : "light"
  );
}

function applyTheme(theme) {
  document.body.classList.toggle("dark", theme === "dark");
}

function getSystemTheme() {
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function loadTheme() {
  let savedTheme = getStoredValue("theme");

  if (savedTheme === "dark" || savedTheme === "light") {
    applyTheme(savedTheme);
    return;
  }

  applyTheme(getSystemTheme());
}

function bindSystemThemeSync() {
  if (!window.matchMedia) return;

  let media = window.matchMedia("(prefers-color-scheme: dark)");
  let handleChange = event => {
    let savedTheme = getStoredValue("theme");
    if (savedTheme === "dark" || savedTheme === "light") {
      return;
    }

    applyTheme(event.matches ? "dark" : "light");
  };

  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", handleChange);
    return;
  }

  if (typeof media.addListener === "function") {
    media.addListener(handleChange);
  }
}

function toggleMenu() {
  let menu = document.getElementById("menu");
  menu.style.display = menu.style.display === "block" ? "none" : "block";
}

let currentDate = new Date();
let selectedDate = getTodayISO();

normalizeStoredWorkouts();
ensureRequiredExercises();
requestPersistentStorage();
seedIndexedDBFromSyncStorage();
loadTheme();
bindSystemThemeSync();
bindSafariStorageAccessRequest();
bindExercisePickerControls();
loadExercises();
bindExerciseControls();
bindDeleteModal();
bindNoticeModal();
bindSettingsControls();
bindMobileZoomLock();
updateWeightMode();
render();

// \u041c\u0415\u0421\u042f\u0426\u042b
const months = [
  "\u042f\u043d\u0432\u0430\u0440\u044c", "\u0424\u0435\u0432\u0440\u0430\u043b\u044c", "\u041c\u0430\u0440\u0442", "\u0410\u043f\u0440\u0435\u043b\u044c", "\u041c\u0430\u0439", "\u0418\u044e\u043d\u044c",
  "\u0418\u044e\u043b\u044c", "\u0410\u0432\u0433\u0443\u0441\u0442", "\u0421\u0435\u043d\u0442\u044f\u0431\u0440\u044c", "\u041e\u043a\u0442\u044f\u0431\u0440\u044c", "\u041d\u043e\u044f\u0431\u0440\u044c", "\u0414\u0435\u043a\u0430\u0431\u0440\u044c"
];

const weekdays = ["\u041f\u043d", "\u0412\u0442", "\u0421\u0440", "\u0427\u0442", "\u041f\u0442", "\u0421\u0431", "\u0412\u0441"];

function renderWeekdays() {
  let weekdaysRow = document.getElementById("calendarWeekdays");
  weekdaysRow.innerHTML = "";

  weekdays.forEach(dayName => {
    let day = document.createElement("div");
    day.className = "weekday";
    day.textContent = dayName;
    weekdaysRow.appendChild(day);
  });
}

// \u041f\u0415\u0420\u0415\u041a\u041b\u042e\u0427\u0415\u041d\u0418\u0415 \u041c\u0415\u0421\u042f\u0426\u0410
function changeMonth(step) {
  currentDate.setMonth(currentDate.getMonth() + step);
  renderCalendar();
}

// \u041e\u0422\u0420\u0418\u0421\u041e\u0412\u041a\u0410 \u041a\u0410\u041b\u0415\u041d\u0414\u0410\u0420\u042f
function renderCalendar() {
  let grid = document.getElementById("calendarGrid");
  let label = document.getElementById("monthLabel");

  grid.innerHTML = "";

  let year = currentDate.getFullYear();
  let month = currentDate.getMonth();
  let today = getTodayISO();

  label.textContent = `${months[month]} ${year}`;

  let firstDay = new Date(year, month, 1).getDay();
  let daysInMonth = new Date(year, month + 1, 0).getDate();

  // \u0418\u0441\u043f\u0440\u0430\u0432\u043b\u044f\u0435\u043c, \u0447\u0442\u043e\u0431\u044b \u043d\u0435\u0434\u0435\u043b\u044f \u043d\u0430\u0447\u0438\u043d\u0430\u043b\u0430\u0441\u044c \u0441 \u043f\u043e\u043d\u0435\u0434\u0435\u043b\u044c\u043d\u0438\u043a\u0430
  let start = firstDay === 0 ? 6 : firstDay - 1;

  for (let i = 0; i < start; i++) {
    let emptyDay = document.createElement("div");
    emptyDay.className = "day empty";
    grid.appendChild(emptyDay);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    let dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

    let hasWorkout = workouts.some(w => normalizeDateString(w.date) === dateStr);

    let className = "day";
    if (dateStr === selectedDate) className += " active";
    if (dateStr === today) className += " today";
    if (hasWorkout) className += " has-workout";

    let div = document.createElement("div");
    div.className = className;
    div.textContent = d;

    div.onclick = () => {
      selectedDate = dateStr;
      render();
      renderCalendar();
    };

    grid.appendChild(div);
  }
}

renderWeekdays();
renderCalendar();
hydrateFromIndexedDB()
  .catch(() => {})
  .finally(() => {
    bootstrapCloudState().catch(() => {});
  });

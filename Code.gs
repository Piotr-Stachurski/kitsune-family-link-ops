// ==========================================
// KITSUNE LINK OPS - BACKEND & DATA PIPELINE
// v2.1 — refactored
// ==========================================

const scriptProps = PropertiesService.getScriptProperties();
function forceAuthorize() {
  ScriptApp.getProjectTriggers();
  DriveApp.getRootFolder();
  SpreadsheetApp.getActiveSpreadsheet();
  return "OK";
}

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('Kitsune - Family Link Ops')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
}

function getAppUrl() {
  return ScriptApp.getService().getUrl();
}

function checkSetup() {
  const apiKey = scriptProps.getProperty('GEMINI_API_KEY');
  const dropzone = scriptProps.getProperty('DROPZONE_FOLDER_ID');
  return (apiKey && dropzone) ? true : false;
}

function initializeSystem(apiKey) {
  try {
    // [FIX] Walidacja formatu API key — musi zaczynać się od "AIza" i mieć min. 35 znaków
    if (!apiKey || !apiKey.startsWith('AIza') || apiKey.length < 35) {
      return { success: false, message: "Nieprawidłowy klucz API. Klucz Gemini zaczyna się od 'AIza' i ma co najmniej 35 znaków. Pobierz go na: https://aistudio.google.com/apikey" };
    }

    scriptProps.setProperty('GEMINI_API_KEY', apiKey);
    const rootFolder = DriveApp.createFolder('Kitsune_Link_Ops_System');
    const dropzone = rootFolder.createFolder('Dropzone');
    const archive = rootFolder.createFolder('Archiwum');

    scriptProps.setProperty('DROPZONE_FOLDER_ID', dropzone.getId());
    scriptProps.setProperty('ARCHIVE_FOLDER_ID', archive.getId());

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (sheet.getLastRow() === 0) {
      // [FIX] Dodana kolumna Category — Gemini teraz kategoryzuje przy ekstrakcji
      sheet.appendRow(["Dziecko", "Data", "Total_Min", "Apps_Payload"]);
      sheet.getRange("A1:D1").setFontWeight("bold");
    }
    return { success: true, message: "Ekosystem pomyślnie postawiony." };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function getTelemetryData() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const data = sheet.getDataRange().getValues();

  if (data.length <= 1) return JSON.stringify([]);

  const result = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    let userStr = row[0] || "Nieznany";
    let dateStr = row[1];

    if (dateStr instanceof Date) {
      dateStr = Utilities.formatDate(dateStr, Session.getScriptTimeZone(), "yyyy-MM-dd");
    }

    let appsObj = {};
    try { appsObj = JSON.parse(row[3]); }
    catch(err) { Logger.log("Błąd parsowania wiersza " + (i+1)); }

    result.push({
      user: userStr,
      date: dateStr,
      total_min: parseInt(row[2]) || 0,
      apps: appsObj
    });
  }
  result.sort((a, b) => new Date(a.date) - new Date(b.date));
  return JSON.stringify(result);
}

// [FIX] processDropzone() — ASYNC pattern.
// Ta funkcja NIE jest już wywoływana synchronicznie z uploadFileFromFrontend().
// Zamiast tego: upload zapisuje plik do Dropzone i kończy request.
// processDropzone() jest wywoływane przez osobny time-based trigger (co 5 minut)
// LUB ręcznie przez użytkownika z poziomu GAS editor.
// Instrukcja setup triggera: GAS Editor → Triggers → Add Trigger →
//   Function: processDropzone | Event: Time-driven | Every 5 minutes
function processDropzone() {
  const API_KEY = scriptProps.getProperty('GEMINI_API_KEY');
  const DROPZONE_ID = scriptProps.getProperty('DROPZONE_FOLDER_ID');
  const ARCHIVE_ID = scriptProps.getProperty('ARCHIVE_FOLDER_ID');

  if (!API_KEY || !DROPZONE_ID) return;

  const dropzone = DriveApp.getFolderById(DROPZONE_ID);
  const archive = DriveApp.getFolderById(ARCHIVE_ID);
  const files = dropzone.getFilesByType(MimeType.PDF);

  while (files.hasNext()) {
    const file = files.next();
    try {
      const extractedData = extractDataWithGemini(file, API_KEY);
      if (extractedData && extractedData.length > 0) {
        upsertToSheet(extractedData);
        file.moveTo(archive);
      }
    } catch (e) {
      Logger.log('Błąd pliku ' + file.getName() + ': ' + e.message);
    }
  }
}

function extractDataWithGemini(file, apiKey) {
  const base64Pdf = Utilities.base64Encode(file.getBlob().getBytes());

  // [FIX] Rozszerzony fallback chain — 4 modele
  const fallbackChain = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

  // [FIX] Prompt rozszerzony o kategoryzację — Gemini teraz sam kategoryzuje każdą aplikację.
  // Usunięta hardcoded CATEGORY_MAP z frontendu — dane kategorii płyną z Sheets przez payload.
  // Dostępne kategorie: entertainment, social, education, other
  const prompt = `Jesteś analitycznym systemem ekstrakcji danych. Analizujesz wielostronicowy raport PDF z czasem ekranowym w formie screenshotów.
Plik to: ${file.getName()}.
Wyciągnij z nazwy pliku imię dziecka (pierwsze słowo przed znakiem _ lub spacją).

ZASADY EKSTRAKCJI:
1. Dokument to ciąg screenshotów. Jeśli na ekranie nie ma nowej daty, to jest KONTYNUACJA poprzedniego dnia.
2. Komasuj wszystkie aplikacje pod ostatnio wykrytą datą. Nie twórz duplikatów dni.
3. Dla każdej aplikacji przypisz kategorię: "entertainment", "social", "education" lub "other".
   Zasady kategoryzacji:
   - entertainment: gry, YouTube, TikTok, streaming wideo, muzyka
   - social: komunikatory, media społecznościowe (WhatsApp, Instagram, Snapchat, Discord, itp.)
   - education: aplikacje edukacyjne, nauka języków, platformy szkolne (Duolingo, Librus, Khan Academy, itp.)
   - other: wszystko pozostałe (ustawienia, przeglądarka, narzędzia systemowe, itp.)

Zwróć wynik WYŁĄCZNIE jako surowy JSON (bez markdown, bez backticks, bez komentarzy):
[
  {
    "user": "Imię_Wyciągnięte_z_Pliku",
    "date": "YYYY-MM-DD",
    "total_min": 150,
    "apps": {
      "Roblox": { "min": 120, "category": "entertainment" },
      "YouTube": { "min": 30, "category": "entertainment" }
    }
  }
]`;

  const payload = {
    "contents": [{
      "parts": [
        { "text": prompt },
        { "inline_data": { "mime_type": "application/pdf", "data": base64Pdf } }
      ]
    }]
  };
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  let lastError = null;
  for (let i = 0; i < fallbackChain.length; i++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${fallbackChain[i]}:generateContent?key=${apiKey}`;
    try {
      const response = UrlFetchApp.fetch(url, options);
      const json = JSON.parse(response.getContentText());
      if (response.getResponseCode() === 200 && !json.error) {
        let rawText = json.candidates[0].content.parts[0].text
          .replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(rawText);
      }
      lastError = json.error ? json.error.message : `HTTP ${response.getResponseCode()}`;
      Logger.log(`Model ${fallbackChain[i]} failed: ${lastError}`);
    } catch (e) {
      lastError = e.message;
      Logger.log(`Model ${fallbackChain[i]} exception: ${lastError}`);
    }
  }
  throw new Error(`Wszystkie modele Gemini zawiodły. Ostatni błąd: ${lastError}`);
}

// [FIX] upsertToSheet() — batch write zamiast N×2 individual calls.
// Logika: wczytaj cały arkusz → oblicz zmiany w pamięci → jeden zapis setValues().
// Eliminuje ryzyko GAS timeout przy dużych batchach (np. rok danych wstecz).
function upsertToSheet(dataArray) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const allValues = sheet.getDataRange().getValues();

  // Buduj index: compositeKey → row index (0-based w tablicy)
  const indexMap = {};
  for (let i = 1; i < allValues.length; i++) {
    let dateStr = allValues[i][1];
    if (dateStr instanceof Date) {
      dateStr = Utilities.formatDate(dateStr, Session.getScriptTimeZone(), "yyyy-MM-dd");
    }
    indexMap[`${allValues[i][0]}_${dateStr}`] = i;
  }

  const rowsToAppend = [];

  dataArray.forEach(day => {
    const compositeKey = `${day.user}_${day.date}`;
    const appsJson = JSON.stringify(day.apps);

    if (indexMap[compositeKey] !== undefined) {
      // UPDATE w pamięci — zmodyfikuj tablicę lokalnie
      const rowIdx = indexMap[compositeKey];
      allValues[rowIdx][2] = day.total_min;
      allValues[rowIdx][3] = appsJson;
    } else {
      // INSERT — dodaj do kolejki
      rowsToAppend.push([day.user, day.date, day.total_min, appsJson]);
    }
  });

  // Jeden batch write dla updates
  if (allValues.length > 1) {
    sheet.getRange(1, 1, allValues.length, 4).setValues(allValues);
  }

  // Batch append dla nowych wierszy
  if (rowsToAppend.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, 4).setValues(rowsToAppend);
  }
}

// [FIX v2.2] uploadFileFromFrontend() — async pattern z auto-triggerem.
// Plik trafia do Dropzone i automatycznie tworzy jednorazowy trigger
// który odpala processDropzone() za 10 sekund.
// Trigger sam się usuwa po wykonaniu (cleanup w processDropzone()).
// Zero ręcznej konfiguracji triggerów w GAS Editor — wgrywasz kod, działa.
function uploadFileFromFrontend(dataURI, filename) {
  try {
    // [FIX] Walidacja nazwy pliku — regex zamiast includes('_')
    const validName = /^[A-Za-zÀ-žĄąĆćĘęŁłŃńÓóŚśŹźŻż]+[_ ].+\.pdf$/i.test(filename);
    if (!validName) {
      return { success: false, message: "Nieprawidłowa nazwa pliku. Wymagany format: Imię_Data.pdf (np. Zuzia_2024-03.pdf)" };
    }

    const dropzoneId = scriptProps.getProperty('DROPZONE_FOLDER_ID');
    if (!dropzoneId) {
      return { success: false, message: "System nie jest skonfigurowany. Odśwież stronę i przejdź przez Setup." };
    }

    const mimeType = dataURI.split(';')[0].replace('data:', '');
    const base64Data = dataURI.split(',')[1];
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename);
    DriveApp.getFolderById(dropzoneId).createFile(blob);

    // [FIX v2.2] Cleanup starych triggerów processDropzone (limit GAS: 20 per user)
    // Usuwamy WSZYSTKIE pending triggery — i tak jeden nowy ogarnie cały Dropzone
    const existingTriggers = ScriptApp.getProjectTriggers();
    existingTriggers.forEach(trigger => {
      if (trigger.getHandlerFunction() === 'processDropzone') {
        ScriptApp.deleteTrigger(trigger);
      }
    });

    // [FIX v2.2] Jednorazowy trigger odpalający processDropzone za 10 sekund
    // .after() w milisekundach. Trigger wykonuje się raz i znika automatycznie po execution.
    ScriptApp.newTrigger('processDropzone')
      .timeBased()
      .after(10 * 1000)
      .create();

    return {
      success: true,
      message: "Plik w kolejce. Dane pojawią się w dashboardzie za ~30-60 sekund. Odśwież stronę."
    };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ==========================================
// W1 — THRESHOLD MANAGEMENT
// ==========================================

function getThresholds() {
  const keys = scriptProps.getProperties();
  const thresholds = {};
  for (const key in keys) {
    if (key.startsWith('threshold_')) {
      const userName = key.replace('threshold_', '');
      thresholds[userName] = parseInt(keys[key]) || 0;
    }
  }
  return JSON.stringify(thresholds);
}

function saveThreshold(userName, minutes) {
  try {
    const mins = parseInt(minutes);
    if (!userName || isNaN(mins) || mins < 0 || mins > 1440) {
      return { success: false, message: "Nieprawidłowa wartość. Podaj liczbę minut od 0 do 1440." };
    }
    scriptProps.setProperty('threshold_' + userName, mins.toString());
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ==========================================
// AUTO-REFRESH POLLING
// ==========================================

function getLastUpdateTime() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return 0;
    // Zwracamy liczbę wierszy + timestamp ostatniej modyfikacji arkusza
    // Frontend porównuje tę wartość — jeśli się zmieni, pobiera świeże dane
    const modTime = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getLastUpdated().getTime();
    return modTime + '_' + lastRow;
  } catch (e) {
    return 0;
  }
}

// ==========================================
// LINK DO SHEETS SSoT
// ==========================================

function getSheetsUrl() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet().getUrl();
  } catch (e) {
    return null;
  }
}

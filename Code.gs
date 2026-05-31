// ==========================================
// KITSUNE LINK OPS - BACKEND & DATA PIPELINE
// v2.1 — refactored | W6 — Upload Reminder
// ==========================================

const scriptProps = PropertiesService.getScriptProperties();

function forceAuthorize() {
  ScriptApp.getProjectTriggers();
  DriveApp.getRootFolder();
  SpreadsheetApp.getActiveSpreadsheet();
  MailApp.getRemainingDailyQuota(); // W6 — wymusza scope gmail.send przy autoryzacji
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
    if (!apiKey || !apiKey.startsWith('AIza') || apiKey.length < 35) {
      return { success: false, code: "INVALID_API_KEY" };
    }

    scriptProps.setProperty('GEMINI_API_KEY', apiKey);
    const rootFolder = DriveApp.createFolder('Kitsune_Link_Ops_System');
    const dropzone = rootFolder.createFolder('Dropzone');
    const archive = rootFolder.createFolder('Archiwum');

    scriptProps.setProperty('DROPZONE_FOLDER_ID', dropzone.getId());
    scriptProps.setProperty('ARCHIVE_FOLDER_ID', archive.getId());

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Dziecko", "Data", "Total_Min", "Apps_Payload"]);
      sheet.getRange("A1:D1").setFontWeight("bold");
    }

    // W6 — rejestruj daily trigger dla checkUploadReminder() przy nowym setupie
    _registerReminderTriggerIfMissing();

    return { success: true, message: "Ekosystem pomyślnie postawiony. / Ecosystem deployed successfully." };
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
  const fallbackChain = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

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

function upsertToSheet(dataArray) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const allValues = sheet.getDataRange().getValues();

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
      const rowIdx = indexMap[compositeKey];
      allValues[rowIdx][2] = day.total_min;
      allValues[rowIdx][3] = appsJson;
    } else {
      rowsToAppend.push([day.user, day.date, day.total_min, appsJson]);
    }
  });

  if (allValues.length > 1) {
    sheet.getRange(1, 1, allValues.length, 4).setValues(allValues);
  }
  if (rowsToAppend.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, 4).setValues(rowsToAppend);
  }
}

// [FIX v2.2] uploadFileFromFrontend() — async pattern z auto-triggerem.
// W6 — dodaje zapis LAST_UPLOAD_TIMESTAMP po pomyślnym zapisie pliku.
function uploadFileFromFrontend(dataURI, filename) {
  try {
    const validName = /^[A-Za-zÀ-žĄąĆćĘęŁłŃńÓóŚśŹźŻż]+[_ ].+\.pdf$/i.test(filename);
    if (!validName) {
      return { success: false, code: "INVALID_FILENAME" };
    }

    const dropzoneId = scriptProps.getProperty('DROPZONE_FOLDER_ID');
    if (!dropzoneId) {
      return { success: false, code: "NOT_CONFIGURED" };
    }

    const mimeType = dataURI.split(';')[0].replace('data:', '');
    const base64Data = dataURI.split(',')[1];
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename);
    DriveApp.getFolderById(dropzoneId).createFile(blob);

    // W6 — zapisz timestamp pomyślnego uploadu (epoch ms)
    scriptProps.setProperty('LAST_UPLOAD_TIMESTAMP', Date.now().toString());

    // Cleanup starych triggerów processDropzone (limit GAS: 20 per user)
    const existingTriggers = ScriptApp.getProjectTriggers();
    existingTriggers.forEach(trigger => {
      if (trigger.getHandlerFunction() === 'processDropzone') {
        ScriptApp.deleteTrigger(trigger);
      }
    });

    // Jednorazowy trigger odpalający processDropzone za 10 sekund
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
      return { success: false, code: "INVALID_MINUTES" };
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

// ==========================================
// W6.1 — UPLOAD REMINDER (email-based)
// ==========================================
// Odbiorca remindera jest konfigurowalny przez frontend (REMINDER_EMAIL).
// Świadoma decyzja architektoniczna: odbiorca ≠ owner skryptu.
// Osoba przypominająca o uploadzie to często nie ta sama co właściciel infrastruktury.
// Zero zależności od Session.getEffectiveUser() → zero scope userinfo.email.
 
// getReminderSettings() — zwraca aktualny stan konfiguracji przypomnienia.
// Frontend wywołuje przy otwarciu ReminderModal ORAZ przy bootstrapie (stan ramki przycisku).
function getReminderSettings() {
  try {
    const days = parseInt(scriptProps.getProperty('REMINDER_DAYS')) || 3;
    const email = scriptProps.getProperty('REMINDER_EMAIL') || '';
    const lastUploadRaw = scriptProps.getProperty('LAST_UPLOAD_TIMESTAMP');
    const lastUpload = lastUploadRaw ? parseInt(lastUploadRaw) : null;
    return JSON.stringify({ days: days, email: email, lastUpload: lastUpload });
  } catch (e) {
    return JSON.stringify({ days: 3, email: '', lastUpload: null });
  }
}
 
// saveReminderSettings(days, email) — waliduje i zapisuje oba pola atomowo.
// days: 1-30 | email: prosty regex guard (frontend waliduje twardziej).
// Pusty email jest DOZWOLONY (user może chcieć tylko zmienić dni) — wtedy reminder pozostaje martwy.
function saveReminderSettings(days, email) {
  try {
    const d = parseInt(days);
    if (isNaN(d) || d < 1 || d > 30) {
      return { success: false, code: "INVALID_DAYS" };
    }
 
    // Email opcjonalny, ale jeśli podany — musi przejść podstawowy guard
    const mail = (email || '').trim();
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return { success: false, code: "INVALID_EMAIL" };
    }
 
    scriptProps.setProperty('REMINDER_DAYS', d.toString());
    scriptProps.setProperty('REMINDER_EMAIL', mail);
    return { success: true, hasEmail: mail.length > 0 };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
 
// checkUploadReminder() — wywoływany przez daily time-based trigger.
// Sprawdza czy minęło więcej niż REMINDER_DAYS dni od ostatniego uploadu.
// Jeśli tak ORAZ jest skonfigurowany REMINDER_EMAIL — wysyła email.
// Opcja A guard: jeden email na cykl braku danych.
//   LAST_REMINDER_SENT >= LAST_UPLOAD_TIMESTAMP → już wysłano w tym cyklu → skip.
//   Reset następuje automatycznie przy następnym uploadzie (LAST_UPLOAD_TIMESTAMP jest aktualizowany).
// Edge cases:
//   - LAST_UPLOAD_TIMESTAMP nie ustawiony (brak uploadów) → skip silently
//   - REMINDER_EMAIL pusty (nigdy nie ustawiony) → skip silently (frontend sygnalizuje ramką)
//   - REMINDER_DAYS nie ustawiony → default 3
//   - MailApp error → log, nie crashuj triggera
function checkUploadReminder() {
  try {
    const recipient = scriptProps.getProperty('REMINDER_EMAIL');
    if (!recipient) {
      Logger.log('W6.1 checkUploadReminder: brak REMINDER_EMAIL, skip.');
      return;
    }
 
    const lastUploadRaw = scriptProps.getProperty('LAST_UPLOAD_TIMESTAMP');
    if (!lastUploadRaw) {
      Logger.log('W6.1 checkUploadReminder: brak LAST_UPLOAD_TIMESTAMP, skip.');
      return;
    }
 
    const lastUpload = parseInt(lastUploadRaw);
    const days = parseInt(scriptProps.getProperty('REMINDER_DAYS')) || 3;
    const thresholdMs = days * 24 * 60 * 60 * 1000;
    const elapsed = Date.now() - lastUpload;
 
    if (elapsed <= thresholdMs) {
      Logger.log(`W6.1 checkUploadReminder: ${Math.floor(elapsed/86400000)}d od ostatniego uploadu — próg ${days}d nie przekroczony.`);
      return;
    }

    // Opcja A guard: jeśli już wysłano reminder po ostatnim uploadzie — skip.
    const lastReminderRaw = scriptProps.getProperty('LAST_REMINDER_SENT');
    if (lastReminderRaw && parseInt(lastReminderRaw) >= lastUpload) {
      Logger.log('W6.1 checkUploadReminder: reminder już wysłano w tym cyklu, skip.');
      return;
    }
 
    const elapsedDays = Math.floor(elapsed / 86400000);
    const lastUploadDate = new Date(lastUpload).toLocaleDateString('pl-PL');
 
    const subject = `Kitsune FL — No new data for ${elapsedDays} days / Brak nowych danych od ${elapsedDays} dni`;
    const body =
      `Cześć,\n\nOd ${elapsedDays} dni (ostatni upload: ${lastUploadDate}) nie dodano nowych danych ekranowych do Kitsune Family Link Ops.\n\nCzas wgrać świeży raport z Family Link.\n\nAby wyłączyć lub zmienić częstotliwość przypomnień: otwórz dashboard → przycisk Remind.\n\n— Kitsune FL System\n\n` +
      `---\n\n` +
      `Hi,\n\nNo new screen time data has been added to Kitsune Family Link Ops for ${elapsedDays} days (last upload: ${lastUploadDate}).\n\nTime to upload a fresh Family Link report.\n\nTo disable or change reminder frequency: open the dashboard → Remind button.\n\n— Kitsune FL System`;
 
    MailApp.sendEmail(recipient, subject, body);
    // Opcja A: zapisz timestamp wysłanego emaila — blokuje kolejne do następnego uploadu
    scriptProps.setProperty('LAST_REMINDER_SENT', Date.now().toString());
    Logger.log(`W6.1 checkUploadReminder: email wysłany do ${recipient} (${elapsedDays}d od ostatniego uploadu). LAST_REMINDER_SENT ustawiony.`);
 
  } catch (e) {
    Logger.log('W6.1 checkUploadReminder ERROR: ' + e.message);
    // Celowo nie rzucamy — nie crashujemy triggera przy błędzie maila
  }
}
 
// registerReminderTrigger() — jednorazowa funkcja do uruchomienia RĘCZNIE z GAS Editor
// dla istniejących instalacji. Idempotentna — bezpieczne wielokrotne uruchomienie.
function registerReminderTrigger() {
  _registerReminderTriggerIfMissing();
  Logger.log('W6.1 registerReminderTrigger: zakończone.');
}
 
// _registerReminderTriggerIfMissing() — helper prywatny. Tworzy daily trigger jeśli brak.
function _registerReminderTriggerIfMissing() {
  const existing = ScriptApp.getProjectTriggers();
  const alreadyExists = existing.some(t => t.getHandlerFunction() === 'checkUploadReminder');
  if (!alreadyExists) {
    ScriptApp.newTrigger('checkUploadReminder')
      .timeBased()
      .everyDays(1)
      .atHour(9)
      .create();
    Logger.log('W6.1 _registerReminderTriggerIfMissing: trigger checkUploadReminder zarejestrowany.');
  } else {
    Logger.log('W6.1 _registerReminderTriggerIfMissing: trigger już istnieje, skip.');
  }
}

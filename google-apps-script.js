// Google Apps Script — paste this into the Apps Script editor
// Then deploy as web app: Deploy > New deployment > Web app > Execute as "Me" > Access "Anyone"

function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);

  sheet.appendRow([
    data.date,
    data.soundName,
    data.artist,
    data.platform,
    data.tiktokLink,
    data.status || ''
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", message: "Outreach logger is running" }))
    .setMimeType(ContentService.MimeType.JSON);
}

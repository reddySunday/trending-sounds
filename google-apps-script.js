// Google Apps Script — paste this into the Apps Script editor
// Then deploy as web app: Deploy > New deployment > Web app > Execute as "Me" > Access "Anyone"
// Headers: A=Date, B=Sound Name, C=Artist, D=Platform, E=TikTok Link, F=Status

function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);

  // Status update: find the most recent row for this artist+sound and update column F
  if (data.action === "statusUpdate") {
    var lastRow = sheet.getLastRow();
    // Search from bottom up to find the most recent matching row
    for (var i = lastRow; i >= 2; i--) {
      var rowSound = sheet.getRange(i, 2).getValue();
      var rowArtist = sheet.getRange(i, 3).getValue();
      if (rowSound === data.soundName && rowArtist === data.artist) {
        sheet.getRange(i, 6).setValue(data.status);
        return ContentService
          .createTextOutput(JSON.stringify({ status: "ok", action: "updated", row: i }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    // No existing row found — nothing to update
    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok", action: "no_match" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Delete from log: remove all rows matching this artist+sound
  if (data.action === "deleteFromLog") {
    var lastRow = sheet.getLastRow();
    var deleted = 0;
    // Delete from bottom up so row indices don't shift
    for (var i = lastRow; i >= 2; i--) {
      var rowSound = sheet.getRange(i, 2).getValue();
      var rowArtist = sheet.getRange(i, 3).getValue();
      if (rowSound === data.soundName && rowArtist === data.artist) {
        sheet.deleteRow(i);
        deleted++;
      }
    }
    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok", action: "deleted", count: deleted }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Normal outreach log: append a new row
  sheet.appendRow([
    data.date,
    data.soundName,
    data.artist,
    data.platform,
    data.tiktokLink,
    data.status || ''
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", action: "appended" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", message: "Outreach logger is running" }))
    .setMimeType(ContentService.MimeType.JSON);
}

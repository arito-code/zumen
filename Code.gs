/*******************************************************
 * PDF 囲い込み → 面積(㎡)計算 → スプシ保存（WebアプリAPI版）
 *******************************************************/

/**
 * 設定値を取得（プロパティサービス優先、なければデフォルト値）
 */
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    SPREADSHEET_ID: props.getProperty('SPREADSHEET_ID') || "1dygMoihb3Xe2ps_2fMauZ2RjdlIl1DLOoQ671fzxm2Y",
    SHEET_NAME: props.getProperty('SHEET_NAME') || "面積計算ログ",
    DRIVE_FOLDER_ID: props.getProperty('DRIVE_FOLDER_ID') || "1l_NBxyuxFQVwSaAI5ZTR_Ad8Esn5HUhI",
    API_KEY: props.getProperty('API_KEY') || "", // セキュリティ対策（オプション）
  };
}

/**
 * CORS対応とエラーハンドリングの統一
 */
function sendResponse(data, statusCode = 200) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * APIキー検証（オプション）
 */
function validateApiKey(request) {
  const CONFIG = getConfig();
  if (!CONFIG.API_KEY) return true; // APIキー未設定の場合はスキップ
  
  const apiKey = request.parameter.apiKey || 
    (request.postData ? JSON.parse(request.postData.contents).apiKey : null);
  
  return apiKey === CONFIG.API_KEY;
}

/**
 * リクエストサイズチェック
 */
function validateRequestSize(postData) {
  const MAX_SIZE = 40 * 1024 * 1024; // 40MB（GAS制限の余裕を持たせる）
  if (postData && postData.contents && postData.contents.length > MAX_SIZE) {
    throw new Error(`リクエストサイズが大きすぎます（最大${MAX_SIZE / 1024 / 1024}MB）`);
  }
}

/**
 * Web API エンドポイント（POST）
 */
function doPost(e) {
  try {
    // リクエストサイズチェック
    validateRequestSize(e.postData);
    
    // APIキー検証（設定されている場合）
    if (!validateApiKey(e)) {
      return sendResponse({
        success: false,
        error: "Invalid API key"
      }, 401);
    }
    
    if (!e.postData || !e.postData.contents) {
      return sendResponse({
        success: false,
        error: "Invalid request: no data"
      }, 400);
    }
    
    const requestData = JSON.parse(e.postData.contents);
    const action = requestData.action;
    
    if (action === 'uploadPdf') {
      const result = uploadPdf(
        requestData.dataUrl,
        requestData.filename,
        requestData.mimeType
      );
      return sendResponse({
        success: true,
        data: result
      });
    }
    
    if (action === 'saveResult') {
      const result = saveResult(requestData.payload);
      return sendResponse({
        success: true,
        data: result
      });
    }
    
    return sendResponse({
      success: false,
      error: "Unknown action"
    }, 400);
    
  } catch (error) {
    console.error("API Error:", error);
    return sendResponse({
      success: false,
      error: error.message || String(error)
    }, 500);
  }
}

function uploadPdf(dataUrl, filename, mimeType) {
  if (!dataUrl || !filename) {
    throw new Error("PDFデータが空です。dataUrlとfilenameが必要です。");
  }

  const CONFIG = getConfig();
  if (!CONFIG.DRIVE_FOLDER_ID) {
    throw new Error("DriveフォルダIDが設定されていません。スクリプトプロパティにDRIVE_FOLDER_IDを設定してください。");
  }

  let folder;
  try {
    folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  } catch (e) {
    const errorMsg = e.message || String(e);
    if (errorMsg.includes("Invalid argument") || errorMsg.includes("not found")) {
      throw new Error(`Driveフォルダが見つかりません（ID: ${CONFIG.DRIVE_FOLDER_ID}）。フォルダIDが正しいか確認してください。`);
    } else if (errorMsg.includes("permission") || errorMsg.includes("access")) {
      throw new Error(`Driveフォルダにアクセス権限がありません（ID: ${CONFIG.DRIVE_FOLDER_ID}）。スクリプトに適切な権限を付与してください。`);
    }
    throw new Error(`Driveフォルダにアクセスできません（ID: ${CONFIG.DRIVE_FOLDER_ID}）。エラー: ${errorMsg}`);
  }

  let base64;
  try {
    const parts = dataUrl.split(",");
    if (parts.length < 2) {
      throw new Error("dataURLの形式が正しくありません（カンマが含まれていません）");
    }
    base64 = parts[1];
  } catch (e) {
    throw new Error(`PDFデータの解析に失敗しました: ${e.message || String(e)}`);
  }

  let bytes;
  let blob;
  try {
    bytes = Utilities.base64Decode(base64);
    blob = Utilities.newBlob(bytes, mimeType || "application/pdf", filename);
  } catch (e) {
    throw new Error(`PDFデータのデコードに失敗しました: ${e.message || String(e)}`);
  }

  let file;
  try {
    file = folder.createFile(blob);
  } catch (e) {
    const errorMsg = e.message || String(e);
    if (errorMsg.includes("permission") || errorMsg.includes("access")) {
      throw new Error(`Driveフォルダにファイルを作成する権限がありません（フォルダID: ${CONFIG.DRIVE_FOLDER_ID}）。スクリプトに適切な権限を付与してください。`);
    }
    throw new Error(`Driveにファイルを保存できませんでした: ${errorMsg}`);
  }

  try {
    // リンクを知っている人は閲覧可
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // 共有設定の失敗は致命的ではないので、ログに記録するだけ
    console.error("ファイルの共有設定に失敗しました:", e.message || String(e));
  }

  const fileId = file.getId();
  const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;

  return {
    fileId,
    name: file.getName(),
    url: viewUrl,
  };
}

function saveResult(payload) {
  if (!payload) {
    throw new Error("保存データが空です。payloadが必要です。");
  }

  const CONFIG = getConfig();
  if (!CONFIG.SPREADSHEET_ID) {
    throw new Error("スプレッドシートIDが設定されていません。スクリプトプロパティにSPREADSHEET_IDを設定してください。");
  }
  if (!CONFIG.SHEET_NAME) {
    throw new Error("シート名が設定されていません。スクリプトプロパティにSHEET_NAMEを設定してください。");
  }

  let ss;
  try {
    ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  } catch (e) {
    const errorMsg = e.message || String(e);
    if (errorMsg.includes("Invalid argument") || errorMsg.includes("not found")) {
      throw new Error(`スプレッドシートが見つかりません（ID: ${CONFIG.SPREADSHEET_ID}）。スプレッドシートIDが正しいか確認してください。`);
    } else if (errorMsg.includes("permission") || errorMsg.includes("access")) {
      throw new Error(`スプレッドシートにアクセス権限がありません（ID: ${CONFIG.SPREADSHEET_ID}）。スクリプトに適切な権限を付与してください。`);
    }
    throw new Error(`スプレッドシートにアクセスできません（ID: ${CONFIG.SPREADSHEET_ID}）。エラー: ${errorMsg}`);
  }

  let sheet;
  try {
    sheet = getOrCreateSheet_(ss, CONFIG.SHEET_NAME);
  } catch (e) {
    throw new Error(`シート「${CONFIG.SHEET_NAME}」の作成/取得に失敗しました: ${e.message || String(e)}`);
  }

  try {
    ensureHeader_(sheet);
  } catch (e) {
    throw new Error(`シートヘッダーの設定に失敗しました: ${e.message || String(e)}`);
  }

  const now = new Date();
  let row;
  try {
    row = [
      Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss"),
      payload.projectName || "",
      payload.pdfName || "",
      payload.pdfUrl || "",
      payload.page ?? "",
      payload.actualMm ?? "",
      payload.pixelDist ?? "",
      payload.mmPerPx ?? "",
      payload.areaM2 ?? "",
      payload.pointsJson || "",
    ];
  } catch (e) {
    throw new Error(`データ行の準備に失敗しました: ${e.message || String(e)}`);
  }

  try {
    sheet.appendRow(row);
  } catch (e) {
    const errorMsg = e.message || String(e);
    if (errorMsg.includes("permission") || errorMsg.includes("access")) {
      throw new Error(`スプレッドシートに書き込み権限がありません（ID: ${CONFIG.SPREADSHEET_ID}）。スクリプトに適切な権限を付与してください。`);
    }
    throw new Error(`スプレッドシートへの保存に失敗しました: ${errorMsg}`);
  }

  return { ok: true };
}

function getOrCreateSheet_(ss, name) {
  if (!name || name.trim() === "") {
    throw new Error("シート名が空です。有効なシート名を指定してください。");
  }
  
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    try {
      sheet = ss.insertSheet(name);
    } catch (e) {
      const errorMsg = e.message || String(e);
      if (errorMsg.includes("already exists") || errorMsg.includes("重複")) {
        // 同名シートが既に存在する場合（まれだが、タイミングによって発生する可能性）
        sheet = ss.getSheetByName(name);
        if (!sheet) {
          throw new Error(`シート「${name}」の作成に失敗しました。同名のシートが既に存在する可能性があります。エラー: ${errorMsg}`);
        }
      } else {
        throw new Error(`シート「${name}」の作成に失敗しました: ${errorMsg}`);
      }
    }
  }
  return sheet;
}

function ensureHeader_(sheet) {
  const header = [
    "timestamp",
    "projectName",
    "pdfName",
    "pdfUrl",
    "page",
    "scale_actualMm",
    "scale_pixelDist",
    "mmPerPx",
    "area_m2",
    "polygon_points_json",
  ];

  if (sheet.getLastRow() === 0) {
    try {
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
      sheet.setFrozenRows(1);
    } catch (e) {
      const errorMsg = e.message || String(e);
      if (errorMsg.includes("permission") || errorMsg.includes("access")) {
        throw new Error("シートにヘッダーを書き込む権限がありません。スクリプトに適切な権限を付与してください。");
      }
      throw new Error(`シートヘッダーの書き込みに失敗しました: ${errorMsg}`);
    }
  }
}

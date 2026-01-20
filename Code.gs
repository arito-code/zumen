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
    ESTIMATE_SHEET_NAME: props.getProperty('ESTIMATE_SHEET_NAME') || "見積ログ",
    ESTIMATE_ITEMS_SHEET_NAME: props.getProperty('ESTIMATE_ITEMS_SHEET_NAME') || "見積明細",
    DRIVE_FOLDER_ID: props.getProperty('DRIVE_FOLDER_ID') || "1l_NBxyuxFQVwSaAI5ZTR_Ad8Esn5HUhI",
    API_KEY: props.getProperty('API_KEY') || "", // セキュリティ対策（オプション）
    ADMIN_EMAIL: props.getProperty('ADMIN_EMAIL') || "info@g-knowthyself.com", // 見積控え送付先（任意）
  };
}

/**
 * 疎通確認（ブラウザで /exec を開いた時に doGet が無いとエラーになるため）
 */
function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, message: "GAS alive" }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Gmail権限（送信系スコープ）を承認するための補助関数。
 * Apps Scriptエディタ上で一度だけ実行し、権限承認を完了させてください。
 * ※ Webアプリが「実行するユーザー: 自分」の場合、オーナーの承認が必要です。
 */
function authorizeGmail() {
  // GmailApp を参照することで、必要なスコープの承認フローを発生させる
  const aliases = GmailApp.getAliases();
  const effective = (Session.getEffectiveUser && Session.getEffectiveUser().getEmail) ? (Session.getEffectiveUser().getEmail() || "") : "";
  return {
    ok: true,
    effectiveUser: effective,
    aliasesCount: Array.isArray(aliases) ? aliases.length : 0,
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

    if (action === 'saveEstimate') {
      const result = saveEstimate(requestData.payload);
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

function saveEstimate(payload) {
  if (!payload) {
    throw new Error("保存データが空です。payloadが必要です。");
  }

  const CONFIG = getConfig();
  if (!CONFIG.SPREADSHEET_ID) {
    throw new Error("スプレッドシートIDが設定されていません。スクリプトプロパティにSPREADSHEET_IDを設定してください。");
  }

  const customerEmail = (payload.customerEmail || "").trim();
  const sendEmail = !!payload.sendEmail;
  if (sendEmail && !customerEmail) {
    throw new Error("見積送付先メールが空です。");
  }

  let ss;
  try {
    ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  } catch (e) {
    const errorMsg = e.message || String(e);
    throw new Error(`スプレッドシートにアクセスできません（ID: ${CONFIG.SPREADSHEET_ID}）。エラー: ${errorMsg}`);
  }

  let sheet;
  try {
    sheet = getOrCreateSheet_(ss, CONFIG.ESTIMATE_SHEET_NAME);
  } catch (e) {
    throw new Error(`シート「${CONFIG.ESTIMATE_SHEET_NAME}」の作成/取得に失敗しました: ${e.message || String(e)}`);
  }

  try {
    ensureHeaderEstimate_(sheet);
  } catch (e) {
    throw new Error(`シートヘッダー（見積）の設定に失敗しました: ${e.message || String(e)}`);
  }

  // 明細シート（行=1アイテム）
  let itemsSheet;
  try {
    itemsSheet = getOrCreateSheet_(ss, CONFIG.ESTIMATE_ITEMS_SHEET_NAME);
    ensureHeaderEstimateItems_(itemsSheet);
  } catch (e) {
    throw new Error(`明細シート「${CONFIG.ESTIMATE_ITEMS_SHEET_NAME}」の作成/取得に失敗しました: ${e.message || String(e)}`);
  }

  const now = new Date();
  const ts = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");

  const estimateId = (payload.clientEstimateId || "").trim() || Utilities.getUuid();
  const floors = Array.isArray(payload.floorItems) ? payload.floorItems : [];
  const walls = Array.isArray(payload.wallItems) ? payload.wallItems : [];

  // スクショ（dataUrl）→ Drive保存（PRIVATE + viewer限定）→ URL
  let screenshotUrl = "";
  const screenshotDataUrl = payload.screenshotDataUrl || "";
  if (screenshotDataUrl) {
    const fileMeta = saveScreenshotToDrive_(screenshotDataUrl, {
      folderId: CONFIG.DRIVE_FOLDER_ID,
      estimateId,
      ts,
      customerEmail,
      adminEmail: (CONFIG.ADMIN_EMAIL || "").trim(),
    });
    screenshotUrl = fileMeta.url || "";
  }

  // ヘッダ側には合計数量だけ残す（詳細は明細シートへ）
  let qtySupport = 0, qtyPlywood = 0, qtyVeneer12 = 0;
  for (const f of floors) {
    const q = f && f.qty ? f.qty : null;
    if (q) {
      qtySupport += Number(q.supportFoot || 0) || 0;
      qtyPlywood += Number(q.plywood || 0) || 0;
      qtyVeneer12 += Number(q.veneer12 || 0) || 0;
    }
  }
  const unitPricesJson = ""; // 箇所別単価は明細側に保存（ヘッダ側は空でOK）

  const row = [
    ts,
    payload.projectName || "",
    customerEmail,
    payload.pdfName || "",
    payload.pdfUrl || "",
    payload.page ?? "",
    payload.areaM2 ?? "",
    payload.wallM ?? "",
    qtySupport || "",
    qtyPlywood || "",
    qtyVeneer12 || "",
    unitPricesJson,
    payload.total ?? "",
    buildEstimateTextWithScreenshotUrl_(payload.estimateText || "", screenshotUrl),
    sendEmail ? "1" : "0",
    "", // emailResult
    estimateId,
    String(floors.length),
    String(walls.length),
    screenshotUrl,
  ];

  try {
    sheet.appendRow(row);
  } catch (e) {
    throw new Error(`スプレッドシートへの保存に失敗しました: ${e.message || String(e)}`);
  }

  // 明細行を保存（最大: 床20 + 壁20）
  try {
    const detailRows = [];
    for (const f of floors) {
      const idx = f && f.index != null ? f.index : "";
      const a = f && f.areaM2 != null ? f.areaM2 : "";
      const u = f && f.unitPrices ? f.unitPrices : null;
      const q = f && f.qty ? f.qty : null;
      detailRows.push([
        ts,
        estimateId,
        "floor",
        idx,
        a,
        u ? JSON.stringify(u) : "",
        q ? JSON.stringify(q) : "",
        f && f.laborYen != null ? f.laborYen : "",
        f && f.materialYen != null ? f.materialYen : "",
        f && f.subtotalYen != null ? f.subtotalYen : "",
        f && f.pts ? JSON.stringify(f.pts) : "",
      ]);
    }
    for (const w of walls) {
      const idx = w && w.index != null ? w.index : "";
      const m = w && w.wallM != null ? w.wallM : "";
      const u = w && w.unitPrices ? w.unitPrices : null;
      detailRows.push([
        ts,
        estimateId,
        "wall",
        idx,
        m,
        u ? JSON.stringify(u) : "",
        "", // qty_json (wall has none)
        w && w.laborYen != null ? w.laborYen : "",
        "", // material_yen (wall has none)
        w && w.subtotalYen != null ? w.subtotalYen : "",
        w && w.pts ? JSON.stringify(w.pts) : "",
      ]);
    }
    if (detailRows.length) {
      const start = itemsSheet.getLastRow() + 1;
      itemsSheet.getRange(start, 1, detailRows.length, detailRows[0].length).setValues(detailRows);
    }
  } catch (e) {
    throw new Error(`明細シートへの保存に失敗しました: ${e.message || String(e)}`);
  }

  let emailResult = "skipped";
  let emailSendFailed = false;
  if (sendEmail) {
    const subject = `【見積】${payload.projectName ? payload.projectName : "乾式二重床"}（自動作成）`;
    const body = buildEstimateTextWithScreenshotUrl_(payload.estimateText || "", screenshotUrl) || "見積内容が空です。";
    const bcc = (CONFIG.ADMIN_EMAIL || "").trim();
    try {
      const options = {};
      if (bcc) options.bcc = bcc;
      GmailApp.sendEmail(customerEmail, subject, body, options);
      emailResult = bcc ? "sent_with_bcc" : "sent_no_admin_email";
    } catch (e) {
      emailResult = "send_failed: " + (e.message || String(e));
      emailSendFailed = true;
      console.error("メール送信に失敗:", e);
    }
  }

  // 最終行の emailResult を更新（簡易）
  try {
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 16).setValue(emailResult);
  } catch (e) {
    console.error("emailResultの更新に失敗:", e);
  }

  // 送信に失敗した場合は「成功」として返さない（フロント側に失敗を伝える）
  if (sendEmail && emailSendFailed) {
    throw new Error(emailResult);
  }

  return { ok: true, emailResult, screenshotUrl };
}

function buildEstimateTextWithScreenshotUrl_(estimateText, screenshotUrl) {
  const base = (estimateText || "").trim();
  if (!screenshotUrl) return base;
  // already included?
  if (base.includes(screenshotUrl)) return base;
  const lines = [];
  if (base) lines.push(base);
  lines.push("");
  lines.push(`スクショ：${screenshotUrl}`);
  return lines.join("\n");
}

function saveScreenshotToDrive_(dataUrl, opts) {
  const folderId = opts && opts.folderId ? String(opts.folderId) : "";
  if (!folderId) throw new Error("DriveフォルダIDが設定されていません（スクショ保存用）。");

  const customerEmail = (opts && opts.customerEmail ? String(opts.customerEmail) : "").trim();
  const adminEmail = (opts && opts.adminEmail ? String(opts.adminEmail) : "").trim();
  const estimateId = (opts && opts.estimateId ? String(opts.estimateId) : "").trim() || Utilities.getUuid();
  const ts = (opts && opts.ts ? String(opts.ts) : "").trim() || Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");

  let folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    throw new Error(`Driveフォルダにアクセスできません（ID: ${folderId}）。エラー: ${e.message || String(e)}`);
  }

  // Parse dataURL (data:image/jpeg;base64,...)
  let base64 = "";
  let mimeType = "image/jpeg";
  try {
    const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error("dataURL形式が不正です");
    mimeType = m[1] || "image/jpeg";
    base64 = m[2] || "";
  } catch (e) {
    throw new Error(`スクショdataURLの解析に失敗しました: ${e.message || String(e)}`);
  }

  let blob;
  try {
    const bytes = Utilities.base64Decode(base64);
    const safeTs = ts.replace(/[:\\s]/g, "-");
    const name = `SS_${estimateId}_${safeTs}.jpg`;
    blob = Utilities.newBlob(bytes, mimeType, name);
  } catch (e) {
    throw new Error(`スクショのデコードに失敗しました: ${e.message || String(e)}`);
  }

  let file;
  try {
    file = folder.createFile(blob);
  } catch (e) {
    throw new Error(`スクショをDriveに保存できませんでした: ${e.message || String(e)}`);
  }

  // Sharing: anyone with link can view (Googleアカウント無しでも閲覧できる運用)
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // continue, but warn in logs
    console.error("スクショの共有設定（ANYONE_WITH_LINK）に失敗:", e.message || String(e));
  }

  // 共有リンク閲覧可のため必須ではないが、管理者がDrive上で探しやすいように一応付与（失敗しても致命ではない）
  try { if (adminEmail) file.addViewer(adminEmail); } catch (e) { console.error("管理者viewer付与に失敗:", e.message || String(e)); }
  try { if (customerEmail) file.addViewer(customerEmail); } catch (e) { console.error("送付先viewer付与に失敗:", e.message || String(e)); }

  const fileId = file.getId();
  const url = `https://drive.google.com/file/d/${fileId}/view`;
  return { fileId, url };
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

function ensureHeaderEstimate_(sheet) {
  const header = [
    "timestamp",
    "projectName",
    "customerEmail",
    "pdfName",
    "pdfUrl",
    "page",
    "area_m2",
    "wall_m",
    "qty_supportFoot",
    "qty_plywood",
    "qty_veneer12",
    "unitPrices_json",
    "total_yen",
    "estimateText",
    "sendEmail",
    "emailResult",
    "clientEstimateId",
    "floorCount",
    "wallCount",
    "screenshotUrl",
  ];

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
    return;
  }

  // 既存ヘッダーが短い場合のみ末尾に追記（壊さない）
  try {
    const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const lastVal = existing[existing.length - 1];
    if (existing.length < header.length && lastVal !== "screenshotUrl") {
      sheet.getRange(1, existing.length + 1, 1, header.length - existing.length).setValues([header.slice(existing.length)]);
    }
  } catch (e) {
    console.error("見積ヘッダー更新（追記）に失敗:", e.message || String(e));
  }
}

function ensureHeaderEstimateItems_(sheet) {
  const header = [
    "timestamp",
    "estimateId",
    "type",
    "index",
    "measureValue",
    "unitPrices_json",
    "qty_json",
    "labor_yen",
    "material_yen",
    "subtotal_yen",
    "pts_json",
  ];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  }
}

<?php
// gas_proxy.php
// nikosauna.com -> (this proxy) -> script.google.com への中継でCORSを回避します。

$GAS_URL = 'https://script.google.com/macros/s/AKfycbwQnpqVv-H4s4bG1-S3MvV8RGmm3HMsdYvshuE-r5qkX1P0oYNETevc-phmHCym-C8/exec';

// ===== Security / Hardening =====
// - 同一サイト利用前提のため、Origin/Referer を簡易チェックします
// - さらに強化したい場合は、サーバ環境変数 GAS_PROXY_KEY を設定し、X-Proxy-Key を必須化できます

$ALLOWED_ORIGINS = [
  'https://nikosauna.com',
  'https://www.nikosauna.com',
];

$requiredKey = getenv('GAS_PROXY_KEY'); // 未設定ならキー検証はスキップ

// セキュリティヘッダ（API用途。キャッシュさせない）
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');

function setCorsHeadersIfAllowed($origin, $allowedOrigins) {
  if ($origin === '') return;
  if (!in_array($origin, $allowedOrigins, true)) return;
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Vary: Origin');
  header('Access-Control-Allow-Methods: POST, OPTIONS, GET');
  header('Access-Control-Allow-Headers: Content-Type, X-Proxy-Key');
}

// 疎通確認（ブラウザで開いたときに JSON を返す）
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
  setCorsHeadersIfAllowed($origin, $ALLOWED_ORIGINS);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['success' => true, 'message' => 'gas_proxy alive'], JSON_UNESCAPED_UNICODE);
  exit;
}

// 将来のため（同一オリジンでは不要だが、クライアント実装が変わっても壊れにくくする）
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
  setCorsHeadersIfAllowed($origin, $ALLOWED_ORIGINS);
  http_response_code(204);
  exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  http_response_code(405);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['success' => false, 'error' => 'Method not allowed'], JSON_UNESCAPED_UNICODE);
  exit;
}

// Origin/Referer チェック（簡易）
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$referer = $_SERVER['HTTP_REFERER'] ?? '';
if ($origin !== '') {
  if (!in_array($origin, $ALLOWED_ORIGINS, true)) {
    http_response_code(403);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'Forbidden'], JSON_UNESCAPED_UNICODE);
    exit;
  }
} else if ($referer !== '') {
  $ok = false;
  foreach ($ALLOWED_ORIGINS as $allowed) {
    if (strpos($referer, $allowed) === 0) { $ok = true; break; }
  }
  if (!$ok) {
    http_response_code(403);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'Forbidden'], JSON_UNESCAPED_UNICODE);
    exit;
  }
}

// 許可OriginならCORSヘッダ付与（同一オリジン利用でも無害）
setCorsHeadersIfAllowed($origin, $ALLOWED_ORIGINS);

// 共有キー（任意）
if ($requiredKey !== false && $requiredKey !== '') {
  $clientKey = $_SERVER['HTTP_X_PROXY_KEY'] ?? '';
  if (!hash_equals($requiredKey, $clientKey)) {
    http_response_code(401);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
    exit;
  }
}

// サイズ制限（PDF base64 が来るので大きめに）
$MAX_BODY_BYTES = 25 * 1024 * 1024; // 25MB
$contentLen = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
if ($contentLen > $MAX_BODY_BYTES) {
  http_response_code(413);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['success'=>false,'error'=>'Payload too large'], JSON_UNESCAPED_UNICODE);
  exit;
}

$body = file_get_contents('php://input');
if ($body === false || $body === '') {
  http_response_code(400);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['success'=>false,'error'=>'Empty body'], JSON_UNESCAPED_UNICODE);
  exit;
}
if (strlen($body) > $MAX_BODY_BYTES) {
  http_response_code(413);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['success'=>false,'error'=>'Payload too large'], JSON_UNESCAPED_UNICODE);
  exit;
}

$ch = curl_init($GAS_URL);
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => [
    'Content-Type: text/plain; charset=utf-8',
  ],
  CURLOPT_POSTFIELDS => $body,
  // GASは script.google.com -> script.googleusercontent.com に 302 することがあるため追従する
  // （https のみに限定し、回数も制限する）
  CURLOPT_FOLLOWLOCATION => true,
  CURLOPT_MAXREDIRS => 3,
  CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
  CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
  CURLOPT_CONNECTTIMEOUT => 10,
  CURLOPT_TIMEOUT => 30,
]);

$resBody = curl_exec($ch);
if ($resBody === false) {
  http_response_code(502);
  header('Content-Type: application/json; charset=utf-8');
  // クライアントへ詳細を出しすぎない（詳細はサーバ側ログへ）
  error_log('gas_proxy curl error: ' . curl_error($ch));
  echo json_encode(['success'=>false,'error'=>'Upstream request failed'], JSON_UNESCAPED_UNICODE);
  curl_close($ch);
  exit;
}
$http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
curl_close($ch);

http_response_code($http ?: 200);
if ($contentType) {
  header('Content-Type: ' . $contentType);
} else {
  header('Content-Type: application/json; charset=utf-8');
}
echo $resBody;
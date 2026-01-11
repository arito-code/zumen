<?php
// gas_proxy.php
// nikosauna.com -> (this proxy) -> script.google.com への中継でCORSを回避します。

$GAS_URL = 'https://script.google.com/macros/s/AKfycbwZnPiugNcEaUZqVWkVlqJWmdfrt-cwao8HtPIYpYL30Mx71EpR0QBbN1M_UmL8CCM/exec';

header('Content-Type: application/json; charset=utf-8');

// 疎通確認（ブラウザで開いたときに JSON を返す）
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  echo json_encode(['success' => true, 'message' => 'gas_proxy alive'], JSON_UNESCAPED_UNICODE);
  exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  http_response_code(405);
  echo json_encode(['success' => false, 'error' => 'Method not allowed'], JSON_UNESCAPED_UNICODE);
  exit;
}

$body = file_get_contents('php://input');
if ($body === false || $body === '') {
  http_response_code(400);
  echo json_encode(['success'=>false,'error'=>'Empty body'], JSON_UNESCAPED_UNICODE);
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
  // 予期しないHTMLリダイレクト（ログイン等）を避ける
  CURLOPT_FOLLOWLOCATION => false,
  CURLOPT_TIMEOUT => 30,
]);

$resBody = curl_exec($ch);
if ($resBody === false) {
  http_response_code(502);
  echo json_encode(['success'=>false,'error'=>'Proxy curl error: '.curl_error($ch)], JSON_UNESCAPED_UNICODE);
  curl_close($ch);
  exit;
}
$http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

http_response_code($http ?: 200);
echo $resBody;
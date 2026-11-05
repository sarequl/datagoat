# Proxy DataGoat with plain PHP

Two small files with cURL, for any PHP host (shared hosting included). Read the
[proxy rules](proxy.md) first.

`datagoat-proxy.php`:

```php
<?php
// Proxies /js/script.js and /api/events to your DataGoat collector.
const DATAGOAT_HOST = 'https://datagoat.yourname.workers.dev';

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'];
if ($path === '/js/script.js' && $method === 'GET') {
    $upstream = DATAGOAT_HOST . '/js/script.js';
} elseif ($path === '/api/events' && $method === 'POST') {
    $upstream = DATAGOAT_HOST . '/api/events';
} else {
    http_response_code(404);
    exit;
}

// The visitor's address. REMOTE_ADDR is the safe default; only use a forwarded header when your
// host's proxy sets it and strips client-supplied copies.
$ip = $_SERVER['REMOTE_ADDR'] ?? '';
$prior = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
$headers = [
    'User-Agent: ' . ($_SERVER['HTTP_USER_AGENT'] ?? ''),
    'X-Real-IP: ' . $ip,
    'X-Forwarded-For: ' . ($prior !== '' ? $prior . ', ' . $ip : $ip),
];
if (!empty($_SERVER['HTTP_SEC_GPC'])) {
    $headers[] = 'Sec-GPC: ' . $_SERVER['HTTP_SEC_GPC'];
}

$ch = curl_init($upstream);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 5,
    CURLOPT_HEADER => false,
]);
if ($method === 'POST') {
    $headers[] = 'Content-Type: ' . ($_SERVER['CONTENT_TYPE'] ?? 'text/plain');
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents('php://input', false, null, 0, 16384));
}
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE) ?: 502;
$type = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'application/json';
curl_close($ch);

http_response_code($status);
header('Content-Type: ' . $type);
header($method === 'GET' ? 'Cache-Control: public, max-age=3600' : 'Cache-Control: no-store');
echo $body === false ? '' : $body;
```

Route the two paths to it. Apache (`.htaccess`):

```apache
RewriteEngine On
RewriteRule ^js/script\.js$ /datagoat-proxy.php [L]
RewriteRule ^api/events$ /datagoat-proxy.php [L]
```

Nginx + PHP-FPM:

```nginx
location = /js/script.js { rewrite ^ /datagoat-proxy.php last; }
location = /api/events   { rewrite ^ /datagoat-proxy.php last; }
```

cURL sets `Host` and SNI from the URL. Script tag:

```html
<script defer data-website-id="dgid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```

# Proxy DataGoat with Laravel

A small controller forwards the two paths with Laravel's HTTP client. Read the
[proxy rules](proxy.md) first.

`config/services.php`:

```php
'datagoat' => [
    'host' => env('DATAGOAT_HOST', 'https://datagoat.yourname.workers.dev'),
],
```

`app/Http/Controllers/DataGoatProxyController.php`:

```php
<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

class DataGoatProxyController extends Controller
{
    private function headers(Request $request): array
    {
        $prior = $request->header('X-Forwarded-For');
        $peer = $request->server('REMOTE_ADDR');

        return array_filter([
            'User-Agent' => $request->userAgent() ?? '',
            'X-Real-IP' => $request->ip(),
            'X-Forwarded-For' => $prior ? "{$prior}, {$peer}" : $request->ip(),
            'Sec-GPC' => $request->header('Sec-GPC'),
        ]);
    }

    public function script(Request $request)
    {
        $body = Cache::remember('datagoat-script', 3600, fn () => Http::withHeaders($this->headers($request))
            ->get(config('services.datagoat.host').'/js/script.js')
            ->throw()
            ->body());

        return response($body, 200, [
            'Content-Type' => 'application/javascript; charset=utf-8',
            'Cache-Control' => 'public, max-age=3600',
        ]);
    }

    public function events(Request $request)
    {
        $upstream = Http::withHeaders($this->headers($request))
            ->withBody($request->getContent(), $request->header('Content-Type', 'text/plain'))
            ->post(config('services.datagoat.host').'/api/events');

        return response($upstream->body(), $upstream->status(), [
            'Content-Type' => $upstream->header('Content-Type') ?: 'application/json',
            'Cache-Control' => 'no-store',
        ]);
    }
}
```

`routes/web.php`:

```php
use App\Http\Controllers\DataGoatProxyController;
use Illuminate\Foundation\Http\Middleware\VerifyCsrfToken;

Route::get('/js/script.js', [DataGoatProxyController::class, 'script']);
Route::post('/api/events', [DataGoatProxyController::class, 'events'])
    ->withoutMiddleware([VerifyCsrfToken::class]);
```

(On Laravel 11+, `ValidateCsrfToken` replaces `VerifyCsrfToken`; or register the route in
`routes/api.php`, which has no CSRF check, as `/api/events`.)

Behind a load balancer, configure trusted proxies (`bootstrap/app.php` →
`$middleware->trustProxies(at: '*')` on Laravel 11+, or `TrustProxies` middleware) so
`$request->ip()` is the visitor.

Script tag in your layout (see [laravel.md](laravel.md)):

```blade
<script defer data-website-id="dgid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```

# DataGoat with Laravel

Add the tag to your main layout (`resources/views/layouts/app.blade.php` or similar):

```blade
<head>
    @unless (auth()->check() && auth()->user()->is_admin)
        <script
            defer
            data-website-id="{{ config('services.datagoat.website_id') }}"
            data-domain="example.com"
            src="https://a.example.com/js/script.js"
        ></script>
    @endunless
</head>
```

`config/services.php`:

```php
'datagoat' => [
    'website_id' => env('DATAGOAT_WEBSITE_ID'),
    'host' => env('DATAGOAT_HOST', 'https://a.example.com'),
],
```

With Inertia (Vue/React), put the tag in `resources/views/app.blade.php`; client-side navigations
are tracked automatically.

## Identify signed-in users

```blade
@auth
<script>
  window.datagoat = window.datagoat || function () { (window.datagoat.q = window.datagoat.q || []).push(arguments); };
  window.datagoat("identify", @json(['user_id' => (string) auth()->id(), 'name' => auth()->user()->name]));
</script>
@endauth
```

## Revenue attribution (Laravel Cashier / Stripe Checkout)

```php
$metadata = array_filter([
    'datagoat_visitor_id' => $request->cookie('datagoat_visitor_id'),
    'datagoat_session_id' => $request->cookie('datagoat_session_id'),
]);

return $request->user()->checkout(['price_xxx' => 1], [
    'success_url' => route('thanks').'?session_id={CHECKOUT_SESSION_ID}',
    'cancel_url' => route('pricing'),
    'metadata' => $metadata,
]);
```

The tracker's cookies are set by JavaScript and are not encrypted, so exclude them from Laravel's
cookie encryption or `$request->cookie()` returns null: in `bootstrap/app.php` (Laravel 11+)
`$middleware->encryptCookies(except: ['datagoat_visitor_id', 'datagoat_session_id']);`, or add them
to `$except` in `App\Http\Middleware\EncryptCookies`.

First-party proxy: [proxy-laravel.md](proxy-laravel.md).

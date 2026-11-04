# DataGoat on WordPress

## Option 1: the DataGoat plugin (recommended)

The plugin is in this repository at [`packages/wordpress/datagoat`](../../packages/wordpress/datagoat).

1. Zip the `datagoat` folder (`cd packages/wordpress && zip -r datagoat.zip datagoat`), then in
   WordPress go to **Plugins > Add New > Upload Plugin**, upload it and activate it.
2. Open **Settings > DataGoat** and fill in:
   - **Website ID**: from the DataGoat dashboard, Settings > Tracking (`dfid_...`).
   - **Script URL**: your collector followed by `/js/script.js`, e.g.
     `https://a.example.com/js/script.js` ([where the collector lives](README.md#2-where-the-collector-lives)).
     A path such as `/js/script.js` works if you [proxy](proxy.md) DataGoat through your server or
     use a [Cloudflare route](cloudflare-route.md).
   - **Events URL** (optional): defaults to `/api/events` on the script's host.
   - **Domain** (optional): defaults to your site's domain without `www.`.
   - **Exclusions**: "Do not track logged-in administrators" is on by default; you can also skip
     every logged-in user.
3. Save. The plugin prints the tracker and the pre-load queue in `<head>` on every front-end page.

Developers can add attributes with the `datagoat_script_attributes` filter and switch tracking off
for a request with `datagoat_should_track`:

```php
add_filter( 'datagoat_script_attributes', function ( $attrs ) {
    $attrs['data-allowed-hostnames'] = 'app.example.io';
    return $attrs;
} );
```

WooCommerce stores: see [woocommerce.md](woocommerce.md).

## Option 2: by hand

In a child theme's `functions.php` (theme updates overwrite the parent theme's files):

```php
add_action( 'wp_head', function () {
    if ( current_user_can( 'manage_options' ) ) {
        return; // do not track administrators
    }
    echo '<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="https://a.example.com/js/script.js"></script>';
}, 1 );
```

Or paste the snippet from [the install overview](README.md#1-the-snippet) into a header-code
plugin.

## Caching and optimisation plugins

Exclude the tracker from "combine/defer/delay JavaScript" features (WP Rocket, Autoptimize,
LiteSpeed Cache): it is already `defer` and must keep its `data-*` attributes. Page caching is fine.

## Verify

Log out (or turn the admin exclusion off), open your site and check the **Realtime** view.

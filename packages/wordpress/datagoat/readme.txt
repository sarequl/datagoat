=== DataGoat Analytics ===
Contributors: datagoat
Tags: analytics, woocommerce, revenue attribution, privacy
Requires at least: 5.8
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.1.0
License: MIT
License URI: https://opensource.org/licenses/MIT

Adds the DataGoat tracker to your site and links WooCommerce orders to the visits that led to them.

== Description ==

DataGoat is open-source, revenue-first web analytics that runs in your own Cloudflare account.
This plugin:

* prints the DataGoat tracking script in the page head (optionally not for logged-in administrators or users);
* stores the visitor on every WooCommerce order (order meta `_datagoat_visitor_id` and `_datagoat_session_id`), so DataGoat attributes each sale to its traffic source;
* sends the `add_to_cart` and `initiate_checkout` goals for conversion funnels.

== Installation ==

1. Upload the `datagoat` folder to `/wp-content/plugins/` (or upload the zip under Plugins > Add New > Upload Plugin) and activate it.
2. Open Settings > DataGoat and enter the Website ID and the Script URL from your DataGoat dashboard.
3. WooCommerce stores: in DataGoat open Integrations > WooCommerce, enter your store URL and approve the connection in WordPress.

== Frequently Asked Questions ==

= Does it work with the checkout block and HPOS? =

Yes. The visitor is stored for both the classic checkout and the checkout block, through the WooCommerce order API.

= Can I add other script attributes? =

Use the `datagoat_script_attributes` filter, for example to add `data-allowed-hostnames`. The `datagoat_should_track` filter turns tracking off for a request.

== Changelog ==

= 0.1.0 =
* First release.

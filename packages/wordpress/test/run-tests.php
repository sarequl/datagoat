<?php
/**
 * Behaviour tests for the DataGoat WordPress plugin, runnable with the PHP CLI:
 *   php packages/wordpress/test/run-tests.php
 */

require __DIR__ . '/wp-stubs.php';
require __DIR__ . '/../datagoat/datagoat.php';

$GLOBALS['failures'] = 0;
$GLOBALS['passes']   = 0;

function check( $name, $condition ) {
	if ( $condition ) {
		$GLOBALS['passes']++;
		return;
	}
	$GLOBALS['failures']++;
	fwrite( STDERR, "FAIL: $name\n" );
}

function head_html() {
	ob_start();
	do_action( 'wp_head' );
	return ob_get_clean();
}

function footer_html() {
	ob_start();
	do_action( 'wp_footer' );
	return ob_get_clean();
}

function configure( $settings ) {
	$GLOBALS['wp_test']['options'][ DataGoat_Settings::OPTION ] = DataGoat_Settings::sanitize( $settings );
}

const VID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const SID = 's0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';

// --- Hooks are registered -------------------------------------------------------------
check( 'wp_head hook', isset( $GLOBALS['wp_test']['actions']['wp_head'] ) );
check( 'admin menu hook', isset( $GLOBALS['wp_test']['actions']['admin_menu'] ) );
check( 'classic checkout hook', isset( $GLOBALS['wp_test']['actions']['woocommerce_checkout_create_order'] ) );
check( 'block checkout hook', isset( $GLOBALS['wp_test']['actions']['woocommerce_store_api_checkout_update_order_meta'] ) );
check( 'HPOS compatibility hook', isset( $GLOBALS['wp_test']['actions']['before_woocommerce_init'] ) );

// --- Snippet ---------------------------------------------------------------------------
wp_test_reset();
check( 'nothing without settings', '' === head_html() );

configure( array( 'website_id' => 'dfid_abc123', 'script_url' => 'https://a.example.com/js/script.js' ) );
$html = head_html();
check( 'queue snippet', false !== strpos( $html, 'window.datafast=window.datafast||function(){(window.datafast.q=window.datafast.q||[]).push(arguments)};' ) );
check( 'script tag', false !== strpos( $html, '<script defer data-website-id="dfid_abc123" data-domain="example.com" data-api-url="https://a.example.com/api/events" src="https://a.example.com/js/script.js"></script>' ) );

configure( array( 'website_id' => 'dfid_abc123', 'script_url' => '/js/script.js', 'domain' => 'https://Shop.Example.org/path' ) );
$html = head_html();
check( 'relative script keeps the tracker default events URL', false === strpos( $html, 'data-api-url' ) );
check( 'relative src', false !== strpos( $html, 'src="/js/script.js"' ) );
check( 'domain cleaned', false !== strpos( $html, 'data-domain="shop.example.org"' ) );

configure( array( 'website_id' => 'dfid_abc123', 'script_url' => 'https://a.example.com/js/script.js', 'api_url' => 'https://b.example.com/collect' ) );
check( 'explicit events URL', false !== strpos( head_html(), 'data-api-url="https://b.example.com/collect"' ) );

// Attribute filter, escaping and attribute-name allowlist.
add_filter(
	'datagoat_script_attributes',
	static function ( $attrs ) {
		$attrs['data-allowed-hostnames'] = 'app.example.io,"><script>';
		$attrs['onload']                 = 'alert(1)';
		return $attrs;
	}
);
$html = head_html();
check( 'filtered attribute escaped', false !== strpos( $html, 'data-allowed-hostnames="app.example.io,&quot;&gt;&lt;script&gt;"' ) );
check( 'non data-* attributes dropped', false === strpos( $html, 'onload' ) );
$GLOBALS['wp_test']['filters'] = array();

// --- Exclusions ------------------------------------------------------------------------
configure( array( 'website_id' => 'dfid_abc123', 'script_url' => 'https://a.example.com/js/script.js', 'exclude_admins' => '1' ) );
$GLOBALS['wp_test']['logged_in'] = true;
$GLOBALS['wp_test']['caps']      = array( 'manage_options' );
check( 'admins excluded', '' === head_html() );
$GLOBALS['wp_test']['caps'] = array( 'read' );
check( 'other logged-in users tracked', '' !== head_html() );
configure( array( 'website_id' => 'dfid_abc123', 'script_url' => 'https://a.example.com/js/script.js', 'exclude_logged_in' => '1' ) );
check( 'all logged-in users excluded', '' === head_html() );
configure( array( 'website_id' => 'dfid_abc123', 'script_url' => 'https://a.example.com/js/script.js' ) );
$GLOBALS['wp_test']['caps'] = array( 'manage_options' );
check( 'admins tracked when the box is off', '' !== head_html() );
$GLOBALS['wp_test']['logged_in'] = false;
$GLOBALS['wp_test']['customize'] = true;
check( 'customizer preview excluded', '' === head_html() );
$GLOBALS['wp_test']['customize'] = false;
add_filter( 'datagoat_should_track', '__return_false' );
function __return_false() {
	return false;
}
check( 'datagoat_should_track filter', '' === head_html() );
$GLOBALS['wp_test']['filters'] = array();

// --- Sanitisation ----------------------------------------------------------------------
wp_test_reset();
$clean = DataGoat_Settings::sanitize(
	array(
		'website_id' => 'bad id <script>',
		'script_url' => 'javascript:alert(1)',
		'domain'     => 'exa mple.com',
	)
);
check( 'invalid website id rejected', '' === $clean['website_id'] && in_array( 'website_id', $GLOBALS['wp_test']['errors'], true ) );
check( 'javascript: URL rejected', '' === $clean['script_url'] );
check( 'invalid domain rejected', '' === $clean['domain'] );
check( 'unchecked boxes are false', false === $clean['exclude_admins'] && false === $clean['woocommerce_goals'] );
check( 'defaults exclude admins', true === DataGoat_Settings::defaults()['exclude_admins'] );

// --- WooCommerce order meta ------------------------------------------------------------
wp_test_reset();
$order = new WP_Test_Order();
do_action( 'woocommerce_checkout_create_order', $order );
check( 'no cookie, no meta', array() === $order->meta );

// DataFast's cookie names (a store that switched) are read too.
$_COOKIE['datafast_visitor_id'] = strtoupper( VID );
$_COOKIE['datafast_session_id'] = SID;
$order                          = new WP_Test_Order();
do_action( 'woocommerce_checkout_create_order', $order );
check( 'visitor meta (normalised)', VID === ( $order->meta['_datagoat_visitor_id'] ?? null ) );
check( 'session meta', SID === ( $order->meta['_datagoat_session_id'] ?? null ) );

$block_order = new WP_Test_Order();
do_action( 'woocommerce_store_api_checkout_update_order_meta', $block_order );
check( 'block checkout meta', VID === ( $block_order->meta['_datagoat_visitor_id'] ?? null ) );

$_COOKIE['datafast_visitor_id'] = 'not-a-uuid"><';
$order                          = new WP_Test_Order();
do_action( 'woocommerce_checkout_create_order', $order );
check( 'malformed cookie ignored', array() === $order->meta );

// DataGoat's own cookie wins over DataFast's.
$_COOKIE['datagoat_visitor_id'] = VID;
$order                          = new WP_Test_Order();
do_action( 'woocommerce_checkout_create_order', $order );
check( 'datagoat_ cookie read first', VID === ( $order->meta['_datagoat_visitor_id'] ?? null ) );
unset( $_COOKIE['datagoat_visitor_id'], $_COOKIE['datafast_visitor_id'], $_COOKIE['datafast_session_id'] );

// --- WooCommerce goals -----------------------------------------------------------------
wp_test_reset();
configure( array( 'website_id' => 'dfid_abc123', 'script_url' => 'https://a.example.com/js/script.js', 'woocommerce_goals' => '1' ) );
do_action( 'woocommerce_add_to_cart' );
$footer = footer_html();
check( 'classic add_to_cart printed on the next page', false !== strpos( $footer, 'd("add_to_cart");' ) );
check( 'pending goals cleared', false === strpos( footer_html(), 'd("add_to_cart");' ) );
check( 'AJAX listeners', false !== strpos( $footer, '"added_to_cart"' ) && false !== strpos( $footer, 'wc-blocks_added_to_cart' ) );

$GLOBALS['wp_test']['ajax'] = true;
do_action( 'woocommerce_add_to_cart' );
$GLOBALS['wp_test']['ajax'] = false;
check( 'AJAX adds are not queued server-side', false === strpos( footer_html(), 'd("add_to_cart");' ) );

$GLOBALS['wp_test']['checkout'] = true;
check( 'initiate_checkout on the checkout page', false !== strpos( footer_html(), 'd("initiate_checkout");' ) );
$GLOBALS['wp_test']['received'] = true;
check( 'not on the order-received page', false === strpos( footer_html(), 'initiate_checkout' ) );

configure( array( 'website_id' => 'dfid_abc123', 'script_url' => 'https://a.example.com/js/script.js' ) );
check( 'goals off when unchecked', '' === footer_html() );
configure( array( 'website_id' => 'dfid_abc123', 'script_url' => 'https://a.example.com/js/script.js', 'woocommerce_goals' => '1', 'exclude_admins' => '1' ) );
$GLOBALS['wp_test']['logged_in'] = true;
$GLOBALS['wp_test']['caps']      = array( 'manage_options' );
check( 'goals off for excluded admins', '' === footer_html() );

// --- Uninstall -------------------------------------------------------------------------
define( 'WP_UNINSTALL_PLUGIN', true );
$GLOBALS['wp_test']['options'][ DataGoat_Settings::OPTION ] = array( 'website_id' => 'x' );
require __DIR__ . '/../datagoat/uninstall.php';
check( 'uninstall removes settings', ! isset( $GLOBALS['wp_test']['options'][ DataGoat_Settings::OPTION ] ) );

printf( "WordPress plugin: %d passed, %d failed\n", $GLOBALS['passes'], $GLOBALS['failures'] );
exit( $GLOBALS['failures'] > 0 ? 1 : 0 );

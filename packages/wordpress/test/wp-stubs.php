<?php
/**
 * Minimal stand-ins for the WordPress and WooCommerce functions the plugin calls, so its
 * behaviour can be tested with the PHP CLI alone. State lives in $GLOBALS['wp_test'].
 */

define( 'ABSPATH', __DIR__ . '/' );

$GLOBALS['wp_test'] = array(
	'options'   => array(),
	'actions'   => array(),
	'filters'   => array(),
	'logged_in' => false,
	'caps'      => array(),
	'home'      => 'https://www.example.com',
	'errors'    => array(),
	'ajax'      => false,
	'checkout'  => false,
	'received'  => false,
	'customize' => false,
);

function wp_test_reset() {
	$GLOBALS['wp_test']['options']   = array();
	$GLOBALS['wp_test']['logged_in'] = false;
	$GLOBALS['wp_test']['caps']      = array();
	$GLOBALS['wp_test']['errors']    = array();
	$GLOBALS['wp_test']['ajax']      = false;
	$GLOBALS['wp_test']['checkout']  = false;
	$GLOBALS['wp_test']['received']  = false;
	$GLOBALS['wp_test']['customize'] = false;
	$GLOBALS['wp_test']['filters']   = array();
	$_COOKIE  = array();
	$_REQUEST = array();
	WC()->session = new WP_Test_Session();
}

function add_action( $hook, $callback, $priority = 10, $args = 1 ) {
	$GLOBALS['wp_test']['actions'][ $hook ][] = $callback;
}
function add_filter( $hook, $callback, $priority = 10, $args = 1 ) {
	$GLOBALS['wp_test']['filters'][ $hook ][] = $callback;
}
function do_action( $hook, ...$args ) {
	foreach ( $GLOBALS['wp_test']['actions'][ $hook ] ?? array() as $cb ) {
		call_user_func_array( $cb, $args );
	}
}
function apply_filters( $hook, $value, ...$args ) {
	foreach ( $GLOBALS['wp_test']['filters'][ $hook ] ?? array() as $cb ) {
		$value = call_user_func_array( $cb, array_merge( array( $value ), $args ) );
	}
	return $value;
}
function get_option( $name, $default = false ) {
	return $GLOBALS['wp_test']['options'][ $name ] ?? $default;
}
function delete_option( $name ) {
	unset( $GLOBALS['wp_test']['options'][ $name ] );
}
function is_user_logged_in() {
	return $GLOBALS['wp_test']['logged_in'];
}
function current_user_can( $cap ) {
	return in_array( $cap, $GLOBALS['wp_test']['caps'], true );
}
function is_customize_preview() {
	return $GLOBALS['wp_test']['customize'];
}
function wp_doing_ajax() {
	return $GLOBALS['wp_test']['ajax'];
}
function is_checkout() {
	return $GLOBALS['wp_test']['checkout'];
}
function is_wc_endpoint_url( $endpoint ) {
	return 'order-received' === $endpoint && $GLOBALS['wp_test']['received'];
}
function home_url() {
	return $GLOBALS['wp_test']['home'];
}
function admin_url( $path = '' ) {
	return 'https://www.example.com/wp-admin/' . $path;
}
function plugin_basename( $file ) {
	return 'datagoat/' . basename( $file );
}
function wp_parse_url( $url, $component = -1 ) {
	return parse_url( $url, $component );
}
function esc_attr( $text ) {
	return htmlspecialchars( (string) $text, ENT_QUOTES, 'UTF-8' );
}
function esc_html( $text ) {
	return htmlspecialchars( (string) $text, ENT_QUOTES, 'UTF-8' );
}
function esc_url( $url ) {
	$url = (string) $url;
	if ( ! preg_match( '#^https?://#i', $url ) ) {
		return '';
	}
	return htmlspecialchars( str_replace( array( '"', "'", ' ', '<', '>' ), '', $url ), ENT_QUOTES, 'UTF-8' );
}
function esc_url_raw( $url, $protocols = null ) {
	$url = trim( (string) $url );
	return preg_match( '#^https?://[^\s"\'<>]+$#i', $url ) ? $url : '';
}
function __( $text, $domain = null ) {
	return $text;
}
function esc_html__( $text, $domain = null ) {
	return esc_html( $text );
}
function sanitize_text_field( $text ) {
	return trim( preg_replace( '/[\r\n\t<>]+/', '', strip_tags( (string) $text ) ) );
}
function wp_unslash( $value ) {
	return is_string( $value ) ? stripslashes( $value ) : $value;
}
function wp_json_encode( $value ) {
	return json_encode( $value );
}
function add_settings_error( $setting, $code, $message ) {
	$GLOBALS['wp_test']['errors'][] = $code;
}
function checked( $checked, $current = true, $echo = true ) {
	return $checked === $current ? 'checked="checked"' : '';
}

class WP_Test_Session {
	public $data = array();
	public function get( $key, $default = null ) {
		return $this->data[ $key ] ?? $default;
	}
	public function set( $key, $value ) {
		$this->data[ $key ] = $value;
	}
}

class WP_Test_WC {
	public $session;
}

function WC() {
	static $wc = null;
	if ( null === $wc ) {
		$wc          = new WP_Test_WC();
		$wc->session = new WP_Test_Session();
	}
	return $wc;
}

class WP_Test_Order {
	public $meta = array();
	public function update_meta_data( $key, $value ) {
		$this->meta[ $key ] = $value;
	}
}

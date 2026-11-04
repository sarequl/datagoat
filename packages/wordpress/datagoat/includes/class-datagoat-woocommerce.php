<?php
/**
 * WooCommerce: store the visitor on each order, send funnel goals.
 *
 * DataGoat reads orders through the WooCommerce connection (Integrations > WooCommerce in the
 * DataGoat dashboard). The order meta `_datagoat_visitor_id` (and `_datagoat_session_id`) tells it
 * which visit the order came from, so revenue is attributed to the right channel.
 *
 * @package DataGoat
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Order meta and goals.
 */
class DataGoat_WooCommerce {

	const META_VISITOR   = '_datagoat_visitor_id';
	const META_SESSION   = '_datagoat_session_id';
	const COOKIE_VISITOR = 'datafast_visitor_id';
	const COOKIE_SESSION = 'datafast_session_id';
	const SESSION_GOALS  = 'datagoat_pending_goals';
	const UUID_V4        = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i';

	/**
	 * Hooks (they only fire when WooCommerce is active).
	 */
	public static function register() {
		// Classic checkout.
		add_action( 'woocommerce_checkout_create_order', array( __CLASS__, 'store_visitor' ), 10, 1 );
		// Checkout block (Store API).
		add_action( 'woocommerce_store_api_checkout_update_order_meta', array( __CLASS__, 'store_visitor' ), 10, 1 );
		add_action( 'woocommerce_add_to_cart', array( __CLASS__, 'queue_add_to_cart' ), 10, 0 );
		add_action( 'wp_footer', array( __CLASS__, 'print_goals' ), 20 );
	}

	/**
	 * The visitor id from the tracker cookie, or '' when missing or malformed.
	 *
	 * @param string $name Cookie name.
	 * @return string
	 */
	public static function cookie( $name ) {
		if ( ! isset( $_COOKIE[ $name ] ) ) {
			return '';
		}
		return sanitize_text_field( wp_unslash( $_COOKIE[ $name ] ) );
	}

	/**
	 * Valid visitor id from the cookie.
	 *
	 * @return string
	 */
	public static function visitor_id() {
		$value = self::cookie( self::COOKIE_VISITOR );
		return preg_match( self::UUID_V4, $value ) ? strtolower( $value ) : '';
	}

	/**
	 * Valid session id (`s` + UUID v4) from the cookie.
	 *
	 * @return string
	 */
	public static function session_id() {
		$value = self::cookie( self::COOKIE_SESSION );
		return ( 's' === substr( $value, 0, 1 ) && preg_match( self::UUID_V4, substr( $value, 1 ) ) ) ? strtolower( $value ) : '';
	}

	/**
	 * Write the visitor and session onto the order being created.
	 *
	 * @param WC_Order $order Order.
	 */
	public static function store_visitor( $order ) {
		if ( ! is_object( $order ) || ! method_exists( $order, 'update_meta_data' ) ) {
			return;
		}
		$visitor = self::visitor_id();
		if ( '' === $visitor ) {
			return;
		}
		$order->update_meta_data( self::META_VISITOR, $visitor );
		$session = self::session_id();
		if ( '' !== $session ) {
			$order->update_meta_data( self::META_SESSION, $session );
		}
	}

	/**
	 * Whether goals are on.
	 *
	 * @return bool
	 */
	private static function goals_enabled() {
		$settings = DataGoat_Settings::get();
		return ! empty( $settings['woocommerce_goals'] ) && DataGoat_Tracker::should_track( $settings );
	}

	/**
	 * Classic (page-reloading) add to cart: remember the goal for the next page view. AJAX and
	 * Store API adds are reported in the browser by the footer script instead.
	 */
	public static function queue_add_to_cart() {
		if ( wp_doing_ajax() || isset( $_REQUEST['wc-ajax'] ) || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			return;
		}
		if ( ! function_exists( 'WC' ) || ! WC()->session ) {
			return;
		}
		$pending   = (array) WC()->session->get( self::SESSION_GOALS, array() );
		$pending[] = 'add_to_cart';
		WC()->session->set( self::SESSION_GOALS, array_slice( $pending, -5 ) );
	}

	/**
	 * Footer script: pending classic add-to-cart goals, AJAX/block add-to-cart listeners and the
	 * initiate_checkout goal on the checkout page.
	 */
	public static function print_goals() {
		if ( ! function_exists( 'WC' ) || ! self::goals_enabled() ) {
			return;
		}
		$goals = array();
		if ( WC()->session ) {
			$goals = (array) WC()->session->get( self::SESSION_GOALS, array() );
			if ( $goals ) {
				WC()->session->set( self::SESSION_GOALS, array() );
			}
		}
		$is_checkout = function_exists( 'is_checkout' ) && is_checkout()
			&& ! ( function_exists( 'is_wc_endpoint_url' ) && is_wc_endpoint_url( 'order-received' ) );
		if ( $is_checkout ) {
			$goals[] = 'initiate_checkout';
		}
		$js = '(function(){var d=window.datafast;if(!d)return;';
		foreach ( $goals as $goal ) {
			if ( preg_match( '/^[a-z_]+$/', (string) $goal ) ) {
				$js .= 'd(' . wp_json_encode( (string) $goal ) . ');';
			}
		}
		$js .= 'var last=0;function add(){var n=Date.now();if(n-last<1500)return;last=n;window.datafast("add_to_cart");}';
		$js .= 'if(window.jQuery){window.jQuery(document.body).on("added_to_cart",add);}';
		$js .= 'document.body&&document.body.addEventListener("wc-blocks_added_to_cart",add);';
		$js .= '})();';
		echo '<script id="datagoat-woocommerce">' . $js . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- static code and json-encoded goal names.
	}
}

<?php
/**
 * Settings page: Settings > DataGoat.
 *
 * @package DataGoat
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Stores everything in one option, `datagoat_settings`.
 */
class DataGoat_Settings {

	const OPTION = 'datagoat_settings';
	const PAGE   = 'datagoat';

	/**
	 * Defaults for every setting.
	 *
	 * @return array<string, mixed>
	 */
	public static function defaults() {
		return array(
			'website_id'         => '',
			'script_url'         => '',
			'api_url'            => '',
			'domain'             => '',
			'exclude_admins'     => true,
			'exclude_logged_in'  => false,
			'woocommerce_goals'  => true,
		);
	}

	/**
	 * Current settings merged over the defaults.
	 *
	 * @return array<string, mixed>
	 */
	public static function get() {
		$stored = get_option( self::OPTION, array() );
		if ( ! is_array( $stored ) ) {
			$stored = array();
		}
		return array_merge( self::defaults(), $stored );
	}

	/**
	 * Hooks.
	 */
	public static function register() {
		add_action( 'admin_menu', array( __CLASS__, 'add_page' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_setting' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( DATAGOAT_PLUGIN_FILE ), array( __CLASS__, 'action_links' ) );
	}

	/**
	 * "Settings" link on the Plugins screen.
	 *
	 * @param string[] $links Existing links.
	 * @return string[]
	 */
	public static function action_links( $links ) {
		$url = admin_url( 'options-general.php?page=' . self::PAGE );
		array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'datagoat' ) . '</a>' );
		return $links;
	}

	/**
	 * Settings > DataGoat.
	 */
	public static function add_page() {
		add_options_page(
			__( 'DataGoat', 'datagoat' ),
			__( 'DataGoat', 'datagoat' ),
			'manage_options',
			self::PAGE,
			array( __CLASS__, 'render_page' )
		);
	}

	/**
	 * Settings API registration with sanitisation.
	 */
	public static function register_setting() {
		register_setting(
			self::PAGE,
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'default'           => self::defaults(),
			)
		);
	}

	/**
	 * Validate and clean submitted settings.
	 *
	 * @param mixed $input Raw form input.
	 * @return array<string, mixed>
	 */
	public static function sanitize( $input ) {
		$input = is_array( $input ) ? $input : array();
		$out   = self::defaults();

		$website_id = isset( $input['website_id'] ) ? trim( sanitize_text_field( $input['website_id'] ) ) : '';
		if ( '' !== $website_id && ! preg_match( '/^[A-Za-z0-9_\-]{3,64}$/', $website_id ) ) {
			add_settings_error( self::OPTION, 'website_id', __( 'The website ID may contain only letters, digits, - and _.', 'datagoat' ) );
			$website_id = '';
		}
		$out['website_id'] = $website_id;

		foreach ( array( 'script_url', 'api_url' ) as $key ) {
			$value = isset( $input[ $key ] ) ? trim( (string) $input[ $key ] ) : '';
			if ( '' === $value ) {
				$out[ $key ] = '';
				continue;
			}
			$is_relative = 0 === strpos( $value, '/' ) && 0 !== strpos( $value, '//' );
			$clean       = $is_relative ? sanitize_text_field( $value ) : esc_url_raw( $value, array( 'https', 'http' ) );
			if ( '' === $clean ) {
				/* translators: %s: setting name */
				add_settings_error( self::OPTION, $key, sprintf( __( '%s must be an https:// URL or a path starting with /.', 'datagoat' ), $key ) );
			}
			$out[ $key ] = $clean;
		}

		$domain        = isset( $input['domain'] ) ? strtolower( trim( sanitize_text_field( $input['domain'] ) ) ) : '';
		$domain        = preg_replace( '#^https?://#', '', $domain );
		$domain        = preg_replace( '#[/?].*$#', '', $domain );
		$out['domain'] = preg_match( '/^[a-z0-9.-]+$/', $domain ) ? $domain : '';

		foreach ( array( 'exclude_admins', 'exclude_logged_in', 'woocommerce_goals' ) as $key ) {
			$out[ $key ] = ! empty( $input[ $key ] );
		}
		return $out;
	}

	/**
	 * Render a text field.
	 *
	 * @param array<string, mixed> $settings Current settings.
	 * @param string               $key      Setting key.
	 * @param string               $placeholder Placeholder.
	 */
	private static function text_field( $settings, $key, $placeholder ) {
		printf(
			'<input type="text" class="regular-text code" id="datagoat_%1$s" name="%2$s[%1$s]" value="%3$s" placeholder="%4$s" />',
			esc_attr( $key ),
			esc_attr( self::OPTION ),
			esc_attr( (string) $settings[ $key ] ),
			esc_attr( $placeholder )
		);
	}

	/**
	 * Render a checkbox.
	 *
	 * @param array<string, mixed> $settings Current settings.
	 * @param string               $key      Setting key.
	 * @param string               $label    Label.
	 */
	private static function checkbox( $settings, $key, $label ) {
		printf(
			'<label><input type="checkbox" name="%1$s[%2$s]" value="1" %3$s /> %4$s</label><br />',
			esc_attr( self::OPTION ),
			esc_attr( $key ),
			checked( ! empty( $settings[ $key ] ), true, false ),
			esc_html( $label )
		);
	}

	/**
	 * The settings screen.
	 */
	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings = self::get();
		echo '<div class="wrap"><h1>' . esc_html__( 'DataGoat', 'datagoat' ) . '</h1>';
		echo '<p>' . esc_html__( 'Copy the website ID and the script URL from your DataGoat dashboard (Settings > Tracking).', 'datagoat' ) . '</p>';
		echo '<form method="post" action="options.php">';
		settings_fields( self::PAGE );
		echo '<table class="form-table" role="presentation">';

		echo '<tr><th scope="row"><label for="datagoat_website_id">' . esc_html__( 'Website ID', 'datagoat' ) . '</label></th><td>';
		self::text_field( $settings, 'website_id', 'dfid_...' );
		echo '</td></tr>';

		echo '<tr><th scope="row"><label for="datagoat_script_url">' . esc_html__( 'Script URL', 'datagoat' ) . '</label></th><td>';
		self::text_field( $settings, 'script_url', 'https://analytics.example.com/js/script.js' );
		echo '<p class="description">' . esc_html__( 'Your DataGoat instance followed by /js/script.js (or /js/script.cookieless.js, /js/script.hash.js). A path such as /js/script.js works when you proxy DataGoat through this site.', 'datagoat' ) . '</p>';
		echo '</td></tr>';

		echo '<tr><th scope="row"><label for="datagoat_api_url">' . esc_html__( 'Events URL (optional)', 'datagoat' ) . '</label></th><td>';
		self::text_field( $settings, 'api_url', 'https://analytics.example.com/api/events' );
		echo '<p class="description">' . esc_html__( 'Default: /api/events on the script URL\'s host.', 'datagoat' ) . '</p>';
		echo '</td></tr>';

		echo '<tr><th scope="row"><label for="datagoat_domain">' . esc_html__( 'Domain (optional)', 'datagoat' ) . '</label></th><td>';
		self::text_field( $settings, 'domain', self::site_domain() );
		echo '<p class="description">' . esc_html__( 'Your root domain as configured in DataGoat. Default: this site\'s domain.', 'datagoat' ) . '</p>';
		echo '</td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Exclusions', 'datagoat' ) . '</th><td>';
		self::checkbox( $settings, 'exclude_admins', __( 'Do not track logged-in administrators', 'datagoat' ) );
		self::checkbox( $settings, 'exclude_logged_in', __( 'Do not track any logged-in user', 'datagoat' ) );
		echo '</td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'WooCommerce', 'datagoat' ) . '</th><td>';
		self::checkbox( $settings, 'woocommerce_goals', __( 'Send add_to_cart and initiate_checkout goals', 'datagoat' ) );
		echo '<p class="description">' . esc_html__( 'Orders always store the visitor (order meta _datagoat_visitor_id) so DataGoat can attribute revenue. Connect the store in DataGoat under Integrations > WooCommerce.', 'datagoat' ) . '</p>';
		echo '</td></tr>';

		echo '</table>';
		submit_button();
		echo '</form></div>';
	}

	/**
	 * This site's host without "www.".
	 *
	 * @return string
	 */
	public static function site_domain() {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		$host = is_string( $host ) ? strtolower( $host ) : '';
		return preg_replace( '/^www\./', '', $host );
	}
}

<?php
/**
 * Prints the DataGoat tracker in <head>.
 *
 * @package DataGoat
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Snippet injection and exclusions.
 */
class DataGoat_Tracker {

	/**
	 * Hooks.
	 */
	public static function register() {
		add_action( 'wp_head', array( __CLASS__, 'print_snippet' ), 1 );
	}

	/**
	 * Whether this page view should load the tracker.
	 *
	 * @param array<string, mixed> $settings Settings.
	 * @return bool
	 */
	public static function should_track( $settings ) {
		if ( '' === (string) $settings['website_id'] || '' === (string) $settings['script_url'] ) {
			return false;
		}
		if ( function_exists( 'is_customize_preview' ) && is_customize_preview() ) {
			return false;
		}
		if ( is_user_logged_in() ) {
			if ( ! empty( $settings['exclude_logged_in'] ) ) {
				return false;
			}
			if ( ! empty( $settings['exclude_admins'] ) && current_user_can( 'manage_options' ) ) {
				return false;
			}
		}
		/**
		 * Filter: return false to skip the tracker on this request.
		 *
		 * @param bool $track Whether to print the tracker.
		 */
		return (bool) apply_filters( 'datagoat_should_track', true );
	}

	/**
	 * The events URL: the setting, or /api/events on the script's host.
	 *
	 * @param array<string, mixed> $settings Settings.
	 * @return string Empty when the tracker's default applies (same-origin proxy).
	 */
	public static function api_url( $settings ) {
		if ( '' !== (string) $settings['api_url'] ) {
			return (string) $settings['api_url'];
		}
		$parts = wp_parse_url( (string) $settings['script_url'] );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) ) {
			return '';
		}
		$scheme = isset( $parts['scheme'] ) ? $parts['scheme'] : 'https';
		$port   = isset( $parts['port'] ) ? ':' . $parts['port'] : '';
		return $scheme . '://' . $parts['host'] . $port . '/api/events';
	}

	/**
	 * Print the pre-load queue and the deferred tracker tag.
	 */
	public static function print_snippet() {
		$settings = DataGoat_Settings::get();
		if ( ! self::should_track( $settings ) ) {
			return;
		}
		$domain = '' !== (string) $settings['domain'] ? (string) $settings['domain'] : DataGoat_Settings::site_domain();
		$api    = self::api_url( $settings );

		echo "<script id=\"datagoat-queue\">window.datafast=window.datafast||function(){(window.datafast.q=window.datafast.q||[]).push(arguments)};</script>\n";
		$attributes = array(
			'data-website-id' => (string) $settings['website_id'],
			'data-domain'     => $domain,
		);
		if ( '' !== $api ) {
			$attributes['data-api-url'] = $api;
		}
		/**
		 * Filter the tracker's data-* attributes (e.g. add data-allowed-hostnames).
		 *
		 * @param array<string, string> $attributes Attribute name => value.
		 */
		$attributes = (array) apply_filters( 'datagoat_script_attributes', $attributes );
		$html       = '<script defer';
		foreach ( $attributes as $name => $value ) {
			if ( ! preg_match( '/^data-[a-z-]+$/', (string) $name ) ) {
				continue;
			}
			$html .= ' ' . $name . '="' . esc_attr( (string) $value ) . '"';
		}
		$src   = (string) $settings['script_url'];
		$src   = 0 === strpos( $src, '/' ) ? esc_attr( $src ) : esc_url( $src );
		$html .= ' src="' . $src . '"></script>' . "\n";
		echo $html; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- every part is escaped above.
	}
}

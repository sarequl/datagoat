<?php
/**
 * Removes the plugin's settings when it is deleted. Order meta stays: it belongs to the orders.
 *
 * @package DataGoat
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'datagoat_settings' );

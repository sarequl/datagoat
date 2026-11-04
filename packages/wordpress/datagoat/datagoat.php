<?php
/**
 * Plugin Name:       DataGoat Analytics
 * Plugin URI:        https://github.com/sarequl/datagoat
 * Description:       Adds the DataGoat tracking script to your site and links WooCommerce orders to the visits that led to them.
 * Version:           0.1.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            DataGoat contributors
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 * Text Domain:       datagoat
 * WC requires at least: 6.0
 * WC tested up to:   10.3
 *
 * @package DataGoat
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'DATAGOAT_VERSION', '0.1.0' );
define( 'DATAGOAT_PLUGIN_FILE', __FILE__ );

require_once __DIR__ . '/includes/class-datagoat-settings.php';
require_once __DIR__ . '/includes/class-datagoat-tracker.php';
require_once __DIR__ . '/includes/class-datagoat-woocommerce.php';

DataGoat_Settings::register();
DataGoat_Tracker::register();
DataGoat_WooCommerce::register();

// WooCommerce High-Performance Order Storage: order meta is written through the CRUD API.
add_action(
	'before_woocommerce_init',
	static function () {
		if ( class_exists( '\Automattic\WooCommerce\Utilities\FeaturesUtil' ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', DATAGOAT_PLUGIN_FILE, true );
		}
	}
);

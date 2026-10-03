<?php
/**
 * WordPress 配置文件样本
 * 
 * @package WordPress
 */

// ===== 核心配置 =====
define( 'ABSPATH', '/your/path/to/wordpress/' );
define( 'WP_DEBUG', false );
define( 'WP_MEMORY_LIMIT', '256M' );

// ===== 数据库配置 =====
$db_host = 'localhost';
$db_name = 'wp_blog_db';
$db_user = '';
$db_pass = '';
$db_charset = 'utf8mb4';

// ===== URL 配置 =====
define( 'WP_HOME', '${WP_SITE_URL}' );
define( 'WP_SITEURL', WP_HOME );
$home_path = parse_url(WP_HOME, PHP_URL_PATH);

// ===== 安全密钥（生产环境请生成新密钥）=====
$salt_1 = '${WP_SALT_1}';
$salt_2 = '${WP_SALT_2}';
$salt_3 = '${WP_SALT_3}';
$salt_4 = '${WP_SALT_4}';

// ===== 启用缓存（可选）=====
define( 'DISABLE_WP_CACHE', false );

// ===== 插件目录 =====
$wp_plugins_dir = ABSPATH . 'wp-content/plugins';
if (!defined('WP_CONTENT_DIR')) define('WP_CONTENT_DIR', ABSPATH . 'wp-content');
if (!defined('WP_PLUGIN_DIR')) define('WP_PLUGIN_DIR', WP_CONTENT_DIR . '/plugins');

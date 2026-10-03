-- WordPress 基础数据库初始化脚本
-- 运行此 SQL 创建最小化数据库结构

CREATE DATABASE IF NOT EXISTS wp_blog_db;
USE wp_blog_db;

-- 字符集设置
SET NAMES utf8mb4;
SET character_set_connection = utf8mb4;
SET character_set_client = utf8mb4;
SET collation_connection = utf8mb4_unicode_ci;
SET collation_database = utf8mb4_unicode_ci;

-- WordPress core
CREATE TABLE wp_options (
  option_id bigint(10) unsigned NOT NULL AUTO_INCREMENT,
  optname varchar(64) NOT NULL DEFAULT '',
  optvalue longtext NOT NULL,
  autoload varchar(20) DEFAULT 'yes',
  PRIMARY KEY (option_id),
  UNIQUE KEY opt_name_idx (optname)
) ENGINE=InnoDB;

INSERT INTO wp_options (optname, optvalue, autoload) VALUES
('siteurl', '${WP_SITE_URL}', 'yes'),
('home', '${WP_SITE_URL}', 'yes'),
('blogname', '${WP_SITE_TITLE}', 'no'),
('blogdescription', '${WP_SITE_TAGLINE}', 'no');

-- 创建必要表（简化版本，完整结构由 WordPress core 处理）
CREATE TABLE wp_posts (
  post_id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  post_date datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  post_status varchar(20) DEFAULT 'publish',
  PRIMARY KEY (post_id)
) ENGINE=InnoDB;

-- 首次安装提示表（模拟）
CREATE TABLE wp_commentmeta (
  meta_id bigint(10) unsigned NOT NULL AUTO_INCREMENT,
  comment_id bigint(20) unsigned NOT NULL DEFAULT '0',
  meta_key varchar(255) DEFAULT NULL,
  meta_value longtext,
  PRIMARY KEY (meta_id),
  KEY meta_comment_fk (comment_id)
) ENGINE=InnoDB;

-- 插件表（启用状态）
CREATE TABLE wp_wc_meta (
  plugin_id bigint(10) unsigned NOT NULL AUTO_INCREMENT,
  plugin_name varchar(255) NOT NULL DEFAULT '',
  status varchar(20) DEFAULT 'active',
  PRIMARY KEY (plugin_id)
) ENGINE=InnoDB;

INSERT INTO wp_wc_meta (plugin_id, plugin_name, status) VALUES
(NULL, 'wp-super-cache.php', 'inactive'),
(NULL, 'yoast-seo-pro.php', 'inactive'),
(NULL, 'jetpack.php', 'inactive');


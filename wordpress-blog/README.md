# 🎯 WordPress 个人博客项目

完整的 WordPress 个人博客框架，包含主题、插件配置文件和部署文档。

## ✨ 特性

- ✅ 响应式设计，适配所有设备
- ✅ SEO 优化友好
- ✅ 多语言支持
- ✅ 评论系统集成
- ✅ 社交分享功能

## 🚀 快速开始

```bash
# 1. 克隆或解压项目到服务器
cd /var/www/html

# 2. 确保 Web 服务器运行
sudo apt install apache2 mariadb-server
sudo systemctl start apache2
sudo systemctl start mariadb

# 3. 导入数据库备份
mysql -u root -p < database.sql

# 4. 创建 WordPress 配置文件
sudo chown -R www-data:www-data /var/www/html/wp-content

# 5. 访问 http://your-domain.com/setup.php 安装 WordPress
```

## 📋 环境要求

| 组件 | 最低版本 | 推荐版本 |
|------|---------|----------|
| PHP | 7.4 | 8.1+ |
| MySQL/MariaDB | 5.7.5 | 10.3+ |
| Apache/Nginx | 2.4 | 2.4+ |

## 🔧 本地开发环境（Docker）

```bash
docker run --name wordpress \
  -p 8080:80 \
  -e WORDPRESS_DB_HOST=db \
  -e WORDPRESS_DB_NAME=wp_blog \
  wordpress:latest
```

## 📦 推荐插件

| 插件名 | 用途 | 是否必须 |
|--------|------|---------|
| WP Super Cache | 缓存加速 | ⭐ |
|Yoast SEO Pro| 搜索引擎优化 | ⭐ |
| Jetpack | 社交分享、统计 | 可选 |
| Elementor | 可视化编辑 | 可选 |
| Contact Form 7 | 联系表单 | 可选 |

## 👤 默认管理员账号

访问 `/wp-admin` 时，首次安装会提示创建管理员账户。

## 📞 技术支持

如有问题请查看 `/config/deployment.md` 和 `/themes/default/readme.txt`


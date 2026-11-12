# QQ 图片与 Clash TUN 兼容修复

QQ 入站图片下载失败时，multimedia.nt.qq.com.cn 被本机 DNS 解析为 198.18/15 Fake-IP，原下载器按保留地址拒绝连接。

修复仅在已知 QQ 图片 CDN 的系统解析全部为 Fake-IP 时，通过固定 Google DNS over HTTPS 服务获取真实公网 IPv4，并使用原下载器固定目标连接。域名查询包含 CDN 域名，图片 URL、临时凭据和图片内容不发给 DNS 服务。其他域名、私网解析、混合地址与重定向仍沿用原有安全检查。

本机 Clash 的 TUN、全局代理及 Antigravity 配置保持现有状态。实际重新下载用户最新图片得到 341349 字节 JPEG，真实模型识别出蓝发少女、档案照场景与“偷吃白饭罪”等图片文字。较旧的两个图片链接已返回 HTTP 400，需要取得新的有效链接。

相关用例覆盖 QQ Fake-IP 回退、普通域名保持拒绝、真实私网保持拒绝及 DNS 服务异常地址拒绝。运行证据保存在本机 data/image-repair-*。

# 会话迁移与续期验证

当前阶段：脚本就绪，但没有真实会话，尚未向零跑发起验证请求。

## 准备

需要 Android 客户端主动导出的会话 JSON（格式见 README）。开启 USB 调试本身不提供读取正式版应用私有会话的权限。不要把会话内容粘贴到聊天或终端命令参数。

脚本在 Node 24 下运行，默认把会话加密保存到当前目录的 `data/session-check`，与仪表盘会话分开。可设置 `SESSION_CHECK_DATA_DIR` 选择验证目录。所有命令必须使用同一个目录。此脚本只能调用登录令牌交换、续期、车辆列表、车辆路由和车况读取接口；不发送短信或控车命令。

## 首次检查

```text
node src/session-check.mjs import /path/to/session.json
```

成功意味着导入会话可以在当前运行机器上换取网关令牌并读取车况。若在 Windows 执行，只证明 Windows 接入可用；要验证 NAS 的实际网络和运行环境，仍需在 NAS 上执行。

导入文件保持原样，脚本不自动删除用户文件。导入成功后自行清理明文副本；保留加密验证目录。

## 分别验证两条续期路径

```text
node src/session-check.mjs refresh-gateway
node src/session-check.mjs refresh-old
```

这两步会真实刷新令牌，可能轮换刷新令牌或使手机共享的旧会话失效。每执行一步，都在手机 APP 手动刷新车况，记录是否要求重新登录；不要以手机页面仍显示缓存车况作为会话仍有效的证据。

网关续期验证禁止自动回退到旧令牌路径，因此其成功不会被另一条路径掩盖。轮换后的令牌即使后续读取车况失败，也会保存在加密验证目录中。

## 跨自然过期时间验证

记下上一次输出的 `gatewayExpiresAt`。保持登录用的测试客户端关闭，在这一时间之后执行：

```text
node src/session-check.mjs probe
```

检查 `ok` 以及 `gatewayRefreshRequests` / `oldRefreshRequests`，并再次手动检查日常手机 APP。更长时间后重复一次可观察稳定性。脚本不自动声称完成自然过期验证：必须比较实际检查时间与此前记录的过期时间。主动刷新成功不能替代跨自然过期时间验证。

结果只输出是否成功、错误类别、时间和续期调用次数，不输出手机号、令牌、VIN、位置或原始车况。`phoneSessionStillValid` 始终提醒需要人工检查。

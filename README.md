# freehub2dsh

[dsh](https://deepseek.com) 插件：把 [free-model-hub](https://github.com/lfapex/free-model-hub)
后台的模型清单注册进 dsh 的模型选择器，对话流量代理到 hub 的 OpenAI 兼容端口。

hub 是独立常驻 daemon，拥有全部车道（免费车道、Kilo、13 个账号白嫖渠道、自定义
中转站）与全部设置；本插件只是它的 dsh 客户端——不碰任何上游、不存任何凭据，
卸载插件不会孤立任何账号。

## 安装

```sh
# 一次性：安装并常驻 hub daemon（见其 README 的自启配置）
npm i -g github:lfapex/free-model-hub

# 装 dsh 插件
dsh plugin --profile <你的profile名> add github:lfapex/freehub2dsh
```

重启 dsh 后，模型选择器出现 **Free Model Hub** 分组。在 hub 的设置页
（`http://127.0.0.1:8331/`）登录白嫖渠道、添加中转站后，模型最多 5 分钟自动
进入选择器；选择器的"检测模型"也会立即重拉。

## 零配置

本机运行 hub 时**无需任何配置**：

- **密钥**自动从 `~/.free-model-hub/hub/settings.json` 读取（只读，绝不回写）；
- **daemon 未运行时自动从 PATH 拉起** `free-model-hub`（detached 进程，
  与 dsh 解耦——关掉 dsh，hub 与 Copilot 侧照常工作）；
- 插件每 5 分钟轮询 `/hub-models`，清单跟随 hub 实时变化。

手动覆盖（仅在 hub 不在本机或改过端口时需要），二选一：

- dsh 插件设置项：`hubBaseUrl` / `hubKey`；
- 或写文件 `<DSH_HOME>/freehub2dsh/endpoint.json`：
  `{ "baseUrl": "http://127.0.0.1:8330", "key": "…" }`

## 它做什么 / 不做什么

| 做 | 不做 |
| --- | --- |
| 把 hub 清单注册进选择器（含思考档位菜单） | 不接触任何上游车道 |
| 每轮对话代理到 hub 的 `/v1/chat/completions`（SSE → dsh chunks） | 不存储凭据（最多读 hub 的密钥文件） |
| daemon 未运行时自动拉起 | 不做任何设置——设置全部在 hub 的 8331 页面 |

## 自测

```sh
node --test scripts/smoke.test.mjs
```

覆盖：端点解析三级优先、密钥文件缺失降级、SSE 分帧、错误路径（hub 未运行时
的指引信息）。

# 番茄小说网页阅读增强

在浏览器中直接阅读番茄小说网页版的完整正文，无需安装客户端，无需登录账号。

网页端默认仅放出部分章节，其余内容由「扫码下载 APP」浮层遮挡。本脚本补齐这部分正文并移除遮挡层。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey
2. 打开 [fanqie-web-free-reader.user.js](./fanqie-web-free-reader.user.js)
3. 点击「Raw」，脚本管理器将弹出安装页，确认安装

也可在脚本管理器中新建脚本，粘贴文件全部内容后保存。

## 使用

打开番茄小说任意章节页，地址形如：

```
https://fanqienovel.com/reader/*
```

脚本将自动以完整正文替换页面内容，并隐藏付费遮挡层。首次运行需注册匿名设备（约数秒），结果缓存在脚本管理器存储中，后续不再重复注册。

## 技术路线

### 数据获取方式

脚本以番茄 Android 客户端身份请求其正文接口获取明文：

```
打开章节页
   ↓
从 URL 提取章节 ID
   ↓
存在缓存设备？──否──→ 注册匿名设备（4 个接口）→ 缓存
   │是
   ↓
携带请求签名调用正文接口（x-argus / x-ladon / x-khronos / x-ss-req-ticket）
   ↓
取得 base64 密文 → AES-128-CBC 解密 → 按需解压 gzip
   ↓
按块级标签拆分为段落，渲染至页面，隐藏遮挡层
```

关键实现：

- **匿名设备**：依次调用 `device_register` → `app_alert_check` → `privilege/add` → `crypt/registerkey`，取得 `device_id` 与 16 字节正文密钥并缓存。不涉及用户账号，不执行登录。
- **请求签名**：`x-argus`（protobuf → PKCS7 → Simon → 分帧 → AES-CBC）、`x-ladon`（34 轮 ARX 分组密码）、`x-khronos`、`x-ss-req-ticket`。缺少签名时接口返回 200 但响应体为空。
- **正文解密**：格式为 `base64(iv[16] || AES-128-CBC(pkcs7(plaintext)))`，明文可能为 gzip，按魔数 `0x1f 0x8b` 判定。
- **`novel_text_type=0`**：该参数为必需项。缺省时上游会在正文前附加 `<h1 class="chapterTitle1">` 章节标题节点，解析后与首段合并为一行，表现为标题混入正文。

签名与设备注册算法移植自 [fqapp](https://github.com/ch6vip/fqapp) 的 Rust 实现。

### 正文接口

客户端提供两个正文接口，返回内容一致（同一章节实测逐字节相同），差异仅在于协议形态与批量能力：


| 接口         | 地址                                                              | 说明                                                                                                           |
| ------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `full`       | `reading.snssdk.com/reading/reader/full/v/`                       | 单章接口，参数`item_id`。正文位于 `data.content`，标题位于 `data.title`。默认使用                              |
| `batch_full` | `api5-normal-sinfonlineb.fqnovel.com/reading/reader/batch_full/v` | 批量接口，参数`item_ids`（逗号分隔，单次可达数十章）。响应为 `{ itemId: { content, title, novel_data, ... } }` |

两者共用同一匿名设备身份与同一套签名头。

### 切换正文接口

页面右下角固定一个设置面板，通过下拉框在 `full（单章）` 与 `batch_full（批量）` 之间切换，选择后当前章节立即重新加载，选择结果持久化保存。

面板挂在 `document.body` 下，不进入 `#app`，因此不受 React 渲染树影响；章节切换或整块替换阅读区后仍会保留。

任一接口失败时自动回退至另一接口。

### 单页应用适配

番茄阅读器为单页应用，目录跳转与上一页/下一页均不触发页面重载。脚本采用 `MutationObserver` 配合 800ms URL 轮询检测章节切换。

**关键约束：不得删除或改写阅读区内由 React 管理的节点。**

章节切换时，React 依据自身虚拟 DOM 对 `<p>` 与遮挡层执行 `removeChild`。若这些节点已被脚本移除，将抛出：

```
NotFoundError: Failed to execute 'removeChild' on 'Node':
The node to be removed is not a child of this node.
```

该异常由 error boundary 捕获后卸载整个 `#app`，页面变为空白。刷新页面可恢复，因为刷新为全新挂载，React 虚拟 DOM 与真实 DOM 重新对齐。

因此脚本不删除任何节点，仅执行两项操作：

- 以 CSS `display: none` 隐藏原始正文与遮挡层，节点保留在 DOM 中
- 在独立创建的 `#fq-reader-body` 容器内渲染正文

## 常见问题

**脚本未生效**

打开开发者工具（F12）检查控制台是否存在 `[番茄阅读]` 前缀的日志。若无输出，确认脚本管理器已启用该脚本且允许在当前域名运行。

**提示「正文接口返回空响应」**

签名被拒绝或设备身份失效。打开脚本管理器菜单，点击「清除设备缓存（重新注册）」即可，脚本会立即以新设备重新拉取当前章节。

也可在控制台执行 `__fanqieReset()` 后刷新页面。

**是否会导致账号风险**

脚本使用匿名设备身份，不涉及用户账号，不执行登录。但请注意请求频率，避免触发风控。

## 调试接口

脚本管理器菜单提供「清除设备缓存（重新注册）」，等价于下列调用。

```js
__fanqieReset()              // 清除设备缓存，下次运行重新注册
__fanqieApi('full')          // 切换至单章接口
__fanqieApi('batch')         // 切换至批量接口
```

`__fanqieApi()` 与下拉框行为一致，会同步更新面板选中项。

## 免责声明

仅供个人阅读便利使用。请遵守番茄小说的服务条款，不得用于商业用途或大规模抓取。因使用本脚本产生的任何后果由使用者自行承担。

## 许可

[MIT](./LICENSE)

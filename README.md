# 番茄小说网页阅读增强

在浏览器中直接阅读番茄小说网页版的完整正文，无需安装客户端，无需登录账号。

网页端默认仅放出部分章节，其余内容由「扫码下载 APP」浮层遮挡。本脚本补齐这部分正文并移除遮挡层。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey
2. 点击 [fanqie-web-free-reader.user.js](https://raw.githubusercontent.com/xyz18950377305/fanqie-web-free-reader/main/fanqie-web-free-reader.user.js)，脚本管理器将弹出安装页，确认安装

## 使用

打开番茄小说任意章节页，地址形如：

```
https://fanqienovel.com/reader/*
```

脚本将自动以完整正文替换页面内容，并隐藏付费遮挡层。首次运行需注册匿名设备（约数秒），结果缓存在脚本管理器存储中，后续不再重复注册。

## 技术路线

### 运行流程

脚本以番茄 Android 客户端身份请求正文接口获取明文。一次完整运行的路径：

```
页面加载 / 章节切换
   ↓
从 URL 提取章节 ID（/reader/<itemId>）
   ↓
读取缓存的匿名设备 ──无──→ 设备注册→ 写入缓存
   │有
   ↓
按设置选择正文接口（默认 full），拼装 query
   ↓
生成签名头（x-argus / x-ladon / x-khronos / x-ss-req-ticket）
   ↓
请求正文接口 → 得到 base64 密文
   ↓
AES-128-CBC 解密（IV 取密文前 16 字节）→ 按魔数判定是否 gzip → 解压
   ↓
按块级标签拆成段落 → 渲染进 #fq-reader-body → 隐藏原正文与遮挡层
```

正文接口出错时换另一个接口重试一次；仍失败则保留原页面，只在控制台打印 `[番茄阅读]` 日志。

### 设备注册

首次运行需要一段匿名设备注册：

| #   | 系统                                       | 接口                              | 作用                            | 失败影响      |
| --- | ---------------------------------------- | ------------------------------- | ----------------------------- | --------- |
| 1   | 设备注册 `log.snssdk.com`                    | `service/2/device_register/`    | 申请 `device_id` 与 `install_id` | 致命，流程终止   |
| 2   | 渠道校验 `ichannel.snssdk.com`               | `service/2/app_alert_check/`    | 上报设备存活                        | 可忽略       |
| 3   | 权限 `api5-normal-sinfonlinea.fqnovel.com` | `reading/user/privilege/add/v/` | 授予 30 天阅读权限                   | 可忽略       |
| 4   | 密钥 `reading.snssdk.com`                  | `reading/crypt/registerkey`     | 换取 16 字节正文密钥                  | 致命，重试 3 次 |

**系统 1 · 设备注册。** 构造一份完整的 Android 设备档案（机型、分辨率、DPI、ROM、MAC、时区等），JSON 序列化后 gzip，再经 `tt_encrypt` 加密作为请求体——以 SHA-512 派生 AES 密钥与 IV，前置魔数 `74 63 05 10 00 00` 与 32 字节随机数。响应中的 `device_id_str` / `install_id_str` 成为后续所有请求的身份。

**系统 2 · 渠道校验。** 携带系统 1 得到的 `device_id` 与 `install_id` 上报一次。脚本对其进行了容错：异常不阻断流程。

**系统 3 · 权限与密钥。** `privilege/add` 提交固定 JSON（`amount` 为 2592000 秒即 30 天，配固定 `privilege_id`），同样失败可忽略。真正的关键在 `crypt/registerkey`：把 `device_id` 按字节反转后 AES 加密作为请求体，响应中的 `data.key` 再用主密钥解出 16 字节正文密钥，脚本内以 32 位大写十六进制保存。该接口内部最多重试 3 次、间隔 1 秒。

注册结果（`deviceId` / `installId` / `secretKey`）缓存在脚本管理器存储的 `fanqie_device_v1` 下，后续运行直接复用。不涉及用户账号，不执行登录。

### 请求签名

两个正文接口共用同一套签名头。缺少任一个，上游都返回 HTTP 200 但响应体为空：

| 头                 | 构造                                                      |
| ----------------- | ------------------------------------------------------- |
| `x-khronos`       | 当前 Unix 秒                                               |
| `x-ss-req-ticket` | 同一时间戳 × 1000（毫秒）                                        |
| `x-ladon`         | 34 轮 ARX 分组密码，输入 `ts-licenseId-aid`                     |
| `x-argus`         | protobuf bean → PKCS7 → Simon → 分帧异或 → AES-CBC → base64 |

`x-argus` 的 protobuf 中第 14 个字段是 **query string 的 SM3 前 6 字节**。因此参数顺序或参数集合与签名时不一致即签名失败——脚本中签名与发送复用同一个字符串；手工构造 URL 时务必保持一致。

签名与设备注册算法移植自 [fqapp](https://github.com/ch6vip/fqapp) 的 Rust 实现。

### 正文接口

客户端提供两个正文接口。**同一章节、同一设备下，两者取回的正文逐字节相同**，差异只在协议形态与批量能力：

|       | `full`                    | `batch_full`                          |
| ----- | ------------------------- | ------------------------------------- |
| 主机    | `reading.snssdk.com`      | `api5-normal-sinfonlineb.fqnovel.com` |
| 路径    | `/reading/reader/full/v/` | `/reading/reader/batch_full/v`        |
| 章节参数  | `item_id`（单数）             | `item_ids`（复数，逗号分隔）                   |
| 特有参数  | 无                         | `book_id=0`、`req_type=1`              |
| 单次章数  | 1                         | 实测 1 / 2 / 3 章均正常返回，未测试上限             |
| 正文位置  | `data.content`            | `data[itemId].content`                |
| 标题位置  | `data.title`              | `data[itemId].title`                  |
| 脚本内默认 | 是                         | 需手动切换                                 |

两者共用同一匿名设备身份与同一套签名头。

#### 请求与解析的分别处理

两个接口虽然内容等价，但请求拼装和响应解析走的是两条独立代码路径：

**`full`（单章）**

- 拼装：9 个公共参数 + `item_id=<章节ID>`
- 解析：正文直接取 `data.content`，标题取 `data.title`
- 判错：`data.content` 为空即抛错

**`batch_full`（批量）**

- 拼装：9 个公共参数 + `book_id=0` + `item_ids=<章节ID>` + `req_type=1`
- 解析：响应是 `{ itemId: {...} }` 字典，需先按 `itemId` 取出子对象，再读 `content` / `title`
- 判错：先查子对象 `code !== 0`，再查 `content` 是否为空

解密环节两者完全一致：`base64(iv[16] || AES-128-CBC(pkcs7(明文)))`，解出后若前两字节为 `0x1f 0x8b` 则按 gzip 解压。

> **说明**：脚本每次请求 `item_ids` 中只包含当前章节 ID，未使用批量接口的多章能力。预加载的实现见下节「预加载下一章」。

#### 公共参数

| 参数                | 值          | 说明                                     |
| ----------------- | ---------- | -------------------------------------- |
| `aid`             | `1967`     | 应用 ID                                  |
| `app_name`        | `novelapp` | 应用名（设备注册用的是 `novel`，两者不同）              |
| `channel`         | `0`        | 官方渠道                                   |
| `device_platform` | `android`  | 决定服务端按 Android 协议解析                    |
| `device_id`       | 缓存值        | 核心身份，服务端据此定位解密密钥                       |
| `device_type`     | `Honor10`  | 机型串，沿用真实客户端抓包值                         |
| `os_version`      | `0`        | 客户端确实发 `0`                             |
| `version_code`    | `66.9`     | 注意是字符串 `66.9`，与其他接口的 `6.1.5.32` 不同     |
| `novel_text_type` | `0`        | 控制正文包装形态，`1` 或省略时带 XML 声明与 `<h1>` 标题节点 |

### 预加载下一章

页面右下角面板在接口下拉框下方提供一个「提前加载下一章」开关，默认关闭，选择结果持久化保存。

开启后，脚本在渲染完当前章节后立即取回下一章并缓存。切到下一章时直接命中缓存、不再发起请求，同时接力预取再下一章，形成连续预取链。

**下一章 ID 的来源**：两个接口的响应中都含 `novel_data.next_item_id`，无需额外查询目录接口。

| 接口           | 预加载方式         | 请求增量   |
| ------------ | ------------- | ------ |
| `full`       | 单独发一次单章请求取下一章 | +1 次请求 |
| `batch_full` | 单独发一次批量请求取下一章 | +1 次请求 |

**两种接口的预加载机制相同**：都是在拿到当前章响应、从 `novel_data.next_item_id` 读到下一章 ID 后，再单独发一次请求取回下一章。区别只在用哪个接口发这个请求，请求次数一致。

`batch_full` 的 `item_ids` 每次只包含一个章节 ID，未使用批量接口的多章能力。

> **为何不能一次取两章**：下一章 ID 只出现在当前章的响应里，发请求时未拿到。若想真正批量取多章，需先通过目录接口`/api/reader/directory/detail?bookId=`拿到全书章节列表，脚本当前暂未实现。

缓存最多保留最近 3 章，避免长时间阅读后无限增长。切换接口、关闭开关、执行 `__fanqieReset()` 都会清空缓存。

预加载失败不影响当前章节显示，仅在控制台提示，切章时按需重新加载。

### 切换正文接口

页面右下角固定一个设置面板，含两行控件：

- 第一下拉框：在 `full（单章）` 与 `batch_full（批量）` 之间切换，选择后当前章节立即重新加载
- 第二行开关：「提前加载下一章」

选择结果持久化保存在 `fanqie_settings_v1`。

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
__fanqiePrefetch(true)       // 开启提前加载下一章
__fanqiePrefetch(false)      // 关闭提前加载下一章
```

## 免责声明

仅供个人阅读便利使用。请遵守番茄小说的服务条款，不得用于商业用途或大规模抓取。因使用本脚本产生的任何后果由使用者自行承担。

## 许可

[MIT](./LICENSE)

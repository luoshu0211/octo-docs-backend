# Redis 鉴权配置与原理详解

本文对应 Octo Docs 后端的 Redis 鉴权改动，说明如何配置、连接时发生什么，以及为什么缓存、协作和事件订阅必须一起接入。

核心变化是：**让 Docs 后端携带完整的连接信息和身份凭据访问 Redis，并确保各条连接使用同一套配置。**

大白话讲：以前后端只知道 Redis 的“地址和门牌号”，现在还支持“用户名、密码、加密通道，以及进去后使用哪个数据库”。

## 1. 实际需要配置什么

配置取决于 Redis 服务端已经开启了什么功能。以下变量只是让后端使用对应凭据，**不会替 Redis 创建用户、设置密码或开启 TLS**。

### 1.1 已经配置 host 和 port，只需要补密码

```dotenv
REDIS_URL=
REDIS_HOST=redis.internal
REDIS_PORT=6379
REDIS_PASSWORD=your-password
```

`your-password` 是示例占位值，需要替换成实际密码。真实凭据通过部署环境或 Secret 注入，不写入仓库。

`REDIS_URL` 留空，表示使用分项配置。如果 Redis 使用具名账号，再增加：

```dotenv
REDIS_USERNAME=docs-user
```

### 1.2 使用完整连接串

只有密码：

```dotenv
REDIS_URL=redis://:your-password@redis.internal:6379/0
REDIS_PREFIX=octo-docs
```

同时有用户名和密码：

```dotenv
REDIS_URL=redis://docs-user:your-password@redis.internal:6379/0
REDIS_PREFIX=octo-docs
```

Redis 开启 TLS：

```dotenv
REDIS_URL=rediss://docs-user:your-password@redis.internal:6379/0
REDIS_PREFIX=octo-docs
```

`rediss` 最后多一个 `s`。端口填写 Redis 实际提供的端口；开启 TLS 不代表一定要换成某个固定端口。

IPv6 地址在 URL 中使用方括号：

```dotenv
REDIS_URL=redis://:your-password@[::1]:6379/0
```

### 1.3 变量对照表

| 变量 | 含义 | 默认值 |
| --- | --- | --- |
| `REDIS_URL` | 完整 Redis 连接串 | 未设置 |
| `REDIS_HOST` | Redis 主机地址 | `127.0.0.1` |
| `REDIS_PORT` | Redis 监听端口 | `6379` |
| `REDIS_USERNAME` | Redis ACL 用户名 | 未设置 |
| `REDIS_PASSWORD` | Redis 密码 | 未设置 |
| `REDIS_DB` | 使用哪个逻辑数据库 | `0` |
| `REDIS_TLS` | 是否使用 TLS 加密连接 | `false` |
| `REDIS_PREFIX` | 业务 key 和消息频道的前缀 | `octo-docs` |

原来不需要密码的部署，继续使用原有 host、port 配置即可。

分项模式下，`REDIS_TLS` 接受 `true/false/1/0`，大小写不敏感。端口必须是 `1..65535` 的十进制整数；DB 必须是非负安全整数，实际可用编号由 Redis 服务端决定。填写用户名时必须同时提供非空密码。

## 2. 连接串每一部分是什么意思

以这条连接串为例：

```text
rediss://docs-user:your-password@redis.internal:6379/0
```

| 部分 | 技术含义 | 大白话 |
| --- | --- | --- |
| `rediss://` | Redis 协议，并启用 TLS | 走加密通道 |
| `docs-user` | Redis 用户名 | 用哪个账号进去 |
| `your-password` | 账号密码 | 证明你有这个账号 |
| `redis.internal` | 主机名 | 去哪里 |
| `6379` | 端口 | 敲哪扇门 |
| `/0` | 数据库编号 | 进去后使用哪个抽屉 |

连接串把几项配置写在一起。程序最终仍然会把它拆成 host、port、username、password 等参数，再交给 Redis 客户端。

连接串省略端口或 DB 时，分别使用 `6379` 和 `0`。当前配置不接受 query、fragment、额外路径段、原始空白或控制字符；不支持通过这套变量配置 Sentinel、Cluster、Unix socket 或 mTLS。

## 3. 两种配置方式如何确定优先级

**只要 `REDIS_URL` 非空，连接参数全部以 URL 为准。**

例如：

```dotenv
REDIS_URL=redis://redis.internal:6379/0
REDIS_PASSWORD=some-password
```

最终不会发送密码，因为 URL 本身没有密码，而下面的 `REDIS_PASSWORD` 已被忽略。

规则是：

1. `REDIS_URL` 未设置或为空字符串：使用分项配置。
2. `REDIS_URL` 非空：host、port、username、password、DB、TLS 全部来自 URL。
3. `REDIS_PREFIX` 始终独立生效。
4. URL 格式错误直接报错，不回退到分项配置；只有空白字符的 URL 也属于错误。

这样可以避免不小心组合出“新 Redis 地址加旧 Redis 密码”。选择一种方式完整填写即可。

## 4. Redis 鉴权到底在做什么

建立 TCP 连接，只能说明网络通了，并不说明允许使用 Redis。

客户端连接后，会根据配置进行身份验证。下面是协议层的大致交互，凭据由客户端库传递：

```text
只有密码：
AUTH password

有用户名和密码：
AUTH username password
```

Redis 检查凭据，成功后才允许执行被授权的操作。

传统密码配置可以理解成“共用一把门钥匙”。Redis 6 及以上支持的 **ACL（访问控制列表）**，则可以给不同服务分配不同账号，并限制每个账号的权限。

例如，Docs 后端的账号可以被配置为：

- 允许读写 Docs 使用的 key。
- 允许发布和订阅 Docs 使用的消息频道。
- 允许执行协作锁需要的脚本。
- 禁止访问其他应用的数据。

因此，**密码正确和权限足够是两回事**。账号可能登录成功，但不能订阅频道，或者不能执行锁脚本，应用仍然会出问题。

配置 ACL 时，需要同时核对命令权限、key 模式和 channel 模式。只验证 AUTH 成功还不够，必须验证实际业务所需的读写、订阅和脚本操作。

这里的凭据属于“Docs 后端访问 Redis”的身份；用户登录 Octo、访问文档的权限属于另一层。此次改动不改变文档访问权限。

## 5. 密码鉴权和 TLS 有什么区别

密码鉴权解决的是：Redis 如何判断客户端是谁、是否允许访问。

TLS 解决的是：连接过程中的信息是否被加密，以及客户端连接到的服务器身份是否可信。

大白话讲：**密码像门禁卡，TLS 像受保护的运送通道。门禁卡本身不会让运送过程自动保密。**

只配置密码，不会自动加密网络上的 Redis 通信。使用 `rediss://` 或分项 `REDIS_TLS=true` 才会启用 TLS。

当前实现会校验服务器证书。使用 DNS 地址时设置相应 SNI；使用 IP 地址时，证书需要包含匹配的 IP 身份信息。

使用内部 CA 签发的证书时，可以在 Node 进程启动前配置：

```dotenv
NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem
```

这样 Node 才会信任对应的内部 CA。这次没有提供“忽略证书错误”的开关。

## 6. 为什么增加密码需要修改好几个地方

这个后端有四条主要 Redis 连接：

| 连接 | 用途 |
| --- | --- |
| 共享命令连接 | 缓存、注册表、ticket、业务读写等 |
| Hocuspocus 发布连接 | 发布协作消息，并执行协作锁操作 |
| Hocuspocus 订阅连接 | 接收其他实例的协作消息 |
| 应用事件订阅连接 | 接收权限失效、评论、PPT 房间等事件 |

可以理解成后端派了四个人去 Redis 办事：有人查资料，有人发通知，有人收通知。

**四个人都需要自己的连接，也都必须带上正确凭据。**只给其中一个人配密码，会出现某些接口正常，但协作同步或事件通知异常的情况。

这次将流程统一为：

```mermaid
flowchart TD
    A["环境变量或 REDIS_URL"] --> B["统一解析和校验"]
    B --> C["共享命令连接"]
    B --> D["协作发布连接"]
    B --> E["协作订阅连接"]
    B --> F["应用事件订阅连接"]
    C --> G["Redis"]
    D --> G
    E --> G
    F --> G
```

如果阅读器不支持 Mermaid，上图表示：一份配置经过统一解析后，分别用于创建四条独立连接，四条连接都访问同一个 Redis。

**共享的是配置，连接仍然各自独立。**订阅连接进入订阅模式后，需要专门接收消息，不能直接当作普通读写连接使用。

## 7. DB 和 prefix 有什么区别

`REDIS_DB=2` 可以理解成使用“第 2 号抽屉”，用来区分 Redis 中的 key。

`REDIS_PREFIX=octo-docs` 则像给 key 和消息频道加上统一的业务标识。示意如下：

```text
octo-docs:某个业务key
octo-docs:某个事件频道
```

关键区别是：**Redis 普通 Pub/Sub 消息不会按 DB 编号隔离。**

大白话讲，数据放在不同抽屉里，但消息仍然通过同一套广播系统传播。测试环境用 DB 0、生产环境用 DB 1，不能保证两个环境的广播互不影响；还需要不同的频道前缀，或者使用独立 Redis 实例。

同一服务的所有实例，应使用一致的 Redis 地址、DB 和 prefix。已有部署此次接入鉴权时，应保持原来的 DB 和 prefix，避免同时改变数据与消息的命名空间。

实现过程中还发现，Hocuspocus 内部的锁库会独立选择 DB，默认是 0。因此，扩展创建时也同步设置了锁库的 DB，确保业务读写和协作锁使用预期数据库。

## 8. 后端启动时发生了什么

启动流程是：

1. 加载环境变量。
2. 解析连接串或分项配置，检查格式。
3. 为四条连接生成一致的连接参数。
4. 建立连接，由客户端进行鉴权及初始化。
5. 对配置的凭据再做显式验证，并确认事件订阅成功。
6. 通过检查后，才启动对外的 HTTP 和 WebSocket 服务。

Redis 初始化阶段有 **10 秒上限**。连接被拒绝等临时 TCP、DNS 或 socket 错误会在这个窗口内交给 ioredis 重试；`SELECT` 等 Redis 初始化命令失败，以及密码、ACL 权限或 TLS 证书错误，都不会因重试恢复，因此会立即失败。这不是整个进程的启动时限，也不包含之前的 MySQL 检查。

密码错误、TLS 错误、订阅权限不足等情况会让启动失败，并关闭这些新建连接，避免服务端口已经起来，但 Redis 的关键连接实际上不可用。

额外做一次显式鉴权，是因为 ioredis 存在一个兼容行为：客户端提供了密码，但服务器根本没配置密码时，它可能只警告后继续连接。当前实现让这种配置不一致明确失败。

启动成功证明连接和事件订阅就绪，不代表所有业务命令都已验证授权。`/healthz` 仍是存活检查，不能据此判断所有 Redis 业务都正常。

运行之后，普通重连策略保持原样，连接恢复时客户端会重新进行连接初始化和订阅。配置在进程启动时读取，修改密码或 URL 后需要重启后端实例。

## 9. 密码里有特殊字符怎么办

密码放进 URL 时，特殊字符需要进行 URL 编码。

例如，真实密码为：

```text
p@ss:/#%
```

在 URL 中应写成：

```text
p%40ss%3A%2F%23%25
```

因为 `@`、`/`、`#` 等字符在 URL 中本来有分隔含义。编码是为了让解析器知道这些字符属于密码。

只对用户名和密码字段编码，不对整条连接串编码；程序会解码一次。**URL 编码不等于加密。**

使用分项变量时，`REDIS_PASSWORD` 填写原始密码，不需要 URL 编码。密码中的合法空格会保留。

## 10. 这次代码如何落地

| 文件 | 职责 |
| --- | --- |
| `src/config/redis.ts` | 解析和校验 URL、分项配置 |
| `src/config/env.ts` | 集中读取环境变量 |
| `src/db/redisOptions.ts` | 生成统一的 Redis 连接参数 |
| `src/db/redis.ts` | 创建共享命令连接和应用事件订阅连接 |
| `src/collab/redis.ts` | 创建协作发布、订阅连接，并同步锁库 DB |
| `src/db/redisLifecycle.ts` | 安全错误日志、启动就绪检查和失败清理 |
| `src/index.ts` | 将启动检查接入服务启动流程 |

Hocuspocus 使用公开的 `createClient` 接口创建两条连接，直接传入统一解析后的参数。这样可以避免扩展内部旧版 ioredis 将 IPv6 地址误解析成 URL 或 Unix socket 路径。连接仍由 Hocuspocus 管理，依赖版本没有升级。

错误日志只输出连接用途和固定错误分类，不打印完整 URL、密码或 AUTH 命令参数。鉴权错误还可能被传给正在等待的业务命令，因此也处理了这条错误传播路径中的凭据脱敏。

## 11. 如何应用配置和发布

如果已有 `REDIS_HOST` 和 `REDIS_PORT`，补上 `REDIS_PASSWORD` 最直观；如果平台提供完整连接串，就使用 `REDIS_URL`。

用户名、密码、TLS 是否开启，以及端口是多少，都以 Redis 服务端实际提供的信息为准。

配置应注入运行后端的进程或容器。在使用 `env_file` 的部署中，更新对应环境文件后重新创建后端容器；只修改宿主机文件不会自动改变已经运行的进程环境。显式列举环境变量的部署模板，需要把新变量传入后端。

给现有匿名 Redis 开启鉴权时，建议按以下顺序推进：

1. 先让所有后端实例升级到支持新配置的版本。
2. 准备 Redis 账号与对应权限。
3. 注入新的 URL 或分项配置，重启后端实例。
4. 验证四条连接及跨实例协作、权限、评论和 PPT 事件。
5. 确认全部实例使用新身份后，再关闭旧的匿名访问。

Redis 6+ ACL 可以使用账号重叠的方式过渡。只能通过 `requirepass` 切换、无法保留过渡身份的场景，需要协调维护窗口。

Redis 已强制鉴权后，不支持这些配置的旧版后端将无法连接。因此回滚要选择仍支持鉴权的版本，或者另行协调 Redis 访问策略。仅回滚镜像不保证恢复服务。

## 12. 验证结果与边界

以下为本次实现截至 2026-09-14 的验证记录，不代表后续代码或部署状态：

- 完整测试：261 个测试文件通过，3940 项测试通过，29 项按条件跳过。
- 单独启用的真实 Redis 集成测试：11 项通过，覆盖无鉴权、密码、ACL、TLS、IPv6、DB 与锁、重连及双实例协作同步。
- 类型检查、lint、构建和差异格式检查通过。
- 独立 Codex review 已完成，未发现需要修复的明确缺陷。评审独立执行了 55 项 Redis 单元测试及类型、lint、差异检查；评审本身受只读环境限制，未重跑真实 Redis/TLS 集成测试。

后续已完成独立 Docker 环境的真实 MySQL＋ACL Redis＋双后端＋浏览器验收，并额外启用真实 MySQL 集群测试（4 项通过）。部署组成、实际结果和未通过的既有画板恢复场景见第 15 节。前述 11 项 Redis 集成测试的持久化仍使用内存模拟，不能与后续整套部署验收混为一谈。

本文更新时，改动已部署到本地隔离验收环境；代码尚未提交、推送，未部署到 `dmwork-test` 或生产。

更精简的运维配置与测试命令见 [Redis configuration](redis-configuration.md)。

## 13. 会影响哪些功能，回归测到什么程度

**这是后端共享基础设施的改动，影响范围覆盖所有 Redis 使用方。**业务算法和用户／文档权限规则没有修改，但连接地址、凭据、DB、prefix 或 ACL 配置错误，可能间接影响依赖它们的功能。

下面根据实际 `getRedis()`、`rkey()` 和协作扩展调用点列出范围。证据包括完整回归日志及第 15 节的真实部署验收；下面分别说明覆盖范围。

| 功能范围 | Redis 在其中的作用 | 配置异常时可能出现什么 | 本次回归证据及边界 |
| --- | --- | --- | --- |
| Docs／Sheet／Board 实时协作 | Hocuspocus 发布、订阅与保存锁 | 跨实例同步中断、协作保存失败 | 真实部署下 Doc 双浏览器双向编辑通过；Sheet 两端键盘编辑与对端后端读取通过；Board 跨节点绘制、保存与冷打开通过。两端使用同一真实账号，不能称为两个独立用户；画板在线版本恢复存在基线也能复现的失败，见 15.4 |
| 权限失效与连接注册 | permission epoch 缓存、失效广播、连接登记／清理 | 缓存或注册操作失败，跨实例权限变更通知可能受阻 | `epoch.test.ts` 5 项等既有测试通过；本地真实双后端 PPT 浏览器验证邀请、降为 reader、重连及撤权通过。账号相同、Space 不同且成员身份真实验证；真实 MySQL 集群测试另外覆盖连接租约过期。尚未在 Kubernetes Pod 上验收 |
| 评论事件通知 | 发布评论变更，向协作连接广播刷新消息 | 评论通知不能及时到达其他实例 | `commentEvents.test.ts` 3 项、`comments.test.ts` 52 项通过；真实部署中 A 创建 Doc 评论，B 浏览器收到 comment 事件，B API 可读；普通文档评论回复／解决通过。未向聊天系统发送通知 |
| PPT 协作与一次性 ticket | 房间变更／presence 事件、ticket 防重复使用 | 跨实例更新／在线状态传播失败，ticket 操作可能失败 | 既有 relay／token 测试通过；真实双后端浏览器验证新建页、标题与文本协作、丢确认重连、继续编辑和冷恢复通过；真实 MySQL＋Redis 双进程测试 4 项通过，含丢广播与节点退出。浏览器走真实 ticket；没有单独在浏览器重复消费同一 ticket |
| 自动快照与版本历史 | 空闲快照、最小间隔快照的去重锁 | 自动快照生成延迟、失败或去重行为异常 | `autoSnapshot.test.ts` 13 项通过；本地启用自动快照，已核验 MySQL 中 kind=1 的自动快照记录；命名快照与 Doc 恢复通过。没有做大并发下快照去重频次压力验收 |
| 文档压缩与超限保护 | 节点心跳、文档持有者、压缩锁、压缩通知与超限标记 | 集群协调和保护标记不可用，压缩或恢复行为受影响 | `compactionCluster.test.ts` 17 项、`compactionNotice.test.ts` 22 项、`oversizeGuard.test.ts` 25 项、`persistenceOversizeGuard.test.ts` 8 项通过；Redis 多为内存替身，未做真实集群故障／恢复演练 |
| 链接预览卡片 | Open Graph 结果缓存 | 缓存读写失败，可能增加回源或触发该路径的错误处理 | `linkCard.test.ts` 6 项通过，Redis 被模拟；未在测试环境点击真实链接做浏览器回归 |
| 整个 Docs 后端实例的启动 | 四条 Redis 连接就绪、鉴权与事件订阅检查 | Redis 初始化失败时，本实例的 HTTP／WS 端口不会开放 | 真实完整后端 ACL 启动、旧无密码分项配置启动通过；每节点 4 条 Redis TCP 连接；错误密码进程退出码 1，HTTP／WS 未开放，日志不含凭据。尚未在 `dmwork-test` 验证探针与滚动更新 |

### 13.1 哪些行为确实发生了变化

- 新增配置开始生效：过去未读取的 `REDIS_URL`、用户名、密码、DB、TLS 变量，现在会影响连接。若某个部署以前留有这些变量但以为它们无效，升级前必须检查。
- 启动检查更完整：过去启动已经等待事件订阅，现在进一步要求共享命令连接及协作 pub/sub 全部就绪。共享命令连接初始化失败，也会阻止本实例开放端口。
- 格式校验更严格：错误端口、错误 URL、只有用户名没有密码等配置会直接失败。
- `.env` 加载移到了其他配置依赖之前，确保环境文件中的变量能够被配置模块读取。本次 `dmwork-test` 使用 Kubernetes 环境注入，未挂载配置文件卷。
- Hocuspocus 连接创建改用 `createClient`，修复旧客户端构造器解析 IPv6 的问题；锁库 DB 与连接 DB 同步。
- Redis 错误日志采用固定分类，鉴权错误中的凭据被移除；不能再依赖日志里的原始 AUTH 错误对象排查问题。

MySQL schema、文档内容格式、前端代码、业务权限判定，以及其他独立服务的 Redis 配置都未修改。不过，如果未来修改的是共享 Redis 服务端的鉴权策略，使用该 Redis 的其他服务也可能受影响；那属于额外的基础设施变更，需要先盘点调用方。

### 13.2 回归结论与发布前缺口

已完成的回归是：**全量 3940 项测试通过，另有 11 项真实 Redis 集成测试通过，独立 review 无明确缺陷。**全量测试中的 29 项跳过包含默认关闭的 Redis 集成测试；上述 11 项是后来显式开启、单独运行并通过的结果。

当前证据支持“连接层实现与已有自动化回归未发现问题”。它不能支持“所有功能在真实测试环境均已验收通过”。发布前仍建议用新镜像验证：

1. 两个副本启动及探针正常，保持旧 host、DB、prefix 不变。
2. 两个浏览器连接分别落到不同 Pod，验证 Docs／Sheet／Board 的编辑同步、保存和刷新。
3. 验证撤权／降权、评论新增／删除通知，以及启用时的 PPT 房间更新与 ticket 流程。
4. 验证自动快照、压缩／超限保护及链接预览缓存路径。
5. 若实际启用鉴权，在相同 ACL 策略下验证上述路径；不能仅以 PING 或 AUTH 成功作为业务验收。

本节只是列明验收范围，没有在共享测试环境中创建文档、修改权限、切换 Redis 鉴权或部署新版本。

## 14. dmwork-test 当前配置与改动后对照

### 14.1 查询时间与证据来源

以下为 **2026-09-14 18:19（北京时间）** 的只读核查快照。之后的部署或配置变更可能使它过期。

| 项目 | 本次核查结果 |
| --- | --- |
| Kubernetes namespace | `dmwork-test` |
| Deployment | `octo-docs-backend-test`，generation `103` |
| 副本状态 | 期望 2 个，2 个 ready；两个 Pod 的容器重启次数均为 0 |
| 配置来源 | `envFrom` 引用 ConfigMap `octo-docs-backend-config-test` |
| ConfigMap resourceVersion | `100769198228` |
| prefix 来源 | Deployment 显式环境变量 `REDIS_PREFIX=octo-docs-test`，优先于 ConfigMap 同名项 |
| 配置文件卷 | Docs 容器未挂载 volume |
| 当前镜像 | `tbj7-xtiao-tcr1.tencentcloudcr.com/dmwork/octo-docs-backend@sha256:8970dd4130f405e4d9b2fec81fd252de0819a010b13c72acefc1c52ca6b43517` |

核对了两个运行中 Pod：

- `octo-docs-backend-test-6cb9885d75-hgh9t`
- `octo-docs-backend-test-6cb9885d75-nb6z9`

除了读取 Deployment 和 ConfigMap，还在两个容器内只读读取了 Redis 环境变量白名单，并加载了当前镜像的配置模块。两个容器结果一致：有效配置包含 `host`、`port`、`prefix`，尚未暴露新实现的 URL／鉴权／DB／TLS 配置字段。

另外，在第一个 Pod 内用一条临时、非 TLS、不发送 AUTH 的 Redis 连接执行了 `PING` 和当前连接的 `CLIENT INFO`：结果为 **`PONG`，DB 为 `0`**。连接随后关闭，没有读写业务 key。

这证明当前服务地址允许这种无鉴权连接方式。它不代表已盘点 Redis 服务端全部 ACL 用户，也不代表 Redis 不可能同时提供其他鉴权或 TLS 入口。

### 14.2 当前变量与升级后的兼容配置

**对于当前 `dmwork-test`，只升级这次后端代码，不要求新增或修改 Redis 环境变量。**

| 变量 | 当前 ConfigMap／Deployment／Pod 实际值 | 新代码上线、保持现有连接方式时 | 解释 |
| --- | --- | --- | --- |
| `REDIS_URL` | 未设置 | 继续不设置 | 保持分项模式 |
| `REDIS_HOST` | `octo-redis`，来自 ConfigMap | `octo-redis` | 继续使用当前服务 |
| `REDIS_PORT` | `6379`，来自 ConfigMap | `6379` | 端口保持不变 |
| `REDIS_USERNAME` | 未设置 | 继续不设置 | 当前路径不发送用户名 |
| `REDIS_PASSWORD` | 未设置 | 继续不设置 | 当前路径不发送 AUTH；无需凭空增加密码 |
| `REDIS_DB` | 未设置；当前只读连接确认使用 DB 0 | 不设置时默认为 `0` | 可以显式填写 `0`，不是必需 |
| `REDIS_TLS` | 未设置；当前只读连接使用非 TLS | 不设置时默认为 `false` | 当前连接方式保持不变 |
| `REDIS_PREFIX` | `octo-docs-test`，来自 Deployment；两个 Pod 一致 | `octo-docs-test` | 必须保留现有 key／频道命名空间 |
| `NODE_EXTRA_CA_CERTS` | 未设置 | 当前无需增加 | 只有接入需要额外 CA 的 TLS 服务时才考虑 |

当前有效连接可以概括为：

```dotenv
REDIS_HOST=octo-redis
REDIS_PORT=6379
REDIS_PREFIX=octo-docs-test
```

升级新代码后，推荐先保留以上三项，其余变量继续不设置。行为仍然是：**无用户名、无密码、非 TLS、DB 0，使用 `octo-docs-test` 前缀**。

这里的“保持兼容”指配置解释和连接方式；仍要通过新镜像部署后的启动及业务验收，才能确认运行结果。

### 14.3 如果只是希望改成 URL 格式

新代码支持下面的等价表达：

```dotenv
REDIS_URL=redis://octo-redis:6379/0
REDIS_PREFIX=octo-docs-test
```

它仍然不发送密码、不使用 TLS。原有 `REDIS_HOST` 和 `REDIS_PORT` 即使保留，也会被 URL 覆盖。

这只是配置表达方式的变化，不是开启鉴权。首次升级没有必要同时做这个切换。

### 14.4 如果之后确实要启用密码／ACL

下面是**待实施的示例，不是当前测试环境已有的配置，也未应用到集群**。用户名和密码必须先在 Redis 服务端准备好，再注入后端。

| 目标 | 后端连接串示例 | 服务端前提 |
| --- | --- | --- |
| 仅密码鉴权 | `redis://:ENCODED_PASSWORD@octo-redis:6379/0` | 当前入口接受对应密码 |
| ACL 用户名与密码 | `redis://docs-user:ENCODED_PASSWORD@octo-redis:6379/0` | 存在 `docs-user`，密码及命令／key／channel 权限正确 |
| ACL 加 TLS | `rediss://docs-user:ENCODED_PASSWORD@TLS_HOST:TLS_PORT/0` | 已有可用 TLS 入口及可信证书，地址和端口以实际配置为准 |

以上 `ENCODED_PASSWORD` 是 URL 编码后的密码占位符，不是实际值。所有方案均保留 `REDIS_PREFIX=octo-docs-test`。

分项方式同样可用：保留 host、port、prefix，额外注入 `REDIS_PASSWORD`；具名 ACL 账号再注入 `REDIS_USERNAME`。不要让一个不含凭据的 `REDIS_URL` 覆盖这些分项凭据。

### 14.5 Kubernetes 中凭据具体放在哪里

当前 Deployment 自动导入的是 **ConfigMap**，没有通过 `envFrom` 自动导入整个 Secret。现有 Secret 的部分键以单独的 `secretKeyRef` 注入，但尚未声明 Redis 凭据引用。

因此，**只往 Secret 里新增一个 `REDIS_PASSWORD` 或 `REDIS_URL` 键，并不会自动进入当前 Docs 容器**。启用鉴权时，除了准备 Secret，还需要在 Deployment 的 `env` 中声明对应引用。

以 URL 方式为例，计划增加的片段如下：

```yaml
env:
  - name: REDIS_URL
    valueFrom:
      secretKeyRef:
        name: octo-docs-backend-secret
        key: REDIS_URL
  - name: REDIS_PREFIX
    value: octo-docs-test
```

这只是新增／保留的环境变量片段，**不能替换完整的现有 `env` 列表**。真实 Secret 值不写入本文或仓库。

当前后端 CI 从本仓库 `manifests/deploy.yaml` 渲染 Deployment，再由部署仓库和 ArgoCD 同步。该模板明确不将 ConfigMap／Secret 纳入同步。因此实际启用鉴权时，应分别处理 Secret 的受控配置和 Deployment 的持久化引用，避免只修改在线 Deployment 后被下一次同步覆盖。

本次仅查询并记录当前配置、给出改动后对照，没有修改 ConfigMap、Secret、Deployment、Redis 服务端策略或运行镜像。

## 15. 本地真实部署验收（2026-09-14）

**结论：Redis 鉴权配置的本地部署核心验收通过；业务回归不是全部通过，画板在线版本恢复存在一个未修改基线同样能复现的既有问题。**

本次使用真实 MySQL、真实 Redis ACL、两个完整后端进程和 Chromium 浏览器。没有模拟 Redis、MySQL 或用户登录校验。验证只发生在本机，不代表 `dmwork-test` 已升级。

### 15.1 实际部署组成

| 项目 | 本次实际值 |
| --- | --- |
| 入口 A | `http://127.0.0.1:28085`，固定路由到后端 A |
| 入口 B | `http://127.0.0.1:28086`，固定路由到后端 B |
| 后端健康地址 | `http://127.0.0.1:4003/healthz`、`http://127.0.0.1:4004/healthz`，均返回 `200 {"ok":true}` |
| 后端源码 | 基线 `f3ec31e6329742afac1dc1f528276568993b7adb` 加本次未提交的 Redis 改动 |
| 部署源码指纹 | `895f1751fce6debe142f4898d07e1f2ec1f2d23bc3b5369e282582761667fde9` |
| 后端镜像 | `octo-docs-backend:redis-auth-895f1751` |
| 两个容器实际镜像 ID | `sha256:e012fb0a760bef49923fd41df033c4c1d51e80c4f24982f1223accd2d2de8acf` |
| 前端镜像 | 复用 `octo-web:ppt-common-a26111d3-latest-20260911`；该标签名称不表示本次更新了前端 |
| 前端组成 | host `8c1c3fa038ea3e406e912f4e7d76acaf910af80d`；Docs `a26111d3df4a6a65e9f4aa801e3e6e76d5bcd00e`；enterprise `055fe33e647cbaa15781ac7eb95429b7d052f658` |
| MySQL | 新建 `redis-auth-mysql`，MySQL 8，数据库 `redis_auth_acceptance`；执行 schema 及升级迁移 |
| Redis | 新建 `redis-auth-redis`，Redis 7.4.9，默认用户禁用；使用具名 ACL 用户 `docs` |
| 网络及数据隔离 | 新建 Docker 网络与 MySQL 卷；身份校验复用现有本地 Octo Server。原有业务容器 ID 未变化，原 MySQL／Redis 数据未修改 |

镜像从已有本地后端镜像派生，已核对基础镜像的 `package.json`、`package-lock.json` 与当前源码完全一致，再复制当前源码执行 TypeScript 构建。验收后逐文件核对了运行镜像构建输入与工作区源码，没有用旧后端二进制冒充本次改动。

两个前端入口的 API 和协作 WebSocket 分别固定到 A、B。两端同时成功编辑，才能证明跨节点链路可用；仅有两个浏览器窗口并不自动代表跨节点测试。

### 15.2 本地实际配置（凭据脱敏）

```dotenv
REDIS_URL=redis://docs:<URL_ENCODED_SECRET>@redis-auth-redis:6379/2
REDIS_PREFIX=octo-docs-redis-auth-acceptance
MYSQL_HOST=redis-auth-mysql
MYSQL_DATABASE=redis_auth_acceptance
AUTO_SNAPSHOT_ENABLED=true
AUTO_IDLE_MS=3000
AUTO_MIN_INTERVAL_MS=5000
```

Redis 用户规则：

```text
user default off
user docs on >SECRET ~octo-docs-redis-auth-acceptance:* &octo-docs-redis-auth-acceptance:* +@all -@admin
```

这是验收配置，`+@all -@admin` 不是生产最小权限清单。Redis 未向宿主机开放端口，验收实例关闭 RDB/AOF；MySQL 使用独立持久卷。两个后端使用相同签名密钥和 Redis prefix，但对外 WS 地址分别指向各自入口。

实际观测：

- 匿名 `PING` 返回 `NOAUTH Authentication required.`。
- 同配置连接返回 `PONG`，`CLIENT INFO` 显示 `user=docs`、`db=2`。
- 两个后端各有 **4 条**已建立的 Redis TCP 连接。
- 业务前缀 key 存在于 DB 2；同前缀在 DB 0 的 key 数为 **0**。
- 错误密码的独立完整后端容器退出码为 **1**，未出现 HTTP／Hocuspocus 开放监听日志；日志不含实际密码或错误密码。
- 新镜像配旧式 `REDIS_HOST`／`REDIS_PORT`、无 `REDIS_URL`、无密码，连接独立无鉴权 Redis，完整后端仍可启动并返回健康检查 200。

本套常驻浏览器验收部署使用 `redis://`。TLS、证书信任／主机名校验另由前述真实 Redis TLS 集成测试覆盖，不能称为这套浏览器环境也启用了 TLS。

### 15.3 真实业务验收结果

| 场景 | 实际验收与结果 |
| --- | --- |
| Doc 跨节点协作 | A 浏览器输入，B 实时显示；B 继续输入，A 实时显示：通过 |
| Doc 断网恢复 | A 离线期间 B 编辑，A 恢复网络后补齐内容：通过 |
| 评论广播 | A 创建评论，B 浏览器收到 comment 事件，B API 可读取；Doc 评论回复／解决：通过 |
| Sheet | A、B 浏览器分别用键盘编辑单元格，对端后端读取到值；真实 MySQL 命名快照包含两端内容：通过 |
| Board 基本协作 | A 绘制矩形，B 画面可见且对端 API 返回有效矩形；命名快照和新浏览器重新打开：通过 |
| Doc 版本恢复 | 保存命名版本、追加内容、恢复旧版本、浏览器重新打开，原文保留且后续文字消失：通过 |
| Board 在线版本恢复 | 删除矩形后恢复历史版本，再次打开时矩形仍标记为删除：失败；未修改基线同样失败，见 15.4 |
| PPT | 双节点标题同步、新增幻灯片、两端文本协作：通过 |
| PPT 丢确认与重连 | 浏览器收到确认前主动断开 WS，重连后同步并继续编辑；刷新保留两端文字：通过 |
| 实时降权与撤权 | 正常邀请进入另一已验证 Space；A 将 B 降为 reader，B 界面失去编辑能力且 HTTP 写入被拒；重连仍只读；A 撤权后 B 内容移除、重新访问被拒：通过 |
| 自动快照 | 启用后，在 MySQL `doc_version` 中观察到 `kind=1` 的记录；未做大并发去重压力验收 |
| 后端重启冷恢复 | 关闭验收浏览器、重启 A 和 B 两个后端，再用全新浏览器上下文分别打开 Doc／Sheet／Board／PPT，内容保留：四类均通过 |
| 真实数据库集群回归 | 单独数据库运行 `pptCanonicalId.mysql.test.ts`，启用 MySQL 和 cluster 开关：4 项通过，涵盖连接租约、公共评论／版本／恢复、跨进程同步、丢广播、节点退出、只读写入拒绝等 |

浏览器使用本地真实账号登录态。双窗口内容协作使用同一账号；跨权限验收使用同一账号在两个真实验证的 Space 中的不同文档成员身份，**不是两个独立用户账号**。没有向其他用户发送聊天或 Bot 通知。

冷恢复前记录了 MySQL `yjs_document`、`doc_version`、`ppt_live_snapshot` 的持久化信息及两个后端重启前后的启动时间。PPT 还会从数据库操作日志补齐初始快照之后的修改，因此不能只看 `ppt_live_snapshot.covered_seq` 判断有没有保存。最终浏览器冷打开读到了两端编辑结果。

### 15.4 已有缺陷及验收过程中出现的异常

**画板在线版本恢复：确认在未修改基线上同样存在，未纳入此次 Redis 改动修复。**

复现步骤：

1. 浏览器打开新画板并绘制矩形。
2. 保存命名版本，确认快照中矩形 `isDeleted=false`。
3. 通过画板 API 删除矩形。
4. 浏览器保持在线时调用版本恢复，再刷新页面。
5. 读取当前场景：矩形仍为 `isDeleted=true`，与历史快照不符。

对照组使用 `git archive HEAD` 导出的未修改后端 `f3ec31e...`、相同依赖和前端镜像、独立无鉴权 Redis，对新画板执行同一脚本，得到相同失败。这个对照说明问题不需要本次 Redis 改动就会发生；**尚未定位画板恢复的具体根因，不能据此猜定某个合并逻辑或前端缓存有错**。

文档首次打开在早期出现过两次超时，后续完整流程通过。另做了 6 次新建文档首次打开复核：新代码 A、B 各 2 次通过，未修改基线 2 次通过，单次约 0.8–1.2 秒。超时根因未确定，没有宣称已经修复；这组短时复核也不等于长期稳定性测试。

复用的本地前端还请求了部分与 Docs 无关的设备、默认 `demo` Space 和机器人接口，出现 400／403。对应请求路径和状态保留在浏览器验收记录中；Docs/PPT 业务断言及本节列出的浏览器检查通过，不将这些旁路请求描述为零错误。

### 15.5 仍未覆盖什么

- Kubernetes 的探针、滚动更新、跨 Pod 网络和 `dmwork-test` 新镜像运行。
- 压缩／文档超限的完整集群压力与故障演练、链接预览实际回源。
- 高并发、多独立用户压力、长时间运行和 Redis 服务自身停机／故障转移。
- 对象存储上传下载、外部聊天通知等未配置的外部依赖。
- Board 在线恢复仍失败，不能把整套业务回归结论写成“全部通过”。

### 15.6 证据与本地复看

本机验收目录：`/Users/cc/Projects/local-redis-auth-acceptance`。该目录是本地部署产物，不作为后端源码提交；真实凭据仅留在权限受限的 `.secrets/`，不写入本文。

| 文件 | 证据 |
| --- | --- |
| `deployment.json`、`version.json` | 实际镜像、源码指纹、前端组成、端口与原容器基线 |
| `results/acceptance.json` | 总结论：Redis 核心验收通过，业务回归有既有失败 |
| `results/infra.json`、`results/compatibility.json` | ACL／DB／四条连接、错误密码和旧无密码配置兼容 |
| `results/doc-dual.json`、`results/sheet.json`、`results/board-dual.json` | 各类文档真实浏览器与跨节点结果 |
| `ppt-collab-browser-result.json`、`results/permissions.json` | PPT 同步、重连及跨节点权限结果 |
| `results/mysql-suite.log` | 真实 MySQL＋Redis 集群测试 4 项通过 |
| `results/restart.json`、`results/cold.json`、`results/mysql-persistence.txt` | 重启、四类文档冷打开及真实数据库记录 |
| `results/shared-docs.json`、`results/baseline.json` | 画板恢复失败及未修改基线对照 |
| `results/first-open.json` | 首次打开稳定性复核 |
| `results/cold-*.png`、`results/doc-dual.png`、`results/board-dual.png`、`results/sheet-dual.png` | 浏览器截图 |

新预览保留在入口 A／B；普通浏览器需要使用本地账号登录。可直接复看以下验收文件：

- Doc：`http://127.0.0.1:28085/d/d_cfe3314bc6976ac52bbe6735`
- Sheet：`http://127.0.0.1:28085/d/d_c1a5bdce75e17d6cfe7d3b71`
- Board：`http://127.0.0.1:28085/d/d_7793db739cb22ba15f2817bd`
- PPT：`http://127.0.0.1:28085/d/d_823ad1b5735755d58ad15a60`

将端口改为 `28086` 可访问同一文件的另一后端入口。临时错误密码、兼容性及未修改基线对照容器已移除；原有预览和数据保留。本次没有提交、推送、创建 MR 或修改远端环境。

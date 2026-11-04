# Project 派生文档访问的事件重验与来源版本设计

日期：2026-11-03

## 目标与确认依据

OCTO-59 保留文档独立授权，Project 归档只限制同步所得网盘/文档权限；成员退出或被移除后，失去最后一个有效来源的已打开连接也必须收回后续读取。用户确认采用变化通知触发重验、活跃文档合并检查来源版本的方案，以减少逐连接完整查权。

本规格约定的 Docs 请求、旧 token、Yjs/PPT 会话及 Drive 内部接口接入已在本仓落地。双节点真实协作连接、真实 Drive 撤权与完整集成验收仍待集中验证；运行环境和部署状态未验证，不表示已启用。

## 复用的权限模型

有效角色仍为 max(owner/doc_member 独立角色、Docs share 角色、Drive reader)。Drive 仅提供 reader 或 none，不授予 writer。保留现有租户/主体/文档绑定、身份验证、Bot 访问边界、HTTP writer 门禁和最终内容写事务。

Project 归档不写 doc_meta.status=2，不改 owner_id、doc_member、share 设置或正文。Project owner 转让不转让 Docs owner。归档及退出后仍有独立 writer/admin 的人继续按原授权操作；仍有另一个有效挂载来源的 reader 也保留。

## 最小处理链路

1. 新请求或连接建立时，沿现有统一解析器读取当前有效角色；签名/身份/文档/Space 证明仍先校验，旧 token 的 role 不能单独恢复被撤销的 Drive 访问。
2. Drive/Server 关系变化提示使受影响绑定失效，各节点标记本地连接需要重验，复用统一角色计算，只在无权时关闭。
3. 每个 Docs 节点只跟踪本节点实际活跃文档的唯一 (doc_id, uid, principal_space_id) 绑定；同绑定多标签页共用一次结果，空闲文档不进入探测。
4. 每 5 秒合并一个探测轮次：批量读取活跃文档的 DB permission_epoch，并按 Drive 契约分批查询授权源元数据指纹。只有本地文档 epoch、来源指纹变化、显式失效或证明过期时才重新执行完整 Docs 角色合并。
5. 返回值来自实际来源读取，不能只检查未曾被源变化更新的 Docs epoch。Redis、Server/Drive 提示即使全部缺失，探测仍能发现源变化，过期未知结果不能继续授予读取。

## 状态与证明

每个活跃绑定保存：已确认 role、doc permission_epoch、Drive source_revision、来源证明截止时刻、内存 generation，以及对应本地连接集合。这是会话状态，不新增 ACL、权限同步表或持久作业。

- 本地文档 epoch 的周期查询直接批量读权威 DB，不能只读可能仍旧的 Redis/local epoch 缓存。相同文档多个绑定合并读取一次。
- Drive 完整判定与版本批量接口、source_revision/valid_for_ms 定义由 octo-drive/docs/specs/2026-11-03-project-archive-authorization-design.md 唯一管理；Docs 不自行解释 Project 或挂载关系。
- source_revision 是等值指纹，不比较大小。它包含当前相关本地授权值、挂载集合及有时间上界的 Project 成员快照；不以单个 Project epoch 代替全部来源。版本探测仍会读轻量元数据，成员快照到期时还需上游批量核验；不能把“只有版本”解释为没有查询成本。
- valid_for_ms 从发起请求的本节点单调时钟计时，最大 30 秒；角色缓存、in-flight 合并及版本相等都不能延长原始来源事实的期限。只有真正刷新来源证据才能取得新的期限。
- Project 成员快照在 Drive 内最长 15 秒，并在 epoch 改变时提前失效。本次部署的 Server peer 上界统一为 30 秒，完整 Docs 证明不得超过剩余来源有效期；不是声称 member_epoch 能检测账号封禁。
- 周期探测确认了同一指纹且返回仍有效的来源证据时，可以保持现有角色；不得给已到期的旧成员事实重新发满额期限。账号有效性变化在 Drive 到期核验后反映到该 UID 的指纹中。
- 探测或权威查询失败不记成“版本未变”。仅靠 Drive 取得读取权的连接，在来源证明到期后暂停后续内容投递并按现有可重认证的无确认错误处理；已确认独立角色不因 Drive 故障被统一关闭。

## 通知接入（本文件为接收契约权威）

新增 POST /internal/docs/source-invalidations，复用现有 Docs 入站内部 token 信任域；不使用 Bot token 或允许最终用户直调。请求正文最多 64 KiB，单次最多 50 个 doc_id：

```json
{"doc_ids":["d_x"],"principal_space_id":"s_x","uid":"u_x"}
```

uid 可省略：已知成员变更精确处理该 UID/Space；挂载/空间等变化处理对应文档在该 principal Space 的所有本地活跃绑定。doc_ids 是业务文档 ID，不是 documentName 或 Drive file_id。Docs 从自身元数据解析 documentName；提示不带内容和名称。

处理：

1. 标记本节点匹配绑定 generation 前进、Drive 来源失效，清理相应派生角色/短期 recheck 缓存并隔离旧 in-flight 结果；不能只清 permission_epoch 缓存。
2. 复用现有 Redis 权限失效通道传播带 source-change 类型、doc_id/documentName、principal_space_id、uid 的提示；接收节点即使 doc permission_epoch 未变，也显式触发来源重验，不依赖 epoch watermark 自动前进。
3. 节点当前事实查询不使用通知自报的 role/版本。重复、迟到通知最多再查一次；已重新取得权限的人不能被旧撤权提示直接踢出。
4. 返回 202 只表示本节点已登记提示并发起传播，不表示所有副本或连接已经完成撤权；身份/输入失败沿 401/400，处理失败返回真实 5xx。Redis 丢失或端点不可用由主动来源探测继续收敛。

来源提示不修改 doc_member，也不把同一提示重放成反复递增的 doc permission_epoch。文档自身 ACL 变更继续按原事务递增 epoch，并在现有通知链路中同样落实到连接处理。

## Yjs 与 PPT 会话行为

### 握手与完整重验

Yjs 普通文档、表格、白板以及 PPT 的真实读/票据入口都复用同一有效角色规则。握手验证旧 token 后重新确认当前授权，不能在 token epoch 等于 Docs epoch 时盲信旧 reader。PPT 的 loadPptDocForRead 及评论 reader 二次检查要真正合并 Drive reader；writer/commenter 操作不从 Drive 获取授权。

对绑定重验前先冻结依赖旧证明的后续内容投递，包括 replay、快照、更新广播、在线状态/awareness 中的受控信息。版本检查失败或正在等待新结果时，不能通过广播旁路继续收到新文档内容。已交付到客户端的内容无法被服务端收回；撤权约束后续访问。

### 结果落地

- 当前 role=none：close 4403，并清理/丢弃该连接尚未投递的受控消息；不是只将 readOnly 设真。
- 当前仍是 reader：保持连接，只读；有另一个有效来源时不因某个来源撤销而断开。
- 当前独立 writer/admin 仍有效：保留原权限，不因 Project 归档或退出降级。
- 文档自身角色实际下降：沿已有降权规则更新 readOnly/角色并阻止应用新的越权写，不广播一次提示就视为完成。
- 权威源无法确认：不授权新的 Drive 读取；现有独立角色仍按本地权威事实判定。无有效独立来源且源证明已过期时停止投递，走现有 4401 可重认证路径。

通知/探测可以在异步重验过程中到达。结果提交时比较绑定 generation 与所依据的文档/source 版本；较旧结果不能覆盖较新失效或重新开放连接。刷新期间，同 epoch 的 source-independent 权威状态或 sourceRevision 变化，或更高 Docs epoch，可隔离较旧 in-flight 结果；同 epoch、同 source 的注册不能延长既有 Drive proof 截止时间。断连、文档卸载及进程关闭时移除绑定；多个相同绑定的连接共享查询但分别执行投递门禁。

Yjs 冻结连接的待发送队列复用现有 `config.ppt.relay.maxLiveBufferFrames/maxLiveBufferBytes`（`PPT_RELAY_MAX_LIVE_BUFFER_FRAMES` / `PPT_RELAY_MAX_LIVE_BUFFER_BYTES`）；超限丢弃待投递内容并以 4401 关闭该逻辑连接，不关闭同一物理 WebSocket 上的其他文档连接，不新增环境变量。

PPT 复用现有 read-auth refresh、canPushRead、terminalClose 等机制；来源结果的恢复和关闭都必须持有当前 source-freeze/auth generation，不能覆盖较新的独立授权或票据重认证等待。Yjs 在 afterLoadDocument 为每个文档实例的公开 addConnection 注册边界安装逐逻辑连接发送门禁，并同步加入活跃绑定，使原生构造函数的首次 awareness 也受证明截止时间及共享绑定冻结约束；不等到 connected 才安装。构造期间若需关闭，先同步阻断内容和写入，再在 microtask 关闭逻辑连接，让原生路由和断连回调完成清理，同一物理 WebSocket 的其他文档不受影响。Redis registry 用于定位，不是权限权威；任何单个节点收到 HTTP 并不等于集群所有连接已处理。

## 负载与生效边界

- 设本节点活跃绑定数为 B、唯一文档数为 D。每轮来源批次最多 50 个绑定，因此 Docs→Drive 的版本 RPC 约为 ceil(B/50)/5 次每秒；文档自身 epoch 读按 D 批量合并。不是每个连接 1 次完整角色 RPC。
- 同 doc/scope 的挂载读取合并；相同 Project/UID 的成员核验在 Drive 内合并，Server epoch/verify 每批不超过既有 50 条限制。不同 UID/Space 不合并授权结果。版本未变且证据有效时，完整 Docs 角色重算次数为 0。
- 成员移除、挂载和本地授权变更：通知尽快处理；丢提示后在下一次来源探测看到权威变更再重验，不宣称退出响应返回时全局连接已断开。
- 正常依赖可用时，每 5 秒开始一轮探测；处理时间另计，不把周期说成绝对完成时限。账号停用不改变 Project epoch，只靠来源成员快照到期核验及有限证明期收敛；依赖不可用时不能突破证明截止时刻继续读取。 距证明截止不足一轮时，按共享绑定提前执行完整查权；相等版本响应和仍基于原 MemberProof 的完整响应都不延长原截止时间。若原证明在两轮之间到期，首次发送可同步冻结该绑定并共享一次完整续证；冻结期间只缓冲，不发送过期内容。已有版本/epoch 探测尚未返回时不另开竞争续证，仍按原到期门禁关闭。完整结果确认无权则 4403，过期证明或到期后仍无法确认则 4401，不用新增每连接计时器延长等待。
- 验收记录实际 B/D、批次、DB/RPC 数量和撤权延迟，覆盖多个节点与重复标签页，不以公式冒充容量实测。现有 PPT 周期若保留，仅查版本/必要状态，不额外叠加逐连接完整来源查权循环。

## 验收标准

1. 独立 owner/doc_member/share 与 Drive reader 矩阵覆盖：归档/退出不改独立权限，最终来源消失后没有伪造 doc_member 保留权。
2. 新 HTTP、旧同 epoch token 重连、现存 Yjs/PPT reader 均收敛；被动 reader 不发入站消息也能被撤权，关闭后不继续收到广播/replay/快照。
3. 分别丢 Server 提示、Drive→Docs 请求、Redis 广播；只有文档 epoch 不变的 Project 撤权也能被来源指纹发现。再删掉最后挂载，不能因源集合为空漏检。
4. 预热各层缓存，保持 Project epoch 不变后停用来源账号，验证成员快照到期不再授权；仅版本相等不能延长旧事实。源故障时有限期依赖权到期，独立授权保留。
5. 失效发生在重验 await 中、探测响应乱序、退出再邀请、多个 Project/Space 混用，旧结果均不能重新开放当前无权连接。
6. PPT Human 的实际读取、collab-token、评论读取接口返回 Drive reader；Drive 来源不能写正文、表格、白板、PPT、评论、成员/share、导入或恢复版本。
7. 多副本、服务重启、重复标签页及通知突发时按文档/绑定聚合，无每连接五秒完整查权或 N+1 源查询。正常依赖与故障证明到期分别计时，单测不能代替真实协作连接联合验收。

## 依赖与交付

依赖 Drive 完整判定的同快照 revision/有效期、新批量来源版本 API、提交后的变化提示，以及 Server 的真实成员/epochs/账号缓存时间界限。Docs 本地端点、批量重验、连接闭环、短期角色缓存失效与 in-flight generation 隔离已实现；生产 PPT 活跃连接复用同一 5 秒绑定探测。最新全量回归通过 312 个测试文件、4615 条测试，另跳过 9 个文件、58 条测试；三个 TypeScript 检查通过。真实 Server、Go Drive、双节点 Docs、MySQL/PostgreSQL/Redis 联查的十个 Yjs/PPT 场景通过：覆盖通知链路分别丢失、最后挂载移除、隔离账号停用及真实 Drive 进程故障。被动 reader 基线后不发送应用消息；撤权后不再收到三次实际协作更新，独立授权及其他 UID/Space 的 reader 继续接收。旧同 epoch token 重连、新 HTTP/ticket 均同步拒绝；Doc epoch 全程未因来源变化而增加。账号停用采用隔离库故障注入，不作为账号管理接口验收。负载形态及逐连接结果记录于 `../evidence/2026-11-03-project-derived-access-native.json`，不是生产容量基准或部署证明。

DRIVE_DERIVED_ENABLED 默认关闭，既有内部地址、双向凭据和相关时间上界必须正确配置后才启用；不得把默认值当作生产已生效。服务间基线和错误语义由各权威规格管理，不把权限消息当内容同步。

HTML 正文与 slug 评论由 octo-docs-html 承载；本仓只读预览/转发不能证明承载服务已按此规则授权。该服务的接口及联合验收是外部依赖，本轮不自动新增仓库或实现。本文的 Docs 侧实现不代表业务运行环境已启用或已上线；生产部署须另行批准，隔离验证不代表已上线；Loop 写入不属于本交付范围。

/**
 * 拉取 HTML 文档的原始源码,给首屏预览用(出站,只读)。
 *
 * ── 这条路是做什么的 ──────────────────────────────────────────────────────────
 * 转发 HTML 文档到会话会产生 type-18 DocumentShareCard,卡片要显示几行首屏文本。
 * HTML 文档的正文**存在 octo-docs-html**(不在 docs-backend,和评论同一个道理,见
 * htmlCommentForward.ts 开头那段),所以只能去它那儿取:
 *
 *   GET {baseUrl}/v1/docs/{slug}/versions/latest/source   → text/plain 原始 HTML
 *
 * ── 授权在哪判 ────────────────────────────────────────────────────────────────
 * **在本服务判完才会走到这里**:路由先过 requireDocRole(reader),没权限根本不发这个请求。
 * 上游带的是**调用方自己的 token**(req.octoToken),不是服务间密钥 —— 与
 * htmlCommentForward 一致。两层含义:
 *   · 绝不拿服务身份替用户读文档;
 *   · 上游那道判定是**纵深**,不是授权来源。授权只在本服务判,绝不委托上游。
 *
 * ── ★ 取哪一篇:按**文档自己的 space** ────────────────────────────────────────
 * 路由传进来的 docSpaceId 是 doc_meta.space_id,**不是**请求头里观察者的 space。
 * slug 只在单个 space 内唯一,而人类链允许跨 space 读 —— 详见 fetchHtmlSource 的注释。
 * 这是个「取哪一篇」的选择参数,不是第二道鉴权。
 *
 * ── ★ 失败策略与 htmlCommentForward **相反** ─────────────────────────────────
 * htmlCommentForward 把上游的状态码**原样回传**(403/409/422 都透出去),因为评论是用户
 * 的写操作:漏掉一条评论必须让用户立刻看见,吞掉错误会让人以为发出去了。
 *
 * 这里正好反过来:预览是**锦上添花**。超时、非 2xx、baseUrl 没配、解析炸了 —— 一律返回
 * null,让路由回 200 + 空 preview,卡片落回今天已有的「暂无预览」中性态。
 * 让一次上游抖动把卡片打回红色错误态,比没有预览更糟,那是倒退。
 * **这不是抄漏了,是有意的方向相反。** 改之前请先想清楚这段。
 *
 * ── ★★ 绝不跟随重定向 ────────────────────────────────────────────────────────
 * 这个请求带着**调用方自己的 octo token**,而且为了兼容上游同时发了 `Authorization`
 * 和自定义的 `token` 两个 header。fetch 的跨源重定向保护**只剥 `Authorization`**,
 * **自定义 header 不在保护范围内,会原样转发到重定向目标**。
 *
 * 实测(Node 22):302 指向另一主机时,目标收到
 *   {"authorization": null, "token": "<调用方 token>"}
 *
 * 也就是说,上游 octo-docs-html 一旦被攻破、被 SSRF 中转,或存在任何开放重定向,
 * 就能收走**每一个调用者的 token**。slug 白名单挡不住这条 —— 白名单防的是 URL 拼接,
 * 而重定向发生在拼接**之后**。
 *
 * 所以下面的 fetch 写死 `redirect: 'manual'`,拿到 3xx 一律当失败降级。
 * 这里读的是一个**确定的固定路径**,没有任何跟随重定向的正当理由。
 * ⚠️ 不要因为「上游改了路径要兼容」把它改回 'follow' —— 那等于把 token 交给任意主机。
 * 上游要改路径,改这里的常量,不要靠重定向。
 */
import { config } from '../../config/env.js'

/**
 * 只读**开头这么多字节**就停,并 abort 掉连接。
 *
 * 为什么不用 `await res.text()`:那会把整份文档读进内存。HTML 文档可以是几十 MB
 * (内嵌 base64 图片的导出件轻松超过),而首屏摘要只要**最开头**的 <title>/<h1> 和头几段
 * 文本 —— 读完整份纯属浪费,还给了一条用大文档打内存的路。
 *
 * 256KB 的取法:HTML 的 <head> + 首屏正文在任何真实文档里都远在这之内(典型文档整份也就
 * 几十 KB);而截断只影响摘要能取到几段,不影响正确性 —— 截断处即使把标签切成两半,
 * htmlExcerpt 的扫描对残缺标签本来就是安全的(未闭合标签直接结束扫描)。
 */
export const HTML_PREVIEW_MAX_BYTES = 256 * 1024

/**
 * slug 拼进 URL 前的形状校验。与 internalHtmlRegistration.ts 的 SAFE_SEGMENT 同款
 * (那里是入口写入时校验,这里是出口拼接时校验)。
 *
 * slug 来自我们自己的 doc_meta,理论上写入时已经校验过 —— 但**仍然要在拼接点再校验一次**:
 * 拼接点是路径注入真正发生的地方,而「上游写入时一定校验过」是一个跨时间、跨代码路径的假设
 * (历史数据、旁路写入、将来新增的写入口都可能破坏它)。带 `../` 或 `?` 的 slug 能把这个
 * 请求打到上游的任意端点上,还带着调用方的 token。
 *
 * 长度上界写死在正则里({1,128}),与 doc_meta 的 SLUG_MAX_LENGTH 一致。
 */
const SAFE_SLUG = /^[A-Za-z0-9_-]{1,128}$/

/** slug 能不能安全拼进 URL。非字符串、空、超长、含特殊字符一律 false。 */
export function isSafeHtmlSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SAFE_SLUG.test(slug)
}

/** 出站取源是否可用。只看基址 —— config.docHtml 没有密钥(带的是调用方自己的 token)。 */
export function htmlPreviewFetchEnabled(): boolean {
  return config.docHtml.baseUrl.trim() !== ''
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/**
 * 按字节上限截断读取响应体。读满 HTML_PREVIEW_MAX_BYTES 立刻 cancel + abort,
 * 不把剩下的字节拉下来。
 *
 * ★★ 切片必须发生在 decode **之前**。
 * 曾经的写法是「先整块 decode 再检查 total」，那样上限只在**块与块之间**生效：
 * 上游一次推一个大块(或运行时把缓冲合并成一块)时，整份文档就全进内存了。
 * 实测：单个 8MiB 块 → decoded chars 8388608，超出 256KB 上限 32 倍 —— 正是这个上限
 * 要防的事。所以下面先算剩余额度、先 subarray 切到额度内，再交给 decoder。
 *
 * 保留 TextDecoder 的 stream 模式:切点(无论是块边界还是我们自己切的)都可能落在一个
 * 多字节 UTF-8 字符中间。stream 模式会把残缺字节挂起来等下一块，所以中间的块边界
 * 不会产生乱码。
 *
 * ★ 但**最后不能调 decoder.decode() 去 flush**。实测(Node 22，也是 WHATWG 规范行为):
 * 带着未完成序列 flush 会**吐出一个 U+FFFD**，而不是把残缺字节丢掉。
 * 那个 U+FFFD 自身在 UTF-8 下占 3 字节，会把输出顶出上限(实测 262146 > 262144)，
 * 同时在摘要末尾留一个“�”。直接不 flush，挂起的残缺字节随局部 decoder 一起丢弃 ——
 * 这正是我们要的。正常读完(没有残缺字节)时，flush 本来就返回空串，不调无影响。
 */
async function readBounded(res: Response, ac: AbortController): Promise<string> {
  const body = res.body
  // 没有可读流(某些运行时/桩件会给 null)。不退化成 res.text() —— 那正是这里要避免的
  // 无上限读取。
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let out = ''
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) {
        const remaining = HTML_PREVIEW_MAX_BYTES - total
        if (value.byteLength >= remaining) {
          // ★ 这一块就把额度吃满了。**先切再 decode**,绝不整块交给 decoder ——
          // 否则一个 8MiB 的单块会把整份文档读进内存,上限形同虚设。
          out += decoder.decode(value.subarray(0, remaining), { stream: true })
          total = HTML_PREVIEW_MAX_BYTES
          // 够了。主动断开,别让上游继续往这边推。
          ac.abort()
          break
        }
        total += value.byteLength
        out += decoder.decode(value, { stream: true })
      }
    }
  } catch {
    // 读到一半断了(abort / 网络)。已经读到的部分照样能出摘要 —— 首屏就在开头。
  } finally {
    // cancel 可能因为已经 abort 而抛,忽略。
    void reader.cancel().catch(() => {})
  }
  // ★ 故意不调 decoder.decode() 做 flush —— 见上面:那会把残缺尾字节变成一个 3 字节的
  // U+FFFD,既顶破字节上限又在摘要末尾留个“�”。丢掉才是对的。
  return out
}

/**
 * 取一篇 HTML 文档的原始源码(截断到 HTML_PREVIEW_MAX_BYTES)。
 *
 * **绝不抛、绝不透错**:任何失败都返回 null,由调用方回落到空预览。
 * 返回的字符串是**给 htmlExcerpt 提纯文本用的**,绝不能原样回给客户端。
 *
 * ★ docSpaceId 是**文档自己的 home space**(doc_meta.space_id),**不是调用者的
 * 当前 space**。两者合法地会不一致:人类链按 docId 定位文档,允许跨 space 读
 * (见 guard.ts),而转发分享卡到另一个 space 的会话里正是预览的主场景。
 * 它以 `X-Space-Id` 发给上游,决定上游去哪个 space 解析这个 slug ——
 * slug 只在单个 space 内唯一((space_id, octo_doc_slug)),所以这是一个
 * **「取哪一篇」的选择参数**,不是鉴权参数(鉴权已在本服务判完)。
 * 传错(比如回头去读请求的 X-Space-Id)的后果不是越权而是**拿错/拿不到**:
 * 上游把「文档 space ≠ 请求 space」当作跨 space 访问直接判死(crossSpaceScope →
 * resolveDocID 返回空 docID 且禁止回落 → 404),于是每个跨 space 读者的卡片永远空白。
 */
export async function fetchHtmlSource(args: {
  slug: unknown
  callerToken: string
  /** 文档的 home space(doc_meta.space_id)。**不是**调用者的当前 space —— 见上。 */
  docSpaceId?: string
}): Promise<string | null> {
  // baseUrl 没配 = 这条路没开。和评论转发的 503 不同,这里静默降级(见文件头的方向说明)。
  if (!htmlPreviewFetchEnabled()) return null
  // ★ 拼接前校验。不过关就当作取不到源,连请求都不发。
  if (!isSafeHtmlSlug(args.slug)) return null
  if (!args.callerToken) return null

  const url = joinUrl(config.docHtml.baseUrl, `/v1/docs/${args.slug}/versions/latest/source`)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.docHtml.timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        // 调用方自己的 token,两种 header 都给 —— 与 htmlCommentForward 一致。
        Authorization: `Bearer ${args.callerToken}`,
        token: args.callerToken,
        // ★ 文档的 home space,不是调用者的。决定上游去哪个 space 解析 slug —— 见函数注释。
        ...(args.docSpaceId ? { 'X-Space-Id': args.docSpaceId } : {}),
      },
      // ★ 绝不跟随重定向。自定义 header(上面的 `token`)**不受跨源剥离保护**,
      // 跟随重定向 = 把调用方的 octo token 交给重定向目标主机。详见文件头。
      redirect: 'manual',
      signal: ac.signal,
    })
    // 3xx 一律当失败。redirect:'manual' 下重定向是一个**正常返回**(不抛),而它的 body
    // 是不可信的 —— 绝不能拿去提摘要。注意 `res.ok` 已经排除 3xx,这里显式再写一道
    // 是为了把意图写在代码里:将来有人放宽 res.ok 判定时,这一行仍然拦着。
    if (res.status >= 300 && res.status < 400) return null
    // 非 2xx(404/403/500…)一律当作没有预览。这里**不**把上游状态码透出去:
    // 见文件头 —— 与评论转发方向相反是有意的。
    if (!res.ok) return null
    return await readBounded(res, ac)
  } catch {
    // 超时 / DNS / 连接重置 / abort。全部静默降级。
    return null
  } finally {
    clearTimeout(timer)
  }
}

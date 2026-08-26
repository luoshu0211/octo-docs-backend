// GET /:docId/html-preview —— 路由测试。
//
// 沿用 docSheet.test.ts 的离线 harness:桩掉权限闸,路由的其余逻辑(doc_type 闸、
// slug 处理、出站取源、降级)真跑。
//
// 这里最要紧的不是「成功时长什么样」,而是**失败时绝不能 5xx**:
// 预览是锦上添花,上游抖一下就把分享卡片打回红色错误态,比没有预览更糟。
// 所有降级路径都必须落在 200 + 空 preview 上。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/api/guard.js', () => ({ requireDocRole: vi.fn() }))

import { getDocHtmlPreviewHandler } from '../src/api/routes/docHtmlPreview.js'
import { requireDocRole } from '../src/api/guard.js'
import { HTML_PREVIEW_MAX_BYTES } from '../src/api/services/htmlPreviewFetch.js'
import { config } from '../src/config/env.js'

// ── mock req/res ────────────────────────────────────────────────────────────
interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}
function mockRes(): MockRes {
  return {
    statusCode: 0,
    body: undefined,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
}
function req(params: Record<string, string>, headers: Record<string, string> = {}) {
  return {
    uid: 'u_1',
    spaceId: 's1',
    octoToken: 'caller-tok',
    params,
    query: {},
    headers,
    header(name: string) {
      return headers[name]
    },
  } as never
}

/**
 * 一个已注册的 html 文档的 guard 结果(meta 上带 octo_doc_slug + doc_type + space_id)。
 *
 * space_id 是**文档自己的 home space**,不是调用者的 —— 人类链允许两者不同
 * (guard.ts:「X-Space-Id never scopes selection or authz」),所以这两个值必须
 * 在测试里分得开,否则「取源用了谁的 space」这个问题根本测不出来。
 */
function htmlGuard(slug: string | null, spaceId = 'space-home') {
  return {
    meta: {
      doc_id: 'd_1',
      document_name: 'octo:s1:f_default:d_1',
      doc_type: 'html',
      octo_doc_slug: slug,
      space_id: spaceId,
      permission_epoch: 3,
    },
    role: 'reader',
  } as never
}

/** 一份典型的上游 HTML 源码。 */
const SAMPLE_HTML = `<!doctype html><html><head><title>季度复盘</title></head>
<body><p>第一段。</p><p>第二段。</p></body></html>`

/** text/plain 流式响应 —— 上游 /versions/latest/source 的形状。 */
function sourceResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })
}

const original = { ...config.docHtml }

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  config.docHtml.baseUrl = 'http://html.test'
  config.docHtml.timeoutMs = 1000
})

afterEach(() => {
  Object.assign(config.docHtml, original)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── 权限闸 ────────────────────────────────────────────────────────────────────
describe('权限(服务端权威)', () => {
  it('要求 reader', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), mockRes() as never)

    expect(vi.mocked(requireDocRole).mock.calls[0]![3]).toBe('reader')
    // 闸没过就绝不出站 —— 否则这条路就成了一个免鉴权的上游代理。
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('无权限 → 403 由 requireDocRole 给,路由不改写', async () => {
    // requireDocRole 自己写 403 并返回 null;路由只是 return。
    vi.mocked(requireDocRole).mockImplementation(async (_req, res) => {
      ;(res as unknown as MockRes).status(403).json({ error: 'forbidden' })
      return null
    })
    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
  })

  it('归档 → 409 conflict,由 requireDocRole 给(路由不重复判 status)', async () => {
    vi.mocked(requireDocRole).mockImplementation(async (_req, res) => {
      ;(res as unknown as MockRes).status(409).json({ error: 'conflict' })
      return null
    })
    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'conflict' })
  })
})

// ── doc_type 闸 ───────────────────────────────────────────────────────────────
describe('doc_type 闸', () => {
  for (const docType of ['doc', 'sheet', 'board', 'html_ppt']) {
    it(`${docType} → 409 unsupported_doc_type`, async () => {
      vi.mocked(requireDocRole).mockResolvedValue({
        meta: { doc_id: 'd_1', doc_type: docType, octo_doc_slug: 'slug-1' },
        role: 'reader',
      } as never)
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const res = mockRes()
      await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

      expect(res.statusCode).toBe(409)
      // 与 /content、/sheet、/scene 三条**逐字一致**:前端已经在按这个串分支。
      expect(res.body).toEqual({ error: 'unsupported_doc_type' })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  }
})

// ── 正常路径 ──────────────────────────────────────────────────────────────────
describe('GET /html-preview —— 上游正常', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(htmlGuard('slug-1')))

  it('返回 200 + 复用 doc 预览形状', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sourceResponse(SAMPLE_HTML)))

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      docId: 'd_1',
      preview: { type: 'doc', heading: '季度复盘', paragraphs: ['第一段。', '第二段。'] },
    })
  })

  it('打的是上游的 latest source 接口,并带调用方自己的 token', async () => {
    const fetchMock = vi.fn(async () => sourceResponse(SAMPLE_HTML))
    vi.stubGlobal('fetch', fetchMock)

    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), mockRes() as never)

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://html.test/v1/docs/slug-1/versions/latest/source',
    )
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    // 调用方 token,不是服务间密钥 —— 与 htmlCommentForward 一致。
    expect(headers.Authorization).toBe('Bearer caller-tok')
    expect(headers.token).toBe('caller-tok')
  })


  it('绝不把原始 HTML 回给客户端', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sourceResponse(
      '<html><head><script>var t="TOKEN_LEAK"</script><title>标题</title></head><body><p>正文</p></body></html>',
    )))

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('<')
    expect(serialized).not.toContain('TOKEN_LEAK')
  })

  it('上游只有噪声时返回空 preview(仍是 200)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sourceResponse('   \n  ')))

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', preview: { type: 'doc', paragraphs: [] } })
  })

  it('超大响应体被截断读取,不整份拉下来(多块)', async () => {
    // 首屏摘要只要最开头。整份读一个几十 MB 的导出件(内嵌 base64 图片)
    // 纯属浪费,还给了一条用大文档打内存的路。
    // 这里用一个**无限**流:实现如果不截断(比如 await res.text()),这条用例会挂死。
    //
    // ★ 注意:这条只钉「块与块之间」的上限。**单个大块**是另一条路,而且是这条
    // 用例测不到的 —— 见下面 readBounded 的 describe。
    const chunk = new TextEncoder().encode('<p>x</p>'.repeat(1024)) // 8KB/块
    let pulled = 0
    const infinite = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<title>大文档</title><p>开头一段</p>'))
      },
      pull(controller) {
        pulled += chunk.byteLength
        // 安全网:若实现没有上限,这里会无限推下去 —— 远超 256KB 后主动报错,
        // 让用例失败而不是挂死。
        if (pulled > 8 * 1024 * 1024) {
          controller.error(new Error('stream was never bounded'))
          return
        }
        controller.enqueue(chunk)
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(infinite, { status: 200 })))

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { preview: { heading?: string; paragraphs: string[] } }
    expect(body.preview.heading).toBe('大文档')
    expect(body.preview.paragraphs[0]).toBe('开头一段')
    // ★ 铉住上限本身:读到 256KB 就该断开,绝不能无限拉。
    // 给一块的宽度(最后一次 read 会跨过上限才停)。
    expect(pulled).toBeLessThanOrEqual(256 * 1024 + chunk.byteLength)
  })
})

// ── 边界 A0:上游取源的 space 必须是**文档自己的**(P0 —— 跨 space 读直接失效) ──
describe('边界 A0 —— 取源绑定到文档的 home space,不是观察者的 space', () => {
  /**
   * ★ 这一组钉的是「查哪一篇文档」这个选择,不是鉴权。
   *
   * 鉴权在 requireDocRole 里已经判完,而且它是 **docId-first**:
   * guard.ts 写明「X-Space-Id never scopes selection or authz」,跨 space 的直接成员 /
   * owner / anyone_in_space 调用者都能正常拿到 reader。也就是说
   * **「观察者 space ≠ 文档 space」是受支持的正常场景**,不是异常 —— 转发分享卡到
   * 另一个 space 的会话里,正是这个端点存在的理由。
   *
   * 但 slug 只在**一个 space 内**唯一(uk_octo_doc_slug 是 (space_id, octo_doc_slug),
   * schema.sql:55),所以上游必须知道去**哪个 space** 解析这个 slug。
   * 实测上游(octo-docs-html)的链路:
   *   user_auth_mw.go: X-Space-Id 经 IsSpaceMember 验证后 → ContextWithSpaceID
   *   doc_member_mirror.go crossSpaceScope(): 文档 provenance space ≠ ctx space ⇒ true
   *   resolveDocID(): 跨 space ⇒ 直接返回 docID="" 且 registered=true(**禁止回落**)
   *   RoleBySlugUID → ok=false → capability 判 CapNone → 404
   *
   * 于是把观察者的 space 转发上去 = 跨 space 读**永远拿不到源码**,卡片永远空白。
   * 传文档自己的 space 才与本服务已经做出的授权判定一致。
   */
  const SPACE_HEADER = (calls: ReturnType<typeof vi.fn>['mock']['calls']) =>
    ((calls[0]![1] as RequestInit).headers as Record<string, string>)['X-Space-Id']

  it('跨 space 读者 → 上游收到的是**文档的** space,预览正常解析', async () => {
    // 观察者在 space-x,文档家在 space-home。人类链明确允许这种读。
    vi.mocked(requireDocRole).mockResolvedValue(htmlGuard('slug-1', 'space-home'))
    const fetchMock = vi.fn(async () => sourceResponse(SAMPLE_HTML))
    vi.stubGlobal('fetch', fetchMock)

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }, { 'X-Space-Id': 'space-x' }), res as never)

    // ★ 承重断言:绝不能是 'space-x'。
    expect(SPACE_HEADER(fetchMock.mock.calls)).toBe('space-home')
    // 而且预览要真的出来 —— 这条端点的主场景不能是空白卡片。
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      docId: 'd_1',
      preview: { type: 'doc', heading: '季度复盘', paragraphs: ['第一段。', '第二段。'] },
    })
  })

  it('同 space 读者 → 行为不变(回归)', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(htmlGuard('slug-1', 'space-home'))
    const fetchMock = vi.fn(async () => sourceResponse(SAMPLE_HTML))
    vi.stubGlobal('fetch', fetchMock)

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }, { 'X-Space-Id': 'space-home' }), res as never)

    expect(SPACE_HEADER(fetchMock.mock.calls)).toBe('space-home')
    expect(res.statusCode).toBe(200)
    expect((res.body as { preview: { heading?: string } }).preview.heading).toBe('季度复盘')
  })

  it('观察者 space 里有同名 slug 的另一篇文档 → 绝不按观察者的 space 解析', async () => {
    // (space_id, slug) 才是唯一键,所以 space-x 里完全可以有一篇同名 slug 的**别的**文档。
    // 若把 space-x 转发上去,上游按 (space-x, slug-1) 解析 —— 要么查不到,要么解析出
    // 攻击者在自己 space 里种下的同名文档。两种都错。
    vi.mocked(requireDocRole).mockResolvedValue(htmlGuard('slug-1', 'space-home'))
    const fetchMock = vi.fn(async () => sourceResponse(SAMPLE_HTML))
    vi.stubGlobal('fetch', fetchMock)

    await getDocHtmlPreviewHandler(
      req({ docId: 'd_1' }, { 'X-Space-Id': 'space-x-with-colliding-slug' }),
      mockRes() as never,
    )

    const sent = SPACE_HEADER(fetchMock.mock.calls)
    expect(sent).toBe('space-home')
    expect(sent).not.toBe('space-x-with-colliding-slug')
  })

  it('请求完全不带 X-Space-Id → 仍然用文档的 space(不退化成不带头)', async () => {
    // 退化回读请求头的实现在这里会**不发** X-Space-Id,上游只能落回无过滤查找。
    vi.mocked(requireDocRole).mockResolvedValue(htmlGuard('slug-1', 'space-home'))
    const fetchMock = vi.fn(async () => sourceResponse(SAMPLE_HTML))
    vi.stubGlobal('fetch', fetchMock)

    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), mockRes() as never)

    expect(SPACE_HEADER(fetchMock.mock.calls)).toBe('space-home')
  })

  it('文档 meta 上没有 space_id → 不发这个头,而不是发空串', async () => {
    // 防御性:meta.space_id 理论上恒非空(schema NOT NULL),但降级路径不该发 'X-Space-Id: '。
    vi.mocked(requireDocRole).mockResolvedValue(htmlGuard('slug-1', ''))
    const fetchMock = vi.fn(async () => sourceResponse(SAMPLE_HTML))
    vi.stubGlobal('fetch', fetchMock)

    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }, { 'X-Space-Id': 'space-x' }), mockRes() as never)

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers['X-Space-Id']).toBeUndefined()
  })
})

// ── 边界 A:slug 为 NULL ──────────────────────────────────────────────────────
describe('边界 A —— slug 为 NULL', () => {
  it('人建的 html 行没有 slug → 200 空 preview,不是 500', async () => {
    // docType.ts 写明:只有 bot 注册的 html 行才存 octo_doc_slug,人建的是 NULL。
    // 这是正常文档,不是错误。
    vi.mocked(requireDocRole).mockResolvedValue(htmlGuard(null))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', preview: { type: 'doc', paragraphs: [] } })
    // 没 slug 就没有可打的地址 —— 连请求都不该发。
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('slug 为空串同样降级', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(htmlGuard(''))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ docId: 'd_1', preview: { type: 'doc', paragraphs: [] } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── 边界 B:slug 形状校验 ─────────────────────────────────────────────────────
describe('边界 B —— slug 拼进 URL 前必须校验', () => {
  const evilSlugs: Array<[string, string]> = [
    ['路径穿越', '../../internal/admin'],
    ['绝对路径', '/v1/internal/secrets'],
    ['查询串注入', 'slug?token=x'],
    ['片段注入', 'slug#frag'],
    ['换行注入', 'slug\nX-Evil: 1'],
    ['协议注入', 'http://evil.test/x'],
    ['超长', 'a'.repeat(129)],
    ['空格', 'a b'],
  ]

  for (const [name, slug] of evilSlugs) {
    it(`${name} → 200 空 preview,且不发出上游请求`, async () => {
      vi.mocked(requireDocRole).mockResolvedValue(htmlGuard(slug))
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const res = mockRes()
      await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({ docId: 'd_1', preview: { type: 'doc', paragraphs: [] } })
      // ★ 关键断言:非法 slug 绝不能拼进 URL 打出去(还带着调用方的 token)。
      expect(fetchMock).not.toHaveBeenCalled()
    })
  }

  it('合法 slug(字母/数字/下划线/连字符)照常放行', async () => {
    vi.mocked(requireDocRole).mockResolvedValue(htmlGuard('Abc_123-xyz'))
    const fetchMock = vi.fn(async () => sourceResponse(SAMPLE_HTML))
    vi.stubGlobal('fetch', fetchMock)

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://html.test/v1/docs/Abc_123-xyz/versions/latest/source',
    )
  })
})

// ── 边界 C:上游失败一律 fail-safe ────────────────────────────────────────────
describe('边界 C —— 上游失败一律 200 空 preview', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(htmlGuard('slug-1')))

  const empty = { docId: 'd_1', preview: { type: 'doc', paragraphs: [] } }

  it('上游 500 → 200 空 preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sourceResponse('boom', 500)))
    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(empty)
  })

  it('上游 404 → 200 空 preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sourceResponse('not found', 404)))
    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(empty)
  })

  it('上游 403 → 200 空 preview(不把上游状态码透给卡片)', async () => {
    // ★ 与 htmlCommentForward 方向相反:那边原样回传上游错误码,这边一律吞掉。
    // 评论漏了必须让用户立刻看见;预览失败只该安静地落回「暂无预览」。
    vi.stubGlobal('fetch', vi.fn(async () => sourceResponse('forbidden', 403)))
    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(empty)
  })

  it('超时 / abort → 200 空 preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }))
    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(empty)
  })

  it('网络不可达 → 200 空 preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(empty)
  })

  it('baseUrl 未配 → 200 空 preview,且不发出请求', async () => {
    config.docHtml.baseUrl = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(empty)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('响应体读到一半断流 → 200,已读到的部分照样出摘要', async () => {
    // 首屏就在开头,读到多少算多少 —— 断流不该把预览整个丢掉。
    // 注意:必须在**第二次** pull 时才 error。规范里 controller.error() 会把队列里
    // 已 enqueue 的块一并丢掉,所以同步 enqueue+error 测不到「读到一半」这个场景。
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('<title>半份文档</title><p>开头</p>'))
          return
        }
        controller.error(new Error('connection reset'))
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { preview: { heading?: string; paragraphs: string[] } }
    expect(body.preview.heading).toBe('半份文档')
    expect(body.preview.paragraphs).toEqual(['开头'])
  })

  it('第一个块就断流 → 200 空 preview,不崩', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'))
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(empty)
  })

  it('上游返回二进制垃圾 → 200,不崩', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xff]), { status: 200 }),
    ))
    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)
    expect(res.statusCode).toBe(200)
    expect((res.body as { preview: { type: string } }).preview.type).toBe('doc')
  })

  it('没有调用方 token → 200 空 preview,不拿服务身份替他读', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const noToken = { ...(req({ docId: 'd_1' }) as object), octoToken: undefined } as never

    const res = mockRes()
    await getDocHtmlPreviewHandler(noToken, res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(empty)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── 边界 D:302 重定向绝不跟随(P0 —— token 泄漏) ──────────────────────────────
describe('边界 D —— 上游重定向不跟随(自定义 header 会被带走)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(htmlGuard('slug-1')))

  const empty = { docId: 'd_1', preview: { type: 'doc', paragraphs: [] } }
  const SOURCE_URL = 'http://html.test/v1/docs/slug-1/versions/latest/source'

  /**
   * ★ 这一组钉的是一条**实测复现过**的泄漏,不是理论风险:
   *
   *   起一个 302 服务指向另一主机 → Node fetch 默认 redirect:'follow' 跟过去 →
   *   重定向目标收到 {"authorization":null,"token":"CALLER_TOKEN_SECRET"}
   *
   * fetch 的跨源重定向保护**只剥 Authorization**,自定义 header(我们为了兼容上游
   * 额外发的 `token`)原样转发。上游 octo-docs-html 一旦被攻破/被 SSRF 中转/存在任何
   * 开放重定向,就能收走**每一个调用者的 octo token**。
   *
   * slug 白名单挡不住这条 —— 它防的是 URL 拼接,而 302 发生在拼接之后。
   */
  for (const status of [301, 302, 303, 307, 308]) {
    it(`上游 ${status} → 200 空 preview,且不对重定向目标发第二次请求`, async () => {
      const fetchMock = vi.fn(async () =>
        new Response(null, { status, headers: { Location: 'http://evil.test/steal' } }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const res = mockRes()
      await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual(empty)
      // ★ 只发生一次 fetch,目标是原始 URL —— 绝不能出现打向 evil.test 的第二枪。
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]![0]).toBe(SOURCE_URL)
    })
  }

  /**
   * ★★ 这条是上面那组的**承重断言**，不能删。
   *
   * 上面按状态码的那组在 mock harness 里是**假通过**：`!res.ok` 本来就拦 3xx，
   * 而被桩掉的 fetch 压根不会真去跟随重定向 —— 所以它们在修复前后都绿。
   * 真实运行时恰恰相反：默认 redirect:'follow' 下 fetch 已经把 token 送到了重定向
   * 目标，回到这里的 res 是最终那个 200，`!res.ok` 根本不会触发。
   * 换句话：状态码断言拦不住这个漏，**只有钉住传给 fetch 的 redirect 选项才行**。
   */
  it('显式要求 redirect:manual —— 跟随重定向 = 把调用方 token 交给任意主机', async () => {
    const fetchMock = vi.fn(async () => sourceResponse(SAMPLE_HTML))
    vi.stubGlobal('fetch', fetchMock)

    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), mockRes() as never)

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.redirect).toBe('manual')
  })

  it('重定向响应即使带 body 也不解析成预览', async () => {
    // redirect:manual 下 3xx 是一个**正常返回**(不是 throw),body 可能有内容。
    // 若实现只判 !res.ok 之外的分支漏掉 3xx,这里会把攻击者的 body 当正文渲染。
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<title>ATTACKER</title><p>ATTACKER_BODY</p>', {
        status: 302,
        headers: { Location: 'http://evil.test/steal' },
      }),
    ))

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(empty)
    expect(JSON.stringify(res.body)).not.toContain('ATTACKER')
  })
})

// ── 边界 E:字节上限对「单个大块」同样有效(P0) ───────────────────────────────
describe('边界 E —— 单块超大响应体也必须被截断', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(htmlGuard('slug-1')))

  /**
   * ★ 实测复现过的漏洞:原实现的循环是「先整块 decode 再检查 total」,所以上限只在
   * **块与块之间**生效。上游一次推一个 8MiB 大块(或运行时把缓冲合并成一块)时:
   *
   *   bytes pulled: 8388608 | decoded chars: 8388608 | cap: 262144 | 超出 32.0 倍
   *
   * 整份文档全进了内存 —— 正是这个上限要防的事。必须在 decode **之前**按剩余额度切片。
   */
  it('单个 8MiB 块 → 解码结果 ≤ 256KB', async () => {
    const huge = new TextEncoder().encode('<p>' + 'x'.repeat(8 * 1024 * 1024) + '</p>')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(huge)
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))

    const res = mockRes()
    await getDocHtmlPreviewHandler(req({ docId: 'd_1' }), res as never)

    expect(res.statusCode).toBe(200)
    // 上限的可观测代理:段落被 htmlExcerpt 截到 300 字,所以直接断言不了解码长度。
    // 用 readBounded 自身来钉 —— 见下面的直接单测。
    expect((res.body as { preview: { type: string } }).preview.type).toBe('doc')
  })

  it('readBounded:单块 8MiB 投喂,解码字节量 ≤ HTML_PREVIEW_MAX_BYTES', async () => {
    // 直接打 fetchHtmlSource,断言它返回的字符串本身没有超限 —— 这是「进内存多少」的
    // 唯一诚实度量,路由层看不到(htmlExcerpt 会把结果截到 1200 字以内)。
    const { fetchHtmlSource } = await import('../src/api/services/htmlPreviewFetch.js')
    const huge = new TextEncoder().encode('a'.repeat(8 * 1024 * 1024))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(huge)
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))

    const out = await fetchHtmlSource({ slug: 'slug-1', callerToken: 'caller-tok' })

    expect(out).not.toBeNull()
    // 全 ASCII,1 char = 1 byte,所以字符数即字节数。
    expect(out!.length).toBeLessThanOrEqual(HTML_PREVIEW_MAX_BYTES)
  })

  it('readBounded:单个大块被切片后,开头的摘要照样取得到', async () => {
    // 截断不能把首屏一起吃掉 —— 切片保留的是**开头**那段额度。
    const { fetchHtmlSource } = await import('../src/api/services/htmlPreviewFetch.js')
    const head = '<title>大文档</title><p>开头一段</p>'
    const huge = new TextEncoder().encode(head + '<p>' + 'x'.repeat(8 * 1024 * 1024) + '</p>')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(huge)
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))

    const out = await fetchHtmlSource({ slug: 'slug-1', callerToken: 'caller-tok' })

    expect(out).not.toBeNull()
    expect(out!.startsWith(head)).toBe(true)
    expect(Buffer.byteLength(out!, 'utf-8')).toBeLessThanOrEqual(HTML_PREVIEW_MAX_BYTES)
  })

  it('readBounded:切片落在多字节字符中间时不产生 U+FFFD 乱码', async () => {
    // 每个中文字 3 字节,256KB 不是 3 的整数倍 → 切点必然落在某个字中间。
    // 关键:**不能**在末尾调 flush。TextDecoder 的 flush 语义是「把攒着的残缺
    // 字节按错误处理吐出来」,即产生 U+FFFD,而不是丢弃(第 2 轮实测确认)。
    // 所以实现里刻意省掉最后一次 flush,残缺尾字符留在 decoder 内部被丢掉。
    const { fetchHtmlSource } = await import('../src/api/services/htmlPreviewFetch.js')
    const huge = new TextEncoder().encode('中'.repeat(400 * 1024))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(huge)
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))

    const out = await fetchHtmlSource({ slug: 'slug-1', callerToken: 'caller-tok' })

    expect(out).not.toBeNull()
    expect(Buffer.byteLength(out!, 'utf-8')).toBeLessThanOrEqual(HTML_PREVIEW_MAX_BYTES)
    expect(out).not.toContain('\ufffd')
  })
})

// htmlExcerpt —— 纯函数单测。
//
// 这里钉两类东西:
//   1. 摘要的**内容契约**:标题从哪来、取几段、实体怎么解、超长怎么截。
//   2. 摘要的**安全契约**:script/style 的内容绝不能当正文冒出来;畸形/超长输入不能崩,
//      也不能触发指数级回溯(ReDoS)—— 文档正文是攻击者可控的。

import { describe, it, expect } from 'vitest'
import { extractHtmlExcerpt, decodeEntities } from '../src/api/services/htmlExcerpt.js'

describe('extractHtmlExcerpt — 正常文档', () => {
  it('取出 title 与前三段文本', () => {
    const html = `<!doctype html><html><head><title>季度复盘</title></head><body>
      <p>第一段。</p>
      <p>第二段。</p>
      <p>第三段。</p>
      <p>第四段不要。</p>
    </body></html>`
    const out = extractHtmlExcerpt(html)
    expect(out.heading).toBe('季度复盘')
    expect(out.paragraphs).toEqual(['第一段。', '第二段。', '第三段。'])
  })

  it('只有 h1 时用 h1 当标题', () => {
    const out = extractHtmlExcerpt('<div><h1>只有标题</h1><p>正文</p></div>')
    expect(out.heading).toBe('只有标题')
    expect(out.paragraphs).toEqual(['正文'])
  })

  it('只有 title 时正文可以为空', () => {
    const out = extractHtmlExcerpt('<html><head><title>空文档</title></head><body></body></html>')
    expect(out.heading).toBe('空文档')
    expect(out.paragraphs).toEqual([])
  })

  it('h2-h6 也能当标题', () => {
    expect(extractHtmlExcerpt('<h3>三级标题</h3>').heading).toBe('三级标题')
    expect(extractHtmlExcerpt('<h6>六级标题</h6>').heading).toBe('六级标题')
  })

  it('title 为空但有 h1 时回落到 h1', () => {
    const out = extractHtmlExcerpt('<head><title></title></head><body><h1>真标题</h1></body>')
    expect(out.heading).toBe('真标题')
  })

  it('标题不会在 paragraphs 里重复出现', () => {
    const out = extractHtmlExcerpt('<h1>标题</h1><p>正文</p>')
    expect(out.heading).toBe('标题')
    expect(out.paragraphs).not.toContain('标题')
  })

  it('折叠空白', () => {
    const out = extractHtmlExcerpt('<p>  多个   空格\n 和换行  </p>')
    expect(out.paragraphs[0]).toBe('多个 空格 和换行')
  })

  it('忽略只有空白的块', () => {
    const out = extractHtmlExcerpt('<p>   </p><p>\n\t</p><p>真正的正文</p>')
    expect(out.paragraphs).toEqual(['真正的正文'])
  })
})

describe('extractHtmlExcerpt — script / style 剥离', () => {
  it('不把 script 内容当正文', () => {
    const html = '<html><head><script>var secret = "TOKEN_LEAK"; if (a<b) {}</script></head><body><p>正文</p></body></html>'
    const out = extractHtmlExcerpt(html)
    expect(JSON.stringify(out)).not.toContain('TOKEN_LEAK')
    expect(out.paragraphs).toEqual(['正文'])
  })

  it('不把 style 内容当正文', () => {
    const html = '<style>.a{color:red;content:"STYLE_LEAK"}</style><p>正文</p>'
    const out = extractHtmlExcerpt(html)
    expect(JSON.stringify(out)).not.toContain('STYLE_LEAK')
    expect(out.paragraphs).toEqual(['正文'])
  })

  it('带属性的 script 标签也剥', () => {
    const out = extractHtmlExcerpt('<script type="module" src="x.js">EVIL</script><p>正文</p>')
    expect(JSON.stringify(out)).not.toContain('EVIL')
  })

  it('不误伤名字相近的标签', () => {
    // <scriptish> 不是 <script>,它的文本该当正文。
    const out = extractHtmlExcerpt('<scriptish>保留我</scriptish>')
    expect(out.paragraphs).toEqual(['保留我'])
  })

  it('剥 HTML 注释', () => {
    const out = extractHtmlExcerpt('<!-- COMMENT_LEAK --><p>正文</p>')
    expect(JSON.stringify(out)).not.toContain('COMMENT_LEAK')
    expect(out.paragraphs).toEqual(['正文'])
  })

  it('绝不返回原始标签', () => {
    const out = extractHtmlExcerpt('<h1>标题</h1><p>带<b>加粗</b>的段落</p>')
    expect(JSON.stringify(out)).not.toContain('<')
  })
})

describe('decodeEntities / 实体解码', () => {
  it('解码基本实体', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&#39;')).toBe('&<>"\'')
  })

  it('nbsp 解成普通空格', () => {
    expect(decodeEntities('a&nbsp;b')).toBe('a b')
  })

  it('未知实体原样保留', () => {
    expect(decodeEntities('&copyright;&#128512;')).toBe('&copyright;&#128512;')
  })

  it('段落里的实体被解码', () => {
    const out = extractHtmlExcerpt('<p>A &amp; B &lt;tag&gt;</p>')
    expect(out.paragraphs[0]).toBe('A & B <tag>')
  })

  it('标题里的实体被解码', () => {
    expect(extractHtmlExcerpt('<title>A &amp; B</title>').heading).toBe('A & B')
  })

  it('解码出来的 nbsp 不会变成一个「空白段落」', () => {
    const out = extractHtmlExcerpt('<p>&nbsp;&nbsp;</p><p>正文</p>')
    expect(out.paragraphs).toEqual(['正文'])
  })
})

describe('extractHtmlExcerpt — 硬上限', () => {
  it('标题截到 200 字符', () => {
    const out = extractHtmlExcerpt(`<title>${'标'.repeat(5000)}</title>`)
    expect(out.heading!.length).toBeLessThanOrEqual(200)
  })

  it('每段截到 300 字符', () => {
    const out = extractHtmlExcerpt(`<p>${'a'.repeat(5000)}</p><p>${'b'.repeat(5000)}</p>`)
    for (const p of out.paragraphs) expect(p.length).toBeLessThanOrEqual(300)
  })

  it('整体有封顶', () => {
    const html = `<title>${'t'.repeat(1000)}</title>` + '<p>' + 'x'.repeat(5000) + '</p>'.repeat(1)
    const out = extractHtmlExcerpt(html)
    const total = (out.heading?.length ?? 0) + out.paragraphs.reduce((n, p) => n + p.length, 0)
    expect(total).toBeLessThanOrEqual(1200)
  })

  it('最多三段', () => {
    const out = extractHtmlExcerpt('<p>a</p>'.repeat(100))
    expect(out.paragraphs.length).toBe(3)
  })

  it('几千个空块之后仍能快速返回', () => {
    const out = extractHtmlExcerpt('<p></p>'.repeat(20000) + '<p>末尾</p>')
    // 扫描是有界的:超过界限就不再找了,返回空段落是可接受的降级(绝不能是挂死)。
    expect(Array.isArray(out.paragraphs)).toBe(true)
  })
})

describe('extractHtmlExcerpt — 空 / 畸形输入不崩', () => {
  it('空字符串', () => {
    expect(extractHtmlExcerpt('')).toEqual({ paragraphs: [] })
  })

  it('非字符串', () => {
    expect(extractHtmlExcerpt(null)).toEqual({ paragraphs: [] })
    expect(extractHtmlExcerpt(undefined)).toEqual({ paragraphs: [] })
    expect(extractHtmlExcerpt(12345)).toEqual({ paragraphs: [] })
    expect(extractHtmlExcerpt({})).toEqual({ paragraphs: [] })
  })

  it('纯文本没有标签', () => {
    const out = extractHtmlExcerpt('就是一段纯文本')
    expect(out.paragraphs).toEqual(['就是一段纯文本'])
    expect(out.heading).toBeUndefined()
  })

  it('未闭合标签不崩', () => {
    expect(() => extractHtmlExcerpt('<p>没闭合')).not.toThrow()
    expect(() => extractHtmlExcerpt('<div><span><b>层层不闭合')).not.toThrow()
    expect(() => extractHtmlExcerpt('<<<<>>>>')).not.toThrow()
    expect(() => extractHtmlExcerpt('<title>没闭合的标题')).not.toThrow()
  })

  it('未闭合的 title 仍能取到标题', () => {
    expect(extractHtmlExcerpt('<title>残缺标题').heading).toBe('残缺标题')
  })

  it('未闭合的 script 把后面全部丢掉(宁可少文本,也不能把 JS 当正文)', () => {
    const out = extractHtmlExcerpt('<p>前面</p><script>var x = "LEAK"')
    expect(JSON.stringify(out)).not.toContain('LEAK')
    expect(out.paragraphs).toEqual(['前面'])
  })

  it('属性里的 > 不会提前结束标签', () => {
    const out = extractHtmlExcerpt('<p title="a > b">正文</p>')
    expect(out.paragraphs).toEqual(['正文'])
  })
})

describe('extractHtmlExcerpt — ReDoS 防护', () => {
  // 文档正文攻击者可控。任何一处开放式量词扫大字符串都可能是多项式回溯
  // (CodeQL js/polynomial-redos)。这几条钉的是**时间**,不是内容。
  const budgetMs = 1500

  it('超长未闭合 script 快速返回', () => {
    const evil = '<script>' + 'a'.repeat(400_000)
    const t0 = Date.now()
    extractHtmlExcerpt(evil)
    expect(Date.now() - t0).toBeLessThan(budgetMs)
  })

  it('超长未闭合注释快速返回', () => {
    const evil = '<!--' + 'a'.repeat(400_000)
    const t0 = Date.now()
    extractHtmlExcerpt(evil)
    expect(Date.now() - t0).toBeLessThan(budgetMs)
  })

  it('超长未闭合标签快速返回', () => {
    const evil = '<div ' + 'a'.repeat(400_000)
    const t0 = Date.now()
    extractHtmlExcerpt(evil)
    expect(Date.now() - t0).toBeLessThan(budgetMs)
  })

  it('海量 < 快速返回', () => {
    const evil = '<'.repeat(200_000)
    const t0 = Date.now()
    extractHtmlExcerpt(evil)
    expect(Date.now() - t0).toBeLessThan(budgetMs)
  })

  it('海量未闭合 style 与 title 交替快速返回', () => {
    const evil = '<style><title>'.repeat(20_000)
    const t0 = Date.now()
    extractHtmlExcerpt(evil)
    expect(Date.now() - t0).toBeLessThan(budgetMs)
  })

  it('超大文档整体有输入上限', () => {
    const t0 = Date.now()
    const out = extractHtmlExcerpt('<p>正文</p>' + 'x'.repeat(2_000_000))
    expect(Date.now() - t0).toBeLessThan(budgetMs)
    expect(out.paragraphs[0]).toBe('正文')
  })

  // ── foreign 标签扫描必须线性(HTM-003)────────────────────────────────────────
  // foreignRanges 早期实现有两条二次路径,都在攻击者可控、可达 256KiB(路由 fetch
  // 上限)的正文上触发,同步阻塞事件循环:
  //   1. 不匹配的闭标签会回溯遍历整个 open 栈 —— `<svg>`×k + `</math>`×k 时,每个
  //      `</math>` 都扫完 k 层 svg 却找不到 math,O(k²)。
  //   2. inRanges 对每个候选线性扫所有 foreign 区间 —— `<svg><title>t</title></svg>`×k
  //      有 k 个区间、k 个 <title> 候选,O(k²)。
  // 现在栈用 O(1) 的 open-name 计数拒绝无匹配闭标签,inRanges 用二分。阈值取远低于
  // 二次路径复发时的耗时(实测 256KiB 二次路径 ~500ms),若二次回来必然翻车。
  const FETCH_CAP = 256 * 1024
  const linearBudgetMs = 150

  it('256KiB 的 <svg> 栈 + </math> 洪水不触发栈回溯(仍是线性)', () => {
    // `<svg>`×k 压满栈,`</math>`×k 每个都不匹配 —— 修复前每个都回溯整栈。
    const unit = '<svg></math>'
    const evil = unit.repeat(Math.floor(FETCH_CAP / unit.length))
    const t0 = Date.now()
    const out = extractHtmlExcerpt(evil)
    const elapsed = Date.now() - t0
    // 全是标签、无正文:heading 为空、paragraphs 为空。
    expect(out).toEqual({ paragraphs: [] })
    expect(elapsed).toBeLessThan(linearBudgetMs)
  })

  it('256KiB 的 <svg><title>t</title></svg> 重复不触发 inRanges 全扫(仍是线性)', () => {
    const unit = '<svg><title>t</title></svg>'
    const evil = unit.repeat(Math.floor(FETCH_CAP / unit.length))
    const t0 = Date.now()
    const out = extractHtmlExcerpt(evil)
    const elapsed = Date.now() - t0
    // 每个 <title> 都在 svg foreign 区间内 —— 不当 heading;SVG title 文本是可见正文,
    // 会作为普通段落留下(现状契约),这里只钉时间与"标题不来自 svg title"。
    expect(out.heading).toBeUndefined()
    expect(elapsed).toBeLessThan(linearBudgetMs)
  })
})

// ── 泄漏面复核:标签属性值 / 注释 / noscript / CDATA ────────────────────────────
//
// 这一组是**逐条实测**得来的,不是照着直觉写的。每条都先跑过探针看真实输出,
// 再决定是钉住现状还是先修。结论:
//   · 属性值   —— 不泄漏(endOfTag 是 quote-aware 的,整个标签连属性一起被替换成 BLOCK_SEP)
//   · <!-- --> —— 不泄漏(stripComments 在最前面就整段摘掉)
//   · noscript —— **曾经泄漏**,已加入 DROPPED_ELEMENTS
//   · template —— **曾经泄漏**,已加入 DROPPED_ELEMENTS
//   · CDATA    —— 与浏览器一致(见该 describe 内的说明)
describe('extractHtmlExcerpt — 不该冒出来的内容', () => {
  describe('标签属性值绝不进正文', () => {
    it('双引号属性', () => {
      const out = extractHtmlExcerpt('<p data-secret="ATTRLEAK" title="TITLELEAK">正文</p>')
      expect(out.paragraphs).toEqual(['正文'])
      expect(JSON.stringify(out)).not.toContain('ATTRLEAK')
      expect(JSON.stringify(out)).not.toContain('TITLELEAK')
    })

    it('单引号属性', () => {
      const out = extractHtmlExcerpt("<p data-x='SINGLELEAK'>正文</p>")
      expect(out.paragraphs).toEqual(['正文'])
      expect(JSON.stringify(out)).not.toContain('SINGLELEAK')
    })

    it('无引号属性', () => {
      const out = extractHtmlExcerpt('<img alt=ALTLEAK src=x><p>正文</p>')
      expect(JSON.stringify(out)).not.toContain('ALTLEAK')
    })

    it('属性值里含 > 时不会被提前截断成正文', () => {
      // endOfTag 是 quote-aware 的:引号内的 '>' 不结束标签。
      // 如果不是,`b ATTRGTLEAK">` 就会漏成一个段落。
      const out = extractHtmlExcerpt('<p title="a > b ATTRGTLEAK">正文</p>')
      expect(out.paragraphs).toEqual(['正文'])
      expect(JSON.stringify(out)).not.toContain('ATTRGTLEAK')
    })

    it('meta content / style / hidden input 的值都不进正文', () => {
      const out = extractHtmlExcerpt(
        '<meta name="x" content="METALEAK"><div style="background:url(STYLEATTRLEAK)">正文</div><input type="hidden" value="HIDDENLEAK">',
      )
      const s = JSON.stringify(out)
      expect(s).not.toContain('METALEAK')
      expect(s).not.toContain('STYLEATTRLEAK')
      expect(s).not.toContain('HIDDENLEAK')
    })

    it('标题元素的属性值也不进 heading', () => {
      const out = extractHtmlExcerpt('<h1 title="H1ATTRLEAK">标题</h1>')
      expect(out.heading).toBe('标题')
      expect(JSON.stringify(out)).not.toContain('H1ATTRLEAK')
    })

    it('未闭合引号 → 整份被当作一个畸形标签吞掉,而不是把属性值吐出来', () => {
      const out = extractHtmlExcerpt('<p title="UNCLOSED>正文</p>')
      expect(JSON.stringify(out)).not.toContain('UNCLOSED')
    })
  })

  describe('<!-- --> 注释内容绝不进正文', () => {
    it('普通注释', () => {
      const out = extractHtmlExcerpt('<p>前</p><!-- COMMENTLEAK --><p>后</p>')
      expect(out.paragraphs).toEqual(['前', '后'])
      expect(JSON.stringify(out)).not.toContain('COMMENTLEAK')
    })

    it('注释里包着标签', () => {
      const out = extractHtmlExcerpt('<p>前</p><!-- <p>COMMENTTAGLEAK</p> --><p>后</p>')
      expect(out.paragraphs).toEqual(['前', '后'])
      expect(JSON.stringify(out)).not.toContain('COMMENTTAGLEAK')
    })

    it('未闭合注释吞掉其后全部内容(与浏览器一致)', () => {
      const out = extractHtmlExcerpt('<p>前</p><!-- COMMENTUNTERM <p>后</p>')
      expect(out.paragraphs).toEqual(['前'])
      expect(JSON.stringify(out)).not.toContain('COMMENTUNTERM')
    })
  })

  describe('<noscript> / <template> 内容绝不进正文', () => {
    it('noscript 是「请开启 JS」这类样板,不是正文', () => {
      const out = extractHtmlExcerpt('<p>前</p><noscript>NOSCRIPTLEAK</noscript>')
      expect(out.paragraphs).toEqual(['前'])
      expect(JSON.stringify(out)).not.toContain('NOSCRIPTLEAK')
    })

    it('noscript 里包着标签也一并丢掉', () => {
      const out = extractHtmlExcerpt('<p>前</p><noscript><p>NOSCRIPTTAGLEAK</p></noscript><p>后</p>')
      expect(JSON.stringify(out)).not.toContain('NOSCRIPTTAGLEAK')
      expect(out.paragraphs).toEqual(['前', '后'])
    })

    it('template 内容浏览器根本不渲染,摘要更不该显示', () => {
      const out = extractHtmlExcerpt('<p>前</p><template>TEMPLATELEAK</template><p>后</p>')
      expect(JSON.stringify(out)).not.toContain('TEMPLATELEAK')
      expect(out.paragraphs).toEqual(['前', '后'])
    })

    it('noscript 里的 script 不会因为嵌套而漏出来', () => {
      const out = extractHtmlExcerpt('<noscript><script>var a="NESTEDLEAK"</script></noscript><p>正文</p>')
      expect(JSON.stringify(out)).not.toContain('NESTEDLEAK')
    })

    it('未闭合 noscript 丢掉其后全部内容(与 script/style 同一 fail-safe 方向)', () => {
      const out = extractHtmlExcerpt('<p>前</p><noscript>UNTERMLEAK<p>后</p>')
      expect(out.paragraphs).toEqual(['前'])
      expect(JSON.stringify(out)).not.toContain('UNTERMLEAK')
    })
  })

  describe('CDATA', () => {
    /**
     * ★ 这里**故意不做特殊处理**,因为当前行为已经与浏览器一致。
     *
     * HTML(非 foreign content)里 `<![CDATA[` 不是 CDATA:tokenizer 走 markup
     * declaration open → 既不是 `--` 也不是 `DOCTYPE` → **bogus comment**,一直吃到
     * 第一个 `>`。我们的 endOfTag 做的正是同一件事。
     *
     * 所以:CDATA 里不含 `>` 时整段被吃掉;含 `>` 时 `>` 之后的部分是**可见文本**——
     * 浏览器也这么显示。跟着浏览器走是对的,自作聪明地按 XML 语义解 CDATA 反而会
     * 隐藏真实读者看得见的内容。
     */
    it('不含 > 的 CDATA 整段被吃掉', () => {
      const out = extractHtmlExcerpt('<p>前</p><![CDATA[CDATALEAK]]><p>后</p>')
      expect(out.paragraphs).toEqual(['前', '后'])
      expect(JSON.stringify(out)).not.toContain('CDATALEAK')
    })

    it('含 > 的 CDATA:> 之后是可见文本,与浏览器 bogus-comment 解析一致', () => {
      const out = extractHtmlExcerpt('<p>前</p><![CDATA[a > CDATAGTLEAK]]><p>后</p>')
      // 钉住现状:这不是泄漏,浏览器同样会把它显示出来。
      expect(out.paragraphs).toEqual(['前', 'CDATAGTLEAK]]>', '后'])
    })
  })

  describe('DOCTYPE / 处理指令', () => {
    it('DOCTYPE 与 <?xml ?> 都不进正文', () => {
      const out = extractHtmlExcerpt('<!DOCTYPE html><?xml version="1.0" PILEAK?><p>正文</p>')
      expect(out.paragraphs).toEqual(['正文'])
      expect(JSON.stringify(out)).not.toContain('PILEAK')
    })
  })
})

// ── 第 3 轮:dropped 元素的「终止语义」按解析类别区分 ──────────────────────────
//
// 本组的核心断言不是「丢掉多少」,而是**丢的边界和浏览器一致**。两类元素的终止
// 规则不同,统一处理必然错一边:
//   · raw text(script/style/noscript,scripting 开启):内部不再解析标签,
//     第一个同名闭标签即终止 —— 深度匹配会吃掉后面的真实正文。
//   · 可嵌套(template):正常元素,children 当 markup 解析,必须数深度 ——
//     只找第一个闭标签会被内层提前关掉,尾巴泄漏成正文。
//
// 下面每条的期望值都对照真实解析器(JSDOM)的可见文本核对过。
describe('extractHtmlExcerpt — dropped 元素的嵌套终止语义', () => {
  describe('template:可嵌套,必须深度匹配', () => {
    it('嵌套 template 的尾巴不泄漏(内层闭标签不得提前关掉外层)', () => {
      // 真实浏览器:body.textContent === '前后',TAIL_LEAK 不可见。
      const out = extractHtmlExcerpt('<p>前</p><template>OUTER<template>INNER</template>TAIL_LEAK</template><p>后</p>')
      expect(out.paragraphs).toEqual(['前', '后'])
      expect(JSON.stringify(out)).not.toContain('TAIL_LEAK')
      expect(JSON.stringify(out)).not.toContain('OUTER')
      expect(JSON.stringify(out)).not.toContain('INNER')
    })

    it('三层嵌套 template 全部丢掉,每层的尾巴都不漏', () => {
      const out = extractHtmlExcerpt('<p>A</p><template>1<template>2<template>3</template>L3</template>L2</template><p>B</p>')
      expect(out.paragraphs).toEqual(['A', 'B'])
      expect(JSON.stringify(out)).not.toContain('L2')
      expect(JSON.stringify(out)).not.toContain('L3')
    })

    it('template 里 script 内的假闭标签不算数(raw text 内容是字符,不是 markup)', () => {
      // `</template>` 写在 script 体里是 JS 源码。真实浏览器可见文本 = 'AB'。
      const out = extractHtmlExcerpt('<p>A</p><template><script>var x="</template>";</script>INSIDE</template><p>B</p>')
      expect(out.paragraphs).toEqual(['A', 'B'])
      expect(JSON.stringify(out)).not.toContain('INSIDE')
    })

    it('未闭合的嵌套 template 丢掉其后全部(fail-safe 方向不变)', () => {
      const out = extractHtmlExcerpt('<p>前</p><template>A<template>B</template>TAIL')
      expect(out.paragraphs).toEqual(['前'])
      expect(JSON.stringify(out)).not.toContain('TAIL')
    })
  })

  describe('raw text(script/style/noscript):第一个闭标签即终止 —— 回归钉死', () => {
    it('script 体里出现 <script> 字样不产生嵌套,仍按第一个 </script> 收', () => {
      // HTML 规范:script 是 raw text,内部不解析标签。若误改成深度匹配,
      // 这里会因为「找不到第二个 </script>」而把 <p>B</p> 一起吃掉。
      const out = extractHtmlExcerpt('<p>A</p><script>var s="<script>";</script><p>B</p>')
      expect(out.paragraphs).toEqual(['A', 'B'])
      expect(JSON.stringify(out)).not.toContain('var s')
    })

    it('style 体里出现 <style> 字样同理', () => {
      const out = extractHtmlExcerpt('<p>A</p><style>/* <style> */ .x{}</style><p>B</p>')
      expect(out.paragraphs).toEqual(['A', 'B'])
      expect(JSON.stringify(out)).not.toContain('.x{}')
    })

    it('noscript 不嵌套:第一个 </noscript> 之后是**可见正文**,不能吞掉', () => {
      // 实测(scripting 开启,即预览消费方的运行方式):DOM 里只有一个 noscript,
      // 其内容是字面文本 `O<noscript>I`,NS_LEAK 是可见 body 文本。
      // 若对 noscript 做深度匹配,NS_LEAK 会被误丢 —— 那是丢失真实正文。
      const out = extractHtmlExcerpt('<p>A</p><noscript>O<noscript>I</noscript>NS_LEAK</noscript><p>B</p>')
      expect(out.paragraphs).toEqual(['A', 'NS_LEAK', 'B'])
    })
  })
})

// ── 第 3 轮:heading 只认 HTML 文档标题,不认外来内容里的 <title> ──────────────
//
// SVG/MathML 的 <title> 是无障碍标签(相当于 tooltip),不是文档标题:真实解析器
// 对 `<svg><title>X</title></svg>` 报 document.title === ''。把它放进卡片标题位
// 等于凭空发明一个文档从没有过的标题。
//
// 注意边界:**只排除 <title> 作为 heading 候选,不丢弃 svg/math 子树** ——
// SVG <text>、<foreignObject> 里的内容是真实可见正文,丢掉会漏正文。
describe('extractHtmlExcerpt — svg/math 里的 <title> 不是文档标题', () => {
  it('svg title 不被选为 heading', () => {
    const out = extractHtmlExcerpt('<svg><title>SVG_TITLE</title></svg><p>正文第一段</p>')
    expect(out.heading).toBeUndefined()
    expect(out.paragraphs).toContain('正文第一段')
  })

  it('math title 同理', () => {
    const out = extractHtmlExcerpt('<math><title>MATH_TITLE</title></math><p>正文</p>')
    expect(out.heading).toBeUndefined()
  })

  it('svg title 之后有 h1 时,heading 回落到 h1', () => {
    const out = extractHtmlExcerpt('<svg><title>SVG_TITLE</title></svg><h1>真H1</h1><p>正文</p>')
    expect(out.heading).toBe('真H1')
  })

  it('嵌套 svg 里的 title 也不算(深度匹配,内层闭标签不提前结束外层)', () => {
    const out = extractHtmlExcerpt('<svg><svg><title>INNER_SVG</title></svg><title>OUTER_SVG</title></svg><h1>真H1</h1>')
    expect(out.heading).toBe('真H1')
  })

  it('正常 <head><title> 仍然生效', () => {
    const out = extractHtmlExcerpt('<html><head><title>真标题</title></head><body><p>正文</p></body></html>')
    expect(out.heading).toBe('真标题')
    expect(out.paragraphs).toEqual(['正文'])
  })

  it('svg 自闭合后的 <title> 是文档标题(<svg/> 不圈住任何东西)', () => {
    const out = extractHtmlExcerpt('<svg/><title>REAL_TITLE</title><p>正文</p>')
    expect(out.heading).toBe('REAL_TITLE')
  })

  it('SVG <text> 是可见正文,必须仍然进 paragraphs(不得整体丢弃 svg 子树)', () => {
    const out = extractHtmlExcerpt('<svg><title>T</title><text>VISIBLE_SVG_TEXT</text></svg><p>正文</p>')
    expect(out.paragraphs).toContain('VISIBLE_SVG_TEXT')
    expect(out.paragraphs).toContain('正文')
  })

  it('foreignObject 里的 h1 是可见内容,仍可作 heading', () => {
    const out = extractHtmlExcerpt('<svg><foreignObject><h1>FO_H1</h1></foreignObject></svg><p>正文</p>')
    expect(out.heading).toBe('FO_H1')
  })

  it('未闭合 <svg> 之后的 title 不当标题(解析器视其为圈住文档剩余部分)', () => {
    const out = extractHtmlExcerpt('<p>正文</p><svg><title>SVG_TITLE</title>')
    expect(out.heading).toBeUndefined()
  })
})

// ── foreignObject 是 HTML integration point ───────────────────────────────────
// `<foreignObject>` 内部退出 SVG 命名空间、回到 HTML 命名空间,所以它里面的
// `<title>` **就是** document.title。真实解析器(JSDOM)确认:
//   <svg><foreignObject><title>X</title></foreignObject></svg>  → document.title === 'X'
//   <svg><title>X</title></svg>                                 → document.title === ''
// 早期实现把整个 <svg>…</svg> 无条件当 foreign,把这个真标题误杀成了普通段落。
// 同位置的 <h1> 一直是正确的(只有 <title> 走 foreign ranges),两者行为不一致
// 本身就是这个 bug 的证据。
describe('extractHtmlExcerpt — foreignObject 内的 <title> 是真标题', () => {
  it('foreignObject 里的 title 当 heading(与同位置 h1 行为一致)', () => {
    const out = extractHtmlExcerpt('<svg><foreignObject><title>FO_TITLE</title></foreignObject></svg><p>正文</p>')
    expect(out.heading).toBe('FO_TITLE')
    expect(out.paragraphs).toEqual(['正文'])
  })

  it('foreignObject 深层嵌套里的 title 仍是真标题,同 svg 内它之后的 title 仍是 a11y 标签', () => {
    const out = extractHtmlExcerpt(
      '<svg><g><foreignObject><div><title>DEEP</title></div></foreignObject></g><title>LABEL</title></svg><p>正文</p>',
    )
    expect(out.heading).toBe('DEEP')
    // LABEL 不是标题,但它是 svg <title> 文本,仍作为普通文本块留在正文里
    expect(out.paragraphs).toContain('LABEL')
  })

  it('未闭合 foreignObject:其后的 title 仍是真标题(退出 foreign 状态一直延续)', () => {
    const out = extractHtmlExcerpt('<svg><foreignObject><title>FO_TITLE</title><p>正文</p>')
    expect(out.heading).toBe('FO_TITLE')
  })

  it('foreignObject 内再嵌 svg:重新进入 foreign,内层 title 不是标题(必须是栈,不是布尔)', () => {
    const out = extractHtmlExcerpt(
      '<svg><foreignObject><svg><title>INNER_LABEL</title></svg></foreignObject></svg><p>正文</p>',
    )
    expect(out.heading).toBeUndefined()
    expect(out.paragraphs).toContain('INNER_LABEL')
  })

  it('foreignObject 自闭合:不圈出 HTML 洞,其后 svg 内的 title 仍不是标题', () => {
    const out = extractHtmlExcerpt('<svg><foreignObject/><title>LABEL</title></svg><p>正文</p>')
    expect(out.heading).toBeUndefined()
  })

  it('foreignObject 闭合后回到 foreign:其后 svg 内的 title 不是标题', () => {
    const out = extractHtmlExcerpt('<svg><foreignObject><p>X</p></foreignObject><title>LABEL</title></svg><p>正文</p>')
    expect(out.heading).toBeUndefined()
  })
})

// ── 非标签语境里的字面 <svg> 不得伪造 foreign 区间 ────────────────────────────
// 属性值里的 `<svg>` 不是开标签。早期实现用裸 indexOf('<svg') 找 foreign 根,
// 把它当成真开标签,开出一个假区间,把后面的**真** <title> 圈进去降级成段落。
// 修法:寻找 foreign 根标签复用文件里已有的引号感知 endOfTag 语义。
describe('extractHtmlExcerpt — 属性值里的 <svg> 不伪造 foreign 区间', () => {
  it('双引号属性值含 <svg>:其后的真 title 仍是 heading', () => {
    const out = extractHtmlExcerpt('<div data-x="<svg>"><title>REAL_TITLE</title></div><p>正文</p>')
    expect(out.heading).toBe('REAL_TITLE')
  })

  it('单引号属性值含 <svg>:同理', () => {
    const out = extractHtmlExcerpt("<div data-x='<svg>'><title>REAL_TITLE</title></div><p>正文</p>")
    expect(out.heading).toBe('REAL_TITLE')
  })

  it('无引号属性值含 <svg>:同理', () => {
    const out = extractHtmlExcerpt('<div data-x=<svg>><title>REAL_TITLE</title></div><p>正文</p>')
    expect(out.heading).toBe('REAL_TITLE')
  })

  it('属性值里的 <math> 同样不伪造区间', () => {
    const out = extractHtmlExcerpt('<div data-x="<math>"><title>REAL_TITLE</title></div><p>正文</p>')
    expect(out.heading).toBe('REAL_TITLE')
  })

  it('正文里的裸 < 不吞掉其后的真 title', () => {
    const out = extractHtmlExcerpt('<p>a < b</p><title>REAL_TITLE</title><p>正文</p>')
    expect(out.heading).toBe('REAL_TITLE')
  })

  it('孤立的 </svg> 闭标签不影响其后的真 title', () => {
    const out = extractHtmlExcerpt('</svg><title>REAL_TITLE</title><p>正文</p>')
    expect(out.heading).toBe('REAL_TITLE')
  })

  it('<script> 内的 <svg> 字面量不伪造区间(区间计算前已剥离)', () => {
    const out = extractHtmlExcerpt('<script>var s = "<svg>"</script><title>REAL_TITLE</title><p>正文</p>')
    expect(out.heading).toBe('REAL_TITLE')
  })

  it('注释内的 <svg> 不伪造区间(区间计算前已剥离)', () => {
    const out = extractHtmlExcerpt('<!-- <svg> --><title>REAL_TITLE</title><p>正文</p>')
    expect(out.heading).toBe('REAL_TITLE')
  })
})

// ── 第 5 轮 / P1-HIGH:inline 标签不得把一个段落打碎 ──────────────────────────
//
// 这是评审抓到的真实阻塞缺陷,已在 head 上逐条复现。早期实现在**每个标签**处注入
// BLOCK_SEP,而段落路径按 BLOCK_SEP 切分,于是任何带行内格式的段落都会被切碎:
//
//   <p>Welcome to <b>Octo Docs</b>, the future of <a href="#">writing</a>.</p>
//   → ["Welcome to", "Octo Docs", ", the future of"]        ← 一句碎成三片
//
// 而且因为卡片只取 MAX_PARAGRAPHS=3 段,碎片把配额吃满,句尾 "writing." 与其后
// **所有段落**一起丢失。真实富文本文档首段几乎必然带 <b>/<i>/<a>/<span>,所以这是
// 常见场景全中,不是边角。前四轮测试全绿只是因为用例里的 <p> 都不带行内格式。
//
// heading 路径当时侥幸没事:firstElementText 是**先剥标签再归一**,
// normalizeWhitespace 把 BLOCK_SEP 当空白折叠掉了;段落路径是**先切分后归一**,
// 所以只有它中招 —— 两条路径行为不一致本身就是这个 bug 的证据。
//
// 修法:只在**块级**边界注入分隔符(BLOCK_LEVEL),inline 标签透明。
describe('extractHtmlExcerpt — inline 标签不打碎段落', () => {
  it('★ 回归:<b> + <a> 的段落是**一整段**,句尾不丢', () => {
    const out = extractHtmlExcerpt('<p>Welcome to <b>Octo Docs</b>, the future of <a href="#">writing</a>.</p>')
    expect(out.paragraphs).toEqual(['Welcome to Octo Docs, the future of writing.'])
  })

  it('★ 回归:inline 碎片不得挤掉后面的真段落', () => {
    const out = extractHtmlExcerpt('<p>Hello <span>world</span> again</p><p>Second para</p>')
    expect(out.paragraphs).toEqual(['Hello world again', 'Second para'])
  })

  it('常见行内格式集合都透明:em/strong/code/i/small/sub/sup/mark', () => {
    const out = extractHtmlExcerpt(
      '<p>use <code>foo()</code> with <em>care</em> and <strong>bar</strong>, see <i>x</i><sub>1</sub><sup>2</sup> <mark>m</mark> <small>s</small>.</p>',
    )
    expect(out.paragraphs).toEqual(['use foo() with care and bar, see x12 m s.'])
  })

  it('嵌套 inline 不碎(<b><i><span>)', () => {
    const out = extractHtmlExcerpt('<p><b><i><span>deep</span></i></b> tail</p>')
    expect(out.paragraphs).toEqual(['deep tail'])
  })

  it('inline 元素紧贴文字时不注入空格(<b>x</b> 前后本就相连)', () => {
    // 浏览器渲染成 "abc" 一个词,不是 "a b c"。
    expect(extractHtmlExcerpt('<p>a<b>b</b>c</p>').paragraphs).toEqual(['abc'])
  })

  it('<img> 是行内的,不切断句子', () => {
    expect(extractHtmlExcerpt('<p>a <img src="x.png"> b</p>').paragraphs).toEqual(['a b'])
  })

  it('未知/自定义元素默认按 inline 处理(与浏览器对未识别标签一致)', () => {
    expect(extractHtmlExcerpt('<p>a <my-widget>b</my-widget> c</p>').paragraphs).toEqual(['a b c'])
  })

  it('inline 里的 <br> 仍然分段(块级判定是逐标签的,不依赖配对)', () => {
    expect(extractHtmlExcerpt('<p><b>a<br>b</b></p>').paragraphs).toEqual(['a', 'b'])
  })

  it('★ 副作用一并消失:h1 的内容不再重复吐进 paragraphs', () => {
    // 修前:{"heading":"Hello World","paragraphs":["Hello","World","Body"]}
    // ——h1 的文本被切碎后不等于 heading,躲过了「跳过 heading 块」那一步。
    const out = extractHtmlExcerpt('<h1>Hello <b>World</b></h1><p>Body</p>')
    expect(out.heading).toBe('Hello World')
    expect(out.paragraphs).toEqual(['Body'])
  })

  it('带 inline 的完整文档:三段都完整,不被碎片挤占', () => {
    const html = `<!doctype html><html><head><title>季度复盘</title></head><body>
      <p>第一段带<b>加粗</b>与<a href="#">链接</a>。</p>
      <p>第二段带<em>强调</em>。</p>
      <p>第三段。</p>
      <p>第四段不要。</p>
    </body></html>`
    const out = extractHtmlExcerpt(html)
    expect(out.heading).toBe('季度复盘')
    expect(out.paragraphs).toEqual(['第一段带加粗与链接。', '第二段带强调。', '第三段。'])
  })
})

// ── 第 5 轮 / P1 回归:块级元素必须仍然分段 ───────────────────────────────────
// 上面把「一律分段」收窄成「块级才分段」,这组把**没被收窄掉**的那一半钉死。
describe('extractHtmlExcerpt — 块级元素仍然分段', () => {
  it('<br> 分段(void 元素,没有 </br> 可配对)', () => {
    expect(extractHtmlExcerpt('<p>one<br>two</p>').paragraphs).toEqual(['one', 'two'])
    expect(extractHtmlExcerpt('<p>one<br/>two</p>').paragraphs).toEqual(['one', 'two'])
  })

  it('<li> 分段', () => {
    expect(extractHtmlExcerpt('<ul><li>alpha</li><li>beta</li></ul>').paragraphs).toEqual(['alpha', 'beta'])
    expect(extractHtmlExcerpt('<ol><li>a</li><li>b</li></ol>').paragraphs).toEqual(['a', 'b'])
  })

  it('<td>/<th>/<tr> 分段', () => {
    expect(extractHtmlExcerpt('<table><tr><td>c1</td><td>c2</td></tr></table>').paragraphs).toEqual(['c1', 'c2'])
    expect(extractHtmlExcerpt('<table><tr><th>h1</th><th>h2</th></tr></table>').paragraphs).toEqual(['h1', 'h2'])
  })

  it('<div> 分段', () => {
    expect(extractHtmlExcerpt('<div>d1</div><div>d2</div>').paragraphs).toEqual(['d1', 'd2'])
  })

  it('其余块级:hr / blockquote / pre / section / dt+dd / figcaption', () => {
    expect(extractHtmlExcerpt('<p>a</p><hr><p>b</p>').paragraphs).toEqual(['a', 'b'])
    expect(extractHtmlExcerpt('<blockquote>q</blockquote><p>p</p>').paragraphs).toEqual(['q', 'p'])
    expect(extractHtmlExcerpt('<pre>code</pre><p>after</p>').paragraphs).toEqual(['code', 'after'])
    expect(extractHtmlExcerpt('<section>s</section><article>a</article>').paragraphs).toEqual(['s', 'a'])
    expect(extractHtmlExcerpt('<dl><dt>t</dt><dd>d</dd></dl>').paragraphs).toEqual(['t', 'd'])
    expect(extractHtmlExcerpt('<figure><figcaption>cap</figcaption></figure><p>x</p>').paragraphs).toEqual(['cap', 'x'])
  })

  it('SVG <text> 是分开定位的文本框,不得被粘成一个词(SVG 的 inline 单位是 tspan)', () => {
    expect(extractHtmlExcerpt('<svg><text>A</text><g><text>B</text></g></svg>').paragraphs).toEqual(['A', 'B'])
  })

  it('相邻块级之间的文字不会跨块粘连', () => {
    expect(extractHtmlExcerpt('<p>前</p><p>后</p>').paragraphs).toEqual(['前', '后'])
  })
})

// ── 第 5 轮 / P2-MEDIUM:正文里的裸 `<` 不得吞掉后文 ──────────────────────────
//
// stripTags 原来用裸 indexOf('<') 找标签起点,于是 `5 < 10` 的 `<` 被当成标签开始,
// 一路吃到下一个 `>`;若后面根本没有 `>`,整段剩余全丢:
//
//   <p>Threshold: 5 < 10 percent.</p>        → ["Threshold: 5"]
//   <p>Value is 5 < 10 and more text</p>     → ["Value is 5"]
//
// 浏览器 tokenizer 的 data state 规则:`<` 只有在后面跟字母 / `/`+字母 / `!` / `?`
// 时才是标记,否则就是普通文本。文件里第 4 轮已为 foreignRanges 写了 startsTag /
// nextTagStart(注释里就写着这个场景),这轮让 stripTags 走同一套,不另起炉灶。
describe('extractHtmlExcerpt — 正文里的裸 < 不吞后文', () => {
  it('★ 回归:5 < 10 完整保留', () => {
    expect(extractHtmlExcerpt('<p>Threshold: 5 < 10 percent.</p>').paragraphs).toEqual(['Threshold: 5 < 10 percent.'])
  })

  it('★ 回归:后面没有 > 时剩余文本不丢', () => {
    const out = extractHtmlExcerpt('<p>Value is 5 < 10 and more text follows here</p>')
    expect(out.paragraphs).toEqual(['Value is 5 < 10 and more text follows here'])
  })

  it('纯文本里的裸 < 同样保留', () => {
    expect(extractHtmlExcerpt('Value is 5 < 10 and nothing else').paragraphs).toEqual(['Value is 5 < 10 and nothing else'])
  })

  it('`<` 后跟数字/空格/末尾都算普通文本', () => {
    expect(extractHtmlExcerpt('<p>1<2 and 3 < 4</p>').paragraphs).toEqual(['1<2 and 3 < 4'])
    expect(extractHtmlExcerpt('<p>trailing <').paragraphs).toEqual(['trailing <'])
  })

  it('裸 < 之后的真标签仍被正确识别为标签(不是被当文本吐出来)', () => {
    const out = extractHtmlExcerpt('<p>a < b</p><p>c</p>')
    expect(out.paragraphs).toEqual(['a < b', 'c'])
    expect(JSON.stringify(out)).not.toContain('<p>')
  })

  it('裸 < 不得让 script/style/noscript/template 的剥离失效', () => {
    // 若 `<` 被当成标签起点吃到下一个 `>`,可能跨过 <script> 的开标签 → JS 泄漏。
    expect(JSON.stringify(extractHtmlExcerpt('<p>5 < 10 <script>SLEAK</script>tail</p>'))).not.toContain('SLEAK')
    expect(JSON.stringify(extractHtmlExcerpt('<p>a < b</p><style>.x{content:"YLEAK"}</style><p>c</p>'))).not.toContain('YLEAK')
    expect(JSON.stringify(extractHtmlExcerpt('<p>a < b</p><noscript>NLEAK</noscript><p>c</p>'))).not.toContain('NLEAK')
    expect(JSON.stringify(extractHtmlExcerpt('<p>a < b</p><template>TLEAK</template><p>c</p>'))).not.toContain('TLEAK')
  })

  it('裸 < 不得让注释剥离失效', () => {
    const out = extractHtmlExcerpt('<p>a < b <!-- CLEAK --> d</p>')
    expect(JSON.stringify(out)).not.toContain('CLEAK')
    expect(out.paragraphs).toEqual(['a < b d'])
  })

  it('实体 &lt; 行为不变:解码成 <,且不被当作标签起点', () => {
    expect(extractHtmlExcerpt('<p>A &amp; B &lt;tag&gt;</p>').paragraphs[0]).toBe('A & B <tag>')
    expect(extractHtmlExcerpt('<p>a &lt; b</p><p>c</p>').paragraphs).toEqual(['a < b', 'c'])
  })

  it('属性值里的 > 仍不提前结束标签(第 2 轮守卫不变)', () => {
    expect(extractHtmlExcerpt('<p title="a > b">正文</p>').paragraphs).toEqual(['正文'])
  })

  it('未闭合引号仍把剩余当畸形标签吞掉,不吐属性值(第 2 轮守卫不变)', () => {
    expect(JSON.stringify(extractHtmlExcerpt('<p title="UNCLOSED>正文</p>'))).not.toContain('UNCLOSED')
  })

  it('裸 < 的 ReDoS 边界:大量裸 < 仍是线性', () => {
    const evil = '<p>' + 'a < b '.repeat(50_000) + '</p>'
    const t0 = Date.now()
    extractHtmlExcerpt(evil)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

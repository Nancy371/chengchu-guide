---
name: 澄初 AI 金牌导购
description: 像护理顾问咨询单一样克制、清楚、可追溯的导购界面。
colors:
  ink-deep: "#0c3042"
  ink: "#123f55"
  teal: "#3f8b87"
  teal-soft: "#dcebe7"
  paper: "#f7f5ef"
  sheet: "#fffefa"
  rule: "#d8ded9"
  muted: "#667579"
  danger: "#a3473f"
typography:
  display:
    fontFamily: 'Georgia, "Songti SC", serif'
    fontSize: "clamp(22px, 3vw, 30px)"
    fontWeight: 500
    lineHeight: 1.25
  body:
    fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.85
  label:
    fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "11px"
    fontWeight: 750
    letterSpacing: "0.08em"
rounded:
  panel: "16px"
  control: "12px"
  pill: "999px"
  brand-mark: "50%"
motion:
  ease: "cubic-bezier(0.16, 1, 0.3, 1)"
  enter: "520ms"
  quick: "240ms"
motion:
  turn-entry: "translateY(10px) → 0, 500ms cubic-bezier(0.16,1,0.3,1)"
  inline-rise: "translateY(6px) → 0, 400–450ms cubic-bezier(0.16,1,0.3,1), 50–70ms stagger"
  thinking-dots: "1s ease-in-out, 150ms stagger"
spacing:
  xs: "8px"
  sm: "12px"
  md: "18px"
  lg: "28px"
  xl: "44px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    height: "42px"
  input:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink-deep}"
    rounded: "{rounded.control}"
    padding: "12px 13px"
  quick-answer:
    backgroundColor: "#f4faf7"
    borderColor: "#5f9490"
    textColor: "{colors.ink-deep}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  consultation-sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink-deep}"
    rounded: "0px"
---

# Design System: 澄初 AI 金牌导购

## Overview

**Creative North Star: “护理咨询单”**

界面像一张由顾客和导购共同完成的纸面咨询记录。它优先呈现事实、取舍和下一步，视觉克制，密度适中，不使用营销摄影来制造购买压力。

深蓝墨色负责结论和价格，灰绿色负责状态与依据，暖白纸面承担长时间阅读。推荐区通过横向分隔和一致的列关系形成秩序。

**Key Characteristics:**

- 暖白纸面与深蓝墨色
- 对话即记录，商品即行项目
- 细规则线建立结构，不依赖卡片堆叠
- 安全、价格和依据始终可追溯

## Colors

主色像深蓝墨水，辅助色像护理顾问的灰绿批注，背景保持温和的纸张白。

### Primary

- **澄初深墨**：用于品牌、主标题、价格和主要动作。
- **批注青绿**：用于已核实状态、依据入口和轻量强调。

### Neutral

- **暖纸白**：页面背景，降低连续咨询的视觉疲劳。
- **咨询单白**：对话工作面和抽屉表面。
- **规则灰**：分隔行、输入边界和工作面轮廓。
- **说明灰**：次要说明和来源信息。

**The Ink Hierarchy Rule.** 只有结论、价格和可执行动作使用深墨；辅助解释退到说明灰。

**The Contrast Rule.** 所有 11–13px 的正文级文字（原话引用、资料来源、商品说明）对比度不低于 4.5:1；快速回答选项和输入框的边界不低于 3:1。`--subtle` 与 `--choice-border` 因此比早期取值更深。

## Typography

**Display Font:** Georgia 与 Songti SC 回退组合  
**Body Font:** Noto Sans SC、PingFang SC、Microsoft YaHei 与系统无衬线回退组合

**Character:** 衬线标题提供纸面咨询记录的稳重感；无衬线正文确保连续对话、价格和规则说明易读。

### Hierarchy

- **Display**：中等字重的响应式标题，只用于页面和抽屉主标题。
- **Title**：14–25px，区分咨询单、商品名称和面板标题。
- **Body**：15px、1.85 行高，用于导购回复；每条回复保持可快速扫读。
- **Label**：10–12px，用于输入标签、状态、SKU 和版本信息。

**The One Display Voice Rule.** 页面标题和主要分区标题使用衬线，其余信息统一使用正文无衬线。

**The Measure Rule.** 导购回复和邀请文案的每行宽度固定在 38em（约 38 个汉字），商品说明 44ch。中文使用 `word-break: keep-all`，断行优先落在标点上，避免在词中间断开。

## Layout

桌面采用摘要栏与 820px 对话工作面组成的双列布局，工作面内依次是标题、对话记录和固定输入区。咨询单摘要在滚动时保持可见。

800px 以下切换为单列，隐藏摘要栏与非必要的头部动作，保留品牌、依据入口、对话和输入。顶部只留品牌与两个方形图标动作（我的偏好、我参考了什么），品牌名称不换行。

移动端把“我记下的需求”压缩成输入区上方的一行横向标签（`--r-control` 直角标签，右端渐隐提示可横向滚动），最后一项是“全部依据”。桌面端仍使用左侧摘要栏，并在超过 6 项时给出“还有 N 项在‘我参考了什么’里”的入口，不再静默截断。

推荐行在 800px 以下折叠为两列（商品事实 + 价格），去掉序号列，理由与限制自然换行。

空间以 8、12、18、28、44px 为主要节奏；相邻事实紧凑，轮次和主要区域之间留出更明显的间距。

## Elevation & Depth

**The One Elevation Rule.** 每个元素只声明一次层级，边界与阴影不叠加。

- **只给阴影**：浮在纸面之上的表面（对话工作面、输入 Dock、抽屉）。阴影染成墨色系，不用中性黑。
- **只给边界**：嵌在页面里的表面（左侧摘要栏、快捷入口磁贴）。
- **只给底色**：漂浮表面内部的内容块（商品卡使用 `--surface-inset` 的淡青绿底）。

「1px 细线压在宽而软的阴影上」是最容易出现的假卡片；任何元素同时具备边界和阴影都要改掉一个。

## Shapes

圆角只有一套规则，页面内不得混用：

- `--r-lg`（16px）：工作面、商品卡片、输入 Dock、抽屉的外缘。
- `--r-sm`（12px）：按钮、输入框、图标动作。
- `--r-pill`（999px）：快速回答、状态、轮次计数、标签。
- 圆形：品牌标记使用接近水滴的圆形轮廓；导购形象使用素材自身的轮廓。

阴影统一染成墨色系（`--shadow-soft` / `--shadow-lift` / `--shadow-dock`），不用中性黑；快速回答回到胶囊形，读起来像一句句可点的回复，而不是纸面勾选。

## 导购形象

导购的形象来自品牌自己的 2D 形象页，一律用同一张脸，出现在三处。

| 位置 | 尺寸 | 取景 |
| --- | --- | --- |
| 顶栏徽标（取代原“澄”字水滴章） | 40px（移动端 36px） | `guide-mark.png`，紧凑头肩 |
| 欢迎位 | 96px（移动端 74px） | `guide-portrait.png`，含发髻、花与肩线 |
| 每轮回复头像 | 34px | `guide-mark.png` |

- **源文件**：`design/guide-character-source.png`（品牌提供，仓库内留档）。
- **派生资源**：`public/guide-mark.png`（330×330）与 `public/guide-portrait.png`（400×400），由 `design/derive-guide-images.py` 裁切，`python3 design/derive-guide-images.py` 可复现。
- **取景**：原画本身就用圆形相框裁切人物，界面沿用同一套取景，因此圆形边框来自素材而非另加的几何遮罩。裁切坐标写在派生脚本里，改构图只改脚本。
- **缺图回退**：资源不存在时自动显示“澄”字徽记，布局不会塌陷或出现破图。这是真实回退，不是占位插画。

**The One Face Rule.** 三个位置必须来自同一张原画；不要为正圆另画一张脸，也不要混入其它风格的人物。

## Components

### Buttons

- **Primary:** 深墨到青绿的渐变背景、白色图标或文字、12px 圆角。
- **Hover / Focus:** 背景加深；键盘焦点使用青绿色焦点环。
- **Ghost:** 透明背景，悬停时使用浅青绿色表面。

### Cards / Containers

- **Consultation sheet:** 咨询单白背景、1px 规则灰轮廓、18px 圆角、柔和阴影，浮在带轻微色晕的纸面上。
- **Product card:** 商品序号放进圆形徽标，商品事实用胶囊标签呈现，价格放进浅青绿价格块；组合总价用青绿渐变条收尾。
- **Evidence drawer:** 作为受保护的核查空间，内部继续使用行与折叠分区。

### Inputs / Fields

- **Style:** 白色背景、细边框、12px 圆角，文本区随内容增长但限制最大高度；输入区是悬浮的 Dock（`composer-card`），聚焦时边界转为青绿。
- **Focus:** 青绿色边框和焦点环；插入符使用青绿色。
- **Disabled:** 降低透明度并保留结构。

### Quick answers

- **Style:** 胶囊选项，浅灰绿底、青绿边界、深墨文字；悬停整颗填充青绿；“自己说”使用虚线边界。
- **Behavior:** 只有最新一轮的答案可点击；点击即提交文字，描述与说话方式保持一致。

### Navigation

顶部只保留品牌、资料加载状态、我的偏好、从头聊和推荐依据。状态点跟随真实状态：资料加载完成后为青绿，服务不可用时转为深红。移动端隐藏状态与“从头聊”，只留两个 38px 方形图标动作，避免压缩核心动作。

### 依据抽屉

- 没有可展开内容时，抽屉显示一个虚线空状态，说明这里会记录什么，而不是让入口变成不可点击的死按钮。

### Recommendation Row

商品以卡片呈现：SKU 徽标、名称、理由标签和价格块在同一行系统中；组合总价在列表末尾右对齐，使用等宽感更强的衬线数字。

## Do's and Don'ts

### Do:

- **Do** 让商品事实、金额和限制在同一视觉上下文中出现。
- **Do** 使用规则线、列关系和留白建立层级。
- **Do** 在移动端优先保留对话、回复和输入。
- **Do** 让动效只说明状态变化：新轮次、新选项、新事实、推荐行依次进入，并遵守 `prefers-reduced-motion`。
- **Do** 让价格和数字使用等宽数字（`font-variant-numeric: tabular-nums`）。

### Don't:

- **Don't** 用营销摄影、场景插画或装饰纹理**代替商品事实**。品牌形象是人物标识，可以用；商品事实仍然只能来自手册。
- **Don't** 用侧边色条、英文眉题或渐变文字制造强调。
- **Don't** 为了动画而动画；出现时长超过 500ms 或无法说明用途的动效一律去掉。

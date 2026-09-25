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
  control: "3px"
  compact: "4px"
  brand-mark: "50%"
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

## Layout

桌面采用摘要栏与 820px 对话工作面组成的双列布局，工作面内依次是标题、对话记录和固定输入区。咨询单摘要在滚动时保持可见。

800px 以下切换为单列，隐藏摘要栏与非必要的头部动作，保留品牌、依据入口、对话和输入。推荐行继续使用商品信息与价格的两端关系，并允许理由自然换行。

空间以 8、12、18、28、44px 为主要节奏；相邻事实紧凑，轮次和主要区域之间留出更明显的间距。

## Elevation & Depth

系统保持平面。工作面依靠背景色和 1px 轮廓与页面区分；抽屉是唯一使用组件库层级阴影的覆盖表面。

**The Flat Record Rule.** 普通内容不用阴影，层级通过纸面、规则线和留白表达。

## Shapes

主要工作面和商品行使用直角，输入与按钮使用轻微 3–4px 圆角。品牌标记和导购头像使用接近水滴的圆形轮廓，为严格的咨询单结构保留少量柔和感。

## Components

### Buttons

- **Primary:** 深墨背景、白色图标或文字、3px 圆角。
- **Hover / Focus:** 背景加深；键盘焦点使用青绿色焦点环。
- **Ghost:** 透明背景，悬停时使用浅青绿色表面。

### Cards / Containers

- **Consultation sheet:** 咨询单白背景、1px 规则灰轮廓、无圆角、无阴影。
- **Product row:** 以横线和三列关系组织序号、商品事实与价格，不包成独立卡片。
- **Evidence drawer:** 作为受保护的核查空间，内部继续使用行与折叠分区。

### Inputs / Fields

- **Style:** 白色背景、细边框、3px 圆角，文本区随内容增长但限制最大高度。
- **Focus:** 青绿色边框和焦点环；插入符使用青绿色。
- **Disabled:** 降低透明度并保留结构。

### Navigation

顶部只保留品牌、规则加载状态、新咨询和推荐依据。移动端隐藏状态与新咨询，避免压缩核心动作。

### Recommendation Row

商品 SKU、名称、首要理由、首要限制和价格保持在同一行系统中；组合总价在列表末尾右对齐，使用等宽感更强的衬线数字。

## Do's and Don'ts

### Do:

- **Do** 让商品事实、金额和限制在同一视觉上下文中出现。
- **Do** 使用规则线、列关系和留白建立层级。
- **Do** 在移动端优先保留对话、回复和输入。

### Don't:

- **Don't** 使用营销摄影、插画场景或装饰纹理代替商品事实。
- **Don't** 把每条事实包装成圆角卡片。
- **Don't** 用侧边色条、英文眉题或渐变文字制造强调。


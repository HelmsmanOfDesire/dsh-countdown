/**
 * 下班倒计时灯笼 · Client 半边
 *
 * 挂在会话标题栏最左侧（slot: conversation.header.leading），常驻 DSH 顶部；
 * 弹窗可拖动（标题栏拖动 / 吸附到页面任意位置）、可缩放（右下角手柄，或 Ctrl+滚轮），
 * 位置与尺寸写入 localStorage，刷新与重启 DSH 后保持。
 *
 * 上下班：08:30 上班 / 12:00 午休 / 13:30 下午上班 / 17:30 下班。
 */
;(function registerWorkdayLantern() {
  /*
   * 注意：这里刻意不做「全局标记防重复注册」。
   * 之前用过一个全局布尔标记挡重复注册，结果标记一旦置位永不复位，
   * 导致「关闭插件再打开」时模块直接 return、插件再也加载不出来（必须重启 DSH）。
   * 重复注册由 Cordis 的 ctx.effect 卸载链负责清理，不需要自己挡。
   */
  if (typeof window === 'undefined') return

  window.__ModuleLoader__.load({
    id: '@sxh20154102013/workday-lantern',
    factory(require) {
      const React = require('react')
      const h = React.createElement

      // ── 配置 ────────────────────────────────────────────────
      const PLUGIN_ID = 'workday-lantern'
      /** bundle 包名：plugins.bundle.config 席位按包名分发，必须与此一致 */
      const PLUGIN_ID_PACKAGE = '@sxh20154102013/workday-lantern'
      /*
       * ctx.layout 服务引用。
       * 组件是纯函数、拿不到 Cordis 的 ctx，而"点设置按钮跳到插件页"需要
       * ctx.layout.selectPanel(panelId)，所以用闭包变量在 apply 时存下来。
       */
      let layoutService = null
      let pluginCtx = null
      /*
       * 插件页在主面板槽（main）里的 key。
       * 从运行时 occupant 列表确认：main 里可用的 key 是 'plugins' / 'conversation'
       * / 'schedules' / 'task-board'。注意不是 'plugin-manager'（那是 CSS 类名）。
       */
      const PLUGIN_MANAGER_PANEL_ID = 'plugins'
      const STORAGE_KEY = 'dsh.workday-lantern.layout.v1'

      /** 一天的四个节点，单位：分钟（自 0 点起） */
      const SCHEDULE = { workStart: 8 * 60 + 30, lunchStart: 12 * 60, lunchEnd: 13 * 60 + 30, workEnd: 17 * 60 + 30 }
      const MINUTES_PER_DAY = 24 * 60
      const DAY_MS = 24 * 60 * 60 * 1000
      const SECOND_MS = 1000

      /** 沙流抖动的循环周期（秒），只影响视觉节奏，不参与体积计算 */
      const SECONDS_PER_DRIP = 12
      const MAX_FALLING_COINS = 8

      const DEFAULT_W = 320
      const DEFAULT_H = 152
      const MIN_W = Math.round(DEFAULT_W * 0.75)
      const MIN_H = Math.round(DEFAULT_H * 0.75)
      const MAX_W = DEFAULT_W * 3
      const MAX_H = DEFAULT_H * 3

      // ── 时段配置（可增删改）────────────────────────────────
      /*
       * 设计要点：
       * · 时段由用户自由配置，不要求覆盖全天；
       * · 当前时间只可能命中 0 个或 1 个时段；
       * · 命中 → 面板显示该段的沙漏/倒计时/进度；
       * · 未命中 → 面板显示「该时间段未配置」。
       */
      const SLOTS_STORAGE_KEY = 'dsh.workday-lantern.slots.v1'
      /*
       * 同页广播事件名。
       * 关键：浏览器的 storage 事件只在「其他窗口」改动 localStorage 时触发，
       * 同一页面内改动不会通知自己 —— 所以在设置页里删掉时段，面板收不到消息、
       * 还在按旧配置倒计时。必须自己再派发一个同页事件，面板才能立刻刷新。
       */
      const SLOTS_CHANGED_EVENT = 'dsh.workday-lantern:slots-changed'

      /** 内置默认时段（首次使用、或用户点了"恢复默认"时使用） */
      const DEFAULT_SLOTS = [
        { id: 's1', label: '上午班', start: 8 * 60 + 30, end: 12 * 60 },
        { id: 's2', label: '午休', start: 12 * 60, end: 13 * 60 + 30 },
        { id: 's3', label: '下午班', start: 13 * 60 + 30, end: 17 * 60 + 30 },
      ]

      /**
       * 读取用户配置的时段列表。
       * 读不到 / 格式不对 → 回退默认值，绝不让面板因配置损坏而空白。
       * @returns {Array<{id:string,label:string,start:number,end:number}>}
       */
      function readSlots() {
        try {
          const raw = window.localStorage.getItem(SLOTS_STORAGE_KEY)
          if (!raw) return DEFAULT_SLOTS.map((x) => ({ ...x }))
          const parsed = JSON.parse(raw)
          if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_SLOTS.map((x) => ({ ...x }))
          const cleaned = parsed
            .filter((x) => x && typeof x.start === 'number' && typeof x.end === 'number')
            .map((x, i) => ({
              id: typeof x.id === 'string' && x.id ? x.id : 'u' + i,
              label: typeof x.label === 'string' && x.label.trim() ? x.label.trim() : '时段' + (i + 1),
              start: clamp(Math.round(x.start), 0, MINUTES_PER_DAY - 1),
              end: clamp(Math.round(x.end), 0, MINUTES_PER_DAY),
            }))
          return cleaned.length > 0 ? cleaned : DEFAULT_SLOTS.map((x) => ({ ...x }))
        } catch (error) {
          console.error('[workday-lantern] 读取时段配置失败，已回退默认值', error)
          return DEFAULT_SLOTS.map((x) => ({ ...x }))
        }
      }

      /**
       * 保存时段列表。
       * @param {Array} slots 时段数组
       */
      function writeSlots(slots) {
        try {
          window.localStorage.setItem(SLOTS_STORAGE_KEY, JSON.stringify(slots))
        } catch (error) {
          console.error('[workday-lantern] 保存时段配置失败', error)
        }
        // 同页广播：设置页改完，面板（同一页面里）立刻跟着刷新
        try {
          window.dispatchEvent(new window.CustomEvent(SLOTS_CHANGED_EVENT))
        } catch (error) {
          console.error('[workday-lantern] 广播时段变更失败', error)
        }
      }

      /**
       * 判断一个时段是否跨零点（结束时间小于等于开始时间，或等于次日）。
       * @param {object} slot 时段
       * @returns {boolean}
       */
      function isOvernight(slot) {
        return slot.end <= slot.start
      }

      /**
       * 计算当前所处的时段及该段的各项进度。
       * 未命中任何时段时返回 { matched: false }，调用方据此显示「该时间段未配置」。
       * @param {Date} now 当前时间
       * @param {Array} slots 时段列表
       * @returns {object} 时段状态
       */
      function computeState(now, slots) {
        const dayStart = new Date(now.getTime())
        dayStart.setHours(0, 0, 0, 0)
        const minutesNow = (now.getTime() - dayStart.getTime()) / 60000
        const list = Array.isArray(slots) && slots.length > 0 ? slots : DEFAULT_SLOTS

        for (let i = 0; i < list.length; i += 1) {
          const slot = list[i]
          const overnight = isOvernight(slot)
          // 跨零点时段：区间是 [start, end+1440)，凌晨要把当前时间 +1440 再比较
          const endAbs = overnight ? slot.end + MINUTES_PER_DAY : slot.end
          let probe = minutesNow
          if (overnight && minutesNow < slot.start) probe += MINUTES_PER_DAY
          if (probe < slot.start || probe >= endAbs) continue

          const slotSeconds = (endAbs - slot.start) * 60
          /*
           * 跨零点时段的关键：凌晨时（minutesNow < start），本段起点在「昨天」。
           * 只加当天 0 点会算成"今天 22:00 才刚开始"，已开始永远是 0。
           */
          let slotStartMs = dayStart.getTime() + slot.start * 60000
          if (overnight && minutesNow < slot.start) slotStartMs -= DAY_MS
          const elapsedRaw = (now.getTime() - slotStartMs) / 1000
          const elapsed = clamp(elapsedRaw, 0, slotSeconds)
          const remaining = Math.max(0, slotSeconds - elapsed)
          return {
            matched: true,
            slotId: slot.id,
            slotLabel: slot.label,
            slotSeconds,
            elapsed,
            remaining,
            progress: slotSeconds > 0 ? clamp(elapsed / slotSeconds, 0, 1) : 0,
            slotEnd: new Date(slotStartMs + slotSeconds * 1000),
          }
        }
        // 没命中任何时段
        return { matched: false, slotSeconds: 0, elapsed: 0, remaining: 0, progress: 0 }
      }

      /**
       * 把 Date 格式化成 HH:mm，用于显示本段结束时刻。
       * @param {Date} date 时间
       * @returns {string} 形如 "17:30"
       */
      function formatClock(date) {
        // 防御：未命中时段时 state.slotEnd 为 undefined，
        // 之前这里直接取 getHours 会抛 "Cannot read properties of undefined"
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
        const hh = String(date.getHours()).padStart(2, '0')
        const mm = String(date.getMinutes()).padStart(2, '0')
        return hh + ':' + mm
      }

      function splitSeconds(total) {
        const safe = Math.max(0, Math.floor(total))
        return {
          hours: String(Math.floor(safe / 3600)).padStart(2, '0'),
          minutes: String(Math.floor((safe % 3600) / 60)).padStart(2, '0'),
          seconds: String(safe % 60).padStart(2, '0'),
        }
      }

      // ── 布局持久化 ──────────────────────────────────────────
      // x / y 为 null 表示「用户没拖过」，此时按默认位置自动贴右侧居中（见 resolveDefaultPosition）
      function readLayout() {
        const fallback = { x: null, y: null, w: DEFAULT_W, h: DEFAULT_H, minimised: false, maximised: false }
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY)
          if (!raw) return fallback
          const saved = JSON.parse(raw)
          const num = (value, fb) => (typeof value === 'number' && Number.isFinite(value) ? value : fb)
          return {
            x: saved.x === null || saved.x === undefined ? null : num(saved.x, 0),
            y: saved.y === null || saved.y === undefined ? null : num(saved.y, 0),
            w: clamp(num(saved.w, DEFAULT_W), MIN_W, MAX_W),
            h: clamp(num(saved.h, DEFAULT_H), MIN_H, MAX_H),
            minimised: saved.minimised === true,
            // maximised：一键全屏放大（记住上次全屏前的尺寸，再点一次还原）
            maximised: saved.maximised === true,
            restoreW: num(saved.restoreW, DEFAULT_W),
            restoreH: num(saved.restoreH, DEFAULT_H),
          }
        } catch (error) {
          console.error('[workday-lantern] 读取布局失败，已回退默认值', error)
          return fallback
        }
      }

      /**
       * 默认位置：贴 DSH 主内容区右侧、垂直居中。
       * 主内容区 = 标题栏所在的 <header> 的父容器（左侧有边栏时自动避开边栏），
       * 取不到就退回整个视口右侧 —— 保证首次加载一定出现在「DSH 右边、中间高度」。
       * @param {number} width 面板宽度
       * @param {number} height 面板高度
       * @returns {{x:number, y:number}}
       */
      function resolveDefaultPosition(width, height) {
        const margin = 16
        let area = null
        try {
          const header = window.document.querySelector('header')
          const host = header ? header.parentElement : null
          if (host) {
            const rect = host.getBoundingClientRect()
            if (rect.width > width + 8 && rect.height > height + 8) area = rect
          }
        } catch (error) {
          console.warn('[workday-lantern] 读取主内容区失败，使用视口作为兜底', error)
        }
        const left = area ? area.left : 0
        const top = area ? area.top : 0
        const areaWidth = area ? area.width : window.innerWidth
        const areaHeight = area ? area.height : window.innerHeight
        return {
          x: Math.round(left + areaWidth - width - margin),
          y: Math.round(top + Math.max(0, (areaHeight - height) / 2)),
        }
      }

      function writeLayout(layout) {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
        } catch (error) {
          console.error('[workday-lantern] 保存布局失败', error)
        }
      }

      /**
       * 主内容区矩形：左侧边栏之右、窗口之内的可用区域。
       * 取标题栏的父容器（有边栏时它已经在边栏右边）；取不到就用整个视口。
       * @returns {{left:number, top:number, width:number, height:number}}
       */
      function resolveStageArea() {
        const margin = 8
        try {
          const header = window.document.querySelector('header')
          const host = header ? header.parentElement : null
          if (host) {
            const rect = host.getBoundingClientRect()
            if (rect.width > 160 && rect.height > 120) {
              return {
                left: Math.round(rect.left + margin),
                top: Math.round(rect.top + margin),
                width: Math.max(MIN_W, Math.round(rect.width - margin * 2)),
                height: Math.max(MIN_H, Math.round(rect.height - margin * 2)),
              }
            }
          }
        } catch (error) {
          console.warn('[workday-lantern] 读取主内容区失败，全屏退回整个窗口', error)
        }
        return {
          left: margin,
          top: margin,
          width: Math.max(MIN_W, window.innerWidth - margin * 2),
          height: Math.max(MIN_H, window.innerHeight - margin * 2),
        }
      }

      function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value))
      }

      // ── 样式 ────────────────────────────────────────────────
      const CSS = `
.wdl-panel{--wdl-scale:1;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;
  /* 挂在 shell.overlay 上：该层是 click-through，面板必须自己开启接收事件；
     同时尺寸由内联 width/height 决定，不撑满整层，避免挡住 DSH 其他区域 */
  pointer-events:auto;
  border-radius:16px;border:.5px solid rgba(255,205,140,.30);
  background:linear-gradient(158deg,rgba(46,19,15,.96),rgba(20,10,10,.97));
  box-shadow:0 14px 34px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,225,180,.12);
  color:#ffe9c9;font-size:calc(12px*var(--wdl-scale));line-height:1.2;
  user-select:none;-webkit-user-select:none;position:relative;isolation:isolate}
.wdl-panel:before{content:"";position:absolute;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(55% 70% at 10% 4%,rgba(255,150,90,.16),transparent 70%),
             radial-gradient(45% 55% at 92% 98%,rgba(255,210,120,.10),transparent 70%)}
.wdl-panel.wdl-floating{position:fixed;z-index:60}
.wdl-panel.wdl-mini{height:auto;min-height:calc(30px*var(--wdl-scale))}
.wdl-panel.wdl-mini .wdl-resize{display:none}
.wdl-panel.wdl-max{box-shadow:0 20px 48px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,225,180,.16)}
.wdl-panel{cursor:grab}
.wdl-panel button,.wdl-panel a,.wdl-panel input{cursor:pointer}
.wdl-panel.wdl-dragging,.wdl-panel.wdl-dragging *{cursor:grabbing!important}
.wdl-panel .wdl-resize{cursor:nwse-resize}

/* ── 三段式骨架：顶栏 / 主体 / 底进度 ── */
.wdl-shell{flex:1;min-height:0;display:flex;flex-direction:column;position:relative;z-index:1;
  padding:calc(7px*var(--wdl-scale)) calc(9px*var(--wdl-scale)) calc(7px*var(--wdl-scale))}

/* 顶栏：左「时段名」右「结束时刻」 */
.wdl-top{flex:none;display:flex;align-items:center;justify-content:space-between;gap:calc(8px*var(--wdl-scale))}
.wdl-top-right{display:flex;align-items:center;gap:calc(6px*var(--wdl-scale));min-width:0}
.wdl-slot{font-size:calc(11.5px*var(--wdl-scale));font-weight:600;color:rgba(255,232,200,.92);letter-spacing:.02em}
.wdl-slot-end{font-size:calc(10px*var(--wdl-scale));color:rgba(255,222,185,.52);
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace}

/* 主体：左沙漏 + 右数据（垂直居中，不再上下脱节） */
.wdl-main{flex:1;min-height:0;display:flex;align-items:center;gap:calc(10px*var(--wdl-scale));margin-top:calc(3px*var(--wdl-scale))}
.wdl-main-left{flex:0 0 33%;align-self:stretch;display:flex;align-items:center;justify-content:center;min-height:0}
.wdl-hourglass{display:block;width:100%;height:100%;max-height:100%;overflow:visible}
.wdl-main-right{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:calc(2px*var(--wdl-scale))}

/* 主数字：剩余时间（唯一主角） */
.wdl-hero{display:flex;align-items:baseline;gap:calc(6px*var(--wdl-scale))}
.wdl-hero-num{font-family:ui-monospace,"Cascadia Mono",Consolas,"SF Mono",monospace;
  font-variant-numeric:tabular-nums;letter-spacing:.01em;font-weight:700;
  font-size:calc(31px*var(--wdl-scale));line-height:1;color:#ff7f6b;
  text-shadow:0 0 calc(14px*var(--wdl-scale)) rgba(235,85,60,.45)}
.wdl-hero-cap{font-size:calc(10px*var(--wdl-scale));color:rgba(255,150,130,.75);padding-bottom:calc(2px*var(--wdl-scale))}

/* 次数字：已开始（缩一级，绿色） */
.wdl-sub{display:flex;align-items:baseline;gap:calc(6px*var(--wdl-scale))}
.wdl-sub-num{font-family:ui-monospace,"Cascadia Mono",Consolas,"SF Mono",monospace;
  font-variant-numeric:tabular-nums;font-weight:600;
  font-size:calc(15px*var(--wdl-scale));line-height:1;color:#6fd99a}
.wdl-sub-cap{font-size:calc(9.5px*var(--wdl-scale));color:rgba(140,225,175,.62)}

/* 底部：整条进度线铺满 + 右侧一个百分比 */
.wdl-foot{flex:none;display:flex;align-items:center;gap:calc(8px*var(--wdl-scale));margin-top:calc(6px*var(--wdl-scale))}
.wdl-track{flex:1;min-width:0;display:flex;height:calc(7px*var(--wdl-scale));border-radius:calc(4px*var(--wdl-scale));
  overflow:hidden;background:rgba(255,220,170,.10);box-shadow:inset 0 1px 2px rgba(0,0,0,.45)}
.wdl-track-started{height:100%;background:linear-gradient(90deg,#2b8f57,#4ecb82);
  transition:width .5s linear}
.wdl-track-left{height:100%;background:linear-gradient(90deg,#cf4636,#f4685a);
  transition:width .5s linear}
.wdl-foot-pct{flex:none;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  font-variant-numeric:tabular-nums;font-weight:700;font-size:calc(12.5px*var(--wdl-scale));
  min-width:calc(56px*var(--wdl-scale));line-height:1}
.wdl-foot-pct-started{color:#5fd68e;text-align:left;text-shadow:0 0 calc(6px*var(--wdl-scale)) rgba(60,200,120,.35)}
.wdl-foot-pct-left{color:#ff8a75;text-align:right;text-shadow:0 0 calc(6px*var(--wdl-scale)) rgba(230,80,60,.35)}

/* 极小字说明 */

/* 工具条：右上角（Windows 窗口习惯），默认低调，悬停变亮 */
.wdl-tools{flex:none;display:flex;align-items:center;gap:calc(3px*var(--wdl-scale));
  position:relative;z-index:2;opacity:.42;transition:opacity .18s ease}
.wdl-panel:hover .wdl-tools{opacity:1}
.wdl-btn{flex:none;width:calc(16px*var(--wdl-scale));height:calc(16px*var(--wdl-scale));border-radius:4px;
  border:.5px solid rgba(255,205,140,.20);background:rgba(255,220,170,.05);
  color:#ffe4bb;font-size:calc(9.5px*var(--wdl-scale));line-height:1;
  display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.wdl-btn:hover{background:rgba(255,220,170,.24);border-color:rgba(255,205,140,.55)}
.wdl-resize{position:absolute;right:0;bottom:0;width:calc(15px*var(--wdl-scale));height:calc(15px*var(--wdl-scale));cursor:nwse-resize;z-index:3;
  background:linear-gradient(135deg,transparent 55%,rgba(255,220,170,.40) 55%,rgba(255,220,170,.40) 63%,transparent 63%,transparent 76%,rgba(255,220,170,.40) 76%,rgba(255,220,170,.40) 84%,transparent 84%)}

/* 收起态：一行紧凑条 */
.wdl-mini-row{display:flex;align-items:center;gap:calc(7px*var(--wdl-scale));width:100%;box-sizing:border-box;
  min-height:calc(30px*var(--wdl-scale));
  /* 右侧额外留出 16px：缩放手柄压在角落，必须把它避让开，否则会抢走点击 */
  padding:calc(6px*var(--wdl-scale)) calc(20px*var(--wdl-scale)) calc(6px*var(--wdl-scale)) calc(10px*var(--wdl-scale));
  overflow:hidden}
/* 收起态按钮加大到 20px，保证鼠标能点中 */
.wdl-mini-row .wdl-btn{width:calc(20px*var(--wdl-scale));height:calc(20px*var(--wdl-scale));
  font-size:calc(11px*var(--wdl-scale));opacity:1}
.wdl-mini-num{flex:none;font-family:ui-monospace,Consolas,monospace;font-weight:700;color:#ff8a75;
  white-space:nowrap;font-size:calc(13px*var(--wdl-scale));text-shadow:0 0 calc(6px*var(--wdl-scale)) rgba(230,80,60,.35)}
.wdl-mini-pct{flex:none;font-family:ui-monospace,Consolas,monospace;font-weight:700;color:#5fd68e;
  font-size:calc(11px*var(--wdl-scale));white-space:nowrap;text-shadow:0 0 calc(6px*var(--wdl-scale)) rgba(60,200,120,.35)}
.wdl-mini-track{flex:1;min-width:0;display:flex;height:calc(5px*var(--wdl-scale));border-radius:3px;overflow:hidden;
  background:rgba(255,220,170,.12)}

/* ── 插件页里的配置摘要行 ── */
.wdl-set-summary{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:2px 0}

/* ── 设置页：时段管理 ── */
.wdl-set{display:flex;flex-direction:column;gap:10px;padding:4px 0;max-width:640px;font-size:13px;
  color:var(--dsw-alias-label-primary,#e8e8e8)}
.wdl-set-title{font-size:15px;font-weight:600}
.wdl-set-desc{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#999)}
.wdl-set-error{font-size:12px;color:#ff8a75;background:rgba(255,90,70,.12);border-radius:6px;padding:6px 10px}
.wdl-set-warn{font-size:12px;color:#e0b23c;background:rgba(224,178,60,.12);border-radius:6px;padding:6px 10px}
.wdl-set-head,.wdl-set-row{display:grid;grid-template-columns:1fr 110px 110px 64px;gap:8px;align-items:center}
.wdl-set-head{font-size:12px;color:var(--dsw-alias-label-tertiary,#999);padding:0 2px 2px}
.wdl-set-rows{display:flex;flex-direction:column;gap:8px}
.wdl-set-input{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;font-size:13px;
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));
  color:inherit;font-family:inherit;outline:none}
.wdl-set-input:focus{border-color:var(--dsw-alias-brand-primary,#4c8dff)}
.wdl-set-del{padding:5px 8px;border-radius:6px;font-size:12px;cursor:pointer;
  border:1px solid rgba(255,110,90,.35);background:rgba(255,110,90,.10);color:#ff8a75}
.wdl-set-del:hover:not(:disabled){background:rgba(255,110,90,.22)}
.wdl-set-del:disabled{opacity:.35;cursor:not-allowed}
.wdl-set-actions{display:flex;gap:10px;margin-top:2px}
.wdl-set-add,.wdl-set-reset{padding:6px 14px;border-radius:6px;font-size:13px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:inherit}
.wdl-set-add:hover,.wdl-set-reset:hover{background:rgba(255,255,255,.12)}
.wdl-set-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);line-height:1.5}

/* ── 未配置时段：当前时间不在任何时段内 ── */
.wdl-idle{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:calc(3px*var(--wdl-scale));padding:calc(6px*var(--wdl-scale)) 0}
.wdl-idle-icon{font-size:calc(26px*var(--wdl-scale));line-height:1;opacity:.35;filter:grayscale(.3)}
.wdl-idle-text{font-size:calc(14px*var(--wdl-scale));font-weight:600;color:rgba(255,228,195,.62);
  letter-spacing:.04em}
.wdl-idle-hint{font-size:calc(9.5px*var(--wdl-scale));color:rgba(255,222,185,.34)}
.wdl-mini-idle{flex:1;font-size:calc(11px*var(--wdl-scale));color:rgba(255,228,195,.55);white-space:nowrap}
.wdl-foot-idle{min-height:calc(7px*var(--wdl-scale))}

/* ── 沙流动效：全部 CSS 驱动，不占 JS，心跳降到 1s 也不影响观感 ── */
.wdl-stream{animation:wdl-stream-sway 2.4s ease-in-out infinite;transform-box:fill-box;transform-origin:top center}
@keyframes wdl-stream-sway{
  0%,100%{transform:translateX(-0.22px)}
  50%{transform:translateX(0.22px)}
}
.wdl-stream-glow{opacity:.45;animation:wdl-stream-shine 1.3s linear infinite}
@keyframes wdl-stream-shine{
  0%,100%{opacity:.25}
  50%{opacity:.95}
}
/*
 * 下落沙粒：沙粒本来就沿沙流均匀排布，所以不需要错峰，
 * 让它们同步做「出现→变亮→淡出」的脉冲，整条沙流就有了流动感。
 */
.wdl-stream-drops circle{animation:wdl-drop-fall 1.05s ease-in-out infinite;transform-box:fill-box}
/* 按序号微错峰，避免 8 颗同时闪（错峰量很小，不会打散整条流） */
.wdl-stream-drops circle:nth-child(2){animation-delay:-.13s}
.wdl-stream-drops circle:nth-child(3){animation-delay:-.26s}
.wdl-stream-drops circle:nth-child(4){animation-delay:-.39s}
.wdl-stream-drops circle:nth-child(5){animation-delay:-.52s}
.wdl-stream-drops circle:nth-child(6){animation-delay:-.65s}
.wdl-stream-drops circle:nth-child(7){animation-delay:-.78s}
.wdl-stream-drops circle:nth-child(8){animation-delay:-.91s}
@keyframes wdl-drop-fall{
  0%{opacity:.35;transform:translateY(-.7px) scale(.85)}
  35%{opacity:1;transform:translateY(0) scale(1.05)}
  70%{opacity:.85;transform:translateY(.7px) scale(1)}
  100%{opacity:.35;transform:translateY(-.7px) scale(.85)}
}
/* 落点：沙堆顶部轻微跳动，像有沙砸上去 */
.wdl-splash{animation:wdl-splash 1.05s ease-out infinite}
@keyframes wdl-splash{
  0%{opacity:.15;transform:scaleX(.6)}
  22%{opacity:.85;transform:scaleX(1.15)}
  55%{opacity:.25;transform:scaleX(.85)}
  100%{opacity:.1;transform:scaleX(.6)}
}
@media (prefers-reduced-motion: reduce){
  .wdl-stream,.wdl-stream-glow,.wdl-stream-drops circle,.wdl-splash{animation:none}
}

/* 全屏时的放大档 */
.wdl-panel.wdl-max .wdl-hero-num{font-size:calc(52px*var(--wdl-scale))}
.wdl-panel.wdl-max .wdl-sub-num{font-size:calc(22px*var(--wdl-scale))}
.wdl-panel.wdl-max .wdl-slot{font-size:calc(15px*var(--wdl-scale))}
.wdl-panel.wdl-max .wdl-track{height:calc(11px*var(--wdl-scale))}
.wdl-panel.wdl-max .wdl-main-left{flex-basis:26%}
`

      // ── 子图：金色沙漏（沙粒按体积计量）──────────────────────
      // 几何：上球 y∈[10,58]，中颈 y=58，下球 y∈[58,106]；整体宽 84（x∈[8,92]）
      const HOURGLASS = {
        topBulbTop: 10,
        neck: 58,
        bottomBulbBottom: 106,
        neckHalf: 3.2,
        bulbHalf: 40,
      }
      /** 沙漏外轮廓：上球 → 细颈 → 下球，一条闭合路径（同时用于裁剪沙体） */
      const HOURGLASS_PATH =
        'M10 10 Q46 6 86 10 C90 26 74 46 54 58 C74 70 90 90 86 106 Q46 110 10 106 C6 90 22 70 42 58 C22 46 6 26 10 10 Z'

      /**
       * 半宽函数：给定 y 返回此刻沙漏内壁的半宽，沙体按它收边。
       * 用两个对称的四次近似（椭圆弧），保证沙体贴着玻璃而不是浮在中间。
       */
      function hourglassHalfWidth(y) {
        const { topBulbTop, neck, bottomBulbBottom, neckHalf, bulbHalf } = HOURGLASS
        const halfHeight = (neck - topBulbTop) / 2 // 每球 24
        if (y < topBulbTop || y > bottomBulbBottom) return 0
        const center = y <= neck ? topBulbTop + halfHeight : neck + halfHeight
        const t = Math.min(1, Math.abs(y - center) / halfHeight)
        const bulge = Math.sqrt(Math.max(0, 1 - t * t)) // 中段最宽、两端收口
        return neckHalf + (bulbHalf - neckHalf) * bulge
      }

      /**
       * 沙粒体积模型（按体积，不按数量）。
       *
       * 需求：上下两端"沙子体积"严格与剩余时间成正比，且总共只有半个球的沙量
       * —— 早上开始上球半满，到点漏完、下球正好半满。
       * 做法：把沙漏沿 y 切成薄片，每片的"体积"= 该高度处球体截面积，
       * 于是"高度 → 累计体积"是一个单调递增函数；反过来用二分法就能由目标体积
       * 求出液面高度。这是真正的体积比例，不受球体形状影响。
       */
      /** 沙体贴着玻璃内壁留的缝（画沙体和算体积必须用同一个值，否则比例会偏） */
      const SAND_INSET = 1.2
      const SAND_MODEL = buildSandModel()

      /**
       * 预计算沙漏下半球每一薄片的面积与累计体积（自底部 y 往上累加）。
       * 只算下球：上球与下球形状镜像对称，体积换算完全一样。
       * @returns {{bottom:number, top:number, dy:number, cum:number[], total:number}}
       */
      function buildSandModel() {
        const { neck, bottomBulbBottom } = HOURGLASS
        const bottom = bottomBulbBottom - 3   // 下球内壁最低处
        const top = neck + 2                  // 下球内壁最高处（靠近细颈）
        const dy = 0.5
        const cum = [0]
        let acc = 0
        for (let y = bottom; y > top; y -= dy) {
          const r = Math.max(0, hourglassHalfWidth(y) - SAND_INSET)
          // 薄片体积 ∝ 截面半径²，这正是球体能积分的正确形式
          acc += r * r * dy
          cum.push(acc)
        }
        return { bottom, top, dy, cum, total: acc }
      }

      /**
       * 给定「占半个球的体积比例」，反解出液面高度 y。
       * 用二分法在下球区间内逼近，误差小于 0.05 单位（视觉上不可见）。
       * @param {number} fillRatio 0~1，占半球体积的比例
       * @returns {number} 液面 y 坐标（越高越小）
       */
      function fillSurfaceY(fillRatio) {
        const { bottom, top, cum, total } = SAND_MODEL
        const target = Math.max(0, Math.min(1, fillRatio)) * total
        if (target <= 0) return bottom
        if (target >= total) return top
        // cum 单调递增，二分找第一个 cum[i] >= target
        let lo = 0
        let hi = cum.length - 1
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (cum[mid] >= target) hi = mid
          else lo = mid + 1
        }
        // 在 lo-1 与 lo 之间按体积做线性插值，得到更平滑的高度
        const prevCum = cum[lo - 1] ?? 0
        const span = cum[lo] - prevCum
        const frac = span > 0 ? (target - prevCum) / span : 1
        return bottom - (lo - 1 + frac) * SAND_MODEL.dy
      }

      /*
       * ── 沙粒渲染优化 ────────────────────────────────────────
       * 问题：原来每次心跳都重新生成 ~1100 个 <circle> 的 JSX，
       *       React 每次要全量 diff，一天下来是几百万次无谓比对。
       * 方案：沙粒位置只跟球体形状有关、跟时间无关 —— 一次性预计算成
       *       按高度分好的行表（每天首次渲染算一次），渲染时按沙面高度取子集，
       *       心跳期间不再生成任何沙粒对象。
       */
      const GRAIN_ROWS = buildGrainRows()

      /**
       * 预计算沙粒行表：每 1.5 单位一行，记录该高度的沙粒几何。
       * @returns {{top: Array<{y:number, grains:Array}>, bottom: Array}}
       */
      function buildGrainRows() {
        const { neck, topBulbTop, bottomBulbBottom } = HOURGLASS
        const rowStep = 1.5
        // 密度系数：原来 2.4，现在 1.35 —— 半径 <0.5px 的点在屏幕上根本看不见
        const DENSITY = 1.35

        const makeRows = (fromY, toY, step, seed) => {
          const rows = []
          let rand = seed
          const next = () => {
            rand = (rand * 1103515245 + 12345) & 0x7fffffff
            return rand / 0x7fffffff
          }
          for (let y = fromY; step > 0 ? y < toY : y > toY; y += step) {
            const half = Math.max(0, hourglassHalfWidth(y) - SAND_INSET)
            if (half <= 0.5) { rows.push({ y, grains: [] }); continue }
            const count = Math.max(1, Math.round(half * DENSITY))
            const grains = []
            for (let i = 0; i < count; i += 1) {
              const tone = next()
              grains.push({
                x: (50 + (next() - 0.5) * 2 * half).toFixed(2),
                y: (y - next() * rowStep * 0.85).toFixed(2),
                r: (0.5 + next() * 0.32).toFixed(2),
                fill: tone > 0.86 ? '#fff0b8' : tone > 0.6 ? '#f6cf5e' : tone > 0.3 ? '#e6b23a' : '#d29a26',
                o: (0.74 + next() * 0.26).toFixed(2),
              })
            }
            rows.push({ y, grains })
          }
          return rows
        }

        return {
          // 上球：自细颈往上（y 递减）
          top: makeRows(neck - 2, topBulbTop + 3, -rowStep, 20261),
          // 下球：自球底往上（y 递减）
          bottom: makeRows(bottomBulbBottom - 3, neck + 2, -rowStep, 91237),
        }
      }

      /**
       * 按沙面高度取沙粒（只切片，不新建几何）。
       * 沙面以下的都显示：上球沙面越小（越靠上）显示越多，下球同理。
       * @param {boolean} isTop 上球 / 下球
       * @param {number} surfaceY 沙面高度
       * @param {string} keyPrefix React key 前缀
       * @returns {Array}
       */
      /*
       * 沙粒缓存：沙粒几何只跟球体形状有关，渲染结果的唯一变量是「沙面高度」。
       * 而沙面是连续变化的，不可能每次精确命中 —— 所以按 0.5px 量化沙面高度做缓存键，
       * 命中就复用上一次的 circle 数组（React 会因引用相同而跳过这部分子树）。
       * 量化误差 0.5px 在 320px 宽的小窗里肉眼不可见，却能把每秒 660 个对象的重建降到
       * 「沙面跨过一个 0.5px 台阶时才重建」，实际约每分钟 5 次。
       */
      const GRAIN_CACHE = new Map()
      const GRAIN_CACHE_LIMIT = 120

      function grainsAt(isTop, surfaceY, keyPrefix) {
        const bucket = Math.round(surfaceY * 2) / 2
        const cacheKey = (isTop ? 'T' : 'B') + '|' + bucket
        const cached = GRAIN_CACHE.get(cacheKey)
        if (cached !== undefined) return cached

        const rows = isTop ? GRAIN_ROWS.top : GRAIN_ROWS.bottom
        const out = []
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]
          if (row.grains.length === 0 || row.y < bucket) continue
          for (let g = 0; g < row.grains.length; g += 1) {
            const gr = row.grains[g]
            out.push(h('circle', {
              key: keyPrefix + i + '-' + g,
              cx: gr.x, cy: gr.y, r: gr.r, fill: gr.fill, opacity: gr.o,
              pointerEvents: 'none',
            }))
          }
        }
        // 简易容量控制：超上限整体清空（沙面是连续变化，旧桶基本不会再用到）
        if (GRAIN_CACHE.size >= GRAIN_CACHE_LIMIT) GRAIN_CACHE.clear()
        GRAIN_CACHE.set(cacheKey, out)
        return out
      }

      /**
       * 金色沙漏：上半球的沙按体积漏下来，下半球按体积堆起来。
       * 沙量总计 = 半个球：开始上球半满，漏完下球正好半满。
       * @param {object} props
       * @param {number} props.remaining 0~1，剩余时间比例
       * @param {boolean} props.resting 是否静止（下班 / 周末）
       */
      function Hourglass({ remaining, resting }) {
        const { topBulbTop, neck, bottomBulbBottom } = HOURGLASS
        const HALF_BULB = 0.5 // 总沙量 = 半个球的体积

        // 体积模型：上球沙量 = 总沙量 × 剩余比例，下球 = 总沙量 - 上球
        const topFill = HALF_BULB * remaining
        const bottomFill = HALF_BULB * (1 - remaining)
        /*
         * 液面换算（上下球镜像，方向必须分清）：
         * fillSurfaceY(v) 返回的是「下球装了 v 体积后，沙面所在的 y」。
         * 沙漏是镜像对称的，把下球的结果沿细颈翻过去，就是上球的沙面：
         *   下球沙面：直接取 fillSurfaceY(bottomFill)          （从球底往上堆）
         *   上球沙面：neck - (fillSurfaceY(topFill) - neck)     （从细颈往上堆）
         */
        /*
         * 下球沙量与液面（务必分清两个比例，之前就在这里翻过车）：
         *   · 半球的体积 = 满球体积的 1/2
         *   · 总沙量     = HALF_BULB 个半球 = 0.5 半球
         *   · fillSurfaceY(v) 的参数 v 是「占整个半球体积的比例」，不是"占总沙量的比例"
         * 于是：下球要装的体积 = (1 - remaining) × HALF_BULB
         *       换算成占半球的比例 = (1 - remaining) × HALF_BULB / 1 … 即 × 0.5
         * 之前直接把 (1 - remaining) 交给 fillSurfaceY，等于当成"装 1-remaining 个半球"，
         * 实际装多了整整一倍 —— 这就是下球看起来装到 2/3 的原因。
         */
        const totalSand = HALF_BULB                     // 总沙量（单位：半球体积）
        const bottomVolume = totalSand * (1 - remaining) // 下球应装体积（单位：半球体积）

        // 沙丘与底座互为依赖，迭代收敛
        let baseBottomRatio = bottomVolume
        let moundHeight = 0
        for (let pass = 0; pass < 4; pass += 1) {
          const baseSurfaceGuess = fillSurfaceY(baseBottomRatio)
          const guessMound = computeMoundHeight(baseBottomRatio)
          const guessMoundVol = moundVolume(baseSurfaceGuess, guessMound) / SAND_MODEL.total
          moundHeight = guessMound
          baseBottomRatio = Math.max(0, bottomVolume - guessMoundVol)
        }
        const bottomSurface = fillSurfaceY(baseBottomRatio)
        /*
         * 上球沙面（这里之前算错过，导致"剩 20% 时上球看着还有一半"）：
         * 沙子受重力只会贴着细颈堆成一坨，不会铺满上球整个内壁。
         * 上下两球镜像对称，所以「上球装 v 体积要堆多高」= 「下球装 v 体积堆起来的高度」：
         *   层高 = SAND_MODEL.bottom - fillSurfaceY(v)
         *   上球沙面 = 细颈 - 层高   （往上堆）
         * 用旧写法 fillSurfaceY(v) 再镜像，得到的是"铺满内壁的等高面"，高度会虚涨 5 倍。
         */
        const topVolume = totalSand * remaining
        const topPile = SAND_MODEL.bottom - fillSurfaceY(topVolume)
        const topSurface = Math.max(topBulbTop + 2, neck - topPile)

        // 下落沙流：细颈处一条会抖动的细沙
        /*
         * 沙流终点必须落在「下球沙堆顶面」上，不能悬空。
         * 注意 y 轴向下：沙堆越浅，bottomSurface 越大（越接近球底 106）。
         * 原来写成 Math.min(bottomSurface, neck + 26)，会取到更靠上的那个值，
         * 导致刚下班/刚上班、沙堆还很浅时，沙流只画到半路、接不到沙堆。
         * 正确做法：往下取到沙堆顶面，用一个较小的上限防止沙流过长。
         */
        const streamTop = neck - 1
        // 落在沙丘尖峰上（沙丘顶 = 底座沙面 - 沙丘高度），而不是底座沙面
        const moundPeakY = bottomSurface - (moundHeight || 0)
        const streamBottom = Math.max(moundPeakY, neck + 4)

        // 取预计算行表里的子集：上球显示沙面以下到细颈，下球显示沙面以下到球底
        const topGrains = grainsAt(true, topSurface, 'top-')
        const bottomGrains = grainsAt(false, bottomSurface, 'bot-')
        const showStream = !resting && remaining > 0

        return h('svg', {
          className: 'wdl-hourglass',
          viewBox: '0 0 100 120',
          preserveAspectRatio: 'xMidYMid meet',
          'aria-hidden': true,
        },
        h('defs', null,
          h('linearGradient', { id: 'wdl-glassBody', x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0', stopColor: 'rgba(224,248,255,.42)' }),
            h('stop', { offset: '0.42', stopColor: 'rgba(168,220,246,.12)' }),
            h('stop', { offset: '1', stopColor: 'rgba(126,192,236,.30)' })),
          h('linearGradient', { id: 'wdl-frame', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0', stopColor: '#8a5a2c' }),
            h('stop', { offset: '1', stopColor: '#43260f' })),
          // 沙子本身的金色渐变（让沙堆有明暗，不至于一片糊）
          h('linearGradient', { id: 'wdl-sandBody', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0', stopColor: '#f7d977' }),
            h('stop', { offset: '0.55', stopColor: '#e0ab33' }),
            h('stop', { offset: '1', stopColor: '#b8801d' })),
          h('clipPath', { id: 'wdl-hourglassClip' }, h('path', { d: HOURGLASS_PATH })),
        ),
        // 玻璃体内的沙子（裁剪进沙漏轮廓）
        h('g', { clipPath: 'url(#wdl-hourglassClip)' },
          // 上球沙体：实心沙堆 + 细沙粒纹理
          h('path', {
            d: sandBodyPath(topSurface, true, 0),
            fill: 'url(#wdl-sandBody)',
            opacity: 0.94,
          }),
          h('g', null, topGrains),
          // 下球沙体
          h('path', {
            d: sandBodyPath(bottomSurface, false, moundHeight),
            fill: 'url(#wdl-sandBody)',
            opacity: 0.94,
          }),
          h('g', null, bottomGrains),
          /*
           * 细沙流：全部交给 CSS 动画，React 只渲染这一次。
           * 原先靠每秒变化的相位驱动 —— 心跳降到 1s 后只剩两档，看着就静止了。
           * CSS 动画独立于 React、不占 JS，能跑满 60fps。
           */
          showStream
            ? h('g', null,
              // 主沙流：一条略呈 S 的细线，整体做极轻微的横向摆动
              h('path', {
                className: 'wdl-stream',
                d: sandStreamPath(streamTop, streamBottom),
                fill: 'none',
                stroke: '#f2c65a',
                strokeWidth: 1.25,
                strokeLinecap: 'round',
                opacity: 0.92,
              }),
              // 高光：贴着右侧，独立眨眼（模拟沙粒反光流动）
              h('path', {
                className: 'wdl-stream-glow',
                d: sandStreamPath(streamTop, streamBottom),
                fill: 'none',
                stroke: '#ffeeb0',
                strokeWidth: 0.5,
                strokeLinecap: 'round',
                transform: 'translate(0.55 0)',
              }),
              // 下落沙粒：用 CSS 让整组沿 y 轴循环滚动，形成连续下落的错觉
              h('g', { className: 'wdl-stream-drops' },
                streamDroplets(streamTop, streamBottom),
              ),
              // 落点：沙堆顶部持续轻微震动（沙落上去的动感）
              h('ellipse', {
                className: 'wdl-splash',
                cx: 50,
                cy: Math.min(bottomBulbBottom - 4, streamBottom),
                rx: 3.2,
                ry: 0.9,
                fill: 'rgba(255,240,180,.75)',
              }),
            )
            : null,
        ),
        // 玻璃外壳（描边压在最上层，才有「玻璃包着沙」的层次）
        h('path', {
          d: HOURGLASS_PATH,
          fill: 'url(#wdl-glassBody)',
          stroke: 'rgba(198,238,255,.78)',
          strokeWidth: 1.2,
          style: { pointerEvents: 'none' },
        }),
        // 玻璃高光
        h('path', { d: 'M22 16 Q30 14 33 22 Q24 22 22 16 Z', fill: 'rgba(255,255,255,.42)' }),
        h('path', { d: 'M24 96 Q32 98 30 104 Q23 102 24 96 Z', fill: 'rgba(255,255,255,.26)' }),
        // 竖条反光
        h('path', {
          d: 'M26 22 Q23 40 34 54',
          fill: 'none',
          stroke: 'rgba(255,255,255,.26)',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M28 92 Q24 76 36 64',
          fill: 'none',
          stroke: 'rgba(255,255,255,.18)',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
        // 上下木质框 + 立柱
        h('rect', { x: 4, y: 4, width: 92, height: 7, rx: 3.4, fill: 'url(#wdl-frame)' }),
        h('rect', { x: 4, y: 109, width: 92, height: 7, rx: 3.4, fill: 'url(#wdl-frame)' }),
        h('rect', { x: 6, y: 10, width: 3.2, height: 100, rx: 1.6, fill: 'rgba(138,90,44,.5)' }),
        h('rect', { x: 90.8, y: 10, width: 3.2, height: 100, rx: 1.6, fill: 'rgba(138,90,44,.5)' }),
        )
      }

      /**
       * 沙流路径：从细颈到落点的一条轻微 S 形曲线。
       * 摆动效果交给 CSS 动画（.wdl-stream），这里只给一条静态骨架。
       * @param {number} fromY 起点（细颈）
       * @param {number} toY 落点
       * @returns {string} SVG path
       */
      function sandStreamPath(fromY, toY) {
        const len = Math.max(1, toY - fromY)
        const midY = fromY + len * 0.5
        return 'M50 ' + fromY.toFixed(2) +
          ' C49.2 ' + (fromY + len * 0.25).toFixed(2) +
          ' 50.7 ' + midY.toFixed(2) +
          ' 50 ' + toY.toFixed(2)
      }

      /**
       * 下落沙粒：沿沙流均匀排一串小点，整组由 CSS 循环上移，形成连续流动。
       * @param {number} fromY 起点
       * @param {number} toY 终点
       * @returns {Array}
       */
      function streamDroplets(fromY, toY) {
        const dots = []
        const COUNT = 8
        for (let i = 0; i < COUNT; i += 1) {
          const t = i / COUNT
          const y = fromY + (toY - fromY) * t
          const wobble = Math.sin(t * Math.PI * 2) * 0.45
          dots.push(h('circle', {
            key: 'drop-' + i,
            cx: (50 + wobble).toFixed(2),
            cy: y.toFixed(2),
            r: (0.55 + (1 - t) * 0.25).toFixed(2),
            fill: t > 0.6 ? '#f6cf5e' : '#fff0b8',
            opacity: (0.5 + t * 0.5).toFixed(2),
          }))
        }
        return dots
      }

      /**
       * 沙丘底半径：取「当前底座沙面处」的球内半宽。      /**
       * 沙丘底半径：取「当前底座沙面处」的球内半宽。
       * 必须与实际绘制沙体同一处取样，否则体积换算与画面不一致。
       * @param {number} baseSurfaceY 底座沙面高度
       * @returns {number} 半宽（像素）
       */
      function moundBaseRadius(baseSurfaceY) {
        return Math.max(0, hourglassHalfWidth(baseSurfaceY) - SAND_INSET)
      }

      /**
       * 落点沙丘高度。
       *
       * 限制条件（缺一不可，否则会出现"沙子凭空变多"）：
       *   ① 不超过可用空间（底座沙面到细颈之间）
       *   ② 不超过底半径的 0.22 倍（保持矮胖小丘的形状，不喧宾夺主）
       *   ③ ★ 沙丘自身体积不超过「当前下球总沙量」的 12% ——
       *      沙少时堆不出大沙丘，否则会把底座挤成 0 却还画着尖峰，体积凭空翻倍
       *
       * @param {number} bottomFill 下球沙量（占半球的比例，0~0.5）
       * @returns {number} 沙丘尖峰高出底座沙面的高度（像素）
       */
      function computeMoundHeight(bottomFill) {
        if (bottomFill <= 0.001) return 0
        const baseY = fillSurfaceY(bottomFill)
        const room = Math.max(0, baseY - (HOURGLASS.neck + 4))
        const shapeLimit = moundBaseRadius(baseY) * 0.22
        // 条件 ③：由圆锥体积反解高度上限  h <= 3V / (π r²)
        const totalVolume = SAND_MODEL.total * bottomFill
        const shareVolume = totalVolume * 0.12
        const r = moundBaseRadius(baseY)
        const volumeLimit = r > 0.5 ? (3 * shareVolume) / (Math.PI * r * r) : 0
        return Math.max(0, Math.min(room * 0.5, shapeLimit, volumeLimit))
      }

      /**
       * 沙丘体积：近似为旋转圆锥      /**
       * 沙丘体积：近似为旋转圆锥（底半径 r、高 h）。
       * 单位与 SAND_MODEL 一致（像素³），用于从目标体积里精确扣除。
       * @param {number} baseSurfaceY 底座沙面高度
       * @param {number} moundHeight 沙丘高度
       * @returns {number} 体积
       */
      function moundVolume(baseSurfaceY, moundHeight) {
        if (moundHeight <= 0) return 0
        const r = moundBaseRadius(baseSurfaceY)
        return (Math.PI * r * r * moundHeight) / 3
      }

      /**
       * 生成沙体轮廓路径。      /**
       * 生成沙体轮廓路径。
       *
       * 下球的沙面不是平的：沙从细颈落下会在落点堆起一个锥形小沙丘，
       * 越靠中心越高、越往四周越薄。所以下球沙体 = 「底座液面」+「沙丘尖峰」。
       *
       * @param {number} surfaceY 底座沙面高度（不含沙丘）
       * @param {boolean} isTop 是否上球（上球沙面是平的，向下凹一点更像被吸走）
       * @param {number} moundHeight 沙丘尖峰高于底座沙面的高度（仅下球用）
       * @returns {string} SVG path
       */
      function sandBodyPath(surfaceY, isTop, moundHeight) {
        const edges = []
        if (isTop) {
          const from = Math.max(surfaceY + 0.5, HOURGLASS.topBulbTop + 2)
          for (let y = from; y <= HOURGLASS.neck - 1; y += 1) {
            edges.push({ y, half: hourglassHalfWidth(y) - SAND_INSET })
          }
        } else {
          const from = Math.min(surfaceY - 0.5, HOURGLASS.bottomBulbBottom - 3)
          for (let y = from; y <= HOURGLASS.bottomBulbBottom - 2; y += 1) {
            edges.push({ y, half: hourglassHalfWidth(y) - SAND_INSET })
          }
        }
        if (edges.length === 0) return ''
        const halfOf = (y) => Math.max(0, hourglassHalfWidth(y) - SAND_INSET)
        const left = edges.map((e) => 'L' + (50 - Math.max(0, e.half)).toFixed(2) + ' ' + e.y.toFixed(2))
        const right = edges.slice().reverse().map((e) => 'L' + (50 + Math.max(0, e.half)).toFixed(2) + ' ' + e.y.toFixed(2))
        const first = edges[0]

        // 下球顶面：中间鼓起小沙丘（锥形），用两段贝塞尔从左右边缘收拢到尖端
        if (!isTop && moundHeight > 0.4) {
          const baseY = first.y
          const peakY = Math.max(HOURGLASS.neck + 1, baseY - moundHeight)
          // 沙丘宽度：以落点为中心，约 60% 球宽
          const moundHalf = Math.max(4, halfOf(baseY) * 1.05)
          const leftFoot = 50 - moundHalf
          const rightFoot = 50 + moundHalf
          return 'M' + (50 - Math.max(0, first.half)).toFixed(2) + ' ' + baseY.toFixed(2) + ' ' +
            left.slice(1).join(' ') + ' ' + right.join(' ') + ' ' +
            'L' + rightFoot.toFixed(2) + ' ' + baseY.toFixed(2) + ' ' +
            'Q' + (rightFoot - moundHalf * 0.35).toFixed(2) + ' ' + (peakY + 0.6).toFixed(2) + ' ' +
            '50 ' + peakY.toFixed(2) + ' ' +
            'Q' + (leftFoot + moundHalf * 0.35).toFixed(2) + ' ' + (peakY + 0.6).toFixed(2) + ' ' +
            leftFoot.toFixed(2) + ' ' + baseY.toFixed(2) + ' Z'
        }
        // 上球：沙面微微下凹（细颈处被抽走），在中间做一点弧度
        if (isTop) {
          const topY = first.y
          const cY = topY + 1.6
          return 'M' + (50 - Math.max(0, first.half)).toFixed(2) + ' ' + topY.toFixed(2) + ' ' +
            'Q50 ' + cY.toFixed(2) + ' ' + (50 + Math.max(0, first.half)).toFixed(2) + ' ' + topY.toFixed(2) + ' ' +
            right.join(' ') + ' ' + left.slice(1).join(' ') + ' Z'
        }
        return 'M' + (50 - Math.max(0, first.half)).toFixed(2) + ' ' + first.y.toFixed(2) + ' ' +
          left.slice(1).join(' ') + ' ' + right.join(' ') + ' Z'
      }

      // ── 主组件 ──────────────────────────────────────────────
      /**
       * 跳到插件管理页（即本插件的配置页）。
       * 通过 Cordis 的 layout 服务切换主面板；服务不可用时降级为提示。
       */
      function openPluginConfig() {
        try {
          /*
           * 优先用 pluginNavigation.openBundle(包名)：直接打开「本插件」的详情页，
           * 也就是带时段设置的那一页（不会改动当前 Session）。
           * 拿不到这个服务时，退化为只切到插件列表页。
           */
          const nav = pluginCtx && typeof pluginCtx.get === 'function'
            ? pluginCtx.get('pluginNavigation')
            : null
          if (nav && typeof nav.openBundle === 'function') {
            nav.openBundle(PLUGIN_ID_PACKAGE)
            return
          }
          console.warn('[workday-lantern] pluginNavigation 不可用，退化为打开插件列表页')
          if (!layoutService && pluginCtx && typeof pluginCtx.get === 'function') {
            layoutService = pluginCtx.get('layout') || null
          }
          if (layoutService && typeof layoutService.selectPanel === 'function') {
            layoutService.selectPanel(PLUGIN_MANAGER_PANEL_ID)
            return
          }
          console.warn('[workday-lantern] layout 服务也不可用，无法跳转')
        } catch (error) {
          console.error('[workday-lantern] 跳转插件详情失败', error)
        }
      }

      function WorkdayLantern() {
        const [now, setNow] = React.useState(() => new Date())
        const [layout, setLayout] = React.useState(readLayout)
        // 时段配置：来自 localStorage，设置页改动后通过 storage 事件实时同步
        const [slots, setSlots] = React.useState(readSlots)
        const [dragging, setDragging] = React.useState(false)
        const rootRef = React.useRef(null)
        const dragRef = React.useRef(null)
        const resizeRef = React.useRef(null)

        /*
         * 时段配置实时同步：设置页写入 localStorage 后，
         * 同源的其他窗口会收到 storage 事件，面板立刻换成新时段。
         */
        React.useEffect(() => {
          // 跨窗口改动走 storage 事件；同页改动走自定义事件（见 writeSlots）
          const sync = () => setSlots(readSlots())
          const onStorage = (event) => {
            if (event.key !== null && event.key !== SLOTS_STORAGE_KEY) return
            sync()
          }
          window.addEventListener('storage', onStorage)
          window.addEventListener(SLOTS_CHANGED_EVENT, sync)
          return () => {
            window.removeEventListener('storage', onStorage)
            window.removeEventListener(SLOTS_CHANGED_EVENT, sync)
          }
        }, [])

        /*
         * 秒级心跳 + 后台暂停。
         * · 间隔 1000ms：界面只显示到秒，1 秒一次足够（原来是 120ms，白白耗 CPU）
         * · 标签页隐藏时停掉定时器，回到前台立刻补一次刷新
         *   —— 否则 DSH 挂在后台一整天，这一天就白转 8 万多次
         */
        React.useEffect(() => {
          let timer = null
          /*
           * 心跳去重：界面只显示到秒，同一秒内重复 tick 没有任何意义。
           * 旧写法每秒无条件 setState，即使秒数没变也触发整棵树重渲染
           * （连带 ~660 个沙粒节点重新 diff），纯属浪费。
           */
          let lastSecond = -1
          const tick = () => {
            const next = new Date()
            const second = Math.floor(next.getTime() / 1000)
            if (second === lastSecond) return
            lastSecond = second
            setNow(next)
          }
          const start = () => {
            if (timer !== null) return
            tick()
            timer = window.setInterval(tick, 1000)
          }
          const stop = () => {
            if (timer === null) return
            window.clearInterval(timer)
            timer = null
          }
          const onVisibility = () => {
            if (window.document.hidden) stop()
            else start()
          }
          if (!window.document.hidden) start()
          window.document.addEventListener('visibilitychange', onVisibility)
          return () => {
            stop()
            window.document.removeEventListener('visibilitychange', onVisibility)
          }
        }, [])

        const state = React.useMemo(() => computeState(now, slots), [now, slots])
        const layoutRef = React.useRef(layout)
        /*
         * 必须在 effect 里同步 ref，不能直接在渲染函数体里赋值 ——
         * 渲染期写 ref 属于副作用，严格模式或并发渲染下可能写入"并未提交"的值。
         * 这里放 effect 里，layout 提交后再同步，语义正确。
         */
        React.useEffect(() => {
          layoutRef.current = layout
        }, [layout])

        const persist = React.useCallback((next) => {
          writeLayout(next)
        }, [])

        // ── 拖动：标题栏区域 / 工具条拖动把手 ──
        // 说明：用 mouse 事件而非 pointer 事件——桌面端部分输入路径会吞掉 pointerdown，
        // 只下发兼容 mousedown；mouse/move/up 组合在这两种情况下都能收到。
        const startDrag = React.useCallback((event) => {
          if (typeof event.button === 'number' && event.button !== 0) return
          // 交互控件不参与拖动：按钮 / 输入框 / 缩放手柄 / 可聚焦元素
          const target = event.target
          if (target && typeof target.closest === 'function'
            && target.closest('button, a, input, textarea, select, [contenteditable], .wdl-resize')) {
            return
          }
          event.preventDefault()
          const root = rootRef.current
          if (!root) return
          const box = root.getBoundingClientRect()
          dragRef.current = { dx: event.clientX - box.left, dy: event.clientY - box.top }
          // 拖动即退出全屏：全屏是铺满的，拖它没有意义，先还原成窗口再拖
          if (layoutRef.current.maximised) {
            setLayout((prev) => {
              const next = {
                ...prev,
                w: clamp(prev.restoreW ?? DEFAULT_W, MIN_W, MAX_W),
                h: clamp(prev.restoreH ?? DEFAULT_H, MIN_H, MAX_H),
                maximised: false,
              }
              layoutRef.current = next
              return next
            })
          }
          setDragging(true)
        }, [])

        // ── 缩放：右下角手柄 ──
        const startResize = React.useCallback((event) => {
          if (typeof event.button === 'number' && event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          const current = layoutRef.current
          resizeRef.current = { startX: event.clientX, startY: event.clientY, w: current.w, h: current.h }
          setDragging(true)
        }, [])

        React.useEffect(() => {
          if (!dragging) return undefined
          const onMove = (event) => {
            if (dragRef.current) {
              const root = rootRef.current
              const box = root ? root.getBoundingClientRect() : { width: layoutRef.current.w, height: layoutRef.current.h }
              const limitW = Math.min(box.width, window.innerWidth - 8)
              const limitH = Math.min(box.height, window.innerHeight - 8)
              const maxX = Math.max(4, window.innerWidth - limitW - 4)
              const maxY = Math.max(4, window.innerHeight - limitH - 4)
              const x = clamp(event.clientX - dragRef.current.dx, 4, maxX)
              const y = clamp(event.clientY - dragRef.current.dy, 4, maxY)
              // 拖动中同步写 ref：mouseup 时无重渲染，读不到最新 layout 就会存旧值
              setLayout((prev) => {
                const next = { ...prev, x, y }
                layoutRef.current = next
                return next
              })
              return
            }
            if (resizeRef.current) {
              const r = resizeRef.current
              setLayout((prev) => {
                const next = {
                  ...prev,
                  w: clamp(r.w + (event.clientX - r.startX), MIN_W, MAX_W),
                  h: clamp(r.h + (event.clientY - r.startY), MIN_H, MAX_H),
                }
                layoutRef.current = next
                return next
              })
            }
          }
          const onUp = () => {
            dragRef.current = null
            resizeRef.current = null
            setDragging(false)
            persist(layoutRef.current)
          }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
          return () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
          }
        }, [dragging, persist])

        // Ctrl + 滚轮缩放（不需要拖手柄）；全屏状态不缩放，避免和「铺满」打架
        React.useEffect(() => {
          const root = rootRef.current
          if (!root) return undefined
          const onWheel = (event) => {
            if (!event.ctrlKey) return
            event.preventDefault()
            const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08
            setLayout((prev) => {
              if (prev.maximised) return prev
              const next = {
                ...prev,
                w: Math.round(clamp(prev.w * factor, MIN_W, MAX_W)),
                h: Math.round(clamp(prev.h * factor, MIN_H, MAX_H)),
              }
              layoutRef.current = next
              persist(next)
              return next
            })
          }
          root.addEventListener('wheel', onWheel, { passive: false })
          return () => root.removeEventListener('wheel', onWheel)
        }, [persist])

        // 窗口变化时把浮窗拉回可视区
        React.useEffect(() => {
          const onResizeWindow = () => {
            setLayout((prev) => {
              if (prev.x === null) return prev
              return {
                ...prev,
                x: clamp(prev.x, 4, Math.max(4, window.innerWidth - prev.w - 4)),
                y: clamp(prev.y, 4, Math.max(4, window.innerHeight - prev.h - 4)),
              }
            })
          }
          window.addEventListener('resize', onResizeWindow)
          return () => window.removeEventListener('resize', onResizeWindow)
        }, [])

        // 恢复默认位置：右侧居中（清空用户拖过的坐标；全屏状态先退出，否则全屏盖满看不出来）
        const resetToDefault = React.useCallback(() => {
          setLayout((prev) => {
            const next = { ...prev, x: null, y: null, minimised: false, maximised: false }
            persist(next)
            return next
          })
        }, [persist])

        // 恢复默认大小：长宽回到初始值，位置保持当前
        const resetSize = React.useCallback(() => {
          setLayout((prev) => {
            const next = { ...prev, w: DEFAULT_W, h: DEFAULT_H, maximised: false }
            persist(next)
            return next
          })
        }, [persist])

        /**
         * 一键全屏 / 还原。
         * 全屏 = 铺满主内容区（避开左侧边栏），尺寸与位置一起接管；
         * 再点一次回到全屏前的尺寸，位置回到右侧居中。
         */
        const toggleMaximise = React.useCallback(() => {
          setLayout((prev) => {
            if (prev.maximised) {
              const next = {
                ...prev,
                w: clamp(prev.restoreW ?? DEFAULT_W, MIN_W, MAX_W),
                h: clamp(prev.restoreH ?? DEFAULT_H, MIN_H, MAX_H),
                x: null,
                y: null,
                minimised: false,
                maximised: false,
              }
              persist(next)
              return next
            }
            const next = {
              ...prev,
              restoreW: prev.w,
              restoreH: prev.h,
              maximised: true,
              minimised: false,
            }
            persist(next)
            return next
          })
        }, [persist])

        const toggleMinimise = React.useCallback(() => {
          setLayout((prev) => {
            const next = { ...prev, minimised: !prev.minimised }
            persist(next)
            return next
          })
        }, [persist])

        // 当前时段进度：沙漏、百分比线、两个计时共用这一个值，天然四段独立
        const sandRemaining = clamp(1 - state.progress, 0, 1)
        // 计时：正计时（本段已开始多久）+ 倒计时（本段还剩多久）
        const elapsedTime = splitSeconds(state.elapsed)
        const leftTime = splitSeconds(state.remaining)
        // 沙流相位：按秒驱动（每 2 秒一轮回），心跳 1s 刚好每次取到不同相位
        // 只有「本段已走满」才停住沙流（不区分周末：四段始终照常运行）
        const resting = state.remaining <= 0
        // 全屏：铺满主内容区（resolveStageArea 已避开左侧边栏与窗口留边）
        const stage = layout.maximised ? resolveStageArea() : null
        const effectiveW = stage ? stage.width : layout.w
        const effectiveH = stage ? stage.height : layout.h
        const scale = clamp(Math.min(effectiveW / DEFAULT_W, effectiveH / DEFAULT_H), 0.75, 2.4)
        // 收起态实际高度由内容决定（≈30px），定位计算也用它，避免位置偏到屏幕外
        const MINI_HEIGHT = 30
        const panelHeight = layout.minimised ? MINI_HEIGHT : effectiveH
        // 始终浮动定位：全屏铺满；用户拖过就贴用户的位置；没拖过就贴右侧居中
        const defaultPosition = resolveDefaultPosition(effectiveW, panelHeight)
        const floating = true
        const positionX = stage ? stage.left : (layout.x === null ? defaultPosition.x : layout.x)
        const positionY = stage ? stage.top : (layout.y === null ? defaultPosition.y : layout.y)

        const style = {
          '--wdl-scale': scale.toFixed(3),
          width: effectiveW + 'px',
          height: layout.minimised ? 'auto' : effectiveH + 'px',
        }
        if (floating) {
          style.position = 'fixed'
          style.left = positionX + 'px'
          style.top = positionY + 'px'
        }

        // 已开始 / 剩余 百分比：本段内互补，相加恒为 100%
        const startedPercent = clamp(state.progress * 100, 0, 100)
        const remainPercent = clamp((1 - state.progress) * 100, 0, 100)
        // 顶栏右侧显示本段结束时刻（未命中时段时为空）
        const endLabel = state.matched ? formatClock(state.slotEnd) : ''

        return h('div', {
          ref: rootRef,
          className: 'wdl-panel' + (floating ? ' wdl-floating' : '') + (dragging ? ' wdl-dragging' : '') + (layout.minimised ? ' wdl-mini' : '') + (layout.maximised ? ' wdl-max' : ''),
          style,
          'data-workday-lantern': '',
          // 整个面板都能按住拖（按钮和缩放手柄在 startDrag 里被排除）
          onMouseDown: startDrag,
        },
        layout.minimised
          /*
           * 收起态：一行。顺序必须与颜色语义一致 ——
           *   左：已过百分比（绿） + 进度条 + 右：剩余时间（红）
           * 之前把「剩余时间」放在左边、「已过」放右边，与进度条左绿右红正好错位，
           * 看的时候数字和颜色对不上，所以调换。
           */
          ? h('div', { className: 'wdl-mini-row' },
            state.matched
              ? h(React.Fragment, null,
                h('div', { className: 'wdl-mini-pct' }, startedPercent.toFixed(0) + '%'),
                h('div', { className: 'wdl-mini-track' },
                  h('div', { className: 'wdl-track-started', style: { width: startedPercent.toFixed(2) + '%' } }),
                  h('div', { className: 'wdl-track-left', style: { width: remainPercent.toFixed(2) + '%' } }),
                ),
                h('div', { className: 'wdl-mini-num' }, leftTime.hours + ':' + leftTime.minutes + ':' + leftTime.seconds),
              )
              : h('div', { className: 'wdl-mini-idle' }, '未配置时段'),
            /*
             * 收起态只保留「展开」按钮，不放设置按钮 ——
             * 收起态面板很窄，两个按钮会把进度条挤没；设置入口在展开态提供即可。
             */
            h('button', { className: 'wdl-btn', type: 'button', onClick: toggleMinimise, title: '展开' }, h('span', { 'aria-hidden': true }, '▢')),
          )
          // 展开态：顶栏 / 主体 / 底部进度 三段式
          : h('div', { className: 'wdl-shell' },
            // ── 顶栏：时段名 + 结束时刻 + 工具条 ──
            h('div', { className: 'wdl-top' },
              h('span', { className: 'wdl-slot' }, state.matched ? state.slotLabel : '未配置时段'),
              h('div', { className: 'wdl-top-right' },
                state.matched ? h('span', { className: 'wdl-slot-end' }, endLabel + ' 结束') : null,
                h('div', { className: 'wdl-tools' },
                  h('button', { className: 'wdl-btn', type: 'button', onClick: openPluginConfig, title: '打开时段设置' }, h('span', { 'aria-hidden': true }, '⚙')),
                  h('button', { className: 'wdl-btn', type: 'button', onClick: toggleMinimise, title: '收起' }, h('span', { 'aria-hidden': true }, '—')),
                  h('button', { className: 'wdl-btn', type: 'button', onClick: resetSize, title: '恢复默认大小' }, h('span', { 'aria-hidden': true }, '◱')),
                  h('button', { className: 'wdl-btn', type: 'button', onClick: resetToDefault, title: '回到默认位置（右侧居中）' }, h('span', { 'aria-hidden': true }, '⌂')),
                  h('button', { className: 'wdl-btn', type: 'button', onClick: toggleMaximise, title: layout.maximised ? '还原窗口' : '一键全屏放大' }, h('span', { 'aria-hidden': true }, layout.maximised ? '❐' : '⛶')),
                ),
              ),
            ),
            /*
             * 主体：只有「当前时间命中某个时段」才显示沙漏与计时；
             * 未命中时整块显示提示 —— 这是本次配置化改造的核心行为。
             */
            state.matched
              ? h('div', { className: 'wdl-main' },
                h('div', { className: 'wdl-main-left' }, h(Hourglass, { remaining: sandRemaining, resting })),
                h('div', { className: 'wdl-main-right' },
                  h('div', { className: 'wdl-hero', title: '本段剩余时间' },
                    h('span', { className: 'wdl-hero-num' },
                      leftTime.hours + ':' + leftTime.minutes + ':' + leftTime.seconds),
                    h('span', { className: 'wdl-hero-cap' }, '剩余'),
                  ),
                  h('div', { className: 'wdl-sub', title: '本段已开始时间' },
                    h('span', { className: 'wdl-sub-num' },
                      elapsedTime.hours + ':' + elapsedTime.minutes + ':' + elapsedTime.seconds),
                    h('span', { className: 'wdl-sub-cap' }, '已开始'),
                  ),
                ),
              )
              : h('div', { className: 'wdl-idle' },
                h('div', { className: 'wdl-idle-icon', 'aria-hidden': true }, '⏱'),
                h('div', { className: 'wdl-idle-text' }, '该时间段未配置'),
                h('div', { className: 'wdl-idle-hint' }, '在 设置 → 下班倒计时 里添加时段'),
              ),
            // ── 底部进度线：只在命中时段时显示 ──
            state.matched
              ? h('div', { className: 'wdl-foot' },
                h('span', { className: 'wdl-foot-pct wdl-foot-pct-started' }, startedPercent.toFixed(2) + '%'),
                h('div', {
                  className: 'wdl-track',
                  title: '已开始 ' + startedPercent.toFixed(2) + '% · 剩余 ' + remainPercent.toFixed(2) + '%',
                },
                h('div', { className: 'wdl-track-started', style: { width: startedPercent.toFixed(2) + '%' } }),
                h('div', { className: 'wdl-track-left', style: { width: remainPercent.toFixed(2) + '%' } }),
                ),
                h('span', { className: 'wdl-foot-pct wdl-foot-pct-left' }, remainPercent.toFixed(2) + '%'),
              )
              : h('div', { className: 'wdl-foot wdl-foot-idle' }),
          ),
          // 缩放手柄（两种状态都有）
          h('div', { className: 'wdl-resize', onMouseDown: startResize, title: '拖动缩放' }),
        )
      }

      /**
       * 用错误边界包住面板组件。
       * @param {Function} Inner 原组件
       * @returns {Function} 包装后的组件
       */
      function wrapPanel(Inner) {
        function Wrapped(props) {
          return h(PanelBoundary, null, h(Inner, props))
        }
        Wrapped.displayName = 'WorkdayLanternBounded'
        return Wrapped
      }

      /**
       * 错误边界：包住面板。
       * 目的：shell.overlay 里任何一次渲染抛异常，都会让该 occupant 被判定为
       * active:false（整个插件从界面上消失、控制台也看不到原因）。
       * 这里兜住异常并降级显示，同时把错误打到控制台，便于定位。
       */
      class PanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) {
          return { error }
        }

        componentDidCatch(error, info) {
          console.error('[workday-lantern] 面板渲染失败', error, info)
        }

        render() {
          if (this.state.error) {
            return React.createElement('div', {
              className: 'wdl-panel wdl-floating wdl-crash',
              style: { position: 'fixed', right: '16px', top: '40%', width: '240px', height: 'auto', padding: '10px 12px' },
            },
            React.createElement('div', { style: { fontWeight: 700, color: '#ff8a75', marginBottom: '4px' } }, '下班倒计时渲染出错'),
            React.createElement('div', { style: { fontSize: '11px', opacity: 0.7, wordBreak: 'break-all' } },
              String(this.state.error && this.state.error.message || this.state.error)),
            )
          }
          return this.props.children
        }
      }

      /**
       * 插件页里的配置卡片（plugins.bundle.config 席位）。
       * 该席位会传 props.view：
       *   'summary' —— 只渲染一行摘要（插件页折叠态）
       *   'page'    —— 渲染完整表单（展开后）
       * @param {object} props 席位传入的属性
       * @returns {object} React 元素
       */
      function BundleConfigCard(props) {
        /*
         * 摘要视图只在插件页折叠态显示，但插件页渲染频率不可控。
         * readSlots() 每次都 JSON.parse，没必要 —— 用 useState 只读一次，
         * 配置变更由 storage / 自定义事件驱动更新。
         */
        const [slots, setSlots] = React.useState(readSlots)
        React.useEffect(() => {
          const sync = () => setSlots(readSlots())
          const onStorage = (event) => {
            if (event.key !== null && event.key !== SLOTS_STORAGE_KEY) return
            sync()
          }
          window.addEventListener('storage', onStorage)
          window.addEventListener(SLOTS_CHANGED_EVENT, sync)
          return () => {
            window.removeEventListener('storage', onStorage)
            window.removeEventListener(SLOTS_CHANGED_EVENT, sync)
          }
        }, [])

        const view = props && props.view ? props.view : 'page'
        if (view === 'summary') {
          const summary = slots.length === 0
            ? '未配置时段'
            : slots.map((x) => x.label + ' ' + minutesToLabel(x.start) + '-' + minutesToLabel(x.end)).join(' · ')
          return h('div', { className: 'wdl-set-summary', title: summary }, summary)
        }
        return h(SlotsSettings, null)
      }

      // ── 设置页：时段增删改 ─────────────────────────────────
      /** 把分钟数格式化成 "HH:mm" */
      function minutesToLabel(minutes) {
        const safe = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
        return String(Math.floor(safe / 60)).padStart(2, '0') + ':' + String(safe % 60).padStart(2, '0')
      }

      /** 把 "HH:mm" 解析成分钟数；非法返回 null */
      function labelToMinutes(text) {
        const matched = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
        if (!matched) return null
        const h = Number(matched[1])
        const m = Number(matched[2])
        if (!Number.isFinite(h) || !Number.isFinite(m) || h > 23 || m > 59) return null
        return h * 60 + m
      }

      /**
       * 设置页：管理可配置时段。
       * 数据存 localStorage，写入后面板通过 storage 事件即时同步。
       */
      function SlotsSettings() {
        const [slots, setSlots] = React.useState(readSlots)
        const [error, setError] = React.useState('')
        const [warning, setWarning] = React.useState('')

        // 外部（另一个窗口）改动时同步到本设置页，避免显示过期数据
        React.useEffect(() => {
          const sync = () => setSlots(readSlots())
          const onStorage = (event) => {
            if (event.key !== null && event.key !== SLOTS_STORAGE_KEY) return
            sync()
          }
          window.addEventListener('storage', onStorage)
          return () => window.removeEventListener('storage', onStorage)
        }, [])

        /**
         * 判断两个时段是否重叠（把跨零点的段展开成 [start, end+1440) 再比较）。
         * @param {object} a 时段 A
         * @param {object} b 时段 B
         * @returns {boolean}
         */
        const overlapOf = (a, b) => {
          const toRange = (slot) => {
            const isOv = slot.end <= slot.start
            return { s: slot.start, e: isOv ? slot.end + MINUTES_PER_DAY : slot.end }
          }
          const ra = toRange(a)
          const rb = toRange(b)
          // 考虑 b 整体前移一天，处理跨零点段与普通段交错的情况
          for (const shift of [0, -MINUTES_PER_DAY, MINUTES_PER_DAY]) {
            if (ra.s < rb.e + shift && rb.s + shift < ra.e) return true
          }
          return false
        }

        /** 写回配置并刷新本地状态 */
        const commit = (next) => {
          // 校验：每段时长为正
          const bad = next.find((x) => x.end === x.start)
          if (bad) {
            setError('「' + bad.label + '」开始与结束时间相同，请调整')
            return
          }
          /*
           * 重叠只提示、不阻止：用户可能故意配重叠段。
           * 说明命中规则，避免"为什么显示的是这一段"的困惑。
           */
          let overlapMsg = ''
          for (let i = 0; i < next.length && !overlapMsg; i += 1) {
            for (let j = i + 1; j < next.length; j += 1) {
              if (overlapOf(next[i], next[j])) {
                overlapMsg = '「' + next[i].label + '」与「' + next[j].label
                  + '」时间重叠，面板会优先显示排序靠前的「' + next[i].label + '」'
                break
              }
            }
          }
          setError('')
          setWarning(overlapMsg)
          writeSlots(next)
          setSlots(next)
        }

        const updateSlot = (id, patch) => {
          commit(slots.map((x) => (x.id === id ? { ...x, ...patch } : x)))
        }

        const removeSlot = (id) => {
          if (slots.length <= 1) {
            setError('至少要保留一个时段')
            return
          }
          commit(slots.filter((x) => x.id !== id))
        }

        const addSlot = () => {
          /*
           * 新段接在最后一段之后，默认 1 小时。
           * 注意：旧写法 `(last.end + MINUTES_PER_DAY) % MINUTES_PER_DAY` 是恒等运算
           * （last.end 本身就在 0~1439，加 1440 再取模等于没加），
           * 结果新段起点永远等于上一段的结束点、长度为 0，与"+"的语义不符。
           * 正确做法：起点 = 上一段结束点（不取模），终点 = 起点 + 60，再各自归一化到 0~1439。
           */
          const last = slots[slots.length - 1]
          const rawStart = last ? last.end : 9 * 60
          const start = ((rawStart % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
          const end = (((start + 60) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
          const next = slots.concat({
            id: 's' + Date.now(),
            label: '新时段' + (slots.length + 1),
            start,
            end,
          })
          commit(next)
        }

        const resetDefault = () => {
          commit(DEFAULT_SLOTS.map((x) => ({ ...x })))
        }

        return h('div', { className: 'wdl-set' },
          h('div', { className: 'wdl-set-title' }, '下班倒计时 · 时段设置'),
          h('div', { className: 'wdl-set-desc' },
            '只填你关心的时段即可，不必覆盖全天。当前时间不在任何时段内时，面板会显示「该时间段未配置」。'),
          error ? h('div', { className: 'wdl-set-error' }, error) : null,
          warning ? h('div', { className: 'wdl-set-warn' }, warning) : null,
          h('div', { className: 'wdl-set-head' },
            h('span', { className: 'wdl-set-col-name' }, '名称'),
            h('span', { className: 'wdl-set-col-time' }, '开始'),
            h('span', { className: 'wdl-set-col-time' }, '结束'),
            h('span', { className: 'wdl-set-col-op' }, ''),
          ),
          h('div', { className: 'wdl-set-rows' },
            slots.map((slot) => h('div', { className: 'wdl-set-row', key: slot.id },
              h('input', {
                className: 'wdl-set-input wdl-set-col-name',
                value: slot.label,
                maxLength: 12,
                onChange: (e) => updateSlot(slot.id, { label: e.target.value }),
                title: '时段名称',
              }),
              h('input', {
                className: 'wdl-set-input wdl-set-col-time',
                type: 'time',
                step: 300,
                value: minutesToLabel(slot.start),
                onChange: (e) => {
                  /*
                   * 清空时 value 是空串：旧写法 labelToMinutes 返回 null 就整个跳过，
                   * 受控 value 立刻弹回旧值，用户根本没法把时间改掉。
                   * 现在显式忽略空串（保持输入中状态），只有解析成功才写回配置。
                   */
                  if (e.target.value === '') return
                  const v = labelToMinutes(e.target.value)
                  if (v !== null) updateSlot(slot.id, { start: v })
                },
                title: '开始时间',
              }),
              h('input', {
                className: 'wdl-set-input wdl-set-col-time',
                type: 'time',
                step: 300,
                value: minutesToLabel(slot.end),
                onChange: (e) => {
                  if (e.target.value === '') return
                  const v = labelToMinutes(e.target.value)
                  if (v !== null) updateSlot(slot.id, { end: v })
                },
                title: '结束时间（早于开始时间表示跨零点）',
              }),
              h('button', {
                className: 'wdl-set-del wdl-set-col-op',
                type: 'button',
                disabled: slots.length <= 1,
                onClick: () => removeSlot(slot.id),
                title: slots.length <= 1 ? '至少保留一个时段' : '删除该时段',
              }, '删除'),
            )),
          ),
          h('div', { className: 'wdl-set-actions' },
            h('button', { className: 'wdl-set-add', type: 'button', onClick: addSlot }, '+ 添加时段'),
            h('button', { className: 'wdl-set-reset', type: 'button', onClick: resetDefault }, '恢复默认'),
          ),
          h('div', { className: 'wdl-set-hint' },
            '提示：结束时间早于开始时间表示跨零点（如 22:00 → 02:00）。'),
        )
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          // 保存 ctx，供"设置按钮跳转插件页"使用；服务可能晚就绪，点击时再取
          pluginCtx = ctx
          try {
            layoutService = typeof ctx.get === 'function' ? (ctx.get('layout') || null) : null
          } catch (error) {
            console.warn('[workday-lantern] 读取 layout 服务失败', error)
          }

          // 样式与插槽注册都放在 ctx.effect 里，卸载时自动清理
          ctx.effect(() => {
            const removeStyle = insertStyles(CSS)
            return () => removeStyle()
          }, PLUGIN_ID + ':styles')

          /*
           * 面板挂在 shell.overlay（框架级浮层），不再挂会话标题栏。
           * 原因：标题栏只在「对话视图」里渲染，切到插件/设置等页面时对话视图消失，
           * 面板也就跟着没了。overlay 覆盖整个框架、位于所有列之上，
           * 因此在 DSH 的任何页面都会显示。
           * 注意：overlay 层本身是 click-through 的，面板需要自己开 pointer-events，
           * 否则连按钮都点不到（样式里已处理）。
           */
          /*
           * 同时注入两个宿主，任一生效即可见（双保险）：
           * · shell.overlay       —— 框架级浮层，任何页面都显示（目标形态）
           * · conversation.header —— 对话标题栏，作为 overlay 不可用时的兜底
           * 两者不会重复显示：overlay 注册成功后，标题栏那个会被 CSS 隐藏
           * （同一组件渲染两次会重叠，这里用 data-wdl-host 区分并隐藏兜底的那份）。
           */
          ctx.effect(() => {
            const remove = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
              name: 'shell.overlay',
              id: PLUGIN_ID,
              order: 10,
            }, wrapPanel(WorkdayLantern)))
            return () => {
              if (typeof remove === 'function') remove()
            }
          }, PLUGIN_ID + ':panel')

          // 设置页：时段增删改
          /*
           * 配置卡片挂到「插件」页的正确席位：plugins.bundle.config。
           *
           * 依据（本机 @linxin666/dsh-client-ui-task-board 的 plugin-card-seat.ts）：
           *   · web-ui.plugin.item 是 dsh-web-settings 家族的列表席位，
           *     只服务该家族的插件，外部插件注册进去也没有渲染位置（已实测无效）；
           *   · plugins.bundle.config 才是 harness 插件管理页的官方席位，
           *     key 填 bundle 包名，渲染在该 bundle 页面的描述与插件行之间。
           *
           * 这个席位会传 ownerProps.view（'summary' | 'page'）：
           *   summary 只渲染一行摘要，page 渲染完整表单。
           * 配置只放在插件页这一处，不再往 DSH 全局设置里塞入口。
           */
          ctx.effect(() => {
            const seatDeclared = (name) => {
              try {
                return typeof ctx.slots.spec !== 'function' || ctx.slots.spec(name) !== undefined
              } catch (error) {
                console.warn('[workday-lantern] 探测插槽失败', name, error)
                return false
              }
            }

            /*
             * 尝试注册配置卡片。
             * 返回值三态：函数 = 注册成功；'occupied' = 该 key 已被注册过（视同成功）；
             * null = 席位还没声明，稍后重试。
             *
             * 注意「重复注册」这条错误：slots/changed 会反复触发，而 Cordis 对已占用的
             * keyed 席位会抛错。若把这种错误当成"失败"继续重试，日志会被同一条警告刷屏。
             * 所以这里显式识别该错误并当作已就位处理。
             */
            const installBundleCard = () => {
              if (!seatDeclared('plugins.bundle.config')) return null
              try {
                return ctx.slots.register({
                  name: 'plugins.bundle.config',
                  key: PLUGIN_ID_PACKAGE,
                }, BundleConfigCard)
              } catch (error) {
                const msg = String(error && error.message ? error.message : error)
                if (msg.indexOf('already has an entry') >= 0) return 'occupied'
                console.warn('[workday-lantern] 注册 bundle 配置卡片失败', error)
                return null
              }
            }

            const firstResult = installBundleCard()
            let removeCard = firstResult === 'occupied' ? null : firstResult
            /*
             * 席位可能晚于本插件声明：出现后补注册一次。
             * 只有「席位尚未声明」（返回 null）才值得重试；一旦注册成功或已被占用，
             * 就永久停止重试，否则 slots/changed 每次触发都会刷一条重复注册警告。
             */
            let cardSettled = firstResult !== null

            const retry = () => {
              if (cardSettled) return
              const result = installBundleCard()
              if (result === null) return
              removeCard = result === 'occupied' ? null : result
              cardSettled = true
            }
            let offChanged = null
            try {
              if (typeof ctx.on === 'function') {
                const handle = ctx.on('slots/changed', retry)
                offChanged = typeof handle === 'function' ? handle : null
              }
            } catch (error) {
              console.warn('[workday-lantern] 订阅 slots/changed 失败', error)
            }

            return () => {
              if (typeof offChanged === 'function') offChanged()
              if (typeof removeCard === 'function') removeCard()
            }
          }, PLUGIN_ID + ':settings')
        },
      }

      /** 用 `<style>` 注入样式，返回清理函数（卸载时移除） */
      function insertStyles(css) {
        const existing = window.__DSH_WORKDAY_STYLES__
        if (existing && typeof existing.dispose === 'function') existing.dispose()
        const element = window.document.createElement('style')
        element.setAttribute('data-workday-lantern-style', '')
        element.textContent = css
        window.document.head.appendChild(element)
        const handle = {
          dispose() {
            if (element.parentNode) element.parentNode.removeChild(element)
            if (window.__DSH_WORKDAY_STYLES__ === handle) window.__DSH_WORKDAY_STYLES__ = undefined
          },
        }
        window.__DSH_WORKDAY_STYLES__ = handle
        return handle.dispose
      }
    },
  })
})()

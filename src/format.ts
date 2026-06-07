/**
 * @fileoverview 纯展示用的格式化函数模块。将数值转换为人类可读字符串，
 * 包括运行时长、网络速率、百分比和 sparkline 趋势图。无副作用，单元测试友好。
 */

/**
 * 将秒数格式化为人类可读的运行时长。
 * @param seconds 秒数；null / 负数 / NaN 时显示 N/A
 * @returns 格式如 "3d 4h"、"1h 30m"、"5m"、"0m" 的字符串
 */
export function formatUptime (seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'N/A'
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (d > 0) return `${d}d ${h}h`
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
}

/**
 * 将字节/秒转换为人类可读速率字符串。1024 进位，固定 1 位小数，K/M/G 后缀 + B/s。
 * @param bps 字节/秒；null / NaN 时显示 "—"
 * @returns 格式如 "500B/s"、"1.5KB/s"、"100KB/s"、"2.5MB/s" 的字符串
 */
export function formatRate (bps: number | null): string {
    if (bps === null || !Number.isFinite(bps)) return '—'
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
    let v = bps
    let i = 0
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
    // 小于 10 时保留 1 位小数，避免 "0KB/s" 抖动；其他保留整数
    return v < 10 && i > 0 ? `${v.toFixed(1)}${units[i]}` : `${Math.round(v)}${units[i]}`
}

/**
 * 将数值格式化为百分比字符串，自动 clamp 到 [0, 100]。
 * @param p 百分比数值；null / NaN 时显示 "—"
 * @returns 格式如 "37%"、"100%"、"0%" 的字符串
 */
export function formatPercent (p: number | null): string {
    if (p === null || !Number.isFinite(p)) return '—'
    return `${Math.max(0, Math.min(100, Math.round(p)))}%`
}

/**
 * 用 Unicode 块字符把一串数值渲染成 sparkline（迷你趋势图）。
 *
 *   sparkline([10, 40, 25, 80, 60], 0, 100) → "▁▃▂▇▅"
 *   sparkline([10, 40], 0, 100, 5)           → "   ▁▃"  (左边补空格到 5 格)
 *
 * 为什么用文本而不是 SVG/canvas：
 *   - 0 依赖：不引入图表库
 *   - 自动跟随终端字号（用户调字号时跟着缩放）
 *   - 渲染成本几乎为 0，定时刷新无压力
 *
 * @param values 数值数组，null 值渲染为空格
 * @param min 最小值（用于归一化）；省略时自动取数组最小值
 * @param max 最大值（用于归一化）；省略时自动取数组最大值
 * @param totalSlots 目标总宽度（字符数）。数据不够时左边用空格填充。
 *                   省略时不填充，保持自然长度。
 * @returns Unicode 块字符组成的迷你趋势图字符串
 */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

export function sparkline (
    values: ReadonlyArray<number | null>,
    min?: number,
    max?: number,
    totalSlots?: number,
): string {
    const raw = values.length === 0 ? '' : _sparklineRaw(values, min, max)
    if (!totalSlots || raw.length >= totalSlots) return raw
    return ' '.repeat(totalSlots - raw.length) + raw
}

/**
 * 将数值数组映射为 Unicode 块字符，不处理填充。
 * @param values 数值数组，null 值渲染为空格
 * @param min 最小值（用于归一化）；省略时自动取数组最小值
 * @param max 最大值（用于归一化）；省略时自动取数组最大值
 * @returns Unicode 块字符序列
 */
function _sparklineRaw (
    values: ReadonlyArray<number | null>,
    min?: number,
    max?: number,
): string {
    const valid = values.filter((v): v is number => v !== null && Number.isFinite(v))
    if (valid.length === 0) return ' '.repeat(values.length)

    const lo = min ?? Math.min(...valid)
    const hi = max ?? Math.max(...valid)
    const range = hi - lo
    return values.map(v => {
        if (v === null || !Number.isFinite(v)) return ' '
        if (range <= 0) return BLOCKS[0]
        const idx = Math.max(0, Math.min(BLOCKS.length - 1,
            Math.floor((v - lo) / range * BLOCKS.length)))
        return BLOCKS[idx]
    }).join('')
}

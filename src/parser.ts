/**
 * @fileoverview 纯函数模块：将远端 probe 脚本的文本输出解析为结构化的
 * ServerStatus 对象。该模块无副作用、无外部依赖，便于 Node.js 单测。
 */

/** 一次远端服务器探针采样的结构化结果。 */
export interface ServerStatus {
    /** 服务器 IP 地址 */
    ip: string
    /** 操作系统名称与版本 */
    os: string
    /** IANA 时区标识，如 Asia/Shanghai */
    timezone: string
    /** 系统启动以来的秒数；不可用时为 null */
    uptimeSeconds: number | null
    /** CPU 使用率百分比（0-100 整数）；不可用时为 null */
    cpuPercent: number | null
    /** 内存使用率百分比（0-100 整数）；不可用时为 null */
    memPercent: number | null
    /** 网卡累计接收字节数；后端用前后两次差值计算速率 */
    netRxBytes: number | null
    /** 网卡累计发送字节数；后端用前后两次差值计算速率 */
    netTxBytes: number | null
    /** 即时下载速率（字节/秒）；首次采样时为 null */
    rxBps: number | null
    /** 即时上传速率（字节/秒）；首次采样时为 null */
    txBps: number | null
    /** CPU 占用最高的进程列表 */
    topProcesses: Array<{ command: string, cpu: number }>
    /** 本次采样的 Unix 时间戳（毫秒） */
    sampledAt: number
}

const SECTION_RE = /^===([A-Z]+)===\s*$/

/**
 * 将 probe 脚本输出按 `===SECTION===` 标记切分为键值对。
 * @param raw 远端脚本的原始文本输出
 * @returns 以节名为键、该节各行（不含节标记行）为值的字典
 */
function splitSections (raw: string): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    let current: string | null = null
    for (const line of raw.split(/\r?\n/)) {
        const m = SECTION_RE.exec(line)
        if (m) {
            current = m[1]
            result[current] = []
        } else if (current) {
            result[current].push(line)
        }
    }
    return result
}

/**
 * 将字符串安全解析为整数，处理 N/A、空字符串等边界情况。
 * @param s 待解析的字符串，可能为 undefined
 * @returns 解析后的整数；输入无效时返回 null
 */
function intOrNull (s: string | undefined): number | null {
    if (!s) return null
    const t = s.trim()
    if (!t || t === 'N/A') return null
    const n = parseInt(t, 10)
    return Number.isFinite(n) ? n : null
}

/**
 * 将字符串数组拼接为单个空格分隔的字符串，并去除首尾空白。
 * @param lines 字符串数组，可能为 undefined
 * @returns 合并后的单行字符串；输入为空时返回空串
 */
function joined (lines: string[] | undefined): string {
    return (lines ?? []).map(l => l.trim()).filter(Boolean).join(' ').trim()
}

/**
 * 解析 probe 脚本的文本输出，构建 ServerStatus 对象。
 * 同时结合上一次采样结果计算网络速率。
 * @param raw 远端 probe 脚本的原始文本输出
 * @param previous 上一次采样结果，用于计算速率差；首次采样传 null
 * @param now 当前时间戳（毫秒），默认 Date.now()
 * @returns 结构化的服务器状态快照
 */
export function parseProbeOutput (raw: string, previous: ServerStatus | null, now: number = Date.now()): ServerStatus {
    const s = splitSections(raw)

    let rxBytes: number | null = null
    let txBytes: number | null = null
    const netLine = joined(s.NET)
    if (netLine && netLine !== 'N/A') {
        const parts = netLine.split(/\s+/)
        rxBytes = intOrNull(parts[0])
        txBytes = intOrNull(parts[1])
    }

    let rxBps: number | null = null
    let txBps: number | null = null
    if (previous && rxBytes !== null && txBytes !== null
        && previous.netRxBytes !== null && previous.netTxBytes !== null) {
        const dt = (now - previous.sampledAt) / 1000
        if (dt > 0) {
            // 处理计数器回绕（重启网卡 / 重启服务器）：负数则记为 0
            rxBps = Math.max(0, (rxBytes - previous.netRxBytes) / dt)
            txBps = Math.max(0, (txBytes - previous.netTxBytes) / dt)
        }
    }

    const topProcesses: Array<{ command: string, cpu: number }> = []
    for (const line of (s.TOP ?? [])) {
        const t = line.trim()
        if (!t || t === 'N/A') continue
        const m = /^([\d.]+)\s+(.+)$/.exec(t)
        if (m) {
            const cpu = parseFloat(m[1])
            if (Number.isFinite(cpu)) {
                topProcesses.push({ cpu, command: m[2].trim() })
            }
        }
    }

    return {
        ip: joined(s.IP) || 'N/A',
        os: joined(s.OS) || 'N/A',
        timezone: joined(s.TZ) || 'N/A',
        uptimeSeconds: intOrNull(joined(s.UPTIME)),
        cpuPercent: intOrNull(joined(s.CPU)),
        memPercent: intOrNull(joined(s.MEM)),
        netRxBytes: rxBytes,
        netTxBytes: txBytes,
        rxBps,
        txBps,
        topProcesses,
        sampledAt: now,
    }
}

/**
 * 仅供测试使用的内部导出。
 * @internal
 */
export const __test = { splitSections }

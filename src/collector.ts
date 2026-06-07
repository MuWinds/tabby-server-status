/**
 * @fileoverview 在已认证的 SSH 会话上执行远程探测脚本，收集服务器运行状态。
 */

import { SSHSession } from 'tabby-ssh'
import * as russh from 'russh'
import { REMOTE_PROBE_SCRIPT } from './probe'
import { parseProbeOutput } from './parser'
import type { ServerStatus } from './parser'

// ServerStatus 是 interface（type-only），ts-loader 在 transpileOnly 下不能
// 自动识别 type-only 重导出，必须用 `export type` 显式告知。
export type { ServerStatus } from './parser'
export { parseProbeOutput } from './parser'

/**
 * 在已经认证完成的 SSH 会话上执行一次探测脚本。
 *
 * 实现要点：
 *   - 不复用通道：每次都开一个新 session channel + requestExec，命令结束就关。
 *     这避免了多次采样间状态泄漏，也避开了 PTY/shell 提示符干扰输出解析。
 *   - data$ 流到 eof$/closed$ 后聚合所有 chunk 解码为字符串。
 *   - 8 秒超时兜底，防止某条命令永远不退出把整个采集卡住。
 */
export async function probeOnce (session: SSHSession, previous: ServerStatus | null): Promise<ServerStatus> {
    if (!(session.ssh instanceof russh.AuthenticatedSSHClient)) {
        throw new Error('SSH session is not authenticated')
    }
    const newCh = await session.ssh.openSessionChannel()
    const channel = await session.ssh.activateChannel(newCh)

    const chunks: Uint8Array[] = []
    const dataSub = channel.data$.subscribe(d => chunks.push(d))

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    try {
        await channel.requestExec(REMOTE_PROBE_SCRIPT)
        await new Promise<void>((resolve, reject) => {
            const eofSub = channel.eof$.subscribe(() => { eofSub.unsubscribe(); resolve() })
            const closedSub = channel.closed$.subscribe(() => { closedSub.unsubscribe(); resolve() })
            timeoutHandle = setTimeout(() => reject(new Error('probe timed out')), 8000)
        })
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        dataSub.unsubscribe()
        try { await channel.close() } catch { /* 可能已经被对端关闭 */ }
    }

    const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0)
    const buf = new Uint8Array(totalLen)
    let off = 0
    for (const c of chunks) { buf.set(c, off); off += c.byteLength }
    const raw = new TextDecoder('utf-8').decode(buf)

    return parseProbeOutput(raw, previous)
}

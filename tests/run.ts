/**
 * 简易单元测试 —— 不依赖 jest/mocha，直接 node 跑：
 *   npx ts-node tests/run.ts
 *   或先编译： tsc -p tsconfig.test.json && node tests/run.js
 *
 * 测试目标：probe.ts 的 shell 脚本输出能被 collector.ts 正确解析；
 *           format.ts 的格式化函数边界条件正确。
 */
import { parseProbeOutput } from '../src/parser'
import { formatRate, formatUptime, formatPercent, sparkline } from '../src/format'

let failed = 0
function assert (name: string, cond: boolean, detail?: string): void {
    if (cond) {
        console.log('  ✓', name)
    } else {
        failed++
        console.log('  ✗', name, detail ?? '')
    }
}

function eq<T> (name: string, actual: T, expected: T): void {
    assert(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// --- parseProbeOutput ---
console.log('parseProbeOutput')
{
    const raw = [
        '===IP===', '10.0.0.5',
        '===OS===', 'Ubuntu 22.04.3 LTS',
        '===TZ===', 'Asia/Shanghai',
        '===UPTIME===', '345678',
        '===CPU===', '37',
        '===MEM===', '62',
        '===NET===', '1000000 500000',
        '===TOP===', '18.2 node', '12.5 mysqld', '4.1 nginx',
    ].join('\n')
    const s1 = parseProbeOutput(raw, null)
    eq('ip', s1.ip, '10.0.0.5')
    eq('os', s1.os, 'Ubuntu 22.04.3 LTS')
    eq('tz', s1.timezone, 'Asia/Shanghai')
    eq('uptime', s1.uptimeSeconds, 345678)
    eq('cpu', s1.cpuPercent, 37)
    eq('mem', s1.memPercent, 62)
    eq('netRx', s1.netRxBytes, 1000000)
    eq('netTx', s1.netTxBytes, 500000)
    eq('rxBps null first', s1.rxBps, null)
    eq('top count', s1.topProcesses.length, 3)
    eq('top[0].command', s1.topProcesses[0].command, 'node')
    eq('top[0].cpu', s1.topProcesses[0].cpu, 18.2)

    // 第二次采样：5 秒后，rx 多了 50000，tx 多了 25000 → 速率 10000 / 5000 B/s
    const raw2 = raw.replace('1000000 500000', '1050000 525000')
    // 显式给 now：previous 在 T=0 采样，本次在 T=5000 采样 → dt=5s
    const s2 = parseProbeOutput(raw2, { ...s1, sampledAt: 0 }, 5000)
    eq('rxBps after sample', s2.rxBps, 10000)
    eq('txBps after sample', s2.txBps, 5000)
}

// 缺失字段时优雅降级
{
    const raw = '===IP===\nN/A\n===OS===\n\n===CPU===\nN/A\n'
    const s = parseProbeOutput(raw, null)
    eq('ip N/A', s.ip, 'N/A')
    eq('os empty → N/A', s.os, 'N/A')
    eq('cpu null', s.cpuPercent, null)
    eq('top empty', s.topProcesses.length, 0)
}

// 网络计数器回绕（reboot 后）：不应出现负速率
{
    const r1 = ['===NET===', '1000000 500000'].join('\n')
    const s1 = parseProbeOutput(r1, null, 0)
    const r2 = ['===NET===', '100 50'].join('\n')
    const s2 = parseProbeOutput(r2, s1, 1000)
    eq('rxBps clamped to 0 on wrap', s2.rxBps, 0)
    eq('txBps clamped to 0 on wrap', s2.txBps, 0)
}

// --- format ---
console.log('formatUptime')
eq('null', formatUptime(null), 'N/A')
eq('negative', formatUptime(-5), 'N/A')
eq('30s → 0m', formatUptime(30), '0m')
eq('5m', formatUptime(300), '5m')
eq('1h 30m', formatUptime(5400), '1h 30m')
eq('3d 4h', formatUptime(3 * 86400 + 4 * 3600 + 12 * 60), '3d 4h')

console.log('formatRate')
eq('null', formatRate(null), '—')
eq('0', formatRate(0), '0B/s')
eq('500 B/s', formatRate(500), '500B/s')
eq('1.5 KB/s', formatRate(1536), '1.5KB/s')
eq('100 KB/s', formatRate(100 * 1024), '100KB/s')
eq('2.5 MB/s', formatRate(2.5 * 1024 * 1024), '2.5MB/s')

console.log('formatPercent')
eq('null', formatPercent(null), '—')
eq('37', formatPercent(37), '37%')
eq('clamp >100', formatPercent(150), '100%')
eq('clamp <0', formatPercent(-3), '0%')

console.log('sparkline')
eq('empty', sparkline([]), '')
eq('all null fills space', sparkline([null, null, null]), '   ')
eq('flat → middle blocks', sparkline([50, 50, 50], 0, 100), '▅▅▅')
{
    const out = sparkline([0, 100], 0, 100)
    assert('low + high produce different blocks', out[0] !== out[1], `got ${out}`)
    assert('high block is full', out[1] === '█', `got ${out}`)
}
eq('preserves length with mixed null', sparkline([10, null, 90], 0, 100).length, 3)

if (failed === 0) {
    console.log('\nAll tests passed.')
    process.exit(0)
} else {
    console.log(`\n${failed} test(s) failed.`)
    process.exit(1)
}

/**
 * @fileoverview Server status bar component for Tabby SSH tabs.
 * Displays real-time CPU, memory, network, and system info at the bottom
 * of SSH terminal sessions, with sparkline history and top process expansion.
 */

import { Component, Input, OnInit, OnDestroy, NgZone, ChangeDetectorRef, ElementRef } from '@angular/core'
import { Subscription, Subject } from 'rxjs'
import { takeUntil } from 'rxjs/operators'
import { SSHTabComponent } from 'tabby-ssh'
import { LogService, Logger, ConfigService } from 'tabby-core'
import { probeOnce, ServerStatus } from './collector'
import { formatRate, formatUptime, sparkline } from './format'

const REFRESH_INTERVAL_MS = 5000
const HISTORY_LEN = 5  // 保留最近 10 次采样用于绘制 sparkline

/**
 * SSH 标签页底部的状态栏。
 *
 * 关键 class 命名约定：**所有 class 都用 `sb-` 前缀**。
 *   背景：之前的版本用 `.row` / `.item`，与 Bootstrap 栅格系统冲突
 *   （ng-bootstrap 给 .row 的子元素强加 flex-basis:100% → 每个 item 占一行）。
 *   这是用户反馈"每个指标占一行"的根因。
 *
 * 字体策略：font-family/font-size 一律 `inherit`，跟随 Tabby 终端字体设置；
 * 不再硬编码 Consolas 12px。
 */
@Component({
    selector: 'server-status-bar',
    template: `
        <div class="sb-root">
            <div class="sb-row">
                <button class="sb-btn" type="button" (click)="refreshNow()" title="Refresh now">
                    <span *ngIf="!loading">⟳</span>
                    <span class="sb-spin" *ngIf="loading">⟳</span>
                </button>

                <span class="sb-item sb-info" *ngIf="!status && !error && loading">Connecting…</span>
                <span class="sb-item sb-info" *ngIf="!status && !error && !loading">Waiting for SSH session…</span>
                <span class="sb-item sb-error" *ngIf="error" [attr.title]="error">⚠ {{ error }}</span>

                <ng-container *ngIf="status">
                    <span class="sb-item" title="Server IP">{{ status.ip }}</span>
                    <span class="sb-item" title="Operating system">{{ status.os }}</span>

                    <span class="sb-item sb-metric" title="CPU usage history">
                        <span class="sb-label">CPU</span>
                        <span class="sb-spark sb-cpu-spark">{{ cpuSpark }}</span>
                        <span class="sb-value">{{ status.cpuPercent === null ? '—' : status.cpuPercent + '%' }}</span>
                    </span>

                    <span class="sb-item sb-metric" title="Memory usage history">
                        <span class="sb-label">MEM</span>
                        <span class="sb-spark sb-mem-spark">{{ memSpark }}</span>
                        <span class="sb-value">{{ status.memPercent === null ? '—' : status.memPercent + '%' }}</span>
                    </span>

                    <span class="sb-item sb-metric" title="Network upload (history)">
                        <span class="sb-label">↑</span>
                        <span class="sb-spark sb-tx-spark">{{ txSpark }}</span>
                        <span class="sb-value">{{ status.txBps === null ? '—' : fmtRate(status.txBps) }}</span>
                    </span>

                    <span class="sb-item sb-metric" title="Network download (history)">
                        <span class="sb-label">↓</span>
                        <span class="sb-spark sb-rx-spark">{{ rxSpark }}</span>
                        <span class="sb-value">{{ status.rxBps === null ? '—' : fmtRate(status.rxBps) }}</span>
                    </span>

                    <span class="sb-item" title="Timezone">{{ status.timezone }}</span>
                    <span class="sb-item" title="Uptime">up {{ fmtUptime(status.uptimeSeconds) }}</span>

                    <button class="sb-btn"
                            type="button"
                            (click)="toggleExpand()"
                            [attr.title]="expanded ? 'Hide top processes' : 'Show top processes'"
                            *ngIf="status.topProcesses && status.topProcesses.length">
                        <span *ngIf="!expanded">▴</span>
                        <span *ngIf="expanded">▾</span>
                    </button>
                </ng-container>
            </div>

            <div class="sb-top" *ngIf="expanded && status && status.topProcesses && status.topProcesses.length">
                <div class="sb-top-title">Top processes by CPU</div>
                <div class="sb-top-row" *ngFor="let p of status.topProcesses">
                    <span class="sb-top-cpu">{{ p.cpu.toFixed(1) }}%</span>
                    <span class="sb-top-cmd">{{ p.command }}</span>
                </div>
            </div>
        </div>
    `,
    styles: [require('./statusBar.component.scss')],
})
export class ServerStatusBarComponent implements OnInit, OnDestroy {
    @Input() tab!: SSHTabComponent

    status: ServerStatus | null = null
    error: string | null = null
    loading = false
    expanded = false

    // sparkline 字符串（模板插值）。提前算好，模板里不调函数。
    cpuSpark = ''
    memSpark = ''
    txSpark = ''
    rxSpark = ''

    fmtRate = formatRate
    fmtUptime = formatUptime

    // 历史值环形缓冲。null 表示该次采样没拿到值，sparkline 渲染为空格保留位置。
    private cpuHistory: Array<number | null> = []
    private memHistory: Array<number | null> = []
    private txHistory: Array<number | null> = []
    private rxHistory: Array<number | null> = []

    private destroy$ = new Subject<void>()
    private timerHandle: ReturnType<typeof setInterval> | null = null
    private inFlight = false
    private sessionSub: Subscription | null = null
    private logger: Logger

    constructor (
        private zone: NgZone,
        private cdr: ChangeDetectorRef,
        private elRef: ElementRef<HTMLElement>,
        private config: ConfigService,
        log: LogService,
    ) {
        this.logger = log.create('serverStatus')
    }

    ngOnInit (): void {
        // 字号严格跟随 Tabby 终端字号：读 config.store.terminal.font/fontSize
        // 并订阅 changed$ 实时同步。组件根元素直接 inline style 设字号，
        // CSS 里所有 em 自动按比例缩放。
        this.applyFontFromConfig()
        this.config.changed$
            .pipe(takeUntil(this.destroy$))
            .subscribe(() => this.applyFontFromConfig())

        this.startTimer()
        this.tab.sessionChanged$
            .pipe(takeUntil(this.destroy$))
            .subscribe(() => {
                this.attachSessionWatchdog()
                void this.tick()
            })
        this.attachSessionWatchdog()
        void this.tick()
    }

    /**
     * 把 Tabby 的终端字号/字体应用到状态栏根元素。
     * Tabby 配置约定（自 v1.0 起稳定）：
     *   - config.store.terminal.fontSize: 数字 px
     *   - config.store.terminal.font:     字体族名字符串
     * 若读不到（不同版本字段名变动）就静默保持当前 CSS 默认值。
     */
    private applyFontFromConfig (): void {
        const root = this.elRef.nativeElement
        try {
            const t = this.config.store?.terminal
            if (t?.fontSize && Number.isFinite(t.fontSize)) {
                root.style.fontSize = `${t.fontSize}px`
            }
            if (t?.font) {
                root.style.fontFamily = `"${t.font}", monospace`
            }
        } catch (e) {
            this.logger.warn?.('failed to read terminal font config', e)
        }
    }

    ngOnDestroy (): void {
        this.destroy$.next()
        this.destroy$.complete()
        this.stopTimer()
    }

    refreshNow (): void { void this.tick() }
    toggleExpand (): void { this.expanded = !this.expanded }

    private startTimer (): void {
        this.stopTimer()
        this.zone.runOutsideAngular(() => {
            this.timerHandle = setInterval(() => { void this.tick() }, REFRESH_INTERVAL_MS)
        })
    }

    private stopTimer (): void {
        if (this.timerHandle !== null) {
            clearInterval(this.timerHandle)
            this.timerHandle = null
        }
        this.inFlight = false
    }

    private attachSessionWatchdog (): void {
        const session = this.tab.sshSession
        this.sessionSub?.unsubscribe()
        if (!session) return
        this.sessionSub = session.willDestroy$
            .pipe(takeUntil(this.destroy$))
            .subscribe(() => {
                this.zone.run(() => {
                    this.status = null
                    this.error = null
                    this.loading = false
                    this.cpuHistory = []
                    this.memHistory = []
                    this.txHistory = []
                    this.rxHistory = []
                    this.updateSparks()
                    this.cdr.markForCheck()
                })
            })
    }

    /** 环形 push：超长就 shift 掉头部。简单可靠，HISTORY_LEN 才 20，性能无虞。 */
    private pushHistory (arr: Array<number | null>, v: number | null): void {
        arr.push(v)
        if (arr.length > HISTORY_LEN) arr.shift()
    }

    private updateSparks (): void {
        // 全部 sparkline 固定 HISTORY_LEN 宽度，数据不够时左边补空格。
        // 这样从第一个采样开始就是满宽的，不会"一点点变长"。
        this.cpuSpark = sparkline(this.cpuHistory, 0, 100, HISTORY_LEN)
        this.memSpark = sparkline(this.memHistory, 0, 100, HISTORY_LEN)
        const txMax = Math.max(1, ...this.txHistory.filter((v): v is number => v !== null))
        const rxMax = Math.max(1, ...this.rxHistory.filter((v): v is number => v !== null))
        this.txSpark = sparkline(this.txHistory, 0, txMax, HISTORY_LEN)
        this.rxSpark = sparkline(this.rxHistory, 0, rxMax, HISTORY_LEN)
    }

    private async tick (): Promise<void> {
        if (this.inFlight) return
        const session = this.tab.sshSession

        if (!session) {
            this.zone.run(() => {
                this.loading = false
                this.cdr.markForCheck()
            })
            return
        }

        this.inFlight = true
        if (!this.status) {
            this.zone.run(() => {
                this.loading = true
                this.cdr.markForCheck()
            })
        }

        try {
            const next = await probeOnce(session, this.status)
            this.pushHistory(this.cpuHistory, next.cpuPercent)
            this.pushHistory(this.memHistory, next.memPercent)
            this.pushHistory(this.txHistory, next.txBps)
            this.pushHistory(this.rxHistory, next.rxBps)
            this.zone.run(() => {
                this.status = next
                this.error = null
                this.loading = false
                this.updateSparks()
                this.cdr.markForCheck()
            })
        } catch (e: any) {
            this.logger.warn?.('probe failed', e)
            this.zone.run(() => {
                this.error = e?.message ?? String(e)
                this.loading = false
                this.cdr.markForCheck()
            })
        } finally {
            this.inFlight = false
        }
    }
}

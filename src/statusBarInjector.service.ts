/**
 * @fileoverview Angular service that mounts a ServerStatusBarComponent into
 * every SSH tab. Handles DOM injection, z-index layering above xterm.js
 * canvas, ResizeObserver-driven padding sync, and cleanup on tab destroy.
 *
 * Multi-tab correlation is done by positional matching: the Nth
 * SSHTabComponent in `app.tabs` flat list corresponds to the Nth `<ssh-tab>`
 * element in DOM — this is guaranteed by Angular's `*ngFor` rendering order.
 */

import { Injectable, ComponentFactoryResolver, ApplicationRef, Injector, EmbeddedViewRef, ComponentRef } from '@angular/core'
import { AppService, BaseTabComponent } from 'tabby-core'
import { SSHTabComponent } from 'tabby-ssh'
import { ServerStatusBarComponent } from './statusBar.component'

/** 状态栏基础高度（px），用于初始化宿主 padding。实际高度由 ResizeObserver 动态同步。 */
const STATUS_HEIGHT = 24

/**
 * 监听 Tabby 的 tab 生命周期事件，在每个 SSH 标签页中动态创建并挂载
 * ServerStatusBarComponent。与 Bootstrap CSS 无关；通过 inline style
 * 直接控制定位。
 */
@Injectable({ providedIn: 'root' })
export class StatusBarInjectorService {
    private installed = new WeakMap<BaseTabComponent, ComponentRef<ServerStatusBarComponent>>()
    private started = false

    constructor (
        private readonly app: AppService,
        private readonly cfr: ComponentFactoryResolver,
        private readonly appRef: ApplicationRef,
        private readonly injector: Injector,
    ) {}

    /**
     * 启动注入器：订阅 tab 生命周期事件并对已存在的 tab 补装。
     * 幂等——多次调用只生效一次。
     */
    start (): void {
        if (this.started) return
        this.started = true

        // 新打开的 tab：tabOpened$ 对每个新 tab 都 fire
        this.app.tabOpened$.subscribe(tab => { this.scheduleInstall(tab) })

        // 兜底：activeTabChange$ 覆盖启动时已存在的 tab 或 tabOpened 未 fire 的场景
        this.app.activeTabChange$.subscribe(tab => {
            if (tab) this.scheduleInstall(tab)
        })

        for (const tab of this.app.tabs) {
            this.scheduleInstall(tab)
        }
    }

    /**
     * 为指定 tab 安排安装（如果它是 SSH 类型且尚未安装）。
     * 最多重试 20 次（每次间隔 100ms），等待 DOM 渲染就绪。
     * @param tab 任意 Tabby tab 实例
     */
    private scheduleInstall (tab: BaseTabComponent): void {
        if (!(tab instanceof SSHTabComponent)) return
        if (this.installed.has(tab)) return

        let attemptsLeft = 20
        const tryOnce = () => {
            if (this.installed.has(tab)) return
            const host = this.findHostForTab(tab)
            if (host) {
                this.install(tab, host)
                return
            }
            if (--attemptsLeft > 0) {
                setTimeout(tryOnce, 100)
            }
        }
        tryOnce()
    }

    /**
     * 按位置匹配：收集所有 SSH 类型 tab，按 `app.tabs` 扁平顺序索引
     * 找到对应 DOM 中同索引的 `<ssh-tab>` 元素。
     *
     * @param tab SSH tab 组件实例
     * @returns DOM 宿主元素；未找到或已安装时返回 null
     */
    private findHostForTab (tab: SSHTabComponent): HTMLElement | null {
        const sshTabs = this.collectAllSshTabs()
        const index = sshTabs.indexOf(tab)
        if (index < 0) return null

        const elements = document.querySelectorAll('ssh-tab')
        const host = elements[index] as HTMLElement | undefined
        if (!host) return null

        // 防止并发 retry 导致重复安装
        if (host.querySelector(':scope > server-status-bar')) return null
        return host
    }

    /**
     * 递归收集所有 SSH 类型 tab，正确处理 Tabby 分屏（SplitTabComponent）。
     * 通过 duck-typing `getAllTabs()` 方法检测分屏容器。
     *
     * @returns 扁平化的 SSHTabComponent 数组，顺序与 `app.tabs` 遍历顺序一致
     */
    private collectAllSshTabs (): SSHTabComponent[] {
        const result: SSHTabComponent[] = []
        const visit = (t: BaseTabComponent): void => {
            if (t instanceof SSHTabComponent) {
                result.push(t)
                return
            }
            // SplitTabComponent 通过 getAllTabs() 暴露子 tab 列表
            const split = t as unknown as { getAllTabs?: () => BaseTabComponent[] }
            if (split.getAllTabs) {
                for (const child of split.getAllTabs()) visit(child)
            }
        }
        for (const t of this.app.tabs) visit(t)
        return result
    }

    /**
     * 执行实际的 DOM 注入：创建 Angular 组件、设置 inline 定位样式、
     * 注册 ResizeObserver 同步宿主 padding、绑定销毁清理。
     *
     * @param tab SSH tab 组件实例
     * @param host `<ssh-tab>` DOM 元素
     */
    private install (tab: SSHTabComponent, host: HTMLElement): void {
        const factory = this.cfr.resolveComponentFactory(ServerStatusBarComponent)
        const ref = factory.create(this.injector)
        ref.instance.tab = tab
        this.appRef.attachView(ref.hostView)

        const node = (ref.hostView as EmbeddedViewRef<unknown>).rootNodes[0] as HTMLElement

        // xterm.js canvas 是 position:absolute;inset:0 —— 必须显式定位 + z-index
        Object.assign(node.style, {
            position: 'absolute',
            bottom: '0',
            left: '0',
            right: '0',
            width: '100%',
            zIndex: '1000',
            pointerEvents: 'auto',
            display: 'block',
            boxSizing: 'border-box',
        })

        const prevPaddingBottom = host.style.paddingBottom
        const prevPosition = host.style.position
        host.style.paddingBottom = `${STATUS_HEIGHT}px`
        if (!prevPosition || prevPosition === 'static') {
            host.style.position = 'relative'
        }

        host.appendChild(node)
        this.installed.set(tab, ref)

        // Top processes 展开/折叠时高度变化，ResizeObserver 自动同步宿主 padding
        const ro = new ResizeObserver(entries => {
            const h = entries[0]?.contentRect.height ?? STATUS_HEIGHT
            host.style.paddingBottom = `${Math.ceil(h)}px`
            window.dispatchEvent(new Event('resize'))
        })
        ro.observe(node)

        // 触发 xterm 重 fit 以适配新的可用高度
        setTimeout(() => window.dispatchEvent(new Event('resize')), 0)

        tab.destroyed$.subscribe(() => {
            try {
                ro.disconnect()
                this.appRef.detachView(ref.hostView)
                ref.destroy()
                if (node.parentNode) node.parentNode.removeChild(node)
                host.style.paddingBottom = prevPaddingBottom
                host.style.position = prevPosition
            } finally {
                this.installed.delete(tab)
            }
        })
    }
}

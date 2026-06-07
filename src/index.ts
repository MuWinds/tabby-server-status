/**
 * @fileoverview Tabby 插件入口。注册 Angular NgModule，模块构造时自动启动
 * StatusBarInjectorService 开始在 SSH 标签页中挂载状态栏组件。
 *
 * 注意：本文件使用 `export default` 而非命名导出，因为 Tabby 的插件加载器
 * 要求每个插件的入口文件默认导出 NgModule 类。这与 Google TS Style Guide 的
 * "禁止 default export" 规则冲突，但这是 Tabby 插件架构的硬性约定，无法绕过。
 */

import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import TabbyCoreModule from 'tabby-core'

import { ServerStatusBarComponent } from './statusBar.component'
import { StatusBarInjectorService } from './statusBarInjector.service'

/**
 * 插件主模块。构造时调用 injector.start() 启动状态栏注入，
 * 后续所有 SSH tab 的状态栏生命周期完全由 StatusBarInjectorService 管理。
 */
@NgModule({
    imports: [
        CommonModule,
        TabbyCoreModule,
    ],
    declarations: [
        ServerStatusBarComponent,
    ],
})
export default class ServerStatusModule {
    constructor (injector: StatusBarInjectorService) {
        injector.start()
    }
}

export { ServerStatusBarComponent, StatusBarInjectorService }

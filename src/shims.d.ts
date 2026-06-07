declare module '*.pug' {
    const content: string
    export default content
    export = content
}
declare module '*.scss' {
    const content: string
    export default content
    export = content
}

// Tabby 的内部包不在 npm 上发布；只在运行时由 Tabby 通过 webpack externals 提供。
// 为了让独立类型检查通过，给出最小可用的类型 stub。
declare module 'tabby-core' {
    const TabbyCoreModule: any
    export default TabbyCoreModule
    export class AppService {
        tabs: any[]
        activeTab: any
        tabOpened$: any
        activeTabChange$: any
    }
    export class LogService { create (name: string): any }
    export type Logger = any
    export class BaseTabComponent {
        destroyed$: any
    }
    export class ConfigService {
        store: any
        changed$: any
    }
}
declare module 'tabby-ssh' {
    import { BaseTabComponent } from 'tabby-core'
    export class SSHSession {
        ssh: any
        open: boolean
        willDestroy$: any
    }
    export class SSHTabComponent extends BaseTabComponent {
        sshSession: SSHSession | null
        sessionChanged$: any
    }
}
declare module 'russh' {
    export class AuthenticatedSSHClient {
        openSessionChannel (): Promise<any>
        activateChannel (ch: any): Promise<any>
    }
}


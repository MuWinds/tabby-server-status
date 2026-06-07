/**
 * @fileoverview Remote probe script that collects system metrics via a single
 * composite shell command. Designed for POSIX shell compatibility (Linux,
 * macOS, FreeBSD) with graceful fallbacks when tools are unavailable.
 */

/**
 * Single-character dollar sign literal. Used within the template string to
 * embed shell variable references (e.g. `${D}var`) without conflicting with
 * JavaScript template interpolation (`${...}`).
 */
const D = '$'

/**
 * A POSIX shell script deployed to remote servers to collect system metrics
 * in a single SSH round-trip.
 *
 * Each metric is emitted as a delimited block: `===KEY===\nVALUE\n`. The
 * parser splits on these delimiters, so the format is strict.
 *
 * Collected metrics: IP, OS, TZ, UPTIME, CPU, MEM, NET, TOP.
 * Any command that fails or produces empty output yields `N/A`.
 */
export const REMOTE_PROBE_SCRIPT = `
emit() {
  key=${D}1
  shift
  out=${D}("${D}@" 2>/dev/null)
  printf '===%s===\\n' "${D}key"
  if [ -n "${D}out" ]; then
    printf '%s\\n' "${D}out"
  else
    printf 'N/A\\n'
  fi
}

# ---- IP（出口/本机地址） ----
get_ip() {
  r=${D}(ip -4 -o addr show scope global 2>/dev/null | awk '{print ${D}4}' | cut -d/ -f1 | head -n1)
  [ -n "${D}r" ] && { printf '%s' "${D}r"; return; }
  r=${D}(ifconfig 2>/dev/null | awk '/inet /{print ${D}2}' | grep -v 127.0.0.1 | head -n1)
  [ -n "${D}r" ] && { printf '%s' "${D}r"; return; }
  r=${D}(hostname -I 2>/dev/null | awk '{print ${D}1}')
  [ -n "${D}r" ] && { printf '%s' "${D}r"; return; }
}

# ---- 操作系统发行版 ----
get_os() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    if [ -n "${D}PRETTY_NAME" ]; then printf '%s' "${D}PRETTY_NAME"
    else printf '%s %s' "${D}NAME" "${D}VERSION"
    fi
  elif command -v sw_vers >/dev/null 2>&1; then
    printf '%s %s' "${D}(sw_vers -productName)" "${D}(sw_vers -productVersion)"
  elif command -v uname >/dev/null 2>&1; then
    uname -sr
  fi
}

# ---- 时区 ----
get_tz() {
  if [ -r /etc/timezone ]; then cat /etc/timezone
  elif command -v timedatectl >/dev/null 2>&1; then timedatectl show -p Timezone --value 2>/dev/null
  elif [ -L /etc/localtime ]; then readlink /etc/localtime | sed 's#.*zoneinfo/##'
  else date +%Z
  fi
}

# ---- 运行时间（秒） ----
get_uptime() {
  if [ -r /proc/uptime ]; then
    awk '{print int(${D}1)}' /proc/uptime
  elif command -v sysctl >/dev/null 2>&1; then
    boot=${D}(sysctl -n kern.boottime 2>/dev/null | sed -E 's/.*sec = ([0-9]+).*/\\1/')
    [ -n "${D}boot" ] && echo ${D}(( ${D}(date +%s) - boot ))
  fi
}

# ---- CPU 使用率（百分比，整数） ----
# Linux 用 /proc/stat 双采样取差；macOS 用 top -l；BSD 用 top -bn1。
get_cpu() {
  if [ -r /proc/stat ]; then
    a=${D}(head -n1 /proc/stat)
    sleep 1
    b=${D}(head -n1 /proc/stat)
    awk -v a="${D}a" -v b="${D}b" 'BEGIN{
      n=split(a,A); m=split(b,B);
      ai=A[5]; bi=B[5];
      at=0; bt=0; for(i=2;i<=n;i++){at+=A[i]; bt+=B[i]}
      d=bt-at; if(d<=0){print 0; exit}
      v=(1-(bi-ai)/d)*100; if(v<0)v=0; if(v>100)v=100;
      printf "%d", v
    }'
  elif command -v top >/dev/null 2>&1; then
    # macOS: "CPU usage: 5.32% user, 2.10% sys, 92.57% idle"
    top -l 1 2>/dev/null | awk -F'[ %,]+' '/CPU usage/{print int(${D}3+${D}5); exit}'
  fi
}

# ---- 内存使用率（百分比，整数） ----
# Linux 优先用 MemAvailable（内核 >=3.14），回退到 MemFree+Buffers+Cached。
get_mem() {
  if [ -r /proc/meminfo ]; then
    awk '
      /^MemTotal:/ {t=${D}2}
      /^MemAvailable:/ {a=${D}2; have=1}
      /^MemFree:/ {f=${D}2}
      /^Buffers:/ {b=${D}2}
      /^Cached:/ {c=${D}2}
      END {
        if (t<=0) exit
        if (have) used = t - a
        else used = t - f - b - c
        if (used < 0) used = 0
        printf "%d", used*100/t
      }
    ' /proc/meminfo
  elif command -v vm_stat >/dev/null 2>&1; then
    # macOS：拼 page 数 * page size，用 active+wired+compressed 作为 "已用"
    page_size=${D}(vm_stat 2>/dev/null | awk '/page size of/{print ${D}8; exit}')
    [ -z "${D}page_size" ] && page_size=4096
    vm_stat 2>/dev/null | awk -v ps="${D}page_size" '
      /Pages free/             {f=${D}3}
      /Pages active/           {a=${D}3}
      /Pages inactive/         {i=${D}3}
      /Pages speculative/      {s=${D}3}
      /Pages wired down/       {w=${D}4}
      /Pages occupied by compressor/ {c=${D}5}
      END {
        gsub(/\\./,"",f); gsub(/\\./,"",a); gsub(/\\./,"",i);
        gsub(/\\./,"",s); gsub(/\\./,"",w); gsub(/\\./,"",c);
        tot=(f+a+i+s+w+c)*ps; used=(a+w+c)*ps;
        if (tot<=0) exit
        printf "%d", used*100/tot
      }'
  fi
}

# ---- 网络流量字节累计（rx tx） ----
# 后端取两次采样差除以时间差得速率。
get_net() {
  if [ -r /proc/net/dev ]; then
    awk '
      NR>2 {
        iface=${D}1; sub(/:${D}/,"",iface);
        if (iface=="lo") next
        rx += ${D}2; tx += ${D}10
      }
      END { printf "%d %d", rx, tx }
    ' /proc/net/dev
  elif command -v netstat >/dev/null 2>&1; then
    # macOS/BSD: "netstat -ibn" 中 <Link#N> 行的列定义跨平台略有差异；
    # 这里按主流 BSD 取第 7 (Ibytes) 与第 10 (Obytes) 列。
    netstat -ibn 2>/dev/null | awk '
      /<Link/ && ${D}1 !~ /^lo/ { rx += ${D}7; tx += ${D}10 }
      END { printf "%d %d", rx, tx }
    '
  fi
}

# ---- Top 5 CPU 进程 ----
# 输出每行 "PCPU COMMAND"。
get_top() {
  if ps -eo pcpu,comm --sort=-pcpu --no-headers >/dev/null 2>&1; then
    ps -eo pcpu,comm --sort=-pcpu --no-headers 2>/dev/null | head -n 5
  else
    # BSD/macOS: ps -Ao 后接 -r 按 CPU 排序；首行是 header 跳过
    ps -Ao pcpu,comm -r 2>/dev/null | awk 'NR>1 && NR<=6 {print ${D}1, ${D}2}'
  fi
}

emit IP get_ip
emit OS get_os
emit TZ get_tz
emit UPTIME get_uptime
emit CPU get_cpu
emit MEM get_mem
emit NET get_net
emit TOP get_top
`.trim()

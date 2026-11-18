'use strict';
/**
 * wininput.js —— Windows 真实键盘 / 鼠标注入（自动跟随遥控、鼠标键盘模拟的底座）
 *
 * 为什么用常驻 PowerShell 进程：
 *   鼠标移动是高频操作（手机滑动每秒几十次），每条指令都 spawn 一个
 *   powershell.exe 会有几百毫秒延迟，卡到没法用。这里起一个常驻进程，
 *   初始化一次 P/Invoke，之后通过 stdin/stdout 管道逐条收发指令。
 *
 * 为什么不用外部 .ps1 文件：
 *   之前项目踩过 .ps1 被安全策略拦截的坑，这里脚本内联在内存里，不落盘。
 *
 * 指令（制表符分隔，Node → PowerShell）：
 *   <id>\t<cmd>\t<参数1>\t<参数2>
 *   key / keydown / keyup   参数1 = 虚拟键码
 *   combo                   参数1 = 逗号分隔的虚拟键码（最多 4 个）
 *   type                    参数1 = UTF-8 文本的 base64（支持中文，不碰剪贴板）
 *   move                    参数1/2 = dx / dy（相对）
 *   moveto                  参数1/2 = x / y（绝对）
 *   wheel                   参数1 = delta（±120 为一格）
 *   click / rclick / mdown / mup / pos  无参数
 * 响应：OK <id> [数据] / ERR <id> <原因>；初始化完成后先输出 READY。
 *
 * 【Win7 兼容性 · 重要】
 *   Win7 SP1 默认只有 PowerShell 2.0 + .NET 3.5。旧版这里用
 *   `$line | ConvertFrom-Json`（ConvertFrom-Json 是 PowerShell 3.0 才加入）和
 *   `[string]::IsNullOrWhiteSpace`（.NET Framework 4.0 才加入），两者在 Win7
 *   上都会抛异常；而异常发生在解析出 $id 之前，回的是 `ERR  <原因>`（id 为空），
 *   Node 端匹配不到等待中的请求，最终统一显示「注入超时」。
 *   因此这里改成纯制表符协议 + 只用 PS 2.0 / .NET 2.0 就有的语法。
 *
 * 所有操作发给「当前前台窗口」。影音软件全屏时即为前台，方向键
 * 对应音量/快进、空格对应播放暂停、Esc 退出全屏、F 切换全屏——这正是
 * 自动跟随遥控依赖的通用快捷键约定。
 */

const { spawn } = require('child_process');
const { WIN } = require('./platform');

/** Windows 虚拟键码（遥控器自动跟随的映射基础） */
const VK = {
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  space: 0x20, enter: 0x0D, esc: 0x1B, tab: 0x09,
  backspace: 0x08, del: 0x2E, insert: 0x2D,
  home: 0x24, end: 0x23, pgup: 0x21, pgdn: 0x22,
  f: 0x46, // 字母 F 键（兼容旧写法）
  volup: 0xAF, voldown: 0xAE, mute: 0xAD,
  next: 0xB0, prev: 0xB1, play: 0xB3,
  ctrl: 0x11, shift: 0x10, alt: 0x12, win: 0x5B,
};
// 万能键需要「任意组合」：补齐 F1-F12、0-9、A-Z。
// 注意 combo() 最多接受 4 个键，所以设置面板里限制 3 个修饰键 + 1 个主键。
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6F + i;
for (let i = 0; i < 10; i++) VK[String(i)] = 0x30 + i;
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;

/** PowerShell 常驻脚本（模板字符串内不能出现反引号与 ${ }） */
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LPInputNative {
  public const uint KEYUP = 0x0002;
  public const uint UNICODE = 0x0004;
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint n, INPUT[] a, int size);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);

  public static int TypeText(string text) {
    int sent = 0;
    foreach (char c in text) {
      INPUT[] a = new INPUT[2];
      a[0].type = 1; a[0].U.ki.wScan = c; a[0].U.ki.dwFlags = UNICODE;
      a[1].type = 1; a[1].U.ki.wScan = c; a[1].U.ki.dwFlags = UNICODE | KEYUP;
      sent += (int)SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
    }
    return sent;
  }
  public static string CursorPos() {
    POINT p;
    GetCursorPos(out p);
    return p.X + "," + p.Y;
  }
}
'@
} catch {
  [Console]::WriteLine('BOOTERR ' + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$verInfo = 'unknown'
try { $verInfo = 'PS' + $PSVersionTable.PSVersion.ToString() + ' CLR' + [Environment]::Version.ToString() } catch { }
[Console]::WriteLine('READY ' + $verInfo)
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrEmpty($line)) { continue }
  if ($line.Trim().Length -eq 0) { continue }

  # 制表符分隔，不用 JSON —— Win7 的 PowerShell 2.0 没有 ConvertFrom-Json
  $parts = $line.Split([char]9)
  $id = [string]$parts[0]
  $cmd = ''
  if ($parts.Length -gt 1) { $cmd = [string]$parts[1] }
  $a1 = ''
  if ($parts.Length -gt 2) { $a1 = [string]$parts[2] }
  $a2 = ''
  if ($parts.Length -gt 3) { $a2 = [string]$parts[3] }

  $reply = ''
  try {
    switch ($cmd) {
      'key' {
        $vk = [byte][int]$a1
        [LPInputNative]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
        [LPInputNative]::keybd_event($vk, 0, [LPInputNative]::KEYUP, [UIntPtr]::Zero)
      }
      'combo' {
        # 组合键：如 Alt+Enter(全屏)、Ctrl+→(下一集)、Alt+F4(关闭窗口)
        $vks = @()
        if ($a1.Length -gt 0) { $vks = @($a1.Split(',')) }
        foreach ($vk in $vks) {
          [LPInputNative]::keybd_event([byte][int]$vk, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 20
        }
        Start-Sleep -Milliseconds 40
        [array]::Reverse($vks)
        foreach ($vk in $vks) {
          [LPInputNative]::keybd_event([byte][int]$vk, 0, [LPInputNative]::KEYUP, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 20
        }
      }
      'keydown' { [LPInputNative]::keybd_event([byte][int]$a1, 0, 0, [UIntPtr]::Zero) }
      'keyup'   { [LPInputNative]::keybd_event([byte][int]$a1, 0, [LPInputNative]::KEYUP, [UIntPtr]::Zero) }
      'type' {
        $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($a1))
        $n = [LPInputNative]::TypeText($text)
        if ($n -lt $text.Length) { throw '部分字符发送失败' }
      }
      'move'   { [LPInputNative]::mouse_event(0x0001, [int]$a1, [int]$a2, 0, [UIntPtr]::Zero) }
      'moveto' { [LPInputNative]::SetCursorPos([int]$a1, [int]$a2) | Out-Null }
      'click'  {
        [LPInputNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [LPInputNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      }
      'rclick' {
        [LPInputNative]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
        [LPInputNative]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
      }
      'mdown'  { [LPInputNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
      'mup'    { [LPInputNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
      'wheel'  { [LPInputNative]::mouse_event(0x0800, 0, 0, [int]$a1, [UIntPtr]::Zero) }
      'pos'    { $reply = [LPInputNative]::CursorPos() }
      'probe'  {
        # 只读自检：验证 base64/UTF-8 往返，不做任何真实注入，便于排障
        $s = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($a1))
        $reply = 'LEN' + $s.Length
      }
      default  { throw ('未知指令: ' + $cmd) }
    }
    if ($reply.Length -gt 0) { [Console]::WriteLine('OK ' + $id + ' ' + $reply) }
    else { [Console]::WriteLine('OK ' + $id) }
  } catch {
    [Console]::WriteLine('ERR ' + $id + ' ' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
`;

/** 把一条指令编码为制表符分隔的一行（不含换行以外的任何空白歧义） */
function encodeLine(id, obj) {
  const cmd = String(obj.cmd || '');
  const parts = [id, cmd];
  const n = (v) => String(Number(v) || 0);
  switch (cmd) {
    case 'key':
    case 'keydown':
    case 'keyup':
      parts.push(n(obj.vk));
      break;
    case 'combo':
      parts.push((Array.isArray(obj.vks) ? obj.vks : []).map(n).join(','));
      break;
    case 'type':
    case 'probe':
      // base64 字符集不含制表符，可安全作为字段
      parts.push(String(obj.text || ''));
      break;
    case 'move':
      parts.push(n(obj.dx), n(obj.dy));
      break;
    case 'moveto':
      parts.push(n(obj.x), n(obj.y));
      break;
    case 'wheel':
      parts.push(n(obj.delta));
      break;
    default:
      break; // click / rclick / mdown / mup / pos
  }
  return parts.join('\t') + '\n';
}

class WinInputDriver {
  constructor() {
    this.child = null;
    this.ready = false;
    this.seq = 0;
    this.pending = new Map(); // id -> {resolve, timer}
    this.buf = '';
    this.starting = null;
    this.stopped = false;
    this.lastStderr = '';
    this.bootError = '';
    this.psInfo = '';
  }

  get running() { return !!(this.child && !this.child.killed && this.ready); }

  /** 惰性启动常驻 PowerShell；并发调用共享同一个启动 Promise */
  ensure() {
    if (this.running) return Promise.resolve(true);
    if (!WIN) return Promise.resolve(false);
    if (this.starting) return this.starting;
    this.stopped = false;
    this.lastStderr = '';
    this.bootError = '';
    this.starting = new Promise((resolve) => {
      let child;
      try {
        child = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', PS_SCRIPT],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        this.starting = null;
        this.lastStderr = e.message;
        return resolve(false);
      }
      this.child = child;
      this.ready = false;
      this.buf = '';

      let settled = false;
      let startTimer = null;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        this.ready = ok;
        this.starting = null;
        resolve(ok);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.buf += chunk;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).replace(/\r$/, '');
          this.buf = this.buf.slice(i + 1);
          if (line.indexOf('READY') === 0) {
            this.psInfo = line.slice(5).trim();
            finish(true);
            continue;
          }
          if (line.indexOf('BOOTERR ') === 0) {
            this.bootError = line.slice(8).trim();
            finish(false);
            continue;
          }
          this._onLine(line);
        }
      });
      // 保留 stderr：Win7 上 Add-Type 失败（未启用 .NET 3.5）时能把真实原因回给用户
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.lastStderr = (this.lastStderr + chunk).slice(-2000);
      });
      child.once('error', (e) => {
        this.lastStderr = e.message;
        finish(false);
      });
      child.once('exit', () => {
        finish(false);
        this.ready = false;
        this.child = null;
        // 未主动停止时，把排队中的请求全部判失败（上层可重试）
        this._failAll('注入进程已退出');
      });

      // Win7 首次 Add-Type 冷编译可能超过 8 秒，放宽到 15 秒；超时后杀掉，避免残留孤儿进程
      startTimer = setTimeout(() => {
        if (!this.ready) {
          try { if (this.child && !this.child.killed) this.child.kill(); } catch {}
          finish(false);
        }
      }, 15000);
    });
    return this.starting;
  }

  /** 启动/崩溃原因摘要，用于把真实错误带到手机页面上 */
  _reason() {
    const env = this.psInfo ? ' (' + this.psInfo + ')' : '';
    const s = (this.bootError || this.lastStderr || '').trim().split(/\r?\n/).filter(Boolean);
    const detail = s.length ? '：' + s[s.length - 1].slice(0, 160) : '';
    return env + detail;
  }

  _failAll(msg) {
    const full = msg + this._reason();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      try { p.resolve({ ok: false, error: full }); } catch {}
    }
    this.pending.clear();
  }

  _onLine(line) {
    const sp = line.indexOf(' ');
    if (sp < 0) return;
    const tag = line.slice(0, sp);
    if (tag !== 'OK' && tag !== 'ERR') return;
    const raw = line.slice(sp + 1);
    // 正常是 "OK <id> [数据]"；若 PowerShell 在解析出 id 之前就异常，
    // 会输出 "ERR  <原因>"（两个空格），此时把错误归给最早的请求，
    // 不再让上层等 5 秒后只看到「注入超时」。
    const hasId = raw.length > 0 && !/^\s/.test(raw);
    let id = '';
    let payload = '';
    if (hasId) {
      const k = raw.indexOf(' ');
      id = k < 0 ? raw : raw.slice(0, k);
      payload = k < 0 ? '' : raw.slice(k + 1).trim();
    } else {
      payload = raw.trim();
    }
    let key = id;
    let p = id ? this.pending.get(id) : null;
    if (!p && !id) {
      for (const [k, v] of this.pending) { key = k; p = v; break; }
    }
    if (!p) return;
    this.pending.delete(key);
    clearTimeout(p.timer);
    if (tag === 'OK') p.resolve({ ok: true, data: payload || '' });
    else p.resolve({ ok: false, error: payload || '执行失败' });
  }

  /** 执行一条注入指令，返回 Promise<{ok, data?, error?}> */
  async exec(obj) {
    const ok = await this.ensure();
    if (!ok) {
      const base = WIN ? '键盘注入服务启动失败' : '仅 Windows 支持键盘注入';
      return { ok: false, error: base + this._reason() };
    }
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return { ok: false, error: '注入进程不可用' };
    }
    const id = String(++this.seq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: '注入超时' + this._reason() });
      }, 8000);
      this.pending.set(id, { resolve, timer });
      try {
        this.child.stdin.write(encodeLine(id, obj), 'utf8');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: e.message });
      }
    });
  }

  // 便捷方法
  key(vk) { return this.exec({ cmd: 'key', vk }); }
  /** 组合键：combo([VK.ctrl, VK.right]) = Ctrl+→ */
  combo(vks) { return this.exec({ cmd: 'combo', vks: (Array.isArray(vks) ? vks : []).slice(0, 4) }); }
  keydown(vk) { return this.exec({ cmd: 'keydown', vk }); }
  keyup(vk) { return this.exec({ cmd: 'keyup', vk }); }
  type(text) {
    const b64 = Buffer.from(String(text || ''), 'utf8').toString('base64');
    return this.exec({ cmd: 'type', text: b64 });
  }
  move(dx, dy) { return this.exec({ cmd: 'move', dx: clamp(dx, -800, 800), dy: clamp(dy, -800, 800) }); }
  moveto(x, y) { return this.exec({ cmd: 'moveto', x, y }); }
  click() { return this.exec({ cmd: 'click' }); }
  rclick() { return this.exec({ cmd: 'rclick' }); }
  mdown() { return this.exec({ cmd: 'mdown' }); }
  mup() { return this.exec({ cmd: 'mup' }); }
  wheel(delta) { return this.exec({ cmd: 'wheel', delta: clamp(delta, -1200, 1200) }); }
  pos() { return this.exec({ cmd: 'pos' }); }

  stop() {
    this.stopped = true;
    this.ready = false;
    if (this.child && !this.child.killed) {
      try { this.child.stdin.end(); } catch {}
      try { this.child.kill(); } catch {}
    }
    this.child = null;
    this.starting = null;
    this._failAll('注入服务已停止');
  }
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

const winInput = new WinInputDriver();

module.exports = { WinInputDriver, winInput, VK, encodeLine, PS_SCRIPT };
